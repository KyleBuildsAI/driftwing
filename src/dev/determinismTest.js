// Determinism test (?test=determinism, dev builds only; main.js never loads it in production).
//
// Proves Milestone G item 3: the same seed and the same scripted path, flown twice in two page loads,
// give an identical site list and an identical director activation log.
//
// Each run (one page load, its own freshly deleted IndexedDB database, so the journal and settings
// start empty both times):
//   1. waits for the game to report ready, then stops the animation loop: from here every frame is
//      stepped by hand at FRAME_MS (window.DRIFTWING.debug), so frame times, the physics clock and
//      every per-frame counter are the same in both runs whatever the machine is doing;
//   2. fixes everything the director reads that would otherwise depend on the loading frames: the time
//      of day (held with the sun PATH_SUN_ELEVATION degrees up), the perf governor's frame time
//      (perf.simulateLoad, a steady 8 ms, so the director's frame-miss deferral never fires), the
//      quality level, the craft (the bush plane, at 100 % assists, in the chase view), and the flight
//      clock, which jumps to PATH_START_SECONDS so the regional weather, the director's ticks and its
//      log times line up. One frame is stepped at the new clock, so every value a system derives from
//      the clock for the next frame (the wind strength the clouds set) is the same in both runs;
//   3. restarts the spawns (spawns.debug.restartSpawns: every spawn ended, the SpawnManager's
//      discoveries, site sweep and visibility rotation reset, a new director on the current clock),
//      then puts the craft at the spawn on the autopilot, PATH_CLEARANCE above the highest ground
//      within reach of the path (a strike would end in a soft crash and a relaunch, which is not
//      the scripted path);
//   4. flies PATH_SECONDS of the scripted path (autopilot heading changes at fixed path times),
//      recording the director's activation log and its running hash, every spawnActivated, spawnEnded
//      and discovery with its frame, and a digest of the craft's position every second;
//   5. records the site-list hash of every site within SITE_RADIUS of the spawn and of the path's end
//      (version 2: with the sites' water bodies and region overlays), the same hash from a freshly
//      built world generator on the same seed, and a digest of the shared water query's heights on a
//      32 x 32 grid around the spawn at three flight times (ocean swell and local water bodies).
// The first run saves its record in sessionStorage and reloads the page; the second compares.
//
// Criteria: identical site-list hashes (live world, fresh world, both runs), an identical activation
// log (entries and hash) with at least MIN_ACTIVATIONS director activations in it, the path flown in
// both runs, 0 console errors and 0 warnings, no harness problems. The spawn event sequence and the
// path digest are compared and reported as evidence; they explain a log difference when there is one.
//
// Output: the on-screen summary panel (both runs side by side, JSON download) and
// window.DRIFTWING.testReport (tools/run-harness.mjs --test determinism).
import { hashSiteList } from '../world/placement.js';
import { createWorldGen } from '../world/worldgen.js';
import { installConsoleCapture } from './testConsole.js';
import { installMockGamepads } from './mockGamepads.js';
import { createTestPanel } from './testPanel.js';
import { readSession, removeSession, round, writeSession } from './testStats.js';

const DATABASE_PREFIX = 'driftwing-v2-test-determinism';
const SESSION_KEY = 'driftwing-v2.test.determinism';
const REPORT_KIND = 'driftwing-determinism-test';
const REPORT_VERSION = 1;
const RUN_COUNT = 2;
/** Stepped frame time (ms): 30 frames per second of flight. */
const FRAME_MS = 1000 / 30;
/** Frames stepped per macrotask; the page yields between batches so it stays responsive. */
const FRAMES_PER_BATCH = 15;
/** The flight clock (s) the scripted path starts at, in both runs. */
const PATH_START_SECONDS = 1200;
const PATH_SECONDS = 480;
/** Held time of day: mid-morning, the sun 40 degrees up. */
const PATH_SUN_ELEVATION = 40;
/**
 * The autopilot holds this much above the highest ground within PATH_REACH of the spawn, so the path
 * never meets the terrain and stays above the Phase 1 landmarks' discovery reach (200-260 m).
 */
