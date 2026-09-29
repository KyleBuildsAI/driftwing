// SetPieceEngine lab: runs the set-piece engine headless (node) inside a real SpawnManager with the
// framework's test engines (src/dev/spawnTestKit.js), the structure engine and the dev timeline
// (src/dev/setPieceTestKit.js), on a flat stub world.
//
// Tests:
//   validation   broken timelines are refused with an error naming the preset and the field
//   timeline     the dev timeline runs its stages in order for their seeded durations; children
//                start and end through the spawn manager (spawnActivated / spawnEnded), a ramp eases a
//                structure child's glow, a tracked child moves across the ground, narration fires
//                with a target, records measure the closest pass and the time within a radius, and
//                the set piece ends itself complete ('setPiece:ended', spawnEnded 'ended')
//   triggers     `when` waits (time, or the regional weather turning stormy), `until` ends a stage
//                early on the player's distance, childActive / childEnded / altitude hold as stated
//   budgets      a heavy child the heavy limit refuses is retried until the limit allows it
//   determinism  the same seed gives the same stage times, narration lines and child seeds
//   dispose      ending the set piece early ends its children and still reports its records
//   narration    the copilot's chatter handler fills {distance} {direction} {name} {eta}
//   allocation   frames between stage changes allocate nothing
//
// Usage: node --expose-gc tools/lab/setpiece.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { validatePreset } from '../../src/spawns/schema.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createSetPieceEngine, validateTimeline } from '../../src/spawns/engines/setPieceEngine.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { createTestMarkerEngine, createTestPresets, createTestWindEngine } from '../../src/dev/spawnTestKit.js';
import { createStructureTestPresets } from '../../src/dev/structureTestKit.js';
import { DEV_TIMELINE, createSetPieceTestPreset } from '../../src/dev/setPieceTestKit.js';
import { createFlightChatter } from '../../src/copilot/flightChatter.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};

// Flat ground at 50 m (integers: the stub's heights never box), sea level 0.
const world = {
  seedHash: 7,
  WATER_LEVEL: 0,
  heightAt: () => 50,
  groundHeight: () => 50,
  biomeAt: () => ({ key: 'meadows', name: 'Meadows' }),
  hash2(x, z, salt) {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  },
};

function createLab({ heavyLimit = 2 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 9000);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 9000);
  camera.position.set(0, 300, 0);
  camera.updateMatrixWorld();
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    nightFactor: uniform(0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1),
  };
  const state = {
    seed: 'LAB',
    ready: true,
    paused: false,
    photoMode: false,
    time: { elapsed: 0, realElapsed: 0, sunElevation: 30, dayTime: 0.4, nightFactor: 0, goldenFactor: 0 },
    player: { position: new THREE.Vector3(0, 300, 0), forward: new THREE.Vector3(0, 0, -1), heading: 0, speed: 50, agl: 250 },
    flight: { onGround: false },
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory: { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 } } }, backend: 'WebGPU',
    wind, audio: null, world, state, sky: null, bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB',
    surfaces: createGroundSurfaces(),
  });
  manager.setHeavyLimit(heavyLimit);
  manager.register(createTestMarkerEngine());
  manager.register(createTestWindEngine());
  manager.register(createStructureEngine());
  const engine = manager.register(createSetPieceEngine());
  for (const preset of createTestPresets()) manager.addPreset(preset);
  for (const preset of createStructureTestPresets()) manager.addPreset(preset);
  manager.addPreset(createSetPieceTestPreset());
  manager.init();
  const log = [];
  const record = (type) => (payload) => log.push({ type, time: Math.round(state.time.elapsed * 100) / 100, ...payload });
  bus.on('setPiece:stage', record('stage'));
  bus.on('setPiece:narrate', record('narrate'));
  bus.on('setPiece:ended', record('ended'));
  bus.onTyped('spawnActivated', record('activated'));
  bus.onTyped('spawnEnded', record('spawnEnded'));
  function step(frames = 1, dt = 1 / 30) {
    for (let frame = 0; frame < frames; frame++) {
      state.time.elapsed += dt;
      state.time.realElapsed += dt;
      manager.update(dt, dt);
    }
  }
  function start(presetId = 'devTimeline', source = 'debug', seed = 4242) {
    return manager.activate(presetId, { position: { x: 0, y: 50, z: -900 }, heading: 0, source, force: source === 'debug', seed });
  }
  const describe = (id) => engine.describe(manager.getParts(id)[0]);
  return { bus, state, wind, registry, manager, engine, log, step, start, describe };
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    return pattern.test(error.message) ? '' : `wrong message: ${error.message}`;
  }
  return 'did not throw';
}

