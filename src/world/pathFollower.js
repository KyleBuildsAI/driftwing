// PathFollower (contract e.2): pure, deterministic movement along a path as a function of flight
// time. A path is a smoothed polyline (Catmull-Rom through the control points, or straight segments),
// tabulated once into a dense polyline with its cumulative arc length; a follower maps a flight time
// to a distance along it (loop, ping-pong or once, with timed stops) and reads the position and
// tangent there. Two calls at the same time give the same answer, so replays and the determinism
// test see the same train, caravan or galleon, and a paused clock stops every follower.
//
// Users: the train on the viaduct (preset 56, structure engine), the camel caravan (58, fauna
// column), the ghost galleon (69), the dragon racer's rival (70), the caribou column (52) and the
// airship's scenic cruise. buildGroundPath plans a walking route over the terrain for caravans and
// herds: around slopes steeper than a limit and around water.
//
// No three.js import (both threads may use it); every query is allocation-free and takes an `out`.

const RAD_TO_DEG = 180 / Math.PI;
/** Smoothing modes of createPath. */
export const PATH_SMOOTHING = Object.freeze(['catmullRom', 'linear']);
/** Follower modes. */
export const FOLLOWER_MODES = Object.freeze(['loop', 'pingpong', 'once']);
/** The run (m) over which buildGroundPath measures a slope (rise over run), as the herd does. */
export const SLOPE_RUN = 6;
/** Metres either side of a table vertex over which the tangent turns (corners of straight segments). */
const TANGENT_BLEND = 4;

function fail(message) {
  throw new TypeError(`[DRIFTWING] pathFollower: ${message}`);
}

/** Uniform Catmull-Rom on one axis: the curve between p1 and p2 at share t. */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** The tabulated state of every path from createPath (followers read it directly). */
const pathStates = new WeakMap();

/** Normalises state.query[0]: wrapped on a closed path, clamped to [0, length] on an open one. */
function normalizeQuery(state) {
  const query = state.query;
  const distance = query[0];
  const length = state.length;
  if (!Number.isFinite(distance)) query[0] = 0;
  else if (state.closed) query[0] = distance - Math.floor(distance / length) * length;
  else query[0] = distance < 0 ? 0 : distance > length ? length : distance;
}

/** The table segment holding state.query[0] (normalised): binary search; the share goes to query[1]. */
function locateQuery(state) {
  normalizeQuery(state);
  const query = state.query;
  const cumulative = state.cumulative;
  const distance = query[0];
  let low = 0;
  let high = state.vertexCount - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] <= distance) low = middle;
    else high = middle;
  }
  const span = cumulative[low + 1] - cumulative[low];
  query[1] = span > 0 ? (distance - cumulative[low]) / span : 0;
  return low;
}

/** out = the path point at state.query[0]. */
function sampleState(state, out) {
  const segment = locateQuery(state);
  const share = state.query[1];
  const table = state.table;
  const base = segment * 3;
  out.x = table[base] + (table[base + 3] - table[base]) * share;
  out.y = table[base + 1] + (table[base + 4] - table[base + 1]) * share;
  out.z = table[base + 2] + (table[base + 5] - table[base + 2]) * share;
  return out;
}

/** Unit direction of table segment `segment` into out (x, y, z). */
function segmentDirection(state, segment, out) {
  const table = state.table;
  const base = segment * 3;
  const dx = table[base + 3] - table[base];
  const dy = table[base + 4] - table[base + 1];
  const dz = table[base + 5] - table[base + 2];
  const span = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  out.x = dx / span;
  out.y = dy / span;
  out.z = dz / span;
}

/**
 * out = the unit tangent at state.query[0], blended across each table vertex so headings turn
 * smoothly: within TANGENT_BLEND metres (at most half the segment) of a vertex the direction blends
 * toward the neighbouring segment's, reaching their average at the vertex.
 */
