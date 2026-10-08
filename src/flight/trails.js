// Craft trails: light particle trails emitted from a craft's anchors (the bush plane's smoke, the
// glider's ballast spray, coloured display smoke: 'smokeColor', tinted per emit). Same technique as v1's bursts (one Sprite drawn instanced with a
// PointsNodeMaterial, camera-relative float32 offsets), but soft, sunlit and alpha-blended instead
// of additive: vapour that streams from the nozzle, billows out, drifts off with the wind and fades.
// Spray (the glider's ballast) falls: a puff that reaches the water it was dumped over (the shared
// water query's static level there: a lake or the sea) is gone.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp } from '../core/util.js';

const CAPACITY = 720;
/**
 * Per-kind emission: rate (puffs/s), life (s), size range at birth and at death (m), how much of the
 * craft's velocity a puff keeps, spread (m/s), rise (m/s^2), drag toward the wind (1/s), fade-in (s),
 * peak opacity and colour. Puffs start small and dense right at the nozzle (visible from the chase
 * camera behind the craft) and grow into a plume that the wind carries away.
 */
const STYLES = Object.freeze({
  smoke: Object.freeze({ rate: 64, life: [3.8, 5.4], birthSize: [0.7, 1], deathSize: [10, 14], inherit: 0.12, spread: 1.1, rise: 0.3, drag: 1.3, fadeIn: 0.05, opacity: 0.62, tint: Object.freeze([0.96, 0.95, 0.93]) }),
  spray: Object.freeze({ rate: 55, life: [0.9, 1.5], birthSize: [0.25, 0.4], deathSize: [1.8, 2.8], inherit: 0.25, spread: 2.2, rise: -2.5, drag: 2.4, fadeIn: 0.08, opacity: 0.35, tint: Object.freeze([0.86, 0.92, 0.98]) }),
  smokeColor: Object.freeze({ rate: 64, life: [3.8, 5.4], birthSize: [0.7, 1], deathSize: [9, 13], inherit: 0.12, spread: 1, rise: 0.25, drag: 1.3, fadeIn: 0.05, opacity: 0.7, tint: Object.freeze([0.96, 0.95, 0.93]) }),
});
const KINDS = Object.freeze(Object.keys(STYLES));

/** Display smoke colours (craftState.smokeColor indexes them; the aerobatic's colour cycle steps through). */
export const SMOKE_COLORS = Object.freeze([
  Object.freeze({ id: 'white', tint: Object.freeze([0.96, 0.95, 0.93]) }),
  Object.freeze({ id: 'red', tint: Object.freeze([0.88, 0.2, 0.16]) }),
  Object.freeze({ id: 'blue', tint: Object.freeze([0.2, 0.38, 0.86]) }),
  Object.freeze({ id: 'yellow', tint: Object.freeze([0.96, 0.82, 0.22]) }),
  Object.freeze({ id: 'green', tint: Object.freeze([0.24, 0.7, 0.34]) }),
  Object.freeze({ id: 'orange', tint: Object.freeze([0.94, 0.48, 0.18]) }),
]);

