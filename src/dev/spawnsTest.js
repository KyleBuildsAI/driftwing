// Spawns test (?test=spawns, dev builds only; main.js never loads it in production).
//
// Proves Milestone G item 2 on whichever backend runs (WebGPU, or WebGL2 with ?renderer=webgl): a
// scripted flight force-spawns each of the 30 presets ahead of the craft, at a time of day and in
// weather that suit it (src/dev/spawnScenarios.js), shows it, and proves it gives back what it took.
//
// The game's own presets are held out of the SpawnManager and its site feed is detached for the whole
// test (spawns.debug.holdGamePresets), so live sites and director events never move a baseline; each
// preset (and a set piece's child presets) goes back into the manager for its own show only. Per preset:
//   1. the held time of day and regional weather of its scenario;
//   2. the anchor: the preset's nearest REAL placed site, with its terrain stamps, for a site preset;
//      a spot of land, open water or coastal water near the start, or a working thermal, for an event;
//      the craft itself for a sky-anchored event. The craft is placed `distance` metres short of it on
//      the autopilot, heading at it, and the terrain is let settle;
//   3. cycle 1 (the show): the baselines (JS heap after a forced GC, renderer.info.memory geometries and
//      textures, the wind source ids, the sky modifier count, the real lights in use), then the spawn
//      is created through the SpawnManager's debug path (source 'debug', the dev debugger's force
//      spawn), the craft flies `runSeconds` toward it while every frame time is recorded (fps, p99,
//      worst frame, draw calls), a staging step runs where the scenario names one, the photo camera
//      frames it and the screenshot is taken (tools/run-harness.mjs takes it, with ?testShots=1), and
//      the spawn is disposed;
//   4. the leak check: from the same start, in photo mode (the simulation and the camera held, so no
//      terrain streams and nothing else moves the heap), one held create and dispose as a warm-up (a
//      one-time cache it keeps is reported, not judged), then LEAK_CYCLES more (?testLeakCycles=N),
//      each drawn for LEAK_CYCLE_FRAMES frames, with the heap read after each (the trend).
//   After the show and after the leak check: GPU memory back (no geometry an engine created is still
//   alive, the geometry count moved by no more than the world's own first draws, which the geometry
//   tracker tells apart, and the texture count exactly back), every wind source the spawn added
//   removed, the sky modifiers and real lights back to their counts, no leak reported by the
//   SpawnManager. Across the leak check the JS heap (read after two forced collections) must stay
//   within HEAP_TOLERANCE_MB of its baseline: a spawn that kept even a third of a megabyte per create
//   fails it. The show itself is not judged on the heap: a first create builds the shared pipelines and
//   caches it leaves behind on purpose, and the craft flies through streaming terrain.
// Criteria: 30 / 30 presets spawned, GPU memory, wind sources, lights and sky modifiers back after
// every dispose, the heap within tolerance across every leak check, 0 console errors and 0 warnings, every
// screenshot taken (with ?testShots=1), no harness problems. Frame times are reported, not judged.
//
// Output: the on-screen summary panel (one row per preset, JSON download) and
// window.DRIFTWING.testReport (tools/run-harness.mjs --test spawns). The test runs in its own
// IndexedDB database (deleted at the start, so every discovery is a first one) and changes no
// player setting.
import { installConsoleCapture } from './testConsole.js';
import { installMockGamepads } from './mockGamepads.js';
import { createTestPanel } from './testPanel.js';
import { createFrameRecorder, gcAvailable, heapAvailable, round } from './testStats.js';
import { createDisposeCheck, createFraming, frames, holdConditions, settledHeapMB, wait } from './spawnCheckKit.js';
import { SPAWN_SCENARIOS } from './spawnScenarios.js';
import { PRESETS } from '../spawns/presets/index.js';

const DATABASE_NAME = 'driftwing-v2-test-spawns';
const REPORT_KIND = 'driftwing-spawns-test';
const REPORT_VERSION = 1;
/** The craft every preset is shown from (a steady powered aircraft on the autopilot). */
const TEST_CRAFT = 'bushplane';
const DEFAULT_ALTITUDE = 150;
const DEFAULT_SPEED = 55;
const DEFAULT_RUN_SECONDS = 4;
/** The leak check: this many held creates and disposes after its warm-up, each drawn LEAK_CYCLE_FRAMES frames. */
const LEAK_CYCLES = 3;
const LEAK_CYCLE_FRAMES = 45;
/** The most leak cycles ?testLeakCycles= may ask for (a longer trend when a preset is in doubt). */
const MAX_LEAK_CYCLES = 30;
/** A warm-up that keeps more than this (MB) is listed in the notes (it is not judged). */
const WARMUP_NOTE_MB = 0.5;
/** JS heap tolerance across the leak check (MB above its baseline, after all LEAK_CYCLES). */
const HEAP_TOLERANCE_MB = 1;
/** A preset's real site is used when one lies within this distance of the start (m). */
const SITE_SEARCH_RADIUS = 60000;
/** Surface spots are searched for out to this distance from the start (m), in rings this far apart. */
const SPOT_SEARCH_RADIUS = 30000;
const SPOT_RING_STEP = 500;
/** A land spot is lowland: at most this high (m above sea level) with this little relief within its reach. */
const LOWLAND_MAX_HEIGHT = 350;
const LOWLAND_REACH = 500;
const LOWLAND_RELIEF = 90;
const FRAME_LIMIT_MS = 50;
/** How long the page waits for tools/run-harness.mjs to take a screenshot (s). */
const SHOT_TIMEOUT_S = 90;
/** The eagle settles into its wing slot this long after its join call (s). */
const WINGMAN_SETTLE_S = 5;
/** Without the runner (a person watching), each framed preset is held this long (s). */
const SHOT_HOLD_S = 1.5;

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

/**
 * Called by main.js before boot: deletes the test database (every discovery is then a first one),
 * hides real gamepads, installs the console capture and returns the system factory.
 */
