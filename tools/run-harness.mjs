// Runs a dev verification harness headlessly and saves its report.
//
// Starts the Vite dev server (the harnesses exist only in dev builds) on a free port other than the
// player's 5199, opens V2's page /v2/?test=1 (flight test), /v2/?test=hotas (HOTAS pipeline test) or
// /v2/?test=terrain (terrain stamps) in headless Chrome with a fresh profile, follows the harness
// through its reloads, waits for window.DRIFTWING.testReport to complete, then saves the report, the
// browser console and screenshots of the summary panel, and stops the browser and the server.
//
// Usage:
//   node tools/run-harness.mjs --test 1|soak|hotas|terrain|determinism|spawns|collision [--backend webgpu|webgl] [--seeds A,B,C] [--seconds N]
//     [--crafts glider,jet] [--views first,third] [--out <dir>] [--timeout-minutes N]
//     [--width 1280] [--height 720] [--headful] [--browser <path>] [--alloc-profile <seconds>]
//     [--presets real | --presets tornado,comet] [--leak-cycles N] [--parts fixture,special,landmarks,structures]
//
// The terrain test runs on one seed (the first of --seeds; by default P2-TERRAIN, or TERRAIN-REAL-8
// with --presets real, a world with every real stamp type near its spawn) in the late
// morning, and afterwards the runner flies its camera tour: one screenshot per stamp type from the
// air (stamp-<type>.png), with the stamp paint in view. --presets real runs it on the game's own
// stamped site presets instead of the fixtures (?presets=real).
//
// The flight test flies every craft in first person (the cockpit or FPV view) and in third person
// (chase) by default; --views first or --views third flies one of them.
//
// The determinism test (/v2/?test=determinism) flies the same scripted path on the same seed (the
// first of --seeds, by default DETERMINISM-1) in two page loads and compares the site-list hash and the
// director's activation log; the runner follows it through its reload.
//
// The soak (--test soak: /v2/?test=1&testPlan=soak) is the flight test as a 10-minute run with the event
// director live: 5 seeds (SOAK-1..5 unless --seeds), one craft per seed, both views, 60 s each.
//
// The spawns test (/v2/?test=spawns) force-spawns each of the 30 presets ahead of the craft on one seed
// (the first of --seeds, by default TERRAIN-REAL-8, whose spawn has a real site of every stamped preset
// in reach), and the runner takes one screenshot per preset when the page asks for it
// (spawn-<nn>-<preset>.png). --presets a,b,c shows only those presets; --leak-cycles N runs N held
// creates and disposes per preset in its leak check instead of 3 (a longer heap trend).
//
// The collision test (/v2/?test=collision) flies the jet and the bush plane into a fixture of every
// collider type, the retrofitted landmarks and the Phase 2 structures at 60, 250 and 1500 m/s on one
// seed (the first of --seeds, by default COLLIDERS-LAB, whose spawn has every landmark type in reach),
// with the slow bump, the landable deck, the tunnel centreline, the arch opening and the kite strings.
// --parts a,b runs some of its parts only (fixture, special, landmarks, structures; the criteria of the
// others are muted).
//
// --alloc-profile N (diagnostic): once the first flight-test run is flying, samples every JS
// allocation for N seconds with the sampling heap profiler (collected objects included, so it is
// the allocation rate, not what survives) and saves the heaviest allocation sites to
// alloc-profile.json (printed as well).
//
// The runner also records evidence for telling game cost from machine load, per flight-test run
// (report.json runs[].machineLoad, runs[].gpuLoad and runs[].mainThread, raw samples in
// machine-load.json and gpu-load.json):
//   - the whole machine's CPU load (all processes, all cores), sampled every 2 s;
//   - the GPU's utilisation and memory (all processes), sampled every 2 s through nvidia-smi when it
//     is installed (NVIDIA GPUs; otherwise reported as unavailable). Another program saturating the
//     GPU shows up here and not in the CPU figures;
//   - Chrome's own main-thread counters over CDP (Performance.getMetrics): TaskDuration (wall time
//     the page's main thread spent in tasks) against ThreadTime (CPU time it was actually given).
//     A CPU share well under 100 % means the thread was waiting or descheduled inside its tasks,
//     which is what a saturated machine does to it; real game work shows up as CPU time;
//   - on Windows, the CPU and GPU load of OTHER processes against our own (tools/process-load.mjs:
//     every process's processor time and Windows' per-process GPU engine counters, split into the
//     harness's Chrome and node processes and everything else, with the busiest other programs
//     named), per run (runs[].processLoad) and at every slow frame (slowFrameList[].load), raw
//     samples in process-load.json. A frame spike that lands in a burst of other programs' load is
//     evidence of the shared machine; one that lands in a quiet interval is not.
//
// Exit code: 0 when the harness reports PASS, the requested backend really ran and the browser
// console stayed free of errors and warnings; 1 on FAIL; 2 when the run itself could not complete.
// Chrome runs with --enable-precise-memory-info and --js-flags=--expose-gc so the heap readings are
// exact (the flight test forces a GC before each reading).
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { findBrowser } from './browser.mjs';
import { findFreePort } from './ports.mjs';
import { startProcessLoadSampler } from './process-load.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLL_MS = 3000;
/** Whole-machine CPU load is sampled this often, as evidence for frame spikes caused by other processes. */
const LOAD_SAMPLE_MS = 2000;
/** Chrome's own close can hang for minutes on a loaded machine; after this the runner kills it. */
const CLOSE_TIMEOUT_MS = 30000;
const EXPECTED_BACKEND = Object.freeze({ webgpu: 'WebGPU', webgl: 'WebGL2' });
/** The terrain test's default world (every fixture stamp type lies within 13 km of its spawn) and time of day. */
const TERRAIN_SEED = 'P2-TERRAIN';
/**
 * The default world of --presets real: every stamp type the game's own site presets use (the volcano's
 * cone included, a rare site) lies within the terrain test's 40 km search radius of its spawn.
 */
