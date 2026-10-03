// Spawn audio lab: checks the Phase 2 spawn voices (src/audio/spawnVoices.js, src/audio/recipes/)
// in node and in V2 itself.
//
// Node (pure functions):
//   distanceLaw      distanceGain() is the Web Audio PannerNode formula for every model; the tornado
//                    carries for kilometres while the crystal and the geyser fade within ~1-2 km
//   frontArrival     the thunder front solver, stepped at the audio update rate against listeners
//                    flying toward and away from a strike at up to 250 m/s: the strike lands when the
//                    front radius (343 m/s x elapsed) equals the listener's distance
//   doppler          dopplerFactor() (shared with the craft spatializer) against the textbook formula
//   updateAllocations  the real voice manager and every recipe on a minimal Web Audio stand-in:
//                    after a warm-up, 50 000 updates of 13 moving voices with changing intensities
//                    and a moving listener under the sampling heap profiler create no objects: only
//                    V8's boxed doubles (reported per update) and sporadic runtime samples, far
//                    fewer than one per thousand updates
//
// Browser (the Vite dev server on a free port, V2 at /v2/ on WebGPU and on forced WebGL2): after an
// activation key press starts the AudioContext, every check runs through window.DRIFTWING and the
// audio debug hook (audio.debug.spawn):
//   recipes          every recipe rendered offline (OfflineAudioContext, the live voice graph) with
//                    its triggers: sounding, finite, not clipping, and each distinct from the others
//                    (spectral centroid and band levels)
//   distanceRender   offline renders at growing distances: the measured level drops by the distance
//                    model's gain (inverse and exponential), and the air absorption darkens the sound
//   crystalPitch     the crystal hum's fundamental rises with setIntensity (live readout and the
//                    dominant frequency of offline renders)
//   lifecycle        every recipe auditioned live at once: voices realized, nodes built, every trigger
//                    fires, sound reaches the output; after stopAll every node is released
//   distanceGains    live voices at 100 m to 15 km: gains match the model, the panner sits at the
//                    voice, nearby-only recipes are not realized far away while a tornado still is
//   budget           with a budget of 3, the quietest voices are culled and come back when they get
//                    louder than a realized one
//   thunder          strikes ahead, behind and abeam: delay against distance / 343, and the front
//                    radius against the listener's measured distance at arrival (the moving listener)
//   doppler          a static voice ahead: its doppler equals dopplerFactor() of the listener's
//                    velocity, and camera cuts (view changes) never swoop it
//   allocations      the sampling heap profiler over 6 s with ten voices sounding, after a warm-up:
//                    what the spawn voice update paths allocate in the browser, split into V8's
//                    boxed doubles (floating-point maths in code V8 has not optimized yet) and other
//                    small allocations. Reported, not asserted: updateAllocations is the proof
//   console          no console errors or warnings
//
// Usage: node tools/lab/audio.mjs [--backend both|webgpu|webgl] [--out <dir>] [--headful]
//   [--browser <path>] [--verbose] [--node-only] [--only recipes,thunder,...]
// --only runs the named browser tests alone (boot and console are always checked).
// --js-flags passes V8 flags to Chrome (diagnostics, e.g. "--trace-deopt"); Chrome's output is then
// saved to <out>/chrome-<backend>.log.
// Prints one line per check and a summary with the measured numbers (also saved to
// <out>/audio-lab.json) and exits non-zero if any check fails.
import puppeteer from 'puppeteer-core';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { findBrowser } from '../browser.mjs';
import { findFreePort } from '../ports.mjs';
import { SPEED_OF_SOUND, dopplerFactor } from '../../src/audio/spatial.js';
import { RECIPES, RECIPE_NAMES } from '../../src/audio/recipes/index.js';
import { createSpawnVoices, distanceGain, frontArrival, resolveSpatial } from '../../src/audio/spawnVoices.js';
import * as THREE from 'three/webgpu';
import { Session } from 'node:inspector';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSER_CLOSE_TIMEOUT_MS = 60000;
const HEAP_NUMBER_SAMPLE_BYTES = 135;
const ALLOCATION_WARMUP_MS = 15000;
const NODE_SAMPLING_INTERVAL = 64;

function parseArgs(argv) {
  const options = { backend: 'both', out: join(tmpdir(), 'driftwing-audio-lab'), headful: false, browser: null, verbose: false, nodeOnly: false, only: null, jsFlags: null };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--backend': options.backend = next(); break;
      case '--out': options.out = next(); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      case '--verbose': options.verbose = true; break;
      case '--node-only': options.nodeOnly = true; break;
      case '--only': options.only = new Set(next().split(',')); break;
      case '--js-flags': options.jsFlags = next(); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!['both', 'webgpu', 'webgl'].includes(options.backend)) throw new Error(`--backend must be both, webgpu or webgl (got ${options.backend})`);
  return options;
}

const options = parseArgs(process.argv);
const results = [];
const numbers = {};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);

