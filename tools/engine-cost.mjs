// Engine cost check (Phase 2 engines): measures what a spawn engine costs per frame in V2 on a running
// dev server, headless, and proves its frame update allocates nothing:
//
//   cost        representative scenes of the engine (preset-like configurations through the spawns dev
//               hook, placed over open water ahead of the craft), each measured over a 3 s window of the
//               live animation loop: the engine's update CPU per frame, the shared water layer's update
//               CPU per frame, the frame interval, and the renderer's triangles and draw calls
//   allocation  the busiest scene with the loop paused, its spawn update and water system ticked by hand
//               after a warm-up that runs every path (the craft flies through the first spawn), sampled
//               by the heap profiler in two windows (the first reported, the second judged): samples
//               and bytes per frame in the engine's own files (under 0.1 samples per frame: nothing
//               allocated per frame), and in what they call outside them (terrain heights, audio
//               voices, bus events; reported)
//
// The frame interval measures the whole machine, which other programs may be loading; the engine CPU
// is the engine's own share of it. Any console error or warning fails the run.
//
// Usage: node tools/engine-cost.mjs --url http://127.0.0.1:<port>/v2/ --engine fauna|waterEffect
//          [--backend webgpu|webgl] [--out <dir>] [--frames 3000] [--scenes 0,2] [--headful]
// --scenes runs only those scenes (indices into SCENES[engine]); the last one listed is sampled.
// Exits 0 when every check passes; the numbers are in <out>/engine-cost-<engine>-<backend>.json.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from './browser.mjs';

const SEED = 'ENGINECOST';
const WINDOW_MS = 3000;
const SETTLE_MS = 2000;
const WARMUP_FRAMES = 400;
const WARMUP_UPDATES = 3000;
/**
 * The heap profiler samples an allocation about every SAMPLING_BYTES bytes, so anything the frame
 * update allocated every frame (one boxed number is 12 bytes) would show as at least 0.37 samples per
 * frame. The check allows under 0.1 samples per frame. What is left in a steady state is the JIT's
 * own background (code, feedback and deoptimisation data of 36 bytes to a few kilobytes while a hot
 * function is re-tiered, about one sample per 100 to 200 frames), reported with the sample sizes.
 */
const SAMPLING_BYTES = 32;
const MAX_SAMPLES_PER_FRAME = 0.1;
/** The warm-up flight through the first spawn: at its anchor's height (null) or this height (m MSL). */
const THROUGH_HEIGHT = Object.freeze({ fauna: null, waterEffect: 8 });

/** The engine's own source files (allocation attribution). */
const OWN_FILES = Object.freeze({
  fauna: Object.freeze(['/src/spawns/engines/faunaEngine.js', '/src/spawns/engines/faunaSpecies.js']),
  waterEffect: Object.freeze(['/src/spawns/engines/waterEffectEngine.js', '/src/render/waterEffects.js']),
});

/**
 * Scenes per engine: { name, time (day fraction), spawns: [{ engines, ahead: [distance, side, up] or
 * 'sea', heading?, extra? }] }. Positions are relative to the craft, which flies level over open water.
 */
