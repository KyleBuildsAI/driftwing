// Flight-test harness (?test=1, dev builds only; main.js never loads it in production).
//
// A scripted pilot flies every craft for runSeconds (60 s) in first person and in third person on
// each world seed (3 by default): 6 craft x 2 views x 3 seeds = 36 runs. Each run switches craft
// through the settings command channel (exactly as the picker does), picks the view the same way
// WREN does (settings.views: 'cockpit' for first person, 'chase' for third person; the camera
// follows the active craft's entry) and flies the craft's script from testFlightScripts.js through
// the real control paths. The flight model is the same in every view; the view dimension proves
// the harness criteria hold with each view's own rendering cost (the cockpit and its instrument
// panel, or the chase camera, glass HUD and flight path marker). A new seed needs a new world, so the
// harness reloads the page with the seed in the URL and carries its progress, results and console
// log across reloads in sessionStorage (key SESSION_KEY). Its settings live in an isolated IndexedDB
// database (TEST_DATABASE), so the player's own settings, bindings and calibration are never touched.
// The scripted pilot is the only input: real gamepads on the machine are hidden behind an empty
// Gamepad API mock for the whole test (listed in the report as environment.hiddenGamepads).
//
// Measured per run and in total:
//   - frame time: every frame interval (ms). Average fps, p50 / p99 / max frame time and the frames
//     over FRAME_LIMIT_MS are taken AFTER WARMUP (see below). Every slow frame is attributed
//     (testFrameProfiler.js): 'systems' (the game's systems ran most of it), 'gc' (a garbage
//     collection: the used heap dropped across the frame), 'mainThread' (a long animation frame
//     outside the systems: render submission or other browser work) or 'delayed' (the main thread
//     was mostly idle: GPU, compositor or OS scheduling, the signature of a loaded machine).
//   - NaN events: frames whose craft pose (state.player position, velocity, attitude) or telemetry
//     is non-finite as sampled by the harness, plus every restore by the flight guards (the flight
//     model's per-tick guard, FlightController getStats().nanRestores, and core's frame guard, the
//     'safety:nonFinite' bus event).
//   - terrain penetrations: the craft reference point (state.player.position, the rendered pose)
//     more than PENETRATION_LIMIT_M below the shared height function (world.groundHeight) or the
//     water surface, sampled every frame; each continuous episode counts once (its deepest point
//     and frame count are listed).
//   - soft crashes: typed 'softCrash' events (reason, impact speed, time).
//   - console errors and warnings: console.error / console.warn, uncaught errors and unhandled
//     rejections (testConsole.js), from boot to the end, tagged with the run they happened in.
//   - JS heap (performance.memory, 'unavailable' where the browser has none), read after a forced
//     garbage collection when the browser allows one (Chrome with --js-flags=--expose-gc).
//
// Warmup (excluded from the frame-time statistics and the slow-frame criterion only; NaN,
// penetration, crash and console checks cover every frame):
//   - world warmup: the first WORLD_WARMUP_SECONDS after the game reports ready on each page load
//     (every seed), while the first chunks, pipelines and caches settle, followed by the UI warmup
//     and the warmup lap;
//   - UI warmup: the time of day steps through dawn, noon, golden hour, dusk and night
//     (UI_WARMUP_DAY_TIMES, UI_WARMUP_STEP_SECONDS each) and back to where it was, then the glass UI
//     is left alone until its toast has left and the HUD has auto-hidden, and is woken again
//     (UI_WARMUP_SETTLE_SECONDS). Every transient UI state (a toast arriving and leaving, the HUD
//     fading out and in, each time-of-day chip and the night sky) is drawn once: Chrome compiles the
//     compositor's and rasterizer's GPU programs (Skia) on their first use, 15-50 ms each on the
//     GPU process's main thread, which also runs WebGPU, so a fresh browser profile otherwise shows
//     them as slow frames the first time a toast leaves or dusk falls in a run. Chrome keeps these
//     programs in its disk cache, so a player's browser compiles each once, ever;
//   - warmup lap: every craft and view this world will fly, switched to in plan order and flown for
//     WARMUP_LAP_SECONDS each on the autopilot, so every craft module, mesh, cockpit, flight model and
//     pipeline exists once before anything is measured;
//   - run warmup: the first RUN_WARMUP_SECONDS after each run's craft and view switch (the switch
//     itself: mesh, cockpit, instruments and their pipelines).
// Heap growth is judged per world load, from the end of the warmup lap to the end of that world's
// last run: once every craft has been built, growth means memory that is never given back. The
// growth from the end of the world warmup (before the lap) is reported too, for transparency; a
// 6-run repeated-jet experiment showed it is one-time allocation that plateaus (runs 3-6: under
// 2 MB each), not a leak.
//
// Pass criteria: 0 NaN events, 0 penetrations, 0 console errors and 0 warnings, heap growth under
// HEAP_LIMIT_MB on every world, no frame over FRAME_LIMIT_MS after warmup; plus two validity checks
// on the harness itself: every run flew its planned craft in its planned view (checked every
// frame of the run), and every scripted manoeuvre was observed.
//
// The soak (testPlan=soak, Phase 2 Milestone G; tools/run-harness.mjs --test soak) is the same harness
// as a 10-minute run with the event director live: 5 world seeds (SOAK_SEEDS), one craft per seed (the
// six craft in turn), both views, 60 s each (5 x 2 x 60 s). The director runs as in the game on every
// world (its activations, the sites it brings into range and the spawn counts are reported per world).
// Its criteria add to the flight test's: heap growth under SOAK_HEAP_LIMIT_MB (75 MB), the worst p99
// frame time within the perf governor's frame target, and the director live on every world (it
// ticked, and the spawns it and the site feed started are counted); NaN, penetrations, console and
// frames over 50 ms after warmup are judged as in the flight test.
//
// URL options: testSeeds=A,B,C  testSeconds=60  testCraft=glider,jet  testViews=first,third
// testPlan=soak.
// Output: the on-screen summary panel (per-run table, overall PASS / FAIL, JSON download) and
// window.DRIFTWING.testReport for automation (tools/run-harness.mjs).
import { installConsoleCapture } from './testConsole.js';
import { flightScriptFor, SCRIPTED_CRAFT } from './testFlightScripts.js';
import { createFrameProfiler } from './testFrameProfiler.js';
import { installMockGamepads } from './mockGamepads.js';
import { createTestPanel } from './testPanel.js';
import { createFrameRecorder, delay, gcAvailable, heapAvailable, readHeapMB, readSession, round, writeSession } from './testStats.js';
import { clamp, isFiniteQuaternion, isFiniteVector, wrapDegrees } from '../core/util.js';

export const TEST_DATABASE = 'driftwing-v2-test';
const SESSION_KEY = 'driftwing-v2.test.flight';
const REPORT_KIND = 'driftwing-flight-test';
const REPORT_VERSION = 2;
const DEFAULT_SEEDS = Object.freeze(['HARNESS-1', 'HARNESS-2', 'HARNESS-3']);
/** The view dimension, in plan order: third person (chase) and first person (cockpit or FPV). */
const VIEWS = Object.freeze(['third', 'first']);
/** The settings.views slot each view is flown from. */
const VIEW_SLOTS = Object.freeze({ third: 'chase', first: 'cockpit' });
const DEFAULT_RUN_SECONDS = 60;
const RUN_WARMUP_SECONDS = 3;
const WORLD_WARMUP_SECONDS = 5;
const WARMUP_LAP_SECONDS = 3;
/** Times of day the UI warmup shows: dawn, noon, golden hour, dusk and night (every chip phase and label). */
const UI_WARMUP_DAY_TIMES = Object.freeze([0.25, 0.5, 0.72, 0.77, 0.02]);
const UI_WARMUP_STEP_SECONDS = 1;
/** After the time is restored: the last toast leaves (about 3.8 s) and the HUD auto-hides (3 s idle plus its fade). */
const UI_WARMUP_SETTLE_SECONDS = 8;
/** After the final wake: the HUD fades back in. */
const UI_WARMUP_WAKE_SECONDS = 1.5;
const FRAME_LIMIT_MS = 50;
const HEAP_LIMIT_MB = 50;
/** The soak plan (testPlan=soak): five worlds, one craft each, both views, a 75 MB heap limit. */
const SOAK_SEEDS = Object.freeze(['SOAK-1', 'SOAK-2', 'SOAK-3', 'SOAK-4', 'SOAK-5']);
const SOAK_HEAP_LIMIT_MB = 75;
const PENETRATION_LIMIT_M = 1;
/** A run that starts below this height (m) or on the ground is lifted to START_AGL first. */
const MIN_START_AGL = 120;
const START_AGL = 300;
/** Ceiling margin (m) under the flight ceiling for autopilot targets. */
const CEILING_MARGIN = 200;
const PROGRESS_HZ = 4;
const MAX_CONSOLE_ENTRIES = 300;
const MAX_EVENT_DETAILS = 20;
/** Slow frames listed per run in the report (the slowest; every one is counted and attributed). */
const MAX_SLOW_LISTED = 25;
const SLOW_CAUSES = Object.freeze(['systems', 'gc', 'mainThread', 'delayed']);

