// Jet effects, attached to the jet's mesh (craft-local, so they stay glued to the airframe at any
// speed) and driven from its update() every frame:
//   afterburner   a TSL emissive cone behind the nozzle: blue-white core, orange tail, shock diamonds
//                 and a turbulent flicker, its length and brightness following the afterburner stage;
//                 plus the glowing burner can inside the nozzle (a dull red at idle, white-hot in
//                 afterburner)
//   vapor cone    a translucent condensation shell from the canopy back over the wing, brightest at
//                 its rear shock edge, with a shimmer of streaks and vapour particles shedding aft,
//                 between Mach 0.9 and 1.05 in humid low air (fading out between 1500 and 3000 m)
//   wingtip vapour  thin condensation streams from the wingtips at high load (from about 5 g)
// Every piece is hidden while its strength is zero, so the effects cost nothing when inactive. They
// are drawn once when the craft is built so their pipelines compile before they are first needed.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, damp } from '../core/util.js';

const { Fn, uniform, float, vec3, uv, sin, cos, fract, pow, abs, mix, saturate, smoothstep, dot, normalize, normalView, positionView, instancedBufferAttribute } = TSL;

const FLAME = Object.freeze({ MIN_LENGTH: 1.6, MAX_LENGTH: 5.2, SEGMENTS: 16, DIAMONDS: 4.5 });
const VAPOR = Object.freeze({ PARTICLES: 96, HUMID_FULL: 1500, HUMID_NONE: 3000, FADE: 6 });
const TIP_VAPOR = Object.freeze({ LENGTH: 18, WIDTH: 0.34, FROM_G: 4.5, FULL_G: 7, FADE: 5 });
/** Updates that keep every effect drawn right after the build (pipeline warm-up). */
const PRIME_FRAMES = 2;

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function smoothRange(from, to, value) {
  return smooth01((value - from) / (to - from));
}

/**
 * Condensation strength of a vapor cone at a Mach number and altitude (0..1): it forms between Mach
 * 0.9 and 1.05 (peaking just below Mach 1) in humid low air. Exported for tests and the flight lab.
 */
export function vaporConeStrength(mach, altitude) {
  const band = smoothRange(0.9, 0.95, mach) * (1 - smoothRange(1.0, 1.05, mach));
  const humid = 1 - smoothRange(VAPOR.HUMID_FULL, VAPOR.HUMID_NONE, altitude);
  return band * humid;
}

/** Wingtip vapour strength (0..1) from the load factor, airspeed and altitude. */
export function wingtipVaporStrength(gLoad, airspeed, altitude) {
  const humid = 1 - smoothRange(VAPOR.HUMID_FULL, VAPOR.HUMID_NONE * 2, altitude);
  return smoothRange(TIP_VAPOR.FROM_G, TIP_VAPOR.FULL_G, gLoad) * smoothRange(90, 150, airspeed) * (0.35 + 0.65 * humid);
}

/** Sunlit condensation colour (like v1's contrail vapour): warm in sunlight, cool and dim at night. */
function vaporColor(uniforms) {
  const sunlit = mix(vec3(0.96, 0.96, 0.97), uniforms.sunColor.mul(0.95), 0.3);
  const skyLit = mix(sunlit, uniforms.skyHorizonColor, 0.15);
  return mix(skyLit, vec3(0.34, 0.4, 0.54), uniforms.nightFactor.mul(0.8));
}

/** The afterburner flame: an additive cone behind the nozzle exit. */
function createFlame(ctx, spec) {
  const { uniforms } = ctx;
  const strength = uniform(0);
  const heat = uniform(0);
  const geometry = new THREE.CylinderGeometry(0.06, spec.radius * 0.92, 1, 20, FLAME.SEGMENTS, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 0.5);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const along = uv().y;
  const facing = abs(dot(normalView, normalize(positionView.negate())));
  const intensity = Fn(() => {
    const core = pow(facing, float(1.4));
    const diamonds = pow(cos(along.mul(FLAME.DIAMONDS * Math.PI * 2).sub(0.6)).mul(0.5).add(0.5), float(6)).mul(float(1).sub(along)).mul(0.9);
    const flicker = sin(uniforms.time.mul(47).add(along.mul(13))).mul(sin(uniforms.time.mul(31).sub(along.mul(7)))).mul(0.18).add(0.9);
    const fade = pow(float(1).sub(along), float(1.3)).mul(smoothstep(float(0), float(0.06), along));
    return core.add(diamonds.mul(core)).mul(fade).mul(flicker).mul(strength);
  })();
  const hot = vec3(0.75, 0.82, 1.0);
  const warm = vec3(1.0, 0.55, 0.2);
  material.colorNode = mix(hot, warm, smoothstep(float(0.05), float(0.7), along)).mul(intensity).mul(heat.mul(2.2).add(1.4));
  material.opacityNode = saturate(intensity);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'afterburner-flame';
  mesh.position.set(0, spec.y, spec.z - 0.05);
  mesh.renderOrder = 4;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  // The burner can deep inside the nozzle: glows with the engine.
  const canMaterial = new THREE.MeshBasicNodeMaterial({ fog: false });
  const radial = uv().sub(0.5).length().mul(2);
  canMaterial.colorNode = mix(vec3(1.0, 0.36, 0.1), vec3(1.0, 0.85, 0.7), heat).mul(heat.mul(3.2).add(0.18)).mul(float(1).sub(radial.mul(0.55)));
  const can = new THREE.Mesh(new THREE.CircleGeometry(spec.radius * 0.72, 20), canMaterial);
  can.name = 'burner-can';
  can.position.set(0, spec.y, spec.z - spec.depth + 0.03);
  can.castShadow = false;
  can.receiveShadow = false;
  return { mesh, can, strength, heat };
}

