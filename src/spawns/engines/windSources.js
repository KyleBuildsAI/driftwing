// WindField source authoring for the spawn engines (docs/engines/windModifier.md and vortex.md):
// one allocation-free sampler per source type, the parameter defaults and ranges a preset may set,
// and the source's bounds. The VortexEngine authors 'rankine'; the WindModifierEngine authors the
// rest. Pure: it imports nothing, so the node labs build the same sources the game does.
//
//   rankine     a vortex: solid-body rotation inside the core radius and 1/r outside, radial inflow
//               out to the inflow radius, a violent updraft core with a sinking ring, heavy turbulence
//   updraft     a rising column (geyser, thermal plume) with a sinking ring, optional swirl and lean
//   downburst   a downdraft core that spreads along the ground into an expanding outward ring gust
//   wake        a velocity deficit with turbulence trailing downwind (wind farms, large bodies)
//   jetStream   a strong tailwind along a curved tube
//   slipstream  a speed and lift lane trailing a moving body (the sky whale)
//   waveLift    smooth lee-wave lift and sink downwind of a peak, with rotor turbulence beneath
//   gustFront   a moving outflow boundary: lift at the front, gusty outflow behind it
//   curtain     a sheet of sinking air (a waterfall, a rain curtain) spilling outward at its foot
//
// Every source reads a frame (a Float64Array written by its engine each frame: anchor, direction,
// strength, age, speed, noise phase and per-type extras) and returns one reused result object, so
// sampling allocates nothing. Heights are metres above the anchor (the ground or water under a
// spawn, or the body a source follows). Turbulence adds its own gusts: seeded smooth space-time
// noise whose amplitude is the local turbulence times the source's `gust` (m/s), so a craft feels
// the bumps as well as reading the turbulence value (camera shake and cockpit rattle).
//
// The strength (frame STRENGTH) scales velocities; turbulence scales with min(1, strength).

/** Frame slots (Float64Array indices) every source reads. */
export const FRAME = Object.freeze({
  X: 0, Y: 1, Z: 2,               // anchor (m, world)
  DIR_X: 3, DIR_Z: 4,             // unit horizontal direction (heading, travel or downwind)
  STRENGTH: 5,                    // overall multiplier (fades, timeline, stage, control)
  AGE: 6,                         // seconds since the source started
  SPEED: 7,                       // anchor speed (m/s), for the slipstream
  PHASE: 8,                       // seeded noise phase (radians)
  A: 9, B: 10, C: 11, D: 12,      // per-type extras (rankine: lean x, lean z, wobble x, wobble z)
});
export const FRAME_SIZE = 13;

export const WIND_SOURCE_TYPES = Object.freeze(['rankine', 'updraft', 'downburst', 'wake', 'jetStream', 'slipstream', 'waveLift', 'gustFront', 'curtain']);

/**
 * Parameter tables per type: [name, default, min, max, isLength]. Lengths are multiplied by the
 * activation scale. docs/engines/*.md documents every entry with its unit.
 */
