// SetPieceEngine ('setPiece', contract section 3): scripted multi-stage timelines that orchestrate
// other engines through the SpawnManager. A timeline is data in the preset (engine params); the
// legendary storm chase is one, and Phase 3 combos reuse it. docs/engines/setPiece.md lists every
// field.
//
//   children  the spawns a timeline may start: a preset id, a place (along / across / up metres in
//             the set piece's heading frame, from its anchor or another child), per-activation engine
//             params, an optional track (a steady drift across the terrain)
//   stages    run in order. Each may wait for a start condition (`when`, with a timeout that skips
//             it), then runs for its `duration` (seconds, or a seeded [min, max]) unless `until` fires
//             first. On entry a stage starts and ends children and narrates; while it runs, its ramps
//             ease child params from `from` to `to`.
//   triggers  conditions on the stage time, the player's distance to a child or the anchor, the
//             player's altitude, the regional weather, and whether a child is active or has ended;
//             combined with `any` / `all`
//   records   measured while children live (the closest the player came, the seconds spent within a
//             radius) and reported when the set piece ends ('setPiece:ended')
//   journal   statistics sent to the journal when it ends (typed 'journalStat'): a record's value
//             (closestTornado) or a fixed value once a record came within a limit (stormsChased)
//
// Children are activated through ctx.spawns (the SpawnManager) with the set piece's own source, so
// every budget, the heavy limit, LOD, lures and dispose hold for them; a refused child is retried.
// Children end by setting their instances' `ended` flag, which the manager honours on its next
// update (never a nested deactivate from inside the manager's loop). Ramps write the child's
// `instance.params[name]` when its engine exposes live params (no call, no allocation) and otherwise
// call the engine's optional setParam(instance, name, value) at most RAMP_CALLS_PER_SECOND times.
//
// Bus events (untyped, namespaced): 'setPiece:stage' { id, presetId, stage, index },
// 'setPiece:narrate' { id, presetId, name, stage, text, position, priority, ttl } (the copilot speaks it),
// 'setPiece:ended' { id, presetId, completed, stagesRun, records }; and the typed 'journalStat'.
//
// Deterministic: every duration, narration line and child seed is drawn from the spawn's seeded
// random generator when the set piece is created. update() allocates nothing between stage changes.
import { createParamReader, roll } from './params.js';

const ENGINE_NAME = 'setPiece';
/** Seconds between attempts to start a child the budgets refused. */
const DEFAULT_RETRY_SECONDS = 2;
/** Ramps that go through an engine's setParam() update at most this often. */
const RAMP_CALLS_PER_SECOND = 10;
/** Tracked children sample the ground under them this often (s). */
const TRACK_GROUND_SECONDS = 0.5;
const WEATHER_STATES = Object.freeze(['clear', 'building', 'storm', 'clearing']);
const EASES = Object.freeze(['linear', 'smooth', 'in', 'out']);
const MEASURES = Object.freeze(['closestDistance', 'timeWithin']);
/** journalStat folds (src/core/events.js JOURNAL_STAT_OPS) and key form (src/gameplay/journal.js). */
const JOURNAL_OPS = Object.freeze(['min', 'max', 'add']);
const JOURNAL_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
const CONDITION_KINDS = Object.freeze(['time', 'playerDistance', 'altitude', 'weather', 'childEnded', 'childActive']);
const DEG = Math.PI / 180;

/** Numbers per child in the state array: status, retry timer, ground timer, ground height, wander time. */
const CHILD_STRIDE = 5;
const CHILD_IDLE = 0;
const CHILD_WAITING = 1;
const CHILD_ACTIVE = 2;
const CHILD_ENDED = 3;

/** Condition kinds as small integers for the frame loop. */
const KIND = Object.freeze({ time: 0, playerDistance: 1, altitude: 2, weather: 3, childEnded: 4, childActive: 5 });
const EASE = Object.freeze({ linear: 0, smooth: 1, in: 2, out: 3 });