/** The vapor cone shell and its shedding particles. */
function createVaporCone(ctx, spec) {
  const { uniforms } = ctx;
  const strength = uniform(0);
  const length = spec.baseZ - spec.apexZ;
  const geometry = new THREE.CylinderGeometry(spec.baseRadius, spec.apexRadius, length, 40, 12, true);
  geometry.rotateX(Math.PI / 2);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const along = uv().y;
  const around = uv().x;
  const facing = abs(dot(normalView, normalize(positionView.negate())));
  material.colorNode = vaporColor(uniforms);
  material.opacityNode = Fn(() => {
    const shell = smoothstep(float(0.2), float(0.88), along).mul(float(1).sub(smoothstep(float(0.93), float(1), along)));
    const rim = pow(float(1).sub(facing), float(2)).mul(0.75).add(0.25);
    const streaks = sin(around.mul(Math.PI * 2 * 11).add(along.mul(3)).add(uniforms.time.mul(23))).mul(sin(around.mul(Math.PI * 2 * 6).sub(uniforms.time.mul(17)))).mul(0.3).add(0.7);
    return saturate(shell.mul(rim).mul(streaks).mul(strength).mul(0.75));
  })();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'vapor-cone';
  mesh.position.set(0, spec.y, (spec.apexZ + spec.baseZ) / 2);
  mesh.renderOrder = 3;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // Particles: GPU-procedural puffs peeling off the rear of the cone and streaming aft (no per-frame
  // CPU work; each puff's ring angle, phase, speed and size come from a static seed).
  const seeds = new Float32Array(VAPOR.PARTICLES * 4);
  for (let index = 0; index < VAPOR.PARTICLES; index++) {
    seeds[index * 4] = Math.random() * Math.PI * 2;
    seeds[index * 4 + 1] = Math.random();
    seeds[index * 4 + 2] = 0.7 + Math.random() * 0.6;
    seeds[index * 4 + 3] = 0.6 + Math.random() * 0.8;
  }
  const seedAttribute = new THREE.InstancedBufferAttribute(seeds, 4);
  const seed = instancedBufferAttribute(seedAttribute, 'vec4');
  const life = fract(seed.y.add(uniforms.time.mul(seed.z).mul(2.2)));
  const startZ = spec.apexZ + length * 0.55;
  const radiusStart = spec.apexRadius + (spec.baseRadius - spec.apexRadius) * 0.55;
  const radius = mix(float(radiusStart), float(spec.baseRadius * 1.3), life);
  const particleMaterial = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: true });
  particleMaterial.positionNode = vec3(cos(seed.x).mul(radius), sin(seed.x).mul(radius).add(spec.y), mix(float(startZ), float(spec.baseZ + 7), life));
  particleMaterial.sizeNode = mix(float(0.5), float(2.2), life).mul(seed.w);
  const puff = pow(saturate(float(1).sub(uv().sub(0.5).length().mul(2))), float(1.6));
  particleMaterial.colorNode = vaporColor(uniforms);
  particleMaterial.opacityNode = saturate(puff.mul(sin(life.mul(Math.PI))).mul(strength).mul(0.55));
  const particles = new THREE.Sprite(particleMaterial);
  particles.count = VAPOR.PARTICLES;
  particles.name = 'vapor-particles';
  particles.frustumCulled = false;
  particles.renderOrder = 3;
  return { mesh, particles, strength };
}