const PATH_CLEARANCE = 450;
const PATH_REACH = 27000;
const PATH_GROUND_STEP = 400;
const PATH_SPEED = 55;
const PATH_CRAFT = 'bushplane';
/** Autopilot heading changes (degrees from the start heading) at path times (s). */
const PATH_TURNS = Object.freeze([
  Object.freeze({ at: 70, heading: 35 }),
  Object.freeze({ at: 150, heading: -40 }),
  Object.freeze({ at: 230, heading: 10 }),
  Object.freeze({ at: 320, heading: 75 }),
  Object.freeze({ at: 410, heading: -15 }),
]);
const SITE_RADIUS = 40000;
const MIN_ACTIVATIONS = 3;
const MAX_LISTED_EVENTS = 400;
const SIMULATED_FRAME_MS = 8;

/** Deletes an IndexedDB database; resolves with null or the reason it could not. */
function deleteDatabase(name) {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (error) {
      resolve(`could not delete ${name}: ${error.message}`);
      return;
    }
    request.onsuccess = () => resolve(null);
    request.onerror = () => resolve(`could not delete ${name}: ${request.error ? request.error.message : 'unknown error'}`);
    request.onblocked = () => resolve(`deleting ${name} was blocked by an open connection`);
  });
}

function newSessionId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a over a string, as 8 hex digits. */
function hashText(text) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The session this page load belongs to: the stored one (same id in the URL), or a new one. */
function loadSession(params) {
  const stored = readSession(SESSION_KEY);
  const requested = params.get('testSession');
  const session = stored.value;
  if (session && session.kind === REPORT_KIND && requested && session.id === requested) return { session, error: stored.error };
  return {
    session: {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      id: newSessionId(),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      runs: [],
      harnessErrors: stored.error ? [stored.error] : [],
    },
    error: null,
  };
}

/**
 * Called by main.js before boot: deletes this run's database (so the journal and settings start
 * empty in both runs), hides real gamepads, installs the console capture and returns the system.
 */
export async function prepareDeterminismTest({ params }) {
  const capture = installConsoleCapture();
  installMockGamepads();
  const { session } = loadSession(params);
  const runIndex = Math.min(session.runs.length, RUN_COUNT - 1);
  const databaseName = `${DATABASE_PREFIX}-${runIndex + 1}`;
  const deleteError = session.status === 'complete' ? null : await deleteDatabase(databaseName);
  if (deleteError) session.harnessErrors.push(deleteError);
  return {
    databaseName,
    createSystem: (ctx) => createDeterminismSystem(ctx, { capture, session }),
  };
}

