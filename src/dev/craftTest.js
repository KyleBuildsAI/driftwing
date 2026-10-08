// Craft test (?test=craft, dev builds only; main.js never loads it in production). Phase 3 contract
// k.1: every registered craft flies the general flight test in the first and third person views,
// then every scenario its craft's file in src/dev/craftScenarios/ lists (index.js has the shape).
//
// A run switches the craft through the settings channel (as the picker does) at 100 % assists (a
// scenario may set its own), picks the view through settings.views (first person: the 'cockpit'
// slot, the FPV camera on the drone; third person: 'chase'), sets the time of day when the scenario
// asks, places the craft with flight.startAt (the same placements a module's situate returns:
// start.at finds the place, start.mode the state), then calls the script every frame for `seconds`
// of flight time. A script returns ControlState fields (roll, pitch, yaw, throttle, collective,
// brakeL, brakeR, flaps, trim, antenna, lookX, lookY) that override the live controls after the input
// system and before flight (the test input path), plus `actions` (one press each) and `held` (held
// while listed). Real gamepads are hidden behind an empty mock for the whole test.
//
// Measured per run (each a pass criterion): the craft and view as planned on every frame; NaN (a
// non-finite pose or telemetry, the flight guard's restores, core's frame guard); terrain or water
// penetrations deeper than PENETRATION_LIMIT_M; soft crashes (unless the scenario sets allowCrash);
// console errors and warnings; every check. A check passes when test(api) holds at least once
// between `from` (default 0) and `until` (default the run length) seconds, or on every frame of that
// window with `always: true`. Frame times are reported, not judged (the owner's rule on machine load).
//
// The general flight test (one per craft and view, generalSpec): the craft starts as its file's
// general.start says (default: above the world's spawn point, 'air' 500 m above the ground, or 'hover'
// 80 m up for a hovering craft, so every run starts from the same place; and 250 m above the highest
// ground it could reach at its cruise during the run, since it flies hands off), flies hands off,
// then gives a roll pulse right, a roll pulse left (so a craft without auto-level ends near wings
// level) and a gentle pull, each general.pulse seconds long (1.5 s) at general.stick of full
// deflection (0.4 by default; the pull at half of it); it must respond (roll, pitch or heading moves 5 degrees from where
// the manual inputs began) and fly (10 m from the start, 5 m up or down, or faster than 2 m/s over
// the ground: a hovering craft may hold its place).
//
// Scenarios on another seed or world (seed, world: 'waters' for the water fixtures' lakes) run on
// their own page load: the test reloads with the seed in the URL and carries its progress, results
// and console log in sessionStorage (SESSION_KEY). Settings live in an isolated IndexedDB database.
//
// URL options: testCraft=a,b  testViews=first,third  testScenarios=id,general-glider  testSeconds=30
// (the general test's length). Output: the summary panel and window.DRIFTWING.testReport for
// tools/run-harness.mjs --test craft.
import { installConsoleCapture } from './testConsole.js';
import { installMockGamepads } from './mockGamepads.js';
import { createTestPanel } from './testPanel.js';
import { createFrameRecorder, readSession, round, writeSession } from './testStats.js';
import { CRAFT_SCENARIO_SETS } from './craftScenarios/index.js';
import { WATER_FIXTURES } from './waterFixtures.js';
import { craftRegistry } from '../craft/index.js';
import { EVENT_TYPES } from '../core/events.js';
import { headingFromVector, isFiniteQuaternion, isFiniteVector, wrapDegrees } from '../core/util.js';

export const TEST_DATABASE = 'driftwing-v2-test-craft';
const SESSION_KEY = 'driftwing-v2.test.craft';
const REPORT_KIND = 'driftwing-craft-test';
const REPORT_VERSION = 1;
const DEFAULT_SEED = 'CRAFT-1';
/** The view dimension, in plan order, and the settings.views slot each is flown from. */
const VIEWS = Object.freeze(['third', 'first']);
const VIEW_SLOTS = Object.freeze({ third: 'chase', first: 'cockpit' });
const WORLDS = Object.freeze(['game', 'waters']);
const START_MODES = Object.freeze(['air', 'ground', 'water', 'hover', 'drift', 'climb', 'perch']);
const START_PLACES = Object.freeze(['here', 'spawn', 'ocean', 'lake', 'thermal', 'slope', 'perch']);
/** ControlState fields a script may set. */
const SCRIPT_AXES = Object.freeze(['roll', 'pitch', 'yaw', 'throttle', 'collective', 'brakeL', 'brakeR', 'flaps', 'trim', 'antenna', 'lookX', 'lookY']);
const GENERAL_SECONDS = 30;
const GENERAL_STICK = 0.4;
/** The general test's stick pulses: when each starts (share of the run) and how long it lasts (s). */
const GENERAL_PULSE_SECONDS = 1.5;
const GENERAL_PULSES = Object.freeze({ rollRight: 0.2, rollLeft: 0.45, pull: 0.7 });
/** After ready and on every page load: frames must flow (WebGPU's cold pipeline compile stalls the page), then a warmup. */
const FRAMES_FLOWING = 20;
const FLOW_WINDOW_MS = 1000;
const WORLD_WARMUP_SECONDS = 5;
/** Frames after a craft switch and after the placement before the run's clock starts. */
const SETTLE_FRAMES = 3;
const PENETRATION_LIMIT_M = 1;
/** A run that has not reached its length after this many wall seconds past it is cut short (a stalled page). */
const RUN_WALL_MARGIN_SECONDS = 120;
const MAX_CONSOLE_ENTRIES = 300;
const MAX_DETAILS = 20;
/** Where the start places are searched (m around the craft). */
const OCEAN_SEARCH = Object.freeze({ radius: 40000, step: 500, angles: 16, minDepth: 15 });
const LAKE_SEARCH_RADIUS = 60000;
const THERMAL_RING = Object.freeze({ radius: 6000, samples: 8, minStrength: 1 });
const SLOPE_SEARCH = Object.freeze({ radius: 20000, step: 400, angles: 16, minGrade: 0.25, maxGrade: 1, minHeight: 60, probe: 20 });
const PERCH_SEARCH_RADIUS = 30000;
/** start.clearRadius: the highest ground within it is sampled on this grid (m) and cleared by start.clearance. */
const CLEAR_STEP = 250;
const DEFAULT_CLEARANCE = 250;
/** The general test keeps clear of the ground this far around its start: the craft's cruise for the run, with a margin. */
const GENERAL_CLEAR_FACTOR = 1.2;
const GENERAL_HOVER_CLEAR_RADIUS = 300;
const MAX_CLEAR_RADIUS = 12000;