function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  if (options.verbose) process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}${detail ? `: ${detail}` : ''}\n`);
}

// ============================================================================================
// NODE: PURE FUNCTIONS
// ============================================================================================
function webAudioGain(model, reference, rolloff, maximum, distance) {
  const clamped = Math.max(distance, reference);
  if (model === 'exponential') return (clamped / reference) ** -rolloff;
  if (model === 'linear') return 1 - (Math.min(rolloff, 1) * (Math.min(clamped, maximum) - reference)) / (maximum - reference);
  return reference / (reference + rolloff * (clamped - reference));
}

function testDistanceLaw() {
  for (const model of ['inverse', 'exponential', 'linear']) {
    const spatial = { distanceModel: model, refDistance: 120, rolloffFactor: model === 'linear' ? 0.8 : 1.3, maxDistance: 20000 };
    let worst = 0;
    for (const distance of [0, 50, 120, 121, 500, 2000, 9000, 20000, 40000]) {
      worst = Math.max(worst, Math.abs(distanceGain(spatial, distance) - webAudioGain(model, 120, spatial.rolloffFactor, 20000, distance)));
    }
    check('distanceLaw', `${model} matches the PannerNode formula`, worst < 1e-12, `max error ${worst}`);
  }
  const reach = {};
  for (const name of RECIPE_NAMES) {
    const recipe = RECIPES[name];
    const spatial = resolveSpatial(recipe.spatial, {});
    // The farthest distance (m) at which the recipe at full intensity stays above the audibility floor.
    let distance = spatial.refDistance;
    while (distance < 60000 && recipe.level * distanceGain(spatial, distance) >= 0.0004) distance *= 1.05;
    reach[name] = Math.round(distance);
  }
  numbers.audibleReachMetres = reach;
  check('distanceLaw', 'the tornado carries for kilometres', reach.tornado > 8000, `${reach.tornado} m`);
  check('distanceLaw', 'the volcano carries furthest of the sites', reach.volcano > 15000, `${reach.volcano} m`);
  check('distanceLaw', 'the crystal is heard only nearby', reach.crystal < 2000, `${reach.crystal} m`);
  check('distanceLaw', 'the geyser is heard only nearby', reach.geyser < 2500, `${reach.geyser} m`);
  check('distanceLaw', 'the murmuration is heard only nearby', reach.murmuration < 2500, `${reach.murmuration} m`);
  const overridden = resolveSpatial(RECIPES.tornado.spatial, { refDistance: 500, size: 50, reverb: 2 });
  check('distanceLaw', 'preset audio.params override the tuning (clamped)', overridden.refDistance === 500 && overridden.size === 50 && overridden.reverb === 1);
}

function testFrontArrival() {
  const cases = [
    { name: 'static listener, 2 km', distance: 2000, speed: 0 },
    { name: 'flying toward at 250 m/s, 3 km', distance: 3000, speed: 250 },
    { name: 'flying away at 200 m/s, 3 km', distance: 3000, speed: -200 },
    { name: 'flying toward at 60 m/s, 686 m', distance: 686, speed: 60 },
  ];
  const interval = 0.05;
  const rows = [];
  for (const testCase of cases) {
    // Listener on the x axis flying along it; the strike at the origin at t = 0.
    let time = 0.013;
    let arrival = null;
    for (let tick = 0; tick < 4000 && arrival === null; tick++) {
      const listenerX = testCase.distance - testCase.speed * time;
      const wait = frontArrival(time, Math.abs(listenerX), testCase.speed * Math.sign(listenerX));
      if (wait <= interval * 1.5) arrival = time + wait;
      time += interval;
    }
    const listenerAtArrival = Math.abs(testCase.distance - testCase.speed * arrival);
    const error = Math.abs(SPEED_OF_SOUND * arrival - listenerAtArrival);
    const exact = testCase.distance / (SPEED_OF_SOUND + testCase.speed);
    rows.push({ case: testCase.name, arrival: round(arrival, 4), exact: round(exact, 4), staticDelay: round(testCase.distance / SPEED_OF_SOUND, 4), errorMetres: round(error, 6) });
    check('frontArrival', testCase.name, error < 0.01 && Math.abs(arrival - exact) < 1e-4, `arrival ${round(arrival, 3)} s (exact ${round(exact, 3)} s, static ${round(testCase.distance / SPEED_OF_SOUND, 3)} s)`);
  }
  numbers.frontArrival = rows;
}

function testDopplerFormula() {
  const origin = { x: 0, y: 0, z: 0 };
  const still = { x: 0, y: 0, z: 0 };
  const source = { x: 0, y: 0, z: -1000 };
  const toward = dopplerFactor(origin, { x: 0, y: 0, z: -100 }, source, still);
  check('doppler', 'listener toward a still source: (c + v) / c', Math.abs(toward - (SPEED_OF_SOUND + 100) / SPEED_OF_SOUND) < 1e-12, round(toward, 5));
  const approaching = dopplerFactor(origin, still, source, { x: 0, y: 0, z: 80 });
  check('doppler', 'source approaching a still listener: c / (c - v)', Math.abs(approaching - SPEED_OF_SOUND / (SPEED_OF_SOUND - 80)) < 1e-12, round(approaching, 5));
  const clamped = dopplerFactor(origin, { x: 0, y: 0, z: 2000 }, source, still);
  check('doppler', 'clamped to the Phase 1 range', clamped === 0.5, round(clamped, 5));
  check('doppler', 'unity closer than 0.5 m', dopplerFactor(origin, { x: 0, y: 0, z: -100 }, { x: 0.1, y: 0, z: 0 }, still) === 1);
}

/**
 * A minimal Web Audio stand-in for node: every node, parameter and context method the voices use,
 * none of which allocates when called (automation methods return the parameter itself).
 */
function installFakeWebAudio() {
  class FakeParam {
    constructor(value) { this.value = value; }
    setTargetAtTime() { return this; }
    setValueAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
  }
  class FakeNode {
    constructor(context) {
      this.context = context;
      this.onended = null;
    }
    connect() {}
    disconnect() {}
  }
  class FakeSource extends FakeNode {
    start() {}
    stop() {}
  }
  const param = (options, key, fallback) => new FakeParam(options && Number.isFinite(options[key]) ? options[key] : fallback);
  globalThis.GainNode = class extends FakeNode {
    constructor(context, options) {
      super(context);
      this.gain = param(options, 'gain', 1);
    }
  };
  globalThis.BiquadFilterNode = class extends FakeNode {
    constructor(context, options) {
      super(context);
      this.type = options?.type ?? 'lowpass';
      this.frequency = param(options, 'frequency', 350);
      this.Q = param(options, 'Q', 1);
      this.gain = param(options, 'gain', 0);
      this.detune = param(options, 'detune', 0);
    }
  };
  globalThis.OscillatorNode = class extends FakeSource {
    constructor(context, options) {
      super(context);
      this.type = options?.type ?? 'sine';
      this.frequency = param(options, 'frequency', 440);
      this.detune = param(options, 'detune', 0);
    }
    setPeriodicWave() {}
  };
  globalThis.AudioBufferSourceNode = class extends FakeSource {
    constructor(context, options) {
      super(context);
      this.buffer = null;
      this.loop = false;
      this.playbackRate = param(options, 'playbackRate', 1);
      this.detune = param(options, 'detune', 0);
    }
  };
  globalThis.ConstantSourceNode = class extends FakeSource {
    constructor(context, options) {
      super(context);
      this.offset = param(options, 'offset', 1);
    }
  };
  globalThis.PannerNode = class extends FakeNode {
    constructor(context, options) {
      super(context);
      this.positionX = param(options, 'positionX', 0);
      this.positionY = param(options, 'positionY', 0);
      this.positionZ = param(options, 'positionZ', 0);
    }
  };
  globalThis.WaveShaperNode = class extends FakeNode {
    constructor(context) {
      super(context);
      this.curve = null;
    }
  };
  const context = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => new GainNode(context),
    createBiquadFilter: () => new BiquadFilterNode(context),
    createOscillator: () => new OscillatorNode(context),
    createBufferSource: () => new AudioBufferSourceNode(context),
    createWaveShaper: () => new WaveShaperNode(context),
    createPeriodicWave: () => ({}),
  };
  return context;
}

/**
 * Samples every allocation (collected objects included) made while run() executes, in src/audio/.
 * Nearly all of them are V8 boxing a double that crosses a call it did not inline (an argument to
 * an AudioParam method, a function's return value, e.g. randomBetween's): they are the modal sample
 * size. Every other sample is counted as a possible object, by site and size.
 */
async function sampleAllocations(run) {
  const session = new Session();
  session.connect();
  const post = (method, params) => new Promise((resolvePost, rejectPost) => {
    session.post(method, params, (error, result) => (error ? rejectPost(error) : resolvePost(result)));
  });
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: NODE_SAMPLING_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  run();
  const { profile } = await post('HeapProfiler.stopSampling');
  await post('HeapProfiler.disable');
  session.disconnect();
  const nodes = new Map();
  const index = (node) => {
    nodes.set(node.id, node);
    for (const child of node.children) index(child);
  };
  index(profile.head);
  const ours = profile.samples.filter((sample) => nodes.get(sample.nodeId)?.callFrame.url.includes('/src/audio/'));
  const sizeCounts = new Map();
  for (const sample of ours) sizeCounts.set(sample.size, (sizeCounts.get(sample.size) ?? 0) + 1);
  const boxSize = [...sizeCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const objectSites = new Map();
  let boxBytes = 0;
  let otherSamples = 0;
  for (const sample of ours) {
    if (sample.size === boxSize) {
      boxBytes += sample.size;
      continue;
    }
    otherSamples++;
    const node = nodes.get(sample.nodeId);
    const key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').slice(-2).join('/')}:${node.callFrame.lineNumber + 1}`;
    objectSites.set(key, (objectSites.get(key) ?? 0) + 1);
  }
  return { boxSize, boxBytes, otherSamples, otherSites: Object.fromEntries(objectSites) };
}