function createDeterminismSystem(ctx, { capture, session }) {
  const { bus, state, world, settings } = ctx;
  const panel = createTestPanel({ title: 'Determinism test' });
  const report = {};
  const runIndex = session.runs.length;
  const totalFrames = Math.round((PATH_SECONDS * 1000) / FRAME_MS);
  let phase = session.status === 'complete' ? 'complete' : 'waiting for the game';
  let step = '';
  let framesDone = 0;
  let navigating = false;

  function saveSession() {
    const error = writeSession(SESSION_KEY, session);
    if (error) {
      session.harnessErrors.push(error);
      console.error(`[DRIFTWING test] ${error}`);
    }
  }

  function urlFor(sessionId) {
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set('testSession', sessionId);
    else url.searchParams.delete('testSession');
    return url.href;
  }

  // ---- Report ----------------------------------------------------------------------------------
  /** The first index where two lists differ (by their JSON lines), or -1. */
  function firstDifference(first, second) {
    const length = Math.max(first.length, second.length);
    for (let index = 0; index < length; index++) {
      if (JSON.stringify(first[index] ?? null) !== JSON.stringify(second[index] ?? null)) return index;
    }
    return -1;
  }

  function compare() {
    const [first, second] = session.runs;
    if (!first || !second) return null;
    const logDifference = firstDifference(first.log, second.log);
    const eventDifference = firstDifference(first.spawnEvents, second.spawnEvents);
    const pathDifference = firstDifference(first.pathSamples, second.pathSamples);
    return {
      siteListHash: first.siteListHash === second.siteListHash && first.siteListHash === first.freshSiteListHash && second.siteListHash === second.freshSiteListHash,
      pathEndSiteListHash: first.pathEndSiteListHash === second.pathEndSiteListHash,
      waterDigest: first.waterDigest === second.waterDigest,
      log: logDifference === -1 && first.logHash === second.logHash && first.logLength === second.logLength,
      logDifference: logDifference === -1 ? null : { index: logDifference, first: first.log[logDifference] ?? null, second: second.log[logDifference] ?? null },
      spawnEvents: eventDifference === -1,
      spawnEventDifference: eventDifference === -1 ? null : { index: eventDifference, first: first.spawnEvents[eventDifference] ?? null, second: second.spawnEvents[eventDifference] ?? null },
      startPose: JSON.stringify(first.startPose) === JSON.stringify(second.startPose),
      path: pathDifference === -1,
      pathDifference: pathDifference === -1 ? null : { second: pathDifference, first: first.pathSamples[pathDifference] ?? null, secondRun: second.pathSamples[pathDifference] ?? null },
    };
  }

  function criteria() {
    const runs = session.runs;
    const comparison = compare();
    const complete = session.status === 'complete';
    const pending = (label) => (complete ? 'fail' : label);
    const activations = runs.map((run) => run.directorActivations);
    const counts = capture.counts;
    const consoleErrors = runs.reduce((sum, run) => sum + run.console.errors, 0) + (complete ? 0 : counts.errors);
    const consoleWarnings = runs.reduce((sum, run) => sum + run.console.warnings, 0) + (complete ? 0 : counts.warnings);
    return [
      {
        id: 'sites', label: `Site-list hash (${SITE_RADIUS / 1000} km): both runs and a fresh world`,
        value: runs.map((run) => run.siteListHash).join(' / ') || 'pending',
        status: comparison ? (comparison.siteListHash && comparison.pathEndSiteListHash ? 'pass' : 'fail') : pending('muted'),
      },
      {
        id: 'water', label: 'Water heights (32 x 32 grid, three times) identical',
        value: runs.map((run) => run.waterDigest).join(' / ') || 'pending',
        status: comparison ? (comparison.waterDigest ? 'pass' : 'fail') : pending('muted'),
      },
      {
        id: 'log', label: 'Director activation log identical',
        value: runs.map((run) => `${run.logLength} entries, hash ${run.logHash}`).join(' / ') || 'pending',
        status: comparison ? (comparison.log ? 'pass' : 'fail') : pending('muted'),
      },
      {
        id: 'activations', label: `Director activations per run (>= ${MIN_ACTIVATIONS})`,
        value: activations.length > 0 ? activations.join(' / ') : 'pending',
        status: activations.length === 0 ? pending('muted') : activations.every((count) => count >= MIN_ACTIVATIONS) && (!complete || activations.length === RUN_COUNT) ? 'pass' : 'fail',
      },
      {
        id: 'path', label: 'Scripted path flown in full',
        value: runs.map((run) => `${run.frames} frames, ${run.distanceKm} km`).join(' / ') || 'pending',
        status: runs.length === 0 ? pending('muted') : runs.every((run) => run.frames === totalFrames) ? 'pass' : 'fail',
      },
      {
        id: 'console', label: 'Console errors / warnings',
        value: `${consoleErrors} / ${consoleWarnings}`,
        status: consoleErrors === 0 && consoleWarnings === 0 ? 'pass' : 'fail',
      },
      {
        id: 'spawnEvents', label: 'Spawn events identical (evidence)',
        value: runs.map((run) => `${run.spawnEventCount} events, hash ${run.spawnEventsHash}`).join(' / ') || 'pending',
        status: comparison ? (comparison.spawnEvents ? 'pass' : 'fail') : pending('muted'),
      },
      {
        id: 'pathDigest', label: 'Flown path identical (evidence)',
        value: runs.map((run) => run.pathHash).join(' / ') || 'pending',
        status: comparison ? (comparison.path ? 'pass' : 'fail') : pending('muted'),
      },
    ];
  }

  function publish() {
    const list = criteria();
    const complete = session.status === 'complete';
    const failed = list.some((entry) => entry.status === 'fail') || session.harnessErrors.length > 0;
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status: complete ? 'complete' : 'running',
      result: complete ? (failed ? 'FAIL' : 'PASS') : null,
      sessionId: session.id,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      progress: { done: session.runs.length * totalFrames + framesDone, total: RUN_COUNT * totalFrames, phase, step },
      environment: {
        backend: ctx.backend,
        backends: [...new Set(session.runs.map((run) => run.backend).concat(ctx.backend))],
        revision: ctx.THREE.REVISION,
        userAgent: navigator.userAgent,
        seed: state.seed,
      },
      config: {
        seed: state.seed,
        runs: RUN_COUNT,
        frameMs: round(FRAME_MS, 3),
        pathSeconds: PATH_SECONDS,
        pathStartSeconds: PATH_START_SECONDS,
        sunElevation: PATH_SUN_ELEVATION,
        craft: PATH_CRAFT,
        clearanceM: PATH_CLEARANCE,
        reachM: PATH_REACH,
        speed: PATH_SPEED,
        turns: PATH_TURNS,
        siteRadius: SITE_RADIUS,
        minActivations: MIN_ACTIVATIONS,
        simulatedFrameMs: SIMULATED_FRAME_MS,
      },
      criteria: list,
      comparison: compare(),
      runs: session.runs,
      console: capture.entries.slice(0, 100),
      harnessErrors: session.harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function progress(label, detail) {
    step = detail;
    capture.setContext(`determinism run ${runIndex + 1}: ${detail}`);
    panel.setProgress({ label, detail, fraction: (session.runs.length * totalFrames + framesDone) / (RUN_COUNT * totalFrames) });
    publish();
  }

  // ---- The run -----------------------------------------------------------------------------------
  const yieldToPage = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  /** Fixes the time of day, the perf governor's frame time, the quality level and the craft. */
  function holdConditions() {
    settings.set('timeFrozen', true);
    settings.set('quality', 'high');
    settings.set('craft', PATH_CRAFT);
    settings.update('assists', { [PATH_CRAFT]: 1 });
    settings.update('views', { [PATH_CRAFT]: 'chase' });
    ctx.perf.simulateLoad({ baseMs: SIMULATED_FRAME_MS, scaledMs: 0 });
    ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(PATH_SUN_ELEVATION, false), { transition: 0 });
    if (ctx.systems.flight.getCraft() !== PATH_CRAFT) throw new Error(`asked for the ${PATH_CRAFT}, flying ${ctx.systems.flight.getCraft()}`);
  }

  /** The path's altitude (m above sea level): PATH_CLEARANCE above the highest ground within PATH_REACH. */
  function pathAltitude() {
    const spawn = state.spawn;
    let highest = world.WATER_LEVEL;
    for (let offsetZ = -PATH_REACH; offsetZ <= PATH_REACH; offsetZ += PATH_GROUND_STEP) {
      for (let offsetX = -PATH_REACH; offsetX <= PATH_REACH; offsetX += PATH_GROUND_STEP) {
        if (offsetX * offsetX + offsetZ * offsetZ > PATH_REACH * PATH_REACH) continue;
        highest = Math.max(highest, world.groundHeight(spawn.x + offsetX, spawn.z + offsetZ));
      }
    }
    return Math.round(highest + PATH_CLEARANCE);
  }

  /** Puts the craft at the start of the path on the autopilot. */
  function placeCraft(altitude) {
    const spawn = state.spawn;
    if (!ctx.systems.flight.resetTo({ x: spawn.x, y: altitude, z: spawn.z, heading: spawn.heading })) throw new Error('the flight system refused the start pose');
    ctx.systems.flight.setAutopilot({ enabled: true, heading: spawn.heading, altitude, speed: PATH_SPEED, followWaypoint: false, reason: 'determinism test' });
  }

  /** The craft's position and velocity to 1 mm (and 1 mm/s): evidence that both runs start alike. */
  function describePose() {
    const { position, velocity } = state.player;
    return { position: [round(position.x, 3), round(position.y, 3), round(position.z, 3)], velocity: [round(velocity.x, 3), round(velocity.y, 3), round(velocity.z, 3)] };
  }

  /** The water query's heights (to 1 mm) on a 32 x 32 grid of 96 m around the spawn at three flight times. */
  function waterDigest() {
    const spawn = state.spawn;
    const lines = [];
    for (const time of [0, 37.5, 120]) {
      for (let row = 0; row < 32; row++) {
        for (let column = 0; column < 32; column++) {
          const height = ctx.waterQuery.heightAt(spawn.x + (column - 15.5) * 96, spawn.z + (row - 15.5) * 96, time);
          lines.push(height === -Infinity ? '-' : String(Math.round(height * 1000)));
        }
      }
    }
    return hashText(lines.join(','));
  }

  function siteHashes() {
    const spawn = state.spawn;
    const live = world.sitesNear(spawn.x, spawn.z, SITE_RADIUS);
    const fresh = createWorldGen(state.seed, ctx.worldOptions);
    return {
      siteListVersion: 2,
      siteListHash: hashSiteList(live), siteCount: live.length, freshSiteListHash: hashSiteList(fresh.sitesNear(spawn.x, spawn.z, SITE_RADIUS)),
      waterDigest: waterDigest(),
    };
  }

  async function flyPath() {
    const stepper = window.DRIFTWING && window.DRIFTWING.debug;
    if (!stepper || typeof stepper.stepFrames !== 'function') throw new Error('the frame stepper (window.DRIFTWING.debug) is missing');
    phase = 'setup';
    progress(`Run ${runIndex + 1} of ${RUN_COUNT}`, 'holding the conditions and placing the craft');
    stepper.pauseLoop();
    holdConditions();
    if (state.time.elapsed >= PATH_START_SECONDS) throw new Error(`the flight clock is already at ${round(state.time.elapsed, 1)} s, past the path start (${PATH_START_SECONDS} s)`);
    const sites = siteHashes();
    const altitude = pathAltitude();
    state.time.elapsed = PATH_START_SECONDS;
    stepper.resetTiming();
    stepper.stepFrames(1, FRAME_MS);
    // Spawns first: the start pose's velocity carries the wind at the start, wind sources included.
    const director = ctx.systems.spawns.debug.restartSpawns();
    if (!director) throw new Error('the director did not restart');
    placeCraft(altitude);
    const startPose = describePose();
    stepper.resetTiming();

    const spawnEvents = [];
    const pathSamples = [];
    const offActivated = bus.onTyped('spawnActivated', (payload) => {
      if (spawnEvents.length < MAX_LISTED_EVENTS) spawnEvents.push({ frame: framesDone, event: 'activated', presetId: payload.presetId, kind: payload.kind, x: round(payload.position.x, 2), z: round(payload.position.z, 2) });
    });
    const offEnded = bus.onTyped('spawnEnded', (payload) => {
      if (spawnEvents.length < MAX_LISTED_EVENTS) spawnEvents.push({ frame: framesDone, event: 'ended', presetId: payload.presetId, reason: payload.reason });
    });
    const offDiscovery = bus.onTyped('discovery', (payload) => {
      if (spawnEvents.length < MAX_LISTED_EVENTS) spawnEvents.push({ frame: framesDone, event: 'discovery', id: payload.id, presetId: payload.presetId ?? null });
    });
    const framesPerSecond = Math.round(1000 / FRAME_MS);
    let turnIndex = 0;
    let distance = 0;
    let lastX = state.player.position.x;
    let lastZ = state.player.position.z;
    const startHeading = state.spawn.heading;
    phase = 'flying';
    try {
      while (framesDone < totalFrames) {
        const pathSeconds = framesDone / framesPerSecond;
        while (turnIndex < PATH_TURNS.length && PATH_TURNS[turnIndex].at <= pathSeconds) {
          ctx.systems.flight.setAutopilot({ enabled: true, heading: startHeading + PATH_TURNS[turnIndex].heading, reason: 'determinism test' });
          turnIndex++;
        }
        const batch = Math.min(FRAMES_PER_BATCH, totalFrames - framesDone);
        for (let index = 0; index < batch; index++) {
          stepper.stepFrames(1, FRAME_MS);
          framesDone++;
          const position = state.player.position;
          distance += Math.hypot(position.x - lastX, position.z - lastZ);
          lastX = position.x;
          lastZ = position.z;
          if (framesDone % framesPerSecond === 0) pathSamples.push(`${round(position.x, 3)},${round(position.y, 3)},${round(position.z, 3)}`);
        }
        if (framesDone % (framesPerSecond * 5) < FRAMES_PER_BATCH) {
          progress(`Run ${runIndex + 1} of ${RUN_COUNT}: flying the path`, `${Math.floor(framesDone / framesPerSecond)} of ${PATH_SECONDS} s, ${director.getState().logLength} activations`);
        }
        await yieldToPage();
      }
    } finally {
      offActivated();
      offEnded();
      offDiscovery();
    }
    const directorState = director.getState();
    const log = director.getLog();
    const end = state.player.position;
    const pathEnd = world.sitesNear(end.x, end.z, SITE_RADIUS);
    return {
      run: runIndex + 1,
      backend: ctx.backend,
      finishedAt: new Date().toISOString(),
      frames: framesDone,
      altitude,
      startPose,
      distanceKm: round(distance / 1000, 2),
      ...sites,
      pathEndSiteListHash: hashSiteList(pathEnd),
      pathEndSiteCount: pathEnd.length,
      log,
      logLength: directorState.logLength,
      logHash: directorState.logHash,
      directorActivations: log.filter((entry) => entry.reason !== 'debug').length,
      directorTicks: directorState.ticks,
      notables: directorState.notables,
      spawnEvents,
      spawnEventCount: spawnEvents.length,
      spawnEventsHash: hashText(JSON.stringify(spawnEvents)),
      pathSamples,
      pathHash: hashText(pathSamples.join(';')),
      finalPosition: { x: round(end.x, 3), y: round(end.y, 3), z: round(end.z, 3) },
      console: { errors: capture.counts.errors, warnings: capture.counts.warnings },
    };
  }

  function restoreLoop() {
    const stepper = window.DRIFTWING && window.DRIFTWING.debug;
    ctx.perf.simulateLoad(null);
    if (stepper) stepper.resumeLoop();
  }

  async function run() {
    const record = await flyPath();
    session.runs.push(record);
    phase = 'between runs';
    if (session.runs.length < RUN_COUNT) {
      progress(`Run ${runIndex + 1} of ${RUN_COUNT} done`, 'reloading the page for the next run');
      saveSession();
      navigating = true;
      window.location.replace(urlFor(session.id));
      return;
    }
    finish();
  }

  // ---- Summary -----------------------------------------------------------------------------------
  function showSummary() {
    publish();
    const comparison = report.comparison;
    const logRows = [];
    const longest = Math.max(0, ...session.runs.map((entry) => entry.log.length));
    for (let index = 0; index < longest; index++) {
      const first = session.runs[0]?.log[index];
      const second = session.runs[1]?.log[index];
      const same = JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
      const cell = (entry) => (entry ? `${round(entry.time - PATH_START_SECONDS, 1)} s ${entry.presetId} (${entry.reason})` : '-');
      logRows.push({ index: index + 1, first: cell(first), second: { text: cell(second), status: same ? null : 'fail' }, candidate: first ? first.candidateId : second ? second.candidateId : '-', same: { text: same ? 'same' : 'DIFFERENT', status: same ? 'pass' : 'fail' } });
    }
    const notes = [];
    if (comparison && comparison.logDifference) notes.push(`First log difference at entry ${comparison.logDifference.index + 1}: ${JSON.stringify(comparison.logDifference.first)} against ${JSON.stringify(comparison.logDifference.second)}`);
    if (comparison && comparison.spawnEventDifference) notes.push(`First spawn event difference at #${comparison.spawnEventDifference.index + 1}: ${JSON.stringify(comparison.spawnEventDifference.first)} against ${JSON.stringify(comparison.spawnEventDifference.second)}`);
    if (comparison && !comparison.startPose) notes.push(`The start poses differ: ${JSON.stringify(session.runs[0].startPose)} against ${JSON.stringify(session.runs[1].startPose)}`);
    if (comparison && comparison.pathDifference) notes.push(`The flown paths part at second ${comparison.pathDifference.second + 1}: ${comparison.pathDifference.first} against ${comparison.pathDifference.secondRun}`);
    panel.showSummary({
      result: report.result,
      subtitle: `Seed ${state.seed} · ${RUN_COUNT} page loads · ${PATH_SECONDS} s path stepped at ${Math.round(1000 / FRAME_MS)} fps · ${ctx.backend}`,
      meta: [
        ['Backend', report.environment.backends.join(', ')],
        ['three.js', `r${ctx.THREE.REVISION}`],
        ['Seed', state.seed],
        ['Craft', `${PATH_CRAFT}, ${session.runs.map((entry) => `${entry.altitude} m`).join(' / ')} above sea level, ${PATH_SPEED} m/s`],
        ['Sites', session.runs.map((entry) => `${entry.siteCount} within ${SITE_RADIUS / 1000} km`).join(' / ')],
        ['Console', `${capture.counts.errors} errors, ${capture.counts.warnings} warnings (this load)`],
      ],
      criteria: report.criteria,
      sections: [
        {
          title: 'Director activation log',
          table: {
            columns: [
              { key: 'index', label: '#', numeric: true },
              { key: 'first', label: 'Run 1' },
              { key: 'second', label: 'Run 2' },
              { key: 'candidate', label: 'Candidate' },
              { key: 'same', label: 'Compared' },
            ],
            rows: logRows,
          },
        },
        {
          title: 'Runs',
          table: {
            columns: [
              { key: 'run', label: 'Run', numeric: true },
              { key: 'sites', label: 'Site-list hash' },
              { key: 'fresh', label: 'Fresh world' },
              { key: 'end', label: 'Path end' },
              { key: 'log', label: 'Log hash' },
              { key: 'events', label: 'Spawn events' },
              { key: 'path', label: 'Path digest' },
              { key: 'ticks', label: 'Ticks', numeric: true },
            ],
            rows: session.runs.map((entry) => ({
              run: entry.run,
              sites: entry.siteListHash,
              fresh: entry.freshSiteListHash,
              end: entry.pathEndSiteListHash,
              log: `${entry.logHash} (${entry.logLength})`,
              events: `${entry.spawnEventsHash} (${entry.spawnEventCount})`,
              path: `${entry.pathHash} (${entry.distanceKm} km)`,
              ticks: entry.directorTicks,
            })),
          },
        },
        ...(notes.length > 0 ? [{ title: 'Differences', notes }] : []),
        ...(capture.entries.length > 0 ? [{ title: 'Console errors and warnings', notes: capture.entries.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) }] : []),
        ...(session.harnessErrors.length > 0 ? [{ title: 'Harness problems', notes: session.harnessErrors.slice() }] : []),
        { title: 'About', notes: [
          `Each run is its own page load with a freshly deleted database. Frames are stepped by hand at ${round(FRAME_MS, 2)} ms, the time of day is held (sun ${PATH_SUN_ELEVATION} degrees), the perf governor reads a steady ${SIMULATED_FRAME_MS} ms frame, the flight clock jumps to ${PATH_START_SECONDS} s and one frame is stepped there before spawns.debug.restartSpawns() starts a fresh director.`,
          `The ${PATH_CRAFT} flies the autopilot from the spawn, ${PATH_CLEARANCE} m above the highest ground within ${PATH_REACH / 1000} km, at ${PATH_SPEED} m/s, turning ${PATH_TURNS.map((turn) => `to ${turn.heading > 0 ? '+' : ''}${turn.heading} degrees at ${turn.at} s`).join(', ')}.`,
          'Log times are seconds from the start of the path. The spawn events (activations, ends, discoveries with their frames) and the path digest (the craft position every second, to 1 mm) are evidence: they show where two runs part when the logs differ.',
        ] },
      ],
      report,
      filename: `driftwing-determinism-test-${ctx.backend.toLowerCase()}-${session.id}.json`,
      actions: [{ label: 'Run again', onClick: () => {
        const error = removeSession(SESSION_KEY);
        if (error) console.error(`[DRIFTWING test] ${error}`);
        window.location.replace(urlFor(null));
      } }],
    });
  }

  function finish() {
    phase = 'complete';
    step = '';
    session.status = 'complete';
    session.finishedAt = new Date().toISOString();
    saveSession();
    restoreLoop();
    showSummary();
  }

  function abort(error) {
    const message = `determinism test stopped during ${phase} (${step}): ${error && error.message ? error.message : error}`;
    session.harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    finish();
  }

  bus.on('game:ready', () => {
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
    if (session.status === 'complete') {
      showSummary();
      return;
    }
    const url = urlFor(session.id);
    if (url !== window.location.href) window.history.replaceState(null, '', url);
    saveSession();
    publish();
    // Out of the frame that announced ready: the run steps frames itself.
    setTimeout(() => {
      run().catch(abort);
    }, 0);
  });
  panel.setProgress({ label: 'Determinism test', detail: session.status === 'complete' ? 'showing the last result' : `run ${runIndex + 1} of ${RUN_COUNT}: waiting for the game`, fraction: session.runs.length / RUN_COUNT });
  publish();

  return {
    update() {},
    getReport() {
      return report;
    },
    /** True while the page is reloading for the next run. */
    get navigating() {
      return navigating;
    },
  };
}
