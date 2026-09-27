// Runs a dev verification harness headlessly and saves its report.
//
// Starts the Vite dev server (the harnesses exist only in dev builds) on a free port other than the
// player's 5199, opens ?test=1 (flight test) or ?test=hotas (HOTAS pipeline test) in headless Chrome
// with a fresh profile, follows the harness through its page reloads, waits for
// window.DRIFTWING.testReport to complete, then saves the report, the browser console and
// screenshots of the summary panel, and stops the browser and the server.
//
// Usage:
//   node tools/run-harness.mjs --test 1|hotas [--backend webgpu|webgl] [--seeds A,B,C] [--seconds N]
//     [--crafts glider,jet] [--modes classic,sim] [--out <dir>] [--timeout-minutes N]
//     [--width 1280] [--height 720] [--headful] [--browser <path>]
//
// The runner also samples the whole machine's CPU load every 2 s (machine-load.json) and adds each
// run's average / peak load to report.json (runs[].machineLoad), as evidence when frame spikes come
// from other processes on a shared machine.
//
// Exit code: 0 when the harness reports PASS, the requested backend really ran and the browser
// console stayed free of errors and warnings; 1 on FAIL; 2 when the run itself could not complete.
// Chrome runs with --enable-precise-memory-info and --js-flags=--expose-gc so the heap readings are
// exact (the flight test forces a GC before each reading).
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { findBrowser } from './browser.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The player's dev server port (IndexedDB is scoped to it): never used by the runner. */
const RESERVED_PORT = 5199;
/** Ports Chrome refuses to load (net::ERR_UNSAFE_PORT) in the range the OS may hand out. */
const CHROME_UNSAFE_PORTS = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const POLL_MS = 3000;
/** Whole-machine CPU load is sampled this often, as evidence for frame spikes caused by other processes. */
const LOAD_SAMPLE_MS = 2000;
/** Chrome's own close can hang for minutes on a loaded machine; after this the runner kills it. */
const CLOSE_TIMEOUT_MS = 30000;
const EXPECTED_BACKEND = Object.freeze({ webgpu: 'WebGPU', webgl: 'WebGL2' });

function parseArgs(argv) {
  const options = {
    test: '1',
    backend: 'webgpu',
    seeds: null,
    seconds: null,
    crafts: null,
    modes: null,
    out: null,
    timeoutMinutes: null,
    width: 1280,
    height: 720,
    headful: false,
    browser: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '--test': options.test = next(); break;
      case '--backend': options.backend = next(); break;
      case '--seeds': options.seeds = next(); break;
      case '--seconds': options.seconds = Number(next()); break;
      case '--crafts': options.crafts = next(); break;
      case '--modes': options.modes = next(); break;
      case '--out': options.out = next(); break;
      case '--timeout-minutes': options.timeoutMinutes = Number(next()); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (options.test !== '1' && options.test !== 'hotas') throw new Error('--test must be 1 or hotas');
  if (!EXPECTED_BACKEND[options.backend]) throw new Error('--backend must be webgpu or webgl');
  if (options.seconds !== null && !(options.seconds >= 5)) throw new Error('--seconds must be at least 5');
  options.out ??= join(tmpdir(), `driftwing-harness-${options.test}-${options.backend}`);
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

function log(started, text) {
  process.stdout.write(`run-harness: [${Math.round((Date.now() - started) / 1000)} s] ${text}\n`);
}

/** Closes the browser we launched; kills its process when close() does not finish in time. */
async function closeBrowser(browser, problems) {
  const closed = await Promise.race([
    browser.close().then(() => true, (error) => {
      problems.push(`browser close failed: ${error.message}`);
      return false;
    }),
    sleep(CLOSE_TIMEOUT_MS).then(() => false),
  ]);
  if (closed) return 'closed';
  const child = browser.process();
  if (child && child.exitCode === null) child.kill('SIGKILL');
  return 'killed after the close timed out';
}

/** Summed CPU times of every logical core (ms): { busy, total }. */
function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const core of cpus()) {
    const { user, nice, sys, idle, irq } = core.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

/** Samples the whole machine's CPU load (all processes, all cores) until stop() is called. */
function startLoadSampler() {
  const samples = [];
  let previous = cpuTimes();
  const timer = setInterval(() => {
    const current = cpuTimes();
    const total = current.total - previous.total;
    if (total > 0) samples.push({ time: Date.now(), busyPct: Math.round(((current.busy - previous.busy) / total) * 1000) / 10 });
    previous = current;
  }, LOAD_SAMPLE_MS);
  return {
    samples,
    stop() {
      clearInterval(timer);
    },
    /** Average and peak machine load (%) between two ISO times, or null without samples there. */
    between(startIso, endIso) {
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      const inside = samples.filter((sample) => sample.time >= start && sample.time <= end + LOAD_SAMPLE_MS);
      if (inside.length === 0) return null;
      const average = inside.reduce((sum, sample) => sum + sample.busyPct, 0) / inside.length;
      return { averagePct: Math.round(average * 10) / 10, peakPct: Math.max(...inside.map((sample) => sample.busyPct)), samples: inside.length };
    },
  };
}

/** A free TCP port on 127.0.0.1 that Chrome will load and that is not the player's port. */
async function findFreePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolvePort, rejectPort) => {
      const probe = createNetServer();
      probe.once('error', rejectPort);
      probe.listen(0, '127.0.0.1', () => {
        const { port: assigned } = probe.address();
        probe.close(() => resolvePort(assigned));
      });
    });
    if (port !== RESERVED_PORT && !CHROME_UNSAFE_PORTS.has(port)) return port;
  }
  throw new Error('no usable free port found');
}