async function testUpdateAllocations() {
  const context = installFakeWebAudio();
  const mixer = { input: () => new GainNode(context), send: () => new GainNode(context) };
  const listener = {
    listenerPosition: new THREE.Vector3(0, 400, 0),
    listenerForward: new THREE.Vector3(0, 0, -1),
    listenerUp: new THREE.Vector3(0, 1, 0),
    listenerVelocity: new THREE.Vector3(0, 0, -45),
  };
  const issues = [];
  const spawnVoices = createSpawnVoices({ THREE, onIssue: (error) => issues.push(error.message) });
  spawnVoices.attach({ context, noise: { duration: 4 }, mixer, spatializer: listener });
  spawnVoices.setBudget(16);
  const handles = RECIPE_NAMES.map((name) => spawnVoices.spawnVoice(name, { intensity: 0.6 }));
  const position = new THREE.Vector3();
  const frame = { time: 0, realTime: 0, interval: 0.05, interior: false, profile: { interiorCutoff: 0 } };
  // Voices circle the listener, who flies north at 45 m/s; intensities change every update.
  const step = (tick) => {
    frame.time += 0.05;
    frame.realTime += 0.05;
    context.currentTime = frame.time;
    listener.listenerPosition.z -= 45 * 0.05;
    for (let voice = 0; voice < handles.length; voice++) {
      const angle = voice * 0.48 + tick * 0.001;
      const radius = 150 + voice * 20;
      position.set(Math.sin(angle) * radius, 400, listener.listenerPosition.z - Math.cos(angle) * radius);
      handles[voice].setPosition(position);
      handles[voice].setIntensity(0.5 + 0.4 * Math.sin(tick * 0.01 + voice));
    }
    spawnVoices.update(frame);
  };
  const warmUpdates = 20000;
  const updates = 50000;
  for (let tick = 0; tick < warmUpdates; tick++) step(tick);
  const warm = spawnVoices.describe();
  const sampled = await sampleAllocations(() => {
    for (let tick = warmUpdates; tick < warmUpdates + updates; tick++) step(tick);
  });
  const after = spawnVoices.describe();
  numbers.updateAllocations = {
    updates,
    voices: after.voices,
    realized: after.realized,
    boxSampleBytes: sampled.boxSize,
    boxedDoubleSampleBytesPerUpdate: round(sampled.boxBytes / updates, 1),
    otherSamples: sampled.otherSamples,
    otherSites: sampled.otherSites,
  };
  check('updateAllocations', 'every recipe realized on the stand-in', after.realized === RECIPE_NAMES.length && issues.length === 0,
    `${after.realized}/${after.voices}${issues.length ? `; ${issues.join(' | ')}` : ''}`);
  // An object created per update (or even per hundred updates) would leave thousands of samples.
  check('updateAllocations', `${updates} updates of ${after.voices} moving voices create no objects`,
    sampled.otherSamples < updates / 1000 && after.realizations === warm.realizations,
    `${sampled.otherSamples} sporadic non-box samples ${JSON.stringify(sampled.otherSites)} (limit ${updates / 1000});`
    + ` V8 boxed doubles ${numbers.updateAllocations.boxedDoubleSampleBytesPerUpdate} sampled B per update; realizations during the run ${after.realizations - warm.realizations}`);
  for (const handle of handles) handle.dispose();
}