function tangentState(state, out) {
  const segment = locateQuery(state);
  const share = state.query[1];
  const cumulative = state.cumulative;
  const vertexCount = state.vertexCount;
  segmentDirection(state, segment, out);
  const span = cumulative[segment + 1] - cumulative[segment];
  const blend = Math.min(span * 0.5, TANGENT_BLEND);
  const fromStart = share * span;
  const toEnd = span - fromStart;
  let neighbour = -1;
  let weight = 0;
  if (blend > 0 && fromStart < blend) {
    neighbour = segment > 0 ? segment - 1 : state.closed ? vertexCount - 2 : -1;
    weight = 0.5 * (1 - fromStart / blend);
  } else if (blend > 0 && toEnd < blend) {
    neighbour = segment < vertexCount - 2 ? segment + 1 : state.closed ? 0 : -1;
    weight = 0.5 * (1 - toEnd / blend);
  }
  if (neighbour >= 0 && weight > 0) {
    const scratch = state.scratch;
    segmentDirection(state, neighbour, scratch);
    out.x += (scratch.x - out.x) * weight;
    out.y += (scratch.y - out.y) * weight;
    out.z += (scratch.z - out.z) * weight;
    const size = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z) || 1;
    out.x /= size;
    out.y /= size;
    out.z /= size;
  }
  return out;
}

/**
 * A path through `points` (a Float64Array or array of xyz triples, at least two points).
 * `closed` joins the last point back to the first; `smoothing` 'catmullRom' passes a smooth curve
 * through every point, 'linear' keeps straight segments; `samplesPerSegment` sets the tabulation
 * (arc length error under 0.5 % at 16 for curves turning up to 90 degrees per segment).
 * Returns { length, closed, pointCount, sampleAt(distance, out), tangentAt(distance, out),
 * sampleFrom(buffer, index, out), tangentFrom(buffer, index, out), nearestDistance(x, y, z) }:
 * distances are metres along the path, wrapped on a closed path and clamped to [0, length] on an
 * open one; `out` receives { x, y, z }. The *From variants read the distance from a typed array, so
 * an allocation-free caller passes no double through a call.
 */
