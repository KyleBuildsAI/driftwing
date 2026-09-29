// Spawn framework check (Milestone B): drives the dev test kit (src/dev/spawnTestKit.js) in V2 on a
// running dev server, headless, and proves the framework with numbers:
//
//   memory      after a warm-up cycle (engine session resources), three cycles of 200 marker
//               instances created (each with its own GPU geometry) and disposed: renderer.info.memory
//               (geometries, textures, attributes, bytes) returns exactly to its baseline, and the JS
//               heap (after a forced GC) within HEAP_TOLERANCE_BYTES
//   lod         a heavy test spawn walked from 500 m to 30 km and back changes tier at the preset's
//               boundaries with the hysteresis band, and its lure shows only at the FAR tier
//   lure        heavy test spawns 12-30 km out stand on the horizon as lures: screenshots at golden
//               hour, midday and night (lure-golden.png, lure-midday.png, lure-night.png)
//   wind        a wind engine's source (and its real light) is live while its spawn runs and gone
//               after dispose, with windSourceAdded / windSourceRemoved
//   discovery   fires once for an event preset (not again when it respawns) and once for a site id
//               (not again when the site is re-created)
//   allocation  the manager's frame update with 40 spawns, sampled by the heap profiler: bytes
//               allocated in src/spawns and the test engines per frame (must be none), and by what
//               they call (the terrain heights the occlusion rays sample; reported)
//   debugger    F9 opens the panel (screenshot debugger.png) and closes it; while it is closed the
//               flight keys fly, while it has focus they stay in it; its Spawn, Nearest (teleport),
//               time-of-day, Wind arrows and engine stats work
//
// The memory cycles run in photo mode (the simulation stands still, the loop keeps rendering), so
// terrain streaming cannot move the GPU counters; the LOD, wind and allocation checks step frames by
// hand with the loop paused (window.DRIFTWING.debug). Any console error or warning fails the run.
//
// Usage: node tools/spawn-check.mjs --url http://127.0.0.1:<port>/v2/ [--backend webgpu|webgl]
//          [--out <dir>] [--headful]
// Exits 0 when every check passes.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from './browser.mjs';

const HEAP_TOLERANCE_BYTES = 1024 * 1024;
const MEMORY_CYCLES = 3;
const MEMORY_INSTANCES = 200;
const SEED = 'SPAWNCHECK';