/** Reads the URL options; unknown craft and views are dropped (and reported). */
function readConfig(params) {
  const notes = [];
  const soak = params.get('testPlan') === 'soak';
  if (params.has('testPlan') && !soak) notes.push(`testPlan "${params.get('testPlan')}" is not a plan (soak) and was ignored`);
  const listParam = (name) => (params.get(name) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  let seeds = listParam('testSeeds').map((seed) => seed.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').slice(0, 24)).filter(Boolean);
  if (seeds.length === 0) seeds = (soak ? SOAK_SEEDS : DEFAULT_SEEDS).slice();
  let crafts = listParam('testCraft').filter((craft) => {
    const known = SCRIPTED_CRAFT.includes(craft);
    if (!known) notes.push(`testCraft "${craft}" is not a craft and was ignored`);
    return known;
  });
  if (crafts.length === 0) crafts = SCRIPTED_CRAFT.slice();
  let views = listParam('testViews').filter((view) => {
    const known = VIEWS.includes(view);
    if (!known) notes.push(`testViews "${view}" is not a view (first or third) and was ignored`);
    return known;
  });
  if (views.length === 0) views = VIEWS.slice();
  const requestedSeconds = Number.parseFloat(params.get('testSeconds'));
  const runSeconds = Number.isFinite(requestedSeconds) && requestedSeconds >= 5 ? Math.min(requestedSeconds, 600) : DEFAULT_RUN_SECONDS;
  if (params.has('testSeconds') && runSeconds !== requestedSeconds) notes.push(`testSeconds ${params.get('testSeconds')} is outside 5-600 s; using ${runSeconds} s`);
  return {
    plan: soak ? 'soak' : 'matrix',
    seeds,
    crafts: SCRIPTED_CRAFT.filter((craft) => crafts.includes(craft)),
    views: VIEWS.filter((view) => views.includes(view)),
    runSeconds,
    runWarmupSeconds: RUN_WARMUP_SECONDS,
    worldWarmupSeconds: WORLD_WARMUP_SECONDS,
    warmupLapSeconds: WARMUP_LAP_SECONDS,
    uiWarmupSeconds: UI_WARMUP_DAY_TIMES.length * UI_WARMUP_STEP_SECONDS + UI_WARMUP_SETTLE_SECONDS + UI_WARMUP_WAKE_SECONDS,
    frameLimitMs: FRAME_LIMIT_MS,
    heapLimitMB: soak ? SOAK_HEAP_LIMIT_MB : HEAP_LIMIT_MB,
    penetrationLimitM: PENETRATION_LIMIT_M,
    notes,
  };
}

/**
 * The runs in order: every craft and view on every seed, or for the soak one craft per seed (the
 * crafts in turn) in every view.
 */
function buildPlan(config) {
  const plan = [];
  if (config.plan === 'soak') {
    config.seeds.forEach((seed, seedIndex) => {
      const craft = config.crafts[seedIndex % config.crafts.length];
      for (const view of config.views) plan.push({ index: plan.length, seed, craft, view });
    });
    return plan;
  }
  for (const seed of config.seeds) {
    for (const craft of config.crafts) {
      for (const view of config.views) plan.push({ index: plan.length, seed, craft, view });
    }
  }
  return plan;
}

function newSessionId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An empty event bucket (a run, or a world's time outside runs). */
function createBucket() {
  return {
    nanFrames: 0,
    nanGuardEvents: 0,
    nanDetails: [],
    penetrations: 0,
    penetrationFrames: 0,
    penetrationDetails: [],
    softCrashes: [],
    consoleErrors: 0,
    consoleWarnings: 0,
  };
}

/**
 * Called by main.js at the very start of boot (dev builds with ?test=1). Installs the console
 * capture at once and returns the isolated database name and the system factory.
 */
export function prepareFlightTest({ params }) {
  const listeners = { entry: null };
  const capture = installConsoleCapture({ onEntry: (entry) => listeners.entry?.(entry) });
  const hiddenGamepads = hideRealGamepads();
  return {
    databaseName: TEST_DATABASE,
    createSystem: (ctx) => createFlightTestSystem(ctx, { params, capture, listeners, hiddenGamepads }),
  };
}

/**
 * The scripted pilot must be the only input. A real stick, throttle or pedals on the test machine
 * would otherwise fly along (an uncalibrated pedal resting off centre overrides the autopilot), so
 * navigator.getGamepads is replaced by an empty mock (mockGamepads.js, no devices plugged) before
 * the input system starts. Returns listHidden(): the ids of the real devices seen so far, read
 * through the browser's own Navigator.prototype.getGamepads (Chrome lists a device only after one
 * of its buttons was pressed, so the list can grow during the test).
 */
function hideRealGamepads() {
  const realGetGamepads = typeof Navigator !== 'undefined' ? Navigator.prototype.getGamepads : null;
  const seen = new Set();
  installMockGamepads();
  return function listHidden() {
    if (typeof realGetGamepads !== 'function') return [...seen];
    try {
      for (const pad of realGetGamepads.call(navigator)) if (pad) seen.add(pad.id);
    } catch (error) {
      seen.add(`unreadable: ${error.message}`);
    }
    return [...seen];
  };
}

function createFlightTestSystem(ctx, { params, capture, listeners, hiddenGamepads }) {
  const { state, bus, settings, world, CONFIG } = ctx;
  const panel = createTestPanel({ title: params.get('testPlan') === 'soak' ? 'Soak test' : 'Flight test' });
  /** The run being flown (null between runs); console entries and events are booked to it. */
  let activeRun = null;

  // ---- Session (progress across reloads) -----------------------------------------------------
  const stored = readSession(SESSION_KEY);
  const requestedSession = params.get('testSession');
  let session = stored.value;
  let phase = 'loading';
  let navigating = false;
  if (!session || session.kind !== REPORT_KIND || !requestedSession || session.id !== requestedSession) {
    const config = readConfig(params);
    session = {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      id: newSessionId(),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      config,
      plan: buildPlan(config),
      nextRun: 0,
      runs: [],
      worlds: [],
      console: [],
      consoleCounts: { errors: 0, warnings: 0 },
      harnessErrors: stored.error ? [stored.error] : [],
      fresh: true,
    };
  }
  const plan = session.plan;
  const config = session.config;
  const heapLimitMB = Number.isFinite(config.heapLimitMB) ? config.heapLimitMB : HEAP_LIMIT_MB;
  const soak = config.plan === 'soak';

  // The world (page load) this system belongs to. Its console entries so far happened while it loaded.
  const worldRecord = {
    seed: state.seed,
    backend: ctx.backend,
    loadSeconds: null,
    heapAtLoadMB: null,
    heapBaselineMB: null,
    heapFinalMB: null,
    heapGrowthMB: null,
    heapGrowthFromLoadMB: null,
    lap: [],
    runs: [],
    outside: createBucket(),
    // The event director and the spawns on this world (the soak reports them; the flight test too).
    spawns: { directorTicks: null, directorActivations: null, directorLog: [], notables: null, declined: null, activated: { site: 0, event: 0 }, peak: 0 },
  };
  bus.onTyped('spawnActivated', (payload) => {
    if (payload && payload.kind === 'site') worldRecord.spawns.activated.site++;
    else worldRecord.spawns.activated.event++;
  });
  const pendingConsole = [];
  for (const entry of capture.entries) pendingConsole.push(entry);
  listeners.entry = (entry) => {
    pendingConsole.push(entry);
    const bucket = activeRun ? activeRun.bucket : worldRecord.outside;
    if (entry.level === 'error') bucket.consoleErrors++;
    else bucket.consoleWarnings++;
  };
  for (const entry of capture.entries) {
    if (entry.level === 'error') worldRecord.outside.consoleErrors++;
    else worldRecord.outside.consoleWarnings++;
  }

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
      if (session.console.length < MAX_CONSOLE_ENTRIES) session.console.push({ ...entry, seed: worldRecord.seed });
    }
    pendingConsole.length = 0;
  }

  function urlFor(seed, sessionId) {
    const url = new URL(window.location.href);
    if (seed) url.searchParams.set('seed', seed);
    else url.searchParams.delete('seed');
    if (sessionId) url.searchParams.set('testSession', sessionId);
    else url.searchParams.delete('testSession');
    return url.href;
  }

  /** Loads the page for seed (a new world); progress is saved first. */
  function navigateToSeed(seed) {
    navigating = true;
    flushConsole();
    delete session.fresh;
    saveSession();
    panel.setProgress({ label: `Loading world ${seed}`, detail: 'A new seed needs a new world: reloading', fraction: session.nextRun / Math.max(plan.length, 1) });
    window.location.replace(urlFor(seed, session.id));
  }

  // ---- Where this page load stands --------------------------------------------------------------
  if (session.status === 'complete') {
    phase = 'complete';
  } else if (session.nextRun >= plan.length) {
    phase = 'finishing';
  } else if (plan[session.nextRun].seed !== state.seed) {
    phase = 'navigating';
  } else {
    if (session.fresh) {
      // A new session: start from the default settings (in the isolated test database).
      settings.reset();
      delete session.fresh;
    }
    phase = 'waitingForReady';
    const url = urlFor(state.seed, session.id);
    if (url !== window.location.href) window.history.replaceState(null, '', url);
    saveSession();
  }

  // ---- Run state ---------------------------------------------------------------------------------
  let worldReadyMs = null;
  let worldClosed = false;
  let lastFrameMs = null;
  let lastHeapMB = null;
  let lastProgressMs = 0;
  let penetrationEpisode = null;
  const profiler = createFrameProfiler(ctx, { exclude: ['test'] });
  const pilotHold = { roll: null, pitch: null, yaw: null, throttle: null, brakes: null };

  bus.on('safety:nonFinite', () => {
    const bucket = activeRun ? activeRun.bucket : worldRecord.outside;
    bucket.nanGuardEvents++;
    if (bucket.nanDetails.length < MAX_EVENT_DETAILS) bucket.nanDetails.push({ at: runTime(), source: 'core frame guard' });
  });
  bus.onTyped('softCrash', (payload) => {
    const bucket = activeRun ? activeRun.bucket : worldRecord.outside;
    if (bucket.softCrashes.length < MAX_EVENT_DETAILS) {
      bucket.softCrashes.push({ at: runTime(), reason: payload.reason, impactSpeed: round(payload.impactSpeed, 1), position: payload.position });
    }
  });
  bus.onTyped('relaunched', () => {
    if (activeRun) activeRun.seen.relaunches++;
  });
  // Every autopilot engage / disengage in a run, with its reason (a disengage the script did not ask
  // for, such as a manual override, shows up here).
  bus.on('autopilot:changed', (payload) => {
    if (!activeRun || !payload) return;
    const changes = activeRun.autopilotChanges;
    const last = changes[changes.length - 1];
    if (last && last.enabled === payload.enabled && last.reason === payload.reason) return;
    if (changes.length < MAX_EVENT_DETAILS) changes.push({ at: runTime(), enabled: Boolean(payload.enabled), reason: payload.reason ?? null });
  });
  bus.on('game:ready', () => {
    profiler.instrument();
    worldReadyMs = performance.now();
    // performance.now() counts from the navigation, so this is the page load until the fade lifts.
    worldRecord.loadSeconds = round(worldReadyMs / 1000, 2);
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
    if (phase === 'waitingForReady') phase = 'worldWarmup';
    publish();
  });

  /** Seconds into the active run (null outside runs). */
  function runTime() {
    return activeRun ? round((performance.now() - activeRun.startMs) / 1000, 2) : null;
  }

  // ---- Pilot: the scripts' interface to the controls ---------------------------------------------
  const flight = () => ctx.systems.flight;
  const camera = () => ctx.systems.camera;

  /** True while the camera shows the entry's view: first person (cockpit or FPV) or third person. */
  function inPlannedView(entry) {
    return camera().isFirstPerson() === (entry.view === 'first');
  }

  /** The water surface at (x, z): the shared water query (ocean swell, local bodies), else the flat sea. */
  function waterAt(x, z) {
    return ctx.waterQuery ? ctx.waterQuery.heightAt(x, z) : CONFIG.WATER_LEVEL;
  }

  function surfaceAt(x, z) {
    return Math.max(world.groundHeight(x, z), waterAt(x, z));
  }

  const pilot = {
    autopilot({ enabled, headingOffset = 0, altitudeAgl = 380, speed = null }) {
      if (!enabled) {
        flight().setAutopilot({ enabled: false, reason: 'flight test' });
        return;
      }
      const player = state.player;
      const ceiling = flight().getCeiling();
      const altitude = clamp(Math.max(player.position.y, surfaceAt(player.position.x, player.position.z) + altitudeAgl), 80, ceiling - CEILING_MARGIN);
      const options = { enabled: true, heading: wrapDegrees(player.heading + headingOffset), altitude, followWaypoint: false, reason: 'flight test' };
      if (Number.isFinite(speed)) options.speed = speed;
      flight().setAutopilot(options);
    },
    stick({ roll, pitch, yaw }) {
      pilotHold.roll = roll;
      pilotHold.pitch = pitch;
      pilotHold.yaw = yaw;
    },
    throttle(value) {
      pilotHold.throttle = value;
    },
    brakes(value) {
      pilotHold.brakes = value;
    },
    action(id) {
      ctx.controls.actions.add(id);
    },
    relaunch() {
      return flight().relaunch();
    },
  };

  function releasePilot() {
    pilotHold.roll = null;
    pilotHold.pitch = null;
    pilotHold.yaw = null;
    pilotHold.throttle = null;
    pilotHold.brakes = null;
  }

  /** Writes the held deflections into ControlState after the input system and before flight (UPDATE_ORDER). */
  function applyPilot() {
    const target = ctx.controls;
    if (pilotHold.roll !== null) target.roll = pilotHold.roll;
    if (pilotHold.pitch !== null) target.pitch = pilotHold.pitch;
    if (pilotHold.yaw !== null) target.yaw = pilotHold.yaw;
    if (pilotHold.throttle !== null) target.throttle = pilotHold.throttle;
    if (pilotHold.brakes !== null) {
      target.brakeL = pilotHold.brakes;
      target.brakeR = pilotHold.brakes;
    }
  }

  // ---- Per-frame sampling ------------------------------------------------------------------------
  function samplePose() {
    const player = state.player;
    const telemetry = state.flight;
    const bucket = activeRun ? activeRun.bucket : worldRecord.outside;
    const finite = isFiniteVector(player.position) && isFiniteVector(player.velocity) && isFiniteQuaternion(player.quaternion)
      && isFiniteVector(telemetry.position) && Number.isFinite(telemetry.airspeed);
    if (!finite) {
      bucket.nanFrames++;
      if (bucket.nanDetails.length < MAX_EVENT_DETAILS) bucket.nanDetails.push({ at: runTime(), source: 'harness pose sample' });
      penetrationEpisode = null;
      return;
    }
    const position = player.position;
    const ground = world.groundHeight(position.x, position.z);
    const water = waterAt(position.x, position.z);
    const surface = Math.max(ground, water);
    const depth = surface - position.y;
    if (depth > PENETRATION_LIMIT_M) {
      bucket.penetrationFrames++;
      if (!penetrationEpisode || penetrationEpisode.bucket !== bucket) {
        bucket.penetrations++;
        penetrationEpisode = {
          bucket,
          detail: { at: runTime(), depth: round(depth, 2), frames: 0, surface: ground >= water ? 'terrain' : 'water', position: { x: round(position.x, 1), y: round(position.y, 1), z: round(position.z, 1) }, craft: flight().getCraft() },
        };
        if (bucket.penetrationDetails.length < MAX_EVENT_DETAILS) bucket.penetrationDetails.push(penetrationEpisode.detail);
      }
      penetrationEpisode.detail.frames++;
      penetrationEpisode.detail.depth = Math.max(penetrationEpisode.detail.depth, round(depth, 2));
    } else {
      penetrationEpisode = null;
    }
  }

  /** The most spawns alive at once on this world (sites and events). */
  function sampleSpawns() {
    const manager = ctx.systems.spawns && ctx.systems.spawns.manager;
    if (!manager) return;
    const count = manager.spawnCount();
    if (count > worldRecord.spawns.peak) worldRecord.spawns.peak = count;
  }

  function observe(run, dt) {
    const player = state.player;
    const telemetry = state.flight;
    const seen = run.seen;
    const autopilotOn = Boolean(player.autopilot.enabled);
    if (autopilotOn) seen.autopilotSeconds += dt;
    if (!autopilotOn && Number.isFinite(telemetry.roll)) seen.maxBank = Math.max(seen.maxBank, Math.abs(telemetry.roll));
    const groundSpeed = Number.isFinite(telemetry.groundSpeed) ? telemetry.groundSpeed : 0;
    if (!telemetry.onGround && groundSpeed < 3) seen.hoverSeconds += dt;
    if (!autopilotOn && groundSpeed > 6) seen.translateSeconds += dt;
    if (Number.isFinite(telemetry.pitch)) seen.minPitch = Math.min(seen.minPitch, telemetry.pitch);
    if (telemetry.craftState && telemetry.craftState.canopy === true) seen.canopy = true;
    if (Number.isFinite(telemetry.flapNotch)) seen.maxFlapNotch = Math.max(seen.maxFlapNotch, telemetry.flapNotch);
    if (Number.isFinite(telemetry.airbrake)) seen.maxAirbrake = Math.max(seen.maxAirbrake, telemetry.airbrake);
    if (telemetry.afterburner) seen.afterburnerSeconds += dt;
    const flightStats = run.flight;
    if (flightStats.lastX !== null) flightStats.distance += Math.hypot(player.position.x - flightStats.lastX, player.position.z - flightStats.lastZ);
    flightStats.lastX = player.position.x;
    flightStats.lastZ = player.position.z;
    if (Number.isFinite(telemetry.airspeed)) flightStats.maxAirspeed = Math.max(flightStats.maxAirspeed, telemetry.airspeed);
    if (Number.isFinite(player.agl)) flightStats.minAgl = Math.min(flightStats.minAgl, player.agl);
    flightStats.maxAltitude = Math.max(flightStats.maxAltitude, player.position.y);
  }

  // ---- UI warmup ------------------------------------------------------------------------------------
  const uiWarmup = { step: 0, stepStartMs: 0, restoreDayTime: 0, woke: false };

  /** Steps the time of day through every chip phase and label, then lets the UI settle (see the header). */
  function startUiWarmup(now) {
    phase = 'uiWarmup';
    capture.setContext(`UI warmup (seed ${worldRecord.seed})`);
    pilot.autopilot({ enabled: true });
    uiWarmup.step = 0;
    uiWarmup.stepStartMs = now;
    uiWarmup.woke = false;
    uiWarmup.restoreDayTime = ctx.systems.sky.getDayTime();
    ctx.systems.sky.setDayTime(UI_WARMUP_DAY_TIMES[0], { transition: 0 });
  }

  /** Advances the UI warmup; true once it is over. */
  function stepUiWarmup(now) {
    const elapsed = (now - uiWarmup.stepStartMs) / 1000;
    if (uiWarmup.step < UI_WARMUP_DAY_TIMES.length) {
      if (elapsed < UI_WARMUP_STEP_SECONDS) return false;
      uiWarmup.step++;
      uiWarmup.stepStartMs = now;
      const dayTime = uiWarmup.step < UI_WARMUP_DAY_TIMES.length ? UI_WARMUP_DAY_TIMES[uiWarmup.step] : uiWarmup.restoreDayTime;
      ctx.systems.sky.setDayTime(dayTime, { transition: 0 });
      return false;
    }
    if (!uiWarmup.woke) {
      if (elapsed < UI_WARMUP_SETTLE_SECONDS) return false;
      ctx.systems.ui.wake();
      uiWarmup.woke = true;
      uiWarmup.stepStartMs = now;
      return false;
    }
    return elapsed >= UI_WARMUP_WAKE_SECONDS;
  }

  // ---- Warmup lap -----------------------------------------------------------------------------------
  const lap = { queue: [], index: 0, stepStartMs: 0 };

  /** Every craft and view this world still flies, once each, in plan order. */
  function startWarmupLap(now) {
    const seen = new Set();
    lap.queue = [];
    for (const entry of plan.slice(session.nextRun)) {
      if (entry.seed !== state.seed) break;
      const key = `${entry.craft} ${entry.view}`;
      if (!seen.has(key)) {
        seen.add(key);
        lap.queue.push(entry);
      }
    }
    phase = 'warmupLap';
    capture.setContext(`warmup lap (seed ${worldRecord.seed})`);
    switchLap(0, now);
  }

  function switchLap(index, now) {
    lap.index = index;
    lap.stepStartMs = now;
    const entry = lap.queue[index];
    const setup = setUpCraft(entry);
    pilot.autopilot({ enabled: true });
    worldRecord.lap.push({ craft: entry.craft, view: entry.view, setupOk: setup.setupOk, notes: setup.notes });
  }

  // ---- Runs -------------------------------------------------------------------------------------------
  /**
   * Switches to the entry's craft through the settings channel at 100 % assists, then to its view
   * through settings.views (the camera follows the active craft's entry), lifting a craft that came
   * down on the ground to a clean airborne start. Returns { setupOk, notes }.
   */
  function setUpCraft(entry) {
    const flightSystem = flight();
    const notes = [];
    releasePilot();
    flightSystem.setAutopilot({ enabled: false, reason: 'flight test' });
    settings.update('assists', { [entry.craft]: 1 });
    const switched = flightSystem.getCraft() !== entry.craft;
    if (switched) settings.set('craft', entry.craft);
    settings.update('views', { [entry.craft]: VIEW_SLOTS[entry.view] });
    const craftOk = flightSystem.getCraft() === entry.craft;
    if (!craftOk) notes.push(`asked for ${entry.craft}, flying ${flightSystem.getCraft()}`);
    const viewOk = inPlannedView(entry);
    if (!viewOk) notes.push(`asked for the ${entry.view}-person view, the camera shows ${camera().getView()}`);
    const setupOk = craftOk && viewOk;
    const model = flightSystem.getModel();
    const position = model && model.state ? model.state.position : state.player.position;
    const agl = position.y - surfaceAt(position.x, position.z);
    const onGround = Boolean(model && model.contact && model.contact.onGround);
    if (onGround || agl < MIN_START_AGL) {
      flightSystem.resetTo({ x: position.x, y: surfaceAt(position.x, position.z) + START_AGL, z: position.z, heading: state.player.heading });
      notes.push(`started ${onGround ? 'on the ground' : `${Math.round(agl)} m above the ground`}: lifted to ${START_AGL} m`);
    } else if (!switched) {
      // The same craft as the last run (its other view): restart it where it is, level at cruise
      // (hovering craft hover), as a craft switch would, so every run starts from the same kind of
      // pose instead of the last run's final manoeuvre.
      flightSystem.resetTo({ x: position.x, y: position.y, z: position.z, heading: state.player.heading });
    }
    return { setupOk, notes };
  }

  function startRun(entry) {
    const flightSystem = flight();
    const { setupOk, notes: setupNotes } = setUpCraft(entry);
    const stats = flightSystem.getStats();
    const script = flightScriptFor(entry.craft);
    const heapStartMB = worldRecord.runs.length > 0 ? worldRecord.runs[worldRecord.runs.length - 1].heapEndMB : worldRecord.heapBaselineMB;
    activeRun = {
      entry,
      startedAt: new Date().toISOString(),
      startMs: performance.now(),
      durationSeconds: config.runWarmupSeconds + config.runSeconds,
      script,
      stepIndex: 0,
      stepLog: [],
      autopilotChanges: [],
      setupOk,
      setupNotes,
      cameraViews: new Set([camera().getView()]),
      viewMismatchFrames: 0,
      bucket: createBucket(),
      recorder: createFrameRecorder({ slowLimitMs: config.frameLimitMs }),
      warmupFrames: 0,
      warmupMaxMs: 0,
      nanRestoresStart: stats.nanRestores ?? 0,
      softCrashesStart: stats.softCrashes ?? 0,
      heapStartMB,
      seen: {
        autopilotSeconds: 0, maxBank: 0, hoverSeconds: 0, translateSeconds: 0,
        relaunches: 0, minPitch: Infinity, canopy: false, maxFlapNotch: 0, maxAirbrake: 0, afterburnerSeconds: 0,
      },
      flight: { distance: 0, lastX: null, lastZ: null, maxAirspeed: 0, minAgl: Infinity, maxAltitude: -Infinity },
    };
    penetrationEpisode = null;
    capture.setContext(`run ${entry.index + 1}: ${entry.craft}, ${entry.view} person (seed ${entry.seed})`);
  }

  function runScript(run, elapsed) {
    const steps = run.script ? run.script.steps : [];
    while (run.stepIndex < steps.length && steps[run.stepIndex].at * run.durationSeconds <= elapsed) {
      const step = steps[run.stepIndex];
      run.stepIndex++;
      run.stepLog.push({ at: round(elapsed, 2), step: step.label });
      step.run(pilot);
    }
  }

  function finishRun(run) {
    const flightSystem = flight();
    releasePilot();
    flightSystem.setAutopilot({ enabled: false, reason: 'flight test' });
    const stats = flightSystem.getStats();
    const guardRestores = Math.max(0, (stats.nanRestores ?? 0) - run.nanRestoresStart);
    run.bucket.nanGuardEvents += guardRestores;
    if (guardRestores > 0 && run.bucket.nanDetails.length < MAX_EVENT_DETAILS) run.bucket.nanDetails.push({ at: null, source: `flight model guard restored ${guardRestores} tick(s)` });
    const frames = run.recorder.summary();
    const slowAttributed = frames.slowFrameList.map((frame) => {
      const { startMs, endMs, systemsMs, top, heapDeltaMB, ...kept } = frame;
      return { ...kept, ...profiler.attribute({ startMs, endMs, ms: frame.ms, systemsMs, top, heapDeltaMB }) };
    });
    const slowByCause = Object.fromEntries(SLOW_CAUSES.map((cause) => [cause, slowAttributed.filter((frame) => frame.cause === cause).length]));
    const heapEndMB = readHeapMB();
    const seen = run.seen;
    const checks = (run.script ? run.script.checks : []).map((check) => ({ id: check.id, label: check.label, passed: Boolean(check.test(seen, run.durationSeconds)) }));
    const bucket = run.bucket;
    const nanEvents = bucket.nanFrames + bucket.nanGuardEvents;
    const result = {
      index: run.entry.index,
      seed: run.entry.seed,
      craft: run.entry.craft,
      view: run.entry.view,
      cameraViews: [...run.cameraViews],
      viewMismatchFrames: run.viewMismatchFrames,
      backend: ctx.backend,
      startedAt: run.startedAt,
      endedAt: new Date().toISOString(),
      setupOk: run.setupOk,
      setupNotes: run.setupNotes,
      measuredSeconds: frames.seconds,
      frames: frames.frames,
      avgFps: frames.avgFps,
      p50Ms: frames.p50Ms,
      p99Ms: frames.p99Ms,
      maxMs: frames.maxMs,
      slowFrames: frames.slowFrames,
      slowByCause,
      slowFrameList: slowAttributed.slice().sort((first, second) => second.ms - first.ms).slice(0, MAX_SLOW_LISTED),
      warmupFrames: run.warmupFrames,
      warmupMaxMs: round(run.warmupMaxMs, 1),
      nanEvents,
      nanDetails: bucket.nanDetails,
      penetrations: bucket.penetrations,
      penetrationFrames: bucket.penetrationFrames,
      penetrationDetails: bucket.penetrationDetails,
      softCrashes: Math.max(bucket.softCrashes.length, (stats.softCrashes ?? 0) - run.softCrashesStart),
      softCrashDetails: bucket.softCrashes,
      consoleErrors: bucket.consoleErrors,
      consoleWarnings: bucket.consoleWarnings,
      heapStartMB: run.heapStartMB,
      heapEndMB,
      heapDeltaMB: Number.isFinite(run.heapStartMB) && Number.isFinite(heapEndMB) ? round(heapEndMB - run.heapStartMB, 2) : null,
      frameTargetMs: Number.isFinite(state.perf.targetMs) ? round(state.perf.targetMs, 2) : null,
      spawnsAtEnd: ctx.systems.spawns && ctx.systems.spawns.manager ? ctx.systems.spawns.manager.spawnCount() : null,
      script: { checks, steps: run.stepLog, autopilotChanges: run.autopilotChanges },
      observed: {
        autopilotSeconds: round(seen.autopilotSeconds, 1),
        maxManualBankDeg: round(seen.maxBank, 1),
        hoverSeconds: round(seen.hoverSeconds, 1),
        translateSeconds: round(seen.translateSeconds, 1),
        relaunches: seen.relaunches,
        minPitchDeg: round(seen.minPitch, 1),
        canopy: seen.canopy,
        maxFlapNotch: seen.maxFlapNotch,
        maxAirbrake: round(seen.maxAirbrake, 2),
        afterburnerSeconds: round(seen.afterburnerSeconds, 1),
      },
      flight: {
        distanceKm: round(run.flight.distance / 1000, 2),
        maxAirspeed: round(run.flight.maxAirspeed, 1),
        minAgl: round(run.flight.minAgl, 1),
        maxAltitude: round(run.flight.maxAltitude, 0),
      },
    };
    result.passed = result.setupOk && result.viewMismatchFrames === 0 && nanEvents === 0 && result.penetrations === 0 && result.consoleErrors === 0 && result.consoleWarnings === 0
      && result.slowFrames === 0 && checks.every((check) => check.passed);
    worldRecord.runs.push(result);
    session.runs.push(result);
    session.nextRun = run.entry.index + 1;
    activeRun = null;
    capture.setContext(`between runs (seed ${worldRecord.seed})`);
    flushConsole();
    saveSession();
    publish();
  }

  /** Closes this world's record (heap growth, outside-run events) into the session. */
  function finishWorld() {
    worldClosed = true;
    const lastRun = worldRecord.runs[worldRecord.runs.length - 1];
    worldRecord.heapFinalMB = lastRun ? lastRun.heapEndMB : readHeapMB();
    worldRecord.heapGrowthMB = Number.isFinite(worldRecord.heapBaselineMB) && Number.isFinite(worldRecord.heapFinalMB)
      ? round(worldRecord.heapFinalMB - worldRecord.heapBaselineMB, 2)
      : null;
    worldRecord.heapGrowthFromLoadMB = Number.isFinite(worldRecord.heapAtLoadMB) && Number.isFinite(worldRecord.heapFinalMB)
      ? round(worldRecord.heapFinalMB - worldRecord.heapAtLoadMB, 2)
      : null;
    readDirector();
    session.worlds.push({
      seed: worldRecord.seed,
      backend: worldRecord.backend,
      loadSeconds: worldRecord.loadSeconds,
      heapAtLoadMB: worldRecord.heapAtLoadMB,
      heapBaselineMB: worldRecord.heapBaselineMB,
      heapFinalMB: worldRecord.heapFinalMB,
      heapGrowthMB: worldRecord.heapGrowthMB,
      heapGrowthFromLoadMB: worldRecord.heapGrowthFromLoadMB,
      lap: worldRecord.lap,
      runs: worldRecord.runs.map((run) => run.index),
      outside: worldRecord.outside,
      spawns: worldRecord.spawns,
    });
  }

  /**
   * The event director's record on this world so far: ticks, activations (with their log), notables,
   * and the director activations the SpawnManager declined (every engine ended at create; the director
   * retries those candidates later, so they are not activations). The manager is new with each world.
   */
  function readDirector() {
    const director = ctx.systems.spawns && ctx.systems.spawns.director;
    if (!director) return;
    const directorState = director.getState();
    const record = worldRecord.spawns;
    record.directorTicks = directorState.ticks;
    record.directorActivations = directorState.logLength;
    record.notables = directorState.notables;
    const manager = ctx.systems.spawns.manager;
    record.declined = manager ? manager.getStats().refusals.declined ?? 0 : null;
    record.directorLog = directorState.log.map((entry) => ({ time: round(entry.time, 1), presetId: entry.presetId, reason: entry.reason }));
  }

  function complete() {
    phase = 'complete';
    session.status = 'complete';
    session.finishedAt = new Date().toISOString();
    flushConsole();
    saveSession();
    publish();
    showSummary();
    // Leave the craft cruising on the autopilot behind the summary.
    pilot.autopilot({ enabled: true });
  }

  // ---- Report -----------------------------------------------------------------------------------------
  const report = {};

  function criterion(id, label, value, status, detail = '') {
    return { id, label, value, status, detail };
  }

  /**
   * The soak's own criteria: the worst p99 frame time within the frame target the perf governor holds,
   * and the event director live on every world (it ticked; its activations and the spawns started on
   * the world are listed with it).
   */
  function soakCriteria(runs, worlds, complete) {
    const p99s = runs.map((run) => run.p99Ms).filter(Number.isFinite);
    const targets = runs.map((run) => run.frameTargetMs).filter(Number.isFinite);
    const worstP99 = p99s.length > 0 ? Math.max(...p99s) : null;
    const target = targets.length > 0 ? Math.min(...targets) : null;
    const p99Status = worstP99 === null || target === null ? (complete ? 'fail' : 'muted') : worstP99 <= target ? 'pass' : 'fail';
    const closed = worlds.filter((entry) => !entry.open && entry.spawns);
    const live = closed.filter((entry) => entry.spawns.directorTicks > 0);
    const activations = closed.reduce((sum, entry) => sum + (entry.spawns.directorActivations ?? 0), 0);
    const started = closed.reduce((sum, entry) => sum + entry.spawns.activated.site + entry.spawns.activated.event, 0);
    const directorStatus = closed.length === 0 ? (complete ? 'fail' : 'muted') : live.length === closed.length && (!complete || closed.length === config.seeds.length) ? 'pass' : 'fail';
    return [
      criterion('p99', 'Worst p99 frame time within the frame target', worstP99 === null ? 'pending' : `${worstP99} ms against ${target ?? 'n/a'} ms`, p99Status),
      criterion('director', 'Event director live on every world', `${live.length} / ${closed.length} worlds, ${activations} director activations, ${started} spawns started`, directorStatus),
    ];
  }

  /** Rebuilds window.DRIFTWING.testReport (the same object, updated in place) from the session. */
  function publish() {
    const runs = session.runs;
    const worlds = session.worlds.slice();
    // This page load's world, while it is still being flown.
    if (!worldClosed && worldReadyMs !== null && session.status !== 'complete') {
      worlds.push({ seed: worldRecord.seed, backend: worldRecord.backend, loadSeconds: worldRecord.loadSeconds, heapAtLoadMB: worldRecord.heapAtLoadMB, heapBaselineMB: worldRecord.heapBaselineMB, heapFinalMB: null, heapGrowthMB: null, heapGrowthFromLoadMB: null, lap: worldRecord.lap, runs: worldRecord.runs.map((run) => run.index), outside: worldRecord.outside, spawns: worldRecord.spawns, open: true });
    }
    const outsideSum = (field) => worlds.reduce((sum, entry) => sum + (field === 'nan' ? entry.outside.nanFrames + entry.outside.nanGuardEvents : entry.outside[field]), 0);
    const sum = (field) => runs.reduce((total, run) => total + (Number.isFinite(run[field]) ? run[field] : 0), 0);
    const frames = sum('frames');
    const seconds = sum('measuredSeconds');
    const nanEvents = sum('nanEvents') + outsideSum('nan');
    const penetrations = sum('penetrations') + outsideSum('penetrations');
    const softCrashes = sum('softCrashes') + worlds.reduce((total, entry) => total + entry.outside.softCrashes.length, 0);
    const slowFrames = sum('slowFrames');
    const pendingErrors = pendingConsole.filter((entry) => entry.level === 'error').length;
    const consoleErrors = session.consoleCounts.errors + pendingErrors;
    const consoleWarnings = session.consoleCounts.warnings + (pendingConsole.length - pendingErrors);
    const heapGrowths = worlds.map((entry) => entry.heapGrowthMB).filter(Number.isFinite);
    const maxHeapGrowth = heapGrowths.length > 0 ? Math.max(...heapGrowths) : null;
    const setupFailures = runs.filter((run) => !run.setupOk || run.viewMismatchFrames > 0).length;
    const scriptChecks = runs.flatMap((run) => run.script.checks);
    const scriptPassed = scriptChecks.filter((check) => check.passed).length;
    const complete = session.status === 'complete';
    const heapMeasured = heapAvailable();
    const criteria = [
      criterion('nan', 'NaN events', String(nanEvents), nanEvents === 0 ? 'pass' : 'fail'),
      criterion('penetrations', `Terrain penetrations (> ${PENETRATION_LIMIT_M} m)`, String(penetrations), penetrations === 0 ? 'pass' : 'fail'),
      criterion('console', 'Console errors / warnings', `${consoleErrors} / ${consoleWarnings}`, consoleErrors === 0 && consoleWarnings === 0 ? 'pass' : 'fail'),
      heapMeasured
        ? criterion('heap', `Heap growth after warmup (< ${heapLimitMB} MB)`, maxHeapGrowth === null ? 'pending' : `${maxHeapGrowth} MB max`, maxHeapGrowth === null ? (complete ? 'fail' : 'muted') : maxHeapGrowth < heapLimitMB ? 'pass' : 'fail')
        : criterion('heap', `Heap growth after warmup (< ${heapLimitMB} MB)`, 'unavailable', 'muted', 'performance.memory is not available in this browser'),
      criterion('frames', `Frames over ${FRAME_LIMIT_MS} ms after warmup`, String(slowFrames), slowFrames === 0 ? 'pass' : 'fail'),
      criterion('plan', 'Runs flown as planned (craft and view)', `${runs.length - setupFailures} / ${plan.length}`, setupFailures === 0 && (!complete || runs.length === plan.length) ? 'pass' : 'fail'),
      criterion('script', 'Scripted manoeuvres observed', `${scriptPassed} / ${scriptChecks.length}`, scriptPassed === scriptChecks.length ? 'pass' : 'fail'),
    ];
    if (soak) criteria.push(...soakCriteria(runs, worlds, complete));
    const failed = criteria.some((entry) => entry.status === 'fail') || session.harnessErrors.length > 0;
    const sortedP99 = runs.map((run) => run.p99Ms).filter(Number.isFinite);
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status: complete ? 'complete' : 'running',
      result: complete ? (failed ? 'FAIL' : 'PASS') : null,
      sessionId: session.id,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      progress: { completedRuns: runs.length, totalRuns: plan.length, current: activeRun ? { ...activeRun.entry, seconds: runTime() } : null },
      environment: {
        backend: ctx.backend,
        backends: [...new Set(worlds.map((entry) => entry.backend).concat(ctx.backend))],
        revision: ctx.THREE.REVISION,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        heap: heapMeasured ? (gcAvailable() ? 'performance.memory after a forced GC' : 'performance.memory (no forced GC: start Chrome with --js-flags=--expose-gc for exact readings)') : 'unavailable',
        database: ctx.storage.databaseName,
        hiddenGamepads: hiddenGamepads(),
      },
      config,
      definitions: {
        warmup: `The first ${config.worldWarmupSeconds} s after the game reports ready on every page load, then a ${round(config.uiWarmupSeconds, 1)} s UI warmup (every time-of-day chip and the night sky, a toast arriving and leaving, the HUD fading out and in: Chrome compiles its compositor and rasterizer GPU programs on first use), then a warmup lap through every craft and view that world flies (${config.warmupLapSeconds} s each on the autopilot, so every craft module, mesh, cockpit, flight model and pipeline exists once), and the first ${config.runWarmupSeconds} s after each run's craft and view switch. Frame statistics and the slow-frame criterion start after warmup; NaN, penetration, crash and console checks cover every frame, the lap included.`,
        view: 'First person is the settings.views slot cockpit (the cockpit, or the FPV camera and the wingsuit helmet view); third person is chase. The camera view is checked every frame of a run: a run that leaves its planned view was not flown as planned.',
        frameTime: 'Interval between consecutive frames (ms), measured by the harness system each frame (performance.now).',
        nanEvents: 'Frames with a non-finite craft pose or telemetry sampled by the harness, plus every restore by the flight model guard (per tick) and core\'s frame guard.',
        penetration: `The craft reference point (state.player.position) more than ${PENETRATION_LIMIT_M} m below the shared height function (world.groundHeight) or the water surface, sampled every frame; one continuous episode counts once.`,
        heapGrowth: 'JS heap (performance.memory.usedJSHeapSize) after a forced GC, from the end of each world\'s warmup lap to the end of that world\'s last run; the largest growth across worlds is judged. The growth from the end of the world warmup (before the lap) is listed too.',
        ...(soak ? {
          p99: 'The soak judges the worst run\'s p99 frame time (after warmup) against the frame target the perf governor holds (state.perf.targetMs: the display refresh, 60 Hz in a browser under automation).',
          director: 'The event director runs as in the game on every world. It is live when it ticked on the world; its activations (with their reasons), the activations the SpawnManager declined (refusal "declined": every engine ended at create, retried later), the sites and events started on the world and the most spawns alive at once are listed.',
        } : {}),
      },
      criteria,
      totals: {
        runs: runs.length,
        frames,
        measuredSeconds: round(seconds, 1),
        avgFps: seconds > 0 ? round(frames / seconds, 1) : null,
        worstP99Ms: sortedP99.length > 0 ? Math.max(...sortedP99) : null,
        maxFrameMs: runs.length > 0 ? Math.max(...runs.map((run) => run.maxMs ?? 0)) : null,
        slowFrames,
        slowByCause: Object.fromEntries(SLOW_CAUSES.map((cause) => [cause, runs.reduce((total, run) => total + (run.slowByCause?.[cause] ?? 0), 0)])),
        nanEvents,
        penetrations,
        softCrashes,
        consoleErrors,
        consoleWarnings,
        maxHeapGrowthMB: maxHeapGrowth,
        scriptChecks: `${scriptPassed}/${scriptChecks.length}`,
      },
      worlds,
      runs,
      console: session.console.concat(pendingConsole.map((entry) => ({ ...entry, seed: worldRecord.seed }))).slice(0, MAX_CONSOLE_ENTRIES),
      harnessErrors: session.harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function statusCell(passed) {
    return { text: passed ? 'PASS' : 'FAIL', status: passed ? 'pass' : 'fail' };
  }

  function countCell(value) {
    return { text: value, status: value === 0 ? 'muted' : 'fail' };
  }

  function showSummary() {
    publish();
    const craftNames = Object.fromEntries(ctx.craftRegistry.list().map((entry) => [entry.id, entry.name]));
    const rows = report.runs.map((run) => ({
      index: run.index + 1,
      seed: run.seed,
      craft: craftNames[run.craft] ?? run.craft,
      view: { text: `${run.view === 'first' ? '1st' : '3rd'} (${run.cameraViews.join(', ')})`, status: run.viewMismatchFrames === 0 ? null : 'fail', title: `${run.viewMismatchFrames} frame(s) outside the planned view` },
      fps: run.avgFps,
      p99: run.p99Ms,
      max: run.maxMs,
      slow: countCell(run.slowFrames),
      causes: { text: run.slowFrames === 0 ? '-' : `${run.slowByCause.systems} / ${run.slowByCause.gc} / ${run.slowByCause.mainThread} / ${run.slowByCause.delayed}`, status: run.slowFrames === 0 ? 'muted' : null },
      nan: countCell(run.nanEvents),
      penetrations: countCell(run.penetrations),
      crashes: { text: run.softCrashes, status: run.softCrashes === 0 ? 'muted' : null, title: run.softCrashDetails.map((crash) => `${crash.at} s ${crash.reason}`).join(', ') },
      console: { text: `${run.consoleErrors} / ${run.consoleWarnings}`, status: run.consoleErrors + run.consoleWarnings === 0 ? 'muted' : 'fail' },
      heap: run.heapDeltaMB,
      script: { text: `${run.script.checks.filter((check) => check.passed).length}/${run.script.checks.length}`, status: run.script.checks.every((check) => check.passed) ? null : 'fail', title: run.script.checks.map((check) => `${check.passed ? 'ok' : 'MISSING'} ${check.label}`).join(', ') },
      result: statusCell(run.passed),
    }));
    const totals = report.totals;
    const footer = {
      index: '', seed: 'All', craft: `${totals.runs} runs, ${totals.measuredSeconds} s`, view: config.views.join(' / '),
      fps: totals.avgFps, p99: totals.worstP99Ms, max: totals.maxFrameMs, slow: countCell(totals.slowFrames),
      causes: `${totals.slowByCause.systems} / ${totals.slowByCause.gc} / ${totals.slowByCause.mainThread} / ${totals.slowByCause.delayed}`,
      nan: countCell(totals.nanEvents), penetrations: countCell(totals.penetrations), crashes: totals.softCrashes,
      console: `${totals.consoleErrors} / ${totals.consoleWarnings}`, heap: totals.maxHeapGrowthMB === null ? 'n/a' : `max ${totals.maxHeapGrowthMB}`,
      script: totals.scriptChecks, result: statusCell(report.result === 'PASS'),
    };
    const sections = [{
      title: 'Runs (frame statistics after warmup)',
      table: {
        columns: [
          { key: 'index', label: '#', numeric: true },
          { key: 'seed', label: 'Seed' },
          { key: 'craft', label: 'Craft' },
          { key: 'view', label: 'View' },
          { key: 'fps', label: 'Avg fps', numeric: true },
          { key: 'p99', label: 'p99 ms', numeric: true },
          { key: 'max', label: 'Max ms', numeric: true },
          { key: 'slow', label: `>${FRAME_LIMIT_MS} ms`, numeric: true },
          { key: 'causes', label: 'Sys / GC / main / delayed', numeric: true, title: 'Slow frames by cause: game systems, garbage collection, other main-thread work, delayed while the main thread was idle' },
          { key: 'nan', label: 'NaN', numeric: true },
          { key: 'penetrations', label: 'Pen.', numeric: true, title: 'Terrain penetrations' },
          { key: 'crashes', label: 'Soft crash', numeric: true },
          { key: 'console', label: 'Err / warn', numeric: true },
          { key: 'heap', label: 'Heap Δ MB', numeric: true },
          { key: 'script', label: 'Script', numeric: true },
          { key: 'result', label: 'Result' },
        ],
        rows,
        footer,
      },
    }];
    sections.push({
      title: 'Worlds',
      table: {
        columns: [
          { key: 'seed', label: 'Seed' },
          { key: 'backend', label: 'Backend' },
          { key: 'load', label: 'Load s', numeric: true },
          { key: 'atLoad', label: 'Heap at load MB', numeric: true, title: 'After the world warmup, before the warmup lap' },
          { key: 'baseline', label: 'Heap after lap MB', numeric: true },
          { key: 'final', label: 'Heap at end MB', numeric: true },
          { key: 'growth', label: 'Growth MB', numeric: true },
          { key: 'fromLoad', label: 'Growth from load MB', numeric: true },
          { key: 'outside', label: 'Between runs: NaN / pen. / err / warn', numeric: true },
          { key: 'spawns', label: 'Director / started / peak', numeric: true, title: 'Director activations, spawns started on the world (sites and events), most spawns alive at once' },
        ],
        rows: report.worlds.map((entry) => ({
          seed: entry.seed,
          backend: entry.backend,
          load: entry.loadSeconds,
          atLoad: entry.heapAtLoadMB ?? 'n/a',
          baseline: entry.heapBaselineMB ?? 'n/a',
          fromLoad: entry.heapGrowthFromLoadMB ?? 'n/a',
          final: entry.heapFinalMB ?? 'n/a',
          growth: entry.heapGrowthMB === null ? 'n/a' : { text: entry.heapGrowthMB, status: entry.heapGrowthMB < heapLimitMB ? 'pass' : 'fail' },
          outside: `${entry.outside.nanFrames + entry.outside.nanGuardEvents} / ${entry.outside.penetrations} / ${entry.outside.consoleErrors} / ${entry.outside.consoleWarnings}`,
          spawns: entry.spawns ? `${entry.spawns.directorActivations ?? '-'} / ${entry.spawns.activated.site + entry.spawns.activated.event} / ${entry.spawns.peak}` : '-',
        })),
      },
    });
    const slowList = report.runs.flatMap((run) => run.slowFrameList.map((frame) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): ${frame.ms} ms at ${frame.at} s after warmup, ${frame.cause} (systems ${frame.systemsMs} ms${frame.topSystems ? `: ${frame.topSystems}` : ''}${Number.isFinite(frame.heapDeltaMB) ? `; heap ${frame.heapDeltaMB} MB` : ''}${frame.loaf ? `; long frame ${frame.loaf.durationMs} ms, scripts ${frame.loaf.scriptsMs} ms` : ''})`));
    if (slowList.length > 0) sections.push({ title: `Frames over ${FRAME_LIMIT_MS} ms`, notes: slowList.slice(0, 40) });
    const eventList = report.runs.flatMap((run) => [
      ...run.penetrationDetails.map((detail) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): penetration ${detail.depth} m below ${detail.surface} at ${detail.at} s for ${detail.frames} frame(s)`),
      ...run.nanDetails.map((detail) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): non-finite state (${detail.source})${detail.at === null ? '' : ` at ${detail.at} s`}`),
      ...run.softCrashDetails.map((crash) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): soft crash "${crash.reason}" at ${crash.at} s, ${crash.impactSpeed} m/s`),
      ...run.setupNotes.map((note) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): ${note}`),
      ...run.script.checks.filter((check) => !check.passed).map((check) => `Run ${run.index + 1} (${run.craft}, ${run.view} person, ${run.seed}): scripted manoeuvre not observed: ${check.label}`),
    ]);
    if (eventList.length > 0) sections.push({ title: 'Events', notes: eventList.slice(0, 60) });
    const directorNotes = report.worlds.filter((entry) => entry.spawns && entry.spawns.directorTicks !== null).map((entry) => `${entry.seed}: ${entry.spawns.directorTicks} director ticks, ${entry.spawns.notables} notables, ${entry.spawns.declined ?? 0} declined, activations: ${entry.spawns.directorLog.length > 0 ? entry.spawns.directorLog.map((log) => `${log.presetId} at ${log.time} s (${log.reason})`).join(', ') : 'none'}; ${entry.spawns.activated.site} sites and ${entry.spawns.activated.event} events started, at most ${entry.spawns.peak} spawns at once`);
    if (directorNotes.length > 0) sections.push({ title: 'Event director and spawns', notes: directorNotes });
    if (report.console.length > 0) sections.push({ title: 'Console errors and warnings', notes: report.console.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) });
    if (report.harnessErrors.length > 0) sections.push({ title: 'Harness problems', notes: report.harnessErrors });
    sections.push({ title: 'Definitions', notes: Object.values(report.definitions).concat(config.notes) });
    const failing = report.criteria.filter((entry) => entry.status === 'fail').map((entry) => entry.label);
    panel.showSummary({
      result: report.result,
      subtitle: report.result === 'PASS' ? 'Every run met every criterion.' : `Failed: ${failing.join(', ') || 'harness problems'}.`,
      meta: [
        ['Backend', report.environment.backends.join(', ')],
        ['three.js', `r${report.environment.revision}`],
        ['Seeds', config.seeds.join(', ')],
        ['Plan', soak ? 'soak: one craft per world, both views, the event director live' : 'every craft in every view on every world'],
        ['Runs', `${report.totals.runs} x ${config.runSeconds} s`],
        ['Views', config.views.map((view) => `${view} person`).join(', ')],
        ['Warmup', `${config.worldWarmupSeconds} s + ${round(config.uiWarmupSeconds, 1)} s UI + a ${config.warmupLapSeconds} s lap per craft and view per world, ${config.runWarmupSeconds} s per run`],
        ['Heap', report.environment.heap],
        ['Input', report.environment.hiddenGamepads.length > 0 ? `scripted only (${report.environment.hiddenGamepads.length} real gamepad(s) hidden)` : 'scripted only'],
        ['Finished', report.finishedAt ? new Date(report.finishedAt).toLocaleString() : '-'],
      ],
      criteria: report.criteria,
      sections,
      report,
      filename: `driftwing-flight-test-${report.environment.backend.toLowerCase()}-${report.sessionId}.json`,
      actions: [{ label: 'Run again', onClick: () => window.location.replace(urlFor(null, null)) }],
    });
  }

  function updateProgress(now) {
    if (now - lastProgressMs < 1000 / PROGRESS_HZ) return;
    lastProgressMs = now;
    const total = Math.max(plan.length, 1);
    // Automation (tools/run-harness.mjs) follows the run in flight between the full report updates.
    report.progress = { completedRuns: session.runs.length, totalRuns: plan.length, current: activeRun ? { ...activeRun.entry, seconds: runTime() } : null, phase };
    if (activeRun) {
      const elapsed = (now - activeRun.startMs) / 1000;
      const entry = activeRun.entry;
      const step = activeRun.stepLog.length > 0 ? activeRun.stepLog[activeRun.stepLog.length - 1].step : 'starting';
      panel.setProgress({
        label: `Run ${entry.index + 1} of ${plan.length}: ${entry.craft}, ${entry.view} person`,
        detail: `Seed ${entry.seed} · ${Math.floor(elapsed)} of ${activeRun.durationSeconds} s${elapsed < config.runWarmupSeconds ? ' (warmup)' : ''} · ${step}`,
        fraction: (entry.index + Math.min(elapsed / activeRun.durationSeconds, 1)) / total,
      });
    } else if (phase === 'worldWarmup') {
      panel.setProgress({ label: `World ${state.seed}: warming up`, detail: `${config.worldWarmupSeconds} s after load, then the warmup lap`, fraction: session.nextRun / total });
    } else if (phase === 'uiWarmup') {
      panel.setProgress({ label: `World ${state.seed}: UI warmup`, detail: `every time-of-day chip, a toast and the HUD fade, for ${round(config.uiWarmupSeconds, 1)} s (not measured)`, fraction: session.nextRun / total });
    } else if (phase === 'warmupLap') {
      const entry = lap.queue[lap.index];
      panel.setProgress({ label: `World ${state.seed}: warmup lap ${lap.index + 1} of ${lap.queue.length}`, detail: `${entry.craft}, ${entry.view} person, for ${config.warmupLapSeconds} s (not measured)`, fraction: session.nextRun / total });
    }
  }

  // ---- Frame -------------------------------------------------------------------------------------------
  function step(realDt) {
    const now = performance.now();
    const frameWork = profiler.takeFrame();
    // The used heap every frame (no forced GC): a drop across a slow frame marks a collection in it.
    const heapNowMB = heapAvailable() ? performance.memory.usedJSHeapSize / (1024 * 1024) : null;
    const heapDeltaMB = heapNowMB !== null && lastHeapMB !== null ? heapNowMB - lastHeapMB : null;
    lastHeapMB = heapNowMB;
    const frameMs = lastFrameMs === null ? null : now - lastFrameMs;
    lastFrameMs = now;
    if (phase === 'navigating') {
      if (!navigating) navigateToSeed(plan[session.nextRun].seed);
      return;
    }
    if (phase === 'finishing') {
      complete();
      return;
    }
    if (phase === 'complete' || phase === 'waitingForReady' || phase === 'loading') return;
    samplePose();
    sampleSpawns();
    if (phase === 'worldWarmup') {
      updateProgress(now);
      if ((now - worldReadyMs) / 1000 < config.worldWarmupSeconds) return;
      worldRecord.heapAtLoadMB = readHeapMB();
      startUiWarmup(now);
      return;
    }
    if (phase === 'uiWarmup') {
      updateProgress(now);
      if (stepUiWarmup(now)) startWarmupLap(now);
      return;
    }
    if (phase === 'warmupLap') {
      updateProgress(now);
      applyPilot();
      if ((now - lap.stepStartMs) / 1000 < config.warmupLapSeconds) return;
      if (lap.index + 1 < lap.queue.length) {
        switchLap(lap.index + 1, now);
        return;
      }
      worldRecord.heapBaselineMB = readHeapMB();
      phase = 'running';
      startRun(plan[session.nextRun]);
      return;
    }
    if (phase !== 'running' || !activeRun) return;
    const run = activeRun;
    const elapsed = (now - run.startMs) / 1000;
    if (frameMs !== null) {
      if (elapsed > config.runWarmupSeconds) {
        const detail = frameMs > config.frameLimitMs ? { startMs: now - frameMs, endMs: now, systemsMs: frameWork.systemsMs, top: frameWork.top, heapDeltaMB } : null;
        run.recorder.push(frameMs, elapsed - config.runWarmupSeconds, detail);
      } else {
        run.warmupFrames++;
        run.warmupMaxMs = Math.max(run.warmupMaxMs, frameMs);
      }
    }
    observe(run, Math.min(Math.max(realDt, 0), 0.1));
    run.cameraViews.add(camera().getView());
    if (!inPlannedView(run.entry)) run.viewMismatchFrames++;
    if (elapsed >= run.durationSeconds) {
      finishRun(run);
      const next = plan[session.nextRun];
      if (!next) {
        finishWorld();
        complete();
      } else if (next.seed !== state.seed) {
        finishWorld();
        phase = 'navigating';
        navigateToSeed(next.seed);
      } else {
        startRun(next);
      }
      return;
    }
    runScript(run, elapsed);
    applyPilot();
    updateProgress(now);
  }

  function abort(error) {
    const message = `flight test harness stopped: ${error && error.message ? error.message : error}`;
    session.harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    activeRun = null;
    releasePilot();
    phase = 'complete';
    session.status = 'complete';
    session.finishedAt = new Date().toISOString();
    flushConsole();
    saveSession();
    showSummary();
  }

  if (phase === 'complete') {
    // A reload of a finished session shows its summary again once the UI is up.
    delay(0).then(() => showSummary(), (error) => abort(error));
  } else {
    panel.setProgress({ label: 'Flight test starting', detail: `${plan.length} runs of ${config.runSeconds} s on ${config.seeds.length} seed(s), ${config.views.map((view) => `${view} person`).join(' and ')}`, fraction: session.nextRun / Math.max(plan.length, 1) });
  }

  return {
    update(simDt, realDt) {
      try {
        step(realDt);
      } catch (error) {
        abort(error);
      }
    },
    getReport() {
      return report;
    },
  };
}