const PARAMETERS = Object.freeze({
  rankine: [
    ['coreRadius', 60, 2, 2000, true],
    ['maxTangential', 60, 0, 120, false],
    ['inflowRadius', 1500, 20, 20000, true],
    ['inflowSpeed', 12, 0, 60, false],
    ['updraft', 40, 0, 90, false],
    ['sinkRing', 0.12, 0, 1, false],
    ['top', 1000, 20, 15000, true],
    ['turbulence', 0.9, 0, 1, false],
    ['gust', 7, 0, 30, false],
    ['rotation', 1, -1, 1, false],
  ],
  updraft: [
    ['radius', 180, 5, 5000, true],
    ['strength', 8, -40, 60, false],
    ['base', 0, -500, 10000, true],
    ['top', 900, 10, 15000, true],
    ['sinkRing', 0.2, 0, 1, false],
    ['ringWidth', 1.6, 0.2, 5, false],
    ['lean', 0, -2, 2, false],
    ['swirl', 0, -40, 40, false],
    ['turbulence', 0.45, 0, 1, false],
    ['gust', 3, 0, 30, false],
  ],
  downburst: [
    ['coreRadius', 450, 20, 5000, true],
    ['downdraft', 14, 0, 60, false],
    ['outflow', 16, 0, 60, false],
    ['depth', 250, 20, 3000, true],
    ['top', 1800, 50, 12000, true],
    ['maxRadius', 3200, 50, 20000, true],
    ['expand', 18, 0, 80, false],
    ['frontLift', 4, 0, 30, false],
    ['turbulence', 0.8, 0, 1, false],
    ['gust', 5, 0, 30, false],
  ],
  wake: [
    ['width', 400, 5, 20000, true],
    ['spread', 0.08, 0, 1, false],
    ['length', 3000, 20, 60000, true],
    ['base', 0, -500, 10000, true],
    ['top', 250, 5, 15000, true],
    ['deficit', 3, -30, 30, false],
    ['turbulence', 0.6, 0, 1, false],
    ['gust', 3, 0, 30, false],
  ],
  jetStream: [
    ['radius', 260, 10, 5000, true],
    ['speed', 35, -120, 120, false],
    ['length', 20000, 200, 200000, true],
    ['altitude', 2500, -500, 15000, true],
    ['bend', 1500, 0, 50000, true],
    ['bendWavelength', 14000, 200, 200000, true],
    ['climb', 150, 0, 5000, true],
    ['turbulence', 0.35, 0, 1, false],
    ['gust', 3, 0, 30, false],
  ],
  slipstream: [
    ['length', 1500, 20, 20000, true],
    ['width', 140, 5, 5000, true],
    ['height', 70, 5, 5000, true],
    ['spread', 0.05, 0, 1, false],
    ['offset', 0, -5000, 5000, true],
    ['centerHeight', 0, -5000, 5000, true],
    ['boost', 8, -40, 60, false],
    ['lift', 3, -20, 30, false],
    ['turbulence', 0.3, 0, 1, false],
    ['gust', 2, 0, 30, false],
  ],
  waveLift: [
    ['wavelength', 6000, 200, 40000, true],
    ['amplitude', 4, 0, 30, false],
    ['crests', 3, 1, 12, false],
    ['startOffset', 3000, -20000, 40000, true],
    ['width', 8000, 100, 60000, true],
    ['base', 250, -500, 15000, true],
    ['top', 4500, 50, 20000, true],
    ['rotorTop', 700, 0, 5000, true],
    ['rotorTurbulence', 0.75, 0, 1, false],
    ['rotorReverse', 4, 0, 30, false],
    ['smoothTurbulence', 0.05, 0, 1, false],
    ['gust', 4, 0, 30, false],
  ],
  gustFront: [
    ['length', 8000, 50, 60000, true],
    ['arcRadius', 0, 0, 60000, true],
    ['frontWidth', 350, 20, 5000, true],
    ['depth', 3500, 50, 30000, true],
    ['outflow', 14, 0, 60, false],
    ['outflowTop', 700, 20, 5000, true],
    ['lift', 5, 0, 30, false],
    ['liftTop', 1800, 50, 12000, true],
    ['turbulence', 0.7, 0, 1, false],
    ['gust', 5, 0, 30, false],
  ],
  curtain: [
    ['length', 400, 5, 20000, true],
    ['thickness', 120, 5, 5000, true],
    ['top', 500, 10, 12000, true],
    ['downdraft', 6, 0, 60, false],
    ['outflow', 4, 0, 60, false],
    ['depth', 60, 5, 2000, true],
    ['reach', 320, 10, 20000, true],
    ['turbulence', 0.5, 0, 1, false],
    ['gust', 3, 0, 30, false],
  ],
});

/** Every parameter name of a type (for the docs and the schema of wind params). */
export function sourceParameterNames(type) {
  const table = PARAMETERS[type];
  if (!table) throw new Error(`[DRIFTWING] unknown wind source type "${type}" (known: ${WIND_SOURCE_TYPES.join(', ')})`);
  return table.map((entry) => entry[0]);
}

/**
 * The parameters of a source: every table entry from params (clamped to its range) or its default,
 * lengths times scale. Throws on an unknown type or a non-finite value a preset set.
 */
export function resolveSourceParams(type, params = {}, scale = 1) {
  const table = PARAMETERS[type];
  if (!table) throw new Error(`[DRIFTWING] unknown wind source type "${type}" (known: ${WIND_SOURCE_TYPES.join(', ')})`);
  const resolved = { type };
  for (const [name, fallback, min, max, isLength] of table) {
    const value = params[name];
    if (value !== undefined && !Number.isFinite(value)) throw new TypeError(`[DRIFTWING] wind source "${type}": ${name} must be a finite number, got ${String(value)}`);
    const clamped = Math.min(max, Math.max(min, value === undefined ? fallback : value));
    resolved[name] = isLength ? clamped * scale : clamped;
  }
  return resolved;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The gust inputs of the sample being computed: [time, sigma (m/s)]. Doubles cross into addGusts
 * through this array, not as arguments (V8 boxes a double passed to a call it does not inline).
 */
const gustInput = new Float64Array(2);

/**
 * Adds the turbulence gusts (smooth seeded noise in about [-1, 1] per axis, spatial wavelengths
 * 25-120 m) of intensity gustInput[1] m/s at pos and time gustInput[0] to the result velocity.
 */
function addGusts(result, frame, pos) {
  const sigma = gustInput[1];
  if (sigma <= 0) return;
  const time = gustInput[0];
  const phase = frame[FRAME.PHASE];
  const x = pos.x;
  const z = pos.z;
  const offsetY = phase + 2.39996;
  const offsetZ = phase + 4.79992;
  result.vel.x += sigma * (0.5 * Math.sin(time * 1.9 + x * 0.061 + phase) + 0.3 * Math.sin(time * 3.7 - z * 0.093 + phase * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z) * 0.147 + phase * 2.3));
  result.vel.y += 0.6 * sigma * (0.5 * Math.sin(time * 1.9 + z * 0.061 + offsetY) + 0.3 * Math.sin(time * 3.7 - x * 0.093 + offsetY * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z) * 0.147 + offsetY * 2.3));
  result.vel.z += sigma * (0.5 * Math.sin(time * 1.9 + (x + 311) * 0.061 + offsetZ) + 0.3 * Math.sin(time * 3.7 - (z - 173) * 0.093 + offsetZ * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z + 138) * 0.147 + offsetZ * 2.3));
}

