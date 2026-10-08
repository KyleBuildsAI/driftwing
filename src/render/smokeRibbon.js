// Smoke ribbon: the aerobatic craft's display smoke as one sunlit ribbon mesh that hangs in the sky
// where it was laid, drifts with the wind it was released into, widens as it diffuses and fades out
// over LIFE (30 s).
//
// Pooled: one mesh with fixed buffers of CAPACITY samples (a ring), built once with the craft; samples
// are two vertices each (both edges of the ribbon), and the ring's quads join consecutive samples of
// the same strip (a strip ends when the smoke goes off, the craft respawns or teleports; its last quad
// becomes degenerate). While the smoke is on, the newest sample (the head) rides the nozzle every frame
// and a new one is committed every SPACING metres (or MAX_INTERVAL seconds), so the ribbon always
// reaches the craft and tight loops stay smooth. Each frame uploads only the samples it wrote.
//
// Origin-anchored (contract a.7): the float32 positions are relative to an anchor (the mesh position,
// in the world frame) that follows the craft in REANCHOR steps, rewriting the live samples from their
// float64 copies, so the buffer never holds large numbers and the scene's render origin needs nothing
// more. Ages run on the flight clock (time since the ribbon was built), so a paused game pauses the fade.
//
// The vertex shader (positionNode) drifts each sample by its wind times its age, widens it with age and
// turns the ribbon to face the camera about its own direction of travel (with a minimum angular width,
// so a trail far off still reads as a line). The fragment shader gives it soft edges, a fade-in at the
// nozzle, a thinning and a fade-out with age, and light like v1's vapour: sun-warmed, sky-tinted, glowing
// when it lies between the camera and the sun, and dim and blue at night. Expired samples collapse to
// zero width.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createRangeList } from '../spawns/engines/engineKit.js';

export const SMOKE_RIBBON = Object.freeze({
  /** Seconds a sample lives (the fade). */
  LIFE: 30,
  /** Samples in the ring: 30 s at Vne (113 m/s) every 4 m is about 850. */
  CAPACITY: 1024,
  SPACING: 4,
  MAX_INTERVAL: 0.35,
  /** A nozzle jump longer than this in one frame (m) breaks the strip (respawn, teleport). */
  TELEPORT: 250,
  /** The anchor follows the nozzle once it is this far away (m). */
  REANCHOR: 2000,
  /** Half-widths (m) at birth and at the end of the fade; each sample varies by +-15 %. */
  BIRTH_HALF_WIDTH: 0.45,
  DEATH_HALF_WIDTH: 5.5,
  /** Buoyant smoke rises slowly on top of the wind (m/s). */
  RISE: 0.3,
  OPACITY: 0.74,
  FADE_IN: 0.2,
  NEAR_FADE_START: 3,
  NEAR_FADE_RANGE: 9,
  /** Minimum half-width as a share of the camera distance (about 1 px at 1080p). */
  MIN_ANGULAR_WIDTH: 0.0012,
  /** Draws after the first build so the pipelines compile before the smoke is first switched on. */
  PRIME_FRAMES: 2,
});

const DEAD_BIRTH = -1e6;
const RENDER_ORDER = 3;

/**
 * Builds the ribbon into ctx.scene. Returns { mesh, update(dt, frame), clear(), getStats(), dispose() },
 * where frame = { emitting, position, velocity, wind, tint, time } (world position and velocity of the
 * nozzle, the wind there in m/s, the tint [r, g, b] 0..1 and the flight clock in seconds).
 */
