// CHALLENGES (contract f): timed gate courses for every craft. A course is a sequence of gates (a
// start, checkpoints, a finish), each a circle or a rectangle in a plane with a pass direction. The
// system detects crossings on the segment flown each frame (world frame, float64), times the run on
// the flight clock (crossing times interpolated inside the frame, so paused frames and frame rate
// change nothing), handles missed gates (penalty seconds, a void run, or a plain count), gives
// splits against this craft's best, medals against bronze / silver / gold thresholds, and keeps the
// best time per craft, per course, per world in local storage together with the best run's path at
// 10 Hz (8 floats a frame: t, x, y, z and the attitude quaternion) for Phase 4's ghosts.
//
// Courses come from engines and presets (the structure recipe challengeGates builds one from a
// preset's `challenge` block), and from the ring course (src/gameplay/rings.js), which runs on this
// core through a legacy adapter: its course is procedural, so it emits no typed challenge events,
// keeps no records, and hands every crossing back to rings.js, which keeps its Phase 2 events and
// state bit for bit (tools/lab/challenges.mjs replays the Phase 2 golden logs).
//
// state.challenge is the live view the HUD (src/ui/challengeHud.js), the copilot and telemetry read.
// The action challengeStart (Y) starts the nearest course within its prompt radius, or cancels the
// active run. Flying through a course's start gate starts it too.
//
// update() allocates nothing: courses live in an array, the live state objects are reused, and the
// path recorder writes into one preallocated Float32Array.

/** Medals, best first. */
export const MEDALS = Object.freeze(['gold', 'silver', 'bronze']);
export const CHALLENGE_STORAGE_KEY = 'driftwing-v2.challenges';
export const CHALLENGE_PATH_KEY_PREFIX = 'driftwing-v2.challengePath.';
export const CHALLENGE_STORAGE_VERSION = 1;
export const BEST_PATH_HZ = 10;
/** Frames of a recorded best path at most (20 minutes at 10 Hz). */
export const MAX_PATH_FRAMES = 12000;
/** Floats per path frame: t, x, y, z, qx, qy, qz, qw. */
export const PATH_FRAME_STRIDE = 8;
export const GATE_ROLES = Object.freeze(['start', 'checkpoint', 'finish']);
export const GATE_SHAPES = Object.freeze(['circle', 'rect']);
export const MISS_MODES = Object.freeze(['penalty', 'void', 'count']);
export const OUTSIDE_CROSSINGS = Object.freeze(['miss', 'ignore']);
export const START_MODES = Object.freeze(['gate', 'immediate']);
export const START_SOURCES = Object.freeze(['gate', 'key', 'copilot', 'ui', 'rings']);
/** Seconds a finished run stays on state.challenge (phase 'finished') before it clears. */
const FINISHED_HOLD_SECONDS = 6;
/** Course and gate limits. */
const MAX_GATES = 64;
const MAX_NAME_LENGTH = 60;
const MAX_COURSES_STORED = 400;
const DEFAULTS = Object.freeze({
  missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 150 }),
  start: Object.freeze({ mode: 'gate', promptRadius: 1500 }),
  abandonDistance: 4500,
  teleportDistance: 400,
});
const RAD_TO_DEG = 180 / Math.PI;

function courseError(id, field, message) {
  return new TypeError(`[DRIFTWING] challenge course "${id}": ${field} ${message}`);
}

