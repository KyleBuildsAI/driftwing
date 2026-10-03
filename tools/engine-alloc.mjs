// Samples the JS allocations of spawn engines' frame updates (the zero-allocation rule of the engine
// contract). It loads V2, runs the setup step of an engine step file (tools/steps/engine-<name>.json:
// its first step registers the test presets), force-spawns the given presets ahead of the craft in
// photo mode, then runs the SpawnManager's update for many frames under the CDP sampling heap
// profiler, advancing the frame counter so each engine's once-per-frame work runs too.
//
// Usage:
//   node tools/engine-alloc.mjs --url http://127.0.0.1:<port>/v2/ --steps tools/steps/engine-emitter.json
//     --presets emVolcano,emGeyser [--backend webgpu|webgl] [--frames 1000] [--warmup 12000] [--distance 800]
//
// Bytes allocated in src/spawns/engines/ count as the engines' own; bytes allocated by what they call
// elsewhere (three.js uploads and compute dispatches, the WindField, the terrain height function, the
// audio engine) are reported separately with the top sites. Own bytes under an engine's lifecycle
// entry points (create, setLOD, dispose: a spawn that ends or changes tier during the run) are
// reported apart too, since the contract's zero-allocation rule is for the frame update. Objects the
// garbage collector already took are sampled as well, so short-lived garbage counts. A tight warm-up
// loop runs first, so the optimising compiler's one-time feedback allocations stay out of the
// sample. Exits non-zero when the engines' own frame-update allocations reach 0.1 byte per frame or
// the console has an error or a warning.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from './browser.mjs';

const SEED = 'ENGINEALLOC';
const OWN_LIMIT_BYTES_PER_FRAME = 0.1;
const DEFAULT_WARMUP_FRAMES = 12000;
/** Warm-up rounds, each followed by a pause of WARMUP_PAUSE_MS. */
const WARMUP_ROUNDS = 3;
const WARMUP_PAUSE_MS = 4000;
// Coarse on purpose: with collected objects sampled, three.js's own frame garbage makes a fine
// interval take many minutes to stop. A real per-frame allocation of 16 bytes still lands about 30
// samples over 1000 frames, while one sample alone already fails the 0.1 B/frame limit.
const SAMPLING_INTERVAL_BYTES = 512;
/** Engine entry points that run on a spawn's lifecycle rather than every frame. */
const LIFECYCLE_ENTRIES = new Set(['init', 'create', 'setLOD', 'dispose']);