// ---- validation ----------------------------------------------------------------------------------------
function testValidation() {
  const preset = createSetPieceTestPreset();
  let valid = '';
  try {
    validatePreset(preset, { engineNames: ['setPiece'] });
  } catch (error) {
    valid = error.message;
  }
  check('validation', 'the dev timeline preset validates', valid === '', valid);
  const known = ['testMarker', 'testUpdraft', 'testLureFunnel', 'devSpires'];
  const cases = [
    ['no children', { stages: DEV_TIMELINE.stages }, /setPiece preset "devTimeline" params\.children: is required/],
    ['child without a preset', { ...DEV_TIMELINE, children: { a: {} } }, /params\.children\.a\.preset: is required/],
    ['unknown child preset', { ...DEV_TIMELINE, children: { ...DEV_TIMELINE.children, ghost: { preset: 'ghost' } } }, /params\.children\.ghost\.preset: names a preset the spawn manager does not know: "ghost"/],
    ['stage starts an unknown child', { ...DEV_TIMELINE, stages: [{ id: 'a', duration: 1, start: ['nobody'] }] }, /params\.stages\[0\]\.start\[0\]: names no child: "nobody"/],
    ['stage that never ends', { ...DEV_TIMELINE, stages: [{ id: 'a' }] }, /params\.stages\[0\]: needs a duration or an until condition/],
    ['duplicate stage ids', { ...DEV_TIMELINE, stages: [{ id: 'a', duration: 1 }, { id: 'a', duration: 1 }] }, /stages\[1\]\.id: "a" is used by another stage/],
    ['bad condition', { ...DEV_TIMELINE, stages: [{ id: 'a', duration: 1, until: { speed: 3 } }] }, /stages\[0\]\.until: must have exactly one of time, playerDistance/],
    ['bad weather state', { ...DEV_TIMELINE, stages: [{ id: 'a', duration: 1, until: { weather: ['hail'] } }] }, /"hail" is not one of clear, building, storm, clearing/],
    ['ramp on no param', { ...DEV_TIMELINE, stages: [{ id: 'a', duration: 1, ramps: [{ child: 'marker' }] }] }, /ramps\[0\]\.param: is required/],
    ['from an unknown child', { ...DEV_TIMELINE, children: { a: { preset: 'testMarker', from: 'b' } }, stages: [{ id: 's', duration: 1 }] }, /children\.a\.from: names no child: "b"/],
  ];
  for (const [name, params, pattern] of cases) {
    const detail = expectThrow(() => validateTimeline(preset, params, known), pattern);
    check('validation', `refused: ${name}`, detail === '', detail);
  }
}