function isPoint(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

/** Compass bearing (degrees, 0 north = -z, 90 east = +x) from (fromX, fromZ) to (toX, toZ). */
function bearing(fromX, fromZ, toX, toZ) {
  const degrees = Math.atan2(toX - fromX, -(toZ - fromZ)) * RAD_TO_DEG;
  return degrees < 0 ? degrees + 360 : degrees;
}

/**
 * Validates a course definition (contract f.1) and returns the normalised, frozen course: gates
 * with unit normals and an orthonormal frame (right, up), the missed, start and sensor rules with
 * their defaults. Throws a TypeError naming the course and the field.
 */
export function validateCourseDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('[DRIFTWING] challenge course: the definition must be an object');
  const id = definition.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_:.-]{1,120}$/.test(id)) throw courseError(String(id), 'id', 'must be a string of 1-120 letters, digits and _ : . -');
  const name = definition.name;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) throw courseError(id, 'name', `must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  if (definition.presetId !== undefined && definition.presetId !== null && typeof definition.presetId !== 'string') throw courseError(id, 'presetId', 'must be a string when present');
  const legacyRings = definition.legacyRings === true;
  const start = { ...DEFAULTS.start, ...(definition.start ?? {}) };
  if (!START_MODES.includes(start.mode)) throw courseError(id, 'start.mode', `must be one of ${START_MODES.join(', ')}`);
  if (!positiveNumber(start.promptRadius)) throw courseError(id, 'start.promptRadius', 'must be a positive number (m)');
  const gates = definition.gates;
  if (!Array.isArray(gates) || gates.length === 0 || gates.length > MAX_GATES) throw courseError(id, 'gates', `must be an array of 1-${MAX_GATES} gates`);
  const seenIds = new Set();
  const normalizedGates = gates.map((gate, index) => {
    const field = `gates[${index}]`;
    if (!gate || typeof gate !== 'object') throw courseError(id, field, 'must be an object');
    if (typeof gate.id !== 'string' || !gate.id || seenIds.has(gate.id)) throw courseError(id, `${field}.id`, 'must be a unique non-empty string');
    seenIds.add(gate.id);
    if (!GATE_ROLES.includes(gate.role)) throw courseError(id, `${field}.role`, `must be one of ${GATE_ROLES.join(', ')}`);
    const last = index === gates.length - 1;
    if (gate.role === 'finish' && !last) throw courseError(id, `${field}.role`, 'finish must be the last gate');
    if (last && gate.role !== 'finish') throw courseError(id, `${field}.role`, 'the last gate must be the finish');
    if (gate.role === 'start' && index !== 0) throw courseError(id, `${field}.role`, 'start must be the first gate');
    if (!isPoint(gate.center)) throw courseError(id, `${field}.center`, 'must be a finite { x, y, z }');
    if (!isPoint(gate.normal)) throw courseError(id, `${field}.normal`, 'must be a finite { x, y, z }');
    const normalLength = Math.hypot(gate.normal.x, gate.normal.y, gate.normal.z);
    if (normalLength < 1e-6) throw courseError(id, `${field}.normal`, 'must not be zero');
    if (!GATE_SHAPES.includes(gate.shape)) throw courseError(id, `${field}.shape`, `must be one of ${GATE_SHAPES.join(', ')}`);
    if (gate.shape === 'circle' && !positiveNumber(gate.radius)) throw courseError(id, `${field}.radius`, 'must be a positive number (m) for a circle');
    if (gate.shape === 'rect' && (!positiveNumber(gate.halfWidth) || !positiveNumber(gate.halfHeight))) throw courseError(id, `${field}.halfWidth / halfHeight`, 'must be positive numbers (m) for a rect');
    // The normal is used exactly as given when it is already unit length (the ring course hands over
    // Vector3.normalize() results, and its crossings must be computed from the same numbers).
    const unit = Math.abs(normalLength - 1) < 1e-12;
    const nx = unit ? gate.normal.x : gate.normal.x / normalLength;
    const ny = unit ? gate.normal.y : gate.normal.y / normalLength;
    const nz = unit ? gate.normal.z : gate.normal.z / normalLength;
    // The frame: up (given, else world up, else north) made orthogonal to the normal; right = up x normal.
    let upX = isPoint(gate.up) ? gate.up.x : 0;
    let upY = isPoint(gate.up) ? gate.up.y : 1;
    let upZ = isPoint(gate.up) ? gate.up.z : 0;
    let along = upX * nx + upY * ny + upZ * nz;
    upX -= nx * along;
    upY -= ny * along;
    upZ -= nz * along;
    let upLength = Math.hypot(upX, upY, upZ);
    if (upLength < 1e-6) {
      upX = 0;
      upY = 0;
      upZ = -1;
      along = upZ * nz;
      upX -= nx * along;
      upY -= ny * along;
      upZ -= nz * along;
      upLength = Math.hypot(upX, upY, upZ);
    }
    upX /= upLength;
    upY /= upLength;
    upZ /= upLength;
    const rightX = upY * nz - upZ * ny;
    const rightY = upZ * nx - upX * nz;
    const rightZ = upX * ny - upY * nx;
    const reach = gate.shape === 'circle' ? gate.radius : Math.hypot(gate.halfWidth, gate.halfHeight);
    return Object.freeze({
      id: gate.id,
      role: gate.role,
      shape: gate.shape,
      cx: gate.center.x,
      cy: gate.center.y,
      cz: gate.center.z,
      nx,
      ny,
      nz,
      ux: upX,
      uy: upY,
      uz: upZ,
      rx: rightX,
      ry: rightY,
      rz: rightZ,
      radius: gate.shape === 'circle' ? gate.radius : 0,
      halfWidth: gate.shape === 'rect' ? gate.halfWidth : 0,
      halfHeight: gate.shape === 'rect' ? gate.halfHeight : 0,
      reach,
    });
  });
  if (start.mode === 'gate' && normalizedGates[0].role !== 'start') throw courseError(id, 'gates[0].role', 'must be start when start.mode is gate');
  if (start.mode === 'gate' && normalizedGates.length < 2) throw courseError(id, 'gates', 'need a start and a finish when start.mode is gate');
  const missed = { ...DEFAULTS.missed, ...(definition.missed ?? {}) };
  if (!MISS_MODES.includes(missed.mode)) throw courseError(id, 'missed.mode', `must be one of ${MISS_MODES.join(', ')}`);
  if (!(Number.isFinite(missed.penaltySeconds) && missed.penaltySeconds >= 0)) throw courseError(id, 'missed.penaltySeconds', 'must be a number >= 0');
  if (!OUTSIDE_CROSSINGS.includes(missed.outsideCrossing)) throw courseError(id, 'missed.outsideCrossing', `must be one of ${OUTSIDE_CROSSINGS.join(', ')}`);
  if (!positiveNumber(missed.skipDistance)) throw courseError(id, 'missed.skipDistance', 'must be a positive number (m)');
  const sensors = {};
  if (definition.sensors !== undefined && definition.sensors !== null) {
    if (typeof definition.sensors !== 'object' || Array.isArray(definition.sensors)) throw courseError(id, 'sensors', 'must be an object { tag: { penaltySeconds } }');
    for (const [tag, rule] of Object.entries(definition.sensors)) {
      if (!rule || typeof rule !== 'object' || !(Number.isFinite(rule.penaltySeconds) && rule.penaltySeconds >= 0)) throw courseError(id, `sensors.${tag}.penaltySeconds`, 'must be a number >= 0');
      sensors[tag] = Object.freeze({ penaltySeconds: rule.penaltySeconds });
    }
  }
  let medals = null;
  if (definition.medals !== undefined && definition.medals !== null) {
    const { gold, silver, bronze } = definition.medals;
    if (!positiveNumber(gold) || !positiveNumber(silver) || !positiveNumber(bronze)) throw courseError(id, 'medals', 'must be null or { gold, silver, bronze } in positive seconds');
    if (!(gold <= silver && silver <= bronze)) throw courseError(id, 'medals', 'must satisfy gold <= silver <= bronze');
    medals = Object.freeze({ gold, silver, bronze });
  }
  const abandonDistance = definition.abandonDistance ?? DEFAULTS.abandonDistance;
  const teleportDistance = definition.teleportDistance ?? DEFAULTS.teleportDistance;
  if (!positiveNumber(abandonDistance)) throw courseError(id, 'abandonDistance', 'must be a positive number (m)');
  if (!positiveNumber(teleportDistance)) throw courseError(id, 'teleportDistance', 'must be a positive number (m)');
  const timeLimit = definition.timeLimit ?? null;
  if (timeLimit !== null && !positiveNumber(timeLimit)) throw courseError(id, 'timeLimit', 'must be null or positive seconds');
  let rival = null;
  if (definition.rival !== undefined && definition.rival !== null) {
    const candidate = definition.rival;
    if (!candidate || typeof candidate.follower?.at !== 'function') throw courseError(id, 'rival.follower', 'must be a PathFollower (src/world/pathFollower.js)');
    if (typeof candidate.follower.atFrom !== 'function') throw courseError(id, 'rival.follower', 'must be a PathFollower with atFrom (src/world/pathFollower.js)');
    if (typeof candidate.path?.nearestDistance !== 'function') throw courseError(id, 'rival.path', 'must be the path the rival follows (createPath)');
    if (typeof candidate.name !== 'string' || !candidate.name) throw courseError(id, 'rival.name', 'must be a non-empty string');
    rival = Object.freeze({ follower: candidate.follower, path: candidate.path, name: candidate.name });
  }
  // Cumulative straight-line distance from the first gate, for the medal pace.
  const gateDistance = new Float64Array(normalizedGates.length);
  for (let index = 1; index < normalizedGates.length; index++) {
    const from = normalizedGates[index - 1];
    const to = normalizedGates[index];
    gateDistance[index] = gateDistance[index - 1] + Math.hypot(to.cx - from.cx, to.cy - from.cy, to.cz - from.cz);
  }
  return Object.freeze({
    id,
    name: name.trim(),
    presetId: typeof definition.presetId === 'string' ? definition.presetId : null,
    gates: Object.freeze(normalizedGates),
    gateDistance,
    medals,
    missed: Object.freeze(missed),
    sensors: Object.freeze(sensors),
    start: Object.freeze(start),
    abandonDistance,
    teleportDistance,
    timeLimit,
    rival,
    record: legacyRings ? false : definition.record !== false,
    legacyRings,
  });
}

/** The best medal a time (seconds, penalties included) earns on a course, or 'none'. */
export function medalFor(medals, time) {
  if (!medals || !Number.isFinite(time)) return 'none';
  if (time <= medals.gold) return 'gold';
  if (time <= medals.silver) return 'silver';
  if (time <= medals.bronze) return 'bronze';
  return 'none';
}

/**
 * Tests the segment (from -> to; { x, y, z } world points) against a normalised gate's plane in its
 * pass direction. Writes into out (a Float64Array of 6): [0] before (signed distance of `from` to
 * the plane), [1] after (of `to`), [2] the crossing share along the segment, [3] the offset of the
 * crossing from the centre (its distance in the plane), [4] the offset along the gate's up, [5] the
 * crossing's world height above the centre (y). Returns 1 for a
 * crossing inside the shape, -1 for a crossing outside it, 0 when the segment does not cross from
 * the back to the front. The plane test is the Phase 2 ring course's, operation for operation.
 */
export function crossGate(gate, from, to, out) {
  const before = (from.x - gate.cx) * gate.nx + (from.y - gate.cy) * gate.ny + (from.z - gate.cz) * gate.nz;
  const after = (to.x - gate.cx) * gate.nx + (to.y - gate.cy) * gate.ny + (to.z - gate.cz) * gate.nz;
  out[0] = before;
  out[1] = after;
  if (!(before < 0 && after >= 0)) return 0;
  const share = before / (before - after);
  const hitX = from.x + (to.x - from.x) * share;
  const hitY = from.y + (to.y - from.y) * share;
  const hitZ = from.z + (to.z - from.z) * share;
  const dx = hitX - gate.cx;
  const dy = hitY - gate.cy;
  const dz = hitZ - gate.cz;
  out[2] = share;
  out[4] = dx * gate.ux + dy * gate.uy + dz * gate.uz;
  out[5] = dy;
  if (gate.shape === 'circle') {
    const offset = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out[3] = offset;
    return offset <= gate.radius ? 1 : -1;
  }
  const across = dx * gate.rx + dy * gate.ry + dz * gate.rz;
  const vertical = out[4];
  out[3] = Math.hypot(across, vertical);
  return Math.abs(across) <= gate.halfWidth && Math.abs(vertical) <= gate.halfHeight ? 1 : -1;
}

// ---- Preset challenge blocks (pure data, validated by the preset schema) ----------------------------
const BLOCK_FIELDS = Object.freeze(['name', 'gates', 'medals', 'missed', 'sensors', 'start', 'abandonDistance', 'teleportDistance', 'timeLimit', 'record', 'frames']);
const BLOCK_GATE_FIELDS = Object.freeze(['id', 'role', 'along', 'across', 'height', 'heading', 'pitch', 'shape', 'radius', 'halfWidth', 'halfHeight']);

/**
 * Validates a preset's `challenge` block (site frame, metres from the site anchor along the site's
 * heading): { name?, gates: [{ id?, role, along, across?, height (m above the ground), heading?
 * (deg, relative to the site heading), pitch? (deg, nose up), shape, radius | halfWidth +
 * halfHeight }], medals?, missed?, sensors?, start?, abandonDistance?, teleportDistance?,
 * timeLimit?, record?, frames? (the structure recipe draws gate frames, default true) }. The frames
 * are visual only; a preset that wants solid frames adds its own colliders. Throws naming the preset
 * and the field; returns true.
 */
export function validateChallengeBlock(block, presetId) {
  const fail = (field, message) => {
    throw new TypeError(`[DRIFTWING] preset "${presetId}": challenge.${field} ${message}`);
  };
  if (!block || typeof block !== 'object' || Array.isArray(block)) fail('', 'must be an object');
  for (const field of Object.keys(block)) if (!BLOCK_FIELDS.includes(field)) fail(field, `is not a challenge field (allowed: ${BLOCK_FIELDS.join(', ')})`);
  if (block.name !== undefined && (typeof block.name !== 'string' || !block.name.trim() || block.name.length > MAX_NAME_LENGTH)) fail('name', `must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  if (!Array.isArray(block.gates) || block.gates.length < 2 || block.gates.length > MAX_GATES) fail('gates', `must list 2-${MAX_GATES} gates`);
  block.gates.forEach((gate, index) => {
    if (!gate || typeof gate !== 'object') fail(`gates[${index}]`, 'must be an object');
    for (const field of Object.keys(gate)) if (!BLOCK_GATE_FIELDS.includes(field)) fail(`gates[${index}].${field}`, `is not a gate field (allowed: ${BLOCK_GATE_FIELDS.join(', ')})`);
    for (const field of ['along', 'height']) if (!Number.isFinite(gate[field])) fail(`gates[${index}].${field}`, 'must be a finite number (m)');
    for (const field of ['across', 'heading', 'pitch']) if (gate[field] !== undefined && !Number.isFinite(gate[field])) fail(`gates[${index}].${field}`, 'must be a finite number when present');
    if (gate.id !== undefined && (typeof gate.id !== 'string' || !gate.id)) fail(`gates[${index}].id`, 'must be a non-empty string when present');
  });
  for (const field of ['frames', 'record']) if (block[field] !== undefined && typeof block[field] !== 'boolean') fail(field, 'must be a boolean when present');
  // The rest is the course definition's own validation, on a course built at the origin.
  try {
    validateCourseDefinition(buildSiteCourse(block, { presetId, siteId: 'validation', presetName: presetId, anchor: { x: 0, y: 0, z: 0 }, heading: 0, ground: () => 0 }));
  } catch (error) {
    fail('', error.message.replace(/^\[DRIFTWING\] challenge course "[^"]*": /, '-> '));
  }
  return true;
}

/**
 * Builds the course definition of a preset's `challenge` block at a site: id
 * `${presetId}:${siteId}`, gates in the world frame (the site anchor, the site heading, each gate
 * `height` metres above `ground(x, z)` (world)). Pure.
 */
export function buildSiteCourse(block, { presetId, siteId, presetName, anchor, heading, ground }) {
  const radians = (heading || 0) * (Math.PI / 180);
  const forwardX = Math.sin(radians);
  const forwardZ = -Math.cos(radians);
  const gates = block.gates.map((gate, index) => {
    const along = gate.along;
    const across = gate.across ?? 0;
    const x = anchor.x + forwardX * along - forwardZ * across;
    const z = anchor.z + forwardZ * along + forwardX * across;
    const gateHeading = radians + (gate.heading ?? 0) * (Math.PI / 180);
    const pitch = (gate.pitch ?? 0) * (Math.PI / 180);
    const shape = gate.shape ?? 'circle';
    const role = gate.role;
    return {
      id: gate.id ?? `g${index}`,
      role,
      center: { x, y: ground(x, z) + gate.height, z },
      normal: { x: Math.sin(gateHeading) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(gateHeading) * Math.cos(pitch) },
      up: { x: -Math.sin(gateHeading) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(gateHeading) * Math.sin(pitch) },
      shape,
      radius: shape === 'circle' ? gate.radius : undefined,
      halfWidth: shape === 'rect' ? gate.halfWidth : undefined,
      halfHeight: shape === 'rect' ? gate.halfHeight : undefined,
    };
  });
  return {
    id: `${presetId}:${siteId}`,
    name: block.name ?? presetName,
    presetId,
    gates,
    medals: block.medals ?? null,
    missed: block.missed,
    sensors: block.sensors,
    start: block.start,
    abandonDistance: block.abandonDistance,
    teleportDistance: block.teleportDistance,
    timeLimit: block.timeLimit ?? null,
    record: block.record !== false,
  };
}

// ---- Records (local storage) ------------------------------------------------------------------------
function sanitizeBest(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!(Number.isFinite(entry.time) && entry.time > 0)) return null;
  const medal = MEDALS.includes(entry.medal) ? entry.medal : 'none';
  const splits = Array.isArray(entry.splits) ? entry.splits.slice(0, MAX_GATES).map((split) => (Number.isFinite(split) ? split : null)) : [];
  return {
    time: entry.time,
    medal,
    splits,
    missed: Number.isInteger(entry.missed) && entry.missed >= 0 ? entry.missed : 0,
    date: Number.isFinite(entry.date) ? entry.date : 0,
  };
}