function parseArgs(argv) {
  const options = { url: null, backend: 'webgpu', out: join(tmpdir(), 'driftwing-spawn-check'), headful: false, width: 1280, height: 720 };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--url': options.url = next(); break;
      case '--backend': options.backend = next(); break;
      case '--out': options.out = next(); break;
      case '--headful': options.headful = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!options.url) throw new Error('--url <dev server V2 address> is required');
  if (!['webgpu', 'webgl'].includes(options.backend)) throw new Error('--backend must be webgpu or webgl');
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(10)} ${name}${detail ? `  (${detail})` : ''}\n`);
}

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const url = new URL(options.url);
  url.searchParams.set('seed', SEED);
  if (options.backend === 'webgl') url.searchParams.set('renderer', 'webgl');
  const profileDir = join(tmpdir(), `driftwing-spawn-check-${process.pid}`);
  const browser = await puppeteer.launch({
    executablePath: findBrowser(null),
    headless: !options.headful,
    userDataDir: profileDir,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', `--window-size=${options.width},${options.height}`],
    defaultViewport: { width: options.width, height: options.height },
  });
  const logs = { errors: [], warnings: [] };
  const report = { url: url.href, backend: null, checks: results, console: logs, numbers: {} };
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'assert') logs.errors.push(message.text());
      else if (type === 'warn' || type === 'warning') logs.warnings.push(message.text());
    });
    page.on('pageerror', (error) => logs.errors.push(`pageerror: ${error.message}`));
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');

    async function collectGarbage() {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
    }
    async function heapUsed() {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return metrics.find((metric) => metric.name === 'JSHeapUsedSize').value;
    }
    const evaluate = (fn, ...args) => page.evaluate(fn, ...args);

    await page.goto(url.href, { waitUntil: 'load', timeout: 120000 });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(await evaluate(() => Boolean(window.DRIFTWING?.ready)).catch(() => false))) await sleep(250);
    report.backend = await evaluate(() => window.DRIFTWING?.backend ?? null);
    check('boot', `V2 ready on ${report.backend}`, report.backend !== null && (options.backend === 'webgl' ? report.backend === 'WebGL2' : true), report.backend);
    const kit = await evaluate(async () => window.DRIFTWING.ctx.systems.spawns.debug.loadTestKit());
    check('boot', 'test kit registered its engines and presets', kit.engines.length === 2 && kit.presets.length >= 9, `${kit.engines.join(', ')}; ${kit.presets.length} presets`);
    await sleep(1500);

    // ---- memory ----------------------------------------------------------------------------------
    // Photo mode stops the simulation (the craft, and with it terrain streaming, stand still) while the
    // animation loop keeps rendering: stepped frames (DRIFTWING.debug.stepFrames) would not do here,
    // because the post stack's scene pass only renders again when the animation loop advances three's
    // node frame, so new geometry would never reach the GPU.
    await evaluate(() => window.DRIFTWING.ctx.setPhotoMode(true));
    await sleep(2500);
    const readGpu = () => evaluate(() => {
      const memory = window.DRIFTWING.ctx.renderer.info.memory;
      return { geometries: memory.geometries, textures: memory.textures, attributes: memory.attributes, bytes: memory.total };
    });
    // Warm-up: an engine's session resources stay by design: the marker engine's instanced mesh reaches
    // the GPU the first time an instance draws, and its halo mesh pool grows to the peak instance count
    // once (pooled meshes and their three.js RenderObjects are reused, never freed; pools.js explains
    // why). One full cycle builds them, and the baseline follows.
    const warmUpIds = await evaluate((count) => window.DRIFTWING.ctx.systems.spawns.debug.testKit.createMany(count, { minDistance: 200, maxDistance: 800, spread: 50 }), MEMORY_INSTANCES);
    await sleep(1500);
    const warmUp = await evaluate((ids) => window.DRIFTWING.ctx.systems.spawns.debug.testKit.deactivateAll(ids), warmUpIds);
    await sleep(1500);
    check('memory', `warm-up: engine session resources built (${MEMORY_INSTANCES} instances created and disposed)`, warmUp === MEMORY_INSTANCES);
    const cycles = [];
    for (let cycle = 0; cycle < MEMORY_CYCLES; cycle++) {
      await collectGarbage();
      const before = { ...(await readGpu()), heap: await heapUsed() };
      const created = await evaluate((count) => {
        const kitApi = window.DRIFTWING.ctx.systems.spawns.debug.testKit;
        window.__spawnCheckIds = kitApi.createMany(count, { minDistance: 200, maxDistance: 800, spread: 50 });
        return window.__spawnCheckIds.length;
      }, MEMORY_INSTANCES);
      await sleep(1500);
      const peak = { ...(await readGpu()), heap: await heapUsed() };
      const stats = await evaluate(() => {
        const spawnStats = window.DRIFTWING.ctx.systems.spawns.getStats();
        return { spawns: spawnStats.spawns, near: spawnStats.tiers.near, drawCalls: spawnStats.engines.testMarker.drawCalls };
      });
      const removed = await evaluate(() => {
        const count = window.DRIFTWING.ctx.systems.spawns.debug.testKit.deactivateAll(window.__spawnCheckIds);
        window.__spawnCheckIds = null;
        return count;
      });
      await sleep(1500);
      await collectGarbage();
      const after = { ...(await readGpu()), heap: await heapUsed() };
      cycles.push({ created, removed, before, peak, after, stats });
    }
    await evaluate(() => {
      window.DRIFTWING.debug.pauseLoop();
      window.DRIFTWING.debug.stepFrames(3);
    });
    report.numbers.memory = cycles;
    cycles.forEach((cycle, index) => {
      const label = `cycle ${index + 1}`;
      check('memory', `${label}: ${cycle.created} created, ${cycle.removed} disposed`, cycle.created === MEMORY_INSTANCES && cycle.removed === MEMORY_INSTANCES);
      check('memory', `${label}: each instance's geometry reached the GPU`, cycle.peak.geometries - cycle.before.geometries >= MEMORY_INSTANCES, `${cycle.before.geometries} -> ${cycle.peak.geometries} geometries, ${cycle.stats.near} near, ${cycle.stats.drawCalls} draw calls`);
      const gpuBack = cycle.after.geometries === cycle.before.geometries && cycle.after.textures === cycle.before.textures && cycle.after.attributes === cycle.before.attributes && cycle.after.bytes === cycle.before.bytes;
      check('memory', `${label}: GPU memory back to baseline`, gpuBack, `geometries ${cycle.before.geometries}/${cycle.peak.geometries}/${cycle.after.geometries}, textures ${cycle.before.textures}/${cycle.after.textures}, attributes ${cycle.before.attributes}/${cycle.peak.attributes}/${cycle.after.attributes}, bytes ${cycle.before.bytes}/${cycle.peak.bytes}/${cycle.after.bytes}`);
      const heapDelta = cycle.after.heap - cycle.before.heap;
      check('memory', `${label}: JS heap back within ${(HEAP_TOLERANCE_BYTES / 1048576).toFixed(1)} MB`, heapDelta <= HEAP_TOLERANCE_BYTES, `${(cycle.before.heap / 1048576).toFixed(2)} -> ${(cycle.peak.heap / 1048576).toFixed(2)} -> ${(cycle.after.heap / 1048576).toFixed(2)} MB (${heapDelta >= 0 ? '+' : ''}${(heapDelta / 1024).toFixed(0)} KB)`);
    });
    const accounting = await evaluate(() => {
      const memory = window.DRIFTWING.ctx.systems.spawns.getStats().memory;
      const last = memory.log[memory.log.length - 1];
      return { created: memory.created, disposed: memory.disposed, entries: memory.log.length, last };
    });
    check('memory', 'getStats().memory accounts every create and dispose', accounting.created === accounting.disposed && accounting.created >= MEMORY_CYCLES * MEMORY_INSTANCES && accounting.last?.disposed === true, `${accounting.created} created, ${accounting.disposed} disposed, ${accounting.entries} log entries`);

    // ---- lod ----------------------------------------------------------------------------------------
    const lod = await evaluate(() => {
      const spawns = window.DRIFTWING.ctx.systems.spawns;
      const kitApi = spawns.debug.testKit;
      const id = kitApi.spawnAt('testLurePlume', { distance: 500 });
      const walk = [500, 1400, 1600, 1700, 3000, 6400, 6600, 12000, 30000, 12000, 5600, 5400, 3000, 1450, 1350, 800];
      const steps = [];
      for (const distance of walk) {
        kitApi.moveAhead(id, distance);
        window.DRIFTWING.debug.stepFrames(3);
        const spawn = spawns.getInstance(id);
        steps.push({ distance, tier: spawn.tier });
      }
      kitApi.moveAhead(id, 30000);
      window.DRIFTWING.debug.stepFrames(90);
      const far = spawns.getInstance(id);
      const lureStats = spawns.manager.lures.getStats();
      spawns.deactivate(id, 'test');
      return { steps, farLure: far.lure, farTier: far.tier, lureStats, lod: spawns.manager.getPreset('testLurePlume').lod };
    });
    report.numbers.lod = lod;
    const tierAt = (distance, direction) => {
      const outbound = lod.steps.findIndex((step) => step.distance === 30000);
      const list = direction === 'out' ? lod.steps.slice(0, outbound + 1) : lod.steps.slice(outbound);
      return list.find((step) => step.distance === distance)?.tier;
    };
    check('lod', 'near inside near * (1 + H) going out (1600 m of 1500 m)', tierAt(1600, 'out') === 'near', lod.steps.map((step) => `${step.distance}:${step.tier}`).join(' '));
    check('lod', 'mid past near * (1 + H) (1700 m)', tierAt(1700, 'out') === 'mid');
    check('lod', 'mid inside mid * (1 + H) going out (6400 m of 6000 m)', tierAt(6400, 'out') === 'mid');
    check('lod', 'far past mid * (1 + H) (6600 m), and at 30 km', tierAt(6600, 'out') === 'far' && tierAt(30000, 'out') === 'far');
    check('lod', 'still far above mid * (1 - H) coming in (5600 m)', tierAt(5600, 'in') === 'far');
    check('lod', 'mid below mid * (1 - H) (5400 m)', tierAt(5400, 'in') === 'mid');
    check('lod', 'still mid above near * (1 - H) coming in (1450 m)', tierAt(1450, 'in') === 'mid');
    check('lod', 'near below near * (1 - H) (1350 m)', tierAt(1350, 'in') === 'near');
    check('lure', 'the lure at 30 km is fully faded in and drawn above the fog', lod.farTier === 'far' && lod.farLure === 1 && lod.lureStats.drawn >= 1 && lod.lureStats.projected >= 1, JSON.stringify(lod.lureStats));

    // ---- wind -------------------------------------------------------------------------------------------
    const wind = await evaluate(() => {
      const spawns = window.DRIFTWING.ctx.systems.spawns;
      const kitApi = spawns.debug.testKit;
      const sourcesBefore = kitApi.windSourceCount();
      const lightsBefore = spawns.manager.lights.active;
      const eventsBefore = kitApi.windEvents.length;
      const id = kitApi.spawnAt('testUpdraft', { distance: 600 });
      window.DRIFTWING.debug.stepFrames(3);
      const anchor = spawns.getInstance(id).position;
      const probe = { x: anchor.x, y: anchor.y + 300, z: anchor.z };
      const during = { sources: kitApi.windSourceCount(), lift: kitApi.windUp(probe), lights: spawns.manager.lights.active };
      spawns.deactivate(id, 'test');
      window.DRIFTWING.debug.stepFrames(3);
      const after = { sources: kitApi.windSourceCount(), lift: kitApi.windUp(probe), lights: spawns.manager.lights.active };
      return { sourcesBefore, lightsBefore, during, after, events: kitApi.windEvents.slice(eventsBefore), leaks: spawns.getStats().leaks };
    });
    report.numbers.wind = wind;
    check('wind', 'the spawn registered one wind source (windSourceAdded)', wind.during.sources === wind.sourcesBefore + 1 && wind.events[0]?.type === 'added', `${wind.sourcesBefore} -> ${wind.during.sources}`);
    check('wind', 'the column lifts the air 300 m above its foot', wind.during.lift > 3, `${wind.during.lift} m/s -> ${wind.after.lift} m/s after dispose`);
    check('wind', 'the spawn held one real light from the pool', wind.during.lights === wind.lightsBefore + 1);
    check('wind', 'dispose removed the source (windSourceRemoved) and the lift', wind.after.sources === wind.sourcesBefore && wind.events[1]?.type === 'removed' && wind.events[1].id === wind.events[0].id && wind.after.lift < wind.during.lift - 3);
    check('wind', 'dispose returned the light; no leaks', wind.after.lights === wind.lightsBefore && wind.leaks.windSources === 0 && wind.leaks.lights === 0);

    // ---- allocation --------------------------------------------------------------------------------------
    await evaluate(() => {
      const kitApi = window.DRIFTWING.ctx.systems.spawns.debug.testKit;
      window.__spawnCheckIds = [
        ...kitApi.createMany(34, { minDistance: 300, maxDistance: 1500, spread: 60 }),
        kitApi.spawnAt('testLurePlume', { distance: 30000, bearing: -20 }),
        kitApi.spawnAt('testLureAnvil', { distance: 28000, bearing: 10 }),
        kitApi.spawnAt('testLureWhale', { distance: 9000, bearing: 20 }),
        kitApi.spawnAt('testLureComet', { distance: 30000, bearing: 0 }),
        kitApi.spawnAt('testUpdraft', { distance: 900, bearing: 5 }),
        kitApi.spawnAt('testLureIslands', { distance: 16000, bearing: -35 }),
      ];
      window.DRIFTWING.debug.stepFrames(5);
      const manager = window.DRIFTWING.ctx.systems.spawns.manager;
      for (let frame = 0; frame < 4000; frame++) manager.update(1 / 60, 1 / 60);
    });
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32 });
    const allocationFrames = 20000;
    const spawnCount = await evaluate((frames) => {
      const manager = window.DRIFTWING.ctx.systems.spawns.manager;
      for (let frame = 0; frame < frames; frame++) manager.update(1 / 60, 1 / 60);
      return manager.getStats().spawns;
    }, allocationFrames);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    // Bytes allocated by the spawn code itself (src/spawns and the test engines), and by what it
    // calls elsewhere (the terrain height of the occlusion rays: worldgen's noise).
    let ownBytes = 0;
    let calleeBytes = 0;
    const sites = new Map();
    const walk = (node, underSpawns) => {
      const file = node.callFrame.url.split('?')[0];
      const own = file.includes('/src/spawns/') || file.includes('/src/dev/spawnTestKit.js');
      if (node.selfSize > 0 && (own || underSpawns)) {
        if (own) ownBytes += node.selfSize;
        else calleeBytes += node.selfSize;
        const key = `${node.callFrame.functionName || '(anonymous)'} ${file.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
        sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
      }
      for (const child of node.children) walk(child, underSpawns || own);
    };
    walk(profile.head, false);
    const ownPerFrame = ownBytes / allocationFrames;
    const calleePerFrame = calleeBytes / allocationFrames;
    const top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    report.numbers.allocation = { frames: allocationFrames, spawns: spawnCount, ownBytes, calleeBytes, ownPerFrame, calleePerFrame, sites: top };
    check('alloc', `the spawn code's frame update with ${spawnCount} spawns allocates nothing (sampled, under 0.1 byte per frame)`, ownPerFrame < 0.1, `${ownBytes} B over ${allocationFrames} frames = ${ownPerFrame.toFixed(3)} B/frame; callees (terrain heights for the occlusion rays) ${calleeBytes} B = ${calleePerFrame.toFixed(3)} B/frame${top.length ? `; top: ${top.map(([key, bytes]) => `${key} ${bytes} B`).join(', ')}` : ''}`);
    await evaluate(() => {
      window.DRIFTWING.ctx.systems.spawns.debug.testKit.deactivateAll(window.__spawnCheckIds);
      window.__spawnCheckIds = null;
      window.DRIFTWING.debug.stepFrames(3);
    });

    // ---- lures on the horizon --------------------------------------------------------------------------
    await evaluate(() => {
      window.DRIFTWING.ctx.setPhotoMode(false);
      window.DRIFTWING.debug.resumeLoop();
    });
    await sleep(1500);
    const lureIds = await evaluate(() => {
      const kitApi = window.DRIFTWING.ctx.systems.spawns.debug.testKit;
      window.__lureIds = [
        kitApi.spawnAt('testLurePlume', { distance: 30000, bearing: -22 }),
        kitApi.spawnAt('testLureAnvil', { distance: 30000, bearing: 4 }),
        kitApi.spawnAt('testLureFunnel', { distance: 14000, bearing: 24 }),
        kitApi.spawnAt('testLureWhale', { distance: 12000, bearing: 14 }),
        kitApi.spawnAt('testLureIslands', { distance: 20000, bearing: -36 }),
        kitApi.spawnAt('testLureComet', { distance: 30000, bearing: -8 }),
      ];
      return window.__lureIds;
    });
    check('lure', 'six heavy test lures spawned 12-30 km out', lureIds.every(Boolean), lureIds.join(', '));
    const times = [['golden', 'dayTimeForSunElevation(8, true)'], ['midday', '0.5'], ['night', 'dayTimeForSunElevation(-30, true)']];
    for (const [label, expression] of times) {
      await evaluate((source) => {
        const ctx = window.DRIFTWING.ctx;
        const dayTime = source === '0.5' ? 0.5 : ctx.util.dayTimeForSunElevation(source.includes('-30') ? -30 : 8, true);
        ctx.systems.sky.setDayTime(dayTime, { transition: 0 });
      }, expression);
      await sleep(2500);
      const state = await evaluate(() => {
        const spawns = window.DRIFTWING.ctx.systems.spawns;
        return { label: window.DRIFTWING.state.time.label, lures: spawns.manager.lures.getStats(), tiers: spawns.getStats().tiers };
      });
      await page.screenshot({ path: join(options.out, `lure-${label}.png`) });
      check('lure', `${label}: lures drawn on the horizon (${state.label})`, state.lures.drawn === 6, `${state.lures.drawn} drawn, ${state.lures.projected} projected, tiers ${JSON.stringify(state.tiers)}`);
    }
    await evaluate(() => {
      window.DRIFTWING.ctx.systems.spawns.debug.testKit.deactivateAll(window.__lureIds);
      window.DRIFTWING.ctx.systems.sky.setDayTime(window.DRIFTWING.ctx.util.dayTimeForSunElevation(8, true), { transition: 0 });
    });

    // ---- discovery ---------------------------------------------------------------------------------------
    // The marker preset may already have been discovered by the memory cycles (200 markers in view):
    // discovery fires once per event preset per world, so the proof counts every discovery since the
    // kit was installed, then respawns the preset where the camera sees it.
    const discoveryCount = (key) => evaluate((value) => window.DRIFTWING.ctx.systems.spawns.debug.testKit.discoveries.filter((entry) => entry.presetId === value || entry.id === value).length, key);
    const markerPoint = await evaluate(() => window.DRIFTWING.ctx.systems.spawns.debug.testKit.visiblePointAhead({ minDistance: 350, maxDistance: 1100, lift: 12 }));
    check('discovery', 'found a spot ahead the camera can see', markerPoint !== null, markerPoint ? `${Math.round(markerPoint.distance)} m, bearing ${markerPoint.bearing}` : 'none');
    await evaluate((point) => {
      window.__markerId = window.DRIFTWING.ctx.systems.spawns.debug.testKit.spawnAtPoint('testMarker', point);
    }, markerPoint);
    const eventDeadline = Date.now() + 8000;
    while (Date.now() < eventDeadline && (await discoveryCount('testMarker')) === 0) await sleep(200);
    const eventFirst = await discoveryCount('testMarker');
    await evaluate((point) => {
      const spawns = window.DRIFTWING.ctx.systems.spawns;
      spawns.deactivate(window.__markerId, 'test');
      window.__markerId = spawns.debug.testKit.spawnAtPoint('testMarker', point);
    }, markerPoint);
    await sleep(3000);
    const eventSecond = await discoveryCount('testMarker');
    const markerSeen = await evaluate(() => window.DRIFTWING.ctx.systems.spawns.getInstance(window.__markerId));
    check('discovery', 'an event preset is discovered exactly once in range and in view', eventFirst === 1, `${eventFirst}`);
    check('discovery', 'it does not fire again when the preset respawns in view', eventSecond === 1 && markerSeen?.discovered === true, `${eventSecond}; respawn ${markerSeen?.inView ? 'in view' : 'not in view'} at ${markerSeen?.distance} m`);
    const sitePoint = await evaluate(() => {
      const spawns = window.DRIFTWING.ctx.systems.spawns;
      spawns.deactivate(window.__markerId, 'test');
      return spawns.debug.testKit.visiblePointAhead({ minDistance: 400, maxDistance: 1300, lift: 15 });
    });
    check('discovery', 'found a site spot ahead the camera can see', sitePoint !== null, sitePoint ? `${Math.round(sitePoint.distance)} m, bearing ${sitePoint.bearing}` : 'none');
    const site = await evaluate((point) => window.DRIFTWING.ctx.systems.spawns.debug.testKit.placeTestSite(0, point), sitePoint);
    const siteDeadline = Date.now() + 8000;
    while (Date.now() < siteDeadline && (await discoveryCount(site.id)) === 0) await sleep(200);
    const siteFirst = await discoveryCount(site.id);
    const recreated = await evaluate((siteId) => {
      const spawns = window.DRIFTWING.ctx.systems.spawns;
      const first = spawns.manager.getSiteSpawn(siteId);
      spawns.deactivate(first, 'test');
      return first;
    }, site.id);
    await sleep(3000);
    const siteAfter = await evaluate((siteId) => window.DRIFTWING.ctx.systems.spawns.manager.getSiteSpawn(siteId), site.id);
    const siteSecond = await discoveryCount(site.id);
    check('discovery', 'a site from the feed is created and discovered once by its id', Boolean(recreated) && siteFirst === 1, `${site.id}: ${siteFirst}`);
    check('discovery', 'the re-created site does not fire again', Boolean(siteAfter) && siteSecond === 1, `re-created ${siteAfter}, ${siteSecond} discoveries`);
    await evaluate(() => window.DRIFTWING.ctx.systems.spawns.debug.testKit.detachSiteFeed());

    // ---- debugger -------------------------------------------------------------------------------------------
    const rollWhileHolding = async () => {
      await page.keyboard.down('KeyD');
      await sleep(450);
      const roll = await evaluate(() => window.DRIFTWING.ctx.controls.roll);
      await page.keyboard.up('KeyD');
      await sleep(400);
      return roll;
    };
    await page.mouse.click(options.width / 2, options.height / 2);
    const rollClosed = await rollWhileHolding();
    check('debugger', 'closed: flight keys fly (D rolls right)', rollClosed > 0.2, `roll ${rollClosed.toFixed(2)}`);
    await page.keyboard.press('F9');
    await sleep(700);
    const opened = await evaluate(() => ({
      open: Boolean(document.querySelector('#dw-spawn-debugger.dw-open')),
      focused: document.getElementById('dw-spawn-debugger')?.contains(document.activeElement) ?? false,
      presets: document.querySelectorAll('#dw-spawn-debugger .dw-spawndbg-list')[0]?.children.length ?? 0,
      director: document.querySelector('#dw-spawn-debugger .dw-spawndbg-section:nth-of-type(3) .dw-spawndbg-empty')?.textContent ?? '',
    }));
    await page.screenshot({ path: join(options.out, 'debugger.png') });
    check('debugger', 'F9 opens the panel with focus inside it', opened.open && opened.focused, JSON.stringify(opened));
    check('debugger', 'it lists the presets and says the director is not running', opened.presets >= 9 && /not running/i.test(opened.director), `${opened.presets} presets, "${opened.director}"`);
    const rollOpen = await rollWhileHolding();
    check('debugger', 'open and focused: flight keys stay in the panel', Math.abs(rollOpen) < 0.05, `roll ${rollOpen.toFixed(2)}`);
    // The panel's controls, driven through the DOM like a player would.
    const controls = await evaluate(async () => {
      const ctx = window.DRIFTWING.ctx;
      const panel = document.getElementById('dw-spawn-debugger');
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rowFor = (name) => [...panel.querySelectorAll('.dw-spawndbg-item')].find((item) => item.querySelector('.dw-spawndbg-item-name')?.firstChild?.textContent === name);
      const buttonIn = (row, label) => [...row.querySelectorAll('button')].find((node) => node.textContent === label);
      const result = {};
      // Force-spawn ahead: the Spawn button of "Test marker".
      const before = ctx.systems.spawns.getStats().spawns;
      buttonIn(rowFor('Test marker'), 'Spawn').click();
      await wait(300);
      const spawned = ctx.systems.spawns.getActive().find((spawn) => spawn.presetId === 'testMarker' && spawn.source === 'debug');
      result.spawned = { count: ctx.systems.spawns.getStats().spawns - before, distance: spawned?.distance ?? null };
      if (spawned) ctx.systems.spawns.deactivate(spawned.id, 'test');
      // Teleport to the nearest site of a type: a test site 6 km ahead, then its Nearest button.
      const site = ctx.systems.spawns.debug.testKit.placeTestSite(6000);
      buttonIn(rowFor('Test site'), 'Nearest').click();
      await wait(300);
      const player = ctx.state.player.position;
      result.teleport = { distance: Math.round(Math.hypot(player.x - site.x, player.z - site.z)), agl: Math.round(player.y - Math.max(ctx.world.groundHeight(player.x, player.z), ctx.world.WATER_LEVEL)) };
      ctx.systems.spawns.debug.testKit.detachSiteFeed();
      // Time of day scrubber.
      const range = panel.querySelector('input[type="range"]');
      range.value = '0.5';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(100);
      result.dayTime = Math.round(ctx.systems.sky.getDayTime() * 1000) / 1000;
      // Wind overlay toggle.
      const overlayBefore = Boolean(ctx.settings.get('windOverlay'));
      [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Wind arrows').click();
      await wait(100);
      result.overlay = { before: overlayBefore, after: Boolean(ctx.settings.get('windOverlay')) };
      [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Wind arrows').click();
      // Engine stats rows.
      result.engineRows = [...panel.querySelectorAll('.dw-spawndbg-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent).join(' | '));
      return result;
    });
    check('debugger', 'Spawn force-spawns the preset ahead of the craft', controls.spawned.count === 1 && controls.spawned.distance > 300 && controls.spawned.distance < 2500, JSON.stringify(controls.spawned));
    check('debugger', 'Nearest teleports next to the nearest site of that preset', Math.abs(controls.teleport.distance - 1800) < 60 && controls.teleport.agl > 200, JSON.stringify(controls.teleport));
    check('debugger', 'the scrubber sets the time of day', Math.abs(controls.dayTime - 0.5) < 0.002, String(controls.dayTime));
    check('debugger', 'the Wind arrows button toggles the WindField overlay', controls.overlay.after !== controls.overlay.before, JSON.stringify(controls.overlay));
    check('debugger', 'engine stats list both test engines', controls.engineRows.length === 2 && controls.engineRows.every((row) => /^test(Marker|Wind) \|/.test(row)), controls.engineRows.join(' ; '));
    await page.keyboard.press('F9');
    await sleep(500);
    const closed = await evaluate(() => !document.querySelector('#dw-spawn-debugger.dw-open'));
    const rollAfter = await rollWhileHolding();
    check('debugger', 'F9 closes it and the flight keys fly again', closed && rollAfter > 0.2, `roll ${rollAfter.toFixed(2)}`);

    report.stats = await evaluate(() => window.DRIFTWING.ctx.systems.spawns.getStats());
  } finally {
    await browser.close().catch((error) => process.stderr.write(`browser close failed: ${error.message}\n`));
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      process.stderr.write(`could not remove temporary profile ${profileDir}: ${error.message}\n`);
    }
  }
  check('console', 'no console errors', logs.errors.length === 0, logs.errors.slice(0, 5).join(' | '));
  check('console', 'no console warnings', logs.warnings.length === 0, logs.warnings.slice(0, 5).join(' | '));
  const failed = results.filter((result) => !result.pass).length;
  report.passed = failed === 0;
  writeFileSync(join(options.out, 'spawn-check.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed on ${report.backend}; report and screenshots in ${options.out}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`spawn-check failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