function parseArgs(argv) {
  const options = { url: null, steps: null, presets: [], backend: 'webgpu', frames: 1000, warmup: DEFAULT_WARMUP_FRAMES, distance: 800 };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--url': options.url = next(); break;
      case '--steps': options.steps = next(); break;
      case '--presets': options.presets = next().split(',').filter(Boolean); break;
      case '--backend': options.backend = next(); break;
      case '--frames': options.frames = Number(next()); break;
      case '--warmup': options.warmup = Number(next()); break;
      case '--distance': options.distance = Number(next()); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!options.url || !options.steps || options.presets.length === 0) throw new Error('--url, --steps and --presets are required');
  if (!['webgpu', 'webgl'].includes(options.backend)) throw new Error('--backend must be webgpu or webgl');
  if (!Number.isInteger(options.frames) || options.frames < 100) throw new Error('--frames must be an integer of at least 100');
  if (!Number.isInteger(options.warmup) || options.warmup < WARMUP_ROUNDS) throw new Error(`--warmup must be an integer of at least ${WARMUP_ROUNDS}`);
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const options = parseArgs(process.argv);
  const setup = JSON.parse(readFileSync(options.steps, 'utf8'))[0];
  if (!setup || typeof setup.eval !== 'string') throw new Error(`${options.steps}: the first step must be the setup eval`);
  const url = new URL(options.url);
  url.searchParams.set('seed', SEED);
  if (options.backend === 'webgl') url.searchParams.set('renderer', 'webgl');
  const browser = await puppeteer.launch({
    executablePath: findBrowser(null),
    headless: true,
    userDataDir: join(tmpdir(), `driftwing-engine-alloc-${process.pid}`),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 },
    // Stopping a sampling profile that keeps collected objects takes minutes on a busy machine.
    protocolTimeout: 900000,
  });
  const logs = { errors: [], warnings: [] };
  let failed = false;
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'assert') logs.errors.push(message.text());
      else if (type === 'warn' || type === 'warning') logs.warnings.push(message.text());
    });
    page.on('pageerror', (error) => logs.errors.push(`pageerror: ${error.message}`));
    const cdp = await page.createCDPSession();
    await page.goto(url.href, { waitUntil: 'load', timeout: 120000 });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(await page.evaluate(() => Boolean(window.DRIFTWING?.ready)).catch(() => false))) await sleep(250);
    const backend = await page.evaluate(() => window.DRIFTWING?.backend ?? null);
    if (!backend) throw new Error('V2 did not report ready');
    process.stdout.write(`backend ${backend}\n`);
    process.stdout.write(`setup: ${await page.evaluate(setup.eval)}\n`);
    const spawned = await page.evaluate((presets, distance) => {
      const { ctx } = window.DRIFTWING;
      return presets.map((id) => ctx.systems.spawns.forceSpawn(id, { distance }));
    }, options.presets, options.distance);
    process.stdout.write(`spawned: ${spawned.join(', ')}\n`);
    // Warm-up: the first frames build pipelines, fill wind grids and settle the lights; then tight
    // loops like the sampled one let the optimising compiler settle. The optimising compilers run on
    // background threads, which a busy machine starves: each round is followed by a pause in which
    // the finished code is installed, or the sample would catch unoptimised code boxing its numbers.
    await sleep(3000);
    for (let round = 0; round < WARMUP_ROUNDS; round++) {
      await page.evaluate((frames) => {
        const { ctx, state } = window.DRIFTWING;
        for (let frame = 0; frame < frames; frame++) {
          state.frame++;
          ctx.systems.spawns.manager.update(1 / 60, 1 / 60);
        }
      }, Math.ceil(options.warmup / WARMUP_ROUNDS));
      await sleep(WARMUP_PAUSE_MS);
    }

    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL_BYTES, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await page.evaluate((frames) => {
      const { ctx, state } = window.DRIFTWING;
      const manager = ctx.systems.spawns.manager;
      const firstFrame = state.frame;
      // The simulation stands still (photo mode) while this loop advances the frame counter itself,
      // so every engine's once-per-frame work runs each iteration.
      for (let frame = 0; frame < frames; frame++) {
        state.frame = firstFrame + 1 + frame;
        manager.update(1 / 60, 1 / 60);
      }
    }, options.frames);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    // Read after the sample: stats() builds its report object, which is not frame-update work.
    const engines = await page.evaluate(() => Object.entries(window.DRIFTWING.ctx.systems.spawns.manager.getStats().engines)
      .filter(([, entry]) => entry.instances > 0).map(([name, entry]) => `${name} ${entry.instances}`));

    let ownBytes = 0;
    let lifecycleBytes = 0;
    let calleeBytes = 0;
    const ownSites = new Map();
    const lifecycleSites = new Map();
    const calleeSites = new Map();
    const siteName = (node) => `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('?')[0].split('/').pop() || '(native)'}:${node.callFrame.lineNumber + 1}`;
    // caller: the innermost engine frame above a node (the engine code that led to a callee's bytes);
    // entry: the outermost one (the engine API the SpawnManager called).
    const walk = (node, caller, entry) => {
      const file = node.callFrame.url.split('?')[0];
      const own = file.includes('/src/spawns/engines/');
      const nearest = own ? siteName(node) : caller;
      const outermost = entry ?? (own ? node.callFrame.functionName : null);
      if (node.selfSize > 0 && nearest) {
        if (own && LIFECYCLE_ENTRIES.has(outermost)) {
          lifecycleBytes += node.selfSize;
          lifecycleSites.set(nearest, (lifecycleSites.get(nearest) ?? 0) + node.selfSize);
        } else if (own) {
          ownBytes += node.selfSize;
          ownSites.set(nearest, (ownSites.get(nearest) ?? 0) + node.selfSize);
        } else {
          calleeBytes += node.selfSize;
          const key = `${siteName(node)} <- ${nearest}`;
          calleeSites.set(key, (calleeSites.get(key) ?? 0) + node.selfSize);
        }
      }
      for (const child of node.children) walk(child, nearest, outermost);
    };
    walk(profile.head, null, null);
    const ownPerFrame = ownBytes / options.frames;
    const ranked = (sites) => [...sites.entries()].sort((first, second) => second[1] - first[1]).slice(0, 6);
    process.stdout.write(`engines: ${engines.join(', ')}
`);
    process.stdout.write(`own (frame update): ${ownBytes} B over ${options.frames} frames = ${ownPerFrame.toFixed(3)} B/frame
`);
    for (const [key, bytes] of ranked(ownSites)) process.stdout.write(`  ${key} ${bytes} B
`);
    process.stdout.write(`lifecycle (create, setLOD, dispose): ${lifecycleBytes} B
`);
    for (const [key, bytes] of ranked(lifecycleSites)) process.stdout.write(`  ${key} ${bytes} B
`);
    process.stdout.write(`callees: ${calleeBytes} B = ${(calleeBytes / options.frames).toFixed(3)} B/frame
`);
    for (const [key, bytes] of ranked(calleeSites)) process.stdout.write(`  ${key} ${bytes} B
`);
    process.stdout.write(`console: ${logs.errors.length} errors, ${logs.warnings.length} warnings\n`);
    for (const line of [...logs.errors, ...logs.warnings]) process.stdout.write(`  ${line}\n`);
    failed = ownPerFrame >= OWN_LIMIT_BYTES_PER_FRAME || logs.errors.length > 0 || logs.warnings.length > 0;
    process.stdout.write(`${failed ? 'FAIL' : 'PASS'}\n`);
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
