// WindModifierEngine (registry name 'windModifier'): WindField sources with no visuals of their own
// (their visual partners come from the other engines of the same preset). docs/engines/windModifier.md
// lists every param with its unit and range.
//
// One instance authors one or more sources (windSources.js): updraft (plume), downburst, wake,
// jetStream, slipstream, waveLift, gustFront and curtain. Which ones:
//   params.sources   [{ type, ...typeParams, ...sourceParams }], up to MAX_SOURCES; or
//   params.type      a single source whose type params sit beside it in params; or neither:
//   preset.wind      every entry whose type this engine knows ({ type, params }).
// Per source it adds: direction ('heading' | 'ambient' | compass degrees), turn, offset [along, side,
// up], start / stop (s), fadeIn / fadeOut (s), strength (multiplier) and a timeline of strength keys
// ({ keys: [[t, value], ...], loop, offset: seconds | 'seeded' }).
//
// Motion (the whole instance): drift (m/s along driftHeading, riding the ground along a seeded path
// precomputed at create), or follow (the registry name of a sibling engine in the same spawn: the
// sources ride that part's anchor, and 'heading' becomes its direction of travel, as a sky whale's
// slipstream trails its body). Sources move with setSourceBounds, which is allocation-free.
//
// Timeline hooks: instance.control.strength scales every source and instance.control.strengths[i]
// source i (a set piece writes them); a site's instance.active = false fades them all out. An event
// ends with its duration (instance.ended) unless params.endWithDuration is false.
//
// LOD: nothing to draw. At 'far' a source is removed when its reach (plus its offset) is inside the
// nearest the far tier can start (lod.mid x 0.5 LOD bias x 0.92 hysteresis), so it can never touch
// the player there; it comes back at 'mid'. A jet stream or a wide wave field keeps its source.
//
// No allocations in update(): per-source numbers live in Float64Arrays, the sources sample into
// reused results, and bounds move in place.
import { FRAME, FRAME_SIZE, WIND_SOURCE_TYPES, createWindSource, resolveSourceParams } from './windSources.js';

export const MAX_SOURCES = 8;
/** The source types this engine authors ('rankine' belongs to the vortex engine). */
export const MODIFIER_TYPES = Object.freeze(WIND_SOURCE_TYPES.filter((type) => type !== 'rankine'));
const MIN_LOD_BIAS = 0.5;
const LOD_HYSTERESIS = 0.08;
const PATH_STEP = 60;
const PATH_MAX_POINTS = 512;
const SITE_PATH_SECONDS = 600;
const ACTIVITY_RATE = 0.5;
const SOURCE_FIELDS = Object.freeze(['type', 'direction', 'turn', 'offset', 'start', 'stop', 'fadeIn', 'fadeOut', 'strength', 'timeline']);

// Per-instance numbers.
const I = Object.freeze({ AGE: 0, ACTIVITY: 1, PREV_X: 2, PREV_Z: 3, TRAVEL_X: 4, TRAVEL_Z: 5, SPEED: 6, DT: 7, DURATION: 8 });
const INSTANCE_SIZE = 9;
// Per-source numbers.
const P = Object.freeze({
  START: 0, STOP: 1, FADE_IN: 2, FADE_OUT: 3, STRENGTH: 4, TURN: 5, ALONG: 6, SIDE: 7, UP: 8, MODE: 9, FIXED_X: 10, FIXED_Z: 11,
  WIND_ON: 12, TIMELINE_LOOP: 13, TIMELINE_OFFSET: 14, CURRENT: 15, TIME: 16, RAMP_FROM: 17, RAMP_TO: 18, RAMP_VALUE: 19,
});
const SOURCE_SIZE = 20;
const DIRECTION_MODES = Object.freeze({ heading: 0, ambient: 1, fixed: 2 });

/**
 * 1 - smoothstep(edge0, edge1, value) (fading out) or smoothstep (fading in), multiplied into
 * numbers[P.CURRENT]: the frame update calls this instead of a function returning a double, which
 * V8 boxes whenever it does not inline the call. The edges and value are read from numbers.
 */