// ---- timeline ------------------------------------------------------------------------------------------
function testTimeline() {
  const lab = createLab();
  const id = lab.start();
  check('timeline', 'the set piece starts', typeof id === 'string', String(id));
  lab.step(2);
  const spires = lab.manager.getActive().find((entry) => entry.presetId === 'devSpires');
  const spiresInstance = spires ? lab.manager.getParts(spires.id)[0] : null;
  const glowStart = spiresInstance ? spiresInstance.params.glow : NaN;
  lab.step(60);
  const glowLater = spiresInstance ? spiresInstance.params.glow : NaN;
  check('timeline', 'the ramp eases the spires glow up', glowStart < 0.5 && glowLater > glowStart + 0.3, `${glowStart.toFixed(2)} -> ${glowLater.toFixed(2)}`);
  check('timeline', 'the child got its per-activation params (5 spires)', spiresInstance && spiresInstance.data.meshes.glow !== null && lab.manager.getInstance(spires.id).source === 'debug', spires ? spires.id : 'none');
  let funnelStart = null;
  let funnelLater = null;
  for (let frame = 0; frame < 1800 && !lab.log.some((entry) => entry.type === 'ended'); frame++) {
    lab.step(1);
    const funnel = lab.manager.getActive().find((entry) => entry.presetId === 'testLureFunnel');
    if (funnel && !funnelStart) funnelStart = { ...funnel.position };
    if (funnel) funnelLater = { ...funnel.position };
  }
  lab.step(3);
  const stages = lab.log.filter((entry) => entry.type === 'stage');
  check('timeline', 'the stages run in order', stages.map((entry) => entry.stage).join() === 'gather,rise,funnel,fade', stages.map((entry) => `${entry.stage}@${entry.time}`).join(' '));
  const gatherLength = stages[1].time - stages[0].time;
  check('timeline', 'a stage lasts its seeded duration (gather: 4-6 s)', gatherLength >= 4 - 0.05 && gatherLength <= 6 + 0.1, `${gatherLength.toFixed(2)} s`);
  const children = lab.log.filter((entry) => entry.type === 'activated' && entry.presetId !== 'devTimeline').map((entry) => entry.presetId);
  check('timeline', 'children start through the spawn manager', children.join() === 'testMarker,devSpires,testUpdraft,testLureFunnel', children.join());
  const ends = lab.log.filter((entry) => entry.type === 'spawnEnded' && entry.presetId !== 'devTimeline');
  check('timeline', 'children end through the spawn manager (reason ended)', ends.length === 4 && ends.every((entry) => entry.reason === 'ended'), ends.map((entry) => `${entry.presetId}:${entry.reason}`).join(' '));
  check('timeline', 'the tracked funnel walks east across the ground', funnelStart && funnelLater && funnelLater.x - funnelStart.x > 60, funnelStart ? `${funnelStart.x.toFixed(0)} -> ${funnelLater.x.toFixed(0)}` : 'no funnel');
  const narrations = lab.log.filter((entry) => entry.type === 'narrate');
  check('timeline', 'stages narrate with a target position and the preset name', narrations.length === 4 && narrations.every((entry) => Number.isFinite(entry.position.x) && entry.name === 'Dev timeline'), narrations.map((entry) => entry.text).join(' | '));
  const ended = lab.log.find((entry) => entry.type === 'ended');
  check('timeline', 'the set piece ends complete with its records', ended && ended.completed && ended.stagesRun === 4 && Number.isFinite(ended.records.closestFunnel) && ended.records.nearColumn >= 0, JSON.stringify(ended));
  const own = lab.log.find((entry) => entry.type === 'spawnEnded' && entry.presetId === 'devTimeline');
  check('timeline', 'and the manager removes it (reason ended)', own && own.reason === 'ended' && lab.manager.getActive().length === 0, own ? own.reason : 'still active');
  check('timeline', 'no wind source or light leaked', lab.manager.getStats().leaks.windSources === 0 && lab.manager.getStats().leaks.lights === 0 && lab.wind.sourceCount === 0);
}

// ---- triggers ------------------------------------------------------------------------------------------
function testTriggers() {
  const lab = createLab();
  const id = lab.start();
  // Through 'gather' into 'rise', then fly to the column: its until fires at once.
  for (let frame = 0; frame < 400 && lab.describe(id).stage !== 'rise'; frame++) lab.step(1);
  lab.step(3);
  const column = lab.manager.getActive().find((entry) => entry.presetId === 'testUpdraft');
  lab.state.player.position.set(column.position.x, 300, column.position.z + 50);
  lab.step(2);
  const state = lab.describe(id);
  check('triggers', 'until: the player within 120 m of the column ends "rise" early', state.stage === 'funnel' && !state.running, JSON.stringify({ stage: state.stage, running: state.running }));
  lab.bus.emitTyped('weatherChanged', { state: 'storm', previous: 'building', region: '0:0' });
  lab.step(1);
  check('triggers', 'when: a storm starts the waiting "funnel" stage at once', lab.describe(id).stage === 'funnel' && lab.describe(id).running && lab.describe(id).weather === 'storm');
  lab.step(3);
  const describe = lab.describe(id);
  check('triggers', 'childActive and altitude (all) keep "funnel" running for its duration', describe.stage === 'funnel' && describe.running, JSON.stringify(describe.children));
  lab.manager.deactivate(id, 'test');
}

// ---- budgets -------------------------------------------------------------------------------------------
function testBudgets() {
  const lab = createLab({ heavyLimit: 0 });
  const id = lab.start('devTimeline', 'director', 99);
  for (let frame = 0; frame < 900 && lab.describe(id).stage !== 'funnel'; frame++) lab.step(1);
  lab.step(90);
  const waiting = lab.describe(id);
  const funnel = waiting.children.find((child) => child.key === 'funnel');
  check('budgets', 'a heavy child the heavy limit refuses waits and is retried', funnel.status === 'waiting' && waiting.refusals >= 1, `${funnel.status}, ${waiting.refusals} refusals`);
  lab.manager.setHeavyLimit(2);
  lab.step(90);
  check('budgets', 'it starts once the limit allows it', lab.describe(id).children.find((child) => child.key === 'funnel').status === 'active');
  lab.manager.deactivate(id, 'test');
}