// ---- Samplers (each returns result, written in place) -----------------------------------------
function createRankineSampler(p, frame, result) {
  const core = p.coreRadius;
  const inflowRadius = Math.max(p.inflowRadius, core * 2);
  const top = p.top;
  const spin = p.rotation >= 0 ? 1 : -1;
  return function sampleRankine(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const height = pos.y - frame[FRAME.Y];
    const heightShare = height / top;
    // The axis follows the rope: a lean growing with height and a mid-height wobble.
    const bow = Math.sin(Math.PI * Math.min(1, Math.max(0, heightShare)));
    const centerX = frame[FRAME.X] + frame[FRAME.A] * heightShare + frame[FRAME.C] * bow;
    const centerZ = frame[FRAME.Z] + frame[FRAME.B] * heightShare + frame[FRAME.D] * bow;
    const dx = pos.x - centerX;
    const dz = pos.z - centerZ;
    const radius = Math.sqrt(dx * dx + dz * dz) + 1e-3;
    const vertical = smoothstep(-60, 10, height) * (1 - smoothstep(0.85, 1.05, heightShare));
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (vertical <= 0 || strength <= 0) return result;
    const radialX = dx / radius;
    const radialZ = dz / radius;
    const outer = 1 - smoothstep(0.75 * inflowRadius, inflowRadius, radius);
    // Rankine: solid body inside the core, 1/r outside.
    const tangential = p.maxTangential * (radius < core ? radius / core : core / radius) * outer;
    // The pull reaches most of the inflow radius (about 40 % of inflowSpeed at 2/3 of it) and fades out at it.
    const inflowShape = smoothstep(0.5 * core, 1.6 * core, radius) * (1 - smoothstep(0.55 * inflowRadius, inflowRadius, radius));
    const inflow = p.inflowSpeed * inflowShape * (0.45 + 0.55 * Math.min(1, (2 * core) / radius)) * (1 - smoothstep(0.35, 0.85, heightShare));
    const coreShare = radius / (1.1 * core);
    const ringShare = (radius - 2.8 * core) / (1.2 * core);
    const liftProfile = smoothstep(-10, 0.15 * top, height) * (1 - smoothstep(0.9, 1.1, heightShare));
    const updraft = p.updraft * (Math.exp(-coreShare * coreShare) - p.sinkRing * Math.exp(-ringShare * ringShare)) * liftProfile;
    const scale = strength * vertical;
    // Counterclockwise from above (cyclonic) for rotation 1: the tangent is (dz, -dx) / r.
    result.vel.x = (tangential * spin * radialZ - inflow * radialX) * scale;
    result.vel.z = (-tangential * spin * radialX - inflow * radialZ) * scale;
    result.vel.y = updraft * scale;
    const turbulenceShare = (radius / (2.2 * core));
    const turbulence = p.turbulence * Math.max(Math.exp(-turbulenceShare * turbulenceShare), 0.45 * (1 - smoothstep(0.3 * inflowRadius, inflowRadius, radius))) * vertical * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust * Math.min(1.5, strength);
    addGusts(result, frame, pos);
    return result;
  };
}