// ============================================================================================
// BROWSER
// ============================================================================================
/** Page-side helpers, installed once per page. */
function installPageHelpers() {
  window.audioLab = {
    audio: () => window.DRIFTWING.ctx.systems.audio,
    spawn: () => window.DRIFTWING.ctx.systems.audio.debug.spawn,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
  return true;
}

const RENDER_PLAN = Object.freeze({
  tornado: { intensity: 1, seconds: 4 },
  thunder: { intensity: 0.6, seconds: 7, distance: 900, skip: 0.4, triggers: [{ at: 0.5, name: 'strike', options: { intensity: 1 } }] },
  volcano: { intensity: 0.8, seconds: 6, triggers: [{ at: 1.2, name: 'boom', options: { strength: 1 } }] },
  geyser: { intensity: 0.5, seconds: 10, triggers: [{ at: 2, name: 'burst', options: { duration: 1.5 } }] },
  waterfall: { intensity: 1, seconds: 4 },
  whale: { intensity: 1, seconds: 10, skip: 0.3, triggers: [{ at: 0, name: 'call' }] },
  skyWhale: { intensity: 1, seconds: 14, skip: 0.3, triggers: [{ at: 0, name: 'call' }] },
  crystal: { intensity: 0.5, seconds: 5, triggers: [{ at: 1.5, name: 'chime', options: { notes: 3 } }] },
  turbine: { intensity: 0.7, seconds: 6 },
  murmuration: { intensity: 1, seconds: 5, triggers: [{ at: 2, name: 'scatter' }] },
  meteor: { intensity: 0.6, seconds: 6, triggers: [{ at: 1.2, name: 'streak' }, { at: 3, name: 'fireball' }] },
  lantern: { intensity: 1, seconds: 5 },
  discovery: { intensity: 1, seconds: 5, skip: 0, triggers: [{ at: 0.2, name: 'chime' }] },
  raptor: { intensity: 1, seconds: 5, skip: 0, triggers: [{ at: 0.3, name: 'call' }, { at: 2.6, name: 'call', options: { strength: 0.8 } }] },
  goose: { intensity: 1, seconds: 6, skip: 0.2, triggers: [{ at: 0.2, name: 'call' }] },
});

async function testRecipes(page, label) {
  const renders = {};
  for (const name of RECIPE_NAMES) {
    const plan = RENDER_PLAN[name];
    renders[name] = await page.evaluate((recipe, planned) => window.audioLab.spawn().render(recipe, planned), name, plan);
  }
  const table = {};
  for (const name of RECIPE_NAMES) {
    const render = renders[name];
    table[name] = {
      rmsDb: render.rmsDb, peakDb: render.peakDb, loudestBlockDb: render.loudestBlockDb, medianBlockDb: render.medianBlockDb,
      centroidHz: render.centroidHz, dominantHz: render.dominantHz, bands: render.bands, nodes: render.nodes,
    };
    check('recipes', `${label} ${name} sounds (RMS above -48 dBFS)`, render.rmsDb > -48, `${render.rmsDb} dBFS`);
    check('recipes', `${label} ${name} is finite and does not clip`, render.nonFinite === 0 && render.peakDb < -0.1, `peak ${render.peakDb} dBFS`);
    check('recipes', `${label} ${name} triggers fired`, render.triggersFired.every(Boolean) && render.issues.length === 0, JSON.stringify(render.triggersFired));
  }
  // Distinctness: spectral features (log centroid and the five band levels), pairwise.
  const features = (render) => [Math.log2(Math.max(render.centroidHz, 1)) * 6, ...Object.values(render.bands)];
  let closest = { distance: Infinity, pair: null };
  for (let first = 0; first < RECIPE_NAMES.length; first++) {
    for (let second = first + 1; second < RECIPE_NAMES.length; second++) {
      const a = features(renders[RECIPE_NAMES[first]]);
      const b = features(renders[RECIPE_NAMES[second]]);
      const distance = Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
      if (distance < closest.distance) closest = { distance: round(distance, 2), pair: `${RECIPE_NAMES[first]} / ${RECIPE_NAMES[second]}` };
    }
  }
  check('recipes', `${label} every recipe is spectrally distinct`, closest.distance > 3, `closest pair ${closest.pair} at ${closest.distance}`);
  // Triggers stand out of the bed.
  const dynamics = (name) => renders[name].loudestBlockDb - renders[name].medianBlockDb;
  for (const name of ['volcano', 'geyser', 'meteor', 'murmuration', 'thunder']) {
    check('recipes', `${label} ${name} trigger stands out`, dynamics(name) > 6, `loudest block ${round(dynamics(name), 1)} dB over the median`);
  }
  return { table, closest };
}

async function testDistanceRender(page, label) {
  const render = (recipe, distance, extra = {}) => page.evaluate((name, planned) => window.audioLab.spawn().render(name, planned), recipe, { seconds: 4, skip: 1, intensity: 1, distance, ...extra });
  const out = {};
  const laws = [
    { recipe: 'waterfall', distances: [400, 800, 1600, 3200, 6400], params: { size: 0, distanceModel: 'inverse' } },
    { recipe: 'waterfall', distances: [150, 300, 600, 1200], params: { size: 0 } },
    { recipe: 'crystal', distances: [60, 120, 240, 480], params: { size: 0 } },
  ];
  for (const { recipe, distances, params } of laws) {
    const rows = [];
    for (const distance of distances) rows.push(await render(recipe, distance, { absorption: false, params }));
    const base = rows[0];
    let worst = 0;
    const table = rows.map((row) => {
      const measured = row.rmsDb - base.rmsDb;
      const expected = row.distanceGainDb - base.distanceGainDb;
      worst = Math.max(worst, Math.abs(measured - expected));
      return { distance: row.distance, measuredDb: round(measured, 2), modelDb: round(expected, 2) };
    });
    out[`${recipe}-${base.spatial.distanceModel}`] = table;
    check('distanceRender', `${label} ${recipe} level follows its ${base.spatial.distanceModel} law`, worst < 1.2, `worst deviation ${round(worst, 2)} dB: ${JSON.stringify(table)}`);
  }
  // Air absorption: band levels are relative to the whole spectrum, so the distance gain cancels.
  const near = await render('tornado', 320);
  const far = await render('tornado', 6000);
  out.tornadoAbsorption = { nearHighMidDb: near.bands.highMid, farHighMidDb: far.bands.highMid, nearHighDb: near.bands.high, farHighDb: far.bands.high, nearCutoffHz: near.cutoffHz, farCutoffHz: far.cutoffHz };
  check('distanceRender', `${label} air absorption strips a far tornado's debris highs`, far.bands.highMid < near.bands.highMid - 10, JSON.stringify(out.tornadoAbsorption));
  const nearFall = await render('waterfall', 150, { params: { size: 0 } });
  const farFall = await render('waterfall', 4000, { params: { size: 0 } });
  out.waterfallAbsorption = { nearCentroidHz: nearFall.centroidHz, farCentroidHz: farFall.centroidHz, nearCutoffHz: nearFall.cutoffHz, farCutoffHz: farFall.cutoffHz };
  check('distanceRender', `${label} air absorption darkens a far waterfall`, farFall.centroidHz < nearFall.centroidHz * 0.6, JSON.stringify(out.waterfallAbsorption));
  return out;
}

async function testCrystalPitch(page, label) {
  const rows = [];
  for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
    const render = await page.evaluate((value) => window.audioLab.spawn().render('crystal', { intensity: value, seconds: 3, skip: 0.8, absorption: false }), intensity);
    const expected = 196 * 2 ** intensity;
    rows.push({ intensity, dominantHz: render.dominantHz, expectedHz: round(expected, 2), readout: round(render.synth.fundamental, 2) });
  }
  const rising = rows.every((row, index) => index === 0 || row.dominantHz > rows[index - 1].dominantHz);
  const accurate = rows.every((row) => Math.abs(row.dominantHz - row.expectedHz) / row.expectedHz < 0.02);
  check('crystalPitch', `${label} offline pitch rises with intensity`, rising, JSON.stringify(rows));
  check('crystalPitch', `${label} offline pitch within 2 % of the design`, accurate);
  const live = await page.evaluate(async () => {
    const spawn = window.audioLab.spawn();
    const id = spawn.play('crystal', { distance: 60, intensity: 0 });
    const readouts = [];
    for (const intensity of [0, 0.5, 1]) {
      spawn.intensity(id, intensity);
      await window.audioLab.sleep(700);
      const voice = spawn.voice(id);
      readouts.push({ intensity, fundamental: voice.synth ? voice.synth.fundamental : null, realized: voice.realized });
    }
    spawn.stop(id);
    return readouts;
  });
  check('crystalPitch', `${label} live hum rises 196 -> 277 -> 392 Hz`, live.every((row) => row.realized) && Math.abs(live[0].fundamental - 196) < 0.5
    && Math.abs(live[1].fundamental - 277.2) < 0.5 && Math.abs(live[2].fundamental - 392) < 0.5, JSON.stringify(live));
  return { offline: rows, live };
}

