// Shared helpers for the spawn engines (src/spawns/engines/):
//
//   createParamReader(label)     readers for preset params that throw a clear TypeError naming the
//                                engine, the preset and the param path (the preset authors' feedback)
//   createHeadingFrame()         the local frame of a spawn: right, up and forward from its compass
//                                heading, so params can say [right, up, forward] in metres
//   createGroundGrid(terrain)    a coarse grid of ground heights (the water surface counts as ground)
//                                around a centre, sampled a few nodes at a time after it moves
//   createPooledLight(lights)    one real light from the light pool with priority, revoke and a
//                                throttled re-acquire; everything else stays emissive plus bloom
//   createRangeList(capacity)    a fixed-capacity updateRanges list for buffers uploaded in part
//                                every frame (three's own array reallocates after each upload)
//
// Nothing here allocates after construction: the frame update paths of the engines call only the
// per-frame members (the grid's step and sample, the light's update, the range list's add).

/** A readable description of a param value for error messages. */
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

/**
 * Param readers for one engine instance. label is for example 'emitter params of preset "volcano"'.
 * Every reader returns the fallback for undefined or null and throws for a value of the wrong kind.
 */
export function createParamReader(label) {
  function fail(path, message) {
    throw new TypeError(`[DRIFTWING] ${label}: param "${path}" ${message}`);
  }
  const reader = {
    fail,
    number(value, path, fallback, min = -Infinity, max = Infinity) {
      if (value === undefined || value === null) return fallback;
      if (!Number.isFinite(value)) fail(path, `must be a finite number, got ${describe(value)}`);
      if (value < min || value > max) fail(path, `must be within ${min}..${max}, got ${value}`);
      return value;
    },
    /** A [min, max] pair; a single number n means [n, n]. */
    range(value, path, fallback, min = -Infinity, max = Infinity) {
      if (value === undefined || value === null) return fallback;
      if (Number.isFinite(value)) value = [value, value];
      if (!Array.isArray(value) || value.length !== 2) fail(path, `must be a number or [min, max], got ${describe(value)}`);
      const low = reader.number(value[0], `${path}[0]`, 0, min, max);
      const high = reader.number(value[1], `${path}[1]`, 0, min, max);
      if (high < low) fail(path, `must be [min, max] with max >= min, got [${low}, ${high}]`);
      return [low, high];
    },
    /** A 0xRRGGBB integer. */
    color(value, path, fallback) {
      if (value === undefined || value === null) return fallback;
      if (!Number.isInteger(value) || value < 0 || value > 0xffffff) fail(path, `must be a 0xRRGGBB integer, got ${describe(value)}`);
      return value;
    },
    /** A [x, y, z] array of finite numbers. */
    vector(value, path, fallback) {
      if (value === undefined || value === null) return fallback;
      if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) fail(path, `must be [x, y, z] numbers, got ${describe(value)}`);
      return value;
    },
    oneOf(value, path, fallback, allowed) {
      if (value === undefined || value === null) return fallback;
      if (!allowed.includes(value)) fail(path, `must be one of ${allowed.join(', ')}, got ${describe(value)}`);
      return value;
    },
    boolean(value, path, fallback) {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'boolean') fail(path, `must be true or false, got ${describe(value)}`);
      return value;
    },
    /** A plain object, or null when absent. */
    object(value, path) {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'object' || Array.isArray(value)) fail(path, `must be an object, got ${describe(value)}`);
      return value;
    },
    /** Refuses keys a param object does not know (a typo would otherwise be ignored silently). */
    onlyKeys(value, path, keys) {
      if (!value) return;
      for (const key of Object.keys(value)) {
        if (!keys.includes(key)) fail(`${path ? `${path}.` : ''}${key}`, `is not a known param (known: ${keys.join(', ')})`);
      }
    },
  };
  return reader;
}

/**
 * The local frame of a spawn from its compass heading (0 = north = -z, 90 = east = +x): params give
 * offsets and directions as [right, up, forward]. set(heading) updates it; toWorld writes the world
 * vector of a local one into target ({ x, y, z }).
 */
export function createHeadingFrame() {
  const frame = {
    rightX: 1,
    rightZ: 0,
    forwardX: 0,
    forwardZ: -1,
    set(headingDegrees) {
      const radians = headingDegrees * Math.PI / 180;
      const sin = Math.sin(radians);
      const cos = Math.cos(radians);
      frame.forwardX = sin;
      frame.forwardZ = -cos;
      frame.rightX = cos;
      frame.rightZ = sin;
      return frame;
    },
    toWorld(right, up, forward, target) {
      target.x = right * frame.rightX + forward * frame.forwardX;
      target.y = up;
      target.z = right * frame.rightZ + forward * frame.forwardZ;
      return target;
    },
  };
  return frame;
}

/**
 * A size x size grid of ground heights (max of the ground and the water level) spanning span metres
 * around a centre. recenter(x, z) moves it; step(samples) samples that many of the nodes still stale
 * since the last recenter (the terrain does not change, so a grid that stays put stops sampling);
 * sample(point) interpolates bilinearly (clamped at the edges) from point[0] = x and point[1] = z
 * into point[2], and heightAt(x, z) returns the same (it boxes its result: create time only).
 * fill() samples every node at once (create time). The samples are what rationing is for: the
 * terrain height function allocates (worldgen's noise), so frame updates sample only a few nodes.
 */
