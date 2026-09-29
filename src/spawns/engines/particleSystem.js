// The emitter engine's GPU particles: two shared pools (soft alpha-blended puffs and additive glows),
// each one instanced quad mesh drawn in a single call, whatever the number of emitters.
//
// Emitters own ROWS of three shared uniform tables (up to maxEmitters rows):
//   params  PARAM_ROWS vec4 per row: motion, size and colour over life, lighting, style, the field
//           grid's placement. Written when an emitter is created or re-tiered.
//   frame   FRAME_ROWS vec4 per row: the row's frame origin relative to the camera (written every
//           frame in float64 on the CPU, so float32 never sees world coordinates), the underglow
//           intensity and the fade.
//   field   FIELD_NODES vec4 per row: a coarse 4 x 3 x 4 grid of the WindField's air velocity (xyz)
//           and the ground height under the node (w), sampled on the CPU a few nodes per frame (the
//           engine's field budget) and eased over a few seconds. Particles read it by trilinear
//           interpolation: wind-driven motion with no per-particle CPU work.
// and PAGES of PAGE_SIZE particle slots in a pool. Every slot has three BIRTH records written by the
// CPU once, when the emitter emits it:
//   birthA  position (m, relative to its row's frame origin), birth time (engine clock, s)
//   birthB  velocity (m/s), life (s)
//   birthC  row, seed (0..1), size scale, brightness
// uploaded through pooled update ranges (64-slot chunks), so an emission costs bytes, not the buffer.
//
// Motion, per backend:
//   WebGPU  a TSL compute kernel integrates every live particle's state (stateP: position and birth
//           stamp; stateV: velocity and the ground under it) each frame in storage buffers: gravity,
//           decaying buoyancy, drag toward the local wind (sampled at the particle's own position
//           every step), and the ground (settle or bounce).
//   WebGL2  the vertex shader evaluates the closed-form solution of the same equations of motion
//           from the birth records (dv/dt = G + b0 e^(-lambda t) up + k (w - v), with w the local
//           wind at the particle's drift-free position), clamped to the ground. No per-particle CPU
//           work either, and it looks the same: the only differences are that the wind is taken as
//           constant along each path and a bounce settles.
// Rendering is shared: turbulent spread (a seeded random walk growing with the square root of the
// age) and wobble, size, colour and opacity over life, velocity stretch (sparks), terrain depth fade
// and a near-camera fade (soft particles without a depth texture, identical on both backends), sun
// and sky lighting with an underglow (a plume lit from below by lava), HDR emission for the bloom,
// and fog with a per-emitter strength. Five sprite styles: puff, glow, spark, lantern, droplet.
//
// Zero allocations per frame: every table is a typed array or a pooled Vector4, update ranges are
// pooled objects, and the frame path passes no doubles across non-inlined calls.
import { createSlotAllocator } from '../pools.js';

export const PAGE_SIZE = 1024;
export const PARAM_ROWS = 12;
export const FRAME_ROWS = 2;
export const FIELD_X = 4;
export const FIELD_Y = 3;
export const FIELD_NODES = FIELD_X * FIELD_Y * FIELD_X;
/** Emission sprite styles, by index in the params table. */
export const PARTICLE_STYLES = Object.freeze(['puff', 'glow', 'spark', 'lantern', 'droplet']);
export const GROUND_MODES = Object.freeze(['none', 'settle', 'bounce']);
/** Slots per upload chunk: an emission uploads the chunks it touched. */
const CHUNK_SLOTS = 64;
/** Update ranges one attribute may carry in a frame before the whole buffer goes instead. */
const MAX_RANGES = 192;
const RENDER_ORDER = Object.freeze({ alpha: 3, additive: 6 });
/**
 * The v1 cloud look (src/render/clouds.js), so lit puffs sit in the same light as the clouds: the
 * shade palette by sun elevation (degrees, linear rgb), the lit gain, the moonlight.
 */
const SHADE_KEYS = Object.freeze([
  [-18, 0.02, 0.024, 0.042],
  [-9, 0.03, 0.034, 0.058],
  [-3, 0.075, 0.07, 0.11],
  [2, 0.14, 0.14, 0.19],
  [8, 0.18, 0.2, 0.27],
  [18, 0.29, 0.33, 0.41],
  [35, 0.42, 0.47, 0.56],
]);
const LIT_GAIN = 1.2;
const MOONLIGHT = Object.freeze([0.05, 0.06, 0.085]);