async function testLifecycle(page, label) {
  const result = await page.evaluate(async (names) => {
    const { spawn, audio, sleep } = window.audioLab;
    const tools = spawn();
    tools.setBudget(16);
    const before = tools.stats();
    const ids = names.map((name, index) => tools.play(name, { distance: name === 'thunder' ? 400 : 150, bearing: (index * 360) / names.length, intensity: 0.8 }));
    await sleep(900);
    const playing = tools.stats();
    const voices = tools.voices();
    const triggers = {
      volcano: tools.trigger(ids[names.indexOf('volcano')], 'boom'),
      geyser: tools.trigger(ids[names.indexOf('geyser')], 'burst', { duration: 2 }),
      crystal: tools.trigger(ids[names.indexOf('crystal')], 'chime'),
      murmuration: tools.trigger(ids[names.indexOf('murmuration')], 'scatter'),
      meteorStreak: tools.trigger(ids[names.indexOf('meteor')], 'streak'),
      meteorFireball: tools.trigger(ids[names.indexOf('meteor')], 'fireball'),
      whale: tools.trigger(ids[names.indexOf('whale')], 'call'),
      skyWhale: tools.trigger(ids[names.indexOf('skyWhale')], 'call'),
      thunder: tools.trigger(ids[names.indexOf('thunder')], 'strike', { intensity: 1 }),
      discovery: tools.trigger(ids[names.indexOf('discovery')], 'chime'),
      raptor: tools.trigger(ids[names.indexOf('raptor')], 'call'),
      goose: tools.trigger(ids[names.indexOf('goose')], 'call'),
      discoveryChime: audio().discoveryChime(),
      unknown: tools.trigger(ids[0], 'no-such-trigger'),
    };
    await sleep(1200);
    const output = audio().getStats();
    const stopped = tools.stopAll();
    await sleep(1500);
    const afterStop = tools.stats();
    let oneShotsWaited = 0;
    // The storm's strike lands anywhere inside it (up to ~3 km away): wait for it to arrive and end.
    while ((tools.stats().oneShotNodesLive > 0 || tools.stats().thunderPending > 0) && oneShotsWaited < 40000) {
      await sleep(500);
      oneShotsWaited += 500;
    }
    const afterOneShots = tools.stats();
    tools.setBudget(10);
    return { before, playing, voices, triggers, outputDb: output.outputDb, environment: output.buses.environment, stopped, afterStop, afterOneShots, oneShotsWaited };
  }, RECIPE_NAMES);
  const nodeSum = result.voices.reduce((sum, voice) => sum + voice.nodes, 0);
  check('lifecycle', `${label} every recipe auditioned and realized`, result.playing.voices === RECIPE_NAMES.length && result.playing.realized === RECIPE_NAMES.length,
    `${result.playing.realized}/${result.playing.voices} realized`);
  check('lifecycle', `${label} nodes built and counted`, result.playing.nodesLive === nodeSum && nodeSum > 100, `${result.playing.nodesLive} live nodes (sum over voices ${nodeSum})`);
  const { unknown, ...fired } = result.triggers;
  check('lifecycle', `${label} every trigger fires; unknown triggers refused`, Object.values(fired).every(Boolean) && unknown === false, JSON.stringify(result.triggers));
  check('lifecycle', `${label} sound reaches the output`, result.outputDb > -60, `${result.outputDb} dBFS`);
  check('lifecycle', `${label} stopAll disposes every voice and releases every voice node`, result.stopped === RECIPE_NAMES.length && result.afterStop.voices === 0 && result.afterStop.nodesLive === 0,
    `voices ${result.afterStop.voices}, nodes ${result.afterStop.nodesLive}`);
  check('lifecycle', `${label} one-shot nodes (thunder, chimes) released when they end`, result.afterOneShots.oneShotNodesLive === 0 && result.afterOneShots.thunderPlayed >= 1,
    `${result.afterOneShots.oneShotNodesLive} left after ${result.oneShotsWaited} ms; thunder played ${result.afterOneShots.thunderPlayed}`);
  return {
    realized: result.playing.realized,
    nodesLive: result.playing.nodesLive,
    nodesPerVoice: Object.fromEntries(result.voices.map((voice) => [voice.recipe, voice.nodes])),
    outputDb: result.outputDb,
    nodesAfterStop: result.afterStop.nodesLive,
    oneShotNodesAfter: result.afterOneShots.oneShotNodesLive,
  };
}

