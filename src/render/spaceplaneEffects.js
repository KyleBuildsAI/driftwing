// Spaceplane effects, attached to the spaceplane's mesh (craft-local, so they stay glued to the airframe
// at any speed) and driven from its update() every frame:
//   rocket plume  a TSL emissive plume behind the bell: a tight blue-white core with shock diamonds in
//                 dense air that balloons into a wide, faint, under-expanded plume as the air thins
//                 (the ambient pressure no longer holds it in), its brightness following the thrust
//   RCS puffs     one instanced draw of every thruster's puff: a short white cone of cold gas along the
//                 jet's direction, flickering while the jet fires (instance strength attribute)
//   plasma        the re-entry glow: a sheath a little off the airframe's skin, brightest on the windward faces (the
//                 belly and the nose at entry angles of attack) with a hot rim and a turbulent flicker,
//                 plus a long ionised wake streaming down the air flow; both follow the heating. Seen
//                 from the cockpit its inside faces wash the windscreen pink and orange
// Every shader term is local to the craft (positionLocal, normalLocal, uv), so the effects need nothing
// from the floating origin and render the same on WebGPU and WebGL2. Every piece is hidden while its
// strength is zero, and drawn for the first frames after the build so its pipeline compiles early.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, damp } from '../core/util.js';

const { Fn, uniform, float, vec3, uv, sin, cos, pow, abs, mix, saturate, smoothstep, dot, normalize, normalView, positionView, normalLocal, positionLocal, instancedDynamicBufferAttribute } = TSL;

const PLUME = Object.freeze({ SEGMENTS: 24, DIAMONDS: 5, DENSE_LENGTH: 7, VACUUM_LENGTH: 16, DENSE_WIDTH: 1, VACUUM_WIDTH: 4 });
const PUFF = Object.freeze({ LENGTH: 2.4, RADIUS: 0.5 });
/** The wake trails this far behind the centre of the shell (m) at full heating. */
const WAKE_LENGTH = 70;
const PRIME_FRAMES = 2;

/** The rocket plume: an additive cone behind the nozzle exit (+z), widening as the air thins. */
function createPlume(ctx, spec) {
  const { uniforms } = ctx;
  const strength = uniform(0);
  const expansion = uniform(0);
  const geometry = new THREE.CylinderGeometry(spec.radius * 0.85, spec.radius * 1.15, 1, 24, PLUME.SEGMENTS, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 0.5);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const along = uv().y;
  const facing = abs(dot(normalView, normalize(positionView.negate())));
  const intensity = Fn(() => {
    // A gas column glows through its whole depth: seen end-on from behind it reads as a disc, not a ring.
    const core = pow(facing, mix(float(1.2), float(0.5), expansion)).mul(0.55).add(0.45);
    // Shock diamonds in dense air, seen from the side (end-on they would stack into rings); gone in the
    // under-expanded vacuum plume.
    const diamonds = pow(cos(along.mul(PLUME.DIAMONDS * Math.PI * 2).sub(0.5)).mul(0.5).add(0.5), float(4)).mul(float(1).sub(along)).mul(float(1).sub(expansion)).mul(facing.mul(facing)).mul(0.9);
    const flicker = sin(uniforms.time.mul(53).add(along.mul(17))).mul(sin(uniforms.time.mul(29).sub(along.mul(9)))).mul(0.15).add(0.92);
    const fade = pow(float(1).sub(along), mix(float(1.2), float(2.4), expansion)).mul(smoothstep(float(0), float(0.04), along));
    // The vacuum plume is wide and faint: the same energy spread over far more volume.
    const thin = mix(float(1), float(0.2), expansion);
    return core.add(diamonds.mul(core)).mul(fade).mul(flicker).mul(thin).mul(strength);
  })();
  const hot = vec3(0.62, 0.72, 1.0);
  const warm = vec3(1.0, 0.55, 0.22);
  const vacuumTint = vec3(0.75, 0.68, 1.0);
  material.colorNode = mix(mix(hot, warm, smoothstep(float(0.06), float(0.5), along)), vacuumTint, expansion.mul(0.6)).mul(intensity).mul(1.6);
  material.opacityNode = saturate(intensity);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rocket-plume';
  mesh.position.set(0, spec.y, spec.z);
  mesh.renderOrder = 4;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  // The glowing injector plate deep in the bell.
  const glowMaterial = new THREE.MeshBasicNodeMaterial({ fog: false });
  const radial = uv().sub(0.5).length().mul(2);
  glowMaterial.colorNode = mix(vec3(1.0, 0.42, 0.14), vec3(0.9, 0.92, 1.0), strength).mul(strength.mul(3.4).add(0.12)).mul(float(1).sub(radial.mul(0.5)));
  const glow = new THREE.Mesh(new THREE.CircleGeometry(spec.radius * 0.55, 20), glowMaterial);
  glow.name = 'rocket-injector';
  glow.position.set(0, spec.y, spec.z - spec.depth + 0.04);
  glow.castShadow = false;
  glow.receiveShadow = false;
  return { mesh, glow, strength, expansion };
}