function harnessUrl(port, options) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set('test', options.test);
  if (options.backend === 'webgl') url.searchParams.set('renderer', 'webgl');
  if (options.test === '1') {
    if (options.seeds) url.searchParams.set('testSeeds', options.seeds);
    if (options.seconds) url.searchParams.set('testSeconds', String(options.seconds));
    if (options.crafts) url.searchParams.set('testCraft', options.crafts);
    if (options.modes) url.searchParams.set('testModes', options.modes);
  }
  return url.href;
}

/** A generous time limit: the planned flying time plus world loads, with a 50 % margin. */
function timeLimitMs(options) {
  if (Number.isFinite(options.timeoutMinutes) && options.timeoutMinutes > 0) return options.timeoutMinutes * 60000;
  if (options.test === 'hotas') return 8 * 60000;
  const seeds = options.seeds ? options.seeds.split(',').filter(Boolean).length : 3;
  const crafts = options.crafts ? options.crafts.split(',').filter(Boolean).length : 6;
  const modes = options.modes ? options.modes.split(',').filter(Boolean).length : 2;
  const seconds = options.seconds ?? 60;
  const plannedSeconds = seeds * crafts * modes * (seconds + 3) + (seeds + 1) * 90;
  return Math.max(10 * 60000, plannedSeconds * 1500);
}

/** Reads the harness state; null while the page is (re)loading or the report is not there yet. */
async function readProgress(page) {
  try {
    return await page.evaluate(() => {
      const report = window.DRIFTWING && window.DRIFTWING.testReport;
      if (!report || !report.status) return null;
      return { status: report.status, result: report.result, progress: report.progress ?? null, backend: window.DRIFTWING.backend };
    });
  } catch (error) {
    // The harness reloads the page for every seed; the old document's context goes away mid-call.
    return { status: 'navigating', detail: error.message };
  }
}

function describeProgress(state) {
  if (!state || !state.progress) return state ? state.status : 'loading';
  const { completedRuns, totalRuns, current } = state.progress;
  if (Number.isFinite(completedRuns)) {
    const now = current ? `, flying run ${current.index + 1}: ${current.craft} ${String(current.mode).toUpperCase()} (${current.seed}) ${Math.round(current.seconds ?? 0)} s` : '';
    return `${completedRuns}/${totalRuns} runs done${now}`;
  }
  const { done, phase, step } = state.progress;
  return `${done} checks (${phase})${step ? `, ${step}` : ''}`;
}