async function testDistanceGains(page, label) {
  const result = await page.evaluate(async () => {
    const { spawn, audio, sleep } = window.audioLab;
    const tools = spawn();
    tools.setBudget(16);
    const distances = [100, 400, 1600, 6400];
    const waterfalls = distances.map((distance) => tools.play('waterfall', { distance, params: { size: 0 } }));
    const crystalFar = tools.play('crystal', { distance: 3000, intensity: 1 });
    const crystalNear = tools.play('crystal', { distance: 300, intensity: 1 });
    const tornadoFar = tools.play('tornado', { distance: 15000, intensity: 1 });
    await sleep(1000);
    const listener = audio().getStats().spatial.listener;
    const rows = waterfalls.map((id, index) => {
      const voice = tools.voice(id);
      const panner = voice.panner;
      const pannerDistance = panner ? Math.hypot(panner.x - listener.x, panner.y - listener.y, panner.z - listener.z) : null;
      return { distance: distances[index], gain: voice.distanceGain, measuredDistance: voice.distance, pannerDistance, realized: voice.realized, cutoff: voice.cutoff };
    });
    const extra = { crystalFar: tools.voice(crystalFar), crystalNear: tools.voice(crystalNear), tornadoFar: tools.voice(tornadoFar) };
    tools.stopAll();
    tools.setBudget(10);
    return { rows, extra };
  });
  let worstGain = 0;
  let worstPanner = 0;
  const waterfallSpatial = resolveSpatial(RECIPES.waterfall.spatial, { size: 0 });
  for (const row of result.rows) {
    worstGain = Math.max(worstGain, Math.abs(row.gain - distanceGain(waterfallSpatial, row.measuredDistance)));
    worstPanner = Math.max(worstPanner, Math.abs(row.pannerDistance - row.distance) / row.distance);
  }
  check('distanceGains', `${label} voice gains follow the waterfall's ${waterfallSpatial.distanceModel} law`, worstGain < 1e-3, JSON.stringify(result.rows.map((row) => ({ d: row.distance, gain: round(row.gain, 5), cutoff: Math.round(row.cutoff) }))));
  check('distanceGains', `${label} panners sit at their voices`, worstPanner < 0.02, `worst ${round(worstPanner * 100, 2)} %`);
  check('distanceGains', `${label} gain falls with distance`, result.rows.every((row, index) => index === 0 || row.gain < result.rows[index - 1].gain));
  check('distanceGains', `${label} a crystal 3 km away stays virtual, 300 m away it sounds`, !result.extra.crystalFar.realized && result.extra.crystalNear.realized,
    `far audibility ${round(result.extra.crystalFar.audibility, 6)}, near ${round(result.extra.crystalNear.audibility, 6)}`);
  check('distanceGains', `${label} a tornado 15 km away still sounds`, result.extra.tornadoFar.realized, `gain ${round(result.extra.tornadoFar.distanceGain, 4)}, cutoff ${Math.round(result.extra.tornadoFar.cutoff)} Hz`);
  return {
    waterfall: result.rows.map((row) => ({ distance: row.distance, gain: round(row.gain, 5), gainDb: round(20 * Math.log10(row.gain), 2), cutoffHz: Math.round(row.cutoff) })),
    crystalAt3km: { realized: result.extra.crystalFar.realized, gain: round(result.extra.crystalFar.distanceGain, 5) },
    tornadoAt15km: { realized: result.extra.tornadoFar.realized, gain: round(result.extra.tornadoFar.distanceGain, 5), cutoffHz: Math.round(result.extra.tornadoFar.cutoff) },
  };
}

async function testBudget(page, label) {
  const result = await page.evaluate(async () => {
    const { spawn, sleep } = window.audioLab;
    const tools = spawn();
    tools.setBudget(3);
    const start = tools.stats();
    const far = [1600, 800, 400].map((distance) => ({ distance, id: tools.play('waterfall', { distance, params: { size: 0 } }) }));
    await sleep(700);
    const phaseOne = far.map(({ distance, id }) => ({ distance, realized: tools.voice(id).realized }));
    const near = [100, 200].map((distance) => ({ distance, id: tools.play('waterfall', { distance, params: { size: 0 } }) }));
    await sleep(700);
    const all = [...far, ...near];
    const phaseTwo = all.map(({ distance, id }) => ({ distance, realized: tools.voice(id).realized }));
    const afterCull = tools.stats();
    tools.place(far[0].id, { distance: 50 });
    await sleep(700);
    const phaseThree = all.map(({ distance, id }) => ({ distance: id === far[0].id ? 50 : distance, realized: tools.voice(id).realized }));
    const end = tools.stats();
    tools.stopAll();
    tools.setBudget(10);
    await sleep(800);
    return { start, phaseOne, phaseTwo, phaseThree, afterCull, end, final: tools.stats() };
  });
  const realizedAt = (phase) => phase.filter((row) => row.realized).map((row) => row.distance).sort((a, b) => a - b);
  check('budget', `${label} three voices under a budget of 3 all sound`, realizedAt(result.phaseOne).length === 3, JSON.stringify(realizedAt(result.phaseOne)));
  check('budget', `${label} two nearer voices cull the two quietest`, JSON.stringify(realizedAt(result.phaseTwo)) === '[100,200,400]'
    && result.afterCull.culled - result.start.culled === 2 && result.afterCull.realized === 3, `realized ${JSON.stringify(realizedAt(result.phaseTwo))}, culled +${result.afterCull.culled - result.start.culled}`);
  check('budget', `${label} a culled voice that comes closer returns and culls the quietest`, JSON.stringify(realizedAt(result.phaseThree)) === '[50,100,200]'
    && result.end.culled - result.start.culled === 3, `realized ${JSON.stringify(realizedAt(result.phaseThree))}, culled +${result.end.culled - result.start.culled}`);
  check('budget', `${label} never more voices realized than the budget; nodes released after`, result.end.realized <= 3 && result.final.nodesLive === 0, `final nodes ${result.final.nodesLive}`);
  return { phaseTwo: realizedAt(result.phaseTwo), phaseThree: realizedAt(result.phaseThree), culled: result.end.culled - result.start.culled };
}

async function testThunder(page, label) {
  const result = await page.evaluate(async () => {
    const { spawn, sleep } = window.audioLab;
    const tools = spawn();
    const before = tools.thunderLog().length;
    const queued = [
      tools.thunder({ distance: 686, bearing: 0, intensity: 1 }),
      tools.thunder({ distance: 1372, bearing: 180, intensity: 0.8 }),
      tools.thunder({ distance: 2058, bearing: 90, intensity: 0.7 }),
      tools.thunder({ distance: 40000, bearing: 0, intensity: 1 }),
    ];
    let waited = 0;
    while (tools.thunderLog().length < before + 3 && waited < 15000) {
      await sleep(250);
      waited += 250;
    }
    await sleep(400);
    return { queued, log: tools.thunderLog().slice(-3), stats: tools.stats() };
  });
  check('thunder', `${label} strikes within 30 km queue, beyond do not`, JSON.stringify(result.queued) === '[true,true,true,false]', JSON.stringify(result.queued));
  const rows = result.log.map((entry) => ({
    distanceAtEmit: round(entry.distanceAtEmit, 1),
    delay: round(entry.delay, 3),
    staticDelay: round(entry.staticDelay, 3),
    closingSpeed: round(entry.closingSpeed, 2),
    frontError: round(entry.frontError, 2),
  }));
  check('thunder', `${label} three strikes arrived`, rows.length === 3 && rows.every((row) => Number.isFinite(row.frontError)), JSON.stringify(rows));
  check('thunder', `${label} delays track distance / 343 m/s`, rows.every((row) => Math.abs(row.delay - row.staticDelay) < 0.08 + (Math.abs(row.closingSpeed) * row.staticDelay) / 300), JSON.stringify(rows.map((row) => [row.delay, row.staticDelay])));
  check('thunder', `${label} the front meets the moving listener (within 10 m)`, rows.every((row) => Math.abs(row.frontError) < 10), JSON.stringify(rows.map((row) => row.frontError)));
  return rows;
}