const SCENES = Object.freeze({
  fauna: [
    { name: 'empty', time: 0.45, spawns: [] },
    { name: 'murmuration 3000 starlings', time: 0.45, spawns: [
      { engines: [{ engine: 'fauna', params: { species: 'starling', behavior: 'murmuration', count: 3000 } }], ahead: [600, 0, 30] },
    ] },
    { name: 'murmuration 8000 starlings', time: 0.45, spawns: [
      { engines: [{ engine: 'fauna', params: { species: 'starling', behavior: 'murmuration', count: 8000, murmuration: { radius: 170 } } }], ahead: [700, 0, 30] },
    ] },
    { name: 'sky whale drift with slipstream (heavy)', time: 0.45, spawns: [
      { engines: [{ engine: 'fauna', params: { species: 'skyWhale', behavior: 'drift', count: 2, size: 230, drift: { slipstream: true } } }], ahead: [900, 0, 90], extra: { heavy: true, lure: { type: 'whale', height: 420, width: 1500, altitude: 1400, color: 0x5f6d80 }, lod: { near: 3000, mid: 7000, far: 40000 } } },
    ] },
    { name: 'every behaviour at once (3000 + 9 + 5 + 1 + 2 + 4 agents)', time: 0.45, spawns: [
      { engines: [{ engine: 'fauna', params: { species: 'starling', behavior: 'murmuration', count: 3000 } }], ahead: [600, 0, 30] },
      { engines: [{ engine: 'fauna', params: { species: 'goose', behavior: 'formation', count: 9 } }], ahead: [250, -40, 5] },
      { engines: [{ engine: 'fauna', params: { species: 'hawk', behavior: 'circling', count: 5 } }], ahead: [400, 120, 0] },
      { engines: [{ engine: 'fauna', params: { species: 'eagle', behavior: 'wingman', count: 1 } }], ahead: [200, 60, 0] },
      { engines: [{ engine: 'fauna', params: { species: 'skyWhale', behavior: 'drift', count: 2, size: 230, drift: { slipstream: true } } }], ahead: [900, 0, 90], extra: { heavy: true, lure: { type: 'whale', height: 420, width: 1500, altitude: 1400, color: 0x5f6d80 }, lod: { near: 3000, mid: 7000, far: 40000 } } },
      { engines: [{ engine: 'fauna', params: { species: 'whale', behavior: 'pod', count: 4, pod: { breachChance: 0.8, diveSeconds: [2, 4] } } }], ahead: 'sea', extra: { category: 'ocean' } },
    ] },
  ],
  waterEffect: [
    { name: 'empty', time: 0.02, spawns: [] },
    { name: 'maelstrom whirlpool (radius 320 m)', time: 0.45, spawns: [
      { engines: [{ engine: 'waterEffect', params: { effect: 'whirlpool', spinUp: 1 } }], ahead: 'sea', extra: { category: 'ocean' } },
    ] },
    { name: 'bioluminescent bay at night with splashes', time: 0.02, spawns: [
      { engines: [{ engine: 'waterEffect', params: { effect: 'bioluminescence', radius: 1100 } }, { engine: 'waterEffect', params: { effect: 'splash', interval: [0.6, 1.4], scatter: 120 } }], ahead: 'sea', extra: { category: 'ocean' } },
    ] },
    { name: 'every effect at once (whirlpool, spray, splashes, bay, pool on the sea)', time: 0.02, spawns: [
      { engines: [{ engine: 'waterEffect', params: { effect: 'whirlpool', spinUp: 1 } }], ahead: 'sea', extra: { category: 'ocean' } },
      { engines: [{ engine: 'waterEffect', params: { effect: 'spray' } }], ahead: [350, 150, 0], extra: { category: 'ocean' } },
      { engines: [{ engine: 'waterEffect', params: { effect: 'bioluminescence', radius: 1100 } }, { engine: 'waterEffect', params: { effect: 'splash', interval: [0.6, 1.4], scatter: 120 } }], ahead: [250, -150, 0], extra: { category: 'ocean' } },
      { engines: [{ engine: 'waterEffect', params: { effect: 'plungePool', radius: 60 } }], ahead: [450, -60, 0], extra: { category: 'ocean' } },
    ] },
  ],
});