/** The stored records repaired: { version, courses: { key: { name, presetId, best: { craft: entry } } } }. */
export function sanitizeRecords(stored) {
  const records = { version: CHALLENGE_STORAGE_VERSION, courses: {} };
  if (!stored || typeof stored !== 'object' || stored.version !== CHALLENGE_STORAGE_VERSION || !stored.courses || typeof stored.courses !== 'object') return records;
  let kept = 0;
  for (const [key, course] of Object.entries(stored.courses)) {
    if (kept >= MAX_COURSES_STORED) break;
    if (!course || typeof course !== 'object' || typeof key !== 'string' || key.length > 200) continue;
    const best = {};
    if (course.best && typeof course.best === 'object') {
      for (const [craft, entry] of Object.entries(course.best)) {
        const clean = sanitizeBest(entry);
        if (clean && /^[a-z][A-Za-z0-9]{0,31}$/.test(craft)) best[craft] = clean;
      }
    }
    records.courses[key] = {
      name: typeof course.name === 'string' ? course.name.slice(0, MAX_NAME_LENGTH) : key,
      presetId: typeof course.presetId === 'string' ? course.presetId : null,
      best,
    };
    kept++;
  }
  return records;
}

// ---- The system ---------------------------------------------------------------------------------------
/**
 * Creates the challenge system (ctx.systems.challenges, updated after 'rings'). Reads ctx.state
 * (player, flight, time, seed), ctx.bus, ctx.storage; writes state.challenge.
 */