function ease(kind, t) {
  if (kind === 1) return t * t * (3 - 2 * t);
  if (kind === 2) return t * t;
  if (kind === 3) return 1 - (1 - t) * (1 - t);
  return t;
}

/** Validates and flattens the timeline params into the plan one instance runs. Throws naming the path. */
function readTimeline(preset, params, rng, manager) {
  const read = createParamReader(ENGINE_NAME, preset.id, params);
  const childrenParams = read.object('children', null);
  if (!childrenParams) read.fail('children', 'is required: { key: { preset, ... } }');
  const children = [];
  const childIndex = new Map();
  for (const [key, definition] of Object.entries(childrenParams)) {
    const childRead = createParamReader(ENGINE_NAME, preset.id, definition, `params.children.${key}`);
    const presetId = childRead.string('preset', null);
    if (!presetId) childRead.fail('preset', 'is required (a preset id)');
    if (manager && !manager.getPreset(presetId)) childRead.fail('preset', `names a preset the spawn manager does not know: "${presetId}"`);
    if (presetId === preset.id) childRead.fail('preset', 'cannot be the set piece itself');
    const offsetRead = childRead.nested('offset');
    const trackParams = childRead.object('track', null);
    const trackRead = childRead.nested('track');
    const overrides = childRead.object('params', null);
    if (overrides) {
      for (const [engineName, value] of Object.entries(overrides)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) childRead.fail(`params.${engineName}`, 'must be an object of engine params');
      }
    }
    childIndex.set(key, children.length);
    children.push({
      key,
      presetId,
      along: offsetRead.number('along', 0),
      across: offsetRead.number('across', 0),
      up: offsetRead.number('up', 0, -2000, 20000),
      from: childRead.string('from', null),
      headingOffset: childRead.number('heading', 0, -360, 360),
      overrides: overrides ?? null,
      duration: childRead.has('duration') ? childRead.number('duration', 0, 1, 86400) : null,
      track: trackParams ? {
        speed: trackRead.number('speed', 10, 0, 200),
        headingOffset: trackRead.number('heading', 0, -360, 360),
        wander: trackRead.number('wander', 0, 0, 90),
        followGround: trackRead.boolean('followGround', true),
      } : null,
      seed: Math.floor(rng() * 4294967296) >>> 0,
      wanderPhase: rng() * Math.PI * 2,
    });
  }
  if (children.length === 0) read.fail('children', 'must name at least one child');
  for (const child of children) {
    if (child.from !== null && !childIndex.has(child.from)) read.fail(`children.${child.key}.from`, `names no child: "${child.from}"`);
    if (child.from === child.key) read.fail(`children.${child.key}.from`, 'cannot be the child itself');
  }
  const childOf = (key, path) => {
    if (typeof key !== 'string' || !childIndex.has(key)) read.fail(path, `names no child: ${JSON.stringify(key)}`);
    return childIndex.get(key);
  };

  function readConditions(value, path) {
    if (value === undefined || value === null) return null;
    let mode = 'any';
    let list = [value];
    if (typeof value === 'object' && !Array.isArray(value) && (value.any || value.all)) {
      mode = value.any ? 'any' : 'all';
      list = value.any ?? value.all;
      if (!Array.isArray(list) || list.length === 0) read.fail(`${path}.${mode}`, 'must be a non-empty array of conditions');
    }
    const conditions = list.map((condition, index) => {
      const where = `${path}${list.length > 1 || mode === 'all' ? `.${mode}[${index}]` : ''}`;
      if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) read.fail(where, 'must be a condition object');
      const keys = Object.keys(condition);
      if (keys.length !== 1 || !CONDITION_KINDS.includes(keys[0])) read.fail(where, `must have exactly one of ${CONDITION_KINDS.join(', ')}`);
      const kind = keys[0];
      const body = condition[kind];
      const entry = { kind: KIND[kind], value: 0, min: -Infinity, max: Infinity, child: -1, agl: false, weather: null };
      const bodyRead = createParamReader(ENGINE_NAME, preset.id, typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}, `params.${where}.${kind}`);
      if (kind === 'time') {
        const range = createParamReader(ENGINE_NAME, preset.id, { time: body }, `params.${where}`).range('time', null, 0, 86400);
        entry.value = roll(range, rng);
      } else if (kind === 'playerDistance') {
        entry.min = bodyRead.number('min', -Infinity, 0);
        entry.max = bodyRead.number('max', Infinity, 0);
        if (!Number.isFinite(entry.min) && !Number.isFinite(entry.max)) read.fail(`${where}.playerDistance`, 'needs min or max (m)');
        entry.child = bodyRead.has('child') ? childOf(body.child, `${where}.playerDistance.child`) : -1;
      } else if (kind === 'altitude') {
        entry.min = bodyRead.number('min', -Infinity);
        entry.max = bodyRead.number('max', Infinity);
        entry.agl = bodyRead.boolean('agl', false);
      } else if (kind === 'weather') {
        const states = Array.isArray(body) ? body : [body];
        for (const state of states) if (!WEATHER_STATES.includes(state)) read.fail(`${where}.weather`, `"${state}" is not one of ${WEATHER_STATES.join(', ')}`);
        entry.weather = Object.freeze([...states]);
      } else {
        entry.child = childOf(body, `${where}.${kind}`);
      }
      return entry;
    });
    return { all: mode === 'all', conditions };
  }

  const stagesParams = read.array('stages', null);
  if (!stagesParams || stagesParams.length === 0) read.fail('stages', 'must be a non-empty array');
  const ids = new Set();
  let longest = 0;
  const stages = stagesParams.map((stage, index) => {
    const path = `stages[${index}]`;
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) read.fail(path, 'must be an object');
    const stageRead = createParamReader(ENGINE_NAME, preset.id, stage, `params.${path}`);
    const id = stageRead.string('id', `stage${index}`);
    if (ids.has(id)) read.fail(`${path}.id`, `"${id}" is used by another stage`);
    ids.add(id);
    const durationRange = stageRead.has('duration') ? stageRead.range('duration', null, 0, 86400) : null;
    const until = readConditions(stage.until, `${path}.until`);
    if (!durationRange && !until) read.fail(path, 'needs a duration or an until condition (it would never end)');
    const duration = durationRange ? roll(durationRange, rng) : Infinity;
    longest += durationRange ? durationRange[1] : 0;
    const start = stageRead.array('start', []).map((key, keyIndex) => childOf(key, `${path}.start[${keyIndex}]`));
    const end = stageRead.array('end', []).map((key, keyIndex) => childOf(key, `${path}.end[${keyIndex}]`));
    const ramps = stageRead.array('ramps', []).map((ramp, rampIndex) => {
      const rampRead = createParamReader(ENGINE_NAME, preset.id, ramp, `params.${path}.ramps[${rampIndex}]`);
      const param = rampRead.string('param', null);
      if (!param) rampRead.fail('param', 'is required (the child engine param to ramp)');
      return {
        child: childOf(ramp.child, `${path}.ramps[${rampIndex}].child`),
        param,
        from: rampRead.number('from', 0),
        to: rampRead.number('to', 1),
        ease: EASE[rampRead.choice('ease', 'smooth', EASES)],
        over: rampRead.number('over', Number.isFinite(duration) ? duration : 60, 0.01, 86400),
      };
    });
    const narrate = stage.narrate ?? null;
    let narration = null;
    if (narrate !== null) {
      const lines = Array.isArray(narrate) ? narrate : narrate.lines;
      if (!Array.isArray(lines) || lines.length === 0 || !lines.every((line) => typeof line === 'string' && line.length > 0)) read.fail(`${path}.narrate`, 'must be a non-empty array of lines, or { lines, target?, delay? }');
      const narrateRead = createParamReader(ENGINE_NAME, preset.id, Array.isArray(narrate) ? {} : narrate, `params.${path}.narrate`);
      narration = {
        text: lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))],
        target: !Array.isArray(narrate) && narrate.target !== undefined ? childOf(narrate.target, `${path}.narrate.target`) : (start.length > 0 ? start[0] : -1),
        delay: narrateRead.number('delay', 0, 0, 3600),
      };
    }
    return {
      id,
      duration,
      when: readConditions(stage.when, `${path}.when`),
      whenTimeout: stageRead.number('whenTimeout', Infinity, 0),
      until,
      start,
      end,
      ramps,
      narration,
      marker: stageRead.string('marker', null),
    };
  });

  const records = read.array('records', []).map((record, index) => {
    const recordRead = createParamReader(ENGINE_NAME, preset.id, record, `params.records[${index}]`);
    const id = recordRead.string('id', null);
    if (!id) recordRead.fail('id', 'is required');
    return {
      id,
      child: record.child === undefined ? -1 : childOf(record.child, `records[${index}].child`),
      measure: recordRead.choice('measure', 'closestDistance', MEASURES),
      radius: recordRead.number('radius', 1000, 0),
    };
  });
  const recordIndex = new Map(records.map((record, index) => [record.id, index]));
  const journal = read.array('journal', []).map((stat, index) => {
    const statRead = createParamReader(ENGINE_NAME, preset.id, stat, `params.journal[${index}]`);
    const key = statRead.string('key', null);
    if (!key || !JOURNAL_KEY_PATTERN.test(key)) statRead.fail('key', `must be a camelCase journal statistic name, got ${JSON.stringify(key)}`);
    const recordId = statRead.string('record', null);
    if (recordId !== null && !recordIndex.has(recordId)) statRead.fail('record', `names no record: "${recordId}"`);
    const hasValue = statRead.has('value');
    if (!hasValue && recordId === null) statRead.fail('value', 'is required without a record (the number to send)');
    return {
      key,
      op: statRead.choice('op', 'add', JOURNAL_OPS),
      record: recordId === null ? -1 : recordIndex.get(recordId),
      value: hasValue ? statRead.number('value', 0) : null,
      max: statRead.number('max', Infinity),
    };
  });
  const narrationRead = read.nested('narration');
  return {
    children,
    stages,
    records,
    journal,
    retrySeconds: read.number('retrySeconds', DEFAULT_RETRY_SECONDS, 0.1, 60),
    radius: read.number('radius', 4000, 10, 100000),
    priority: narrationRead.number('priority', 3, 0, 10),
    ttl: narrationRead.number('ttl', 25, 1, 600),
    longest,
  };
}

