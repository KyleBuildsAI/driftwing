import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG } from '../core/config.js';
import { MathUtils, clamp } from '../core/util.js';

/**
 * WAYPOINTS: a warm golden beacon marks the waypoint. It is a tall additive
 * light pillar (vertical alpha gradient, soft edges, slow upward light bands),
 * a terrain-hugging ripple ring on the ground or water, and a small floating
 * diamond. It ignores fog and fades by distance instead, widens with distance
 * so it stays readable on the horizon, and is drawn through a homothety toward
 * the camera when it lies beyond the far plane. Flying within 180 m of it
 * (horizontally) fires an fx burst, emits `waypoint:reached` (the audio system
 * plays its panned arpeggio chime from that event) and clears it after a short flare.
 */
export function createWaypointSystem(ctx) {
  const { THREE: T, TSL: N, scene, camera, state, bus, world, uniforms } = ctx;
  const {
    uniform, positionLocal, positionWorld, cameraPosition, normalWorld,
    normalize, dot, abs, pow, exp, fract, length, smoothstep, oneMinus,
  } = N;

  const PILLAR_HEIGHT = 620;
  const CORE_RADIUS = 3.4;
  const HALO_RADIUS = 10.5;
  const GROUND_RADIUS = 46;
  const DIAMOND_HOVER = 42;
  const DIAMOND_HALF_HEIGHT = 10.4;
  const REACH_RADIUS = 180;
  const ARM_RADIUS = REACH_RADIUS + 60;
  const APPEAR_SECONDS = 1.4;
  const VANISH_SECONDS = 0.7;
  const REACHED_SECONDS = 1.5;
  const GROUND_LIFT = 1.1;
  const WATER_LIFT = 1.3;
  const MAX_LABEL_LENGTH = 48;
  const BEACON_HEX = 0xffcf6b;

  // ---- Shared uniforms (created once, outside every Fn) ------------------------
  const beaconColor = uniform(new T.Color(BEACON_HEX));
  const visibility = uniform(0);
  const groundVisibility = uniform(0);
  const growth = uniform(0);
  const flare = uniform(0);
  const simTime = uniforms.time;

  // ---- Materials ------------------------------------------------------------------
  function createAdditiveMaterial() {
    return new T.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      forceSinglePass: true,
      fog: false,
    });
  }

  /** tetherLevel: brightness of the beam below the diamond, so the crystal reads as the light's source. */
  function createPillarMaterial(strength, facingPower, falloffPower, bandAmount, tetherLevel) {
    const material = createAdditiveMaterial();
    const heightFraction = positionLocal.y.div(PILLAR_HEIGHT).clamp(0, 1);
    const viewDirection = normalize(cameraPosition.sub(positionWorld));
    const facing = pow(abs(dot(normalWorld, viewDirection)), facingPower);
    const vertical = pow(oneMinus(heightFraction), falloffPower);
    const bandPhase = fract(heightFraction.mul(7).sub(simTime.mul(0.16)));
    const band = smoothstep(0, 0.12, bandPhase).mul(oneMinus(smoothstep(0.12, 0.7, bandPhase)));
    const grown = oneMinus(smoothstep(growth.sub(0.08), growth, heightFraction));
    const diamondTop = DIAMOND_HOVER + DIAMOND_HALF_HEIGHT;
    const tether = smoothstep(diamondTop - 6, diamondTop + 14, positionLocal.y).mul(1 - tetherLevel).add(tetherLevel);
    material.colorNode = beaconColor.mul(strength).mul(flare.mul(1.6).add(1));
    material.opacityNode = facing
      .mul(vertical)
      .mul(tether)
      .mul(band.mul(bandAmount).add(1 - bandAmount * 0.5))
      .mul(grown)
      .mul(visibility);
    return material;
  }

  function createGroundMaterial() {
    const material = createAdditiveMaterial();
    const radial = length(positionLocal.xz).div(GROUND_RADIUS);
    const gaussian = (value, center, width) => {
      const offset = value.sub(center).div(width);
      return exp(offset.mul(offset).negate());
    };
    let rings = gaussian(radial, 0.22, 0.028).mul(1.25);
    for (let index = 0; index < 3; index++) {
      const phase = fract(simTime.mul(0.3).add(index / 3));
      const ripple = gaussian(radial, phase.mul(0.7).add(0.24), phase.mul(0.025).add(0.018));
      rings = rings.add(ripple.mul(pow(oneMinus(phase), 1.6)).mul(0.95));
    }
    const glow = exp(radial.mul(-6.5)).mul(0.75);
    const edge = oneMinus(smoothstep(0.8, 1, radial));
    material.colorNode = beaconColor.mul(2.1).mul(flare.add(1));
    material.opacityNode = rings.add(glow).mul(edge).mul(groundVisibility).mul(growth.mul(0.6).add(0.4));
    return material;
  }

  function createDiamondMaterial() {
    const material = new T.MeshStandardNodeMaterial({
      color: 0xffdb96,
      roughness: 0.3,
      metalness: 0.2,
      flatShading: true,
      fog: false,
    });
    material.emissiveNode = beaconColor.mul(flare.mul(2.2).add(0.85));
    return material;
  }

  // ---- Geometry + scene graph ---------------------------------------------------------
  const coreGeometry = new T.CylinderGeometry(CORE_RADIUS * 0.55, CORE_RADIUS, PILLAR_HEIGHT, 20, 1, true);
  coreGeometry.translate(0, PILLAR_HEIGHT / 2, 0);
  const haloGeometry = new T.CylinderGeometry(HALO_RADIUS * 0.6, HALO_RADIUS, PILLAR_HEIGHT, 24, 1, true);
  haloGeometry.translate(0, PILLAR_HEIGHT / 2, 0);
  const groundGeometry = new T.RingGeometry(1.5, GROUND_RADIUS, 64, 8);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPositions = groundGeometry.attributes.position;
  const diamondGeometry = new T.OctahedronGeometry(6.5, 0);
  diamondGeometry.scale(1, 1.6, 1);

  const materials = {
    core: createPillarMaterial(2.6, 2.6, 2.1, 0.45, 0.28),
    halo: createPillarMaterial(0.55, 2.2, 1.35, 0.25, 0.5),
    ground: createGroundMaterial(),
    diamond: createDiamondMaterial(),
  };

  const beacon = new T.Group();
  beacon.name = 'waypoint-beacon';
  beacon.visible = false;
  const pillar = new T.Group();
  const coreMesh = new T.Mesh(coreGeometry, materials.core);
  const haloMesh = new T.Mesh(haloGeometry, materials.halo);
  const groundMesh = new T.Mesh(groundGeometry, materials.ground);
  const diamondMesh = new T.Mesh(diamondGeometry, materials.diamond);
  for (const mesh of [coreMesh, haloMesh, groundMesh]) {
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }
  diamondMesh.castShadow = false;
  diamondMesh.receiveShadow = false;
  pillar.add(haloMesh, coreMesh);
  beacon.add(pillar, groundMesh, diamondMesh);
  scene.add(beacon);
  // First shown long after boot: let core compile their pipelines behind the loading fade.
  ctx.registerPrewarm?.(beacon);

  // ---- Runtime state ----------------------------------------------------------------------
  const base = new T.Vector3();
  const toBase = new T.Vector3();
  let phase = 'hidden';
  let phaseTime = 0;
  let armed = false;
  let appear = 0;
  let spin = 0;

  function sanitizeLabel(label) {
    const text = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return text ? text.slice(0, MAX_LABEL_LENGTH) : 'Waypoint';
  }

  function surfaceHeight(x, z) {
    const height = world.heightAt(x, z);
    return height > CONFIG.WATER_LEVEL ? height + GROUND_LIFT : CONFIG.WATER_LEVEL + WATER_LIFT;
  }

  /** Drapes the ripple ring over the terrain (or water) around the beacon, once per waypoint. */
  function conformGround(x, z, baseY) {
    for (let index = 0; index < groundPositions.count; index++) {
      const localX = groundPositions.getX(index);
      const localZ = groundPositions.getZ(index);
      groundPositions.setY(index, surfaceHeight(x + localX, z + localZ) - baseY);
    }
    groundPositions.needsUpdate = true;
    groundGeometry.computeBoundingSphere();
  }

  function setPhase(next) {
    phase = next;
    phaseTime = 0;
  }

  function set(position, label) {
    const x = Number(position?.x);
    const z = Number(position?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const cleanLabel = sanitizeLabel(label ?? position?.label);
    const groundY = Math.max(world.heightAt(x, z), CONFIG.WATER_LEVEL);
    base.set(x, groundY, z);
    conformGround(x, z, groundY);
    state.waypoint = { x, z, label: cleanLabel, setAt: state.time.elapsed };
    const player = state.player.position;
    armed = Math.hypot(player.x - x, player.z - z) > ARM_RADIUS;
    appear = phase === 'hidden' ? 0 : Math.min(appear, 0.35);
    beacon.visible = true;
    setPhase('appearing');
    bus.emit('waypoint:set', { x, z, label: cleanLabel });
    return { ...state.waypoint };
  }

  function clear() {
    if (!state.waypoint) return false;
    state.waypoint = null;
    if (phase !== 'hidden') setPhase('vanishing');
    bus.emit('waypoint:cleared', {});
    return true;
  }

  function reach() {
    const waypoint = state.waypoint;
    setPhase('reached');
    const player = state.player.position;
    const burstPosition = new T.Vector3(waypoint.x, clamp(player.y, base.y + 12, base.y + PILLAR_HEIGHT * 0.8), waypoint.z);
    ctx.systems.fx?.burst?.('waypoint', burstPosition);
    bus.emit('waypoint:reached', { x: waypoint.x, z: waypoint.z, label: waypoint.label });
  }

  function checkReached() {
    const waypoint = state.waypoint;
    if (!waypoint || (phase !== 'appearing' && phase !== 'active')) return;
    const player = state.player.position;
    const horizontal = Math.hypot(player.x - waypoint.x, player.z - waypoint.z);
    if (!armed) {
      if (horizontal > ARM_RADIUS) armed = true;
      return;
    }
    if (horizontal < REACH_RADIUS) reach();
  }

  /** Advances the appear / reach / vanish animation; returns the lifecycle fade (0..1). */
  function advancePhase(dt) {
    phaseTime += dt;
    if (phase === 'appearing') {
      appear = Math.min(1, appear + dt / APPEAR_SECONDS);
      if (appear >= 1) setPhase('active');
      flare.value = 0;
      return 1;
    }
    if (phase === 'active') {
      flare.value = 0;
      return 1;
    }
    if (phase === 'reached') {
      const progress = phaseTime / REACHED_SECONDS;
      flare.value = Math.min(1, phaseTime / 0.18) * (1 - MathUtils.smoothstep(progress, 0.3, 1));
      if (progress >= 1) {
        clear();
        setPhase('hidden');
        beacon.visible = false;
        return 0;
      }
      return 1 - MathUtils.smoothstep(progress, 0.6, 1);
    }
    if (phase === 'vanishing') {
      const progress = phaseTime / VANISH_SECONDS;
      flare.value = 0;
      if (progress >= 1) {
        setPhase('hidden');
        beacon.visible = false;
        return 0;
      }
      return 1 - progress;
    }
    return 0;
  }

  function placeBeacon(dt, lifecycleFade) {
    toBase.subVectors(base, camera.position);
    const distance = toBase.length();
    const horizontal = Math.hypot(toBase.x, toBase.z);
    const maxRenderDistance = camera.far * 0.7;
    const homothety = distance > maxRenderDistance ? maxRenderDistance / distance : 1;
    beacon.position.copy(camera.position).addScaledVector(toBase, homothety);
    beacon.scale.setScalar(homothety);

    const widthScale = Math.max(1, distance / 1100) * (1 + flare.value * 1.4);
    pillar.scale.set(widthScale, 1, widthScale);

    const eased = 1 - Math.pow(1 - appear, 3);
    growth.value = eased;
    spin += dt * 0.9;
    const bob = Math.sin(state.time.elapsed * 1.3) * 2.2;
    diamondMesh.position.set(0, DIAMOND_HOVER + bob, 0);
    diamondMesh.rotation.set(0, spin, 0);
    diamondMesh.scale.setScalar(Math.max(0.001, eased * lifecycleFade * (1 + flare.value * 0.6) * Math.max(1, distance / 2200)));

    const farFade = 1 - 0.45 * MathUtils.smoothstep(distance, 2500, 12000);
    const nearness = MathUtils.smoothstep(horizontal, 40, 800);
    const lifecycle = lifecycleFade * (0.25 + 0.75 * eased);
    visibility.value = lifecycle * farFade * (0.14 + 0.86 * nearness) * (1 + flare.value * 0.8);
    groundVisibility.value = lifecycle * (0.6 + 0.4 * nearness) * (1 + flare.value * 0.5);
  }

  return {
    update(dt) {
      if (phase === 'hidden') return;
      if (!state.waypoint && (phase === 'appearing' || phase === 'active')) setPhase('vanishing');
      checkReached();
      const lifecycleFade = advancePhase(dt);
      if (phase === 'hidden') return;
      placeBeacon(dt, lifecycleFade);
    },
    set,
    clear,
    get() {
      return state.waypoint ? { ...state.waypoint } : null;
    },
    getStats() {
      return { phase, armed, visible: beacon.visible, visibility: Math.round(visibility.value * 100) / 100 };
    },
  };
}