async function testLiveDoppler(page, label) {
  const steadyResult = await page.evaluate(async () => {
    const { audio, sleep } = window.audioLab;
    const camera = window.DRIFTWING.ctx.camera;
    const forward = camera.getWorldDirection(camera.position.clone());
    const cameraPosition = camera.getWorldPosition(camera.position.clone());
    const voice = audio().spawnVoice('waterfall', { size: 0 });
    voice.setPosition(cameraPosition.addScaledVector(forward, 900));
    window.audioLab.dopplerVoice = voice;
    const read = () => {
      const spatial = audio().getStats().spatial;
      return {
        listener: spatial.listener,
        velocity: spatial.listenerVelocity,
        voice: voice.describe(),
        view: window.DRIFTWING.ctx.systems.camera.getView(),
        cuts: window.DRIFTWING.ctx.systems.camera.getCutCount(),
        time: performance.now(),
      };
    };
    window.audioLab.readDoppler = read;
    await sleep(1500);
    const steady = [];
    for (let sample = 0; sample < 6; sample++) {
      steady.push(read());
      await sleep(120);
    }
    window.audioLab.cutSamples = [];
    window.audioLab.cutSampler = setInterval(() => window.audioLab.cutSamples.push(read()), 50);
    return { steady, cutsBefore: window.DRIFTWING.ctx.systems.camera.getCutCount() };
  });
  // Camera cuts: cycle the views (chase, cockpit, wing, flyby and back) with real key presses.
  for (let press = 0; press < 4; press++) {
    await page.keyboard.press('KeyC');
    await sleep(600);
  }
  const cutResult = await page.evaluate(() => {
    clearInterval(window.audioLab.cutSampler);
    const craftSpeed = window.DRIFTWING.state.flight.velocity.length();
    const cutCount = window.DRIFTWING.ctx.systems.camera.getCutCount();
    window.audioLab.dopplerVoice.dispose();
    return { cuts: window.audioLab.cutSamples, craftSpeed, cutCount };
  });
  const result = { steady: steadyResult.steady, cuts: cutResult.cuts, craftSpeed: cutResult.craftSpeed, cutCount: cutResult.cutCount - steadyResult.cutsBefore };
  // The expected factor from the same listener readout; the voice is still (its derived velocity is 0).
  let worst = 0;
  const still = { x: 0, y: 0, z: 0 };
  for (const sample of result.steady) {
    const expected = dopplerFactor(sample.listener, sample.velocity, sample.voice.position, still);
    worst = Math.max(worst, Math.abs(sample.voice.doppler - expected) / expected);
  }
  const last = result.steady[result.steady.length - 1];
  const cents = 1200 * Math.log2(last.voice.doppler);
  check('doppler', `${label} a still voice's doppler is dopplerFactor() of the listener's velocity`, worst < 0.01 && last.voice.realized,
    `worst ${round(worst * 100, 3)} %, factor ${round(last.voice.doppler, 4)} (${round(cents, 1)} cents), craft ${round(result.craftSpeed, 1)} m/s`);
  check('doppler', `${label} the voice's detune carries the factor`, Math.abs(last.voice.dopplerCents - cents) < 15, `${round(last.voice.dopplerCents, 1)} cents applied`);
  const speeds = result.cuts.map((sample) => Math.hypot(sample.velocity.x, sample.velocity.y, sample.velocity.z));
  const factors = result.cuts.map((sample) => sample.voice.doppler);
  const maxSpeed = Math.max(...speeds);
  const maxShift = Math.max(...factors.map((factor) => Math.abs(1200 * Math.log2(factor))));
  const craftCents = 1200 * Math.log2((SPEED_OF_SOUND + result.craftSpeed) / SPEED_OF_SOUND);
  check('doppler', `${label} camera cuts do not swoop the pitch`, maxSpeed < result.craftSpeed + 25 && maxShift < craftCents + 60,
    `${result.cutCount} cuts; listener speed max ${round(maxSpeed, 1)} m/s (craft ${round(result.craftSpeed, 1)}); shift max ${round(maxShift, 1)} cents (craft-speed bound ${round(craftCents, 1)})`);
  const series = result.cuts.map((sample, index) => ({
    t: Math.round(sample.time - result.cuts[0].time),
    view: sample.view,
    cuts: sample.cuts,
    speed: round(speeds[index], 1),
    cents: round(1200 * Math.log2(factors[index]), 1),
  }));
  return { factor: round(last.voice.doppler, 4), cents: round(cents, 1), craftSpeed: round(result.craftSpeed, 1), cutListenerSpeedMax: round(maxSpeed, 1), cutShiftMaxCents: round(maxShift, 1), series };
}