/** One problem with a scenario set, or '' when it can run. */
function scenarioProblem(set, scenario, seenIds) {
  if (!scenario || typeof scenario.id !== 'string' || !/^[a-z][A-Za-z0-9-]{1,63}$/.test(scenario.id)) return 'a scenario needs an id (letters, digits, dashes)';
  if (seenIds.has(scenario.id) || scenario.id.startsWith('general-')) return `scenario id "${scenario.id}" is taken`;
  if (scenario.craft !== undefined && scenario.craft !== set.craft) return `scenario "${scenario.id}" names craft "${scenario.craft}" in the ${set.craft} file`;
  if (!(Number.isFinite(scenario.seconds) && scenario.seconds > 0 && scenario.seconds <= 900)) return `scenario "${scenario.id}" needs seconds in (0, 900]`;
  if (!scenario.start || typeof scenario.start !== 'object') return `scenario "${scenario.id}" needs a start`;
  const at = scenario.start.at ?? 'here';
  if (typeof at === 'string' ? !START_PLACES.includes(at) : !(Number.isFinite(at.x) && Number.isFinite(at.z))) return `scenario "${scenario.id}" start.at must be one of ${START_PLACES.join(', ')} or { x, y?, z }`;
  if (scenario.start.mode !== undefined && !START_MODES.includes(scenario.start.mode)) return `scenario "${scenario.id}" start.mode must be one of ${START_MODES.join(', ')}`;
  if (scenario.world !== undefined && !WORLDS.includes(scenario.world)) return `scenario "${scenario.id}" world must be one of ${WORLDS.join(', ')}`;
  if (scenario.script !== undefined && typeof scenario.script !== 'function') return `scenario "${scenario.id}" script must be a function`;
  if (!Array.isArray(scenario.checks) || scenario.checks.some((check) => !check || typeof check.id !== 'string' || typeof check.test !== 'function')) return `scenario "${scenario.id}" needs checks [{ id, test(api) }]`;
  if (scenario.views !== undefined && (!Array.isArray(scenario.views) || scenario.views.some((view) => !VIEWS.includes(view)))) return `scenario "${scenario.id}" views must list first and / or third`;
  return '';
}

/** The scenario sets as { byCraft, scenarios: Map(id -> { set, scenario }), problems }. */
function indexScenarios() {
  const byCraft = new Map();
  const scenarios = new Map();
  const problems = [];
  for (const set of CRAFT_SCENARIO_SETS) {
    if (!set || !craftRegistry.entry(set.craft)) {
      problems.push(`a scenario set names "${set && set.craft}", which is not in the craft catalog`);
      continue;
    }
    byCraft.set(set.craft, set);
    for (const scenario of set.scenarios ?? []) {
      const problem = scenarioProblem(set, scenario, scenarios);
      if (problem) problems.push(problem);
      else scenarios.set(scenario.id, { set, scenario });
    }
  }
  return { byCraft, scenarios, problems };
}