function flightTable(report) {
  const lines = ['  #  seed        craft       mode     fps  p99ms  maxms  >50  sys/main/delay  NaN  pen  crash  err/warn  heapMB  script  result  machineCPU%avg/peak'];
  for (const run of report.runs) {
    const checks = run.script.checks;
    lines.push([
      String(run.index + 1).padStart(3),
      run.seed.padEnd(11),
      run.craft.padEnd(11),
      run.mode.toUpperCase().padEnd(7),
      String(run.avgFps).padStart(5),
      String(run.p99Ms).padStart(6),
      String(run.maxMs).padStart(6),
      String(run.slowFrames).padStart(4),
      `${run.slowByCause.systems}/${run.slowByCause.mainThread}/${run.slowByCause.delayed}`.padStart(15),
      String(run.nanEvents).padStart(4),
      String(run.penetrations).padStart(4),
      String(run.softCrashes).padStart(6),
      `${run.consoleErrors}/${run.consoleWarnings}`.padStart(9),
      String(run.heapDeltaMB).padStart(7),
      `${checks.filter((check) => check.passed).length}/${checks.length}`.padStart(7),
      run.passed ? '  PASS' : '  FAIL',
      run.machineLoad ? `  ${run.machineLoad.averagePct}/${run.machineLoad.peakPct}` : '  n/a',
    ].join(' '));
  }
  const totals = report.totals;
  lines.push(`  totals: ${totals.runs} runs, ${totals.measuredSeconds} s measured, avg ${totals.avgFps} fps, worst p99 ${totals.worstP99Ms} ms, max ${totals.maxFrameMs} ms, >50 ms ${totals.slowFrames} (systems ${totals.slowByCause.systems}, main thread ${totals.slowByCause.mainThread}, delayed ${totals.slowByCause.delayed}), NaN ${totals.nanEvents}, penetrations ${totals.penetrations}, soft crashes ${totals.softCrashes}, console ${totals.consoleErrors}/${totals.consoleWarnings}, max heap growth ${totals.maxHeapGrowthMB} MB, script ${totals.scriptChecks}`);
  for (const world of report.worlds) lines.push(`  world ${world.seed} (${world.backend}): load ${world.loadSeconds} s, heap ${world.heapBaselineMB} -> ${world.heapFinalMB} MB (growth ${world.heapGrowthMB} MB)`);
  return lines.join('\n');
}