/** Smooth 0..1 of value between edge0 and edge1 (three's MathUtils.smoothstep argument order differs). */
function smoothRange(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Builds the particle system. options: THREE, TSL, scene, backend ('WebGPU' uses compute),
 * uniforms (the game's shared TSL uniforms), maxEmitters, pages ({ alpha, additive }: pages per pool).
 */
export function createParticleSystem({ THREE, TSL, scene, backend, uniforms, maxEmitters, pages }) {
  const {
    Fn, If, Return, float, int, vec2, vec3, vec4, uniform, uniformArray, instanceIndex, instancedBufferAttribute,
    storage, positionGeometry, modelViewMatrix, cameraProjectionMatrix, uv, varyingProperty,
    abs, exp, sqrt, pow, sin, cos, atan, min, max, mix, clamp, floor, smoothstep, saturate, length, hash, rotate, select,
  } = TSL;
  const useCompute = backend === 'WebGPU';

  // ---- Shared tables --------------------------------------------------------------------------------
  const paramVectors = Array.from({ length: maxEmitters * PARAM_ROWS }, () => new THREE.Vector4());
  const frameVectors = Array.from({ length: maxEmitters * FRAME_ROWS }, () => new THREE.Vector4());
  const fieldVectors = Array.from({ length: maxEmitters * FIELD_NODES }, () => new THREE.Vector4());
  const paramTable = uniformArray(paramVectors, 'vec4');
  const frameTable = uniformArray(frameVectors, 'vec4');
  const fieldTable = uniformArray(fieldVectors, 'vec4');
  const clock = uniform(0);
  const stepSeconds = uniform(0);
  const fogNear = uniform(400);
  const fogFar = uniform(2400);
  const rows = createSlotAllocator(maxEmitters);
  // The cloud look, refreshed every frame from the sky (updateLook).
  const look = {
    lit: uniform(new THREE.Color(1, 1, 1)),
    shade: uniform(new THREE.Color(0.3, 0.33, 0.4)),
    moon: uniform(new THREE.Color(0, 0, 0)),
    rim: uniform(new THREE.Color(0, 0, 0)),
    silver: uniform(1),
  };
  const lookScratch = new THREE.Color();

  /** The cloud look for the sky's current state (the formulas of clouds.js updateLook). */
  function updateLook(time) {
    const elevation = time.sunElevation;
    const sunVisibility = smoothRange(-0.03, 0.05, time.sunDirection.y);
    const dayness = smoothRange(10, 32, elevation);
    const sunColor = uniforms.sunColor.value;
    const peak = Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4);
    const lit = look.lit.value.setRGB(sunColor.r / peak, sunColor.g / peak, sunColor.b / peak);
    const whiten = 0.4 + 0.45 * dayness;
    lit.setRGB(lit.r + (1 - lit.r) * whiten, lit.g + (1 - lit.g) * whiten, lit.b + (1 - lit.b) * whiten).multiplyScalar((LIT_GAIN - 0.18 * dayness) * sunVisibility);
    const shade = look.shade.value;
    let key = 0;
    while (key < SHADE_KEYS.length - 1 && elevation > SHADE_KEYS[key + 1][0]) key++;
    const lower = SHADE_KEYS[key];
    const upper = SHADE_KEYS[Math.min(key + 1, SHADE_KEYS.length - 1)];
    const blend = upper === lower ? 0 : Math.min(1, Math.max(0, (elevation - lower[0]) / (upper[0] - lower[0])));
    shade.setRGB(lower[1] + (upper[1] - lower[1]) * blend, lower[2] + (upper[2] - lower[2]) * blend, lower[3] + (upper[3] - lower[3]) * blend);
    shade.lerp(lookScratch.copy(uniforms.skyZenithColor.value).multiplyScalar(0.9), 0.12);
    const afterglow = smoothRange(-7, -2, elevation) * (1 - smoothRange(2, 6, elevation));
    if (afterglow > 0) shade.lerp(lookScratch.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.42), 0.5 * afterglow);
    const moonAbove = smoothRange(0, 0.12, time.moonDirection.y);
    look.moon.value.setRGB(MOONLIGHT[0], MOONLIGHT[1], MOONLIGHT[2]).multiplyScalar(time.nightFactor * moonAbove);
    look.rim.value.copy(sunColor).multiplyScalar(0.3 + 0.85 * time.goldenFactor);
    look.silver.value = 1.1 + 0.9 * time.goldenFactor;
  }

  const param = (row, index) => paramTable.element(row.mul(PARAM_ROWS).add(index));
  const frameValue = (row, index) => frameTable.element(row.mul(FRAME_ROWS).add(index));

  /** Air velocity (xyz) and ground height (w) of row's field grid at p (relative to the row's origin). */
  const sampleField = Fn(([row, p]) => {
    const placement = param(row, 10);
    const spacingY = param(row, 11).x;
    const gridX = clamp(p.x.sub(placement.x).div(placement.w), 0, FIELD_X - 1);
    const gridY = clamp(p.y.sub(placement.y).div(spacingY), 0, FIELD_Y - 1);
    const gridZ = clamp(p.z.sub(placement.z).div(placement.w), 0, FIELD_X - 1);
    const cellX = min(floor(gridX), FIELD_X - 2);
    const cellY = min(floor(gridY), FIELD_Y - 2);
    const cellZ = min(floor(gridZ), FIELD_X - 2);
    const fractionX = gridX.sub(cellX);
    const fractionY = gridY.sub(cellY);
    const fractionZ = gridZ.sub(cellZ);
    const base = row.mul(FIELD_NODES).add(int(cellY).mul(FIELD_X * FIELD_X)).add(int(cellZ).mul(FIELD_X)).add(int(cellX));
    const node = (offset) => fieldTable.element(base.add(offset));
    const lower = mix(
      mix(node(0), node(1), fractionX),
      mix(node(FIELD_X), node(FIELD_X + 1), fractionX),
      fractionZ,
    );
    const upper = mix(
      mix(node(FIELD_X * FIELD_X), node(FIELD_X * FIELD_X + 1), fractionX),
      mix(node(FIELD_X * FIELD_X + FIELD_X), node(FIELD_X * FIELD_X + FIELD_X + 1), fractionX),
      fractionZ,
    );
    // The ground is the same on every level: the lower level's bilinear value.
    return vec4(mix(lower.xyz, upper.xyz, fractionY), lower.w);
  });

  /** Ground height (m, relative to the row's origin) at p from the row's field grid. */
  const sampleGround = Fn(([row, p]) => {
    const placement = param(row, 10);
    const gridX = clamp(p.x.sub(placement.x).div(placement.w), 0, FIELD_X - 1);
    const gridZ = clamp(p.z.sub(placement.z).div(placement.w), 0, FIELD_X - 1);
    const cellX = min(floor(gridX), FIELD_X - 2);
    const cellZ = min(floor(gridZ), FIELD_X - 2);
    const base = row.mul(FIELD_NODES).add(int(cellZ).mul(FIELD_X)).add(int(cellX));
    const node = (offset) => fieldTable.element(base.add(offset)).w;
    const fractionX = gridX.sub(cellX);
    return mix(mix(node(0), node(1), fractionX), mix(node(FIELD_X), node(FIELD_X + 1), fractionX), gridZ.sub(cellZ));
  });

  // ---- Pools ----------------------------------------------------------------------------------------
  function createBirthAttribute(capacity) {
    if (useCompute) return new THREE.StorageInstancedBufferAttribute(capacity, 4);
    return new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  }

  function createPool(kind, pageCount) {
    const capacity = pageCount * PAGE_SIZE;
    const chunkCount = capacity / CHUNK_SLOTS;
    const birthAttributes = [createBirthAttribute(capacity), createBirthAttribute(capacity), createBirthAttribute(capacity)];
    const birthA = birthAttributes[0].array;
    const birthB = birthAttributes[1].array;
    const birthC = birthAttributes[2].array;
    const dirty = new Uint8Array(chunkCount);
    const inFlight = new Uint8Array(chunkCount);
    const ranges = Array.from({ length: MAX_RANGES }, () => ({ start: 0, count: 0 }));
    const pageSlots = createSlotAllocator(pageCount);
    const flags = { dirty: false, pending: false };

    let stateAttributes = null;
    let computeNode = null;
    if (useCompute) {
      stateAttributes = [new THREE.StorageInstancedBufferAttribute(capacity, 4), new THREE.StorageInstancedBufferAttribute(capacity, 4)];
      computeNode = buildKernel(birthAttributes, stateAttributes, capacity);
    }
    const material = buildMaterial(kind, birthAttributes, stateAttributes, capacity);
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `emitter-particles-${kind}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER[kind];
    mesh.count = 0;
    mesh.visible = false;
    scene.add(mesh);

    function markChunk(slot) {
      dirty[(slot / CHUNK_SLOTS) | 0] = 1;
      flags.dirty = true;
    }

    /** Pushes the chunks in flight as update ranges on every birth attribute and bumps their versions. */
    function flush() {
      if (!flags.dirty && !flags.pending) return;
      // three clears an attribute's update ranges once it uploads them: an empty list means the
      // previous frame's ranges reached the GPU, so only this frame's chunks remain in flight.
      const consumed = birthAttributes[0].updateRanges.length === 0;
      if (consumed) inFlight.fill(0);
      if (flags.dirty) {
        for (let chunk = 0; chunk < chunkCount; chunk++) if (dirty[chunk] === 1) inFlight[chunk] = 1;
        dirty.fill(0);
        flags.dirty = false;
      } else if (consumed) {
        flags.pending = false;
        return;
      }
      let rangeCount = 0;
      let chunk = 0;
      while (chunk < chunkCount && rangeCount <= MAX_RANGES) {
        if (inFlight[chunk] === 0) {
          chunk++;
          continue;
        }
        const start = chunk;
        while (chunk < chunkCount && inFlight[chunk] === 1) chunk++;
        if (rangeCount < MAX_RANGES) {
          ranges[rangeCount].start = start * CHUNK_SLOTS * 4;
          ranges[rangeCount].count = (chunk - start) * CHUNK_SLOTS * 4;
        }
        rangeCount++;
      }
      for (let index = 0; index < 3; index++) {
        const attribute = birthAttributes[index];
        attribute.updateRanges.length = 0;
        // Too many scattered chunks: the whole buffer goes (no ranges means a whole upload).
        if (rangeCount <= MAX_RANGES) for (let range = 0; range < rangeCount; range++) attribute.updateRanges.push(ranges[range]);
        attribute.needsUpdate = true;
      }
      flags.pending = rangeCount > 0;
    }

    return {
      kind,
      capacity,
      mesh,
      material,
      computeNode,
      /** The GPU state buffers (WebGPU only; null on WebGL2), for read-back in the dev checks. */
      stateAttributes,
      pageSlots,
      birthA,
      birthB,
      birthC,
      /** Writes one particle's birth records into slot. Positions are relative to its row's origin. */
      write(slot, x, y, z, birthTime, vx, vy, vz, life, row, seed, sizeScale, brightness) {
        const offset = slot * 4;
        birthA[offset] = x;
        birthA[offset + 1] = y;
        birthA[offset + 2] = z;
        birthA[offset + 3] = birthTime;
        birthB[offset] = vx;
        birthB[offset + 1] = vy;
        birthB[offset + 2] = vz;
        birthB[offset + 3] = life;
        birthC[offset] = row;
        birthC[offset + 1] = seed;
        birthC[offset + 2] = sizeScale;
        birthC[offset + 3] = brightness;
        markChunk(slot);
      },
      /** Ends a slot's particle at once (its life becomes 0). */
      kill(slot) {
        const offset = slot * 4;
        if (birthB[offset + 3] === 0) return;
        birthB[offset + 3] = 0;
        markChunk(slot);
      },
      flush,
      /** Draws only up to the highest page in use. */
      refreshCount() {
        mesh.count = pageSlots.highWater * PAGE_SIZE;
        mesh.visible = mesh.count > 0;
        if (computeNode) computeNode.count = Math.max(1, mesh.count);
      },
      get buffers() { return birthAttributes.length + (stateAttributes ? stateAttributes.length : 0); },
      dispose() {
        mesh.removeFromParent();
        geometry.dispose();
        material.dispose();
        if (computeNode) computeNode.dispose();
      },
    };
  }

  // ---- WebGPU: the compute kernel -------------------------------------------------------------------
  function buildKernel(birthAttributes, stateAttributes, capacity) {
    const birthA = storage(birthAttributes[0], 'vec4', capacity).toReadOnly();
    const birthB = storage(birthAttributes[1], 'vec4', capacity).toReadOnly();
    const birthC = storage(birthAttributes[2], 'vec4', capacity).toReadOnly();
    const stateP = storage(stateAttributes[0], 'vec4', capacity);
    const stateV = storage(stateAttributes[1], 'vec4', capacity);
    const kernel = Fn(() => {
      const born = birthA.element(instanceIndex);
      const motion = birthB.element(instanceIndex);
      const age = clock.sub(born.w);
      If(motion.w.lessThanEqual(0).or(age.greaterThan(motion.w)), () => {
        Return();
      });
      const row = int(birthC.element(instanceIndex).x);
      const position = stateP.element(instanceIndex);
      const velocity = stateV.element(instanceIndex);
      // A new birth record: start where the closed-form motion puts it (it left the emitter age
      // seconds ago; a warm start's particles are up to a life old).
      If(position.w.notEqual(born.w), () => {
        const settled = closedForm(row, born.xyz, motion.xyz, age, sampleField(row, born.xyz).xyz);
        const start = settled.position.toVar();
        const startGround = sampleGround(row, start);
        If(param(row, 1).w.greaterThan(0.5), () => {
          start.y.assign(max(start.y, startGround.add(param(row, 9).x)));
        });
        position.assign(vec4(start, born.w));
        velocity.assign(vec4(settled.velocity, startGround));
        Return();
      });
      const forces = param(row, 0);
      const drag = forces.w;
      const buoyancy = param(row, 1);
      const p = position.xyz.toVar();
      const field = sampleField(row, p);
      const lift = buoyancy.x.mul(exp(buoyancy.y.negate().mul(age)));
      const acceleration = forces.xyz.add(vec3(0, lift, 0)).add(field.xyz.mul(buoyancy.z).mul(drag));
      // Semi-implicit drag: stable for any step.
      const v = velocity.xyz.add(acceleration.mul(stepSeconds)).div(drag.mul(stepSeconds).add(1)).toVar();
      p.addAssign(v.mul(stepSeconds));
      const ground = field.w;
      const groundMode = buoyancy.w;
      const floorY = ground.add(param(row, 9).x);
      If(groundMode.greaterThan(0.5).and(p.y.lessThan(floorY)), () => {
        p.y.assign(floorY);
        If(groundMode.greaterThan(1.5).and(v.y.lessThan(-1)), () => {
          const restitution = param(row, 11).y;
          v.assign(vec3(v.x.mul(0.6), v.y.negate().mul(restitution), v.z.mul(0.6)));
        }).Else(() => {
          const friction = exp(stepSeconds.mul(-6));
          v.assign(vec3(v.x.mul(friction), 0, v.z.mul(friction)));
        });
      });
      position.assign(vec4(p, born.w));
      velocity.assign(vec4(v, ground));
    });
    return kernel().compute(capacity);
  }

  // ---- WebGL2: the closed-form motion ---------------------------------------------------------------
  /** Position (xyz) of a particle age seconds old, and with it the velocity, under wind w. */
  function closedForm(row, start, initial, age, wind) {
    const forces = param(row, 0);
    const drag = forces.w;
    const buoyancy = param(row, 1);
    const decay = buoyancy.y;
    const dragFall = exp(drag.negate().mul(age));
    const liftFall = exp(decay.negate().mul(age));
    const liftCoefficient = buoyancy.x.div(drag.sub(decay));
    const drift = wind.mul(buoyancy.z).add(forces.xyz.div(drag));
    const transient = initial.sub(drift).sub(vec3(0, liftCoefficient, 0));
    const position = start.add(drift.mul(age))
      .add(vec3(0, liftCoefficient.mul(float(1).sub(liftFall)).div(decay), 0))
      .add(transient.mul(float(1).sub(dragFall)).div(drag));
    const velocity = drift.add(vec3(0, liftCoefficient.mul(liftFall), 0)).add(transient.mul(dragFall));
    return { position, velocity };
  }

  // ---- Material -------------------------------------------------------------------------------------
  function buildMaterial(kind, birthAttributes, stateAttributes, capacity) {
    const additive = kind === 'additive';
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
    });
    const readBirth = (index) => (useCompute
      ? storage(birthAttributes[index], 'vec4', capacity).toReadOnly().element(instanceIndex)
      : instancedBufferAttribute(birthAttributes[index], 'vec4'));
    const born = readBirth(0);
    const motion = readBirth(1);
    const identity = readBirth(2);
    const stateP = useCompute ? storage(stateAttributes[0], 'vec4', capacity).toReadOnly().element(instanceIndex) : null;
    const stateV = useCompute ? storage(stateAttributes[1], 'vec4', capacity).toReadOnly().element(instanceIndex) : null;

    // Per-particle values the vertex stage hands the fragment stage.
    const vAlbedo = varyingProperty('vec3', 'vParticleAlbedo');
    const vGlow = varyingProperty('vec3', 'vParticleGlow');
    const vEmit = varyingProperty('vec3', 'vParticleEmit');
    const vShape = varyingProperty('vec4', 'vParticleShape');
    const vLight = varyingProperty('vec4', 'vParticleLight');
    const vUp = varyingProperty('vec4', 'vParticleUp');
    const vToward = varyingProperty('float', 'vParticleTowardSun');

    material.vertexNode = Fn(() => {
      const row = int(identity.x);
      const seed = identity.y;
      const age = clock.sub(born.w);
      const life = motion.w;
      const alive = select(life.greaterThan(0).and(age.greaterThanEqual(0)).and(age.lessThanEqual(life)), float(1), float(0));
      const lifeT = saturate(age.div(max(life, 0.001)));

      const groundParams = param(row, 9);
      const groundMode = param(row, 1).w;
      const position = vec3(0).toVar();
      const velocity = vec3(0).toVar();
      const ground = float(0).toVar();
      if (useCompute) {
        position.assign(stateP.xyz);
        velocity.assign(stateV.xyz);
        ground.assign(stateV.w);
      } else {
        const still = closedForm(row, born.xyz, motion.xyz, age, vec3(0));
        const wind = sampleField(row, still.position).xyz;
        const moving = closedForm(row, born.xyz, motion.xyz, age, wind);
        position.assign(moving.position);
        velocity.assign(moving.velocity);
        ground.assign(sampleGround(row, position));
        If(groundMode.greaterThan(0.5).and(position.y.lessThan(ground.add(groundParams.x))), () => {
          position.y.assign(ground.add(groundParams.x));
          velocity.assign(vec3(velocity.x.mul(0.2), 0, velocity.z.mul(0.2)));
        });
      }

      // Turbulence: a seeded random walk (spread grows with the square root of the age) and a wobble.
      const turbulence = param(row, 8);
      const seedBits = seed.mul(16777216);
      const direction = vec3(hash(seedBits), hash(seedBits.add(1)), hash(seedBits.add(2))).mul(2).sub(1);
      const spreadVector = direction.mul(turbulence.x).mul(sqrt(age)).mul(vec3(1, turbulence.w, 1));
      const wobblePhase = age.mul(turbulence.z);
      const wobble = vec3(
        sin(wobblePhase.add(seed.mul(19.1))),
        sin(wobblePhase.mul(0.77).add(seed.mul(41.3))).mul(0.5),
        cos(wobblePhase.mul(1.13).add(seed.mul(27.7))),
      ).mul(turbulence.y);
      const drawn = position.add(spreadVector).add(wobble).toVar();
      If(groundMode.greaterThan(0.5), () => {
        drawn.y.assign(max(drawn.y, ground.add(groundParams.x)));
      });

      // Size over life, clamped to about 60 degrees on screen right at the lens.
      const sizing = param(row, 2);
      const frame = frameValue(row, 0);
      const offset = drawn.add(frame.xyz);
      const distance = length(offset);
      const size = mix(sizing.x, sizing.y, pow(lifeT, sizing.z)).mul(identity.z).mul(frameValue(row, 1).y);
      const drawnSize = min(size, distance.mul(1.15));
      const viewCentre = modelViewMatrix.mul(vec4(offset, 1));
      const viewVelocity = modelViewMatrix.mul(vec4(velocity, 0)).xy;
      const viewSpeed = length(viewVelocity);
      const stretch = viewSpeed.mul(sizing.w);
      const streaking = sizing.w.greaterThan(0).and(viewSpeed.greaterThan(0.01));
      const angle = select(streaking, atan(viewVelocity.y, viewVelocity.x).sub(Math.PI / 2), seed.mul(Math.PI * 2));
      const corner = rotate(positionGeometry.xy.mul(vec2(drawnSize, drawnSize.add(stretch))), angle).mul(alive);
      const viewPosition = vec4(viewCentre.xy.add(corner), viewCentre.zw);

      // Opacity over life, the terrain depth fade and the near-camera fade.
      const fades = param(row, 6);
      const colorStart = param(row, 3);
      const colorMid = param(row, 4);
      const colorEnd = param(row, 5);
      const fadeIn = smoothstep(0, max(colorStart.w, 0.0005), lifeT);
      const fadeOut = pow(float(1).sub(lifeT), colorEnd.w);
      const depthFade = select(groundParams.y.greaterThan(0), smoothstep(0, max(groundParams.y, 0.001), drawn.y.sub(ground)), float(1));
      const nearFade = smoothstep(0.55, 1.5, distance.div(max(drawnSize, 0.01)));
      const alpha = fades.x.mul(fadeIn).mul(fadeOut).mul(depthFade).mul(nearFade).mul(frameValue(row, 1).x).mul(alive);

      // Colour over life (three stops), the underglow reaching this height, and HDR emission.
      const midPoint = max(colorMid.w, 0.001);
      const early = mix(colorStart.xyz, colorMid.xyz, saturate(lifeT.div(midPoint)));
      const late = mix(colorMid.xyz, colorEnd.xyz, saturate(lifeT.sub(midPoint).div(max(float(1).sub(midPoint), 0.001))));
      const albedo = select(lifeT.lessThan(midPoint), early, late).mul(identity.w);
      const glowParams = param(row, 7);
      const glowFall = exp(max(drawn.y, 0).negate().div(max(glowParams.w, 1)));
      const extras = param(row, 11);
      const emission = fades.y.mul(exp(fades.z.negate().mul(lifeT))).mul(float(1).add(extras.z.mul(uniforms.nightFactor)));
      vAlbedo.assign(albedo);
      vGlow.assign(glowParams.xyz.mul(frame.w).mul(glowFall));
      vEmit.assign(albedo.mul(emission));
      vShape.assign(vec4(alpha, smoothstep(fogNear, fogFar, distance).mul(groundParams.z), groundParams.w, extras.w));
      // The sun and the sky's up in the sprite's own frame, for the puffs' round shading.
      const sunView = modelViewMatrix.mul(vec4(uniforms.sunDirection, 0)).xyz;
      const upView = modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
      vLight.assign(vec4(rotate(sunView.xy, angle.negate()), sunView.z, fades.w));
      vUp.assign(vec4(rotate(upView.xy, angle.negate()), upView.z, seed));
      vToward.assign(saturate(offset.div(max(distance, 0.001)).dot(uniforms.sunDirection)));
      return cameraProjectionMatrix.mul(viewPosition);
    })();

    const soft = (distanceFromCentre, radius, softness) => pow(saturate(float(1).sub(distanceFromCentre.div(radius))), softness);
    // vec4(mask, core boost, normal xy packed later): each style's coverage and brightness boost.
    const shape = Fn(() => {
      const style = vShape.z;
      const softness = vShape.w;
      const centred = uv().sub(0.5);
      const radius = length(centred).mul(2);
      const mask = float(0).toVar();
      const boost = float(1).toVar();
      If(style.lessThan(0.5), () => {
        // puff: a soft cauliflower of a core and three seeded lobes
        const turn = vUp.w.mul(Math.PI * 2);
        const lobe = (index) => {
          const angleNode = turn.add(index * 2.094);
          return soft(length(centred.sub(vec2(cos(angleNode), sin(angleNode)).mul(0.22))), 0.27, softness);
        };
        mask.assign(max(max(soft(length(centred), 0.4, softness), lobe(0)), max(lobe(1), lobe(2))));
      }).ElseIf(style.lessThan(1.5), () => {
        // glow: a hot core in a wide halo
        const halo = pow(saturate(float(1).sub(radius)), 2.2);
        const core = pow(saturate(float(1).sub(radius.mul(2.4))), 2);
        mask.assign(saturate(halo.add(core)));
        boost.assign(float(1).add(core.mul(1.6)));
      }).ElseIf(style.lessThan(2.5), () => {
        // spark: a streak with a bright spine
        mask.assign(pow(saturate(float(1).sub(radius)), 1.4));
        boost.assign(float(1).add(pow(saturate(float(1).sub(abs(centred.x).mul(4))), 3)));
      }).ElseIf(style.lessThan(3.5), () => {
        // lantern: a glowing paper body, hottest at the flame below, in a faint halo
        const across = abs(centred.x).div(0.24);
        const along = abs(centred.y.add(0.02)).div(0.32);
        const body = float(1).sub(smoothstep(0.82, 1, across)).mul(float(1).sub(smoothstep(0.82, 1, along)));
        const flame = float(1).sub(smoothstep(-0.3, 0.1, centred.y));
        const halo = pow(saturate(float(1).sub(radius)), 3).mul(0.3);
        mask.assign(max(body, halo));
        boost.assign(float(0.75).add(flame.mul(1.2)).add(body.mul(0.25)));
      }).Else(() => {
        // droplet: a small firm dot
        mask.assign(float(1).sub(smoothstep(0.55, 1, radius)));
      });
      return vec2(mask, boost);
    })();

    // Round shading in the v1 cloud light: a sphere's normal across the sprite, the sun key and the
    // shade palette (tops brighter), moonlight, the underglow from below, and a silver lining at the
    // edges when looking toward the sun. Unlit styles keep their colour.
    const shaded = Fn(() => {
      const centred = uv().sub(0.5).mul(2);
      const edge = saturate(centred.dot(centred));
      const normal = vec3(centred, sqrt(float(1).sub(edge)));
      const sunKey = pow(saturate(normal.dot(vLight.xyz).mul(0.62).add(0.38)), 1.6);
      const skyTerm = saturate(normal.dot(vUp.xyz).mul(0.5).add(0.5));
      const occlusion = mix(0.72, 1, skyTerm);
      const body = look.shade.mul(occlusion)
        .add(look.lit.mul(sunKey).mul(mix(occlusion, 1, 0.35)))
        .add(look.moon.mul(skyTerm.mul(0.5).add(0.5)))
        .add(vGlow.mul(float(1).sub(skyTerm).mul(0.7).add(0.3)));
      const toward = vToward;
      const back = look.rim.mul(pow(toward, 4).mul(0.16).add(edge.mul(pow(toward, 3).mul(0.45).add(pow(toward, 16).mul(0.9))).mul(look.silver)));
      const unlit = vAlbedo.add(vAlbedo.mul(vGlow));
      return mix(unlit, vAlbedo.mul(body.add(back)), vLight.w).mul(shape.y).add(vEmit.mul(shape.y));
    })();

    if (additive) {
      material.colorNode = shaded;
      material.opacityNode = saturate(vShape.x.mul(shape.x).mul(float(1).sub(vShape.y)));
    } else {
      material.colorNode = mix(shaded, uniforms.fogColor, vShape.y);
      material.opacityNode = saturate(vShape.x.mul(shape.x));
    }
    return material;
  }

  const pools = {
    alpha: createPool('alpha', pages.alpha),
    additive: createPool('additive', pages.additive),
  };
  const poolList = [pools.alpha, pools.additive];

  return {
    pools,
    rows,
    paramVectors,
    frameVectors,
    fieldVectors,
    clock,
    useCompute,
    /** The meshes (for the pipeline prewarm). */
    meshes: [pools.alpha.mesh, pools.additive.mesh],
    /**
     * Once per frame after the emitters wrote: moves the meshes to the camera, flushes the uploads,
     * draws up to the pages in use, advances the clock and, on WebGPU, runs the integration kernels.
     */
    update(renderer, camera, dt, time, fog, skyTime) {
      clock.value = time;
      updateLook(skyTime);
      stepSeconds.value = dt;
      if (fog) {
        fogNear.value = fog.near;
        fogFar.value = fog.far;
      }
      for (let index = 0; index < poolList.length; index++) {
        const pool = poolList[index];
        // The meshes sit at the camera: the frame table holds every row's origin relative to it.
        pool.mesh.position.copy(camera.position);
        pool.flush();
        pool.refreshCount();
        if (pool.computeNode && dt > 0 && pool.mesh.count > 0) renderer.compute(pool.computeNode);
      }
    },
    /** Builds the compute pipelines once (behind the loading fade), so the first emitter never hitches. */
    prewarm(renderer) {
      if (!useCompute) return;
      for (const pool of poolList) {
        pool.computeNode.count = 1;
        renderer.compute(pool.computeNode);
      }
    },
    dispose() {
      pools.alpha.dispose();
      pools.additive.dispose();
    },
  };
}
