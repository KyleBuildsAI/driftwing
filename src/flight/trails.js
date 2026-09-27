// Craft trails: light particle trails emitted from a craft's anchors (the bush plane's smoke, the
// glider's ballast spray). Same technique as v1's bursts (one Sprite drawn instanced with a
// PointsNodeMaterial, camera-relative float32 offsets), but soft, sunlit and alpha-blended instead
// of additive: vapour that billows out, drifts and fades.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp } from '../core/util.js';

const CAPACITY = 640;
/**
 * Per-kind emission: rate (puffs/s), life (s), size range at birth and at death (m), how much of the
 * craft's velocity a puff keeps, spread (m/s), rise (m/s^2), drag (1/s), peak opacity and colour.
 */
const STYLES = Object.freeze({
  smoke: Object.freeze({ rate: 36, life: [3.6, 5.2], birthSize: [0.9, 1.4], deathSize: [5.5, 8], inherit: 0.08, spread: 1.4, rise: 0.35, drag: 1.6, opacity: 0.55, tint: Object.freeze([0.96, 0.95, 0.93]) }),
  spray: Object.freeze({ rate: 55, life: [0.9, 1.5], birthSize: [0.25, 0.4], deathSize: [1.8, 2.8], inherit: 0.25, spread: 2.2, rise: -2.5, drag: 2.4, opacity: 0.35, tint: Object.freeze([0.86, 0.92, 0.98]) }),
});
const NEAR_FADE_START = 2;
const NEAR_FADE_RANGE = 8;

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function randomRange(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

export function createTrailSystem(ctx) {
  const { scene, uniforms } = ctx;
  const { Fn, float, vec3, mix, pow, saturate, uv, instancedDynamicBufferAttribute } = TSL;

  const offsets = new Float32Array(CAPACITY * 3);
  const tints = new Float32Array(CAPACITY * 4);
  const shapes = new Float32Array(CAPACITY * 2);
  const offsetAttribute = new THREE.InstancedBufferAttribute(offsets, 3).setUsage(THREE.DynamicDrawUsage);
  const tintAttribute = new THREE.InstancedBufferAttribute(tints, 4).setUsage(THREE.DynamicDrawUsage);
  const shapeAttribute = new THREE.InstancedBufferAttribute(shapes, 2).setUsage(THREE.DynamicDrawUsage);
  const particleTint = instancedDynamicBufferAttribute(tintAttribute, 'vec4');
  const particleShape = instancedDynamicBufferAttribute(shapeAttribute, 'vec2');

  const material = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: true });
  material.positionNode = instancedDynamicBufferAttribute(offsetAttribute, 'vec3');
  material.sizeNode = particleShape.x;
  const radial = uv().sub(0.5).mul(2).length();
  material.colorNode = Fn(() => {
    // Lit like v1's contrail vapour: sun-warmed, sky-tinted, cool and dim at night; a soft core.
    const sunlit = mix(particleTint.rgb, uniforms.sunColor.mul(0.9), 0.3);
    const skyLit = mix(sunlit, uniforms.skyHorizonColor, 0.15);
    const shaded = skyLit.mul(float(0.82).add(pow(saturate(float(1).sub(radial)), 1.5).mul(0.18)));
    return mix(shaded, vec3(0.36, 0.42, 0.56), uniforms.nightFactor.mul(0.8));
  })();
  material.opacityNode = Fn(() => {
    const puff = pow(saturate(float(1).sub(radial)), 1.6);
    return saturate(particleTint.a.mul(puff));
  })();
  const sprite = new THREE.Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 3;
  sprite.visible = false;
  sprite.name = 'craft-trails';
  scene.add(sprite);

  const positionX = new Float64Array(CAPACITY);
  const positionY = new Float64Array(CAPACITY);
  const positionZ = new Float64Array(CAPACITY);
  const velocityX = new Float32Array(CAPACITY);
  const velocityY = new Float32Array(CAPACITY);
  const velocityZ = new Float32Array(CAPACITY);
  const age = new Float32Array(CAPACITY);
  const life = new Float32Array(CAPACITY);
  const birthSize = new Float32Array(CAPACITY);
  const deathSize = new Float32Array(CAPACITY);
  const rise = new Float32Array(CAPACITY);
  const drag = new Float32Array(CAPACITY);
  const peakOpacity = new Float32Array(CAPACITY);
  const red = new Float32Array(CAPACITY);
  const green = new Float32Array(CAPACITY);
  const blue = new Float32Array(CAPACITY);
  const emitDebt = { smoke: 0, spray: 0 };
  const lastEmit = { smoke: new THREE.Vector3(), spray: new THREE.Vector3() };
  const hasLastEmit = { smoke: false, spray: false };
  const emittedThisFrame = { smoke: false, spray: false };
  let cursor = 0;
  let live = 0;

  function claim() {
    for (let attempt = 0; attempt < CAPACITY; attempt++) {
      const index = cursor;
      cursor = (cursor + 1) % CAPACITY;
      if (life[index] <= 0) return index;
    }
    const index = cursor;
    cursor = (cursor + 1) % CAPACITY;
    return index;
  }

  function spawn(style, x, y, z, craftVelocity) {
    const index = claim();
    const shade = 0.94 + Math.random() * 0.06;
    positionX[index] = x;
    positionY[index] = y;
    positionZ[index] = z;
    velocityX[index] = craftVelocity.x * style.inherit + (Math.random() * 2 - 1) * style.spread;
    velocityY[index] = craftVelocity.y * style.inherit + (Math.random() * 2 - 1) * style.spread;
    velocityZ[index] = craftVelocity.z * style.inherit + (Math.random() * 2 - 1) * style.spread;
    age[index] = 0;
    life[index] = randomRange(style.life);
    birthSize[index] = randomRange(style.birthSize);
    deathSize[index] = randomRange(style.deathSize);
    rise[index] = style.rise;
    drag[index] = style.drag;
    peakOpacity[index] = style.opacity;
    red[index] = style.tint[0] * shade;
    green[index] = style.tint[1] * shade;
    blue[index] = style.tint[2] * shade;
  }

  return {
    object: sprite,
    get count() { return live; },

    /**
     * Emits kind ('smoke' | 'spray') at a world position for dt seconds of flight; puffs are spread
     * along the segment since the previous emission so fast craft leave a continuous trail.
     */
    emit(kind, position, craftVelocity, dt) {
      const style = STYLES[kind];
      if (!style || !(dt > 0)) return;
      emitDebt[kind] += style.rate * dt;
      const count = Math.floor(emitDebt[kind]);
      emitDebt[kind] -= count;
      const from = hasLastEmit[kind] ? lastEmit[kind] : position;
      for (let puff = 0; puff < count; puff++) {
        const t = count > 1 ? (puff + 1) / count : 1;
        spawn(style, from.x + (position.x - from.x) * t, from.y + (position.y - from.y) * t, from.z + (position.z - from.z) * t, craftVelocity);
      }
      lastEmit[kind].copy(position);
      hasLastEmit[kind] = true;
      emittedThisFrame[kind] = true;
    },

    /** Ends every trail at once (craft changes and teleports). */
    clear() {
      life.fill(0);
      live = 0;
      sprite.count = 0;
      sprite.visible = false;
      hasLastEmit.smoke = false;
      hasLastEmit.spray = false;
    },

    /** Ages and moves the puffs, then writes camera-relative instance data (float32-safe far out). */
    update(dt, camera) {
      // A trail that paused restarts at the craft instead of bridging the gap.
      for (const kind of Object.keys(emittedThisFrame)) {
        if (!emittedThisFrame[kind] && dt > 0) hasLastEmit[kind] = false;
        emittedThisFrame[kind] = false;
      }
      if (!camera) return;
      const cameraPosition = camera.position;
      sprite.position.copy(cameraPosition);
      let written = 0;
      for (let index = 0; index < CAPACITY; index++) {
        if (life[index] <= 0) continue;
        if (dt > 0) {
          age[index] += dt;
          if (age[index] >= life[index]) {
            life[index] = 0;
            continue;
          }
          const dragFactor = Math.exp(-drag[index] * dt);
          velocityX[index] *= dragFactor;
          velocityY[index] = velocityY[index] * dragFactor + rise[index] * dt;
          velocityZ[index] *= dragFactor;
          positionX[index] += velocityX[index] * dt;
          positionY[index] += velocityY[index] * dt;
          positionZ[index] += velocityZ[index] * dt;
        }
        const offsetX = positionX[index] - cameraPosition.x;
        const offsetY = positionY[index] - cameraPosition.y;
        const offsetZ = positionZ[index] - cameraPosition.z;
        const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
        const lifeRatio = age[index] / life[index];
        const fadeIn = smooth01(age[index] / 0.25);
        const alpha = peakOpacity[index] * fadeIn * Math.pow(1 - lifeRatio, 1.4) * smooth01((distance - NEAR_FADE_START) / NEAR_FADE_RANGE);
        offsets[written * 3] = offsetX;
        offsets[written * 3 + 1] = offsetY;
        offsets[written * 3 + 2] = offsetZ;
        tints[written * 4] = red[index];
        tints[written * 4 + 1] = green[index];
        tints[written * 4 + 2] = blue[index];
        tints[written * 4 + 3] = alpha;
        shapes[written * 2] = birthSize[index] + (deathSize[index] - birthSize[index]) * Math.sqrt(lifeRatio);
        shapes[written * 2 + 1] = lifeRatio;
        written++;
      }
      live = written;
      sprite.count = written;
      sprite.visible = written > 0;
      if (written > 0) {
        offsetAttribute.needsUpdate = true;
        tintAttribute.needsUpdate = true;
        shapeAttribute.needsUpdate = true;
      }
    },
  };
}