function createUpdraftSampler(p, frame, result) {
  const span = Math.max(1, p.top - p.base);
  const ramp = Math.min(150, 0.15 * span);
  const ringOuter = 1 + p.ringWidth;
  return function sampleUpdraft(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const height = pos.y - frame[FRAME.Y];
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    const vertical = smoothstep(p.base - 20, p.base + ramp, height) * (1 - smoothstep(p.top - 0.2 * span, p.top, height));
    if (vertical <= 0 || strength <= 0) return result;
    const rise = Math.max(0, height - p.base) * p.lean;
    const dx = pos.x - (frame[FRAME.X] + frame[FRAME.DIR_X] * rise);
    const dz = pos.z - (frame[FRAME.Z] + frame[FRAME.DIR_Z] * rise);
    const radius = Math.sqrt(dx * dx + dz * dz) + 1e-3;
    const share = radius / p.radius;
    if (share >= ringOuter) return result;
    const core = share < 1 ? (1 - share * share) * (1 - share * share) : 0;
    const ring = share >= 1 ? Math.sin(Math.PI * (share - 1) / p.ringWidth) : 0;
    const scale = strength * vertical;
    result.vel.y = p.strength * (core - p.sinkRing * ring) * scale;
    if (p.swirl !== 0) {
      const swirl = p.swirl * (share < 1 ? share : Math.max(0, 1 - (share - 1) / p.ringWidth)) * scale / radius;
      result.vel.x = swirl * dz;
      result.vel.z = -swirl * dx;
    }
    const edge = smoothstep(0.6, 1, share) * (1 - smoothstep(1, ringOuter, share));
    const turbulence = p.turbulence * Math.max(0.6 * core, edge) * vertical * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createDownburstSampler(p, frame, result) {
  const core = p.coreRadius;
  return function sampleDownburst(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    // A: the ring front's radius (the engine grows it with the age).
    const front = frame[FRAME.A];
    const height = pos.y - frame[FRAME.Y];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const radius = Math.sqrt(dx * dx + dz * dz) + 1e-3;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || height > p.top || height < -40) return result;
    const coreShare = radius / core;
    const coreShape = Math.exp(-coreShare * coreShare);
    // The downdraft slows to nothing at the ground, where it turns outward.
    const sinking = smoothstep(0, 1.2 * p.depth, height) * (1 - smoothstep(0.8 * p.top, p.top, height));
    const downdraft = -p.downdraft * coreShape * sinking;
    const behind = (front - radius) / (0.25 * core);
    const ahead = (radius - front) / (0.15 * core);
    const ringShape = radius <= front ? 0.55 + 0.45 * Math.exp(-behind * behind) : Math.exp(-ahead * ahead);
    const outflowShape = smoothstep(0, 1.2 * core, radius) * ringShape * Math.sqrt(core / Math.max(radius, core));
    const layer = Math.exp(-Math.max(height, 0) / p.depth) * smoothstep(-20, 10, height);
    const outflow = p.outflow * outflowShape * layer;
    const headShare = (radius - front) / (0.2 * core);
    const headLift = p.frontLift * Math.exp(-headShare * headShare) * smoothstep(0, p.depth, height) * (1 - smoothstep(p.depth, 3 * p.depth, height));
    result.vel.x = (dx / radius) * outflow * strength;
    result.vel.z = (dz / radius) * outflow * strength;
    result.vel.y = (downdraft + headLift) * strength;
    const frontShare = (radius - front) / (0.35 * core);
    const turbulence = p.turbulence * Math.max(0.5 * coreShape * sinking, Math.exp(-frontShare * frontShare) * (1 - smoothstep(2 * p.depth, 4 * p.depth, height)), 0.4 * outflowShape * layer) * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createWakeSampler(p, frame, result) {
  const verticalSpan = Math.max(1, p.top - p.base);
  return function sampleWake(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const height = pos.y - frame[FRAME.Y];
    const along = dx * dirX + dz * dirZ;
    const lateral = -dx * dirZ + dz * dirX;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || along < -0.5 * p.width || along > p.length) return result;
    const halfWidth = 0.5 * p.width + p.spread * Math.max(0, along);
    const across = Math.abs(lateral) / halfWidth;
    if (across >= 1) return result;
    const lateralShape = (1 - across * across) * (1 - across * across);
    const alongShape = smoothstep(-0.5 * p.width, 0, along) * (1 - smoothstep(0.6 * p.length, p.length, along));
    const vertical = smoothstep(p.base - 10, p.base + Math.min(40, 0.2 * verticalSpan), height) * (1 - smoothstep(p.top - 0.3 * verticalSpan, p.top, height));
    const decay = 1 - 0.6 * Math.max(0, along) / p.length;
    const shape = lateralShape * alongShape * vertical * decay;
    if (shape <= 0) return result;
    const deficit = p.deficit * shape * strength;
    result.vel.x = -dirX * deficit;
    result.vel.z = -dirZ * deficit;
    const turbulence = p.turbulence * shape * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

/**
 * The jet stream's tube: a polyline of JET_SEGMENTS segments relative to the anchor, bending
 * sideways (bend, bendWavelength) and gently up and down (climb) along the direction it was created
 * with. path: Float64Array of (x, y, z) offsets, JET_SEGMENTS + 1 points.
 */
export const JET_SEGMENTS = 48;
export function buildJetPath(p, dirX, dirZ, seedPhase) {
  const path = new Float64Array((JET_SEGMENTS + 1) * 3);
  for (let index = 0; index <= JET_SEGMENTS; index++) {
    const along = (index / JET_SEGMENTS - 0.5) * p.length;
    const side = p.bend * Math.sin((2 * Math.PI * along) / p.bendWavelength + seedPhase);
    const rise = p.climb * Math.sin((2 * Math.PI * along) / (1.7 * p.bendWavelength) + seedPhase * 1.3);
    path[index * 3] = dirX * along - dirZ * side;
    path[index * 3 + 1] = p.altitude + rise;
    path[index * 3 + 2] = dirZ * along + dirX * side;
  }
  return path;
}

function createJetStreamSampler(p, frame, result, path) {
  const radius = p.radius;
  const reach = radius * 1.25;
  const lengths = new Float64Array(JET_SEGMENTS);
  let total = 0;
  for (let index = 0; index < JET_SEGMENTS; index++) {
    const ax = path[index * 3];
    const ay = path[index * 3 + 1];
    const az = path[index * 3 + 2];
    const bx = path[index * 3 + 3];
    const by = path[index * 3 + 4];
    const bz = path[index * 3 + 5];
    lengths[index] = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
    total += lengths[index];
  }
  return function sampleJetStream(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0) return result;
    const px = pos.x - frame[FRAME.X];
    const py = pos.y - frame[FRAME.Y];
    const pz = pos.z - frame[FRAME.Z];
    let best = Infinity;
    let bestSegment = -1;
    let bestT = 0;
    for (let index = 0; index < JET_SEGMENTS; index++) {
      const base = index * 3;
      const ax = path[base];
      const ay = path[base + 1];
      const az = path[base + 2];
      const sx = path[base + 3] - ax;
      const sy = path[base + 4] - ay;
      const sz = path[base + 5] - az;
      const lengthSq = sx * sx + sy * sy + sz * sz;
      let t = ((px - ax) * sx + (py - ay) * sy + (pz - az) * sz) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = px - (ax + sx * t);
      const oy = py - (ay + sy * t);
      const oz = pz - (az + sz * t);
      const distanceSq = ox * ox + oy * oy + oz * oz;
      if (distanceSq < best) {
        best = distanceSq;
        bestSegment = index;
        bestT = t;
      }
    }
    const distance = Math.sqrt(best);
    if (distance >= reach) return result;
    let arc = 0;
    for (let index = 0; index < bestSegment; index++) arc += lengths[index];
    arc = (arc + bestT * lengths[bestSegment]) / total;
    const endTaper = smoothstep(0, 0.08, arc) * (1 - smoothstep(0.92, 1, arc));
    const share = distance / radius;
    const core = share < 1 ? (1 - share * share) * (1 - share * share) : 0;
    const segmentLength = lengths[bestSegment];
    const base = bestSegment * 3;
    const speed = p.speed * core * endTaper * strength / segmentLength;
    result.vel.x = (path[base + 3] - path[base]) * speed;
    result.vel.y = (path[base + 4] - path[base + 1]) * speed;
    result.vel.z = (path[base + 5] - path[base + 2]) * speed;
    // Shear turbulence at the tube's edge, a little in its core.
    const turbulence = p.turbulence * (0.15 * core + smoothstep(0.45, 0.9, share) * (1 - smoothstep(0.95, 1.25, share))) * endTaper * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createSlipstreamSampler(p, frame, result) {
  return function sampleSlipstream(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const behind = -(dx * dirX + dz * dirZ) - p.offset;
    const lateral = -dx * dirZ + dz * dirX;
    const vertical = pos.y - frame[FRAME.Y] - p.centerHeight;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || behind < -0.1 * p.length || behind > p.length) return result;
    const growth = p.spread * Math.max(0, behind);
    const halfWidth = 0.5 * p.width + growth;
    const halfHeight = 0.5 * p.height + 0.5 * growth;
    const shareSq = (lateral / halfWidth) * (lateral / halfWidth) + (vertical / halfHeight) * (vertical / halfHeight);
    if (shareSq >= 1.96) return result;
    const share = Math.sqrt(shareSq);
    const core = share < 1 ? (1 - shareSq) * (1 - shareSq) : 0;
    const alongShape = smoothstep(-0.1 * p.length, 0.05 * p.length, behind) * (1 - smoothstep(0.55 * p.length, p.length, behind));
    const lane = core * alongShape * strength;
    result.vel.x = dirX * p.boost * lane;
    result.vel.z = dirZ * p.boost * lane;
    result.vel.y = p.lift * lane;
    // The body's tip vortices churn the lane's edges.
    const turbulence = p.turbulence * (0.3 * core + smoothstep(0.6, 1, share) * (1 - smoothstep(1, 1.4, share))) * alongShape * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createWaveLiftSampler(p, frame, result) {
  const span = Math.max(1, p.top - p.base);
  const start = p.startOffset - 0.5 * p.wavelength;
  const end = p.startOffset + p.crests * p.wavelength;
  const decayLength = p.crests * p.wavelength * 1.5;
  return function sampleWaveLift(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const height = pos.y - frame[FRAME.Y];
    const along = dx * dirX + dz * dirZ;
    const lateral = -dx * dirZ + dz * dirX;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || along < start || along > end) return result;
    const across = Math.abs(lateral) / (0.5 * p.width);
    const lateralShape = 1 - smoothstep(0.6, 1, across);
    if (lateralShape <= 0) return result;
    const envelope = smoothstep(start, p.startOffset, along) * (1 - smoothstep(end - p.wavelength * 0.5, end, along)) * Math.exp(-Math.max(0, along - p.startOffset) / decayLength) * lateralShape;
    const phase = (2 * Math.PI * (along - p.startOffset)) / p.wavelength;
    // Rising limb upwind of each crest, sinking limb downwind of it.
    const waveVertical = smoothstep(p.base, p.base + 0.2 * span, height) * (1 - smoothstep(p.top - 0.3 * span, p.top, height));
    const lift = p.amplitude * Math.sin(phase) * envelope * waveVertical;
    // Rotors tumble beneath each crest (where the wave's displacement peaks: sin(phase) turning negative).
    const crest = Math.max(0, -Math.cos(phase));
    const rotorVertical = smoothstep(-20, 30, height) * (1 - smoothstep(0.7 * p.rotorTop, p.rotorTop, height));
    const rotor = crest * Math.sqrt(crest) * envelope * rotorVertical;
    const reverse = p.rotorReverse * rotor * (1 - smoothstep(0, 0.5 * p.rotorTop, height));
    result.vel.x = -dirX * reverse * strength;
    result.vel.z = -dirZ * reverse * strength;
    result.vel.y = lift * strength;
    const turbulence = Math.max(p.rotorTurbulence * rotor, p.smoothTurbulence * envelope * waveVertical) * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createGustFrontSampler(p, frame, result) {
  const width = p.frontWidth;
  return function sampleGustFront(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const height = pos.y - frame[FRAME.Y];
    const lateral = -dx * dirZ + dz * dirX;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || height < -40) return result;
    // Distance ahead of the front, and the outward direction: straight, or radial from the arc's centre.
    let ahead;
    let outX = dirX;
    let outZ = dirZ;
    if (p.arcRadius > 0) {
      const cx = dx + dirX * p.arcRadius;
      const cz = dz + dirZ * p.arcRadius;
      const distance = Math.sqrt(cx * cx + cz * cz) + 1e-3;
      ahead = distance - p.arcRadius;
      outX = cx / distance;
      outZ = cz / distance;
    } else {
      ahead = dx * dirX + dz * dirZ;
    }
    if (ahead > 3 * width || ahead < -p.depth) return result;
    const ends = 1 - smoothstep(0.4 * p.length, 0.5 * p.length, Math.abs(lateral));
    if (ends <= 0) return result;
    const frontShare = ahead / (0.4 * width);
    const behindShape = smoothstep(0.5 * width, -0.2 * width, ahead) * (1 - smoothstep(0.5 * p.depth, p.depth, -ahead));
    const layer = smoothstep(-20, 10, height) * (1 - smoothstep(0.6 * p.outflowTop, p.outflowTop, height));
    const outflow = p.outflow * (0.6 + 0.4 * Math.exp(-frontShare * frontShare)) * behindShape * layer * ends * strength;
    const liftShare = (ahead - 0.3 * width) / width;
    const lift = p.lift * Math.exp(-liftShare * liftShare) * smoothstep(0, 200, height) * (1 - smoothstep(0.7 * p.liftTop, p.liftTop, height)) * ends * strength;
    result.vel.x = outX * outflow;
    result.vel.z = outZ * outflow;
    result.vel.y = lift;
    const edgeShare = ahead / (0.8 * width);
    const turbulence = p.turbulence * Math.max(Math.exp(-edgeShare * edgeShare) * (1 - smoothstep(0.7 * p.liftTop, p.liftTop, height)), 0.45 * behindShape * layer) * ends * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

function createCurtainSampler(p, frame, result) {
  return function sampleCurtain(pos, time) {
    const strength = frame[FRAME.STRENGTH];
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    const dx = pos.x - frame[FRAME.X];
    const dz = pos.z - frame[FRAME.Z];
    const height = pos.y - frame[FRAME.Y];
    // across: through the sheet (along the direction it faces); along: its length.
    const across = dx * dirX + dz * dirZ;
    const along = -dx * dirZ + dz * dirX;
    result.vel.x = 0;
    result.vel.y = 0;
    result.vel.z = 0;
    result.turbulence = 0;
    if (strength <= 0 || height > p.top || height < -40) return result;
    const ends = 1 - smoothstep(0.4 * p.length, 0.5 * p.length + p.thickness, Math.abs(along));
    if (ends <= 0) return result;
    const acrossShare = Math.abs(across) / (0.5 * p.thickness);
    const sheet = Math.exp(-2 * acrossShare * acrossShare) * ends;
    const vertical = smoothstep(0, p.depth, height) * (1 - smoothstep(0.9 * p.top, p.top, height));
    const spill = smoothstep(0.3 * p.thickness, p.thickness, Math.abs(across)) * (1 - smoothstep(0.5 * p.reach, p.reach, Math.abs(across))) * Math.exp(-Math.max(height, 0) / p.depth) * smoothstep(-20, 5, height) * ends;
    const outward = (across >= 0 ? 1 : -1) * p.outflow * spill * strength;
    result.vel.x = dirX * outward;
    result.vel.z = dirZ * outward;
    result.vel.y = -p.downdraft * sheet * vertical * strength;
    const turbulence = p.turbulence * Math.max(sheet * (1 - smoothstep(0.9 * p.top, p.top, height)), 0.6 * spill) * Math.min(1, strength);
    result.turbulence = turbulence;
    gustInput[0] = time;
    gustInput[1] = turbulence * p.gust;
    addGusts(result, frame, pos);
    return result;
  };
}

const SAMPLERS = Object.freeze({
  rankine: createRankineSampler,
  updraft: createUpdraftSampler,
  downburst: createDownburstSampler,
  wake: createWakeSampler,
  jetStream: createJetStreamSampler,
  slipstream: createSlipstreamSampler,
  waveLift: createWaveLiftSampler,
  gustFront: createGustFrontSampler,
  curtain: createCurtainSampler,
});

// ---- Bounds --------------------------------------------------------------------------------------
/** The footprint being written (doubles cross into the helpers through it, not as arguments). */
const extent = new Float64Array(5);

/**
 * Writes the bounds of an oriented footprint into bounds.min / max: along the direction from
 * extent[0] to extent[1], across it from -extent[2] to extent[2], heights extent[3]..extent[4]
 * above the anchor.
 */
function orientedBounds(bounds, frame) {
  const alongMin = extent[0];
  const alongMax = extent[1];
  const halfWidth = extent[2];
  const x = frame[FRAME.X];
  const z = frame[FRAME.Z];
  const dirX = frame[FRAME.DIR_X];
  const dirZ = frame[FRAME.DIR_Z];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let corner = 0; corner < 4; corner++) {
    const along = corner < 2 ? alongMin : alongMax;
    const side = (corner & 1) === 0 ? -halfWidth : halfWidth;
    const cornerX = x + dirX * along - dirZ * side;
    const cornerZ = z + dirZ * along + dirX * side;
    if (cornerX < minX) minX = cornerX;
    if (cornerX > maxX) maxX = cornerX;
    if (cornerZ < minZ) minZ = cornerZ;
    if (cornerZ > maxZ) maxZ = cornerZ;
  }
  bounds.min.x = minX;
  bounds.max.x = maxX;
  bounds.min.z = minZ;
  bounds.max.z = maxZ;
  bounds.min.y = frame[FRAME.Y] + extent[3];
  bounds.max.y = frame[FRAME.Y] + extent[4];
}

/** Writes a square footprint of radius extent[2] around the anchor, heights extent[3]..extent[4]. */
function circleBounds(bounds, frame) {
  const radius = extent[2];
  bounds.min.x = frame[FRAME.X] - radius;
  bounds.max.x = frame[FRAME.X] + radius;
  bounds.min.z = frame[FRAME.Z] - radius;
  bounds.max.z = frame[FRAME.Z] + radius;
  bounds.min.y = frame[FRAME.Y] + extent[3];
  bounds.max.y = frame[FRAME.Y] + extent[4];
}

/**
 * Bounds writers, one per type (a single function over every type would see nine parameter shapes
 * and lose its optimisation): each writes the source's current bounds (from its frame) into
 * source.bounds and its horizontal reach from the anchor (m) into source.metrics[0] (written, not
 * returned: a returned double is boxed).
 */
const BOUNDS_WRITERS = Object.freeze({
  rankine(source) {
    const { params: p, frame, bounds, metrics } = source;
    const lean = Math.sqrt(frame[FRAME.A] * frame[FRAME.A] + frame[FRAME.B] * frame[FRAME.B]) + Math.sqrt(frame[FRAME.C] * frame[FRAME.C] + frame[FRAME.D] * frame[FRAME.D]);
    const reach = Math.max(p.inflowRadius, p.coreRadius * 2) + lean;
    extent[2] = reach;
    extent[3] = -60;
    extent[4] = p.top * 1.05;
    circleBounds(bounds, frame);
    metrics[0] = reach;
  },
  updraft(source) {
    const { params: p, frame, bounds, metrics } = source;
    const reach = p.radius * (1 + p.ringWidth) + Math.abs(p.lean) * Math.max(0, p.top - p.base);
    extent[2] = reach;
    extent[3] = p.base - 20;
    extent[4] = p.top;
    circleBounds(bounds, frame);
    metrics[0] = reach;
  },
  downburst(source) {
    const { params: p, frame, bounds, metrics } = source;
    const reach = Math.max(frame[FRAME.A], p.coreRadius) + p.coreRadius * 0.6;
    extent[2] = reach;
    extent[3] = -40;
    extent[4] = p.top;
    circleBounds(bounds, frame);
    metrics[0] = reach;
  },
  wake(source) {
    const { params: p, frame, bounds, metrics } = source;
    const halfWidth = 0.5 * p.width + p.spread * p.length;
    extent[0] = -0.5 * p.width;
    extent[1] = p.length;
    extent[2] = halfWidth;
    extent[3] = p.base - 10;
    extent[4] = p.top;
    orientedBounds(bounds, frame);
    metrics[0] = Math.sqrt(p.length * p.length + halfWidth * halfWidth);
  },
  jetStream(source) {
    const { params: p, frame, bounds, metrics } = source;
    const path = source.path;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let reach = 0;
    for (let index = 0; index <= JET_SEGMENTS; index++) {
      const px = path[index * 3];
      const py = path[index * 3 + 1];
      const pz = path[index * 3 + 2];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
      const distance = Math.sqrt(px * px + pz * pz);
      if (distance > reach) reach = distance;
    }
    const margin = p.radius * 1.25;
    bounds.min.x = frame[FRAME.X] + minX - margin;
    bounds.max.x = frame[FRAME.X] + maxX + margin;
    bounds.min.y = frame[FRAME.Y] + minY - margin;
    bounds.max.y = frame[FRAME.Y] + maxY + margin;
    bounds.min.z = frame[FRAME.Z] + minZ - margin;
    bounds.max.z = frame[FRAME.Z] + maxZ + margin;
    metrics[0] = reach + margin;
  },
  slipstream(source) {
    const { params: p, frame, bounds, metrics } = source;
    const growth = p.spread * p.length;
    const halfWidth = (0.5 * p.width + growth) * 1.4;
    const halfHeight = (0.5 * p.height + 0.5 * growth) * 1.4;
    extent[0] = -p.offset - p.length;
    extent[1] = -p.offset + 0.1 * p.length;
    extent[2] = halfWidth;
    extent[3] = p.centerHeight - halfHeight;
    extent[4] = p.centerHeight + halfHeight;
    orientedBounds(bounds, frame);
    metrics[0] = Math.abs(p.offset) + p.length + halfWidth;
  },
  waveLift(source) {
    const { params: p, frame, bounds, metrics } = source;
    const alongMin = p.startOffset - 0.5 * p.wavelength;
    const alongMax = p.startOffset + p.crests * p.wavelength;
    extent[0] = alongMin;
    extent[1] = alongMax;
    extent[2] = 0.5 * p.width;
    extent[3] = -30;
    extent[4] = p.top;
    orientedBounds(bounds, frame);
    metrics[0] = Math.max(Math.abs(alongMin), Math.abs(alongMax)) + 0.5 * p.width;
  },
  gustFront(source) {
    const { params: p, frame, bounds, metrics } = source;
    const bulge = p.arcRadius > 0 ? p.arcRadius - Math.sqrt(Math.max(0, p.arcRadius * p.arcRadius - 0.25 * p.length * p.length)) : 0;
    extent[0] = -p.depth - bulge;
    extent[1] = 3 * p.frontWidth;
    extent[2] = 0.5 * p.length;
    extent[3] = -40;
    extent[4] = Math.max(p.outflowTop, p.liftTop);
    orientedBounds(bounds, frame);
    metrics[0] = Math.sqrt((p.depth + bulge) * (p.depth + bulge) + 0.25 * p.length * p.length);
  },
  curtain(source) {
    const { params: p, frame, bounds, metrics } = source;
    extent[0] = -p.reach;
    extent[1] = p.reach;
    extent[2] = 0.5 * p.length + p.thickness;
    extent[3] = -40;
    extent[4] = p.top;
    orientedBounds(bounds, frame);
    metrics[0] = Math.sqrt(p.reach * p.reach + (0.5 * p.length + p.thickness) * (0.5 * p.length + p.thickness));
  },
});

/**
 * A wind source of `type` for the WindField, driven by frame (FRAME_SIZE Float64Array the engine
 * writes). Returns { id, type, kind, params, frame, path, result, bounds, reach, sample(pos, t),
 * refreshBounds() }: pass { id, kind, bounds, sample } to wind.addSource; after moving the frame's
 * anchor call refreshBounds() and wind.setSourceBounds(id, source.bounds). Nothing here allocates
 * after creation.
 */
export function createWindSource(THREE, { id, type, params, frame, kind = `spawn-${type}` }) {
  const factory = SAMPLERS[type];
  if (!factory) throw new Error(`[DRIFTWING] unknown wind source type "${type}" (known: ${WIND_SOURCE_TYPES.join(', ')})`);
  if (!(frame instanceof Float64Array) || frame.length < FRAME_SIZE) throw new TypeError('[DRIFTWING] a wind source needs a Float64Array frame of FRAME_SIZE');
  const result = { vel: new THREE.Vector3(), turbulence: 0 };
  const path = type === 'jetStream' ? buildJetPath(params, frame[FRAME.DIR_X], frame[FRAME.DIR_Z], frame[FRAME.PHASE]) : null;
  const writeBounds = BOUNDS_WRITERS[type];
  const source = {
    id,
    type,
    kind,
    params,
    frame,
    path,
    result,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    metrics: new Float64Array(1),
    /** Horizontal reach from the anchor (m), as of the last refreshBounds(). */
    get reach() {
      return source.metrics[0];
    },
    sample: type === 'jetStream' ? factory(params, frame, result, path) : factory(params, frame, result),
    refreshBounds() {
      writeBounds(source);
      return source.bounds;
    },
  };
  source.refreshBounds();
  return source;
}