async function testAllocations(page, label) {
  await page.evaluate(async (names) => {
    const tools = window.audioLab.spawn();
    tools.setBudget(16);
    window.audioLab.allocationIds = names.map((name, index) => tools.play(name, { distance: 200, bearing: index * 30, intensity: 0.7 }));
    await window.audioLab.sleep(2000);
  }, ['tornado', 'volcano', 'waterfall', 'whale', 'skyWhale', 'crystal', 'turbine', 'murmuration', 'lantern', 'geyser']);
  // Intensities change every update, as the engines will drive them. A warm-up first lets V8
  // compile the update paths, so one-off compilation artifacts stay out of the sample.
  const drive = (milliseconds) => page.evaluate(async (duration) => {
    const tools = window.audioLab.spawn();
    const started = performance.now();
    while (performance.now() - started < duration) {
      const phase = (performance.now() - started) / 1000;
      for (let index = 0; index < window.audioLab.allocationIds.length; index++) tools.intensity(window.audioLab.allocationIds[index], 0.5 + 0.4 * Math.sin(phase + index));
      await window.audioLab.sleep(50);
    }
  }, milliseconds);
  await drive(ALLOCATION_WARMUP_MS);
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await drive(6000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await cdp.send('HeapProfiler.disable');
  await cdp.detach();
  const statsDuring = await page.evaluate(() => {
    const tools = window.audioLab.spawn();
    const stats = tools.stats();
    tools.stopAll();
    tools.setBudget(10);
    return stats;
  });
  const watched = /\/src\/audio\/(spawnVoices|synthKit|spatial)\.js|\/src\/audio\/recipes\//;
  const nodes = new Map();
  const walk = (node) => {
    nodes.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  // Samples by allocation size. A sample's size is scaled for the sampling interval
  // (size / (1 - exp(-size / interval))), so a 12-byte V8 HeapNumber (a boxed double, produced by
  // floating-point maths in code V8 has not optimized) reads as about 134 bytes; the smallest
  // real object (a JS object, array or closure) is larger than that.
  const sites = new Map();
  const sizes = new Map();
  let total = 0;
  let heapNumberBytes = 0;
  for (const sample of profile.samples) {
    const node = nodes.get(sample.nodeId);
    if (!node || !watched.test(node.callFrame.url)) continue;
    sizes.set(sample.size, (sizes.get(sample.size) ?? 0) + 1);
    if (sample.size <= HEAP_NUMBER_SAMPLE_BYTES) {
      heapNumberBytes += sample.size;
      continue;
    }
    const key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').slice(-2).join('/')}:${node.callFrame.lineNumber + 1} (${sample.size} B)`;
    sites.set(key, (sites.get(key) ?? 0) + sample.size);
    total += sample.size;
  }
  process.stdout.write(`  info allocations / ${label} sampled over 6 s: ${heapNumberBytes} bytes of boxed doubles, ${total} bytes of other small`
    + ` allocations ${JSON.stringify(Object.fromEntries(sites))}; ${statsDuring.realized} voices realized\n`);
  return { objectBytes: total, sites: Object.fromEntries(sites), heapNumberSampleBytes: heapNumberBytes, sampleSizes: Object.fromEntries(sizes), voicesRealized: statsDuring.realized };
}

async function runBackend(server, port, backend, executablePath) {
  const label = backend === 'webgl' ? '[WebGL2]' : '[WebGPU]';
  const profileDir = join(tmpdir(), `driftwing-audio-lab-profile-${process.pid}-${backend}`);
  const consoleErrors = [];
  const consoleWarnings = [];
  const summary = { backend: null };
  const browser = await puppeteer.launch({
    executablePath,
    headless: !options.headful,
    userDataDir: profileDir,
    args: [
      '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,720',
      ...(options.jsFlags ? [`--js-flags=${options.jsFlags}`] : []),
    ],
    defaultViewport: { width: 1280, height: 720 },
    dumpio: false,
  });
  if (options.jsFlags) {
    const chromeLog = createWriteStream(join(options.out, `chrome-${backend}.log`));
    browser.process()?.stdout?.pipe(chromeLog);
    browser.process()?.stderr?.pipe(chromeLog);
  }
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'assert') consoleErrors.push(message.text());
      else if (type === 'warn' || type === 'warning') consoleWarnings.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      if (request.failure()?.errorText !== 'net::ERR_ABORTED') consoleErrors.push(`requestfailed: ${request.url()}`);
    });
    page.setDefaultTimeout(600000);
    const url = `http://127.0.0.1:${port}/v2/${backend === 'webgl' ? '?renderer=webgl' : ''}`;
    process.stdout.write(`audio lab: ${label} opening ${url}\n`);
    await page.goto(url, { waitUntil: 'load', timeout: 300000 });
    const readyDeadline = Date.now() + 300000;
    while (Date.now() < readyDeadline) {
      if (await page.evaluate(() => Boolean(window.DRIFTWING?.ready)).catch(() => false)) break;
      await sleep(500);
    }
    summary.backend = await page.evaluate(() => window.DRIFTWING?.backend ?? null);
    check('boot', `${label} V2 ready on the requested backend`, summary.backend === (backend === 'webgl' ? 'WebGL2' : 'WebGPU'), String(summary.backend));
    await page.evaluate(installPageHelpers);
    const beforeUnlock = await page.evaluate(() => window.audioLab.audio().getStats().state);
    // The activation: a harmless key (I toggles the stats overlay; pressed again it goes away).
    await page.keyboard.press('KeyI');
    let state = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await page.evaluate(() => window.audioLab.audio().getStats().state);
      if (state === 'running') break;
      await sleep(250);
    }
    await page.keyboard.press('KeyI');
    check('boot', `${label} the activation key press starts audio`, beforeUnlock === 'locked' && state === 'running', `${beforeUnlock} -> ${state}`);
    if (state !== 'running') return summary;
    const tests = [
      ['recipes', testRecipes],
      ['distanceRender', testDistanceRender],
      ['crystalPitch', testCrystalPitch],
      ['lifecycle', testLifecycle],
      ['distanceGains', testDistanceGains],
      ['budget', testBudget],
      ['thunder', testThunder],
      ['doppler', testLiveDoppler],
      ['allocations', testAllocations],
    ];
    for (const [name, test] of tests) {
      if (!options.only || options.only.has(name)) summary[name] = await test(page, label);
    }
    summary.spawnStats = await page.evaluate(() => window.audioLab.audio().getStats().spawn);
  } finally {
    const closing = browser.close();
    const timedOut = await Promise.race([closing.then(() => false), sleep(BROWSER_CLOSE_TIMEOUT_MS).then(() => true)]);
    if (timedOut) browser.process()?.kill('SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      process.stderr.write(`could not remove the temporary profile ${profileDir}: ${error.message}\n`);
    }
  }
  check('console', `${label} no console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  check('console', `${label} no console warnings`, consoleWarnings.length === 0, consoleWarnings.slice(0, 5).join(' | '));
  summary.console = { errors: consoleErrors, warnings: consoleWarnings };
  return summary;
}

async function main() {
  mkdirSync(options.out, { recursive: true });
  testDistanceLaw();
  testFrontArrival();
  testDopplerFormula();
  await testUpdateAllocations();
  const browserRuns = {};
  if (!options.nodeOnly) {
    const executablePath = findBrowser(options.browser);
    const port = await findFreePort();
    const cacheDir = join(tmpdir(), `driftwing-audio-lab-vite-${createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 10)}`);
    const server = await createViteServer({
      root: PROJECT_ROOT,
      configFile: join(PROJECT_ROOT, 'vite.config.js'),
      cacheDir,
      logLevel: 'warn',
      clearScreen: false,
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    });
    try {
      await server.listen();
      process.stdout.write(`audio lab: Vite dev server on http://127.0.0.1:${port}/\n`);
      const backends = options.backend === 'both' ? ['webgpu', 'webgl'] : [options.backend];
      for (const backend of backends) browserRuns[backend] = await runBackend(server, port, backend, executablePath);
    } finally {
      await server.close();
    }
  }
  const failed = results.filter((result) => !result.pass);
  for (const result of results) {
    if (!options.verbose && result.pass) continue;
    if (!options.verbose) process.stdout.write(`  FAIL ${result.test} / ${result.name}${result.detail ? `: ${result.detail}` : ''}\n`);
  }
  const report = { passed: failed.length === 0, checks: results.length, failed: failed.length, numbers, browserRuns, results };
  writeFileSync(join(options.out, 'audio-lab.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`audio lab: ${results.length - failed.length}/${results.length} checks passed (report: ${join(options.out, 'audio-lab.json')})\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`audio lab failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