function hotasTable(report) {
  const lines = [];
  for (const check of report.checks) lines.push(`  ${check.passed ? 'PASS' : 'FAIL'}  [${check.group}] ${check.name}: ${check.actual}${check.passed ? '' : ` (expected ${check.expected})`}`);
  lines.push(`  totals: ${report.totals.passed}/${report.totals.checks} checks passed, console ${report.totals.consoleErrors}/${report.totals.consoleWarnings}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const executablePath = findBrowser(options.browser);
  const port = await findFreePort();
  // A cache of its own: node_modules may be shared with another checkout's running dev server.
  const cacheDir = join(tmpdir(), `driftwing-run-harness-vite-${createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 10)}`);
  const server = await createViteServer({
    root: PROJECT_ROOT,
    configFile: join(PROJECT_ROOT, 'vite.config.js'),
    cacheDir,
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  });
  const profileDir = join(tmpdir(), `driftwing-harness-profile-${process.pid}`);
  let browser = null;
  const runner = {
    test: options.test,
    backendRequested: options.backend,
    url: null,
    browser: executablePath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationSeconds: null,
    navigations: 0,
    errors: [],
    warnings: [],
    info: 0,
    backend: null,
    result: null,
    passed: false,
    problems: [],
  };
  const consoleLines = [];
  const started = Date.now();
  const load = startLoadSampler();
  let report = null;

  try {
    await server.listen();
    runner.url = harnessUrl(port, options);
    process.stdout.write(`run-harness: Vite dev server on http://127.0.0.1:${port}/, opening ${runner.url}\n`);
    browser = await puppeteer.launch({
      executablePath,
      headless: !options.headful,
      userDataDir: profileDir,
      args: [
        '--enable-unsafe-webgpu',
        '--ignore-gpu-blocklist',
        '--enable-gpu',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
        `--window-size=${options.width},${options.height}`,
      ],
      defaultViewport: { width: options.width, height: options.height },
    });
    const page = await browser.newPage();
    page.on('console', (message) => {
      const location = message.location();
      const where = location?.url ? ` (${location.url.split('/').pop()}:${location.lineNumber ?? '?'})` : '';
      const entry = `${message.text()}${where}`;
      const type = message.type();
      consoleLines.push(`[${new Date().toISOString()}] [${type}] ${entry}`);
      if (type === 'error' || type === 'assert') runner.errors.push(entry);
      else if (type === 'warn' || type === 'warning') runner.warnings.push(entry);
      else runner.info++;
    });
    page.on('pageerror', (error) => {
      runner.errors.push(`pageerror: ${error.message}`);
      consoleLines.push(`[${new Date().toISOString()}] [pageerror] ${error.stack ?? error.message}`);
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? '';
      // Requests cut off by the harness's own reloads are aborted by design.
      if (failure === 'net::ERR_ABORTED') return;
      runner.errors.push(`requestfailed: ${request.url()} ${failure}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) runner.errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        runner.navigations++;
        consoleLines.push(`[${new Date().toISOString()}] [navigate] ${frame.url()}`);
      }
    });

    await page.goto(runner.url, { waitUntil: 'load', timeout: 120000 });
    const deadline = started + timeLimitMs(options);
    let lastLine = '';
    let state = null;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      state = await readProgress(page);
      const line = describeProgress(state);
      if (line !== lastLine) {
        log(started, line);
        lastLine = line;
      }
      if (state && state.status === 'complete') break;
    }
    if (!state || state.status !== 'complete') throw new Error(`the harness did not finish within ${Math.round(timeLimitMs(options) / 60000)} min (last state: ${lastLine})`);

    report = await page.evaluate(() => JSON.parse(JSON.stringify(window.DRIFTWING.testReport)));
    log(started, 'harness complete, taking the summary screenshots');
    runner.backend = report.environment?.backends ?? [report.environment?.backend];
    runner.result = report.result;
    await sleep(1500);
    await page.screenshot({ path: join(options.out, 'summary.png') });
    // A tall viewport shows the whole summary table in one image.
    await page.setViewport({ width: options.width, height: Math.max(options.height, options.test === '1' ? 1640 : 1400) });
    await sleep(1500);
    await page.screenshot({ path: join(options.out, 'summary-full.png') });
    // Every page of the scrolled summary body, so the whole table can be read from the images.
    const pages = await page.evaluate(() => {
      const body = document.querySelector('.dw-test-summary .dw-test-body');
      return body ? Math.min(12, Math.ceil(body.scrollHeight / Math.max(body.clientHeight, 1))) : 0;
    });
    for (let pageIndex = 1; pageIndex < pages; pageIndex++) {
      await page.evaluate((index) => {
        const body = document.querySelector('.dw-test-summary .dw-test-body');
        body.scrollTop = index * (body.clientHeight - 40);
      }, pageIndex);
      await sleep(300);
      await page.screenshot({ path: join(options.out, `summary-page-${pageIndex + 1}.png`) });
    }
  } catch (error) {
    runner.problems.push(error.message);
  } finally {
    if (browser) log(started, `browser ${await closeBrowser(browser, runner.problems)}`);
    await server.close().catch((error) => runner.problems.push(`dev server close failed: ${error.message}`));
    log(started, 'dev server stopped');
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      runner.problems.push(`could not remove the temporary profile ${profileDir}: ${error.message}`);
    }
  }

  load.stop();
  runner.finishedAt = new Date().toISOString();
  runner.machineLoad = load.between(runner.startedAt, runner.finishedAt);
  if (report && Array.isArray(report.runs)) {
    // Evidence for the frame statistics: how busy the whole machine was while each run flew.
    for (const run of report.runs) run.machineLoad = run.startedAt ? load.between(run.startedAt, run.endedAt) : null;
  }
  runner.durationSeconds = Math.round((Date.now() - started) / 1000);
  const expected = EXPECTED_BACKEND[options.backend];
  if (runner.backend && !(runner.backend.length === 1 && runner.backend[0] === expected)) {
    runner.problems.push(`requested ${expected} but the game ran on ${runner.backend.join(', ')}`);
  }
  runner.passed = Boolean(report) && report.result === 'PASS' && runner.errors.length === 0 && runner.warnings.length === 0 && runner.problems.length === 0;
  if (report) writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(options.out, 'runner.json'), JSON.stringify(runner, null, 2));
  writeFileSync(join(options.out, 'console.log'), `${consoleLines.join('\n')}\n`);
  writeFileSync(join(options.out, 'machine-load.json'), JSON.stringify(load.samples, null, 2));

  if (report) process.stdout.write(`${options.test === '1' ? flightTable(report) : hotasTable(report)}\n`);
  process.stdout.write(`run-harness: ${runner.passed ? 'PASS' : 'FAIL'} (harness ${report ? report.result : 'no report'}, backend ${runner.backend ? runner.backend.join(', ') : 'unknown'}, browser console ${runner.errors.length} errors / ${runner.warnings.length} warnings, ${runner.durationSeconds} s)\n`);
  for (const problem of runner.problems) process.stdout.write(`run-harness: problem: ${problem}\n`);
  for (const error of runner.errors.slice(0, 20)) process.stdout.write(`run-harness: browser error: ${error}\n`);
  for (const warning of runner.warnings.slice(0, 20)) process.stdout.write(`run-harness: browser warning: ${warning}\n`);
  process.stdout.write(`run-harness: saved report.json, runner.json, console.log and summary screenshots in ${options.out}\n`);
  process.exit(report ? (runner.passed ? 0 : 1) : 2);
}

main().catch((error) => {
  process.stderr.write(`run-harness failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