export function createGroundGrid(terrain, { size = 8, span = 2000 } = {}) {
  const heights = new Float64Array(size * size);
  const origin = new Float64Array(2);
  const spacing = new Float64Array(1);
  const lookup = new Float64Array(3);
  let cursor = 0;
  let stale = size * size;
  let filled = false;

  function sampleNode(index) {
    const x = origin[0] + (index % size) * spacing[0];
    const z = origin[1] + Math.floor(index / size) * spacing[0];
    const ground = terrain.groundHeight(x, z);
    heights[index] = ground > terrain.waterLevel ? ground : terrain.waterLevel;
  }

  const grid = {
    size,
    heights,
    get filled() { return filled; },
    /** Puts the grid's middle at (x, z) with the given span (m). The nodes are stale until sampled. */
    recenter(x, z, newSpan = span) {
      span = newSpan;
      spacing[0] = span / (size - 1);
      origin[0] = x - span / 2;
      origin[1] = z - span / 2;
      cursor = 0;
      stale = heights.length;
    },
    /** Samples every node now. */
    fill() {
      for (let index = 0; index < heights.length; index++) sampleNode(index);
      cursor = 0;
      stale = 0;
      filled = true;
    },
    /** Samples up to count of the nodes still stale since the last recenter (in order). */
    step(count) {
      for (let sample = 0; sample < count && stale > 0; sample++) {
        sampleNode(cursor);
        cursor = (cursor + 1) % heights.length;
        stale--;
      }
    },
    /** True when (x, z) lies more than share of the span away from the grid's middle. */
    drifted(x, z, share) {
      const middleX = origin[0] + span / 2;
      const middleZ = origin[1] + span / 2;
      const limit = span * share;
      return Math.abs(x - middleX) > limit || Math.abs(z - middleZ) > limit;
    },
    heightAt(x, z) {
      lookup[0] = x;
      lookup[1] = z;
      grid.sample(lookup);
      return lookup[2];
    },
    sample(point) {
      let gridX = (point[0] - origin[0]) / spacing[0];
      let gridZ = (point[1] - origin[1]) / spacing[0];
      gridX = gridX < 0 ? 0 : gridX > size - 1 ? size - 1 : gridX;
      gridZ = gridZ < 0 ? 0 : gridZ > size - 1 ? size - 1 : gridZ;
      const cellX = Math.min(size - 2, Math.floor(gridX));
      const cellZ = Math.min(size - 2, Math.floor(gridZ));
      const fractionX = gridX - cellX;
      const fractionZ = gridZ - cellZ;
      const base = cellZ * size + cellX;
      const near = heights[base] + (heights[base + 1] - heights[base]) * fractionX;
      const far = heights[base + size] + (heights[base + size + 1] - heights[base + size]) * fractionX;
      point[2] = near + (far - near) * fractionZ;
    },
  };
  grid.recenter(0, 0, span);
  return grid;
}

/** Seconds between attempts to get a light back after the pool refused or revoked it. */
const LIGHT_RETRY_SECONDS = 1;

/**
 * One real light from the pool (ctx.lights), held only while wanted. update(wanted, dt) acquires or
 * releases it: a holder can lose it to a higher priority (the pool calls the revoke callback), and a
 * refused or revoked holder asks again at most once a second. While held, place() and shine() drive
 * it. release() gives it back (dispose).
 */
export function createPooledLight(lights, { priority = 1, color = 0xffffff, range = 500 } = {}) {
  let light = null;
  let retry = 0;
  const handle = {
    priority,
    color,
    range,
    get held() { return light !== null; },
    get light() { return light; },
    /** Acquires the light when wanted and none is held (throttled), releases it when not wanted. */
    update(wanted, dt) {
      if (!wanted) {
        if (light !== null) handle.release();
        retry = 0;
        return false;
      }
      if (light !== null) return true;
      retry -= dt;
      if (retry > 0) return false;
      retry = LIGHT_RETRY_SECONDS;
      light = lights.acquire(handle.priority, onRevoke);
      if (light !== null) {
        light.color.setHex(handle.color);
        light.distance = handle.range;
        light.decay = 2;
      }
      return light !== null;
    },
    place(x, y, z) {
      if (light !== null) light.position.set(x, y, z);
    },
    /** Sets the intensity (candela) of the held light. */
    shine(intensity) {
      if (light !== null) light.intensity = intensity > 0 ? intensity : 0;
    },
    release() {
      if (light === null) return;
      lights.release(light);
      light = null;
    },
  };
  function onRevoke() {
    light = null;
    retry = LIGHT_RETRY_SECONDS;
  }
  return handle;
}

/** A seeded random value in [low, high] from rng(). */
export function randomIn(rng, low, high) {
  return low + (high - low) * rng();
}

/** A smooth 0..1 step of value between edge0 and edge1. */
export function smoothstep(edge0, edge1, value) {
  const t = (value - edge0) / (edge1 - edge0);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * A fixed-capacity stand-in for a BufferAttribute's updateRanges array, for buffers the engines
 * upload in part every frame. three's backends only read length and [index] from it and clear it
 * with length = 0 after the upload; a real array gives up its backing store on that clear and makes
 * a new one on the next push, an allocation per attribute per frame. This list keeps capacity range
 * records and only moves its length: add(start, count) fills the next record.
 */
export function createRangeList(capacity) {
  let length = 0;
  const list = {
    get length() { return length; },
    set length(value) { length = value < 0 ? 0 : value > capacity ? capacity : value; },
    add(start, count) {
      if (length >= capacity) throw new RangeError(`createRangeList: more than ${capacity} ranges`);
      const record = list[length];
      record.start = start;
      record.count = count;
      length++;
    },
    capacity,
  };
  for (let index = 0; index < capacity; index++) list[index] = { start: 0, count: 0 };
  return list;
}