/** Every RCS thruster's puff in one instanced mesh: per-instance strength (0..1) written each frame. */
function createPuffs(ctx, thrusters) {
  const { uniforms } = ctx;
  const count = thrusters.length;
  const geometry = new THREE.ConeGeometry(PUFF.RADIUS, PUFF.LENGTH, 10, 4, true);
  // The cone's apex at the jet, opening along +y: flip it and seat the apex on the origin.
  geometry.rotateX(Math.PI);
  geometry.translate(0, PUFF.LENGTH / 2, 0);
  const strengths = new Float32Array(count);
  const strengthAttribute = new THREE.InstancedBufferAttribute(strengths, 1);
  strengthAttribute.setUsage(THREE.DynamicDrawUsage);
  const strength = instancedDynamicBufferAttribute(strengthAttribute, 'float');
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const along = uv().y.oneMinus();
  const facing = abs(dot(normalView, normalize(positionView.negate())));
  material.colorNode = mix(vec3(1, 1, 1), uniforms.sunColor, 0.25).mul(mix(float(1), float(0.45), uniforms.nightFactor));
  material.opacityNode = Fn(() => {
    const plume = pow(float(1).sub(along), float(1.6)).mul(smoothstep(float(0), float(0.08), along));
    const soft = pow(facing, float(0.8));
    const flicker = sin(uniforms.time.mul(61).add(along.mul(21))).mul(0.18).add(0.82);
    return saturate(plume.mul(soft).mul(flicker).mul(strength).mul(1.1));
  })();
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'rcs-puffs';
  mesh.renderOrder = 5;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const position = new THREE.Vector3();
  const unit = new THREE.Vector3(1, 1, 1);
  thrusters.forEach((thruster, index) => {
    direction.fromArray(thruster.direction).normalize();
    rotation.setFromUnitVectors(up, direction);
    matrix.compose(position.fromArray(thruster.position), rotation, unit);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return { mesh, strengths, strengthAttribute };
}

/** The plasma sheath around the airframe and its ionised wake. */
function createPlasma(ctx, spec) {
  const { uniforms } = ctx;
  const strength = uniform(0);
  /** The air flow's direction in the craft's frame (unit, toward where the air goes). */
  const flow = uniform(new THREE.Vector3(0, 0, 1));
  const shellMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const shellIntensity = Fn(() => {
    // Windward: the faces the air flows onto (the normal against the flow).
    const windward = saturate(dot(normalize(normalLocal), flow.negate()));
    const front = pow(windward, float(1.5));
    const facing = abs(dot(normalView, normalize(positionView.negate())));
    // The shock layer hugs the windward faces: the rim glows only where the air is piling up.
    const rim = pow(float(1).sub(facing), float(2.5)).mul(windward).mul(0.8);
    const turbulence = sin(positionLocal.x.mul(5.1).add(uniforms.time.mul(23))).mul(sin(positionLocal.z.mul(3.3).sub(uniforms.time.mul(31)))).mul(0.25).add(0.8);
    return front.mul(1.3).add(rim).mul(turbulence).mul(strength);
  })();
  const pink = vec3(1.0, 0.38, 0.55);
  const orange = vec3(1.0, 0.58, 0.2);
  const white = vec3(1.0, 0.92, 0.85);
  shellMaterial.colorNode = mix(mix(orange, pink, saturate(shellIntensity.mul(0.6))), white, saturate(strength.sub(0.75).mul(2))).mul(shellIntensity).mul(1.5);
  shellMaterial.opacityNode = saturate(shellIntensity.mul(0.85));
  const shell = new THREE.Mesh(spec.geometry, shellMaterial);
  shell.name = 'plasma-sheath';
  shell.renderOrder = 6;
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.frustumCulled = false;

  // The wake: a long cone from the shell down the air flow (+y of the geometry, aimed each frame).
  const wakeGeometry = new THREE.CylinderGeometry(1, 0.2, 1, 24, 16, true);
  wakeGeometry.translate(0, 0.5, 0);
  const wakeMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const along = uv().y;
  const wakeFacing = abs(dot(normalView, normalize(positionView.negate())));
  const wakeIntensity = Fn(() => {
    const fade = pow(float(1).sub(along), float(1.8)).mul(smoothstep(float(0), float(0.05), along));
    const streaks = sin(uv().x.mul(Math.PI * 2 * 9).add(along.mul(14)).sub(uniforms.time.mul(37))).mul(0.25).add(0.75);
    return fade.mul(pow(wakeFacing, float(1.2))).mul(streaks).mul(strength).mul(0.7);
  })();
  wakeMaterial.colorNode = mix(pink, vec3(0.55, 0.42, 1.0), along).mul(wakeIntensity).mul(1.3);
  wakeMaterial.opacityNode = saturate(wakeIntensity);
  const wake = new THREE.Mesh(wakeGeometry, wakeMaterial);
  wake.name = 'plasma-wake';
  wake.position.set(spec.centre[0], spec.centre[1], spec.centre[2]);
  wake.renderOrder = 6;
  wake.castShadow = false;
  wake.receiveShadow = false;
  wake.frustumCulled = false;
  return { shell, wake, strength, flow };
}

/**
 * Adds the spaceplane's effects to `root`. spec: { nozzle: { z (exit), y, radius, depth }, thrusters:
 * [{ position, direction, axis: 'pitch' | 'yaw' | 'roll', sign }], plasma: { geometry (the sheath, owned
 * by the effects from then on), centre (where the wake starts), radius (the wake's) } }.
 * update(frame) takes { dt, thrust (0..1 of the lever), expansion (0 dense .. 1 vacuum), jets: { pitch,
 * yaw, roll } (-1..1), heating (0..1), flow (unit Vector3: the air flow in the craft's frame), engineOn }.
 * Returns { update, getStats }.
 */
export function createSpaceplaneEffects(ctx, root, spec) {
  const plume = createPlume(ctx, spec.nozzle);
  const puffs = createPuffs(ctx, spec.thrusters);
  const plasma = createPlasma(ctx, spec.plasma);
  root.add(plume.mesh, plume.glow, puffs.mesh, plasma.shell, plasma.wake);
  const thrusters = spec.thrusters;
  const levels = { plume: 0, expansion: 0, plasma: 0, puffs: 0 };
  const wakeUp = new THREE.Vector3(0, 1, 0);
  let primeFrames = PRIME_FRAMES;

  return {
    update(frame) {
      const dt = frame.dt;
      const plumeTarget = frame.engineOn ? clamp(frame.thrust, 0, 1) : 0;
      levels.plume = dt > 0 ? damp(levels.plume, plumeTarget, plumeTarget > levels.plume ? 14 : 9, dt) : plumeTarget;
      levels.expansion = dt > 0 ? damp(levels.expansion, clamp(frame.expansion, 0, 1), 2, dt) : clamp(frame.expansion, 0, 1);
      plume.strength.value = levels.plume;
      plume.expansion.value = levels.expansion;
      const length = (PLUME.DENSE_LENGTH + (PLUME.VACUUM_LENGTH - PLUME.DENSE_LENGTH) * levels.expansion) * (0.45 + 0.55 * levels.plume);
      const width = PLUME.DENSE_WIDTH + (PLUME.VACUUM_WIDTH - PLUME.DENSE_WIDTH) * levels.expansion * levels.expansion;
      plume.mesh.scale.set(width, width, length);

      // Thruster puffs: each jet fires on the sign of its axis command.
      let strongest = 0;
      for (let index = 0; index < thrusters.length; index++) {
        const thruster = thrusters[index];
        const command = frame.jets[thruster.axis];
        const fire = clamp((Number.isFinite(command) ? command : 0) * thruster.sign, 0, 1);
        const shown = fire > 0.04 ? 0.35 + 0.65 * fire : 0;
        puffs.strengths[index] = shown;
        strongest = Math.max(strongest, shown);
      }
      puffs.strengthAttribute.needsUpdate = true;
      levels.puffs = strongest;

      levels.plasma = clamp(frame.heating, 0, 1);
      plasma.strength.value = levels.plasma;
      if (frame.flow && frame.flow.lengthSq() > 0.5) {
        plasma.flow.value.copy(frame.flow);
        plasma.wake.quaternion.setFromUnitVectors(wakeUp, frame.flow);
      }
      const wakeLength = WAKE_LENGTH * (0.3 + 0.7 * levels.plasma);
      const wakeRadius = spec.plasma.radius;
      plasma.wake.scale.set(wakeRadius, wakeLength, wakeRadius);

      const priming = primeFrames > 0;
      if (priming) primeFrames--;
      plume.mesh.visible = priming || levels.plume > 0.004;
      plume.glow.visible = plume.mesh.visible;
      puffs.mesh.visible = priming || strongest > 0;
      plasma.shell.visible = priming || levels.plasma > 0.004;
      plasma.wake.visible = plasma.shell.visible;
    },

    getStats() {
      return { plume: levels.plume, expansion: levels.expansion, puffs: levels.puffs, plasma: levels.plasma };
    },
  };
}