function parseArgs(argv) {
  const options = { url: null, engine: null, backend: 'webgpu', out: join(tmpdir(), 'driftwing-engine-cost'), frames: 3000, scenes: null, headful: false, width: 1280, height: 720 };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--url': options.url = next(); break;
      case '--engine': options.engine = next(); break;
      case '--backend': options.backend = next(); break;
      case '--out': options.out = next(); break;
      case '--frames': options.frames = Number(next()); break;
      case '--scenes': options.scenes = next().split(',').map(Number); break;
      case '--headful': options.headful = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!options.url) throw new Error('--url <dev server V2 address> is required');
  if (!SCENES[options.engine]) throw new Error(`--engine must be one of ${Object.keys(SCENES).join(', ')}`);
  if (!['webgpu', 'webgl'].includes(options.backend)) throw new Error('--backend must be webgpu or webgl');
  if (!Number.isInteger(options.frames) || options.frames < 100) throw new Error('--frames must be an integer of at least 100');
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(10)} ${name}${detail ? `  (${detail})` : ''}\n`);
}

/** In the page: the measuring kit (meters on the engine and the water layer, spawning, windows). */
function installKit(engineName) {
  const game = window.DRIFTWING;
  const { ctx, state } = game;
  const spawns = ctx.systems.spawns;
  if (!spawns.debug) throw new Error('engine-cost needs the spawns dev API (a dev server, ?debug=1 or ?dev=1)');
  const manager = spawns.manager;
  const engine = manager.registry.get(engineName);
  if (!engine) throw new Error(`engine-cost: engine ${engineName} is not registered`);
  const layer = ctx.systems.water.effects;
  const meter = { engine: 0, layer: 0 };
  const engineUpdate = engine.update;
  engine.update = function meteredUpdate(instance, dt, engineCtx) {
    const start = performance.now();
    engineUpdate.call(engine, instance, dt, engineCtx);
    meter.engine += performance.now() - start;
  };
  const layerUpdate = layer.update;
  layer.update = function meteredLayerUpdate(...args) {
    const start = performance.now();
    layerUpdate.apply(layer, args);
    meter.layer += performance.now() - start;
  };
  // Open water: a square of sea around a point, the nearest one to the craft (the widest found).
  const world = ctx.world;
  const open = (x, z, radius) => {
    for (let dx = -radius; dx <= radius; dx += 80) for (let dz = -radius; dz <= radius; dz += 80) if (world.heightAt(x + dx, z + dz) > -0.5) return false;
    return true;
  };
  let sea = null;
  const origin = state.player.position;
  for (const radius of [1200, 700, 450]) {
    for (let reach = 0; reach < 60000 && !sea; reach += 400) {
      for (let step = 0; step < 48; step++) {
        const x = origin.x + Math.cos((step / 48) * Math.PI * 2) * reach;
        const z = origin.z + Math.sin((step / 48) * Math.PI * 2) * reach;
        if (open(x, z, radius)) {
          sea = { x, z, radius };
          break;
        }
      }
    }
    if (sea) break;
  }
  if (!sea) throw new Error('engine-cost: no open water found within 60 km');
  let presetCount = 0;
  const kit = {
    sea,
    ids: [],
    restore() {
      engine.update = engineUpdate;
      layer.update = layerUpdate;
    },
    /** Puts the craft level over the sea, 900 m south of the sea point, flying north. */
    place() {
      ctx.systems.flight.resetTo({ x: sea.x, y: 300, z: sea.z + 900, heading: 0 });
    },
    spawn(entry) {
      const player = state.player;
      const extra = entry.extra ?? {};
      let position;
      if (entry.ahead === 'sea') position = { x: sea.x, y: 0, z: sea.z };
      else {
        const [distance, side, up] = entry.ahead;
        position = { x: player.position.x + side, y: player.position.y + up, z: player.position.z - distance };
      }
      const id = `engineCost${++presetCount}`;
      const freeze = (value) => {
        if (value && typeof value === 'object') {
          Object.values(value).forEach(freeze);
          Object.freeze(value);
        }
        return value;
      };
      spawns.debug.addPreset(freeze({
        id, name: id, category: extra.category ?? 'wildlife', kind: 'event', rarity: 'common', heavy: extra.heavy ?? false,
        candidates: { cellSize: 6000, bucketSeconds: 600, chance: 0.1 }, filters: { biomes: null, timeOfDay: null, altitude: null, weather: null },
        engines: entry.engines, lod: extra.lod ?? { near: 2500, mid: 6000, far: 14000 }, lure: extra.lure ?? null, wind: [], audio: null,
        journal: { title: id, description: 'An engine cost configuration.' }, discovery: { radius: 800, requireInView: true },
        callouts: ['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Engine cost: {name}.'],
        lifetime: { duration: [900, 1200], despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 30 } }, achievements: [],
      }));
      const spawnId = manager.activate(id, { position, heading: 0, source: 'debug', force: true });
      if (!spawnId) throw new Error(`engine-cost: ${id} was refused (${JSON.stringify(manager.getStats().refusals)})`);
      kit.ids.push(spawnId);
      return spawnId;
    },
    endAll() {
      for (const id of kit.ids) manager.deactivate(id, 'engine cost');
      kit.ids.length = 0;
    },
    window() {
      return { frame: state.frame, time: performance.now(), engine: meter.engine, layer: meter.layer };
    },
    read(start) {
      const now = kit.window();
      const frames = Math.max(1, now.frame - start.frame);
      const info = ctx.renderer.info.render;
      const stats = engine.stats();
      return {
        frames,
        frameMs: Math.round(((now.time - start.time) / frames) * 100) / 100,
        engineCpuMs: Math.round(((now.engine - start.engine) / frames) * 1000) / 1000,
        layerCpuMs: Math.round(((now.layer - start.layer) / frames) * 1000) / 1000,
        triangles: info.triangles,
        drawCalls: info.drawCalls,
        engineStats: { instances: stats.instances, particles: stats.particles, drawCalls: stats.drawCalls },
      };
    },
  };
  window.__engineCost = kit;
  kit.place();
  return { backend: game.backend, sea };
}

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const url = new URL(options.url);
  url.searchParams.set('seed', SEED);
  if (options.backend === 'webgl') url.searchParams.set('renderer', 'webgl');
  const profileDir = join(tmpdir(), `driftwing-engine-cost-${process.pid}`);
  const browser = await puppeteer.launch({
    executablePath: findBrowser(null),
    headless: !options.headful,
    userDataDir: profileDir,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', `--window-size=${options.width},${options.height}`],
    defaultViewport: { width: options.width, height: options.height },
  });
  const logs = { errors: [], warnings: [] };
  const report = { url: url.href, engine: options.engine, backend: null, checks: results, console: logs, scenes: [], allocation: null };
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'assert') logs.errors.push(message.text());
      else if (type === 'warn' || type === 'warning') logs.warnings.push(message.text());
    });
    page.on('pageerror', (error) => logs.errors.push(`pageerror: ${error.message}`));
    const cdp = await page.createCDPSession();
    const evaluate = (fn, ...args) => page.evaluate(fn, ...args);

    await page.goto(url.href, { waitUntil: 'load', timeout: 120000 });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(await evaluate(() => Boolean(window.DRIFTWING?.ready)).catch(() => false))) await sleep(250);
    const boot = await evaluate(installKit, options.engine);
    report.backend = boot.backend;
    check('boot', `V2 ready on ${boot.backend}, open water found`, options.backend === 'webgl' ? boot.backend === 'WebGL2' : boot.backend === 'WebGPU', JSON.stringify(boot.sea));
    await sleep(SETTLE_MS);

    // ---- cost ------------------------------------------------------------------------------------
    const scenes = options.scenes ? options.scenes.map((index) => SCENES[options.engine][index]) : SCENES[options.engine];
    if (scenes.some((scene) => !scene)) throw new Error(`--scenes: indices 0-${SCENES[options.engine].length - 1}`);
    for (const [index, scene] of scenes.entries()) {
      await evaluate((entry) => {
        const kit = window.__engineCost;
        window.DRIFTWING.ctx.systems.sky.setDayTime(entry.time, { transition: 0 });
        kit.place();
        for (const spawn of entry.spawns) kit.spawn(spawn);
      }, scene);
      await sleep(SETTLE_MS);
      const start = await evaluate(() => window.__engineCost.window());
      await sleep(WINDOW_MS);
      const reading = await evaluate((from) => window.__engineCost.read(from), start);
      report.scenes.push({ name: scene.name, ...reading });
      await page.screenshot({ path: join(options.out, `cost-${options.engine}-${options.backend}-${report.scenes.length}.png`) });
      // The last (busiest) scene stays live for the allocation check.
      if (index < scenes.length - 1) {
        await evaluate(() => window.__engineCost.endAll());
        await sleep(1000);
      }
      check('cost', scene.name, Number.isFinite(reading.engineCpuMs) && reading.frames > 10, `engine ${reading.engineCpuMs} ms/frame, water layer ${reading.layerCpuMs} ms/frame, frame ${reading.frameMs} ms, ${reading.triangles} triangles, ${reading.drawCalls} draw calls, engine ${JSON.stringify(reading.engineStats)}`);
    }

    // ---- allocation (the last, busiest scene is still live) -------------------------------------------
    // The loop is paused and the sampled work is the spawn update and the water system on their own
    // (manager.update and water.update with the flight clock advanced by hand), as tools/spawn-check.mjs
    // samples the manager: rendering runs no engine code and would only add the renderer's own noise.
    // Warm-up: V8 tiers the code up over the first calls (its lower tiers box doubles) and deoptimises
    // once when a branch first runs, so every path runs before sampling: many ticks, then whole frames
    // with the craft flown through the first spawn (a scatter, craft contact), then more ticks with the
    // craft turned away from everything.
    await evaluate(async (warmUp) => {
      const game = window.DRIFTWING;
      const { ctx, state } = game;
      const manager = ctx.systems.spawns.manager;
      const kit = window.__engineCost;
      // The meters call performance.now(), which allocates: they are off for the allocation check.
      kit.restore();
      kit.tick = () => {
        state.time.elapsed += 1 / 60;
        manager.update(1 / 60, 1 / 60);
        ctx.systems.water.update(1 / 60, 1 / 60);
      };
      kit.ticks = async (count) => {
        for (let done = 0; done < count; done += 100) {
          for (let call = 0; call < 100 && done + call < count; call++) kit.tick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      game.debug.pauseLoop();
      await kit.ticks(warmUp.updates);
      const target = manager.getParts(kit.ids[0])[0].anchor;
      const height = warmUp.through === null ? target.y : warmUp.through;
      ctx.systems.flight.resetTo({ x: target.x, y: height, z: target.z + 150, heading: 0 });
      for (let done = 0; done < warmUp.frames; done += 50) game.debug.stepFrames(50);
      ctx.systems.flight.resetTo({ x: kit.sea.x, y: 300, z: kit.sea.z + 900, heading: 180 });
      game.debug.stepFrames(60);
      await kit.ticks(warmUp.updates * 2);
    }, { frames: WARMUP_FRAMES, updates: WARMUP_UPDATES, through: THROUGH_HEIGHT[options.engine] });
    await cdp.send('HeapProfiler.enable');
    const ownFiles = OWN_FILES[options.engine];
    report.allocation = [];
    for (let windowIndex = 0; windowIndex < 2; windowIndex++) {
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_BYTES, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      await evaluate((frames) => window.__engineCost.ticks(frames), options.frames);
      const { profile } = await cdp.send('HeapProfiler.stopSampling');
      // Samples by the profile node of the code that allocated.
      const nodeSamples = new Map();
      for (const sample of profile.samples) {
        const entry = nodeSamples.get(sample.nodeId) ?? { count: 0, sizes: [] };
        entry.count++;
        entry.sizes.push(sample.size);
        nodeSamples.set(sample.nodeId, entry);
      }
      let ownBytes = 0;
      let calleeBytes = 0;
      let ownSamples = 0;
      const sites = new Map();
      const walk = (node, underOwn) => {
        const file = node.callFrame.url.split('?')[0];
        const own = ownFiles.some((path) => file.endsWith(path));
        if (node.selfSize > 0 && (own || underOwn)) {
          const samples = nodeSamples.get(node.id) ?? { count: 0, sizes: [] };
          if (own) {
            ownBytes += node.selfSize;
            ownSamples += samples.count;
          } else calleeBytes += node.selfSize;
          const key = `${node.callFrame.functionName || '(anonymous)'} ${file.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
          const site = sites.get(key) ?? { bytes: 0, samples: 0, sizes: [] };
          site.bytes += node.selfSize;
          site.samples += samples.count;
          site.sizes.push(...samples.sizes);
          sites.set(key, site);
        }
        for (const child of node.children) walk(child, underOwn || own);
      };
      walk(profile.head, false);
      const ownPerFrame = ownBytes / options.frames;
      const calleePerFrame = calleeBytes / options.frames;
      const samplesPerFrame = ownSamples / options.frames;
      const top = [...sites.entries()].sort((first, second) => second[1].bytes - first[1].bytes).slice(0, 5);
      report.allocation.push({ frames: options.frames, ownBytes, ownSamples, calleeBytes, ownPerFrame, calleePerFrame, samplesPerFrame, sites: top });
      const detail = `${ownBytes} B in ${ownSamples} samples over ${options.frames} frames = ${ownPerFrame.toFixed(3)} B/frame; callees ${calleeBytes} B = ${calleePerFrame.toFixed(3)} B/frame${top.length ? `; top: ${top.map(([key, site]) => `${key} ${site.bytes} B (${site.samples} samples: ${site.sizes.slice(0, 6).join(', ')} B)`).join(', ')}` : ''}`;
      // The first window still sees the JIT settling; the second is the steady state the check judges.
      if (windowIndex === 0) process.stdout.write(`INFO  alloc      window 1 (settling): ${detail}
`);
      else check('alloc', `steady state: the ${options.engine} frame update allocates nothing per frame in its own files (under ${MAX_SAMPLES_PER_FRAME} heap samples per frame; one 12-byte object per frame would give 0.37)`, samplesPerFrame < MAX_SAMPLES_PER_FRAME, detail);
    }
    await evaluate(() => {
      const game = window.DRIFTWING;
      const kit = window.__engineCost;
      kit.endAll();
      game.debug.stepFrames(3);
      game.debug.resumeLoop();
    });
    await sleep(1000);
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
  writeFileSync(join(options.out, `engine-cost-${options.engine}-${options.backend}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed on ${report.backend}; report and screenshots in ${options.out}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`engine-cost failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