export function createSmokeRibbon(ctx, { capacity = SMOKE_RIBBON.CAPACITY } = {}) {
  const { scene, uniforms } = ctx;
  const {
    Fn, float, vec3, vec4, uniform, attribute, positionGeometry, positionWorld, cameraPosition, modelWorldMatrix,
    normalize, cross, length, max, mix, pow, saturate, smoothstep, sqrt, abs, step, dot,
  } = TSL;
  const vertexCount = capacity * 2;
  const positions = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 3);
  const info = new Float32Array(vertexCount * 4);
  const drifts = new Float32Array(vertexCount * 3);
  const tints = new Float32Array(vertexCount * 3);
  const indices = new Uint16Array(capacity * 6);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    info[vertex * 4] = DEAD_BIRTH;
    info[vertex * 4 + 1] = vertex % 2 === 0 ? -1 : 1;
  }
  for (let segment = 0; segment < capacity; segment++) indices.fill(segment * 2, segment * 6, segment * 6 + 6);

  const geometry = new THREE.BufferGeometry();
  const attributes = {
    position: new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    smokeTangent: new THREE.BufferAttribute(tangents, 3).setUsage(THREE.DynamicDrawUsage),
    smokeInfo: new THREE.BufferAttribute(info, 4).setUsage(THREE.DynamicDrawUsage),
    smokeDrift: new THREE.BufferAttribute(drifts, 3).setUsage(THREE.DynamicDrawUsage),
    smokeTint: new THREE.BufferAttribute(tints, 3).setUsage(THREE.DynamicDrawUsage),
  };
  for (const [name, attributeBuffer] of Object.entries(attributes)) {
    attributeBuffer.updateRanges = createRangeList(2);
    geometry.setAttribute(name, attributeBuffer);
  }
  const indexAttribute = new THREE.BufferAttribute(indices, 1).setUsage(THREE.DynamicDrawUsage);
  indexAttribute.updateRanges = createRangeList(2);
  geometry.setIndex(indexAttribute);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const uploads = [...Object.values(attributes).map((buffer) => ({ buffer, perSample: buffer.itemSize * 2 })), { buffer: indexAttribute, perSample: 6 }];

  // ---- Material ----------------------------------------------------------------------------------
  const clock = uniform(0);
  const sampleInfo = attribute('smokeInfo', 'vec4');
  const tangent = attribute('smokeTangent', 'vec3');
  const drift = attribute('smokeDrift', 'vec3');
  const tint = attribute('smokeTint', 'vec3');
  // smokeInfo: x birth (s on the ribbon clock), y side (-1 left edge, +1 right edge), z seed 0..1,
  // w strength 0..1 (a strip's first and last samples fade in and out).
  const age = clock.sub(sampleInfo.x);
  const lifeShare = saturate(age.div(SMOKE_RIBBON.LIFE));
  const alive = float(1).sub(step(float(SMOKE_RIBBON.LIFE), age));

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.positionNode = Fn(() => {
    const centre = positionGeometry.add(drift.mul(age));
    const origin = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const toCamera = cameraPosition.sub(origin).sub(centre);
    const across = cross(tangent, toCamera);
    const side = across.div(max(length(across), 1e-4));
    const growth = mix(float(SMOKE_RIBBON.BIRTH_HALF_WIDTH), float(SMOKE_RIBBON.DEATH_HALF_WIDTH), sqrt(lifeShare));
    const halfWidth = max(growth.mul(sampleInfo.z.mul(0.3).add(0.85)), length(toCamera).mul(SMOKE_RIBBON.MIN_ANGULAR_WIDTH)).mul(alive);
    return centre.add(side.mul(sampleInfo.y.mul(halfWidth)));
  })();
  material.colorNode = Fn(() => {
    const viewDirection = normalize(positionWorld.sub(cameraPosition));
    const sunUp = smoothstep(float(-0.05), float(0.25), uniforms.sunDirection.y);
    const forwardScatter = pow(saturate(dot(viewDirection, uniforms.sunDirection)), float(5)).mul(0.55).mul(sunUp);
    const sunlit = tint.mul(sunUp.mul(0.38).add(0.62)).mul(mix(vec3(1, 1, 1), uniforms.sunColor, 0.35));
    const lit = mix(sunlit, uniforms.skyHorizonColor, 0.12).add(uniforms.sunColor.mul(forwardScatter));
    return mix(lit, tint.mul(vec3(0.3, 0.34, 0.44)), uniforms.nightFactor.mul(0.8));
  })();
  material.opacityNode = Fn(() => {
    const across = abs(sampleInfo.y);
    const edge = pow(saturate(float(1).sub(across.mul(across))), float(1.4));
    const fadeIn = smoothstep(float(0), float(SMOKE_RIBBON.FADE_IN), age);
    const fadeOut = pow(float(1).sub(lifeShare), float(1.3));
    const thinning = mix(float(1), float(0.45), sqrt(lifeShare));
    const distance = length(positionWorld.sub(cameraPosition));
    const near = smoothstep(float(SMOKE_RIBBON.NEAR_FADE_START), float(SMOKE_RIBBON.NEAR_FADE_START + SMOKE_RIBBON.NEAR_FADE_RANGE), distance);
    return saturate(edge.mul(fadeIn).mul(fadeOut).mul(thinning).mul(near).mul(sampleInfo.w).mul(SMOKE_RIBBON.OPACITY));
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'smoke-ribbon';
  mesh.frustumCulled = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  // ---- Ring state (world float64 copies for re-anchoring) ---------------------------------------
  const worldX = new Float64Array(capacity);
  const worldY = new Float64Array(capacity);
  const worldZ = new Float64Array(capacity);
  const anchor = { x: 0, y: 0, z: 0, set: false };
  /** Serial number of the head sample (index = serial % capacity); -1 before the first. */
  let headSerial = -1;
  let strip = false;
  /** Where the head's predecessor was committed (world) and when (ribbon clock). */
  const committed = { x: 0, y: 0, z: 0, time: 0 };
  const lastNozzle = { x: 0, y: 0, z: 0, valid: false };
  const lastTangent = { x: 0, y: 0, z: -1 };
  let timeBase = NaN;
  let lastBirth = DEAD_BIRTH;
  let primeFrames = SMOKE_RIBBON.PRIME_FRAMES;
  const dirty = { from: Infinity, to: -Infinity, full: false };
  const counters = { strips: 0, committed: 0, reanchors: 0 };

  function markDirty(serial) {
    dirty.from = Math.min(dirty.from, serial);
    dirty.to = Math.max(dirty.to, serial);
  }

  function setSegment(serial, linked) {
    const index = ((serial % capacity) + capacity) % capacity;
    const next = (index + 1) % capacity;
    const offset = index * 6;
    if (linked) {
      indices[offset] = index * 2;
      indices[offset + 1] = index * 2 + 1;
      indices[offset + 2] = next * 2;
      indices[offset + 3] = index * 2 + 1;
      indices[offset + 4] = next * 2 + 1;
      indices[offset + 5] = next * 2;
    } else {
      indices.fill(index * 2, offset, offset + 6);
    }
    markDirty(serial);
  }

  function writePosition(index) {
    const x = worldX[index] - anchor.x;
    const y = worldY[index] - anchor.y;
    const z = worldZ[index] - anchor.z;
    for (let edge = 0; edge < 2; edge++) {
      const vertex = (index * 2 + edge) * 3;
      positions[vertex] = x;
      positions[vertex + 1] = y;
      positions[vertex + 2] = z;
    }
  }

  /** Writes a sample's every attribute (both edges). */
  function writeSample(serial, frame, birth, strength) {
    const index = serial % capacity;
    worldX[index] = frame.position.x;
    worldY[index] = frame.position.y;
    worldZ[index] = frame.position.z;
    writePosition(index);
    const velocity = frame.velocity;
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed > 0.5) {
      lastTangent.x = velocity.x / speed;
      lastTangent.y = velocity.y / speed;
      lastTangent.z = velocity.z / speed;
    }
    const seed = (Math.sin(serial * 12.9898) * 43758.5453) % 1;
    for (let edge = 0; edge < 2; edge++) {
      const vertex = index * 2 + edge;
      tangents[vertex * 3] = lastTangent.x;
      tangents[vertex * 3 + 1] = lastTangent.y;
      tangents[vertex * 3 + 2] = lastTangent.z;
      info[vertex * 4] = birth;
      info[vertex * 4 + 2] = Math.abs(seed);
      info[vertex * 4 + 3] = strength;
      drifts[vertex * 3] = frame.wind.x;
      drifts[vertex * 3 + 1] = frame.wind.y + SMOKE_RIBBON.RISE;
      drifts[vertex * 3 + 2] = frame.wind.z;
      tints[vertex * 3] = frame.tint[0];
      tints[vertex * 3 + 1] = frame.tint[1];
      tints[vertex * 3 + 2] = frame.tint[2];
    }
    lastBirth = birth;
    markDirty(serial);
  }

  /** A new sample after the head (a new strip when linked is false). */
  function addSample(frame, birth, strength, linked) {
    headSerial++;
    writeSample(headSerial, frame, birth, strength);
    setSegment(headSerial - 1, linked);
    // The new sample's own quad would join the oldest sample of the ring: empty until a successor comes.
    setSegment(headSerial, false);
    committed.x = frame.position.x;
    committed.y = frame.position.y;
    committed.z = frame.position.z;
    committed.time = birth;
    counters.committed++;
  }

  function reanchor(position) {
    anchor.x = position.x;
    anchor.y = position.y;
    anchor.z = position.z;
    anchor.set = true;
    mesh.position.set(anchor.x, anchor.y, anchor.z);
    for (let index = 0; index < capacity; index++) writePosition(index);
    dirty.full = true;
    counters.reanchors++;
  }

  function upload() {
    if (dirty.full) {
      for (const { buffer } of uploads) {
        buffer.updateRanges.length = 0;
        buffer.needsUpdate = true;
      }
    } else if (dirty.to >= dirty.from) {
      const count = dirty.to - dirty.from + 1;
      if (count >= capacity) {
        for (const { buffer } of uploads) {
          buffer.updateRanges.length = 0;
          buffer.needsUpdate = true;
        }
      } else {
        const start = ((dirty.from % capacity) + capacity) % capacity;
        const firstCount = Math.min(count, capacity - start);
        for (const { buffer, perSample } of uploads) {
          buffer.updateRanges.length = 0;
          buffer.updateRanges.add(start * perSample, firstCount * perSample);
          if (firstCount < count) buffer.updateRanges.add(0, (count - firstCount) * perSample);
          buffer.needsUpdate = true;
        }
      }
    }
    dirty.from = Infinity;
    dirty.to = -Infinity;
    dirty.full = false;
  }

  function endStrip() {
    if (!strip) return;
    strip = false;
    // The last sample fades the strip out.
    const index = headSerial % capacity;
    info[index * 8 + 3] = 0;
    info[index * 8 + 7] = 0;
    markDirty(headSerial);
  }

  return {
    mesh,

    /** One frame: lays smoke at the nozzle while frame.emitting, then uploads what changed. */
    update(dt, frame) {
      if (!Number.isFinite(timeBase)) timeBase = frame.time;
      const now = frame.time - timeBase;
      clock.value = now;
      const position = frame.position;
      const valid = Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
      if (frame.emitting && valid) {
        if (!anchor.set || Math.hypot(position.x - anchor.x, position.y - anchor.y, position.z - anchor.z) > SMOKE_RIBBON.REANCHOR) reanchor(position);
        const jump = lastNozzle.valid ? Math.hypot(position.x - lastNozzle.x, position.y - lastNozzle.y, position.z - lastNozzle.z) : 0;
        if (strip && jump > SMOKE_RIBBON.TELEPORT) endStrip();
        if (!strip) {
          strip = true;
          counters.strips++;
          addSample(frame, now, 0, false);
          addSample(frame, now, 1, true);
        } else {
          const travelled = Math.hypot(position.x - committed.x, position.y - committed.y, position.z - committed.z);
          if (travelled >= SMOKE_RIBBON.SPACING || now - committed.time >= SMOKE_RIBBON.MAX_INTERVAL) addSample(frame, now, 1, true);
          else writeSample(headSerial, frame, now, 1);
        }
      } else {
        endStrip();
      }
      if (valid) {
        lastNozzle.x = position.x;
        lastNozzle.y = position.y;
        lastNozzle.z = position.z;
        lastNozzle.valid = true;
      }
      upload();
      const live = strip || now - lastBirth < SMOKE_RIBBON.LIFE;
      mesh.visible = live || primeFrames > 0;
      if (primeFrames > 0 && dt > 0) primeFrames--;
    },

    /** Ends the strip and removes every sample at once. */
    clear() {
      strip = false;
      for (let vertex = 0; vertex < vertexCount; vertex++) info[vertex * 4] = DEAD_BIRTH;
      for (let segment = 0; segment < capacity; segment++) indices.fill(segment * 2, segment * 6, segment * 6 + 6);
      lastBirth = DEAD_BIRTH;
      lastNozzle.valid = false;
      dirty.full = true;
      upload();
      mesh.visible = false;
    },

    /** { liveSamples, strips, committed, reanchors, emitting } (tests). */
    getStats() {
      const now = clock.value;
      let liveSamples = 0;
      for (let index = 0; index < capacity; index++) if (now - info[index * 8] < SMOKE_RIBBON.LIFE) liveSamples++;
      return { liveSamples, strips: counters.strips, committed: counters.committed, reanchors: counters.reanchors, emitting: strip };
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