const REAL_TERRAIN_SEED = 'TERRAIN-REAL-8';
const TERRAIN_DAY_TIME = '0.42';
/** The determinism test's default world. */
const DETERMINISM_SEED = 'DETERMINISM-1';
/** The spawns test's default world: a real site of every stamped preset near its spawn, and open water. */
const SPAWNS_SEED = REAL_TERRAIN_SEED;
/** The spawns test asks for screenshots: the runner polls this often while it runs. */
const SHOT_POLL_MS = 400;
/** The collision test's default world. */
const COLLISION_SEED = 'COLLIDERS-LAB';
const TESTS = Object.freeze(['1', 'soak', 'hotas', 'terrain', 'determinism', 'spawns', 'collision']);
/** The soak's default worlds (src/dev/testHarness.js SOAK_SEEDS). */
const SOAK_SEED_COUNT = 5;

function parseArgs(argv) {
  const options = {
    test: '1',
    backend: 'webgpu',
    seeds: null,
    seconds: null,
    crafts: null,
    views: null,
    out: null,
    timeoutMinutes: null,
    width: 1280,
    height: 720,
    headful: false,
    browser: null,
    allocProfileSeconds: null,
    presets: null,
    leakCycles: null,
    parts: null,
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
      case '--views': options.views = next(); break;
      case '--presets': options.presets = next(); break;
      case '--leak-cycles': options.leakCycles = Number(next()); break;
      case '--parts': options.parts = next(); break;
      case '--out': options.out = next(); break;
      case '--timeout-minutes': options.timeoutMinutes = Number(next()); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      case '--alloc-profile': options.allocProfileSeconds = Number(next()); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!TESTS.includes(options.test)) throw new Error(`--test must be one of ${TESTS.join(', ')}`);
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

/** Main-thread counters from Chrome (seconds): task wall time, thread CPU time, script time. */
async function readMainThread(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? null;
  return { taskSeconds: value('TaskDuration'), threadSeconds: value('ThreadTime'), scriptSeconds: value('ScriptDuration') };
}

/**
 * Samples the whole machine's CPU load (all processes, all cores) and, once attach(cdp) is called,
 * the page's main-thread counters, until stop() is called.
 */
function startLoadSampler() {
  const samples = [];
  let previous = cpuTimes();
  let cdp = null;
  let previousThread = null;
  const timer = setInterval(() => {
    const current = cpuTimes();
    const total = current.total - previous.total;
    const sample = { time: Date.now(), busyPct: total > 0 ? Math.round(((current.busy - previous.busy) / total) * 1000) / 10 : null };
    samples.push(sample);
    previous = current;
    if (!cdp) return;
    readMainThread(cdp).then((thread) => {
      // The counters restart with every page load (the harness reloads per seed): skip that interval.
      if (previousThread && thread.taskSeconds >= previousThread.taskSeconds && thread.threadSeconds >= previousThread.threadSeconds) {
        sample.taskMs = Math.round((thread.taskSeconds - previousThread.taskSeconds) * 1000);
        sample.threadMs = Math.round((thread.threadSeconds - previousThread.threadSeconds) * 1000);
        sample.scriptMs = Math.round((thread.scriptSeconds - previousThread.scriptSeconds) * 1000);
      }
      previousThread = thread;
    }, (error) => {
      // A page mid-reload has no metrics for a moment; the next sample starts a new baseline.
      sample.threadError = error.message;
      previousThread = null;
    });
  }, LOAD_SAMPLE_MS);
  return {
    samples,
    attach(session) {
      cdp = session;
    },
    stop() {
      clearInterval(timer);
    },
    /** Average and peak machine load (%) between two ISO times, or null without samples there. */
    between(startIso, endIso) {
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      const inside = samples.filter((sample) => sample.time >= start && sample.time <= end + LOAD_SAMPLE_MS);
      const loads = inside.filter((sample) => Number.isFinite(sample.busyPct));
      if (loads.length === 0) return null;
      const average = loads.reduce((sum, sample) => sum + sample.busyPct, 0) / loads.length;
      return { averagePct: Math.round(average * 10) / 10, peakPct: Math.max(...loads.map((sample) => sample.busyPct)), samples: loads.length };
    },
    /** The page main thread between two ISO times: task wall time, the CPU it got, script time. */
    mainThreadBetween(startIso, endIso) {
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      const inside = samples.filter((sample) => sample.time > start && sample.time <= end && Number.isFinite(sample.taskMs));
      if (inside.length === 0) return null;
      const taskMs = inside.reduce((sum, sample) => sum + sample.taskMs, 0);
      const threadMs = inside.reduce((sum, sample) => sum + sample.threadMs, 0);
      const scriptMs = inside.reduce((sum, sample) => sum + sample.scriptMs, 0);
      const wallMs = inside.length * LOAD_SAMPLE_MS;
      return {
        taskBusyPct: Math.round((taskMs / wallMs) * 1000) / 10,
        cpuSharePct: taskMs > 0 ? Math.round((threadMs / taskMs) * 1000) / 10 : null,
        scriptBusyPct: Math.round((scriptMs / wallMs) * 1000) / 10,
        samples: inside.length,
      };
    },
  };
}

/**
 * Samples the GPU's utilisation (%) and used memory (MiB) every LOAD_SAMPLE_MS through a long-running
 * nvidia-smi. Without nvidia-smi (no NVIDIA GPU or driver tools) it stays empty and says why.
 */
function startGpuSampler() {
  const samples = [];
  const sampler = { samples, unavailable: null };
  let pending = '';
  let child = null;
  try {
    child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits', `-lms=${LOAD_SAMPLE_MS}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    sampler.unavailable = `nvidia-smi could not start: ${error.message}`;
  }
  if (child) {
    child.on('error', (error) => {
      sampler.unavailable = `nvidia-smi is not available: ${error.message}`;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        // One line per GPU; the first GPU is the one Chrome renders on in a single-GPU machine.
        const [utilization, memory] = line.split(',').map((field) => Number.parseFloat(field));
        if (Number.isFinite(utilization)) samples.push({ time: Date.now(), gpuPct: utilization, memoryMiB: Number.isFinite(memory) ? memory : null });
      }
    });
  }
  sampler.stop = () => {
    if (child && child.exitCode === null) child.kill();
  };
  /** Average and peak GPU utilisation (%) and peak memory between two ISO times, or null. */
  sampler.between = (startIso, endIso) => {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    const inside = samples.filter((sample) => sample.time >= start && sample.time <= end + LOAD_SAMPLE_MS);
    if (inside.length === 0) return null;
    const average = inside.reduce((sum, sample) => sum + sample.gpuPct, 0) / inside.length;
    const memory = inside.map((sample) => sample.memoryMiB).filter(Number.isFinite);
    return {
      averagePct: Math.round(average * 10) / 10,
      peakPct: Math.max(...inside.map((sample) => sample.gpuPct)),
      peakMemoryMiB: memory.length > 0 ? Math.max(...memory) : null,
      samples: inside.length,
    };
  };
  return sampler;
}