/** The tint of a smoke colour index (wrapping; white for anything that is not a whole number). */
export function smokeColorTint(index) {
  if (!Number.isInteger(index)) return SMOKE_COLORS[0].tint;
  return SMOKE_COLORS[((index % SMOKE_COLORS.length) + SMOKE_COLORS.length) % SMOKE_COLORS.length].tint;
}
const NEAR_FADE_START = 2;
const NEAR_FADE_RANGE = 8;
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function randomRange(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

export function createTrailSystem(ctx) {
  const { scene, uniforms } = ctx;
  const waterQuery = ctx.waterQuery ?? null;
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
  const windX = new Float32Array(CAPACITY);
  const windY = new Float32Array(CAPACITY);
  const windZ = new Float32Array(CAPACITY);
  const age = new Float32Array(CAPACITY);
  const life = new Float32Array(CAPACITY);
  const birthSize = new Float32Array(CAPACITY);
  const deathSize = new Float32Array(CAPACITY);
  const rise = new Float32Array(CAPACITY);
  const drag = new Float32Array(CAPACITY);
  const fadeIn = new Float32Array(CAPACITY);
  const peakOpacity = new Float32Array(CAPACITY);
  const red = new Float32Array(CAPACITY);
  const green = new Float32Array(CAPACITY);
  const blue = new Float32Array(CAPACITY);
  /** The water level a falling puff ends at (-Infinity: none, smoke and puffs over dry land). */
  const floor = new Float64Array(CAPACITY).fill(-Infinity);
  const floorScratch = new Float64Array(1);
  const emitDebt = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const lastEmit = Object.fromEntries(KINDS.map((kind) => [kind, new THREE.Vector3()]));
  const hasLastEmit = Object.fromEntries(KINDS.map((kind) => [kind, false]));
  const emittedThisFrame = Object.fromEntries(KINDS.map((kind) => [kind, false]));
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

  /**
   * One puff; `age` is how long ago within this frame it left the nozzle (keeps the stream even);
   * tint ([r, g, b]) overrides the style's colour.
   */
  function spawn(style, x, y, z, craftVelocity, wind, startAge, waterFloor, tint) {
    const index = claim();
    floor[index] = waterFloor;
    const shade = 0.94 + Math.random() * 0.06;
    positionX[index] = x;
    positionY[index] = y;
    positionZ[index] = z;
    windX[index] = wind.x;
    windY[index] = wind.y;
    windZ[index] = wind.z;
    velocityX[index] = wind.x + (craftVelocity.x - wind.x) * style.inherit + (Math.random() * 2 - 1) * style.spread;
    velocityY[index] = wind.y + (craftVelocity.y - wind.y) * style.inherit + (Math.random() * 2 - 1) * style.spread;
    velocityZ[index] = wind.z + (craftVelocity.z - wind.z) * style.inherit + (Math.random() * 2 - 1) * style.spread;
    age[index] = startAge;
    life[index] = randomRange(style.life);
    birthSize[index] = randomRange(style.birthSize);
    deathSize[index] = randomRange(style.deathSize);
    rise[index] = style.rise;
    drag[index] = style.drag;
    fadeIn[index] = style.fadeIn;
    peakOpacity[index] = style.opacity;
    const colour = tint ?? style.tint;
    red[index] = colour[0] * shade;
    green[index] = colour[1] * shade;
    blue[index] = colour[2] * shade;
  }

  return {
    object: sprite,
    get count() { return live; },

    /**
     * Emits kind ('smoke' | 'spray' | 'smokeColor') at a world position for dt seconds of flight.
     * Puffs are spread along the segment since the previous frame's emitter position (each aged by
     * when it left the nozzle) so fast craft leave a continuous trail; they relax toward `wind` (m/s,
     * the air mass the craft flies in) so the trail drifts downwind. tint ([r, g, b] 0..1) colours
     * the puffs (display smoke); null keeps the style's colour.
     */
    emit(kind, position, craftVelocity, dt, wind = ZERO, tint = null) {
      const style = STYLES[kind];
      if (!style || !(dt > 0)) return;
      emitDebt[kind] += style.rate * dt;
      const count = Math.floor(emitDebt[kind]);
      emitDebt[kind] -= count;
      const from = hasLastEmit[kind] ? lastEmit[kind] : position;
      floorScratch[0] = -Infinity;
      if (style.rise < 0 && count > 0 && waterQuery !== null) waterQuery.staticLevelInto(position.x, position.z, floorScratch, 0);
      for (let puff = 0; puff < count; puff++) {
        const t = (puff + 1) / count;
        spawn(style, from.x + (position.x - from.x) * t, from.y + (position.y - from.y) * t, from.z + (position.z - from.z) * t, craftVelocity, wind, (1 - t) * dt, floorScratch[0], tint);
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
      for (const kind of KINDS) hasLastEmit[kind] = false;
    },

    /** Ages and moves the puffs, then writes camera-relative instance data (float32-safe far out). */
    update(dt, camera) {
      // A trail that paused restarts at the craft instead of bridging the gap.
      for (const kind of KINDS) {
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
          // Drag pulls each puff toward the wind it was released into; buoyancy (or weight) on top.
          const dragFactor = Math.exp(-drag[index] * dt);
          velocityX[index] = windX[index] + (velocityX[index] - windX[index]) * dragFactor;
          velocityY[index] = windY[index] + (velocityY[index] - windY[index]) * dragFactor + rise[index] * dt;
          velocityZ[index] = windZ[index] + (velocityZ[index] - windZ[index]) * dragFactor;
          positionX[index] += velocityX[index] * dt;
          positionY[index] += velocityY[index] * dt;
          positionZ[index] += velocityZ[index] * dt;
          if (positionY[index] < floor[index]) {
            life[index] = 0;
            continue;
          }
        }
        const offsetX = positionX[index] - cameraPosition.x;
        const offsetY = positionY[index] - cameraPosition.y;
        const offsetZ = positionZ[index] - cameraPosition.z;
        const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
        const lifeRatio = age[index] / life[index];
        const appear = smooth01(age[index] / fadeIn[index]);
        const alpha = peakOpacity[index] * appear * Math.pow(1 - lifeRatio, 1.4) * smooth01((distance - NEAR_FADE_START) / NEAR_FADE_RANGE);
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