/** Wingtip vapour: two crossed ribbons trailing from each tip. */
function createWingtipVapor(ctx, tips) {
  const { uniforms } = ctx;
  const strength = uniform(0);
  const flat = new THREE.PlaneGeometry(TIP_VAPOR.WIDTH, TIP_VAPOR.LENGTH, 1, 12);
  flat.rotateX(-Math.PI / 2);
  flat.translate(0, 0, TIP_VAPOR.LENGTH / 2);
  const upright = flat.clone();
  upright.rotateZ(Math.PI / 2);
  const geometry = ctx.addons.BufferGeometryUtils.mergeGeometries([flat, upright]);
  flat.dispose();
  upright.dispose();
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // uv.y is 1 at the wingtip and 0 at the far end of the stream.
  const distance = float(1).sub(uv().y);
  material.colorNode = vaporColor(uniforms);
  material.opacityNode = Fn(() => {
    const across = pow(saturate(float(1).sub(abs(uv().x.sub(0.5)).mul(2))), float(1.5));
    const trail = pow(float(1).sub(distance), float(1.6)).mul(smoothstep(float(0), float(0.02), distance));
    const streaks = sin(distance.mul(90).sub(uniforms.time.mul(70))).mul(0.25).add(0.75);
    return saturate(across.mul(trail).mul(streaks).mul(strength).mul(0.8));
  })();
  const meshes = tips.map((tip) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'wingtip-vapor';
    mesh.position.set(tip[0], tip[1], tip[2]);
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  });
  return { meshes, strength };
}

/**
 * Adds the jet's effects to `root`. spec: { nozzle: { z (exit), y, radius (open exit), depth },
 * cone: { apexZ, baseZ, apexRadius, baseRadius, y }, wingtips: [[x, y, z], [x, y, z]] }.
 * update(frame) takes { dt, sim, throttle, burner (0..1), spool, engineOn, nozzle (0..1), mach,
 * altitude, airspeed, gLoad }. Returns { update, getStats }.
 */
export function createJetEffects(ctx, root, spec) {
  const flame = createFlame(ctx, spec.nozzle);
  const cone = createVaporCone(ctx, spec.cone);
  const tips = createWingtipVapor(ctx, spec.wingtips);
  root.add(flame.mesh, flame.can, cone.mesh, cone.particles, ...tips.meshes);
  const levels = { flame: 0, heat: 0, cone: 0, tips: 0 };
  let primeFrames = PRIME_FRAMES;

  return {
    update(frame) {
      const dt = frame.dt;
      const running = frame.engineOn;
      // Afterburner flame: stage-driven, with a quick light-off and a slightly slower fade.
      const flameTarget = running ? clamp(frame.burner, 0, 1) : 0;
      levels.flame = dt > 0 ? damp(levels.flame, flameTarget, flameTarget > levels.flame ? 9 : 6, dt) : flameTarget;
      const heatTarget = running ? clamp(0.12 + 0.35 * clamp((frame.spool - 0.62) / 0.38, 0, 1) + 0.53 * levels.flame, 0, 1) : 0;
      levels.heat = dt > 0 ? damp(levels.heat, heatTarget, 3, dt) : heatTarget;
      // Vapor: the shell and the wingtip streams fade in and out.
      const coneTarget = vaporConeStrength(frame.mach, frame.altitude);
      levels.cone = dt > 0 ? damp(levels.cone, coneTarget, VAPOR.FADE, dt) : coneTarget;
      const tipTarget = wingtipVaporStrength(frame.gLoad, frame.airspeed, frame.altitude);
      levels.tips = dt > 0 ? damp(levels.tips, tipTarget, TIP_VAPOR.FADE, dt) : tipTarget;

      flame.strength.value = levels.flame;
      flame.heat.value = levels.heat;
      const length = FLAME.MIN_LENGTH + (FLAME.MAX_LENGTH - FLAME.MIN_LENGTH) * levels.flame;
      const width = 0.78 + 0.22 * clamp(frame.nozzle, 0, 1);
      flame.mesh.scale.set(width, width, length);
      cone.strength.value = levels.cone;
      tips.strength.value = levels.tips;

      const priming = primeFrames > 0;
      if (priming) primeFrames--;
      flame.mesh.visible = priming || levels.flame > 0.004;
      flame.can.visible = priming || levels.heat > 0.004;
      cone.mesh.visible = priming || levels.cone > 0.004;
      cone.particles.visible = cone.mesh.visible;
      for (const mesh of tips.meshes) mesh.visible = priming || levels.tips > 0.004;
    },

    getStats() {
      return { flame: levels.flame, heat: levels.heat, cone: levels.cone, tips: levels.tips };
    },
  };
}