export function createPath({ points, closed = false, smoothing = 'catmullRom', samplesPerSegment = 16 } = {}) {
  if (!points || typeof points.length !== 'number' || points.length % 3 !== 0) fail('points must be xyz triples');
  const count = points.length / 3;
  if (count < 2) fail('a path needs at least two points');
  for (let index = 0; index < points.length; index++) {
    if (!Number.isFinite(points[index])) fail(`point coordinate ${index} is not finite`);
  }
  if (!PATH_SMOOTHING.includes(smoothing)) fail(`smoothing must be one of ${PATH_SMOOTHING.join(', ')}`);
  if (!Number.isInteger(samplesPerSegment) || samplesPerSegment < 1 || samplesPerSegment > 256) fail('samplesPerSegment must be an integer 1..256');
  const isClosed = Boolean(closed) && count >= 3;
  const segments = isClosed ? count : count - 1;
  const steps = smoothing === 'linear' ? 1 : samplesPerSegment;
  const vertexCount = segments * steps + 1;
  const table = new Float64Array(vertexCount * 3);
  const cumulative = new Float64Array(vertexCount);
  const coordinate = (index, axis) => {
    let wrapped = index;
    if (isClosed) wrapped = ((index % count) + count) % count;
    else wrapped = Math.min(count - 1, Math.max(0, index));
    return points[wrapped * 3 + axis];
  };
  // Open paths extend their end tangents by mirroring the neighbour (a natural end).
  const control = (index, axis) => {
    if (isClosed || (index >= 0 && index < count)) return coordinate(index, axis);
    if (index < 0) return 2 * coordinate(0, axis) - coordinate(1, axis);
    return 2 * coordinate(count - 1, axis) - coordinate(count - 2, axis);
  };
  let vertex = 0;
  for (let segment = 0; segment < segments; segment++) {
    for (let step = 0; step < steps; step++) {
      const share = step / steps;
      for (let axis = 0; axis < 3; axis++) {
        table[vertex * 3 + axis] = steps === 1
          ? coordinate(segment, axis)
          : catmullRom(control(segment - 1, axis), control(segment, axis), control(segment + 1, axis), control(segment + 2, axis), share);
      }
      vertex++;
    }
  }
  for (let axis = 0; axis < 3; axis++) table[vertex * 3 + axis] = coordinate(isClosed ? 0 : count - 1, axis);
  for (let index = 1; index < vertexCount; index++) {
    const dx = table[index * 3] - table[index * 3 - 3];
    const dy = table[index * 3 + 1] - table[index * 3 - 2];
    const dz = table[index * 3 + 2] - table[index * 3 - 1];
    cumulative[index] = cumulative[index - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const length = cumulative[vertexCount - 1];
  if (!(length > 0)) fail('a path needs a positive length');

  // The queries are module functions over this state (one closure each, whatever the number of
  // paths, so V8 inlines them); doubles never cross a call: the distance being looked up lives in
  // query[0], the share along its segment in query[1].
  const state = { table, cumulative, vertexCount, length, closed: isClosed, query: new Float64Array(2), scratch: { x: 0, y: 0, z: 0 } };

  /** out = the point `distance` metres along the path. */
  function sampleAt(distance, out) {
    state.query[0] = distance;
    return sampleState(state, out);
  }

  /** out = the unit tangent `distance` metres along the path. */
  function tangentAt(distance, out) {
    state.query[0] = distance;
    return tangentState(state, out);
  }

  /** sampleAt with the distance read from buffer[index] (callers that keep doubles in typed arrays). */
  function sampleFrom(buffer, index, out) {
    state.query[0] = buffer[index];
    return sampleState(state, out);
  }

  /** tangentAt with the distance read from buffer[index]. */
  function tangentFrom(buffer, index, out) {
    state.query[0] = buffer[index];
    return tangentState(state, out);
  }

  /** The distance along the path of the path point nearest (x, y, z) (linear scan of the table). */
  function nearestDistance(x, y, z) {
    let best = Infinity;
    let bestDistance = 0;
    for (let segment = 0; segment < vertexCount - 1; segment++) {
      const base = segment * 3;
      const ax = table[base];
      const ay = table[base + 1];
      const az = table[base + 2];
      const dx = table[base + 3] - ax;
      const dy = table[base + 4] - ay;
      const dz = table[base + 5] - az;
      const lengthSquared = dx * dx + dy * dy + dz * dz;
      let share = lengthSquared > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / lengthSquared : 0;
      share = share < 0 ? 0 : share > 1 ? 1 : share;
      const px = ax + dx * share - x;
      const py = ay + dy * share - y;
      const pz = az + dz * share - z;
      const squared = px * px + py * py + pz * pz;
      if (squared < best) {
        best = squared;
        bestDistance = cumulative[segment] + (cumulative[segment + 1] - cumulative[segment]) * share;
      }
    }
    return bestDistance;
  }

  const path = Object.freeze({ length, closed: isClosed, pointCount: count, sampleAt, tangentAt, sampleFrom, tangentFrom, nearestDistance });
  pathStates.set(path, state);
  return path;

}

/**
 * A follower moving along `path` at `speed` m/s from `startDistance` at flight time `startTime`.
 * mode 'loop' wraps around (a closed path runs on; an open one restarts from its start), 'pingpong'
 * runs to the end and back, 'once' stops at the end (done). `waits` are timed stops
 * [{ distance, seconds }] (stations, a caravan's rest), honoured on every pass (both directions on a
 * ping-pong). `ground(x, z)` (optional) puts the follower on the terrain plus `groundOffset`.
 *
 * Returns { at(time, out), atFrom(buffer, index, out), carAt(time, offset, out), carAtFrom(buffer, index, out),
 * length, duration, period }: out receives
 * { x, y, z, tx, ty, tz, heading (deg), distance, speed (m/s now: 0 while waiting), done }.
 * carAt is a trailing car `offset` metres behind the head along the track it travelled (train cars,
 * camels); duration is Infinity for loop and ping-pong; period is one cycle in seconds.
 */
export function createPathFollower({
  path, speed, mode = 'loop', startTime = 0, startDistance = 0, ground = null, groundOffset = 0, waits = [],
} = {}) {
  if (!path || typeof path.sampleAt !== 'function' || !(path.length > 0)) fail('createPathFollower needs a path from createPath');
  if (!(Number.isFinite(speed) && speed > 0)) fail('speed must be a positive number (m/s)');
  if (!FOLLOWER_MODES.includes(mode)) fail(`mode must be one of ${FOLLOWER_MODES.join(', ')}`);
  if (!Number.isFinite(startTime)) fail('startTime must be a finite flight time (s)');
  if (!Number.isFinite(startDistance)) fail('startDistance must be finite (m)');
  if (ground !== null && typeof ground !== 'function') fail('ground must be null or a function (x, z) => y');
  if (!Number.isFinite(groundOffset)) fail('groundOffset must be finite (m)');
  if (!Array.isArray(waits)) fail('waits must be an array of { distance, seconds }');
  const length = path.length;
  // A path from createPath is queried through its state directly (module functions V8 inlines).
  const pathState = pathStates.get(path) ?? null;
  // The unfolded track: a loop runs [0, length), a ping-pong [0, 2 length) (out and back).
  const trackLength = mode === 'pingpong' ? length * 2 : length;
  const startAlong = Math.min(length, Math.max(0, path.closed ? ((startDistance % length) + length) % length : startDistance));
  const stops = [];
  waits.forEach((wait, index) => {
    if (!wait || !Number.isFinite(wait.distance) || !(Number.isFinite(wait.seconds) && wait.seconds >= 0)) fail(`waits[${index}] needs a finite distance and seconds >= 0`);
    const along = Math.min(length, Math.max(0, wait.distance));
    stops.push({ at: along, seconds: wait.seconds });
    if (mode === 'pingpong' && along > 0 && along < length) stops.push({ at: trackLength - along, seconds: wait.seconds });
  });
  // A loop's stop at the very end is the same place as its start.
  for (const stop of stops) if (mode === 'loop' && stop.at >= trackLength) stop.at = 0;
  stops.sort((a, b) => a.at - b.at);
  const stopAt = new Float64Array(stops.map((stop) => stop.at));
  const stopSeconds = new Float64Array(stops.map((stop) => stop.seconds));
  const stopCount = stops.length;
  let waitTotal = 0;
  for (let index = 0; index < stopCount; index++) waitTotal += stopSeconds[index];
  const travelSeconds = (mode === 'once' ? length - startAlong : trackLength) / speed;
  const period = travelSeconds + (mode === 'once' ? 0 : waitTotal);

  /** Schedule time (s from the track's 0, waits included) at which the follower stands at `along`, before its stop there. */
  function scheduleTimeOf(along) {
    let time = along / speed;
    for (let index = 0; index < stopCount; index++) if (stopAt[index] < along) time += stopSeconds[index];
    return time;
  }
  const startSchedule = mode === 'once' ? 0 : scheduleTimeOf(startAlong);
  // A 'once' run: its stops from the start onward, and its total duration.
  let onceDuration = travelSeconds;
  if (mode === 'once') for (let index = 0; index < stopCount; index++) if (stopAt[index] >= startAlong) onceDuration += stopSeconds[index];
  const duration = mode === 'once' ? onceDuration : Infinity;

  // Scratch (doubles never cross a call): located = [track coordinate, speed now, done flag], written
  // by locate() from located[3] (the flight time); located[4] is the folded distance along the path.
  const located = new Float64Array(5);
  const sample = { x: 0, y: 0, z: 0 };
  const tangent = { x: 0, y: 0, z: 0 };

  /** Writes the track coordinate at flight time located[3] into located[0], the speed into [1], done into [2]. */
  function locate() {
    const time = located[3];
    const elapsed = Number.isFinite(time) ? time - startTime : 0;
    if (mode === 'once') {
      if (elapsed <= 0) {
        located[0] = startAlong;
        located[1] = 0;
        located[2] = 0;
        return;
      }
      if (elapsed >= onceDuration) {
        located[0] = length;
        located[1] = 0;
        located[2] = 1;
        return;
      }
      let clock = elapsed;
      let along = startAlong;
      for (let index = 0; index < stopCount; index++) {
        if (stopAt[index] < startAlong) continue;
        const travel = (stopAt[index] - along) / speed;
        if (clock < travel) break;
        clock -= travel;
        along = stopAt[index];
        if (clock < stopSeconds[index]) {
          located[0] = along;
          located[1] = 0;
          located[2] = 0;
          return;
        }
        clock -= stopSeconds[index];
      }
      located[0] = Math.min(length, along + clock * speed);
      located[1] = speed;
      located[2] = 0;
      return;
    }
    let clock = (startSchedule + elapsed) % period;
    if (clock < 0) clock += period;
    let along = 0;
    for (let index = 0; index < stopCount; index++) {
      const travel = (stopAt[index] - along) / speed;
      if (clock < travel) break;
      clock -= travel;
      along = stopAt[index];
      if (clock < stopSeconds[index]) {
        located[0] = along;
        located[1] = 0;
        located[2] = 0;
        return;
      }
      clock -= stopSeconds[index];
    }
    located[0] = Math.min(trackLength, along + clock * speed);
    located[1] = speed;
    located[2] = 0;
  }

  /** Folds the track coordinate located[0] onto the path into located[4]; returns +1 (out) or -1 (back). */
  function fold() {
    const track = located[0];
    if (mode === 'pingpong') {
      // A floor-based wrap: V8's % on a negative double (a car behind the start) allocates.
      const wrapped = track - Math.floor(track / trackLength) * trackLength;
      if (wrapped <= length) {
        located[4] = wrapped;
        return 1;
      }
      located[4] = trackLength - wrapped;
      return -1;
    }
    if (path.closed) {
      located[4] = track - Math.floor(track / length) * length;
      return 1;
    }
    const distance = track < 0 ? (mode === 'loop' ? track + length : 0) : track > length ? length : track;
    located[4] = distance < 0 ? 0 : distance;
    return 1;
  }

  /** Fills `out` at the track coordinate located[0] (speed and done already set). */
  function write(out) {
    const direction = fold();
    out.distance = located[4];
    if (pathState) {
      pathState.query[0] = located[4];
      sampleState(pathState, sample);
      pathState.query[0] = located[4];
      tangentState(pathState, tangent);
    } else {
      path.sampleFrom(located, 4, sample);
      path.tangentFrom(located, 4, tangent);
    }
    let tx = tangent.x * direction;
    let ty = tangent.y * direction;
    let tz = tangent.z * direction;
    out.x = sample.x;
    out.z = sample.z;
    if (ground) {
      const here = ground(sample.x, sample.z);
      out.y = here + groundOffset;
      const horizontal = Math.sqrt(tx * tx + tz * tz);
      if (horizontal > 1e-9) {
        const rise = ground(sample.x + tx / horizontal, sample.z + tz / horizontal) - here;
        tx /= horizontal;
        tz /= horizontal;
        ty = rise;
        const size = Math.sqrt(1 + rise * rise);
        tx /= size;
        ty /= size;
        tz /= size;
      }
    } else {
      out.y = sample.y;
    }
    out.tx = tx;
    out.ty = ty;
    out.tz = tz;
    const degrees = Math.atan2(tx, -tz) * RAD_TO_DEG;
    out.heading = degrees < 0 ? degrees + 360 : degrees;
    return out;
  }

  return Object.freeze({
    length,
    duration,
    period,
    at(time, out) {
      located[3] = time;
      locate();
      out.speed = located[1];
      out.done = located[2] === 1;
      return write(out);
    },
    /** at() with the time read from buffer[index] (allocation-free callers keep doubles in typed arrays). */
    atFrom(buffer, index, out) {
      located[3] = buffer[index];
      locate();
      out.speed = located[1];
      out.done = located[2] === 1;
      return write(out);
    },
    carAt(time, offset, out) {
      located[3] = time;
      locate();
      out.speed = located[1];
      out.done = located[2] === 1;
      if (Number.isFinite(offset)) located[0] -= offset;
      return write(out);
    },
    /** carAt() with the time read from buffer[index] and the offset from buffer[index + 1]. */
    carAtFrom(buffer, index, out) {
      located[3] = buffer[index];
      locate();
      out.speed = located[1];
      out.done = located[2] === 1;
      const offset = buffer[index + 1];
      if (Number.isFinite(offset)) located[0] -= offset;
      return write(out);
    },
  });
}

/** A deterministic hash of a grid cell and seed to [0, 1). */
function cellNoise(column, row, seed) {
  let hash = Math.imul(column | 0, 0x27d4eb2d) ^ Math.imul(row | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** A string or number seed as a 32-bit integer. */
function seedInteger(seed) {
  if (Number.isFinite(seed)) return seed | 0;
  const text = String(seed ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash | 0;
}

/**
 * A walking route over the terrain from `from` to `to` ({ x, z }): a grid search (A*, cells of
 * `spacing` metres, 8 neighbours) over a corridor around the straight line, where a step is allowed
 * only if the slope (rise over SLOPE_RUN metres, sampled along the step) stays within `maxSlope` and
 * no sample is water (`waterQuery.isWater`, or ground below `waterLevel` without a query). The seed
 * adds a small deterministic wander to the step costs, so two caravans do not walk one line.
 * Returns { points: Float64Array (xyz on the ground), reached, length }; when no allowed route
 * exists the route ends at the reachable cell nearest `to` and `reached` is false.
 */
export function buildGroundPath(world, waterQuery, {
  from, to, maxSlope = 0.45, seed = 0, spacing = 40, margin = 0.6, waterLevel = 0, maxCells = 60000,
} = {}) {
  if (!world || typeof world.groundHeight !== 'function') fail('buildGroundPath needs a world with groundHeight(x, z)');
  if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(from.z) || !Number.isFinite(to.x) || !Number.isFinite(to.z)) fail('buildGroundPath needs from and to points { x, z }');
  if (!(maxSlope > 0)) fail('maxSlope must be positive');
  if (!(spacing >= SLOPE_RUN)) fail(`spacing must be at least ${SLOPE_RUN} m`);
  const seedBits = seedInteger(seed);
  const isWater = waterQuery && typeof waterQuery.isWater === 'function'
    ? (x, z) => waterQuery.isWater(x, z)
    : (x, z) => world.groundHeight(x, z) < waterLevel;
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  const pad = Math.max(spacing * 4, span * margin);
  const minX = Math.min(from.x, to.x) - pad;
  const minZ = Math.min(from.z, to.z) - pad;
  let columns = Math.ceil((Math.max(from.x, to.x) + pad - minX) / spacing) + 1;
  let rows = Math.ceil((Math.max(from.z, to.z) + pad - minZ) / spacing) + 1;
  if (columns * rows > maxCells) {
    const shrink = Math.sqrt(maxCells / (columns * rows));
    columns = Math.max(2, Math.floor(columns * shrink));
    rows = Math.max(2, Math.floor(rows * shrink));
  }
  const cellSize = Math.max((Math.max(from.x, to.x) + pad - minX) / (columns - 1), (Math.max(from.z, to.z) + pad - minZ) / (rows - 1));
  const cellX = (column) => minX + column * cellSize;
  const cellZ = (row) => minZ + row * cellSize;
  const clampColumn = (x) => Math.min(columns - 1, Math.max(0, Math.round((x - minX) / cellSize)));
  const clampRow = (z) => Math.min(rows - 1, Math.max(0, Math.round((z - minZ) / cellSize)));
  const cellCount = columns * rows;
  // 0 unknown, 1 dry, 2 water.
  const cellWater = new Uint8Array(cellCount);
  const waterAt = (index) => {
    if (cellWater[index] === 0) cellWater[index] = isWater(cellX(index % columns), cellZ(Math.floor(index / columns))) ? 2 : 1;
    return cellWater[index] === 2;
  };
  /** True when walking from (ax, az) to (bx, bz) keeps every SLOPE_RUN rise within maxSlope and stays dry. */
  function stepAllowed(ax, az, bx, bz) {
    const distance = Math.hypot(bx - ax, bz - az);
    const samples = Math.max(1, Math.ceil(distance / SLOPE_RUN));
    const dirX = (bx - ax) / distance;
    const dirZ = (bz - az) / distance;
    for (let sample = 0; sample <= samples; sample++) {
      const along = Math.min(distance, (sample / samples) * distance);
      const x = ax + dirX * along;
      const z = az + dirZ * along;
      const here = world.groundHeight(x, z);
      const ahead = world.groundHeight(x + dirX * SLOPE_RUN, z + dirZ * SLOPE_RUN);
      const behind = world.groundHeight(x - dirX * SLOPE_RUN, z - dirZ * SLOPE_RUN);
      if (Math.abs(ahead - here) / SLOPE_RUN > maxSlope || Math.abs(here - behind) / SLOPE_RUN > maxSlope) return false;
      if (sample > 0 && isWater(x, z)) return false;
    }
    return true;
  }

  const startIndex = clampRow(from.z) * columns + clampColumn(from.x);
  const goalIndex = clampRow(to.z) * columns + clampColumn(to.x);
  const cost = new Float64Array(cellCount).fill(Infinity);
  const parent = new Int32Array(cellCount).fill(-1);
  const closedSet = new Uint8Array(cellCount);
  // Binary heap of cell indices keyed by cost + heuristic.
  const heap = new Int32Array(cellCount * 8 + 1);
  const heapKey = new Float64Array(cellCount * 8 + 1);
  let heapSize = 0;
  const push = (index, key) => {
    let slot = heapSize++;
    heap[slot] = index;
    heapKey[slot] = key;
    while (slot > 0) {
      const up = (slot - 1) >> 1;
      if (heapKey[up] < heapKey[slot] || (heapKey[up] === heapKey[slot] && heap[up] <= heap[slot])) break;
      const swapIndex = heap[up];
      const swapKey = heapKey[up];
      heap[up] = heap[slot];
      heapKey[up] = heapKey[slot];
      heap[slot] = swapIndex;
      heapKey[slot] = swapKey;
      slot = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    heapSize--;
    heap[0] = heap[heapSize];
    heapKey[0] = heapKey[heapSize];
    let slot = 0;
    for (;;) {
      const left = slot * 2 + 1;
      const right = left + 1;
      let smallest = slot;
      if (left < heapSize && (heapKey[left] < heapKey[smallest] || (heapKey[left] === heapKey[smallest] && heap[left] < heap[smallest]))) smallest = left;
      if (right < heapSize && (heapKey[right] < heapKey[smallest] || (heapKey[right] === heapKey[smallest] && heap[right] < heap[smallest]))) smallest = right;
      if (smallest === slot) break;
      const swapIndex = heap[smallest];
      const swapKey = heapKey[smallest];
      heap[smallest] = heap[slot];
      heapKey[smallest] = heapKey[slot];
      heap[slot] = swapIndex;
      heapKey[slot] = swapKey;
      slot = smallest;
    }
    return top;
  };
  const goalX = cellX(goalIndex % columns);
  const goalZ = cellZ(Math.floor(goalIndex / columns));
  const heuristic = (index) => Math.hypot(cellX(index % columns) - goalX, cellZ(Math.floor(index / columns)) - goalZ);
  cost[startIndex] = 0;
  push(startIndex, heuristic(startIndex));
  let nearest = startIndex;
  let nearestGap = heuristic(startIndex);
  while (heapSize > 0) {
    const current = pop();
    if (closedSet[current]) continue;
    closedSet[current] = 1;
    const gap = heuristic(current);
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = current;
    }
    if (current === goalIndex) break;
    const column = current % columns;
    const row = Math.floor(current / columns);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nextColumn = column + dx;
        const nextRow = row + dz;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
        const next = nextRow * columns + nextColumn;
        if (closedSet[next] || waterAt(next)) continue;
        const step = cellSize * (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1);
        const wander = 1 + 0.35 * cellNoise(nextColumn, nextRow, seedBits);
        const candidate = cost[current] + step * wander;
        if (candidate >= cost[next]) continue;
        if (!stepAllowed(cellX(column), cellZ(row), cellX(nextColumn), cellZ(nextRow))) continue;
        cost[next] = candidate;
        parent[next] = current;
        push(next, candidate + heuristic(next));
      }
    }
  }
  const reached = closedSet[goalIndex] === 1;
  const end = reached ? goalIndex : nearest;
  const route = [];
  for (let index = end; index >= 0; index = parent[index]) route.push(index);
  route.reverse();
  const points = new Float64Array(route.length * 3);
  let total = 0;
  route.forEach((index, order) => {
    const x = cellX(index % columns);
    const z = cellZ(Math.floor(index / columns));
    points[order * 3] = x;
    points[order * 3 + 1] = world.groundHeight(x, z);
    points[order * 3 + 2] = z;
    if (order > 0) total += Math.hypot(x - points[order * 3 - 3], z - points[order * 3 - 1]);
  });
  return { points, reached, length: total };
}