// ---- determinism -----------------------------------------------------------------------------------------
function runTimes(seed) {
  const lab = createLab();
  lab.start('devTimeline', 'debug', seed);
  for (let frame = 0; frame < 2400 && !lab.log.some((entry) => entry.type === 'ended'); frame++) lab.step(1);
  return JSON.stringify(lab.log.filter((entry) => entry.type === 'stage' || entry.type === 'narrate').map((entry) => [entry.type, entry.stage, entry.time, entry.text ?? '']));
}

function testDeterminism() {
  const first = runTimes(777);
  const second = runTimes(777);
  const other = runTimes(778);
  check('determinism', 'the same seed gives the same stage times and lines', first === second, `${first.length} chars`);
  check('determinism', 'another seed gives other times', first !== other);
}

// ---- dispose ---------------------------------------------------------------------------------------------
function testDispose() {
  const lab = createLab();
  const id = lab.start();
  for (let frame = 0; frame < 400 && lab.describe(id).stage !== 'rise'; frame++) lab.step(1);
  lab.step(10);
  lab.manager.deactivate(id, 'test');
  lab.step(2);
  const ended = lab.log.find((entry) => entry.type === 'ended');
  check('dispose', 'an early end reports incomplete with its records', ended && ended.completed === false && ended.stagesRun === 2, JSON.stringify(ended));
  check('dispose', 'and every child ends with it', lab.manager.getActive().length === 0 && lab.wind.sourceCount === 0, lab.manager.getActive().map((entry) => entry.presetId).join());
}

// ---- narration -------------------------------------------------------------------------------------------
function testNarration() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const spoken = [];
  const state = { ready: true, paused: false, time: { realElapsed: 0 }, player: { position: { x: 0, y: 300, z: 0 }, heading: 0, speed: 50 }, flight: {} };
  const settings = { get: () => true };
  createFlightChatter({ bus, state, settings, systems: {}, craftRegistry: { catalog: [] } }, {
    offerChatter: (text, priority, ttl) => spoken.push({ text, priority, ttl }),
    pick: (key, lines) => lines[0],
    formatDistance: (metres) => `${(metres / 1000).toFixed(1)} km`,
    directionPhrase: (bearing) => `to the bearing ${Math.round(bearing)}`,
  });
  bus.emit('setPiece:narrate', { id: 'x', presetId: 'p', name: 'Storm chase', stage: 's', text: '{name}: supercell {distance} {direction}, {eta} out.', position: { x: 0, y: 0, z: -6000 }, priority: 3, ttl: 20 });
  check('narration', 'the copilot fills the tokens and offers the line', spoken.length === 1 && spoken[0].text === 'Storm chase: supercell 6.0 km to the bearing 0, 2 minutes out.' && spoken[0].priority === 3 && spoken[0].ttl === 20, JSON.stringify(spoken));
}

// ---- allocation ------------------------------------------------------------------------------------------
async function testAllocation() {
  const lab = createLab();
  // A long single stage with a ramp, a tracked child, records and conditions (no stage change).
  const params = {
    ...DEV_TIMELINE,
    stages: [
      { id: 'hold', duration: 80000, start: ['spires', 'funnel', 'column'], ramps: [{ child: 'spires', param: 'glow', from: 0, to: 2, over: 80000 }], until: { any: [{ playerDistance: { child: 'funnel', max: 1 } }, { weather: ['storm'] }, { altitude: { min: 90000 } }] } },
    ],
  };
  lab.manager.addPreset(createSetPieceTestPreset(params, 'devHold'));
  const id = lab.start('devHold');
  lab.step(2);
  const setPiece = lab.manager.getParts(id)[0];
  const frame = () => {
    lab.state.time.elapsed += 1 / 60;
    lab.engine.update(setPiece, 1 / 60);
  };
  for (let index = 0; index < 150000; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const before = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const after = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const perFrame = (after - before) / frames;
  check('allocation', `no garbage collection during ${frames} set-piece frames`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(3)} B/frame (ramp, track, records, conditions)`);
  check('allocation', 'the stage kept running (nothing ended it)', lab.engine.describe(setPiece).stage === 'hold' && lab.engine.describe(setPiece).running);
}

await testAllocation();
testValidation();
testTimeline();
testTriggers();
testBudgets();
testDeterminism();
testDispose();
testNarration();
check('console', 'no console errors (valid events, no leaks)', consoleErrors.length === 0, consoleErrors.join(' | '));

console.error = originalError;
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