function harnessUrl(port, options) {
  // The harnesses are V2's: they run on V2's own page, not inside the launcher shell.
  const url = new URL(`http://127.0.0.1:${port}/v2/`);
  // The soak is the flight test (?test=1) with its soak plan.
  url.searchParams.set('test', options.test === 'soak' ? '1' : options.test);
  if (options.test === 'soak') url.searchParams.set('testPlan', 'soak');
  if (options.backend === 'webgl') url.searchParams.set('renderer', 'webgl');
  if (options.test === 'terrain') {
    url.searchParams.set('seed', options.seeds ? options.seeds.split(',')[0] : options.presets === 'real' ? REAL_TERRAIN_SEED : TERRAIN_SEED);
    url.searchParams.set('time', TERRAIN_DAY_TIME);
    if (options.presets === 'real') url.searchParams.set('presets', 'real');
  }
  if (options.test === 'determinism') url.searchParams.set('seed', options.seeds ? options.seeds.split(',')[0] : DETERMINISM_SEED);
  if (options.test === 'collision') {
    url.searchParams.set('seed', options.seeds ? options.seeds.split(',')[0] : COLLISION_SEED);
    if (options.parts) url.searchParams.set('testParts', options.parts);
  }
  if (options.test === 'spawns') {
    url.searchParams.set('seed', options.seeds ? options.seeds.split(',')[0] : SPAWNS_SEED);
    url.searchParams.set('testShots', '1');
    if (options.presets) url.searchParams.set('testPresets', options.presets);
    if (Number.isInteger(options.leakCycles) && options.leakCycles > 0) url.searchParams.set('testLeakCycles', String(options.leakCycles));
  }
  if (options.test === '1' || options.test === 'soak') {
    if (options.seeds) url.searchParams.set('testSeeds', options.seeds);
    if (options.seconds) url.searchParams.set('testSeconds', String(options.seconds));
    if (options.crafts) url.searchParams.set('testCraft', options.crafts);
    if (options.views) url.searchParams.set('testViews', options.views);
  }
  return url.href;
}

/** A generous time limit: the planned flying time plus world loads, with a 50 % margin. */
function timeLimitMs(options) {
  if (Number.isFinite(options.timeoutMinutes) && options.timeoutMinutes > 0) return options.timeoutMinutes * 60000;
  if (options.test === 'hotas') return 8 * 60000;
  if (options.test === 'terrain' || options.test === 'determinism' || options.test === 'collision') return 40 * 60000;
  if (options.test === 'spawns') return 90 * 60000;
  const soak = options.test === 'soak';
  const seeds = options.seeds ? options.seeds.split(',').filter(Boolean).length : soak ? SOAK_SEED_COUNT : 3;
  // The soak flies one craft per seed.
  const crafts = soak ? 1 : options.crafts ? options.crafts.split(',').filter(Boolean).length : 6;
  const views = options.views ? options.views.split(',').filter(Boolean).length : 2;
  const seconds = options.seconds ?? 60;
  const plannedSeconds = seeds * crafts * views * (seconds + 3 + 3) + (seeds + 1) * 90;
  return Math.max(10 * 60000, plannedSeconds * 1500);
}