export function createChallengeSystem(ctx) {
  const { state, bus, storage } = ctx;
  /** Registered courses: { key, course, owner, legacy } (an array, so update() iterates without allocating). */
  const courseList = [];
  const crossing = new Float64Array(6);
  // Doubles handed between functions every frame go through this array (V8 boxes a double passed to
  // a call it does not inline): [0] the path recorder's limit (run time), [1] the frame's dt.
  const frameNumbers = new Float64Array(2);
  const previous = { x: state.player.position.x, y: state.player.position.y, z: state.player.position.z };
  const lerped = { x: 0, y: 0, z: 0 };
  const rivalOut = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, heading: 0, distance: 0, speed: 0, done: false };
  const pathFrames = new Float32Array(MAX_PATH_FRAMES * PATH_FRAME_STRIDE);
  const pathCache = new Map();
  let records = loadRecords();
  let storageWarned = false;

  /** The active run (one at a time), or null. */
  const run = {
    entry: null,
    phase: null,
    source: null,
    craft: null,
    gateIndex: 0,
    // Generic runs: the flight-clock time of the start crossing; legacy runs accumulate dt.
    startedAt: 0,
    elapsed: 0,
    missed: 0,
    penalties: 0,
    voided: false,
    splits: [],
    pathCount: 0,
    finishedHold: 0,
  };

  const live = state.challenge ?? {};
  Object.assign(live, {
    active: false,
    courseKey: null,
    name: null,
    phase: null,
    elapsed: 0,
    gateIndex: 0,
    gatesTotal: 0,
    nextGate: null,
    missed: 0,
    penalties: 0,
    lastSplit: null,
    medalPace: null,
    best: null,
    rival: null,
    prompt: null,
  });
  state.challenge = live;
  // nextGate adds the gate's frame and size to the contract's fields, for the HUD's 3D marker.
  const nextGate = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1, ux: 0, uy: 1, uz: 0, shape: 'circle', radius: 0, halfWidth: 0, halfHeight: 0, distance: 0, bearing: 0 };
  const lastSplit = { index: 0, time: 0, delta: null };
  const rivalState = { distanceAhead: 0, name: '', done: false };
  const prompt = { courseKey: null, name: null, distance: 0, bearing: 0 };

  // ---- Storage --------------------------------------------------------------------------------------
  function loadRecords() {
    return sanitizeRecords(storage.read(CHALLENGE_STORAGE_KEY, null));
  }

  function warnStorage() {
    if (storageWarned) return;
    storageWarned = true;
    bus.emit('notify', { text: 'This browser will not keep your challenge times, but they still count for this flight.', kind: 'warning' });
  }

  function saveRecords() {
    if (!storage.write(CHALLENGE_STORAGE_KEY, records)) warnStorage();
  }

  function pathKey(courseKey, craft) {
    return `${CHALLENGE_PATH_KEY_PREFIX}${courseKey}.${craft}`;
  }

  // ---- Registry -----------------------------------------------------------------------------------------
  function findEntry(courseKey) {
    for (let index = 0; index < courseList.length; index++) if (courseList[index].key === courseKey) return courseList[index];
    return null;
  }

  function register(definition, { owner = 'unknown', legacy = null } = {}) {
    const course = validateCourseDefinition(definition);
    if (course.legacyRings && (!legacy || typeof legacy.crossed !== 'function')) throw courseError(course.id, 'legacyRings', 'needs the ring adapter hooks (rings.js)');
    const key = `${state.seed}:${course.id}`;
    const existing = findEntry(key);
    if (existing) {
      existing.course = course;
      existing.owner = String(owner);
      existing.legacy = course.legacyRings ? legacy : null;
      return key;
    }
    courseList.push({ key, course, owner: String(owner), legacy: course.legacyRings ? legacy : null });
    return key;
  }

  function unregister(courseKey) {
    const entry = findEntry(courseKey);
    if (!entry) return false;
    if (run.entry === entry && isRunning()) cancel('removed');
    unregisterQuietly(entry);
    if (run.entry === entry) clearRun();
    writeLive();
    // The prompt drops a removed course now, not on the next frame.
    writePrompt();
    return true;
  }

  // ---- Run lifecycle --------------------------------------------------------------------------------------
  function clearRun() {
    run.entry = null;
    run.phase = null;
    run.source = null;
    run.finishedHold = 0;
  }

  function firstPlayableGate(course) {
    return course.start.mode === 'immediate' && course.gates[0].role === 'start' ? 1 : 0;
  }

  function resetRun(entry, source) {
    run.entry = entry;
    run.source = source;
    run.craft = state.flight?.craft ?? 'glider';
    run.gateIndex = firstPlayableGate(entry.course);
    run.startedAt = 0;
    run.elapsed = 0;
    run.missed = 0;
    run.penalties = 0;
    run.voided = false;
    run.splits = new Array(entry.course.gates.length).fill(null);
    run.pathCount = 0;
    run.finishedHold = 0;
  }

  /**
   * Arms (start.mode 'gate': the clock starts at the start-gate crossing) or starts (immediate) the
   * course. Any other active run is cancelled first (reason 'replaced'). Returns true when armed or
   * running.
   */
  function start(courseKey, { source = 'key' } = {}) {
    const entry = findEntry(courseKey);
    if (!entry) return false;
    if (!START_SOURCES.includes(source)) throw new TypeError(`[DRIFTWING] challenges.start: unknown source "${source}"`);
    if (isRunning()) cancel('replaced');
    resetRun(entry, source);
    const player = state.player.position;
    previous.x = player.x;
    previous.y = player.y;
    previous.z = player.z;
    if (entry.course.start.mode === 'immediate') beginRunning(state.time.elapsed);
    else {
      run.phase = 'armed';
      writeLive();
    }
    return true;
  }

  /** The clock starts at flight time `at` (a start crossing, or now). */
  function beginRunning(at) {
    run.phase = 'running';
    run.startedAt = at;
    const course = run.entry.course;
    if (!course.legacyRings) {
      bus.emitTyped('challengeStarted', { id: run.entry.key, name: course.name, craft: run.craft, gates: course.gates.length, ...(course.presetId ? { presetId: course.presetId } : {}) });
    }
    writeLive();
  }

  function isRunning() {
    return run.entry !== null && (run.phase === 'armed' || run.phase === 'running');
  }

  /** Ends the active run (armed or running) and emits challengeCancelled; false when nothing runs. */
  function cancel(reason = 'cancelled') {
    if (!isRunning()) return false;
    const entry = run.entry;
    run.phase = null;
    if (entry.legacy) {
      // The ring course reports its own cancel (rings:cancelled), and its course is procedural.
      run.entry = null;
      unregisterQuietly(entry);
      entry.legacy.cancelled(reason);
    } else {
      bus.emitTyped('challengeCancelled', { id: entry.key, reason: String(reason) });
      clearRun();
    }
    writeLive();
    return true;
  }

  function unregisterQuietly(entry) {
    const index = courseList.indexOf(entry);
    if (index >= 0) courseList.splice(index, 1);
  }

  // ---- Gate handling -------------------------------------------------------------------------------------
  /** Run time (s since the start crossing) at the share `share` through this frame (dt in frameNumbers[1]). */
  function runTimeAt(share) {
    const dt = frameNumbers[1];
    return state.time.elapsed - dt + dt * share - run.startedAt;
  }

  function bestFor(entry, craft) {
    return records.courses[entry.key]?.best?.[craft] ?? null;
  }

  function onGateMissed(index, time) {
    const course = run.entry.course;
    run.missed++;
    if (course.missed.mode === 'penalty') run.penalties += course.missed.penaltySeconds;
    else if (course.missed.mode === 'void') run.voided = true;
    const gate = course.gates[index];
    bus.emitTyped('challengeGate', { id: run.entry.key, index, role: gate.role, time, missed: true });
  }

  function onGatePassed(index, time) {
    const course = run.entry.course;
    const gate = course.gates[index];
    const split = time + run.penalties;
    if (gate.role !== 'start') run.splits[index] = split;
    const best = bestFor(run.entry, run.craft);
    const bestSplit = best && Number.isFinite(best.splits[index]) ? best.splits[index] : null;
    const delta = bestSplit === null ? null : split - bestSplit;
    lastSplit.index = index;
    lastSplit.time = split;
    lastSplit.delta = delta;
    live.lastSplit = lastSplit;
    const payload = { id: run.entry.key, index, role: gate.role, time, missed: false };
    if (gate.role !== 'start') payload.split = split;
    if (delta !== null) payload.delta = delta;
    bus.emitTyped('challengeGate', payload);
  }

  /** Moves past gate `index`; finishes the run after the finish gate. */
  function advanceGate(index, time) {
    const course = run.entry.course;
    run.gateIndex = index + 1;
    if (run.gateIndex >= course.gates.length) finishRun(time);
  }

  function finishRun(rawTime) {
    const entry = run.entry;
    const course = entry.course;
    frameNumbers[0] = rawTime;
    recordPath(true);
    const time = rawTime + run.penalties;
    const valid = !run.voided;
    const medal = valid ? medalFor(course.medals, time) : 'none';
    const previousBest = bestFor(entry, run.craft);
    let improved = false;
    if (course.record && valid && (!previousBest || time < previousBest.time)) {
      improved = true;
      const courseRecord = records.courses[entry.key] ?? { name: course.name, presetId: course.presetId, best: {} };
      courseRecord.name = course.name;
      courseRecord.presetId = course.presetId;
      courseRecord.best[run.craft] = { time, medal, splits: run.splits.slice(), missed: run.missed, date: Date.now() };
      records.courses[entry.key] = courseRecord;
      saveRecords();
      saveBestPath(entry.key, run.craft);
    }
    const best = bestFor(entry, run.craft);
    run.phase = 'finished';
    run.finishedHold = FINISHED_HOLD_SECONDS;
    run.elapsed = time;
    writeLive();
    bus.emitTyped('challengeFinished', {
      id: entry.key,
      craft: run.craft,
      time,
      medal,
      best: best ? best.time : null,
      improved,
      missed: run.missed,
      penalties: run.penalties,
      valid,
    });
  }

  // ---- The 10 Hz path ----------------------------------------------------------------------------------------
  /**
   * Writes the path frames due up to run time frameNumbers[0] on the segment flown this frame (from
   * `previous` at the frame's start to the player now; run time is linear along it). `final` adds
   * the exact finish frame after the 10 Hz lattice.
   */
  function recordPath(final) {
    if (!run.entry.course.record) return;
    const limit = frameNumbers[0];
    while (run.pathCount < MAX_PATH_FRAMES) {
      const sampleTime = run.pathCount / BEST_PATH_HZ;
      if (sampleTime > limit) break;
      writePathFrame(false);
    }
    if (final && run.pathCount < MAX_PATH_FRAMES) {
      const last = (run.pathCount - 1) * PATH_FRAME_STRIDE;
      if (run.pathCount === 0 || pathFrames[last] < Math.fround(limit)) writePathFrame(true);
    }
  }

  /**
   * One frame, interpolated on the segment flown this frame, at the next 10 Hz lattice time, or
   * (final) at the finish time frameNumbers[0].
   */
  function writePathFrame(final) {
    const sampleTime = final ? frameNumbers[0] : run.pathCount / BEST_PATH_HZ;
    const player = state.player.position;
    const quaternion = state.player.quaternion;
    const dt = frameNumbers[1];
    const frameStart = state.time.elapsed - dt - run.startedAt;
    const share = dt > 1e-9 ? Math.min(1, Math.max(0, (sampleTime - frameStart) / dt)) : 1;
    const base = run.pathCount * PATH_FRAME_STRIDE;
    pathFrames[base] = sampleTime;
    pathFrames[base + 1] = previous.x + (player.x - previous.x) * share;
    pathFrames[base + 2] = previous.y + (player.y - previous.y) * share;
    pathFrames[base + 3] = previous.z + (player.z - previous.z) * share;
    pathFrames[base + 4] = quaternion.x;
    pathFrames[base + 5] = quaternion.y;
    pathFrames[base + 6] = quaternion.z;
    pathFrames[base + 7] = quaternion.w;
    run.pathCount++;
  }

  function saveBestPath(courseKey, craft) {
    const frames = pathFrames.slice(0, run.pathCount * PATH_FRAME_STRIDE);
    pathCache.set(pathKey(courseKey, craft), frames);
    if (!storage.write(pathKey(courseKey, craft), { version: CHALLENGE_STORAGE_VERSION, hz: BEST_PATH_HZ, frames: Array.from(frames) })) warnStorage();
  }

  function getBestPath(courseKey, craft) {
    const key = pathKey(courseKey, craft);
    let frames = pathCache.get(key) ?? null;
    if (!frames) {
      const stored = storage.read(key, null);
      if (stored && stored.version === CHALLENGE_STORAGE_VERSION && stored.hz === BEST_PATH_HZ && Array.isArray(stored.frames) && stored.frames.length % PATH_FRAME_STRIDE === 0 && stored.frames.every(Number.isFinite)) {
        frames = Float32Array.from(stored.frames);
        pathCache.set(key, frames);
      }
    }
    return frames ? { hz: BEST_PATH_HZ, frames: frames.slice() } : null;
  }

  // ---- Detection ---------------------------------------------------------------------------------------------
  /** The legacy ring course: Phase 2's rules, crossing by crossing, through the adapter hooks. */
  function detectLegacy(player) {
    const entry = run.entry;
    const course = entry.course;
    const index = run.gateIndex;
    const gate = course.gates[index];
    const result = crossGate(gate, previous, player, crossing);
    if (result !== 0) {
      endLegacyAfter(entry, index);
      entry.legacy.crossed(index, crossing[3], crossing[5], result === 1);
      return;
    }
    if (crossing[1] > course.missed.skipDistance) {
      endLegacyAfter(entry, index);
      entry.legacy.overshot(index);
      return;
    }
    const dx = player.x - gate.cx;
    const dy = player.y - gate.cy;
    const dz = player.z - gate.cz;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > course.abandonDistance) cancel('abandoned');
  }

  /** Moves the legacy run past gate `index`; after the last one the run ends (rings.js finishes its course). */
  function endLegacyAfter(entry, index) {
    run.gateIndex = index + 1;
    if (run.gateIndex < entry.course.gates.length) return;
    run.phase = null;
    run.entry = null;
    unregisterQuietly(entry);
  }

  function detectRunning(player) {
    const course = run.entry.course;
    const index = run.gateIndex;
    const gate = course.gates[index];
    const result = crossGate(gate, previous, player, crossing);
    if (result === 1) {
      const time = runTimeAt(crossing[2]);
      onGatePassed(index, time);
      advanceGate(index, time);
      return;
    }
    if (result === -1 && course.missed.outsideCrossing === 'miss') {
      const time = runTimeAt(crossing[2]);
      onGateMissed(index, time);
      advanceGate(index, time);
      return;
    }
    if (result === 0 && crossing[1] > course.missed.skipDistance) {
      const time = runTimeAt(1);
      onGateMissed(index, time);
      advanceGate(index, time);
      return;
    }
    const dx = player.x - gate.cx;
    const dy = player.y - gate.cy;
    const dz = player.z - gate.cz;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > course.abandonDistance) {
      cancel('abandoned');
      return;
    }
    if (course.timeLimit !== null && state.time.elapsed - run.startedAt > course.timeLimit) cancel('timeLimit');
  }

  /** The start gate was crossed inside at share crossing[2]: the clock starts there. */
  function startAtCrossing() {
    const dt = frameNumbers[1];
    beginRunning(state.time.elapsed - dt + dt * crossing[2]);
    onGatePassed(0, 0);
    run.gateIndex = 1;
  }

  function detectArmed(player) {
    const course = run.entry.course;
    const gate = course.gates[0];
    if (crossGate(gate, previous, player, crossing) === 1) {
      startAtCrossing();
      return;
    }
    const dx = player.x - gate.cx;
    const dy = player.y - gate.cy;
    const dz = player.z - gate.cz;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > course.abandonDistance) cancel('abandoned');
  }

  /** Idle: flying through any course's start gate (inside it) starts that course. */
  function detectStartGates(player) {
    for (let index = 0; index < courseList.length; index++) {
      const entry = courseList[index];
      const course = entry.course;
      if (course.legacyRings || course.start.mode !== 'gate') continue;
      const gate = course.gates[0];
      const dx = player.x - gate.cx;
      const dy = player.y - gate.cy;
      const dz = player.z - gate.cz;
      const reach = gate.reach + course.teleportDistance;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      if (crossGate(gate, previous, player, crossing) !== 1) continue;
      resetRun(entry, 'gate');
      startAtCrossing();
      return;
    }
  }

  // ---- Sensors and crashes ------------------------------------------------------------------------------------
  function onSensor(payload) {
    if (!isRunning() || run.phase !== 'running' || run.entry.legacy || !payload) return;
    const rule = run.entry.course.sensors[payload.tag];
    if (!rule) return;
    run.missed++;
    run.penalties += rule.penaltySeconds;
    if (run.entry.course.missed.mode === 'void') run.voided = true;
    bus.emit('challenge:sensorMiss', { id: run.entry.key, tag: payload.tag, penaltySeconds: rule.penaltySeconds, missed: run.missed });
    writeLive();
  }

  function onSoftCrash() {
    if (isRunning() && !run.entry.legacy) cancel('crash');
  }

  function onInputAction(payload) {
    if (!payload || payload.phase !== 'press' || payload.id !== 'challengeStart') return;
    toggleNearest('key');
  }

  /**
   * The challengeStart action: cancels the active challenge run, else starts the nearest course
   * within its prompt radius. Returns 'cancelled', 'started' or 'none'.
   */
  function toggleNearest(source) {
    if (isRunning() && !run.entry.legacy) {
      cancel('cancelled');
      return 'cancelled';
    }
    const found = nearestInPrompt();
    if (!found) {
      bus.emit('notify', { text: 'No challenge course nearby', kind: 'info', key: 'challenge' });
      return 'none';
    }
    start(found.key, { source });
    return 'started';
  }

  // ---- Queries ------------------------------------------------------------------------------------------
  /** The nearest registered start gate within its course's prompt radius: { key, distance } or null. */
  function nearestInPrompt() {
    const player = state.player.position;
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < courseList.length; index++) {
      const entry = courseList[index];
      const course = entry.course;
      if (course.legacyRings) continue;
      const gate = course.gates[0];
      const distance = Math.hypot(player.x - gate.cx, player.y - gate.cy, player.z - gate.cz);
      if (distance <= course.start.promptRadius && distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best ? { key: best.key, distance: bestDistance } : null;
  }

  function nearest(radius = Infinity) {
    const player = state.player.position;
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < courseList.length; index++) {
      const entry = courseList[index];
      if (entry.course.legacyRings) continue;
      const gate = entry.course.gates[0];
      const distance = Math.hypot(player.x - gate.cx, player.y - gate.cy, player.z - gate.cz);
      if (distance <= radius && distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    const gate = best.course.gates[0];
    return { courseKey: best.key, name: best.course.name, distance: bestDistance, bearing: bearing(player.x, player.z, gate.cx, gate.cz) };
  }

  // ---- state.challenge -----------------------------------------------------------------------------------
  function writePrompt() {
    if (isRunning() && !run.entry.legacy) {
      live.prompt = null;
      return;
    }
    const player = state.player.position;
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < courseList.length; index++) {
      const entry = courseList[index];
      const course = entry.course;
      if (course.legacyRings) continue;
      const gate = course.gates[0];
      const dx = player.x - gate.cx;
      const dy = player.y - gate.cy;
      const dz = player.z - gate.cz;
      const squared = dx * dx + dy * dy + dz * dz;
      const radius = course.start.promptRadius;
      if (squared <= radius * radius && squared < bestDistance) {
        best = entry;
        bestDistance = squared;
      }
    }
    if (!best) {
      live.prompt = null;
      return;
    }
    const gate = best.course.gates[0];
    prompt.courseKey = best.key;
    prompt.name = best.course.name;
    prompt.distance = Math.sqrt(bestDistance);
    const promptBearing = Math.atan2(gate.cx - player.x, -(gate.cz - player.z)) * RAD_TO_DEG;
    prompt.bearing = promptBearing < 0 ? promptBearing + 360 : promptBearing;
    live.prompt = prompt;
  }

  function writeLive() {
    const showing = run.entry !== null && !run.entry.legacy && run.phase !== null;
    live.active = showing && run.phase !== 'finished';
    live.courseKey = showing ? run.entry.key : null;
    live.name = showing ? run.entry.course.name : null;
    live.phase = showing ? run.phase : null;
    if (!showing) {
      live.elapsed = 0;
      live.gateIndex = 0;
      live.gatesTotal = 0;
      live.nextGate = null;
      live.missed = 0;
      live.penalties = 0;
      live.lastSplit = null;
      live.medalPace = null;
      if (live.best !== null) live.best = null;
      live.rival = null;
      return;
    }
    const course = run.entry.course;
    const player = state.player.position;
    live.gatesTotal = course.gates.length;
    live.gateIndex = run.gateIndex;
    live.missed = run.missed;
    live.penalties = run.penalties;
    const best = bestFor(run.entry, run.craft);
    const bestTime = best ? best.time : null;
    // Written only on a change: a double stored into a field that also holds null is boxed.
    if (live.best !== bestTime) live.best = bestTime;
    if (run.phase === 'running') live.elapsed = state.time.elapsed - run.startedAt;
    else if (run.phase === 'armed') live.elapsed = 0;
    else live.elapsed = run.elapsed;
    if (run.phase !== 'finished' && run.gateIndex < course.gates.length) {
      const gate = course.gates[run.gateIndex];
      nextGate.x = gate.cx;
      nextGate.y = gate.cy;
      nextGate.z = gate.cz;
      nextGate.nx = gate.nx;
      nextGate.ny = gate.ny;
      nextGate.nz = gate.nz;
      nextGate.ux = gate.ux;
      nextGate.uy = gate.uy;
      nextGate.uz = gate.uz;
      nextGate.shape = gate.shape;
      nextGate.radius = gate.radius;
      nextGate.halfWidth = gate.halfWidth;
      nextGate.halfHeight = gate.halfHeight;
      const dx = player.x - gate.cx;
      const dy = player.y - gate.cy;
      const dz = player.z - gate.cz;
      nextGate.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gateBearing = Math.atan2(gate.cx - player.x, -(gate.cz - player.z)) * RAD_TO_DEG;
      nextGate.bearing = gateBearing < 0 ? gateBearing + 360 : gateBearing;
      live.nextGate = nextGate;
    } else {
      live.nextGate = null;
    }
    live.medalPace = run.phase === 'running' ? medalPace(course, player) : null;
    if (course.rival && run.phase === 'running') {
      frameNumbers[0] = live.elapsed;
      course.rival.follower.atFrom(frameNumbers, 0, rivalOut);
      rivalState.name = course.rival.name;
      rivalState.done = rivalOut.done;
      rivalState.distanceAhead = rivalOut.distance - course.rival.path.nearestDistance(player.x, player.y, player.z);
      live.rival = rivalState;
    } else {
      live.rival = null;
    }
  }

  /** The medal the run is on pace for: time so far projected over the share of the course flown. */
  function medalPace(course, player) {
    if (!course.medals) return null;
    const total = course.gateDistance[course.gates.length - 1];
    if (!(total > 0)) return null;
    const index = Math.min(run.gateIndex, course.gates.length - 1);
    const gate = course.gates[index];
    const dx = player.x - gate.cx;
    const dy = player.y - gate.cy;
    const dz = player.z - gate.cz;
    const toGate = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const segment = index > 0 ? course.gateDistance[index] - course.gateDistance[index - 1] : 0;
    const flown = course.gateDistance[index] - Math.min(segment, toGate);
    const share = flown / total;
    const medals = course.medals;
    if (share < 0.1) return 'gold';
    // medalFor, inline: a double handed to a call that is not inlined would be boxed every frame.
    const projected = (state.time.elapsed - run.startedAt + run.penalties) / share;
    if (!Number.isFinite(projected)) return 'none';
    if (projected <= medals.gold) return 'gold';
    if (projected <= medals.silver) return 'silver';
    if (projected <= medals.bronze) return 'bronze';
    return 'none';
  }

  // ---- Wiring ------------------------------------------------------------------------------------------------
  bus.on('input:action', onInputAction);
  bus.on('colliderSensor', onSensor);
  bus.onTyped('softCrash', onSoftCrash);

  return {
    update(dt) {
      const player = state.player.position;
      frameNumbers[1] = dt;
      const entry = run.entry;
      if (entry && entry.legacy && run.phase === 'running') {
        if (dt > 0) {
          run.elapsed += dt;
          entry.legacy.tick(run.elapsed);
          const dx = player.x - previous.x;
          const dy = player.y - previous.y;
          const dz = player.z - previous.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) < entry.course.teleportDistance) detectLegacy(player);
        }
        entry.legacy.publish();
      } else if (dt > 0) {
        const dx = player.x - previous.x;
        const dy = player.y - previous.y;
        const dz = player.z - previous.z;
        const segmentSquared = dx * dx + dy * dy + dz * dz;
        const teleportDistance = entry ? entry.course.teleportDistance : DEFAULTS.teleportDistance;
        if (segmentSquared < teleportDistance * teleportDistance) {
          if (run.phase === 'running') detectRunning(player);
          else if (run.phase === 'armed') detectArmed(player);
          else detectStartGates(player);
          if (run.phase === 'running') {
            frameNumbers[0] = state.time.elapsed - run.startedAt;
            recordPath(false);
          }
        }
        if (run.phase === 'finished') {
          run.finishedHold -= dt;
          if (run.finishedHold <= 0) clearRun();
        }
      }
      previous.x = player.x;
      previous.y = player.y;
      previous.z = player.z;
      writeLive();
      writePrompt();
    },
    register,
    unregister,
    start,
    cancel,
    nearest,
    /** The challengeStart action (Y, the copilot's "start the challenge", the HUD prompt). */
    toggleNearest,
    getState() {
      return live;
    },
    getBest(courseKey, craft) {
      const best = records.courses[courseKey]?.best?.[craft] ?? null;
      return best ? { ...best, splits: best.splits.slice() } : null;
    },
    /** A plain copy of every stored record (the journal's Challenges section reads it). */
    getRecords() {
      return JSON.parse(JSON.stringify(records));
    },
    getBestPath,
    count() {
      return courseList.length;
    },
    /** Registered courses: [{ courseKey, name, presetId, owner, gates }] (debugging and the journal). */
    list() {
      return courseList.map((entry) => ({ courseKey: entry.key, name: entry.course.name, presetId: entry.course.presetId, owner: entry.owner, gates: entry.course.gates.length, legacy: entry.course.legacyRings }));
    },
    /** Re-reads the records from storage (tests that edit storage). */
    reloadRecords() {
      records = loadRecords();
      pathCache.clear();
    },
  };
}