function multiplyRamp(numbers, fadeOut) {
  const t = Math.min(1, Math.max(0, (numbers[P.RAMP_VALUE] - numbers[P.RAMP_FROM]) / (numbers[P.RAMP_TO] - numbers[P.RAMP_FROM])));
  const eased = t * t * (3 - 2 * t);
  numbers[P.CURRENT] *= fadeOut ? 1 - eased : eased;
}

function finite(value, fallback, label, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) throw new TypeError(`[DRIFTWING] windModifier: ${label} must be a finite number, got ${String(value)}`);
  return Math.min(max, Math.max(min, value));
}

/** The source entries of an activation: params.sources, a single params.type, or preset.wind. */
export function sourceEntries(preset, params) {
  if (Array.isArray(params.sources)) {
    if (params.sources.length === 0) throw new TypeError('[DRIFTWING] windModifier: params.sources is empty');
    return params.sources;
  }
  if (typeof params.type === 'string') return [params];
  const fromPreset = (Array.isArray(preset.wind) ? preset.wind : [])
    .filter((entry) => entry && MODIFIER_TYPES.includes(entry.type))
    .map((entry) => ({ ...(entry.params ?? {}), type: entry.type }));
  if (fromPreset.length === 0) throw new TypeError(`[DRIFTWING] windModifier: preset "${preset.id}" gives no sources (params.sources, params.type or a preset.wind entry of ${MODIFIER_TYPES.join(', ')})`);
  return fromPreset;
}

/** Strength keys of a timeline: Float64Array [t0, v0, t1, v1, ...] sorted by time, or null. */
function readTimeline(timeline, label) {
  if (timeline === undefined || timeline === null) return null;
  if (typeof timeline !== 'object' || !Array.isArray(timeline.keys) || timeline.keys.length === 0) {
    throw new TypeError(`[DRIFTWING] windModifier: ${label}.timeline must be { keys: [[seconds, value], ...], loop?, offset? }`);
  }
  const keys = new Float64Array(timeline.keys.length * 2);
  let previous = -Infinity;
  timeline.keys.forEach((key, index) => {
    if (!Array.isArray(key) || key.length !== 2 || !Number.isFinite(key[0]) || !Number.isFinite(key[1]) || key[0] < previous) {
      throw new TypeError(`[DRIFTWING] windModifier: ${label}.timeline.keys[${index}] must be [seconds, value] in time order`);
    }
    previous = key[0];
    keys[index * 2] = key[0];
    keys[index * 2 + 1] = key[1];
  });
  return keys;
}

/**
 * The timeline's value at the time numbers[P.TIME] (piecewise linear, holding its end values),
 * written to numbers[P.CURRENT]: a returned double would be boxed.
 */
function writeTimelineValue(keys, numbers) {
  const time = numbers[P.TIME];
  const count = keys.length >> 1;
  if (time <= keys[0]) {
    numbers[P.CURRENT] = keys[1];
    return;
  }
  for (let index = 1; index < count; index++) {
    const t1 = keys[index * 2];
    if (time <= t1) {
      const t0 = keys[index * 2 - 2];
      const v0 = keys[index * 2 - 1];
      const span = t1 - t0;
      numbers[P.CURRENT] = span > 0 ? v0 + ((keys[index * 2 + 1] - v0) * (time - t0)) / span : keys[index * 2 + 1];
      return;
    }
  }
  numbers[P.CURRENT] = keys[count * 2 - 1];
}