/** Adds up sampled allocation bytes per function (self size) from a sampling heap profile. */
function summarizeAllocations(profile, seconds) {
  const sites = new Map();
  let totalBytes = 0;
  const visit = (node) => {
    const frame = node.callFrame;
    const self = node.selfSize || 0;
    totalBytes += self;
    if (self > 0) {
      const file = String(frame.url || '(native)').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
      const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
      sites.set(key, (sites.get(key) ?? 0) + self);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(profile.head);
  const top = [...sites.entries()].sort((first, second) => second[1] - first[1]).slice(0, 40)
    .map(([site, bytes]) => ({ site, mb: Math.round((bytes / 1048576) * 100) / 100, mbPerSecond: Math.round((bytes / 1048576 / seconds) * 100) / 100, share: Math.round((bytes / Math.max(totalBytes, 1)) * 1000) / 10 }));
  return { seconds, totalMB: Math.round((totalBytes / 1048576) * 10) / 10, mbPerSecond: Math.round((totalBytes / 1048576 / seconds) * 100) / 100, top };
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
    const now = current ? `, flying run ${current.index + 1}: ${current.craft}, ${current.view} person (${current.seed}) ${Math.round(current.seconds ?? 0)} s` : '';
    return `${completedRuns}/${totalRuns} runs done${now}`;
  }
  const { done, phase, step } = state.progress;
  return `${done} checks (${phase})${step ? `, ${step}` : ''}`;
}

/**
 * The load evidence at one moment (ms since the epoch): other processes' and our own CPU and GPU
 * (the per-process sample holding that moment), the whole machine's CPU and the whole GPU.
 */
function loadAtFrame(processLoad, machineLoad, gpuLoad, timeMs) {
  const sample = processLoad.at(timeMs);
  const nearest = (samples) => samples.reduce((best, entry) => (!best || Math.abs(entry.time - timeMs) < Math.abs(best.time - timeMs) ? entry : best), null);
  const machine = nearest(machineLoad.samples.filter((entry) => Number.isFinite(entry.busyPct)));
  const gpu = nearest(gpuLoad.samples);
  return {
    otherCpuPct: sample ? sample.otherCpuPct : null,
    ownCpuPct: sample ? sample.ownCpuPct : null,
    otherGpuPct: sample ? sample.otherGpuPct : null,
    ownGpuPct: sample ? sample.ownGpuPct : null,
    topOtherCpu: sample ? sample.topOtherCpu.map((entry) => `${entry.name} ${entry.pct}%`).join(', ') : null,
    machineCpuPct: machine && Math.abs(machine.time - timeMs) <= LOAD_SAMPLE_MS * 2 ? machine.busyPct : null,
    gpuPct: gpu && Math.abs(gpu.time - timeMs) <= LOAD_SAMPLE_MS * 2 ? gpu.gpuPct : null,
  };
}

/**
 * The machine's CPU load that is not ours (%): the whole machine minus the harness's own processes.
 * It also covers processes whose counters cannot be read (protected processes, virtual machines),
 * which the named other-process figure leaves out.
 */
function notOurs(machinePct, ownPct) {
  if (!Number.isFinite(machinePct) || !Number.isFinite(ownPct)) return null;
  return Math.round(Math.max(0, machinePct - ownPct) * 10) / 10;
}

/** Every slow frame with its attribution and the load evidence at that moment, then the averages. */
function slowFrameEvidence(report) {
  const lines = ['  frames over the limit, with the load at that moment (other = the named processes other than the harness\'s Chrome and node; notOurs = the whole machine minus ours):',
    '    run  craft       view   at s     ms  cause       scripts/blocking ms  otherCPU%  notOurs%  ownCPU%  otherGPU%  ownGPU%  machineCPU%  GPU%  busiest other processes'];
  const cell = (value, width) => String(value ?? 'n/a').padStart(width);
  const spikeOther = [];
  const spikeNotOurs = [];
  for (const run of report.runs) {
    for (const frame of (run.slowFrameList ?? []).slice().sort((first, second) => first.at - second.at)) {
      const load = frame.load ?? {};
      if (Number.isFinite(load.otherCpuPct)) spikeOther.push(load.otherCpuPct);
      const machineNotOurs = notOurs(load.machineCpuPct, load.ownCpuPct);
      if (Number.isFinite(machineNotOurs)) spikeNotOurs.push(machineNotOurs);
      lines.push([
        `    ${String(run.index + 1).padStart(3)}`,
        run.craft.padEnd(11),
        run.view.padEnd(6),
        cell(frame.at, 5),
        cell(frame.ms, 6),
        ` ${frame.cause.padEnd(10)}`,
        cell(frame.loaf ? `${frame.loaf.scriptsMs}/${frame.loaf.blockingMs ?? 'n/a'}` : '-', 19),
        cell(load.otherCpuPct, 10),
        cell(machineNotOurs, 9),
        cell(load.ownCpuPct, 8),
        cell(load.otherGpuPct, 10),
        cell(load.ownGpuPct, 8),
        cell(load.machineCpuPct, 12),
        cell(load.gpuPct, 5),
        ` ${load.topOtherCpu ?? 'n/a'}`,
      ].join(' '));
    }
  }
  if (lines.length === 2) return '  frames over the limit: none';
  const runOther = report.runs.map((run) => run.processLoad?.otherCpuAvgPct).filter(Number.isFinite);
  const mean = (values) => (values.length > 0 ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 'n/a');
  const runNotOurs = report.runs.map((run) => notOurs(run.machineLoad?.averagePct, run.processLoad?.ownCpuAvgPct)).filter(Number.isFinite);
  lines.push(`    other processes' CPU: ${mean(spikeOther)} % on average at these frames, ${mean(runOther)} % on average over the runs`);
  lines.push(`    machine CPU not ours: ${mean(spikeNotOurs)} % on average at these frames, ${mean(runNotOurs)} % on average over the runs`);
  return lines.join('\n');
}

function flightTable(report) {
  const lines = ['  #  seed        craft       view   fps  p99ms  maxms  >50  sys/gc/main/delay  NaN  pen  crash  err/warn  heapMB  script  result  machineCPU%avg/peak  GPU%avg/peak  mainThread busy%/cpuShare%  otherCPU%avg/peak  otherGPU%avg/peak'];
  for (const run of report.runs) {
    const checks = run.script.checks;
    lines.push([
      String(run.index + 1).padStart(3),
      run.seed.padEnd(11),
      run.craft.padEnd(11),
      `${run.view}${run.viewMismatchFrames > 0 ? '!' : ''}`.padEnd(6),
      String(run.avgFps).padStart(5),
      String(run.p99Ms).padStart(6),
      String(run.maxMs).padStart(6),
      String(run.slowFrames).padStart(4),
      `${run.slowByCause.systems}/${run.slowByCause.gc}/${run.slowByCause.mainThread}/${run.slowByCause.delayed}`.padStart(18),
      String(run.nanEvents).padStart(4),
      String(run.penetrations).padStart(4),
      String(run.softCrashes).padStart(6),
      `${run.consoleErrors}/${run.consoleWarnings}`.padStart(9),
      String(run.heapDeltaMB).padStart(7),
      `${checks.filter((check) => check.passed).length}/${checks.length}`.padStart(7),
      run.passed ? '  PASS' : '  FAIL',
      run.machineLoad ? `  ${run.machineLoad.averagePct}/${run.machineLoad.peakPct}`.padEnd(21) : '  n/a'.padEnd(21),
      run.gpuLoad ? `${run.gpuLoad.averagePct}/${run.gpuLoad.peakPct}`.padEnd(13) : 'n/a'.padEnd(13),
      (run.mainThread ? `${run.mainThread.taskBusyPct}/${run.mainThread.cpuSharePct}` : 'n/a').padEnd(27),
      run.processLoad ? `${run.processLoad.otherCpuAvgPct}/${run.processLoad.otherCpuPeakPct}`.padEnd(18) : 'n/a'.padEnd(18),
      run.processLoad ? `${run.processLoad.otherGpuAvgPct}/${run.processLoad.otherGpuPeakPct}` : 'n/a',
    ].join(' '));
  }
  const totals = report.totals;
  lines.push(`  totals: ${totals.runs} runs, ${totals.measuredSeconds} s measured, avg ${totals.avgFps} fps, worst p99 ${totals.worstP99Ms} ms, max ${totals.maxFrameMs} ms, >50 ms ${totals.slowFrames} (systems ${totals.slowByCause.systems}, gc ${totals.slowByCause.gc}, main thread ${totals.slowByCause.mainThread}, delayed ${totals.slowByCause.delayed}), NaN ${totals.nanEvents}, penetrations ${totals.penetrations}, soft crashes ${totals.softCrashes}, console ${totals.consoleErrors}/${totals.consoleWarnings}, max heap growth ${totals.maxHeapGrowthMB} MB, script ${totals.scriptChecks}`);
  for (const world of report.worlds) lines.push(`  world ${world.seed} (${world.backend}): load ${world.loadSeconds} s, heap at load ${world.heapAtLoadMB} MB, after the warmup lap ${world.heapBaselineMB} MB, at the end ${world.heapFinalMB} MB (growth ${world.heapGrowthMB} MB after the lap, ${world.heapGrowthFromLoadMB} MB from load)`);
  return lines.join('\n');
}

/** The report's pass criteria, one line each, and (soak) each world's director and spawns. */
function criteriaLines(report) {
  const lines = report.criteria.map((criterion) => `  ${criterion.status === 'pass' ? 'PASS' : criterion.status === 'fail' ? 'FAIL' : '----'}  ${criterion.label}: ${criterion.value}`);
  for (const world of report.worlds) {
    if (!world.spawns || world.spawns.directorTicks === null) continue;
    const log = world.spawns.directorLog.map((entry) => `${entry.presetId}@${entry.time}s(${entry.reason})`).join(', ') || 'none';
    lines.push(`  world ${world.seed}: director ${world.spawns.directorTicks} ticks, ${world.spawns.directorActivations} activations [${log}], spawns started ${world.spawns.activated.site} sites + ${world.spawns.activated.event} events, peak ${world.spawns.peak}`);
  }
  return lines.join('\n');
}

/** One line per craft and view over every seed: runs passed, worst frame, NaN, penetrations. */
function craftViewTable(report) {
  const groups = new Map();
  for (const run of report.runs) {
    const key = `${run.craft} ${run.view}`;
    if (!groups.has(key)) groups.set(key, { craft: run.craft, view: run.view, runs: [] });
    groups.get(key).runs.push(run);
  }
  const lines = ['  per craft and view (all seeds):', '    craft       view   runs  passed  worst p99ms  max ms  >50  NaN  pen  err/warn  camera views'];
  for (const group of groups.values()) {
    const sum = (field) => group.runs.reduce((total, run) => total + (Number.isFinite(run[field]) ? run[field] : 0), 0);
    const cameraViews = [...new Set(group.runs.flatMap((run) => run.cameraViews ?? []))].join(', ');
    lines.push([
      `    ${group.craft.padEnd(11)}`,
      group.view.padEnd(6),
      String(group.runs.length).padStart(4),
      String(group.runs.filter((run) => run.passed).length).padStart(7),
      String(Math.max(...group.runs.map((run) => run.p99Ms ?? 0))).padStart(12),
      String(Math.max(...group.runs.map((run) => run.maxMs ?? 0))).padStart(7),
      String(sum('slowFrames')).padStart(4),
      String(sum('nanEvents')).padStart(4),
      String(sum('penetrations')).padStart(4),
      `${sum('consoleErrors')}/${sum('consoleWarnings')}`.padStart(9),
      ` ${cameraViews}`,
    ].join(' '));
  }
  return lines.join('\n');
}

function terrainTable(report) {
  const lines = ['  stamp       site                              km  offline seams  max gap m  skirt margin m  live seams  LODs     parity                collision m  result'];
  for (const row of report.stamps) {
    lines.push([
      `  ${row.type.padEnd(11)}`,
      row.siteId.padEnd(32),
      String(Math.round(row.distance / 100) / 10).padStart(5),
      `${row.offline.seams - row.offline.violations}/${row.offline.seams}`.padStart(14),
      String(row.offline.maxGap).padStart(10),
      String(row.offline.worstCoverage).padStart(15),
      `${row.live.seams - row.live.seamViolations}/${row.live.seams}`.padStart(11),
      ` ${row.live.lodsSeen.join('')}`.padEnd(8),
      ` ${row.live.parityChunks} chunks ${row.live.parityWorst === 0 ? 'identical' : `diff ${row.live.parityWorst}`}`.padEnd(22),
      String(Math.max(row.live.collisionWorst, row.offline.collisionWorst)).padStart(12),
      row.passed ? '  PASS' : '  FAIL',
    ].join(' '));
  }
  for (const criterion of report.criteria) lines.push(`  ${criterion.status === 'pass' ? 'PASS' : 'FAIL'}  ${criterion.label}: ${criterion.value}`);
  lines.push(`  poses: ${report.poses.map((pose) => `${pose.stamp} +${pose.offset} m ${pose.settled ? `${pose.seconds} s` : 'NOT SETTLED'}`).join('; ')}`);
  lines.push(`  terrain: ${report.environment.terrainMode} (${report.environment.terrainWorkers} workers), ${report.environment.viewRings} view rings; seed ${report.environment.seed}; site-list hash ${report.siteListHash}`);
  for (const problem of report.harnessErrors) lines.push(`  harness problem: ${problem}`);
  return lines.join('\n');
}

/** Flies the terrain test's camera tour and saves one screenshot per stamp type (stamp-<type>.png). */
async function captureStampTour(page, options, started) {
  const count = await page.evaluate(() => window.DRIFTWING.terrainTest.views.length);
  const shots = [];
  for (let index = 0; index < count; index++) {
    const view = await page.evaluate((viewIndex) => window.DRIFTWING.terrainTest.showView(viewIndex), index);
    const file = `stamp-${view.type}.png`;
    await page.screenshot({ path: join(options.out, file) });
    shots.push({ ...view, file });
    log(started, `stamp tour: ${file} (${view.siteId}, ${view.settled ? `settled in ${view.seconds} s` : 'streaming had NOT settled'})`);
  }
  await page.evaluate(() => window.DRIFTWING.terrainTest.showSummary());
  return shots;
}

function determinismTable(report) {
  const lines = ['  run  site-list hash    fresh world       path end          log hash  entries  activations  spawn events     path digest  km'];
  for (const run of report.runs) {
    lines.push([
      `  ${String(run.run).padStart(3)}`,
      run.siteListHash.padEnd(17),
      run.freshSiteListHash.padEnd(17),
      run.pathEndSiteListHash.padEnd(17),
      run.logHash.padEnd(9),
      String(run.logLength).padStart(7),
      String(run.directorActivations).padStart(12),
      `${run.spawnEventsHash} (${run.spawnEventCount})`.padStart(16),
      run.pathHash.padStart(13),
      String(run.distanceKm).padStart(5),
    ].join(' '));
  }
  const longest = Math.max(0, ...report.runs.map((run) => run.log.length));
  for (let index = 0; index < longest; index++) {
    const cell = (entry) => (entry ? `${Math.round((entry.time - report.config.pathStartSeconds) * 10) / 10} s ${entry.presetId} ${entry.candidateId} (${entry.reason})` : '-');
    const first = report.runs[0]?.log[index];
    const second = report.runs[1]?.log[index];
    const same = JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
    lines.push(`  log ${String(index + 1).padStart(2)}: ${cell(first)} | ${cell(second)}${same ? '' : '  DIFFERENT'}`);
  }
  for (const criterion of report.criteria) lines.push(`  ${criterion.status === 'pass' ? 'PASS' : criterion.status === 'fail' ? 'FAIL' : '----'}  ${criterion.label}: ${criterion.value}`);
  for (const problem of report.harnessErrors) lines.push(`  harness problem: ${problem}`);
  return lines.join('\n');
}

/**
 * The spawns test's screenshot handshake: when the page asks for one (window.DRIFTWING.spawnsTest
 * .pendingShot), saves <name>.png and tells the page it was taken. Returns the file name or null.
 */
async function takeRequestedShot(page, options, runner) {
  let pending = null;
  try {
    pending = await page.evaluate(() => (window.DRIFTWING && window.DRIFTWING.spawnsTest ? window.DRIFTWING.spawnsTest.pendingShot : null));
  } catch (error) {
    // The page is between documents for a moment while it loads; the next poll asks again.
    runner.notes.push(`screenshot poll skipped: ${error.message}`);
    return null;
  }
  if (!pending) return null;
  const file = `${pending.name}.png`;
  await page.screenshot({ path: join(options.out, file) });
  runner.shots = runner.shots ?? [];
  runner.shots.push({ file, presetId: pending.presetId });
  await page.evaluate((token) => window.DRIFTWING.spawnsTest.shotTaken(token), pending.token);
  return file;
}

function spawnsTable(report) {
  const lines = ['  #  preset               sun  weather   anchor   engines                              fps   p99ms  maxms  show: geo/world tex wind  leak: geo/world tex wind  heapMB  err/warn  shot  result'];
  const cycleText = (cycle) => (cycle ? `${cycle.geometryDelta}/${cycle.worldFirstDrawn} ${cycle.textureDelta} ${cycle.windLeft.length}${cycle.gpuOk && cycle.windOk && cycle.skyOk && cycle.lightsOk && cycle.leaksOk && cycle.collidersOk && cycle.challengesOk ? '' : '!'}` : '-');
  for (const row of report.presets) {
    lines.push([
      String(row.index).padStart(3),
      row.presetId.padEnd(20),
      String(row.conditions.sun).padStart(4),
      row.conditions.weather.padEnd(9),
      (row.anchor ? row.anchor.kind : '-').padEnd(8),
      (row.parts.join('+') || '-').padEnd(36),
      String(row.frames.avgFps ?? '-').padStart(5),
      String(row.frames.p99Ms ?? '-').padStart(6),
      String(row.frames.maxMs ?? '-').padStart(6),
      cycleText(row.cycles[0]).padStart(22),
      cycleText(row.cycles[1]).padStart(22),
      String(row.cycles[1] ? row.cycles[1].heapDeltaMB : '-').padStart(7),
      `${row.console.errors}/${row.console.warnings}`.padStart(9),
      (row.shot && row.shot.taken ? 'yes' : 'no').padStart(5),
      row.passed ? '  PASS' : '  FAIL',
    ].join(' '));
  }
  for (const criterion of report.criteria) lines.push(`  ${criterion.status === 'pass' ? 'PASS' : criterion.status === 'fail' ? 'FAIL' : '----'}  ${criterion.label}: ${criterion.value}`);
  for (const row of report.presets) for (const note of row.notes) lines.push(`  note: ${row.presetId}: ${note}`);
  for (const row of report.presets) {
    const leak = row.cycles[1];
    if (leak && leak.warmupRetainedMB > 0.5) lines.push(`  note: ${row.presetId}: the held warm-up kept ${leak.warmupRetainedMB} MB once; the judged cycles read ${leak.heapTraceMB.join(', ')} MB`);
  }
  for (const problem of report.harnessErrors) lines.push(`  harness problem: ${problem}`);
  return lines.join('\n');
}

function collisionTable(report) {
  const lines = ['  target                        craft                  m/s            runs  strikes  through  inside  max impact'];
  for (const row of report.types) {
    lines.push([
      `  ${row.kind.padEnd(30)}`,
      row.crafts.padEnd(22),
      row.speeds.padEnd(14),
      String(row.runs).padStart(4),
      String(row.crashes).padStart(8),
      String(row.through).padStart(8),
      String(row.penetrations).padStart(7),
      String(row.impact).padStart(11),
    ].join(' '));
  }
  for (const criterion of report.criteria) lines.push(`  ${criterion.status === 'pass' ? 'PASS' : criterion.status === 'fail' ? 'FAIL' : '----'}  ${criterion.label}: ${criterion.value}`);
  for (const note of report.special?.notes ?? []) lines.push(`  note: ${note}`);
  for (const problem of report.harnessErrors) lines.push(`  harness problem: ${problem}`);
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
    notes: [],
  };
  const consoleLines = [];
  const started = Date.now();
  const load = startLoadSampler();
  const gpuLoad = startGpuSampler();
  // Every Chrome process the harness launches carries its profile directory on the command line.
  const processLoad = startProcessLoadSampler({ markers: [basename(profileDir)], ownPids: [process.pid] });
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
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    load.attach(cdp);
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
    const allocation = { phase: options.allocProfileSeconds > 0 ? 'waiting' : 'off', startedMs: 0 };
    let lastProgressRead = 0;
    while (Date.now() < deadline) {
      if (options.test === 'spawns') {
        // The spawns test asks for a screenshot per preset and waits: answer quickly.
        await sleep(SHOT_POLL_MS);
        const shot = await takeRequestedShot(page, options, runner);
        if (shot) log(started, `screenshot ${shot}`);
        if (Date.now() - lastProgressRead < POLL_MS) continue;
        lastProgressRead = Date.now();
      } else {
        await sleep(POLL_MS);
      }
      state = await readProgress(page);
      if (allocation.phase === 'waiting' && state?.progress?.current) {
        await cdp.send('HeapProfiler.enable');
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        allocation.phase = 'sampling';
        allocation.startedMs = Date.now();
        log(started, `allocation profile: sampling for ${options.allocProfileSeconds} s`);
      } else if (allocation.phase === 'sampling' && Date.now() - allocation.startedMs >= options.allocProfileSeconds * 1000) {
        const { profile } = await cdp.send('HeapProfiler.stopSampling');
        allocation.phase = 'done';
        const summary = summarizeAllocations(profile, (Date.now() - allocation.startedMs) / 1000);
        writeFileSync(join(options.out, 'alloc-profile.json'), JSON.stringify(summary, null, 2));
        log(started, `allocation profile: ${summary.totalMB} MB in ${Math.round(summary.seconds)} s (${summary.mbPerSecond} MB/s); heaviest sites:`);
        for (const entry of summary.top.slice(0, 25)) process.stdout.write(`    ${String(entry.mbPerSecond).padStart(7)} MB/s ${String(entry.share).padStart(5)} %  ${entry.site}\n`);
      }
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
    await page.setViewport({ width: options.width, height: Math.max(options.height, options.test === '1' || options.test === 'soak' ? 1640 : 1400) });
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
    if (options.test === 'terrain') {
      await page.setViewport({ width: options.width, height: options.height });
      runner.stampShots = await captureStampTour(page, options, started);
      if (runner.stampShots.some((shot) => !shot.settled)) runner.notes.push('the stamp tour took some screenshots before streaming had settled');
    }
  } catch (error) {
    runner.problems.push(error.message);
  } finally {
    if (browser) log(started, `browser ${await closeBrowser(browser, runner.problems)}`);
    await server.close().catch((error) => runner.problems.push(`dev server close failed: ${error.message}`));
    log(started, 'dev server stopped');
    // A killed Chrome can hold its profile files for a moment; leftovers are housekeeping, not a result.
    await sleep(2000);
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      runner.notes.push(`could not remove the temporary profile ${profileDir}: ${error.message}`);
    }
  }

  load.stop();
  gpuLoad.stop();
  processLoad.stop();
  runner.finishedAt = new Date().toISOString();
  runner.machineLoad = load.between(runner.startedAt, runner.finishedAt);
  runner.gpuLoad = gpuLoad.between(runner.startedAt, runner.finishedAt);
  if (gpuLoad.unavailable) runner.notes.push(`GPU load not recorded: ${gpuLoad.unavailable}`);
  if (processLoad.unavailable) runner.notes.push(`per-process load not recorded: ${processLoad.unavailable}`);
  for (const problem of processLoad.errors) runner.notes.push(`per-process load sampler: ${problem}`);
  runner.processLoad = processLoad.between(Date.parse(runner.startedAt), Date.parse(runner.finishedAt));
  if (report && Array.isArray(report.runs)) {
    // Evidence for the frame statistics: how busy the whole machine was while each run flew.
    for (const run of report.runs) {
      run.machineLoad = run.startedAt ? load.between(run.startedAt, run.endedAt) : null;
      run.gpuLoad = run.startedAt ? gpuLoad.between(run.startedAt, run.endedAt) : null;
      run.mainThread = run.startedAt ? load.mainThreadBetween(run.startedAt, run.endedAt) : null;
      run.processLoad = run.startedAt ? processLoad.between(Date.parse(run.startedAt), Date.parse(run.endedAt)) : null;
      // Slow frames are timed from the end of the run's warmup.
      const measureStart = Date.parse(run.startedAt) + (report.config?.runWarmupSeconds ?? 0) * 1000;
      for (const frame of run.slowFrameList ?? []) frame.load = loadAtFrame(processLoad, load, gpuLoad, measureStart + frame.at * 1000);
    }
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
  writeFileSync(join(options.out, 'gpu-load.json'), JSON.stringify(gpuLoad.samples, null, 2));
  writeFileSync(join(options.out, 'process-load.json'), JSON.stringify(processLoad.samples, null, 2));

  const flightTables = () => `${flightTable(report)}\n${craftViewTable(report)}\n${criteriaLines(report)}\n${slowFrameEvidence(report)}`;
  const tables = { 1: flightTables, soak: flightTables, hotas: () => hotasTable(report), terrain: () => terrainTable(report), determinism: () => determinismTable(report), spawns: () => spawnsTable(report), collision: () => collisionTable(report) };
  if (report) process.stdout.write(`${tables[options.test]()}\n`);
  process.stdout.write(`run-harness: ${runner.passed ? 'PASS' : 'FAIL'} (harness ${report ? report.result : 'no report'}, backend ${runner.backend ? runner.backend.join(', ') : 'unknown'}, browser console ${runner.errors.length} errors / ${runner.warnings.length} warnings, ${runner.durationSeconds} s)\n`);
  for (const problem of runner.problems) process.stdout.write(`run-harness: problem: ${problem}\n`);
  for (const note of runner.notes) process.stdout.write(`run-harness: note: ${note}\n`);
  for (const error of runner.errors.slice(0, 20)) process.stdout.write(`run-harness: browser error: ${error}\n`);
  for (const warning of runner.warnings.slice(0, 20)) process.stdout.write(`run-harness: browser warning: ${warning}\n`);
  process.stdout.write(`run-harness: saved report.json, runner.json, console.log and summary screenshots in ${options.out}\n`);
  process.exit(report ? (runner.passed ? 0 : 1) : 2);
}

main().catch((error) => {
  process.stderr.write(`run-harness failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