/** Reads the URL options; unknown craft, views and scenarios are dropped (and reported). */
function readConfig(params, index) {
  const notes = [];
  const listParam = (name) => (params.get(name) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const registered = craftRegistry.list().filter((entry) => entry.available).map((entry) => entry.id);
  let crafts = listParam('testCraft').filter((craft) => {
    const known = registered.includes(craft);
    if (!known) notes.push(`testCraft "${craft}" is not a registered craft and was ignored`);
    return known;
  });
  if (crafts.length === 0) crafts = registered.slice();
  let views = listParam('testViews').filter((view) => {
    const known = VIEWS.includes(view);
    if (!known) notes.push(`testViews "${view}" is not a view (first or third) and was ignored`);
    return known;
  });
  if (views.length === 0) views = VIEWS.slice();
  const scenarioIds = listParam('testScenarios').filter((id) => {
    const known = index.scenarios.has(id) || /^general(-[a-z][A-Za-z0-9]*)?$/.test(id);
    if (!known) notes.push(`testScenarios "${id}" is not a scenario and was ignored`);
    return known;
  });
  const requestedSeconds = Number.parseFloat(params.get('testSeconds'));
  const generalSeconds = Number.isFinite(requestedSeconds) && requestedSeconds >= 5 ? Math.min(requestedSeconds, 600) : GENERAL_SECONDS;
  if (params.has('testSeconds') && generalSeconds !== requestedSeconds) notes.push(`testSeconds ${params.get('testSeconds')} is outside 5-600 s; using ${generalSeconds} s`);
  const seed = (params.get('seed') ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').slice(0, 24) || DEFAULT_SEED;
  return { crafts: registered.filter((craft) => crafts.includes(craft)), views: VIEWS.filter((view) => views.includes(view)), scenarioIds, generalSeconds, seed, notes };
}

/** True when the run filter (testScenarios) keeps a run id. */
function wanted(config, id, craft) {
  if (config.scenarioIds.length === 0) return true;
  return config.scenarioIds.includes(id) || (id.startsWith('general-') && config.scenarioIds.includes('general')) || (id === `general-${craft}` && config.scenarioIds.includes(id));
}

/**
 * The runs in order: the general test of every craft in every view on the default seed, then every
 * scenario in its views; runs on the same seed and world are kept together (one page load each).
 */
function buildPlan(config, index) {
  const runs = [];
  for (const craft of config.crafts) {
    const id = `general-${craft}`;
    if (!wanted(config, id, craft)) continue;
    for (const view of config.views) runs.push({ id, kind: 'general', craft, view, seed: config.seed, world: 'game' });
  }
  for (const [id, { set, scenario }] of index.scenarios) {
    if (!config.crafts.includes(set.craft) || !wanted(config, id, set.craft)) continue;
    const views = (scenario.views ?? VIEWS).filter((view) => config.views.includes(view));
    const seed = typeof scenario.seed === 'string' && scenario.seed ? scenario.seed.toUpperCase() : config.seed;
    for (const view of views) runs.push({ id, kind: 'scenario', craft: set.craft, view, seed, world: scenario.world ?? 'game' });
  }
  const groups = [];
  for (const run of runs) {
    const key = `${run.seed}|${run.world}`;
    if (!groups.includes(key)) groups.push(key);
  }
  const ordered = groups.flatMap((key) => runs.filter((run) => `${run.seed}|${run.world}` === key));
  return ordered.map((run, position) => ({ index: position, ...run }));
}

function newSessionId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Called by main.js at the very start of boot (dev builds with ?test=craft). Installs the console
 * capture and the gamepad mock at once; the water fixtures replace the presets on a 'waters' world.
 */
export function prepareCraftTest({ params }) {
  const listeners = { entry: null };
  const capture = installConsoleCapture({ onEntry: (entry) => listeners.entry?.(entry) });
  installMockGamepads();
  const world = params.get('testWorld') === 'waters' ? 'waters' : 'game';
  return {
    databaseName: TEST_DATABASE,
    ...(world === 'waters' ? { worldPresets: WATER_FIXTURES } : {}),
    createSystem: (ctx) => createCraftTestSystem(ctx, { params, capture, listeners, world }),
  };
}

function createCraftTestSystem(ctx, { params, capture, listeners, world: pageWorld }) {
  const { state, bus, settings, world } = ctx;
  const panel = createTestPanel({ title: 'Craft test' });
  const index = indexScenarios();

  // ---- Session (progress across reloads) -----------------------------------------------------
  const stored = readSession(SESSION_KEY);
  const requestedSession = params.get('testSession');
  let session = stored.value;
  if (!session || session.kind !== REPORT_KIND || !requestedSession || session.id !== requestedSession) {
    const config = readConfig(params, index);
    session = {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      id: newSessionId(),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      config,
      plan: buildPlan(config, index),
      nextRun: 0,
      runs: [],
      console: [],
      consoleCounts: { errors: 0, warnings: 0 },
      harnessErrors: [...index.problems, ...(stored.error ? [stored.error] : [])],
      fresh: true,
    };
  }
  const plan = session.plan;
  const config = session.config;
  let phase = 'loading';
  let step = '';
  let activeRun = null;
  const frameWaiters = [];
  const report = {};

  // Console entries: booked to the run in flight, else counted for the page.
  const pendingConsole = [...capture.entries];
  listeners.entry = (entry) => {
    pendingConsole.push(entry);
    if (activeRun) {
      if (entry.level === 'error') activeRun.bucket.consoleErrors++;
      else activeRun.bucket.consoleWarnings++;
    }
  };

  function saveSession() {
    const error = writeSession(SESSION_KEY, session);
    if (error) {
      session.harnessErrors.push(error);
      console.error(`[DRIFTWING test] ${error}`);
    }
  }

  function flushConsole() {
    for (const entry of pendingConsole) {
      if (entry.level === 'error') session.consoleCounts.errors++;
      else session.consoleCounts.warnings++;
      if (session.console.length < MAX_CONSOLE_ENTRIES) session.console.push({ ...entry, seed: state.seed });
    }
    pendingConsole.length = 0;
  }

  function urlFor(seed, worldId, sessionId) {
    const url = new URL(window.location.href);
    if (seed) url.searchParams.set('seed', seed);
    else url.searchParams.delete('seed');
    if (worldId && worldId !== 'game') url.searchParams.set('testWorld', worldId);
    else url.searchParams.delete('testWorld');
    if (sessionId) url.searchParams.set('testSession', sessionId);
    else url.searchParams.delete('testSession');
    return url.href;
  }

  // ---- Events (every typed event, counted per run for the checks) ---------------------------------
  const eventLog = new Map();
  for (const type of Object.keys(EVENT_TYPES)) {
    bus.onTyped(type, (payload) => {
      if (!activeRun) return;
      const entry = eventLog.get(type) ?? { count: 0, last: null };
      entry.count++;
      entry.last = payload;
      eventLog.set(type, entry);
      if (type === 'softCrash' && activeRun.bucket.softCrashes.length < MAX_DETAILS) {
        activeRun.bucket.softCrashes.push({ at: round(activeRun.t, 2), reason: payload.reason, impactSpeed: round(payload.impactSpeed, 1) });
      }
    });
  }
  bus.on('safety:nonFinite', () => {
    if (activeRun) activeRun.bucket.nanGuardEvents++;
  });

  // ---- Frames ------------------------------------------------------------------------------------
  function nextFrame() {
    return new Promise((resolve) => { frameWaiters.push(resolve); });
  }
  async function waitFrames(count) {
    for (let frame = 0; frame < count; frame++) await nextFrame();
  }
  async function waitWallSeconds(seconds) {
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) await nextFrame();
  }
  /** Waits until FRAMES_FLOWING frames arrive within FLOW_WINDOW_MS (the cold pipeline compile has passed). */
  async function waitForFramesToFlow() {
    const stamps = [];
    for (;;) {
      await nextFrame();
      stamps.push(performance.now());
      if (stamps.length > FRAMES_FLOWING) stamps.shift();
      if (stamps.length === FRAMES_FLOWING && stamps[stamps.length - 1] - stamps[0] <= FLOW_WINDOW_MS) return;
    }
  }

  const flight = () => ctx.systems.flight;
  const camera = () => ctx.systems.camera;
  const waterAt = (x, z) => (ctx.waterQuery ? ctx.waterQuery.heightAt(x, z) : world.WATER_LEVEL);
  const surfaceAt = (x, z) => Math.max(world.groundHeight(x, z), waterAt(x, z));

  // ---- Specs: the general test and the scenarios ---------------------------------------------------
  /** The general flight test for a craft (its file's general block tunes it). */
  function generalSpec(craftId) {
    const module = craftRegistry.get(craftId);
    const general = index.byCraft.get(craftId)?.general ?? {};
    const hover = Boolean(module && module.spawn && module.spawn.hover);
    const seconds = Number.isFinite(general.seconds) ? general.seconds : config.generalSeconds;
    const stick = Number.isFinite(general.stick) ? general.stick : GENERAL_STICK;
    const pulse = Number.isFinite(general.pulse) ? general.pulse : GENERAL_PULSE_SECONDS;
    const within = (t, share) => t >= seconds * share && t < seconds * share + pulse;
    const engine = module && module.inputProfile && module.inputProfile.throttle !== 'none';
    const throttle = Number.isFinite(general.throttle) ? general.throttle : !engine ? null : hover ? 0.5 : module.spawn.cruiseThrottle;
    return {
      id: `general-${craftId}`,
      seconds,
      start: general.start ?? {
        at: 'spawn',
        mode: hover ? 'hover' : 'air',
        agl: hover ? 80 : 500,
        clearRadius: hover ? GENERAL_HOVER_CLEAR_RADIUS : Math.min(MAX_CLEAR_RADIUS, module.spawn.cruise * seconds * GENERAL_CLEAR_FACTOR),
      },
      script(t) {
        const controls = { roll: 0, pitch: 0, yaw: 0 };
        if (Number.isFinite(throttle)) controls.throttle = throttle;
        if (within(t, GENERAL_PULSES.rollRight)) controls.roll = stick;
        else if (within(t, GENERAL_PULSES.rollLeft)) controls.roll = -stick;
        else if (within(t, GENERAL_PULSES.pull)) controls.pitch = stick * 0.5;
        return controls;
      },
      checks: [
        {
          id: 'responds',
          label: 'responds to the stick (roll, pitch or heading moves 5 degrees)',
          from: seconds * 0.2,
          until: seconds * 0.95,
          test(api) {
            const memo = api.memo;
            if (!memo.baseline) memo.baseline = { roll: api.flight.roll, pitch: api.flight.pitch, heading: api.flight.heading };
            const base = memo.baseline;
            return Math.abs(api.flight.roll - base.roll) > 5 || Math.abs(api.flight.pitch - base.pitch) > 5 || Math.abs(wrapDegrees(api.flight.heading - base.heading + 180) - 180) > 5;
          },
        },
        { id: 'flies', label: 'flies (10 m from the start, 5 m up or down, or faster than 2 m/s over the ground)', test: (api) => api.distanceFromStart() > 10 || Math.abs(api.flight.altitude - api.start.y) > 5 || api.flight.groundSpeed > 2 },
      ],
    };
  }

  function specFor(entry) {
    if (entry.kind === 'general') return generalSpec(entry.craft);
    return index.scenarios.get(entry.id)?.scenario ?? null;
  }

  // ---- Start places ------------------------------------------------------------------------------
  function findOcean(origin) {
    const query = ctx.waterQuery;
    if (!query) return null;
    for (let radius = 0; radius <= OCEAN_SEARCH.radius; radius += OCEAN_SEARCH.step) {
      const samples = radius === 0 ? 1 : OCEAN_SEARCH.angles;
      for (let sample = 0; sample < samples; sample++) {
        const angle = (sample / samples) * Math.PI * 2;
        const x = origin.x + Math.sin(angle) * radius;
        const z = origin.z - Math.cos(angle) * radius;
        if (query.isOcean(x, z) && world.groundHeight(x, z) < query.seaLevel - OCEAN_SEARCH.minDepth) return { x, z };
      }
    }
    return null;
  }

  function findLake(origin) {
    let found = null;
    world.waterBodiesNear?.(origin.x, origin.z, LAKE_SEARCH_RADIUS, (record) => {
      if (!found && (record.kind === 'lake' || record.kind === 'pool') && record.material === 'water') found = { x: record.x, z: record.z, y: record.level };
    });
    return found;
  }

  function findThermal(origin) {
    const wind = ctx.wind;
    if (!wind || typeof wind.nearestThermal !== 'function') return null;
    let best = wind.nearestThermal(origin, THERMAL_RING.minStrength);
    for (let sample = 0; !best && sample < THERMAL_RING.samples; sample++) {
      const angle = (sample / THERMAL_RING.samples) * Math.PI * 2;
      best = wind.nearestThermal({ x: origin.x + Math.sin(angle) * THERMAL_RING.radius, y: origin.y, z: origin.z - Math.cos(angle) * THERMAL_RING.radius }, THERMAL_RING.minStrength);
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  function findSlope(origin) {
    const probe = SLOPE_SEARCH.probe;
    for (let radius = 0; radius <= SLOPE_SEARCH.radius; radius += SLOPE_SEARCH.step) {
      const samples = radius === 0 ? 1 : SLOPE_SEARCH.angles;
      for (let sample = 0; sample < samples; sample++) {
        const angle = (sample / samples) * Math.PI * 2;
        const x = origin.x + Math.sin(angle) * radius;
        const z = origin.z - Math.cos(angle) * radius;
        const height = world.groundHeight(x, z);
        if (height < waterAt(x, z) + SLOPE_SEARCH.minHeight) continue;
        const gradientX = (world.groundHeight(x + probe, z) - world.groundHeight(x - probe, z)) / (2 * probe);
        const gradientZ = (world.groundHeight(x, z + probe) - world.groundHeight(x, z - probe)) / (2 * probe);
        const grade = Math.hypot(gradientX, gradientZ);
        if (grade >= SLOPE_SEARCH.minGrade && grade <= SLOPE_SEARCH.maxGrade) return { x, z, heading: headingFromVector(-gradientX, -gradientZ) };
      }
    }
    return null;
  }

  function findPerch(origin) {
    let best = null;
    ctx.colliders?.perchesNear?.(origin.x, origin.y, origin.z, PERCH_SEARCH_RADIUS, (x, y, z, kind, sourceId) => {
      const distance = Math.hypot(x - origin.x, z - origin.z);
      if (!best || distance < best.distance) best = { x, y, z, kind, sourceId, distance };
    });
    return best;
  }

  /** The highest ground or water surface within radius of (x, z), on a CLEAR_STEP grid. */
  function highestSurface(x, z, radius) {
    let highest = surfaceAt(x, z);
    for (let offsetX = -radius; offsetX <= radius; offsetX += CLEAR_STEP) {
      for (let offsetZ = -radius; offsetZ <= radius; offsetZ += CLEAR_STEP) {
        if (offsetX * offsetX + offsetZ * offsetZ <= radius * radius) highest = Math.max(highest, surfaceAt(x + offsetX, z + offsetZ));
      }
    }
    return highest;
  }

  /** The placement for a start (flight.startAt) and the resolved start point. Throws when the place is not found. */
  function resolveStart(start) {
    const origin = state.player.position;
    const at = start.at ?? 'here';
    const mode = start.mode ?? 'air';
    let x = origin.x;
    let z = origin.z;
    let y = null;
    let heading = Number.isFinite(start.heading) ? start.heading : state.player.heading;
    let place = null;
    if (typeof at === 'object') place = { x: at.x, z: at.z, y: Number.isFinite(at.y) ? at.y : null };
    else if (at === 'spawn') place = { x: state.spawn.x, z: state.spawn.z };
    else if (at === 'ocean') place = findOcean(origin);
    else if (at === 'lake') place = findLake(origin);
    else if (at === 'thermal') place = findThermal(origin);
    else if (at === 'slope') place = findSlope(origin);
    else if (at === 'perch') place = findPerch(origin);
    if (at !== 'here') {
      if (!place) throw new Error(`no ${typeof at === 'string' ? at : 'start point'} found near ${Math.round(origin.x)}, ${Math.round(origin.z)}`);
      x = place.x;
      z = place.z;
      if (Number.isFinite(place.y)) y = place.y;
      if (!Number.isFinite(start.heading) && Number.isFinite(place.heading)) heading = place.heading;
    }
    const airborne = mode === 'air' || mode === 'climb' || mode === 'drift' || mode === 'hover';
    if (airborne && y === null) y = surfaceAt(x, z) + (Number.isFinite(start.agl) ? start.agl : mode === 'hover' ? 60 : 400);
    // clearRadius: high enough to clear every hill the craft could reach (start.clearance above it).
    if (airborne && Number.isFinite(start.clearRadius) && start.clearRadius > 0) {
      y = Math.max(y, highestSurface(x, z, start.clearRadius) + (Number.isFinite(start.clearance) ? start.clearance : DEFAULT_CLEARANCE));
    }
    if (y === null) y = surfaceAt(x, z);
    const placement = { mode, heading };
    // A ground start at 'here' looks for a flat spot near the craft; every other start is exact.
    if (!(mode === 'ground' && at === 'here')) placement.position = { x, y, z };
    for (const field of ['speed', 'pitch', 'throttle']) if (Number.isFinite(start[field])) placement[field] = start[field];
    if (start.craftState && typeof start.craftState === 'object') placement.craftState = start.craftState;
    if (start.flatSpot === true) placement.flatSpot = true;
    return { placement, point: { x, y, z, heading } };
  }

  // ---- Runs ----------------------------------------------------------------------------------------
  function inPlannedView(entry) {
    return camera().isFirstPerson() === (entry.view === 'first');
  }

  function createBucket() {
    return { nanFrames: 0, nanGuardEvents: 0, penetrations: 0, penetrationDetails: [], softCrashes: [], consoleErrors: 0, consoleWarnings: 0 };
  }

  /** What a script and its checks read (contract k.1 api). */
  function createApi(run) {
    const once = new Set();
    return {
      get t() { return run.t; },
      seconds: run.seconds,
      ctx,
      state,
      get flight() { return state.flight; },
      get craftState() { return state.flight.craftState; },
      get player() { return state.player; },
      get module() { return flight().getCraftModule(); },
      get controller() { return flight(); },
      world,
      waterQuery: ctx.waterQuery ?? null,
      colliders: ctx.colliders ?? null,
      wind: ctx.wind ?? null,
      controls: ctx.controls,
      /** Scratch space the scenario keeps across frames of this run. */
      memo: run.memo,
      /** The start point (world { x, y, z, heading }). */
      get start() { return run.start; },
      /** True the first time it is called with key in this run (one press of an action). */
      once(key) {
        if (once.has(key)) return false;
        once.add(key);
        return true;
      },
      events: {
        /** How many typed events of type arrived during this run, and the last payload. */
        count: (type) => eventLog.get(type)?.count ?? 0,
        last: (type) => eventLog.get(type)?.last ?? null,
      },
      surfaceHeight: surfaceAt,
      agl: () => state.player.position.y - surfaceAt(state.player.position.x, state.player.position.z),
      distanceFromStart: () => Math.hypot(state.player.position.x - run.start.x, state.player.position.z - run.start.z),
      /** Presses and releases any input action, as a device would (camera and UI actions included). */
      press(actionId) {
        bus.emit('input:action', { id: actionId, phase: 'press', source: 'test', device: 'test' });
        bus.emit('input:action', { id: actionId, phase: 'release', source: 'test', device: 'test' });
      },
    };
  }

  /** Switches the craft (settings channel), its assists and its view; returns { ok, notes }. */
  async function setUpRun(entry, spec) {
    const notes = [];
    flight().setAutopilot({ enabled: false, reason: 'craft test' });
    settings.update('assists', { [entry.craft]: Number.isFinite(spec.assists) ? spec.assists : 1 });
    if (flight().getCraft() !== entry.craft) settings.set('craft', entry.craft);
    settings.update('views', { [entry.craft]: VIEW_SLOTS[entry.view] });
    await waitFrames(SETTLE_FRAMES);
    const craftOk = flight().getCraft() === entry.craft;
    if (!craftOk) notes.push(`asked for ${entry.craft}, flying ${flight().getCraft()}`);
    const viewOk = inPlannedView(entry);
    if (!viewOk) notes.push(`asked for the ${entry.view}-person view, the camera shows ${camera().getView()}`);
    if (Number.isFinite(spec.time)) ctx.systems.sky.setDayTime(spec.time, { transition: 0 });
    return { ok: craftOk && viewOk, notes };
  }

  async function runEntry(entry) {
    const spec = specFor(entry);
    const label = `${entry.id}, ${entry.craft}, ${entry.view} person`;
    capture.setContext(`craft test: ${label}`);
    step = label;
    const result = {
      index: entry.index, id: entry.id, kind: entry.kind, craft: entry.craft, view: entry.view, seed: entry.seed, world: entry.world,
      backend: ctx.backend, startedAt: new Date().toISOString(), setupOk: false, notes: [], start: null, checks: [],
      cameraViews: [], viewMismatchFrames: 0, craftMismatchFrames: 0, frames: null, passed: false,
    };
    if (!spec) {
      result.notes.push('the scenario is no longer in its file');
      return finishResult(result, createBucket());
    }
    const setup = await setUpRun(entry, spec);
    result.setupOk = setup.ok;
    result.notes.push(...setup.notes);
    let start;
    try {
      start = resolveStart(spec.start);
      result.start = { mode: start.placement.mode, applied: flight().startAt(start.placement), x: round(start.point.x, 1), y: round(start.point.y, 1), z: round(start.point.z, 1), heading: round(start.point.heading, 1) };
    } catch (error) {
      result.setupOk = false;
      result.notes.push(`start failed: ${error.message}`);
      return finishResult(result, createBucket());
    }
    await waitFrames(SETTLE_FRAMES);
    eventLog.clear();
    const stats = flight().getStats();
    const position = state.player.position;
    activeRun = {
      entry, spec, result, t: 0, seconds: spec.seconds, memo: {},
      start: { x: position.x, y: position.y, z: position.z, heading: start.point.heading },
      startElapsed: state.time.elapsed, startWall: performance.now(), lastWall: null,
      bucket: createBucket(), recorder: createFrameRecorder({ slowLimitMs: 50, maxSlowListed: 0 }),
      checkState: spec.checks.map(() => ({ passed: false, failed: false, at: null, seen: false })),
      held: new Set(), penetrating: false, cameraViews: new Set(),
      nanRestoresStart: stats.nanRestores ?? 0, done: null, finished: false,
    };
    activeRun.api = createApi(activeRun);
    const finished = new Promise((resolve) => { activeRun.done = resolve; });
    await finished;
    const run = activeRun;
    activeRun = null;
    releaseHeld(run);
    run.bucket.nanGuardEvents += Math.max(0, (flight().getStats().nanRestores ?? 0) - run.nanRestoresStart);
    result.checks = spec.checks.map((check, checkIndex) => {
      const checkState = run.checkState[checkIndex];
      const passed = check.always ? checkState.seen && !checkState.failed : checkState.passed;
      return { id: check.id, label: check.label ?? check.id, passed, at: checkState.at === null ? null : round(checkState.at, 2), always: Boolean(check.always) };
    });
    result.cameraViews = [...run.cameraViews];
    result.viewMismatchFrames = run.viewMismatchFrames ?? 0;
    result.craftMismatchFrames = run.craftMismatchFrames ?? 0;
    result.flownSeconds = round(run.t, 1);
    const frames = run.recorder.summary();
    result.frames = { count: frames.frames, avgFps: frames.avgFps, p99Ms: frames.p99Ms, maxMs: frames.maxMs, over50: frames.slowFrames };
    if (run.cutShort) result.notes.push(`cut short after ${round(run.t, 1)} s of flight (the page stalled)`);
    if (run.failure) result.notes.push(run.failure);
    result.failed = Boolean(run.failure || run.cutShort);
    return finishResult(result, run.bucket, spec);
  }

  function finishResult(result, bucket, spec = null) {
    result.endedAt = new Date().toISOString();
    result.nanEvents = bucket.nanFrames + bucket.nanGuardEvents;
    result.penetrations = bucket.penetrations;
    result.penetrationDetails = bucket.penetrationDetails;
    result.softCrashes = bucket.softCrashes.length;
    result.softCrashDetails = bucket.softCrashes;
    result.allowCrash = Boolean(spec && spec.allowCrash);
    result.consoleErrors = bucket.consoleErrors;
    result.consoleWarnings = bucket.consoleWarnings;
    result.passed = result.setupOk && result.viewMismatchFrames === 0 && result.craftMismatchFrames === 0 && result.nanEvents === 0 && result.penetrations === 0
      && (result.allowCrash || result.softCrashes === 0) && result.consoleErrors === 0 && result.consoleWarnings === 0
      && result.checks.length > 0 && result.checks.every((check) => check.passed) && !result.failed;
    return result;
  }

  function releaseHeld(run) {
    for (const actionId of run.held) ctx.controls.held.delete(actionId);
    run.held.clear();
  }

  /** The run's frame: script controls into ControlState (before flight), then the measurements and checks. */
  function stepRun(run, realDt) {
    const now = performance.now();
    if (run.lastWall !== null) run.recorder.push(now - run.lastWall, run.t);
    run.lastWall = now;
    run.t = state.time.elapsed - run.startElapsed;
    if (run.t >= run.seconds || (now - run.startWall) / 1000 > run.seconds + RUN_WALL_MARGIN_SECONDS) {
      run.cutShort = run.t < run.seconds;
      endRun(run);
      return;
    }
    try {
      applyScript(run);
    } catch (error) {
      run.failure = `the script failed at ${round(run.t, 2)} s: ${error && error.message ? error.message : error}`;
      session.harnessErrors.push(`${run.entry.id} (${run.entry.view}): ${run.failure}`);
      endRun(run);
      return;
    }
    samplePose(run);
    run.cameraViews.add(camera().getView());
    if (!inPlannedView(run.entry)) run.viewMismatchFrames = (run.viewMismatchFrames ?? 0) + 1;
    if (flight().getCraft() !== run.entry.craft) run.craftMismatchFrames = (run.craftMismatchFrames ?? 0) + 1;
    evaluateChecks(run);
    if (realDt > 0) updateProgress(run);
  }

  function endRun(run) {
    run.finished = true;
    run.done();
  }

  function applyScript(run) {
    if (typeof run.spec.script !== 'function') return;
    const controls = run.spec.script(run.t, run.api);
    if (!controls) return;
    const target = ctx.controls;
    for (const axis of SCRIPT_AXES) if (Number.isFinite(controls[axis])) target[axis] = controls[axis];
    if (Array.isArray(controls.actions)) for (const actionId of controls.actions) target.actions.add(actionId);
    const held = Array.isArray(controls.held) ? controls.held : [];
    for (const actionId of run.held) {
      if (!held.includes(actionId)) {
        target.held.delete(actionId);
        run.held.delete(actionId);
      }
    }
    for (const actionId of held) {
      target.held.add(actionId);
      run.held.add(actionId);
    }
  }

  function samplePose(run) {
    const player = state.player;
    const telemetry = state.flight;
    const bucket = run.bucket;
    const finite = isFiniteVector(player.position) && isFiniteVector(player.velocity) && isFiniteQuaternion(player.quaternion) && isFiniteVector(telemetry.position) && Number.isFinite(telemetry.airspeed);
    if (!finite) {
      bucket.nanFrames++;
      run.penetrating = false;
      return;
    }
    const position = player.position;
    const depth = surfaceAt(position.x, position.z) - position.y;
    if (depth > PENETRATION_LIMIT_M) {
      if (!run.penetrating) {
        bucket.penetrations++;
        if (bucket.penetrationDetails.length < MAX_DETAILS) bucket.penetrationDetails.push({ at: round(run.t, 2), depth: round(depth, 2), position: { x: round(position.x, 1), y: round(position.y, 1), z: round(position.z, 1) } });
      }
      run.penetrating = true;
    } else {
      run.penetrating = false;
    }
  }

  function evaluateChecks(run) {
    run.spec.checks.forEach((check, checkIndex) => {
      const checkState = run.checkState[checkIndex];
      const from = Number.isFinite(check.from) ? check.from : 0;
      const until = Number.isFinite(check.until) ? check.until : run.seconds;
      if (run.t < from || run.t > until || checkState.failed || (!check.always && checkState.passed)) return;
      let holds;
      try {
        holds = Boolean(check.test(run.api));
      } catch (error) {
        // A check that throws is a failed check and a harness problem, never a silent pass.
        checkState.failed = true;
        checkState.at = run.t;
        session.harnessErrors.push(`${run.entry.id} (${run.entry.view}): check "${check.id}" threw at ${round(run.t, 2)} s: ${error && error.message ? error.message : error}`);
        return;
      }
      checkState.seen = true;
      if (check.always) {
        if (!holds) {
          checkState.failed = true;
          checkState.at = run.t;
        }
      } else if (holds) {
        checkState.passed = true;
        checkState.at = run.t;
      }
    });
  }

  // ---- Report ----------------------------------------------------------------------------------------
  function criterion(id, label, value, status) {
    return { id, label, value, status };
  }

  function publish() {
    const runs = session.runs;
    const complete = session.status === 'complete';
    const sum = (field) => runs.reduce((total, run) => total + (Number.isFinite(run[field]) ? run[field] : 0), 0);
    const pendingErrors = pendingConsole.filter((entry) => entry.level === 'error').length;
    const consoleErrors = session.consoleCounts.errors + pendingErrors;
    const consoleWarnings = session.consoleCounts.warnings + (pendingConsole.length - pendingErrors);
    const checks = runs.flatMap((run) => run.checks);
    const crashes = runs.filter((run) => !run.allowCrash).reduce((total, run) => total + run.softCrashes, 0);
    const planned = runs.filter((run) => run.setupOk && run.viewMismatchFrames === 0 && run.craftMismatchFrames === 0).length;
    const generals = new Set(runs.filter((run) => run.kind === 'general' && run.passed).map((run) => `${run.craft} ${run.view}`));
    const expectedGenerals = plan.filter((entry) => entry.kind === 'general').map((entry) => `${entry.craft} ${entry.view}`);
    const pending = (passed) => (passed ? 'pass' : complete ? 'fail' : 'muted');
    const criteria = [
      criterion('plan', 'Runs flown as planned (craft and view, every frame)', `${planned} / ${plan.length}`, planned === runs.length && (!complete || runs.length === plan.length) ? 'pass' : 'fail'),
      criterion('general', 'General flight test: every registered craft in every view', `${generals.size} / ${expectedGenerals.length}`, pending(expectedGenerals.every((key) => generals.has(key)))),
      criterion('nan', 'NaN events', String(sum('nanEvents')), sum('nanEvents') === 0 ? 'pass' : 'fail'),
      criterion('penetrations', `Terrain or water penetrations (> ${PENETRATION_LIMIT_M} m)`, String(sum('penetrations')), sum('penetrations') === 0 ? 'pass' : 'fail'),
      criterion('crashes', 'Soft crashes (scenarios that allow them aside)', String(crashes), crashes === 0 ? 'pass' : 'fail'),
      criterion('checks', 'Checks passed', `${checks.filter((check) => check.passed).length} / ${checks.length}`, checks.every((check) => check.passed) && checks.length > 0 ? 'pass' : complete ? 'fail' : 'muted'),
      criterion('console', 'Console errors / warnings', `${consoleErrors} / ${consoleWarnings}`, consoleErrors === 0 && consoleWarnings === 0 ? 'pass' : 'fail'),
    ];
    const failed = criteria.some((entry) => entry.status === 'fail') || session.harnessErrors.length > 0;
    const p99s = runs.map((run) => run.frames?.p99Ms).filter(Number.isFinite);
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status: complete ? 'complete' : 'running',
      result: complete ? (failed ? 'FAIL' : 'PASS') : null,
      sessionId: session.id,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      progress: { completedRuns: runs.length, totalRuns: plan.length, current: activeRun ? { ...activeRun.entry, seconds: round(activeRun.t, 1) } : null, phase, step },
      environment: { backend: ctx.backend, backends: [...new Set(runs.map((run) => run.backend).concat(ctx.backend))], revision: ctx.THREE.REVISION, userAgent: navigator.userAgent, database: ctx.storage.databaseName },
      config,
      criteria,
      totals: {
        runs: runs.length,
        nanEvents: sum('nanEvents'),
        penetrations: sum('penetrations'),
        softCrashes: sum('softCrashes'),
        checks: `${checks.filter((check) => check.passed).length}/${checks.length}`,
        consoleErrors,
        consoleWarnings,
        worstP99Ms: p99s.length > 0 ? Math.max(...p99s) : null,
        framesOver50: runs.reduce((total, run) => total + (run.frames?.over50 ?? 0), 0),
      },
      runs,
      console: session.console.concat(pendingConsole.map((entry) => ({ ...entry, seed: state.seed }))).slice(0, MAX_CONSOLE_ENTRIES),
      harnessErrors: session.harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function updateProgress(run) {
    const total = Math.max(plan.length, 1);
    report.progress = { completedRuns: session.runs.length, totalRuns: plan.length, current: { ...run.entry, seconds: round(run.t, 1) }, phase, step };
    panel.setProgress({
      label: `Run ${run.entry.index + 1} of ${plan.length}: ${run.entry.id}`,
      detail: `${run.entry.craft}, ${run.entry.view} person · ${Math.floor(run.t)} of ${run.seconds} s`,
      fraction: (run.entry.index + Math.min(run.t / run.seconds, 1)) / total,
    });
  }

  function cell(passed) {
    return { text: passed ? 'PASS' : 'FAIL', status: passed ? 'pass' : 'fail' };
  }

  function countCell(value) {
    return { text: value, status: value === 0 ? 'muted' : 'fail' };
  }

  function showSummary() {
    publish();
    const rows = report.runs.map((run) => ({
      index: run.index + 1,
      id: run.id,
      craft: run.craft,
      view: { text: `${run.view === 'first' ? '1st' : '3rd'}${run.cameraViews.length > 0 ? ` (${run.cameraViews.join(', ')})` : ''}`, status: run.viewMismatchFrames === 0 ? null : 'fail' },
      start: run.start ? `${run.start.mode}${run.start.applied !== run.start.mode ? ` -> ${run.start.applied}` : ''}` : '-',
      checks: { text: `${run.checks.filter((check) => check.passed).length}/${run.checks.length}`, status: run.checks.every((check) => check.passed) && run.checks.length > 0 ? null : 'fail', title: run.checks.map((check) => `${check.passed ? 'ok' : 'FAILED'} ${check.label}`).join(', ') },
      nan: countCell(run.nanEvents),
      penetrations: countCell(run.penetrations),
      crashes: { text: run.softCrashes, status: run.softCrashes === 0 || run.allowCrash ? 'muted' : 'fail' },
      console: { text: `${run.consoleErrors} / ${run.consoleWarnings}`, status: run.consoleErrors + run.consoleWarnings === 0 ? 'muted' : 'fail' },
      p99: run.frames?.p99Ms ?? '-',
      result: cell(run.passed),
    }));
    const sections = [{
      title: 'Runs',
      table: {
        columns: [
          { key: 'index', label: '#', numeric: true },
          { key: 'id', label: 'Run' },
          { key: 'craft', label: 'Craft' },
          { key: 'view', label: 'View' },
          { key: 'start', label: 'Start' },
          { key: 'checks', label: 'Checks', numeric: true },
          { key: 'nan', label: 'NaN', numeric: true },
          { key: 'penetrations', label: 'Pen.', numeric: true },
          { key: 'crashes', label: 'Soft crash', numeric: true },
          { key: 'console', label: 'Err / warn', numeric: true },
          { key: 'p99', label: 'p99 ms', numeric: true, title: 'Reported, not judged (shared machine)' },
          { key: 'result', label: 'Result' },
        ],
        rows,
      },
    }];
    const events = report.runs.flatMap((run) => [
      ...run.notes.map((note) => `${run.id} (${run.view}): ${note}`),
      ...run.checks.filter((check) => !check.passed).map((check) => `${run.id} (${run.view}): check failed: ${check.label}${check.at !== null ? ` at ${check.at} s` : ''}`),
      ...run.softCrashDetails.map((crash) => `${run.id} (${run.view}): soft crash "${crash.reason}" at ${crash.at} s, ${crash.impactSpeed} m/s`),
      ...run.penetrationDetails.map((detail) => `${run.id} (${run.view}): penetration ${detail.depth} m at ${detail.at} s`),
    ]);
    if (events.length > 0) sections.push({ title: 'Events', notes: events.slice(0, 60) });
    if (report.console.length > 0) sections.push({ title: 'Console errors and warnings', notes: report.console.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) });
    if (report.harnessErrors.length > 0) sections.push({ title: 'Harness problems', notes: report.harnessErrors });
    if (config.notes.length > 0) sections.push({ title: 'Notes', notes: config.notes });
    const failing = report.criteria.filter((entry) => entry.status === 'fail').map((entry) => entry.label);
    panel.showSummary({
      result: report.result,
      subtitle: report.result === 'PASS' ? 'Every run met every criterion.' : `Failed: ${failing.join(', ') || 'harness problems'}.`,
      meta: [
        ['Backend', report.environment.backends.join(', ')],
        ['three.js', `r${report.environment.revision}`],
        ['Craft', config.crafts.join(', ')],
        ['Views', config.views.map((view) => `${view} person`).join(', ')],
        ['Runs', String(report.totals.runs)],
        ['Finished', report.finishedAt ? new Date(report.finishedAt).toLocaleString() : '-'],
      ],
      criteria: report.criteria,
      sections,
      report,
      filename: `driftwing-craft-test-${String(report.environment.backend).toLowerCase()}-${report.sessionId}.json`,
      actions: [{ label: 'Run again', onClick: () => window.location.replace(urlFor(null, null, null)) }],
    });
  }

  function complete() {
    phase = 'complete';
    session.status = 'complete';
    session.finishedAt = new Date().toISOString();
    flushConsole();
    saveSession();
    showSummary();
  }

  // ---- The page load's work -----------------------------------------------------------------------------
  async function runPage() {
    if (session.status === 'complete') {
      phase = 'complete';
      showSummary();
      return;
    }
    const next = plan[session.nextRun];
    if (!next) {
      complete();
      return;
    }
    if (next.seed !== state.seed || next.world !== pageWorld) {
      phase = 'navigating';
      delete session.fresh;
      flushConsole();
      saveSession();
      panel.setProgress({ label: `Loading world ${next.seed}${next.world === 'waters' ? ' (water fixtures)' : ''}`, detail: 'A new seed or world needs a page load', fraction: session.nextRun / Math.max(plan.length, 1) });
      window.location.replace(urlFor(next.seed, next.world, session.id));
      return;
    }
    if (session.fresh) {
      // A new session: start from the default settings (in the isolated test database).
      settings.reset();
      delete session.fresh;
    }
    const url = urlFor(state.seed, pageWorld, session.id);
    if (url !== window.location.href) window.history.replaceState(null, '', url);
    saveSession();
    phase = 'waiting for frames';
    publish();
    await waitForFramesToFlow();
    phase = 'world warmup';
    panel.setProgress({ label: `World ${state.seed}: warming up`, detail: `${WORLD_WARMUP_SECONDS} s after load`, fraction: session.nextRun / Math.max(plan.length, 1) });
    await waitWallSeconds(WORLD_WARMUP_SECONDS);
    phase = 'running';
    while (session.nextRun < plan.length && plan[session.nextRun].seed === state.seed && plan[session.nextRun].world === pageWorld) {
      const result = await runEntry(plan[session.nextRun]);
      session.runs.push(result);
      session.nextRun++;
      flushConsole();
      saveSession();
      publish();
    }
    capture.setContext('craft test: between worlds');
    await runPage();
  }

  function abort(error) {
    const message = `craft test stopped: ${error && error.message ? error.message : error}`;
    session.harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    if (activeRun) releaseHeld(activeRun);
    activeRun = null;
    complete();
  }

  bus.on('game:ready', () => {
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
    publish();
    runPage().catch(abort);
  });
  panel.setProgress({ label: 'Craft test starting', detail: `${plan.length} runs: ${config.crafts.length} craft, ${config.views.map((view) => `${view} person`).join(' and ')}`, fraction: session.nextRun / Math.max(plan.length, 1) });

  return {
    update(simDt, realDt) {
      try {
        if (activeRun && !activeRun.finished) stepRun(activeRun, realDt);
      } catch (error) {
        abort(error);
      }
      if (frameWaiters.length > 0) {
        const waiting = frameWaiters.splice(0, frameWaiters.length);
        for (const resolve of waiting) resolve();
      }
    },
    getReport() {
      return report;
    },
  };
}