export async function prepareSpawnsTest({ params }) {
  const capture = installConsoleCapture();
  installMockGamepads();
  const deleteError = await deleteDatabase(DATABASE_NAME);
  return {
    databaseName: DATABASE_NAME,
    createSystem: (ctx) => createSpawnsTestSystem(ctx, { params, capture, deleteError }),
  };
}

function createSpawnsTestSystem(ctx, { params, capture, deleteError }) {
  const { bus, state, world, settings } = ctx;
  const framing = createFraming(ctx);
  const panel = createTestPanel({ title: 'Spawns test' });
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const THREE = ctx.THREE;
  const shotsWanted = params.get('testShots') === '1';
  const requestedCycles = Number.parseInt(params.get('testLeakCycles') ?? '', 10);
  const leakCycles = Number.isInteger(requestedCycles) && requestedCycles >= 1 ? Math.min(requestedCycles, MAX_LEAK_CYCLES) : LEAK_CYCLES;
  const only = (params.get('testPresets') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const scenarios = SPAWN_SCENARIOS.filter((scenario) => only.length === 0 || only.includes(scenario.id));
  const presetById = new Map(PRESETS.map((preset) => [preset.id, preset]));
  const report = {};
  const rows = [];
  const harnessErrors = deleteError ? [deleteError] : [];
  const startedAt = new Date().toISOString();
  const spotCache = new Map();
  /** The dispose check (spawnCheckKit.js), created when the run starts. */
  let dispose = null;
  let finishedAt = null;
  let status = 'running';
  let phase = 'waiting for the game';
  let step = '';
  let heldPresets = [];
  let detachedFeed = null;
  let timeFrozenBefore = settings.get('timeFrozen');
  /** The frame recorder of the live window, or null outside it. */
  let recording = null;
  let lastFrameMs = null;
  /** The screenshot the runner should take now: { token, name, presetId } or null. */
  let pendingShot = null;
  let shotSerial = 0;
  const shotWaiters = new Map();

  const ground = (x, z) => Math.max(world.groundHeight(x, z), world.WATER_LEVEL);

  // ---- Report ----------------------------------------------------------------------------------
  function criteria() {
    const complete = status === 'complete';
    const total = scenarios.length;
    const count = (test) => rows.filter(test).length;
    const done = rows.length;
    const ratio = (passed, of = done) => `${passed} / ${of}`;
    const allOf = (passed) => (done === 0 ? (complete ? 'fail' : 'muted') : passed === done && (!complete || done === total) ? 'pass' : 'fail');
    const spawned = count((row) => row.spawned);
    const gpu = count((row) => row.cycles.length === 2 && row.cycles.every((cycle) => cycle.gpuOk));
    const heap = count((row) => row.cycles.length === 2 && row.cycles[1].heapOk);
    const wind = count((row) => row.cycles.length === 2 && row.cycles.every((cycle) => cycle.windOk));
    const other = count((row) => row.cycles.length === 2 && row.cycles.every((cycle) => cycle.lightsOk && cycle.skyOk && cycle.leaksOk));
    const shots = count((row) => Boolean(row.shot && row.shot.taken));
    const counts = capture.counts;
    const fpsRows = rows.filter((row) => Number.isFinite(row.frames.avgFps));
    const list = [
      { id: 'spawned', label: 'Presets force-spawned ahead of the craft', value: ratio(spawned, total), status: allOf(spawned) },
      { id: 'gpu', label: 'GPU memory back after every dispose (geometries, textures)', value: ratio(gpu), status: allOf(gpu) },
      { id: 'heap', label: `JS heap within ${HEAP_TOLERANCE_MB} MB after ${leakCycles} more creates and disposes`, value: heapAvailable() ? ratio(heap) : 'unavailable', status: heapAvailable() ? allOf(heap) : 'muted' },
      { id: 'wind', label: 'Wind sources removed after every dispose', value: ratio(wind), status: allOf(wind) },
      { id: 'other', label: 'Real lights, sky modifiers and leak counters back', value: ratio(other), status: allOf(other) },
      { id: 'console', label: 'Console errors / warnings', value: `${counts.errors} / ${counts.warnings}`, status: counts.errors === 0 && counts.warnings === 0 ? 'pass' : 'fail' },
      shotsWanted
        ? { id: 'shots', label: 'Screenshots taken', value: ratio(shots, total), status: allOf(shots) }
        : { id: 'shots', label: 'Screenshots taken', value: 'not requested (?testShots=1)', status: 'muted' },
      {
        id: 'fps', label: 'Frame rate while each spawn is live (reported, not judged)',
        value: fpsRows.length > 0 ? `lowest avg ${Math.min(...fpsRows.map((row) => row.frames.avgFps))} fps, worst p99 ${Math.max(...fpsRows.map((row) => row.frames.p99Ms))} ms` : 'pending',
        status: 'info',
      },
    ];
    return list;
  }

  function publish() {
    const list = criteria();
    const failed = list.some((entry) => entry.status === 'fail') || harnessErrors.length > 0;
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status,
      result: status === 'complete' ? (failed ? 'FAIL' : 'PASS') : null,
      startedAt,
      finishedAt,
      progress: { done: rows.length, total: scenarios.length, phase, step, shot: pendingShot },
      environment: {
        backend: ctx.backend,
        backends: [ctx.backend],
        revision: ctx.THREE.REVISION,
        userAgent: navigator.userAgent,
        seed: state.seed,
        heap: heapAvailable() ? (gcAvailable() ? 'performance.memory after a forced GC' : 'performance.memory (no forced GC: start Chrome with --js-flags=--expose-gc)') : 'unavailable',
        geometryTracker: Boolean(dispose && dispose.tracker),
      },
      config: {
        craft: TEST_CRAFT,
        heapToleranceMB: HEAP_TOLERANCE_MB,
        leakCycles,
        leakCycleFrames: LEAK_CYCLE_FRAMES,
        siteSearchRadius: SITE_SEARCH_RADIUS,
        frameLimitMs: FRAME_LIMIT_MS,
        shots: shotsWanted,
        presets: scenarios.map((scenario) => scenario.id),
      },
      criteria: list,
      presets: rows,
      console: capture.entries.slice(0, 200),
      harnessErrors: harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function progress(label, detail) {
    step = detail;
    panel.setProgress({ label, detail, fraction: scenarios.length > 0 ? rows.length / scenarios.length : 0 });
    publish();
  }

  // ---- Where each preset stands -----------------------------------------------------------------------
  function isWater(x, z, depth) {
    return world.groundHeight(x, z) < world.WATER_LEVEL - depth;
  }

  function isLand(x, z, above) {
    return world.groundHeight(x, z) > world.WATER_LEVEL + above;
  }

  /** True when every point `reach` metres around (x, z) passes test (8 compass points). */
  function ringAll(x, z, reach, test) {
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      if (!test(x + Math.sin(angle) * reach, z - Math.cos(angle) * reach)) return false;
    }
    return true;
  }

  function ringAny(x, z, reach, test) {
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      if (test(x + Math.sin(angle) * reach, z - Math.cos(angle) * reach)) return true;
    }
    return false;
  }

  /** Lowland: open, gently rolling country (fields and meadows), where weather and wildlife read best. */
  function isLowland(x, z) {
    const height = world.groundHeight(x, z);
    if (height < world.WATER_LEVEL + 15 || height > world.WATER_LEVEL + LOWLAND_MAX_HEIGHT) return false;
    let low = height;
    let high = height;
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      const sample = world.groundHeight(x + Math.sin(angle) * LOWLAND_REACH, z - Math.cos(angle) * LOWLAND_REACH);
      low = Math.min(low, sample);
      high = Math.max(high, sample);
    }
    return low > world.WATER_LEVEL + 5 && high - low < LOWLAND_RELIEF;
  }

  const SURFACE_TESTS = Object.freeze({
    land: isLowland,
    water: (x, z) => isWater(x, z, 6) && ringAll(x, z, 700, (px, pz) => isWater(px, pz, 2)),
    coast: (x, z) => isWater(x, z, 4) && ringAll(x, z, 250, (px, pz) => isWater(px, pz, 1)) && ringAny(x, z, 1400, (px, pz) => isLand(px, pz, 5)),
  });

  /** The nearest spot of a surface kind to the start ({ x, z }), searched ring by ring; cached. */
  function surfaceSpot(kind) {
    if (spotCache.has(kind)) return spotCache.get(kind);
    const test = SURFACE_TESTS[kind];
    if (!test) throw new Error(`unknown surface "${kind}"`);
    const origin = state.spawn;
    let found = null;
    for (let radius = 0; radius <= SPOT_SEARCH_RADIUS && !found; radius += SPOT_RING_STEP) {
      const steps = Math.max(1, Math.round((2 * Math.PI * radius) / SPOT_RING_STEP));
      for (let index = 0; index < steps && !found; index++) {
        const angle = (index / steps) * Math.PI * 2;
        const x = origin.x + Math.sin(angle) * radius;
        const z = origin.z - Math.cos(angle) * radius;
        if (test(x, z)) found = { x, z };
      }
    }
    if (!found) throw new Error(`no ${kind} within ${SPOT_SEARCH_RADIUS / 1000} km of the start`);
    spotCache.set(kind, found);
    return found;
  }

  /** The nearest working thermal from the land spot outward: { x, z } 200 m off its core. */
  function thermalSpot() {
    const land = surfaceSpot('land');
    const probe = new THREE.Vector3();
    for (let radius = 0; radius <= 12000; radius += 1500) {
      for (let index = 0; index < Math.max(1, radius / 1500 * 6); index++) {
        const angle = (index / Math.max(1, radius / 1500 * 6)) * Math.PI * 2;
        probe.set(land.x + Math.sin(angle) * radius, 0, land.z - Math.cos(angle) * radius);
        const thermal = ctx.wind.nearestThermal(probe, 1.2);
        if (thermal) return { x: thermal.x + 200, z: thermal.z, thermal: { x: Math.round(thermal.x), z: Math.round(thermal.z), strength: round(thermal.strength, 2) } };
      }
    }
    throw new Error('no working thermal within 12 km of the land spot');
  }

  /** The nearest real site of presetId within SITE_SEARCH_RADIUS of the start, or null. */
  function realSite(presetId) {
    const origin = state.spawn;
    let best = null;
    for (const site of world.sitesNear(origin.x, origin.z, SITE_SEARCH_RADIUS)) {
      if (site.presetId !== presetId) continue;
      if (!best || Math.hypot(site.x - origin.x, site.z - origin.z) < Math.hypot(best.x - origin.x, best.z - origin.z)) best = site;
    }
    return best;
  }

  /** Where a site's stamp puts its point of interest: a volcano's peak, a waterfall's lip. */
  function siteFocus(site) {
    const stamp = site.stamps && site.stamps.length > 0 ? site.stamps[0] : null;
    if (stamp && Number.isFinite(stamp.lipX)) return { x: stamp.lipX, y: stamp.topY, z: stamp.lipZ };
    if (stamp && Number.isFinite(stamp.peakY)) return { x: site.x, y: stamp.peakY, z: site.z };
    return { x: site.x, y: site.groundY, z: site.z };
  }

  /** The scenario's anchor: { kind, x, z, y, site? , note }. */
  function resolveAnchor(scenario, preset) {
    if (scenario.anchor === 'sky') return { kind: 'sky' };
    if (scenario.anchor === 'site') {
      const site = realSite(preset.id);
      if (site) {
        const focus = siteFocus(site);
        return { kind: 'site', x: site.x, z: site.z, y: site.groundY, site, focus, note: `real site ${site.id} (${site.stamps.map((stamp) => stamp.type).join(', ') || 'no stamps'})` };
      }
      const surface = preset.placement && preset.placement.surface === 'water' ? 'water' : preset.placement && preset.placement.surface === 'coast' ? 'coast' : 'land';
      const spot = surfaceSpot(surface);
      return { kind: surface, x: spot.x, z: spot.z, y: ground(spot.x, spot.z), note: `no site within ${SITE_SEARCH_RADIUS / 1000} km: ${surface} ahead` };
    }
    if (scenario.anchor === 'thermal') {
      const spot = thermalSpot();
      return { kind: 'thermal', x: spot.x, z: spot.z, y: ground(spot.x, spot.z), note: `thermal at ${spot.thermal.x}, ${spot.thermal.z} (${spot.thermal.strength} m/s)` };
    }
    const spot = surfaceSpot(scenario.anchor);
    return { kind: scenario.anchor, x: spot.x, z: spot.z, y: ground(spot.x, spot.z), note: `${scenario.anchor} spot` };
  }

  // ---- The flight ---------------------------------------------------------------------------------------
  /** The compass heading away from the sun. */
  function downSunHeading() {
    const sun = state.time.sunDirection;
    return ((Math.atan2(-sun.x, sun.z) * 180) / Math.PI + 360) % 360;
  }

  /** Puts the craft `distance` m short of the anchor, heading at it, on the autopilot. Returns the pose. */
  function placeCraft(scenario, anchor) {
    const heading = scenario.heading === 'downSun' ? downSunHeading() : state.spawn.heading;
    const radians = (heading * Math.PI) / 180;
    const origin = anchor.kind === 'sky' ? surfaceSpot('land') : anchor;
    const distance = anchor.kind === 'sky' ? 0 : scenario.distance;
    const x = origin.x - Math.sin(radians) * distance;
    const z = origin.z + Math.cos(radians) * distance;
    const y = Number.isFinite(scenario.altitudeMsl) ? scenario.altitudeMsl : Math.max(ground(x, z), anchor.kind === 'sky' ? 0 : ground(origin.x, origin.z)) + (scenario.altitude ?? DEFAULT_ALTITUDE);
    ctx.setPhotoMode(false);
    if (!ctx.systems.flight.resetTo({ x, y, z, heading })) throw new Error('the flight system refused the approach pose');
    ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: y, speed: scenario.speed ?? DEFAULT_SPEED, followWaypoint: false, reason: 'spawns test' });
    return { x, y, z, heading };
  }

  /** Creates the spawn at the anchor (the debug path the F9 debugger uses). Returns its id or null. */
  function createSpawn(scenario, anchor) {
    const options = { source: 'debug', force: true, heading: state.player.heading };
    if (scenario.params) options.params = scenario.params;
    if (anchor.kind === 'sky') {
      // A sky-anchored event places itself; its position (distance ahead) carries any ground part
      // (the glory's cloud sea under the flight path).
      const ahead = system.pointAhead(scenario.distance);
      options.position = { x: ahead.x, y: ahead.y, z: ahead.z };
    } else {
      options.position = { x: anchor.x, y: anchor.y, z: anchor.z };
      if (anchor.site) {
        options.site = anchor.site;
        delete options.heading;
      }
    }
    return manager.activate(scenario.id, options);
  }

  /** The preset and every set-piece child it names, in the order they go into the manager. */
  function presetFamily(preset) {
    const family = [preset];
    for (const entry of preset.engines) {
      if (entry.engine !== 'setPiece') continue;
      for (const child of Object.values(entry.params.children ?? {})) {
        const childPreset = presetById.get(child.preset);
        if (childPreset && !family.includes(childPreset)) family.push(childPreset);
      }
    }
    return family;
  }

  function addFamily(family) {
    for (const preset of family) if (!manager.getPreset(preset.id)) manager.addPreset(preset);
  }

  function removeFamily(family) {
    for (const preset of family) manager.removePreset(preset.id);
  }

  /** Spawns the director started meanwhile (a re-added preset's own candidate): ended, and counted. */
  function endOtherSpawns() {
    let ended = 0;
    for (const spawn of manager.getActive()) {
      if (spawn.source === 'debug') continue;
      manager.deactivate(spawn.id, 'spawns test');
      ended++;
    }
    return ended;
  }

  /** The director activations the SpawnManager has declined so far (getStats().refusals.declined). */
  function declinedCount() {
    return manager.getStats().refusals.declined ?? 0;
  }

  async function recordLive(seconds) {
    const recorder = createFrameRecorder({ slowLimitMs: FRAME_LIMIT_MS });
    const render = { drawCalls: 0, triangles: 0, samples: 0 };
    recording = { recorder, render };
    lastFrameMs = null;
    await wait(seconds * 1000);
    recording = null;
    const summary = recorder.summary();
    return {
      frames: summary.frames,
      seconds: summary.seconds,
      avgFps: summary.avgFps,
      p50Ms: summary.p50Ms,
      p99Ms: summary.p99Ms,
      maxMs: summary.maxMs,
      slowFrames: summary.slowFrames,
      drawCalls: render.samples > 0 ? Math.round(render.drawCalls / render.samples) : null,
      triangles: render.samples > 0 ? Math.round(render.triangles / render.samples) : null,
    };
  }

  // ---- Staging and framing -------------------------------------------------------------------------------
  function partsOf(spawnId) {
    return spawnId ? manager.getParts(spawnId) ?? [] : [];
  }

  function engineOf(name) {
    return manager.registry.get(name);
  }

  /** A set piece's child spawn id by its key, or null. */
  function childSpawn(spawnId, key) {
    const part = partsOf(spawnId).find((entry) => entry.engine === 'setPiece');
    if (!part) return null;
    const child = engineOf('setPiece').describe(part).children.find((entry) => entry.key === key);
    return child && child.id ? child.id : null;
  }

  /** Named staging steps (scenario.stage), each run while the spawn is live, before the framing. */
  const STAGES = {
    /** Waits (up to 20 s) for three meteors in flight, so the still shows some. */
    async meteors(spawnId) {
      const part = partsOf(spawnId).find((entry) => entry.engine === 'celestial');
      if (!part) return 'no celestial part';
      const started = performance.now();
      while (engineOf('celestial').describe(part).meteorsActive < 3 && performance.now() - started < 20000) await frames(1);
      return `${engineOf('celestial').describe(part).meteorsActive} meteors in flight`;
    },
    /** Puts the crossing at totality (the moon centred on the sun). */
    async totality(spawnId) {
      const part = partsOf(spawnId).find((entry) => entry.engine === 'celestial');
      if (!part) return 'no celestial part';
      const data = part.data;
      const eclipse = data.params.eclipse;
      const lead = (data.duration - eclipse.crossingSeconds) * 0.5;
      data.startTime = state.time.elapsed - (lead + eclipse.crossingSeconds * 0.5);
      await frames(20);
      const described = engineOf('celestial').describe(part);
      return `uncovered ${round(described.eclipse.uncovered, 3)}`;
    },
    /** Waits (up to 40 s of flight) for the eagle to call as it joins the wing. */
    async wingman(spawnId) {
      let joined = false;
      const off = bus.on('fauna:call', (payload) => {
        if (payload && payload.id === spawnId && payload.reason === 'join') joined = true;
      });
      const started = performance.now();
      try {
        while (!joined && manager.getInstance(spawnId) && performance.now() - started < 40000) await frames(5);
      } finally {
        off();
      }
      if (joined) await wait(WINGMAN_SETTLE_S * 1000);
      const flock = flockOf(spawnId);
      const where = flock ? `, ${round(flock.playerDistance, 1)} m from the craft` : '';
      return joined ? `joined the wing (${round((performance.now() - started) / 1000, 1)} s with the settle)${where}` : `did not join within 40 s${where}`;
    },
    /** Moves the comet's slow fade-in on by 30 s. */
    async cometFadeIn(spawnId) {
      for (const part of partsOf(spawnId)) if (part.engine === 'celestial' && Number.isFinite(part.data.startTime)) part.data.startTime -= 30;
      await frames(10);
      return 'fade-in moved on 30 s';
    },
    /** Ends the storm chase's opening stage and grows the supercell to 0.92, so the wall cloud lowers. */
    async wallCloud(spawnId) {
      const part = partsOf(spawnId).find((entry) => entry.engine === 'setPiece');
      if (!part) return 'no set piece';
      const data = part.data;
      const stage = data.plan.stages[data.stageIndex];
      if (stage && Number.isFinite(stage.duration)) data.stageClock[0] = Math.max(data.stageClock[0], stage.duration - 0.05);
      const started = performance.now();
      await frames(2);
      while (performance.now() - started < 10000 && !data.finished && engineOf('setPiece').describe(part).stage === (stage ? stage.id : null)) await frames(2);
      const supercell = childSpawn(spawnId, 'supercell');
      let grown = 0;
      for (const child of partsOf(supercell)) {
        if (child.engine !== 'weatherVolume') continue;
        child.data.growth = 0.92;
        grown++;
      }
      await frames(10);
      return `stage ${engineOf('setPiece').describe(part).stage}, ${grown} volumes grown`;
    },
  };

  /** The live anchor of a spawn (its first part's), or of a set piece child. */
  function anchorOf(spawnId, view) {
    const id = view.child ? childSpawn(spawnId, view.child) : spawnId;
    const parts = partsOf(id);
    return parts.length > 0 ? parts[0].anchor : null;
  }

  /** A fauna spawn's flock: its live centre and radius (the fauna engine's describe), or null. */
  function flockOf(spawnId) {
    const fauna = engineOf('fauna');
    const described = fauna && typeof fauna.describe === 'function' ? fauna.describe(spawnId) : null;
    return described && described.center ? { center: described.center, radius: described.radius, mode: described.mode, playerDistance: described.playerDistance } : null;
  }

  /** Frames the spawn for its screenshot (photo mode); returns a description of the view. */
  async function frameSpawn(scenario, spawnId, anchor) {
    const view = scenario.view ?? {};
    const mode = view.mode ?? 'world';
    const fov = Number.isFinite(view.fov) ? view.fov : undefined;
    const player = state.player.position;
    if (mode === 'sky' || mode === 'sun') {
      ctx.setPhotoMode(true);
      await frames(2);
      const position = new THREE.Vector3(player.x, player.y + 30, player.z);
      let target;
      if (mode === 'sun') {
        const sun = state.time.sunDirection;
        target = new THREE.Vector3(position.x + sun.x * 1000, position.y + sun.y * 1000, position.z + sun.z * 1000);
      } else {
        const sky = anchorOf(spawnId, view);
        if (!sky) return { mode, framed: false, reason: 'no live anchor' };
        target = new THREE.Vector3(sky.x, sky.y + (view.lookUp ?? 0), sky.z);
      }
      ctx.systems.camera.setFreeCameraPose({ position, target, fov });
      await frames(30);
      return { mode, framed: true };
    }
    if (mode === 'player') {
      ctx.setPhotoMode(true);
      await frames(2);
      const heading = ((state.player.heading + (view.bearing ?? 180)) * Math.PI) / 180;
      const distance = view.distance ?? 60;
      const position = new THREE.Vector3(player.x + Math.sin(heading) * distance, player.y + (view.height ?? 10), player.z - Math.cos(heading) * distance);
      let target = new THREE.Vector3(player.x, player.y, player.z);
      if (view.look === 'antisolar') {
        const sun = state.time.sunDirection;
        target = new THREE.Vector3(player.x - sun.x * 1000, player.y - sun.y * 1000, player.z - sun.z * 1000);
      } else if (view.look === 'pair') {
        // Between the craft and the spawn (a wingman off the wing): both in the frame.
        const flock = flockOf(spawnId);
        const live = flock ? flock.center : anchorOf(spawnId, view);
        if (live) target = new THREE.Vector3((player.x + live.x) / 2, (player.y + live.y) / 2, (player.z + live.z) / 2);
      }
      ctx.systems.camera.setFreeCameraPose({ position, target, fov });
      await frames(30);
      return { mode, framed: true };
    }
    const live = anchorOf(spawnId, view);
    if (!live) return { mode, framed: false, reason: 'no live anchor' };
    const heading = (state.player.heading * Math.PI) / 180;
    const focus = anchor.focus && !view.child ? anchor.focus : live;
    let target = { x: focus.x, y: focus.y + (view.lift ?? 40), z: focus.z };
    if (view.offset) {
      const [right, up, forward] = view.offset;
      target = {
        x: live.x + Math.cos(heading) * right + Math.sin(heading) * forward,
        y: live.y + up,
        z: live.z + Math.sin(heading) * right - Math.cos(heading) * forward,
      };
    }
    const position = framing.viewpoint(target, view.distance ?? 900, view.height ?? 160, state.player.heading + (view.bearing ?? 200));
    const settled = await framing.frameView(position, target, { fov });
    return { mode, framed: true, terrainSettled: settled, target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) } };
  }

  /** Asks tools/run-harness.mjs for a screenshot and waits for it (or holds the view a moment). */
  async function takeShot(name, presetId) {
    panel.hideProgress();
    await frames(3);
    if (!shotsWanted) {
      await wait(SHOT_HOLD_S * 1000);
      return { name, taken: false, requested: false };
    }
    shotSerial++;
    const token = `${shotSerial}`;
    pendingShot = { token, name, presetId };
    publish();
    const taken = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        shotWaiters.delete(token);
        resolve(false);
      }, SHOT_TIMEOUT_S * 1000);
      shotWaiters.set(token, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    pendingShot = null;
    if (!taken) harnessErrors.push(`the screenshot ${name} was not taken within ${SHOT_TIMEOUT_S} s`);
    return { name, taken, requested: true };
  }

  // ---- One preset ----------------------------------------------------------------------------------------------
  async function testPreset(scenario, index) {
    const preset = presetById.get(scenario.id);
    const errorsBefore = capture.counts.errors;
    const warningsBefore = capture.counts.warnings;
    const label = `${index + 1}. ${preset ? preset.name : scenario.id}`;
    capture.setContext(`spawns: ${scenario.id}`);
    const row = {
      index: index + 1,
      presetId: scenario.id,
      name: preset ? preset.name : scenario.id,
      category: preset ? preset.category : null,
      kind: preset ? preset.kind : null,
      heavy: preset ? preset.heavy === true : null,
      conditions: { sun: scenario.sun, morning: scenario.morning === true, weather: scenario.weather ?? 'clear', why: scenario.why },
      anchor: null,
      spawned: false,
      spawnId: null,
      parts: [],
      tier: null,
      discovered: null,
      stage: null,
      view: null,
      shot: null,
      frames: { frames: 0, avgFps: null, p99Ms: null, maxMs: null, slowFrames: 0 },
      cycles: [],
      otherSpawnsEnded: 0,
      // Director activations of the re-added preset the manager declined meanwhile (refusal 'declined':
      // every engine ended at create, so nothing was spawned and the director retries later).
      directorDeclined: 0,
      console: { errors: 0, warnings: 0 },
      notes: [],
      passed: false,
    };
    rows.push(row);
    if (!preset) {
      row.notes.push('no such preset');
      return;
    }
    const family = presetFamily(preset);
    const declinedBefore = declinedCount();
    holdConditions(ctx, { sun: scenario.sun, morning: scenario.morning === true, weather: scenario.weather ?? 'clear' });
    phase = 'placing';
    progress(label, `${row.conditions.why}: finding its spot`);
    const anchor = resolveAnchor(scenario, preset);
    row.anchor = { kind: anchor.kind, note: anchor.note ?? null, x: Number.isFinite(anchor.x) ? Math.round(anchor.x) : null, z: Number.isFinite(anchor.z) ? Math.round(anchor.z) : null };
    const pose = placeCraft(scenario, anchor);
    addFamily(family);
    try {
      // ---- Cycle 1: the show ----
      phase = 'show';
      progress(label, 'baseline');
      const baseline = await dispose.baseline();
      const spawnId = createSpawn(scenario, anchor);
      row.spawnId = spawnId;
      row.spawned = Boolean(spawnId) && manager.getInstance(spawnId) !== null;
      if (!row.spawned) {
        row.notes.push(`refused: ${manager.getStats().lastRefusal}`);
        dispose.cancel();
        return;
      }
      row.parts = partsOf(spawnId).map((part) => part.engine);
      progress(label, `live for ${scenario.runSeconds ?? DEFAULT_RUN_SECONDS} s, recording frame times`);
      row.frames = await recordLive(scenario.runSeconds ?? DEFAULT_RUN_SECONDS);
      if (scenario.stage) {
        const stage = STAGES[scenario.stage];
        row.stage = stage ? await stage(spawnId) : `unknown stage ${scenario.stage}`;
      }
      const instance = manager.getInstance(spawnId);
      row.tier = instance ? instance.tier : null;
      progress(label, 'framing the screenshot');
      row.view = await frameSpawn(scenario, spawnId, anchor);
      row.shot = await takeShot(`spawn-${String(index + 1).padStart(2, '0')}-${scenario.id}`, scenario.id);
      const live = manager.getInstance(spawnId);
      row.discovered = live ? live.discovered === true : null;
      if (live) manager.deactivate(spawnId, 'spawns test');
      else row.notes.push('the spawn had ended on its own before the dispose');
      ctx.setPhotoMode(false);
      row.otherSpawnsEnded += endOtherSpawns();
      row.cycles.push(await dispose.compare(baseline, { presetIds: family.map((entry) => entry.id) }));

      // ---- The leak check: more creates and disposes from the same start, everything held ----
      phase = 'leak check';
      progress(label, `leak check: ${leakCycles} creates and disposes, the simulation held`);
      ctx.systems.flight.resetTo({ x: pose.x, y: pose.y, z: pose.z, heading: pose.heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading: pose.heading, altitude: pose.y, speed: scenario.speed ?? DEFAULT_SPEED, followWaypoint: false, reason: 'spawns test' });
      await frames(20);
      ctx.setPhotoMode(true);
      // One held create and dispose first, not judged: a first held create can keep a one-time amount
      // for good (the floating islands keep about 2 MB, then stay flat over any number of further
      // creates), which is a cache and not a leak. What it kept is reported as warmupRetainedMB; the
      // judged cycles measure what every further create keeps.
      const warmupBeforeMB = heapAvailable() ? await settledHeapMB() : null;
      const warmupId = createSpawn(scenario, anchor);
      if (warmupId) {
        await frames(LEAK_CYCLE_FRAMES);
        if (manager.getInstance(warmupId)) manager.deactivate(warmupId, 'spawns test');
        await frames(2);
      }
      const baseline2 = await dispose.baseline({ heap: true });
      let refused = warmupId ? null : manager.getStats().lastRefusal;
      // The heap after each create and dispose (forced collections): a leak climbs cycle by cycle.
      const heapTrace = [];
      for (let cycle = 0; cycle < leakCycles && !refused; cycle++) {
        const cycleId = createSpawn(scenario, anchor);
        if (!cycleId) {
          refused = manager.getStats().lastRefusal;
          break;
        }
        await frames(LEAK_CYCLE_FRAMES);
        if (manager.getInstance(cycleId)) manager.deactivate(cycleId, 'spawns test');
        await frames(2);
        if (heapAvailable()) heapTrace.push(await settledHeapMB());
      }
      row.otherSpawnsEnded += endOtherSpawns();
      const leakCheck = await dispose.compare(baseline2, { presetIds: family.map((entry) => entry.id), heapToleranceMB: HEAP_TOLERANCE_MB });
      leakCheck.heapTraceMB = heapTrace;
      leakCheck.warmupRetainedMB = Number.isFinite(warmupBeforeMB) && Number.isFinite(baseline2.heapMB) ? round(baseline2.heapMB - warmupBeforeMB, 2) : null;
      row.cycles.push(leakCheck);
      ctx.setPhotoMode(false);
      if (refused) row.notes.push(`leak check refused: ${refused}`);
    } finally {
      removeFamily(family);
      row.directorDeclined = declinedCount() - declinedBefore;
      row.console = { errors: capture.counts.errors - errorsBefore, warnings: capture.counts.warnings - warningsBefore };
      row.passed = row.spawned && row.cycles.length === 2 && row.cycles.every((cycle) => cycle.ok) && row.console.errors === 0 && row.console.warnings === 0 && (!shotsWanted || Boolean(row.shot && row.shot.taken));
      publish();
    }
  }

  // ---- Run --------------------------------------------------------------------------------------------------
  async function setup() {
    phase = 'setup';
    progress('Spawns test', 'holding the game presets');
    timeFrozenBefore = settings.get('timeFrozen');
    settings.set('craft', TEST_CRAFT);
    settings.update('assists', { [TEST_CRAFT]: 1 });
    settings.update('views', { [TEST_CRAFT]: 'chase' });
    if (ctx.systems.flight.getCraft() !== TEST_CRAFT) throw new Error(`asked for the ${TEST_CRAFT}, flying ${ctx.systems.flight.getCraft()}`);
    if (!system.debug) throw new Error('the spawns dev API (spawns.debug) is missing');
    heldPresets = system.debug.holdGamePresets();
    detachedFeed = manager.getSiteFeed();
    manager.setSiteFeed(null);
    dispose = createDisposeCheck(ctx, framing);
    if (!dispose.tracker) harnessErrors.push('the geometry tracker is unavailable (renderer internals changed): GPU memory is judged by the plain counts');
    await frames(10);
  }

  function restore() {
    if (dispose) dispose.restore();
    if (detachedFeed) manager.setSiteFeed(detachedFeed);
    detachedFeed = null;
    if (heldPresets.length > 0) system.debug.releaseGamePresets();
    heldPresets = [];
    ctx.systems.weather.forceState(null);
    settings.set('timeFrozen', timeFrozenBefore);
    ctx.setPhotoMode(false);
  }

  async function run() {
    await setup();
    for (const [index, scenario] of scenarios.entries()) {
      try {
        await testPreset(scenario, index);
      } catch (error) {
        const message = `${scenario.id}: ${error && error.message ? error.message : error}`;
        harnessErrors.push(message);
        console.error(`[DRIFTWING test] spawns test: ${message}`, error);
        for (const spawn of manager.getActive()) manager.deactivate(spawn.id, 'spawns test');
        if (dispose) dispose.cancel();
      }
    }
  }

  // ---- Summary ------------------------------------------------------------------------------------------------
  function cycleCell(cycle) {
    if (!cycle) return { text: '-', status: 'fail' };
    const ok = cycle.gpuOk && cycle.windOk && cycle.skyOk && cycle.lightsOk && cycle.leaksOk;
    return { text: `g${cycle.geometryDelta >= 0 ? '+' : ''}${cycle.geometryDelta} (world ${cycle.worldFirstDrawn}) t${cycle.textureDelta >= 0 ? '+' : ''}${cycle.textureDelta} w${cycle.windLeft.length}`, status: ok ? 'pass' : 'fail', title: JSON.stringify({ leftBehind: cycle.leftBehind, wind: cycle.windSources, sky: cycle.skyModifiers, lights: cycle.lights }) };
  }

  function showSummary() {
    publish();
    const sections = [{
      title: 'Presets',
      table: {
        columns: [
          { key: 'index', label: '#', numeric: true },
          { key: 'name', label: 'Preset' },
          { key: 'conditions', label: 'Sun / weather' },
          { key: 'anchor', label: 'Anchor' },
          { key: 'parts', label: 'Engines' },
          { key: 'fps', label: 'Avg fps', numeric: true },
          { key: 'p99', label: 'p99 ms', numeric: true },
          { key: 'max', label: 'Max ms', numeric: true },
          { key: 'cycle1', label: 'Show: GPU / wind', numeric: true },
          { key: 'cycle2', label: 'Leak: GPU / wind', numeric: true },
          { key: 'heap', label: 'Heap Δ MB', numeric: true },
          { key: 'console', label: 'Err / warn', numeric: true },
          { key: 'result', label: 'Result' },
        ],
        rows: rows.map((row) => ({
          index: row.index,
          name: row.name,
          conditions: `${row.conditions.sun}° ${row.conditions.weather}`,
          anchor: row.anchor ? row.anchor.kind : '-',
          parts: row.parts.join('+') || '-',
          fps: row.frames.avgFps ?? '-',
          p99: row.frames.p99Ms ?? '-',
          max: row.frames.maxMs ?? '-',
          cycle1: cycleCell(row.cycles[0]),
          cycle2: cycleCell(row.cycles[1]),
          heap: row.cycles[1] ? { text: row.cycles[1].heapDeltaMB ?? 'n/a', status: row.cycles[1].heapOk ? null : 'fail' } : '-',
          console: { text: `${row.console.errors} / ${row.console.warnings}`, status: row.console.errors + row.console.warnings === 0 ? 'muted' : 'fail' },
          result: { text: row.passed ? 'PASS' : 'FAIL', status: row.passed ? 'pass' : 'fail' },
        })),
      },
    }];
    const notes = rows.flatMap((row) => [
      ...row.notes.map((note) => `${row.name}: ${note}`),
      ...(row.otherSpawnsEnded > 0 ? [`${row.name}: ${row.otherSpawnsEnded} director spawn(s) of the re-added preset ended`] : []),
      ...(row.directorDeclined > 0 ? [`${row.name}: ${row.directorDeclined} director activation(s) of the re-added preset declined (every engine ended at create)`] : []),
      ...row.cycles.flatMap((cycle, cycleIndex) => (cycle.leftBehind.length > 0 ? [`${row.name}, cycle ${cycleIndex + 1}: left behind ${cycle.leftBehind.join(', ')}`] : [])),
      ...(row.cycles[1] && row.cycles[1].warmupRetainedMB > WARMUP_NOTE_MB ? [`${row.name}: the held warm-up create kept ${row.cycles[1].warmupRetainedMB} MB once; the heap then stayed at ${row.cycles[1].heapTraceMB.join(', ')} MB over the judged cycles`] : []),
    ]);
    if (notes.length > 0) sections.push({ title: 'Notes', notes });
    if (capture.entries.length > 0) sections.push({ title: 'Console errors and warnings', notes: capture.entries.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) });
    if (harnessErrors.length > 0) sections.push({ title: 'Harness problems', notes: harnessErrors.slice() });
    sections.push({ title: 'About', notes: [
      'The game\'s own presets are held out of the SpawnManager and its site feed is detached for the whole test; each preset (and a set piece\'s children) goes back in for its own show only. Site presets stand on their nearest real placed site, with its terrain stamps; events stand on a spot that suits them ahead of the craft.',
      `Cycle 1 shows the preset (live flight toward it with the frame times recorded, staging, the photo camera, the screenshot) and disposes it; the leak check then creates and disposes it ${leakCycles} more times from the same start in photo mode (the simulation and the camera held, ${LEAK_CYCLE_FRAMES} frames each). After each: no geometry an engine made still alive, the geometry count up by no more than the world's own first draws (the geometry tracker), textures exactly back, every wind source it added removed, sky modifiers, real lights and leak counters back. Across the leak check the JS heap (two forced collections) must stay within ${HEAP_TOLERANCE_MB} MB of its baseline.`,
      'Frame times are taken over the live window with the chase camera on the craft flying toward the spawn; they are reported, not judged (the owner\'s rule on the shared machine).',
    ] });
    panel.showSummary({
      result: report.result,
      subtitle: `${rows.filter((row) => row.passed).length} / ${scenarios.length} presets passed · seed ${state.seed} · ${ctx.backend}`,
      meta: [
        ['Backend', ctx.backend],
        ['three.js', `r${ctx.THREE.REVISION}`],
        ['Seed', state.seed],
        ['Craft', TEST_CRAFT],
        ['Heap', report.environment.heap],
        ['Console', `${capture.counts.errors} errors, ${capture.counts.warnings} warnings`],
      ],
      criteria: report.criteria,
      sections,
      report,
      filename: `driftwing-spawns-test-${ctx.backend.toLowerCase()}.json`,
      actions: [{ label: 'Run again', onClick: () => window.location.reload() }],
    });
  }

  function finish() {
    restore();
    status = 'complete';
    finishedAt = new Date().toISOString();
    phase = 'complete';
    step = '';
    capture.setContext('spawns complete');
    publish();
    showSummary();
  }

  function abort(error) {
    const message = `spawns test stopped during ${phase} (${step}): ${error && error.message ? error.message : error}`;
    harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    finish();
  }

  // The runner's side of the screenshots (tools/run-harness.mjs): it reads pendingShot, takes the
  // screenshot and calls shotTaken(token).
  const handle = {
    get pendingShot() {
      return pendingShot ? { ...pendingShot } : null;
    },
    shotTaken(token) {
      const resolve = shotWaiters.get(String(token));
      if (!resolve) return false;
      shotWaiters.delete(String(token));
      resolve();
      return true;
    },
  };

  bus.on('game:ready', () => {
    // main.js publishes window.DRIFTWING after the systems are built, so it is read here.
    if (window.DRIFTWING) {
      window.DRIFTWING.spawnsTest = handle;
      window.DRIFTWING.testReport = report;
    }
    publish();
    run().then(finish, abort);
  });
  panel.setProgress({ label: 'Spawns test', detail: 'waiting for the game', fraction: 0 });

  return {
    update() {
      if (!recording) return;
      const now = performance.now();
      if (lastFrameMs !== null) recording.recorder.push(now - lastFrameMs, 0);
      lastFrameMs = now;
      const info = ctx.renderer.info.render;
      recording.render.drawCalls += info.drawCalls ?? info.calls ?? 0;
      recording.render.triangles += info.triangles ?? 0;
      recording.render.samples++;
    },
    getReport() {
      return report;
    },
  };
}