export function createSetPieceEngine() {
  let ctx = null;
  let weather = 'clear';
  const live = [];
  /** Child spawn id -> { instance, child } for the spawnEnded listener. */
  const childBySpawn = new Map();
  const counts = { instances: 0, stages: 0, children: 0, refused: 0, narrations: 0, rampCalls: 0, unsupportedRamps: 0 };

  function onSpawnEnded(payload) {
    const entry = childBySpawn.get(payload.id);
    if (!entry) return;
    childBySpawn.delete(payload.id);
    const state = entry.instance.data.childState;
    const base = entry.child * CHILD_STRIDE;
    state[base] = CHILD_ENDED;
    entry.instance.data.childParts[entry.child] = null;
    counts.children--;
  }

  function onWeatherChanged(payload) {
    weather = payload.state;
  }

  function childAnchor(data, index) {
    const parts = data.childParts[index];
    return parts && parts.length > 0 ? parts[0].anchor : null;
  }

  /** Starts child `index` (or schedules a retry when a budget refuses it). */
  function startChild(instance, index) {
    const data = instance.data;
    const plan = data.plan;
    const child = plan.children[index];
    const state = data.childState;
    const base = index * CHILD_STRIDE;
    if (state[base] === CHILD_ACTIVE) return;
    const heading = (data.heading + child.headingOffset) * DEG;
    const frameAngle = data.heading * DEG;
    const forwardX = Math.sin(frameAngle);
    const forwardZ = -Math.cos(frameAngle);
    let originX = instance.anchor.x;
    let originZ = instance.anchor.z;
    if (child.from !== null) {
      const fromIndex = plan.children.findIndex((candidate) => candidate.key === child.from);
      const from = childAnchor(data, fromIndex);
      if (from) {
        originX = from.x;
        originZ = from.z;
      }
    }
    const x = originX + forwardX * child.along - forwardZ * child.across;
    const z = originZ + forwardZ * child.along + forwardX * child.across;
    const ground = Math.max(ctx.terrain.groundHeight(x, z), ctx.terrain.waterLevel);
    const remaining = data.remaining + 60;
    const id = ctx.spawns.activate(child.presetId, {
      position: { x, y: ground + child.up, z },
      heading: ((heading / DEG) % 360 + 360) % 360,
      source: data.source,
      seed: child.seed,
      duration: child.duration ?? remaining,
      params: child.overrides,
      force: data.source === 'debug',
    });
    if (!id) {
      counts.refused++;
      data.refusals++;
      state[base] = CHILD_WAITING;
      state[base + 1] = data.plan.retrySeconds;
      return;
    }
    const parts = ctx.spawns.getParts(id);
    data.childIds[index] = id;
    data.childParts[index] = parts;
    data.childEngines[index] = parts.map((part) => ctx.spawns.registry.get(part.engine));
    state[base] = CHILD_ACTIVE;
    state[base + 2] = 0;
    state[base + 3] = ground + child.up;
    childBySpawn.set(id, { instance, child: index });
    counts.children++;
  }

  /** Ends child `index`: its instances' ended flag (the manager removes it on its next update). */
  function endChild(data, index) {
    const state = data.childState;
    const base = index * CHILD_STRIDE;
    if (state[base] === CHILD_WAITING) {
      state[base] = CHILD_ENDED;
      return;
    }
    if (state[base] !== CHILD_ACTIVE) return;
    const parts = data.childParts[index];
    if (parts) for (const part of parts) part.ended = true;
  }

  function emitNarration(instance, stage) {
    const data = instance.data;
    const narration = stage.narration;
    const target = narration.target >= 0 ? childAnchor(data, narration.target) : null;
    const point = target ?? instance.anchor;
    counts.narrations++;
    ctx.bus.emit('setPiece:narrate', {
      id: instance.id, presetId: instance.presetId, name: data.name, stage: stage.id, text: narration.text,
      position: { x: point.x, y: point.y, z: point.z }, priority: data.plan.priority, ttl: data.plan.ttl,
    });
  }

  function enterStage(instance, index) {
    const data = instance.data;
    const stage = data.plan.stages[index];
    data.stageIndex = index;
    data.running = true;
    data.stageClock[0] = 0;
    data.stageClock[1] = 0;
    data.narrated = stage.narration === null;
    data.stagesRun++;
    counts.stages++;
    for (const child of stage.end) endChild(data, child);
    for (const child of stage.start) startChild(instance, child);
    // What is left of the timeline bounds the children's own lifetimes.
    let remaining = 0;
    for (let later = index; later < data.plan.stages.length; later++) remaining += Number.isFinite(data.plan.stages[later].duration) ? data.plan.stages[later].duration : 600;
    data.remaining = remaining;
    ctx.bus.emit('setPiece:stage', { id: instance.id, presetId: instance.presetId, stage: stage.id, index, marker: stage.marker });
    if (!data.narrated && stage.narration.delay === 0) {
      emitNarration(instance, stage);
      data.narrated = true;
    }
  }

  /** Advances to the next stage that may run, or ends the set piece. */
  function nextStage(instance) {
    const data = instance.data;
    const next = data.stageIndex + 1;
    if (next >= data.plan.stages.length) {
      finish(instance, true);
      return;
    }
    data.stageIndex = next;
    data.running = false;
    data.stageClock[0] = 0;
    data.stageClock[1] = 0;
    if (data.plan.stages[next].when === null) enterStage(instance, next);
  }

  function finish(instance, completed) {
    const data = instance.data;
    if (data.finished) return;
    data.finished = true;
    data.running = false;
    for (let index = 0; index < data.plan.children.length; index++) endChild(data, index);
    const records = {};
    data.plan.records.forEach((record, index) => {
      const value = data.recordValues[index];
      records[record.id] = Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    });
    ctx.bus.emit('setPiece:ended', { id: instance.id, presetId: instance.presetId, completed, stagesRun: data.stagesRun, records });
    sendJournalStats(instance, completed);
    instance.ended = true;
  }

  /**
   * The timeline's journal statistics (typed 'journalStat'): a stat tied to a record sends when that
   * record measured something within its `max` (its own value, or the record's when it has none); a
   * stat without a record sends its value only when the timeline completed.
   */
  function sendJournalStats(instance, completed) {
    const data = instance.data;
    for (const stat of data.plan.journal) {
      let value = stat.value;
      if (stat.record >= 0) {
        const measured = data.recordValues[stat.record];
        if (!Number.isFinite(measured) || measured > stat.max) continue;
        if (value === null) value = Math.round(measured * 10) / 10;
      } else if (!completed) {
        continue;
      }
      if (typeof ctx.bus.emitTyped === 'function') ctx.bus.emitTyped('journalStat', { key: stat.key, value, op: stat.op, presetId: instance.presetId });
    }
  }

  /** True when a condition set holds now (allocation-free). */
  function conditionsHold(instance, set, stageTime) {
    const all = set.all;
    const conditions = set.conditions;
    for (let index = 0; index < conditions.length; index++) {
      const holds = conditionHolds(instance, conditions[index], stageTime);
      if (all && !holds) return false;
      if (!all && holds) return true;
    }
    return all;
  }

  function conditionHolds(instance, condition, stageTime) {
    const data = instance.data;
    const player = ctx.state.player.position;
    switch (condition.kind) {
      case 0:
        return stageTime >= condition.value;
      case 1: {
        const target = condition.child >= 0 ? childAnchor(data, condition.child) : instance.anchor;
        if (!target) return false;
        const dx = player.x - target.x;
        const dz = player.z - target.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        return distance >= condition.min && distance <= condition.max;
      }
      case 2: {
        const altitude = condition.agl ? ctx.state.player.agl : player.y;
        return altitude >= condition.min && altitude <= condition.max;
      }
      case 3:
        return condition.weather.includes(weather);
      case 4:
        return data.childState[condition.child * CHILD_STRIDE] === CHILD_ENDED;
      default:
        return data.childState[condition.child * CHILD_STRIDE] === CHILD_ACTIVE;
    }
  }

  function applyRamps(instance, stage, dt) {
    const data = instance.data;
    const clock = data.stageClock;
    clock[1] -= dt;
    const callsDue = clock[1] <= 0;
    if (callsDue) clock[1] = 1 / RAMP_CALLS_PER_SECOND;
    const ramps = stage.ramps;
    for (let index = 0; index < ramps.length; index++) {
      const ramp = ramps[index];
      const parts = data.childParts[ramp.child];
      if (!parts) continue;
      const t = clock[0] >= ramp.over ? 1 : clock[0] / ramp.over;
      const value = ramp.from + (ramp.to - ramp.from) * ease(ramp.ease, t);
      const engines = data.childEngines[ramp.child];
      for (let part = 0; part < parts.length; part++) {
        const instanceParams = parts[part].params;
        if (instanceParams !== null && typeof instanceParams === 'object' && typeof instanceParams[ramp.param] === 'number') {
          instanceParams[ramp.param] = value;
        } else if (callsDue && engines[part] && typeof engines[part].setParam === 'function') {
          counts.rampCalls++;
          if (!engines[part].setParam(parts[part], ramp.param, value)) data.unsupported++;
        } else if (callsDue) {
          data.unsupported++;
        }
      }
    }
  }

  function trackChildren(instance, dt) {
    const data = instance.data;
    const children = data.plan.children;
    const state = data.childState;
    for (let index = 0; index < children.length; index++) {
      const track = children[index].track;
      if (track === null || state[index * CHILD_STRIDE] !== CHILD_ACTIVE) continue;
      const parts = data.childParts[index];
      if (!parts) continue;
      const base = index * CHILD_STRIDE;
      state[base + 4] += dt;
      const heading = (data.heading + children[index].headingOffset + track.headingOffset + track.wander * Math.sin(state[base + 4] * 0.05 + children[index].wanderPhase)) * DEG;
      const stepX = Math.sin(heading) * track.speed * dt;
      const stepZ = -Math.cos(heading) * track.speed * dt;
      const anchor = parts[0].anchor;
      if (track.followGround) {
        state[base + 2] -= dt;
        if (state[base + 2] <= 0) {
          state[base + 2] = TRACK_GROUND_SECONDS;
          // Whole metres: small integers reach the height function without being boxed.
          state[base + 3] = Math.max(ctx.terrain.groundHeight(Math.round(anchor.x), Math.round(anchor.z)), ctx.terrain.waterLevel) + children[index].up;
        }
      }
      for (let part = 0; part < parts.length; part++) {
        const partAnchor = parts[part].anchor;
        partAnchor.x += stepX;
        partAnchor.z += stepZ;
        if (track.followGround) partAnchor.y += (state[base + 3] - partAnchor.y) * Math.min(1, dt * 2);
      }
    }
  }

  function measureRecords(instance, dt) {
    const data = instance.data;
    const records = data.plan.records;
    const player = ctx.state.player.position;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const target = record.child >= 0 ? childAnchor(data, record.child) : instance.anchor;
      if (!target) continue;
      const dx = player.x - target.x;
      const dy = player.y - target.y;
      const dz = player.z - target.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (record.measure === 'closestDistance') {
        if (!(distance >= data.recordValues[index])) data.recordValues[index] = distance;
      } else if (distance <= record.radius) {
        data.recordValues[index] += dt;
      }
    }
  }

  function retryChildren(instance, dt) {
    const data = instance.data;
    const state = data.childState;
    for (let index = 0; index < data.plan.children.length; index++) {
      const base = index * CHILD_STRIDE;
      if (state[base] !== CHILD_WAITING) continue;
      state[base + 1] -= dt;
      if (state[base + 1] <= 0) startChild(instance, index);
    }
  }

  const engine = {
    name: ENGINE_NAME,
    init(engineCtx) {
      ctx = engineCtx;
      if (!ctx.spawns) throw new Error('[DRIFTWING] the setPiece engine needs the spawn manager (ctx.spawns)');
      ctx.bus.onTyped('spawnEnded', onSpawnEnded);
      ctx.bus.onTyped('weatherChanged', onWeatherChanged);
    },

    create(preset, params, rng) {
      const plan = readTimeline(preset, params, rng, ctx.spawns);
      const data = {
        plan,
        name: preset.name,
        source: params.source === 'site' ? 'director' : params.source ?? 'director',
        heading: Number.isFinite(params.heading) ? params.heading : 0,
        stageIndex: -1,
        running: false,
        finished: false,
        narrated: true,
        stagesRun: 0,
        refusals: 0,
        unsupported: 0,
        remaining: 0,
        /** [seconds into the stage (or waiting for it), seconds to the next setParam ramp call]. */
        stageClock: new Float64Array(2),
        childState: new Float64Array(plan.children.length * CHILD_STRIDE),
        childIds: plan.children.map(() => null),
        childParts: plan.children.map(() => null),
        childEngines: plan.children.map(() => null),
        recordValues: new Float64Array(plan.records.length),
      };
      plan.records.forEach((record, index) => {
        data.recordValues[index] = record.measure === 'closestDistance' ? Infinity : 0;
      });
      for (let index = 0; index < plan.children.length; index++) data.childState[index * CHILD_STRIDE] = CHILD_IDLE;
      const instance = { anchor: params.position, radius: plan.radius, windSourceIds: [], lights: 0, particles: 0, data };
      live.push(instance);
      counts.instances++;
      return instance;
    },

    update(instance, dt) {
      const data = instance.data;
      if (data.finished) return;
      // The first stage starts on the first frame, once the manager has given the set piece its id.
      if (data.stageIndex < 0) {
        data.stageIndex = -1;
        nextStage(instance);
        if (data.finished) return;
      }
      const stage = data.plan.stages[data.stageIndex];
      const clock = data.stageClock;
      clock[0] += dt;
      if (!data.running) {
        if (conditionsHold(instance, stage.when, clock[0])) enterStage(instance, data.stageIndex);
        else if (clock[0] >= stage.whenTimeout) nextStage(instance);
        return;
      }
      retryChildren(instance, dt);
      trackChildren(instance, dt);
      applyRamps(instance, stage, dt);
      measureRecords(instance, dt);
      if (!data.narrated && clock[0] >= stage.narration.delay) {
        emitNarration(instance, stage);
        data.narrated = true;
      }
      if (clock[0] >= stage.duration || (stage.until !== null && conditionsHold(instance, stage.until, clock[0]))) nextStage(instance);
    },

    setLOD(instance, tier) {
      instance.tier = tier;
    },

    dispose(instance) {
      const data = instance.data;
      // A set piece ended early (despawned, removed) still reports what it measured.
      if (!data.finished && data.stagesRun > 0) finish(instance, false);
      for (let index = 0; index < data.plan.children.length; index++) {
        endChild(data, index);
        const id = data.childIds[index];
        if (id && childBySpawn.has(id)) {
          childBySpawn.delete(id);
          counts.children--;
        }
      }
      const index = live.indexOf(instance);
      if (index >= 0) {
        live.splice(index, 1);
        counts.instances--;
      }
    },

    stats() {
      return {
        instances: counts.instances,
        particles: 0,
        lights: 0,
        buffers: 0,
        drawCalls: 0,
        children: counts.children,
        stagesEntered: counts.stages,
        narrations: counts.narrations,
        refusedChildren: counts.refused,
        rampCalls: counts.rampCalls,
      };
    },

    /** The timeline state of a set piece, for the debugger and tests. */
    describe(instance) {
      const data = instance.data;
      const stage = data.plan.stages[data.stageIndex] ?? null;
      return {
        stage: stage ? stage.id : null,
        running: data.running,
        stageTime: Math.round(data.stageClock[0] * 10) / 10,
        stagesRun: data.stagesRun,
        finished: data.finished,
        children: data.plan.children.map((child, index) => ({
          key: child.key,
          presetId: child.presetId,
          id: data.childIds[index],
          status: ['idle', 'waiting', 'active', 'ended'][data.childState[index * CHILD_STRIDE]],
        })),
        records: Object.fromEntries(data.plan.records.map((record, index) => [record.id, data.recordValues[index]])),
        refusals: data.refusals,
        unsupportedRamps: data.unsupported,
        weather,
      };
    },
  };
  return engine;
}

/** Validates a set-piece timeline without a running game (the labs and the preset tests). */
export function validateTimeline(preset, params, presetIds = null, random = () => 0.5) {
  const manager = presetIds ? { getPreset: (id) => (presetIds.includes(id) ? { id } : null) } : null;
  return readTimeline(preset, params, random, manager);
}