export function createWindModifierEngine() {
  let ctx = null;
  let live = 0;
  let serial = 0;
  let registered = 0;
  const active = [];

  // ---- Create ----------------------------------------------------------------------------------------
  function resolveSource(entry, index, scale, heading, rng) {
    if (!entry || typeof entry !== 'object') throw new TypeError(`[DRIFTWING] windModifier: sources[${index}] must be an object`);
    const type = entry.type;
    if (!MODIFIER_TYPES.includes(type)) throw new TypeError(`[DRIFTWING] windModifier: sources[${index}].type must be one of ${MODIFIER_TYPES.join(', ')}, got ${String(type)}`);
    const typeParams = {};
    for (const [key, value] of Object.entries(entry)) if (!SOURCE_FIELDS.includes(key)) typeParams[key] = value;
    const params = resolveSourceParams(type, typeParams, scale);
    const numbers = new Float64Array(SOURCE_SIZE);
    const label = `sources[${index}]`;
    numbers[P.START] = finite(entry.start, 0, `${label}.start`, 0);
    numbers[P.STOP] = finite(entry.stop, Infinity, `${label}.stop`, 0);
    numbers[P.FADE_IN] = finite(entry.fadeIn, 4, `${label}.fadeIn`, 0, 600);
    numbers[P.FADE_OUT] = finite(entry.fadeOut, 6, `${label}.fadeOut`, 0, 600);
    numbers[P.STRENGTH] = finite(entry.strength, 1, `${label}.strength`, 0, 4);
    numbers[P.TURN] = finite(entry.turn, 0, `${label}.turn`, -360, 360);
    const offset = entry.offset ?? [0, 0, 0];
    if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) throw new TypeError(`[DRIFTWING] windModifier: ${label}.offset must be [along, side, up] in metres`);
    numbers[P.ALONG] = offset[0] * scale;
    numbers[P.SIDE] = offset[1] * scale;
    numbers[P.UP] = offset[2] * scale;
    const direction = entry.direction ?? 'heading';
    if (typeof direction === 'number') {
      if (!Number.isFinite(direction)) throw new TypeError(`[DRIFTWING] windModifier: ${label}.direction must be 'heading', 'ambient' or compass degrees`);
      numbers[P.MODE] = DIRECTION_MODES.fixed;
      const radians = ((direction + numbers[P.TURN]) * Math.PI) / 180;
      numbers[P.FIXED_X] = Math.sin(radians);
      numbers[P.FIXED_Z] = -Math.cos(radians);
    } else if (direction === 'heading' || direction === 'ambient') {
      numbers[P.MODE] = DIRECTION_MODES[direction];
    } else {
      throw new TypeError(`[DRIFTWING] windModifier: ${label}.direction must be 'heading', 'ambient' or compass degrees, got ${String(direction)}`);
    }
    const timeline = readTimeline(entry.timeline, label);
    if (timeline) {
      numbers[P.TIMELINE_LOOP] = finite(entry.timeline.loop, 0, `${label}.timeline.loop`, 0);
      const offsetValue = entry.timeline.offset;
      numbers[P.TIMELINE_OFFSET] = offsetValue === 'seeded' ? rng() * (numbers[P.TIMELINE_LOOP] > 0 ? numbers[P.TIMELINE_LOOP] : timeline[timeline.length - 2]) : finite(offsetValue, 0, `${label}.timeline.offset`);
    }
    const frame = new Float64Array(FRAME_SIZE);
    frame[FRAME.PHASE] = rng() * Math.PI * 2;
    const headingRadians = ((heading + numbers[P.TURN]) * Math.PI) / 180;
    frame[FRAME.DIR_X] = numbers[P.MODE] === DIRECTION_MODES.fixed ? numbers[P.FIXED_X] : Math.sin(headingRadians);
    frame[FRAME.DIR_Z] = numbers[P.MODE] === DIRECTION_MODES.fixed ? numbers[P.FIXED_Z] : -Math.cos(headingRadians);
    if (numbers[P.MODE] === DIRECTION_MODES.ambient) writeAmbientDirection(frame);
    return { type, params, numbers, frame, timeline, source: null };
  }

  /** The prevailing wind's downwind direction (the shared windDirection uniform) into the frame. */
  function writeAmbientDirection(frame) {
    const direction = ctx.uniforms.windDirection.value;
    const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
    if (length < 1e-6) return;
    frame[FRAME.DIR_X] = direction.x / length;
    frame[FRAME.DIR_Z] = direction.y / length;
  }

  /** The seeded drift path (x, z, surface height per PATH_STEP metres) riding the ground or water. */
  function buildDriftPath(position, speed, heading, duration, followTerrain) {
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : SITE_PATH_SECONDS;
    const length = speed * seconds;
    const points = Math.max(2, Math.min(PATH_MAX_POINTS, Math.ceil(length / PATH_STEP) + 2));
    const step = length / (points - 2);
    const path = new Float64Array(points * 3);
    const radians = (heading * Math.PI) / 180;
    for (let index = 0; index < points; index++) {
      const x = position.x + Math.sin(radians) * step * index;
      const z = position.z - Math.cos(radians) * step * index;
      path[index * 3] = x;
      path[index * 3 + 1] = z;
      path[index * 3 + 2] = followTerrain ? Math.max(ctx.terrain.groundHeight(x, z), ctx.terrain.waterLevel) : position.y;
    }
    return { points: path, count: points, step };
  }

  // ---- Wind registration ----------------------------------------------------------------------------
  function addSource(instance, entry) {
    if (entry.numbers[P.WIND_ON] === 1) return;
    const source = entry.source;
    ctx.wind.addSource({ id: source.id, kind: source.kind, bounds: source.refreshBounds(), sample: source.sample });
    entry.numbers[P.WIND_ON] = 1;
    instance.windSourceIds.push(source.id);
    registered++;
  }

  function removeSource(instance, entry) {
    if (entry.numbers[P.WIND_ON] !== 1) return;
    ctx.wind.removeSource(entry.source.id);
    entry.numbers[P.WIND_ON] = 0;
    const index = instance.windSourceIds.indexOf(entry.source.id);
    if (index >= 0) instance.windSourceIds.splice(index, 1);
    registered--;
  }

  // ---- Frame ------------------------------------------------------------------------------------------------
  /** Finds the followed sibling part's anchor (once: getParts allocates). Throws when it is missing. */
  function resolveFollow(instance) {
    const record = instance.data;
    const parts = ctx.spawns && typeof ctx.spawns.getParts === 'function' ? ctx.spawns.getParts(instance.id) : [];
    const leader = parts.find((part) => part !== instance && part.engine === record.follow);
    if (!leader) throw new Error(`[DRIFTWING] windModifier: spawn ${instance.id} has no "${record.follow}" part to follow`);
    record.leader = leader.anchor;
  }

  function moveAnchor(instance) {
    const record = instance.data;
    const numbers = record.numbers;
    const dt = numbers[I.DT];
    const anchor = instance.anchor;
    if (record.follow) {
      if (!record.leader) resolveFollow(instance);
      anchor.copy(record.leader);
    } else if (record.path) {
      const path = record.path;
      let distance = record.drift * numbers[I.AGE];
      const span = (path.count - 2) * path.step;
      if (!Number.isFinite(record.duration)) {
        const cycle = distance % (2 * span);
        distance = cycle > span ? 2 * span - cycle : cycle;
      }
      const position = Math.min(path.count - 1.0001, distance / path.step);
      const index = Math.floor(position);
      const blend = position - index;
      const points = path.points;
      const base = index * 3;
      anchor.x = points[base] + (points[base + 3] - points[base]) * blend;
      anchor.z = points[base + 1] + (points[base + 4] - points[base + 1]) * blend;
      anchor.y = points[base + 2] + (points[base + 5] - points[base + 2]) * blend;
    }
    // The direction of travel (smoothed), for 'heading' sources that follow or drift.
    if (dt > 0) {
      const velocityX = (anchor.x - numbers[I.PREV_X]) / dt;
      const velocityZ = (anchor.z - numbers[I.PREV_Z]) / dt;
      const blend = Math.min(1, dt * 2);
      numbers[I.TRAVEL_X] += (velocityX - numbers[I.TRAVEL_X]) * blend;
      numbers[I.TRAVEL_Z] += (velocityZ - numbers[I.TRAVEL_Z]) * blend;
      numbers[I.SPEED] = Math.sqrt(numbers[I.TRAVEL_X] * numbers[I.TRAVEL_X] + numbers[I.TRAVEL_Z] * numbers[I.TRAVEL_Z]);
    }
    numbers[I.PREV_X] = anchor.x;
    numbers[I.PREV_Z] = anchor.z;
  }

  /** The source's strength now, written to its frame's STRENGTH (worked out in numbers[P.CURRENT]). */
  function writeSourceStrength(instance, entry, index) {
    const record = instance.data;
    const age = record.numbers[I.AGE];
    const numbers = entry.numbers;
    const frame = entry.frame;
    const local = age - numbers[P.START];
    if (local < 0 || age > numbers[P.STOP] + numbers[P.FADE_OUT]) {
      frame[FRAME.STRENGTH] = 0;
      return;
    }
    numbers[P.CURRENT] = numbers[P.STRENGTH] * record.numbers[I.ACTIVITY];
    if (numbers[P.FADE_IN] > 0) {
      numbers[P.RAMP_FROM] = 0;
      numbers[P.RAMP_TO] = numbers[P.FADE_IN];
      numbers[P.RAMP_VALUE] = local;
      multiplyRamp(numbers, false);
    }
    if (numbers[P.STOP] < Infinity) {
      if (numbers[P.FADE_OUT] > 0) {
        numbers[P.RAMP_FROM] = numbers[P.STOP];
        numbers[P.RAMP_TO] = numbers[P.STOP] + numbers[P.FADE_OUT];
        numbers[P.RAMP_VALUE] = age;
        multiplyRamp(numbers, true);
      } else if (age > numbers[P.STOP]) {
        numbers[P.CURRENT] = 0;
      }
    }
    if (record.hasDuration && numbers[P.FADE_OUT] > 0) {
      numbers[P.RAMP_FROM] = record.numbers[I.DURATION] - numbers[P.FADE_OUT];
      numbers[P.RAMP_TO] = record.numbers[I.DURATION];
      numbers[P.RAMP_VALUE] = age;
      multiplyRamp(numbers, true);
    }
    if (entry.timeline) {
      const strength = numbers[P.CURRENT];
      const loop = numbers[P.TIMELINE_LOOP];
      numbers[P.TIME] = loop > 0 ? (local + numbers[P.TIMELINE_OFFSET]) % loop : local + numbers[P.TIMELINE_OFFSET];
      writeTimelineValue(entry.timeline, numbers);
      numbers[P.CURRENT] *= strength;
    }
    const control = instance.control;
    const overall = Number.isFinite(control.strength) ? Math.max(0, control.strength) : 1;
    const own = control.strengths[index];
    frame[FRAME.STRENGTH] = numbers[P.CURRENT] * overall * (Number.isFinite(own) ? Math.max(0, own) : 1);
  }

  function updateSource(instance, entry, index) {
    const record = instance.data;
    const numbers = entry.numbers;
    const frame = entry.frame;
    const anchor = instance.anchor;
    const age = record.numbers[I.AGE];
    const mode = numbers[P.MODE];
    if (mode === DIRECTION_MODES.ambient) {
      writeAmbientDirection(frame);
    } else if (mode === DIRECTION_MODES.heading && (record.follow || record.path) && record.numbers[I.SPEED] > 1) {
      const speed = record.numbers[I.SPEED];
      const travelX = record.numbers[I.TRAVEL_X] / speed;
      const travelZ = record.numbers[I.TRAVEL_Z] / speed;
      const turn = (numbers[P.TURN] * Math.PI) / 180;
      frame[FRAME.DIR_X] = travelX * Math.cos(turn) - travelZ * Math.sin(turn);
      frame[FRAME.DIR_Z] = travelX * Math.sin(turn) + travelZ * Math.cos(turn);
    }
    const dirX = frame[FRAME.DIR_X];
    const dirZ = frame[FRAME.DIR_Z];
    frame[FRAME.X] = anchor.x + dirX * numbers[P.ALONG] - dirZ * numbers[P.SIDE];
    frame[FRAME.Y] = anchor.y + numbers[P.UP];
    frame[FRAME.Z] = anchor.z + dirZ * numbers[P.ALONG] + dirX * numbers[P.SIDE];
    frame[FRAME.AGE] = age - numbers[P.START];
    frame[FRAME.SPEED] = record.numbers[I.SPEED];
    writeSourceStrength(instance, entry, index);
    if (entry.type === 'downburst') {
      const params = entry.params;
      frame[FRAME.A] = Math.min(params.maxRadius, params.coreRadius + params.expand * Math.max(0, age - numbers[P.START]));
    }
    if (numbers[P.WIND_ON] === 1) ctx.wind.setSourceBounds(entry.source.id, entry.source.refreshBounds());
  }

  return {
    name: 'windModifier',

    init(engineCtx) {
      ctx = engineCtx;
    },

    create(preset, params, rng) {
      const { THREE } = ctx;
      const scale = Number.isFinite(params.scale) && params.scale > 0 ? params.scale : 1;
      const heading = Number.isFinite(params.heading) ? params.heading : 0;
      const duration = Number.isFinite(params.duration) && params.duration > 0 ? params.duration : null;
      const entries = sourceEntries(preset, params);
      if (entries.length > MAX_SOURCES) throw new TypeError(`[DRIFTWING] windModifier: at most ${MAX_SOURCES} sources per instance, got ${entries.length}`);
      const follow = params.follow ?? null;
      if (follow !== null && typeof follow !== 'string') throw new TypeError('[DRIFTWING] windModifier: follow must be the registry name of a sibling engine');
      const drift = finite(params.drift, 0, 'drift', 0, 120);
      const driftHeading = finite(params.driftHeading, heading, 'driftHeading');
      const anchor = params.position;
      const record = {
        numbers: new Float64Array(INSTANCE_SIZE),
        sources: entries.map((entry, index) => resolveSource(entry, index, scale, heading, rng)),
        duration,
        hasDuration: duration !== null,
        endWithDuration: params.endWithDuration !== false,
        follow,
        leader: null,
        drift,
        path: follow === null && drift > 0 ? buildDriftPath(anchor, drift, driftHeading, duration, params.driftTerrain !== false) : null,
        preset,
      };
      record.numbers[I.ACTIVITY] = 1;
      record.numbers[I.DURATION] = duration ?? 0;
      record.numbers[I.PREV_X] = anchor.x;
      record.numbers[I.PREV_Z] = anchor.z;
      const instance = {
        anchor,
        radius: 0,
        windSourceIds: [],
        lights: 0,
        particles: 0,
        tier: 'near',
        control: { strength: 1, strengths: new Float64Array(record.sources.length).fill(1) },
        data: record,
      };
      try {
        record.sources.forEach((entry, index) => {
          serial++;
          entry.source = createWindSource(THREE, { id: `windModifier:${params.seed ?? 0}:${serial}:${entry.type}`, type: entry.type, params: entry.params, frame: entry.frame });
          updateSource(instance, entry, index);
          addSource(instance, entry);
        });
      } catch (error) {
        for (const entry of record.sources) if (entry.source) removeSource(instance, entry);
        throw error;
      }
      let radius = 0;
      for (const entry of record.sources) radius = Math.max(radius, entry.source.reach);
      instance.radius = radius;
      live++;
      active.push(instance);
      return instance;
    },

    update(instance, dt) {
      const record = instance.data;
      const numbers = record.numbers;
      numbers[I.DT] = dt;
      numbers[I.AGE] += dt;
      const wantActive = instance.active === false ? 0 : 1;
      numbers[I.ACTIVITY] += (wantActive - numbers[I.ACTIVITY]) * Math.min(1, dt * ACTIVITY_RATE);
      moveAnchor(instance);
      const sources = record.sources;
      for (let index = 0; index < sources.length; index++) updateSource(instance, sources[index], index);
      if (record.endWithDuration && record.hasDuration && numbers[I.AGE] >= numbers[I.DURATION]) instance.ended = true;
    },

    setLOD(instance, tier) {
      const record = instance.data;
      instance.tier = tier;
      const lod = record.preset.lod;
      const farStartsAt = lod && Number.isFinite(lod.mid) ? lod.mid * MIN_LOD_BIAS * (1 - LOD_HYSTERESIS) : Infinity;
      for (const entry of record.sources) {
        const numbers = entry.numbers;
        const reach = entry.source.reach + Math.sqrt(numbers[P.ALONG] * numbers[P.ALONG] + numbers[P.SIDE] * numbers[P.SIDE]);
        if (tier === 'far' && reach < farStartsAt) removeSource(instance, entry);
        else addSource(instance, entry);
      }
    },

    dispose(instance) {
      for (const entry of instance.data.sources) removeSource(instance, entry);
      live--;
      const index = active.indexOf(instance);
      if (index >= 0) active.splice(index, 1);
    },

    stats() {
      return { instances: live, particles: 0, lights: 0, buffers: 0, drawCalls: 0, sources: registered };
    },
  };
}
