// Wind engines lab: runs the VortexEngine and the WindModifierEngine headless (node, three's node
// materials without a renderer) on a real WindField over flat, calm ground, and flies the SIM glider
// and jet through every source.
//
// Tests:
//   sources      each source type blows the right way at probe points: the Rankine vortex (solid body
//                in the core, 1/r outside, cyclonic, inflow within the inflow radius and none past it,
//                updraft core), updraft (lift and a sinking ring), downburst (sinking core, outward ring
//                gust that expands with age), wake (deficit downwind, turbulence), jet stream (tailwind
//                along the tube, none outside), slipstream (boost and lift behind a followed body),
//                wave lift (lift and sink limbs, rotor turbulence beneath), gust front (moves with its
//                drift, lift at the front, outflow behind), curtain (sheet sink, outflow at its foot)
//   vortex       lifecycle forming -> mature -> ropeOut -> dissipated with instance.ended at the
//                duration; rope-out on control.ropeOut for a site; strength eases with the stages;
//                terrain tracking; the far tier removes the source only when it cannot reach
//   lifecycle    wind modifier fades, start / stop windows, timelines, control strengths, a site's
//                active state, ending with the duration; dispose removes every source
//   flight       the glider (30 m/s) and the jet (220 m/s) fly scripted inputs (wings level, pitch
//                held) through each source and through the same path in calm air: vertical speed,
//                load factor, airspeed, ground speed and drift are logged, and each source must move
//                the craft the way it should
//   allocation   after a JIT warm-up, both engines' update() and the WindField samples through every
//                source allocate nothing (heap sampling of src/spawns/engines and src/env)
//   cost         CPU per update and per wind sample, for the report
//
// Usage: node tools/lab/wind-engines.mjs [--verbose]
// Prints one line per check (and the flight table) and exits non-zero if any check fails.
import { Session } from 'node:inspector';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import glider from '../../src/craft/glider.js';
import jet from '../../src/craft/jet.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp } from '../../src/core/util.js';
import { createWindField } from '../../src/env/WindField.js';
import { createScratch, createSlotAllocator, createObjectPool, createInstancedPool, createMeshPool } from '../../src/spawns/pools.js';
import { createVortexEngine } from '../../src/spawns/engines/vortexEngine.js';
import { createWindModifierEngine } from '../../src/spawns/engines/windModifierEngine.js';

const VERBOSE = process.argv.includes('--verbose');
const DT = 1 / 120;
const FRAME = 1 / 60;
const GROUND = 0;
const WATER_LEVEL = -60;

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(10)} ${name}${detail ? `  (${detail})` : ''}\n`);
}
function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

// ============================================================================================
// WORLD AND ENGINES
// ============================================================================================
/** Flat calm ground: no thermals (night, hash rolls above every chance), no ambient wind. */
function createWorld() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const world = {
    seedHash: 7,
    hash2: () => 0.99,
    groundHeight: () => GROUND,
    heightAt: () => GROUND,
    biomeAt: () => ({ key: 'meadows' }),
    WATER_LEVEL,
  };
  const uniforms = {
    time: TSL.uniform(0),
    windDirection: TSL.uniform(new THREE.Vector2(1, 0)),
    windStrength: TSL.uniform(0),
    sunDirection: TSL.uniform(new THREE.Vector3(0.4, 0.3, -0.87)),
    sunColor: TSL.uniform(new THREE.Color(1, 0.85, 0.65)),
    skyZenithColor: TSL.uniform(new THREE.Color(0x4f6fa8)),
    skyHorizonColor: TSL.uniform(new THREE.Color(0xf2c48e)),
    fogColor: TSL.uniform(new THREE.Color(0xe0b48c)),
    nightFactor: TSL.uniform(0),
  };
  const state = { frame: 0, time: { elapsed: 0, sunElevation: -10 }, player: { position: new THREE.Vector3() } };
  const wind = createWindField({ world, uniforms, state, bus });
  const parts = new Map();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 2400);
  const ctx = {
    THREE, TSL, scene, camera: new THREE.PerspectiveCamera(), renderer: null, backend: 'node',
    wind, audio: null,
    terrain: { heightAt: world.heightAt, groundHeight: world.groundHeight, biomeAt: world.biomeAt, waterLevel: WATER_LEVEL },
    time: state.time, sky: null, bus, perf: null, settings: null, state, uniforms, budgets: null, lights: null,
    pools: {
      scratch: createScratch(THREE, 64),
      createSlotAllocator,
      createObjectPool,
      createInstancedPool: (options) => createInstancedPool(THREE, options),
      createMeshPool: (options) => createMeshPool(THREE, options),
    },
    spawns: { getParts: (id) => parts.get(id) ?? [] },
    registerPrewarm() {},
  };
  const vortex = createVortexEngine();
  const modifier = createWindModifierEngine();
  vortex.init(ctx);
  modifier.init(ctx);
  let serial = 0;
  /** Creates an engine instance the way the SpawnManager does (params merged with the activation). */
  function spawn(engine, preset, params, { position = { x: 0, y: GROUND, z: 0 }, heading = 0, duration = null, site = null, id = null, tier = 'near', siblings = [] } = {}) {
    serial++;
    const spawnId = id ?? `lab:${serial}`;
    const instance = engine.create(preset, { ...(preset.engines[0].params ?? {}), ...params, position: new THREE.Vector3(position.x, position.y, position.z), heading, site, startTime: 0, scale: 1, duration, seed: 1000 + serial }, seeded(serial));
    instance.id = spawnId;
    instance.presetId = preset.id;
    instance.engine = engine.name;
    instance.heavy = preset.heavy;
    if (instance.ended === undefined) instance.ended = false;
    parts.set(spawnId, [...siblings, instance]);
    engine.setLOD(instance, tier);
    return instance;
  }
  function frame(dt = FRAME) {
    state.frame++;
    state.time.elapsed += dt;
  }
  return { ctx, world, wind, state, vortex, modifier, spawn, frame, parts };
}

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A preset-like object (contract section 1) for one engine entry. */
function preset(id, engine, params, { heavy = false, wind = [], lod = { near: 1500, mid: 6000, far: 40000 } } = {}) {
  return { id, name: id, category: 'weather', kind: 'event', rarity: 'common', heavy, engines: [{ engine, params }], lod, lure: null, wind, audio: null };
}

/** The air at a point (probe: the craft's own reading stays untouched). */
function air(lab, x, y, z) {
  const sample = lab.wind.probe(new THREE.Vector3(x, y, z), lab.state.time.elapsed);
  return { x: sample.vel.x, y: sample.vel.y, z: sample.vel.z, turbulence: sample.turbulence };
}

function advance(lab, engine, instance, seconds) {
  const frames = Math.round(seconds / FRAME);
  for (let index = 0; index < frames; index++) {
    lab.frame();
    engine.update(instance, FRAME, lab.ctx);
  }
}

// ============================================================================================
// SOURCES
// ============================================================================================
function testSources() {
  // The vortex (mature at once, stationary, at the origin).
  {
    const lab = createWorld();
    // No wobble and no gusts: the profile itself.
    const instance = lab.spawn(lab.vortex, preset('tornado', 'vortex', {}), { startStage: 'mature', wobble: 0, gust: 0 }, { duration: 300 });
    advance(lab, lab.vortex, instance, 2);
    const inside = air(lab, 30, 200, 0);
    const edge = air(lab, 60, 200, 0);
    const out = air(lab, 240, 200, 0);
    const beyond = air(lab, 1700, 200, 0);
    const pull = air(lab, 800, 200, 0);
    check('sources', 'rankine: solid-body core, 1/r outside, cyclonic (counterclockwise from above)', inside.z < -20 && edge.z < inside.z && out.z > edge.z && Math.abs(out.z / edge.z - 0.25) < 0.12, `tangential at 30/60/240 m: ${round(inside.z)}, ${round(edge.z)}, ${round(out.z)} m/s (east of the core, northward is -z)`);
    check('sources', 'rankine: inflow pulls toward the core within the inflow radius, nothing past it', pull.x < -2 && Math.abs(beyond.x) < 1.2 && Math.abs(beyond.z) < 1.2, `radial at 800 m ${round(pull.x)} m/s, at 1700 m (${round(beyond.x)}, ${round(beyond.z)})`);
    check('sources', 'rankine: violent updraft core, heavy turbulence', inside.y > 25 && inside.turbulence > 0.8, `updraft ${round(inside.y)} m/s, turbulence ${round(inside.turbulence)}`);
    lab.vortex.dispose(instance);
    check('sources', 'rankine: dispose removes the source', lab.wind.sourceCount === 0, `${lab.wind.sourceCount} left`);
  }
  const lab = createWorld();
  const make = (type, params = {}, options = {}) => lab.spawn(lab.modifier, preset(type, 'windModifier', { type, fadeIn: 0, ...params }), {}, { duration: 600, ...options });
  const settle = (instance, seconds = 1) => advance(lab, lab.modifier, instance, seconds);
  {
    const instance = make('updraft');
    settle(instance);
    const core = air(lab, 0, 400, 0);
    const ring = air(lab, 320, 400, 0);
    check('sources', 'updraft: a lifting core and a sinking ring', core.y > 6 && ring.y < -0.5, `core ${round(core.y)} m/s, ring ${round(ring.y)} m/s`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('downburst');
    settle(instance, 2);
    const core = air(lab, 0, 600, 0);
    const earlyFront = air(lab, 900, 40, 0);
    settle(instance, 60);
    const lateFront = air(lab, 1400, 40, 0);
    check('sources', 'downburst: a sinking core that slows toward the ground', core.y < -8 && Math.abs(air(lab, 0, 5, 0).y) < Math.abs(core.y) * 0.3, `core ${round(core.y)} m/s at 600 m`);
    check('sources', 'downburst: an outward ring gust that spreads with age', lateFront.x > 5 && lateFront.x > earlyFront.x, `outflow at 1.4 km after 62 s ${round(lateFront.x)} m/s (at 0.9 km after 2 s ${round(earlyFront.x)})`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('wake', { direction: 'ambient' });
    settle(instance);
    const downwind = air(lab, 800, 100, 0);
    const upwind = air(lab, -800, 100, 0);
    check('sources', 'wake: a deficit and turbulence trailing downwind, nothing upwind', downwind.x < -1 && downwind.turbulence > 0.3 && Math.abs(upwind.x) < 0.8, `downwind ${round(downwind.x)} m/s, turbulence ${round(downwind.turbulence)}; upwind ${round(upwind.x)}`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('jetStream', { bend: 0, climb: 0, altitude: 1000, speed: 35 }, { heading: 90 });
    settle(instance);
    const core = air(lab, 0, 1000, 0);
    const outside = air(lab, 0, 1400, 0);
    check('sources', 'jet stream: a strong tailwind along the tube, none outside it', core.x > 30 && Math.abs(outside.x) < 1, `core ${round(core.x)} m/s east, 400 m above ${round(outside.x)}`);
    lab.modifier.dispose(instance);
  }
  {
    // A body moving east at 20 m/s (a sibling part), its slipstream following it.
    const body = { anchor: new THREE.Vector3(0, 600, 0), engine: 'fauna' };
    const instance = make('slipstream', { follow: 'fauna' }, { position: { x: 0, y: 600, z: 0 }, id: 'lab:slip', siblings: [body] });
    for (let step = 0; step < 180; step++) {
      body.anchor.x += 20 * FRAME;
      lab.frame();
      lab.modifier.update(instance, FRAME, lab.ctx);
    }
    const behind = air(lab, body.anchor.x - 400, 600, 0);
    const ahead = air(lab, body.anchor.x + 400, 600, 0);
    check('sources', 'slipstream: a speed and lift lane behind the moving body it follows', behind.x > 4 && behind.y > 1.5 && Math.abs(ahead.x) < 0.8, `behind (${round(behind.x)} east, ${round(behind.y)} up), ahead ${round(ahead.x)}`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('waveLift', { direction: 'ambient' });
    settle(instance);
    const rising = air(lab, 3000 + 1500, 1500, 0);
    const sinking = air(lab, 3000 + 4500, 1500, 0);
    const rotor = air(lab, 3000 + 3000, 300, 0);
    check('sources', 'wave lift: smooth lift and sink limbs downwind, rotor turbulence beneath', rising.y > 2.5 && sinking.y < -2 && rotor.turbulence > 0.45 && rising.turbulence < 0.2, `lift ${round(rising.y)}, sink ${round(sinking.y)} m/s, rotor turbulence ${round(rotor.turbulence)}, wave ${round(rising.turbulence)}`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('gustFront', { drift: 12 }, { heading: 90 });
    settle(instance, 10);
    const front = instance.anchor.x;
    const lift = air(lab, front + 100, 600, 0);
    const behind = air(lab, front - 800, 200, 0);
    check('sources', 'gust front: moves with its drift, lift at the front, outflow behind', Math.abs(front - 120) < 15 && lift.y > 3 && behind.x > 6, `front at ${round(front, 0)} m after 10 s, lift ${round(lift.y)} m/s, outflow ${round(behind.x)} m/s`);
    lab.modifier.dispose(instance);
  }
  {
    const instance = make('curtain', {}, { heading: 0 });
    settle(instance);
    const sheet = air(lab, 0, 250, 0);
    const foot = air(lab, 0, 15, -200);
    check('sources', 'curtain: sinking air in the sheet, spilling outward at its foot', sheet.y < -4 && foot.z < -1.5, `sheet ${round(sheet.y)} m/s, foot ${round(foot.z)} m/s outward`);
    lab.modifier.dispose(instance);
  }
  check('sources', 'every wind modifier source is gone after dispose', lab.wind.sourceCount === 0, `${lab.wind.sourceCount} left`);
}

// ============================================================================================
// VORTEX LIFECYCLE, TRACKING AND LOD
// ============================================================================================
function testVortex() {
  const lab = createWorld();
  const tornado = preset('tornado', 'vortex', {}, { heavy: true });
  const instance = lab.spawn(lab.vortex, tornado, { formSeconds: 20, ropeSeconds: 30, trackSpeed: 12 }, { duration: 120 });
  const trace = [];
  for (let second = 0; second <= 125; second++) {
    advance(lab, lab.vortex, instance, 1);
    const described = lab.vortex.describe(instance);
    trace.push({ second, stage: described.stage, strength: described.strength, ended: instance.ended });
    if (instance.ended) break;
  }
  const at = (second) => trace.find((entry) => entry.second === second);
  check('vortex', 'forming -> mature -> ropeOut -> dissipated, ended at the duration', at(5).stage === 'forming' && at(40).stage === 'mature' && at(100).stage === 'ropeOut' && trace[trace.length - 1].ended && trace.length >= 119, trace.filter((entry, index) => index === 0 || entry.stage !== trace[index - 1].stage).map((entry) => `${entry.second}s ${entry.stage}`).join(', '));
  check('vortex', 'strength eases up while forming and down while roping out', at(5).strength < 0.6 && at(40).strength > 0.99 && at(110).strength < 0.5, `5 s ${round(at(5).strength)}, 40 s ${round(at(40).strength)}, 110 s ${round(at(110).strength)}`);
  const travelled = Math.sqrt(instance.anchor.x * instance.anchor.x + instance.anchor.z * instance.anchor.z);
  // The meander (20 degrees either side) shortens the straight-line distance a little.
  check('vortex', 'tracks across the terrain at its speed', travelled > 12 * 120 * 0.85 && travelled < 12 * 120 * 1.01 && instance.anchor.y === GROUND, `${round(travelled, 0)} m from its start in ${trace.length} s at 12 m/s`);
  lab.vortex.dispose(instance);

  const site = lab.spawn(lab.vortex, tornado, { startStage: 'mature' }, { site: { id: 'lab-site' }, duration: null });
  advance(lab, lab.vortex, site, 200);
  const stillMature = lab.vortex.describe(site).stage === 'mature';
  site.control.ropeOut = true;
  advance(lab, lab.vortex, site, 40);
  const dissipated = lab.vortex.describe(site).stage;
  check('vortex', 'a site stays mature until control.ropeOut, then ropes out without ending', stillMature && dissipated === 'dissipated' && site.ended === false, `after 200 s mature: ${stillMature}; then ${dissipated}, ended ${site.ended}`);
  lab.vortex.dispose(site);

  const near = lab.spawn(lab.vortex, tornado, { startStage: 'mature' }, { duration: 300 });
  const sourcesNear = lab.wind.sourceCount;
  lab.vortex.setLOD(near, 'far');
  const sourcesFar = lab.wind.sourceCount;
  lab.vortex.setLOD(near, 'mid');
  const sourcesBack = lab.wind.sourceCount;
  lab.vortex.dispose(near);
  const wide = lab.spawn(lab.vortex, preset('wide', 'vortex', {}, { lod: { near: 800, mid: 2000, far: 20000 } }), { startStage: 'mature' }, { duration: 300 });
  lab.vortex.setLOD(wide, 'far');
  const wideFar = lab.wind.sourceCount;
  lab.vortex.dispose(wide);
  check('vortex', 'the far tier drops a source that cannot reach the player and keeps one that can', sourcesNear === 1 && sourcesFar === 0 && sourcesBack === 1 && wideFar === 1 && lab.wind.sourceCount === 0, `tornado near/far/mid ${sourcesNear}/${sourcesFar}/${sourcesBack}; inflow 1.5 km with far from 0.92 km: kept ${wideFar}`);

  let refused = null;
  const full = [];
  for (let index = 0; index < 5; index++) {
    try {
      full.push(lab.spawn(lab.vortex, tornado, {}, { duration: 300 }));
    } catch (error) {
      refused = error.message;
    }
  }
  for (const instance of full) lab.vortex.dispose(instance);
  check('vortex', 'a fifth vortex is refused with a clear error; slots come back on dispose', full.length === 4 && /slots/.test(refused ?? '') && lab.vortex.stats().instances === 0, refused ?? 'no refusal');
  let badParam = null;
  try {
    lab.spawn(lab.vortex, tornado, { coreRadius: Number.NaN }, { duration: 300 });
  } catch (error) {
    badParam = error.message;
  }
  check('vortex', 'a non-finite param is refused, naming it', /coreRadius/.test(badParam ?? ''), badParam ?? 'accepted');
}

// ============================================================================================
// WIND MODIFIER LIFECYCLE
// ============================================================================================
function testModifierLifecycle() {
  const lab = createWorld();
  const probe = () => air(lab, 0, 400, 0).y;
  const faded = lab.spawn(lab.modifier, preset('plume', 'windModifier', { type: 'updraft', fadeIn: 10, fadeOut: 10 }), {}, { duration: 60 });
  advance(lab, lab.modifier, faded, 2);
  const early = probe();
  advance(lab, lab.modifier, faded, 20);
  const full = probe();
  advance(lab, lab.modifier, faded, 34);
  const late = probe();
  advance(lab, lab.modifier, faded, 5);
  check('lifecycle', 'fades in, holds, fades out before its duration, then ends', early < full * 0.3 && full > 6 && late < full * 0.5 && faded.ended, `2 s ${round(early)}, 22 s ${round(full)}, 56 s ${round(late)} m/s, ended ${faded.ended}`);
  lab.modifier.dispose(faded);

  const pulsing = lab.spawn(lab.modifier, preset('geyser', 'windModifier', { sources: [{ type: 'updraft', fadeIn: 0, timeline: { keys: [[0, 0], [5, 0], [6, 1], [9, 1], [10, 0]], loop: 20 } }] }), {}, { duration: 600 });
  const samples = [];
  for (let second = 0; second < 40; second++) {
    advance(lab, lab.modifier, pulsing, 1);
    samples.push(round(probe(), 1));
  }
  check('lifecycle', 'a looping timeline erupts on schedule', samples[2] < 1 && samples[7] > 6 && samples[14] < 1 && samples[27] > 6, samples.join(' '));
  pulsing.control.strength = 0;
  advance(lab, lab.modifier, pulsing, 0.1);
  const muted = probe();
  pulsing.control.strength = 1;
  pulsing.control.strengths[0] = 0.5;
  advance(lab, lab.modifier, pulsing, 0.1);
  check('lifecycle', 'control.strength and control.strengths[i] scale the sources', Math.abs(muted) < 0.5, `muted ${round(muted)} m/s`);
  lab.modifier.dispose(pulsing);

  const windowed = lab.spawn(lab.modifier, preset('window', 'windModifier', { type: 'updraft', fadeIn: 0, fadeOut: 2, start: 10, stop: 20 }), {}, { duration: 600 });
  advance(lab, lab.modifier, windowed, 5);
  const before = probe();
  advance(lab, lab.modifier, windowed, 10);
  const during = probe();
  advance(lab, lab.modifier, windowed, 10);
  const after = probe();
  check('lifecycle', 'start / stop windows', Math.abs(before) < 0.5 && during > 6 && Math.abs(after) < 0.5, `5 s ${round(before)}, 15 s ${round(during)}, 25 s ${round(after)}`);
  lab.modifier.dispose(windowed);

  const site = lab.spawn(lab.modifier, preset('siteLift', 'windModifier', { type: 'updraft', fadeIn: 0 }), {}, { duration: null });
  advance(lab, lab.modifier, site, 2);
  const on = probe();
  site.active = false;
  advance(lab, lab.modifier, site, 15);
  const off = probe();
  check('lifecycle', "a site's active state fades its sources out", on > 6 && Math.abs(off) < 0.5 && !site.ended, `active ${round(on)}, inactive ${round(off)} m/s`);
  lab.modifier.dispose(site);

  const fromPreset = lab.spawn(lab.modifier, { ...preset('lenticular', 'windModifier', {}), wind: [{ type: 'waveLift', params: { amplitude: 3 } }, { type: 'rankine', params: {} }] }, {}, { duration: 600 });
  const count = fromPreset.windSourceIds.length;
  lab.modifier.dispose(fromPreset);
  let refused = null;
  try {
    lab.spawn(lab.modifier, preset('bad', 'windModifier', { type: 'vortexish' }), {}, { duration: 60 });
  } catch (error) {
    refused = error.message;
  }
  check('lifecycle', "preset.wind entries become sources (only this engine's types); unknown types are refused", count === 1 && /vortexish/.test(refused ?? ''), `${count} source from 2 entries; ${refused}`);
  check('lifecycle', 'every source is removed after dispose', lab.wind.sourceCount === 0 && lab.modifier.stats().sources === 0, `${lab.wind.sourceCount} left`);
}

// ============================================================================================
// FLIGHT
// ============================================================================================
/** A craft's SIM model in the lab's air: env.wind is the WindField at the craft every tick. */
function createFlightRig(craft, lab, assists) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const craftState = craft.abilities.craftAbility.initialState();
  const world = { groundHeight: () => GROUND, heightAt: () => GROUND, WATER_LEVEL };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { model, data: model.flightData, pilot, env, time: 0 };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    lab.wind.sample(model.state.position, lab.state.time.elapsed, env.wind);
    model.step(DT, controls, env);
    rig.time += DT;
  };
  rig.airborne = ({ speed, altitude, heading, x, z, throttle }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(x, altitude, z), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  return rig;
}

/**
 * Flies craft on a straight scripted line through the lab's air, advancing the spawned instances
 * with it, and returns the log: vertical speed, load factor, airspeed, ground speed and cross-track
 * drift. Scripted inputs: the glider at 0 % assists holds wings level on the ailerons, the ball
 * centred on the rudder and its trim pitch attitude on the elevator; the jet at 100 % assists (its
 * fly-by-wire holds 1 g on a centred stick) holds wings level and the ball.
 */
function fly(craft, lab, { speed, altitude, heading, start, seconds, throttle, instances = [], onFrame = null }) {
  const flyByWire = craft === jet;
  const rig = createFlightRig(craft, lab, flyByWire ? 1 : 0);
  const bankGain = flyByWire ? 1.2 : 1.6;
  const rateGain = flyByWire ? 0.25 : 0.35;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  // Settle the trim in calm air first (the sources are ahead).
  let trimPitch = 0;
  for (let tick = 0; tick < 240; tick++) {
    rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
    rig.pilot.pitch = flyByWire ? 0 : clamp(-0.12 * rig.data.verticalSpeed - 0.25 * rig.data.pitchRate, -1, 1);
    rig.tick();
    trimPitch = rig.data.pitch;
  }
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  let integral = 0;
  const log = { minVertical: Infinity, maxVertical: -Infinity, minLoad: Infinity, maxLoad: -Infinity, minAirspeed: Infinity, maxAirspeed: -Infinity, groundSpeed: 0, samples: 0, maxTurbulence: 0, drift: 0, altitudeChange: 0 };
  const across = { x: Math.cos(heading * DEG), z: Math.sin(heading * DEG) };
  let loadSquares = 0;
  let loadSum = 0;
  let travelled = 0;
  const frames = Math.round(seconds / FRAME);
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    lab.frame();
    if (onFrame) onFrame(frameIndex * FRAME);
    for (const [engine, instance] of instances) engine.update(instance, FRAME, lab.ctx);
    for (let tick = 0; tick < 2; tick++) {
      if (flyByWire) {
        rig.pilot.pitch = 0;
      } else {
        const error = trimPitch - rig.data.pitch;
        integral = clamp(integral + error * DT * 1.2, -0.6, 0.6);
        rig.pilot.pitch = clamp(2.2 * error + integral - 0.6 * rig.data.pitchRate, -1, 1);
      }
      rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
      rig.pilot.yaw = clamp((flyByWire ? 3 : 4) * rig.data.sideslip, -1, 1);
      rig.tick();
    }
    if (frameIndex < 30) continue;
    const data = rig.data;
    const velocity = rig.model.state.velocity;
    log.minVertical = Math.min(log.minVertical, data.verticalSpeed);
    log.maxVertical = Math.max(log.maxVertical, data.verticalSpeed);
    log.minLoad = Math.min(log.minLoad, data.gLoad);
    log.maxLoad = Math.max(log.maxLoad, data.gLoad);
    log.minAirspeed = Math.min(log.minAirspeed, data.airspeed);
    log.maxAirspeed = Math.max(log.maxAirspeed, data.airspeed);
    log.maxTurbulence = Math.max(log.maxTurbulence, rig.env.wind.turbulence);
    loadSquares += data.gLoad * data.gLoad;
    loadSum += data.gLoad;
    travelled += Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z) * FRAME;
    log.samples++;
  }
  const position = rig.model.state.position;
  log.groundSpeed = travelled / (log.samples * FRAME);
  log.drift = (position.x - start.x) * across.x + (position.z - start.z) * across.z;
  log.altitudeChange = position.y - altitude;
  const mean = loadSum / log.samples;
  log.loadDeviation = Math.sqrt(Math.max(0, loadSquares / log.samples - mean * mean));
  return log;
}

const FLIGHT_CRAFT = [
  { craft: glider, label: 'glider', speed: 30, throttle: 0 },
  { craft: jet, label: 'jet', speed: 220, throttle: 0.34 },
];

/** One scenario: flies each craft through a fresh source and through the same path in calm air. */
function scenario(name, build, flightFor, expect) {
  for (const entry of FLIGHT_CRAFT) {
    const plan = flightFor(entry);
    const calmLab = createWorld();
    const calm = fly(entry.craft, calmLab, { ...plan, speed: entry.speed, throttle: entry.throttle });
    const lab = createWorld();
    const instances = build(lab, entry);
    const through = fly(entry.craft, lab, { ...plan, speed: entry.speed, throttle: entry.throttle, instances, onFrame: plan.onFrame ? plan.onFrame(lab, instances) : null });
    const row = {
      vertical: `${round(calm.minVertical, 1)}..${round(calm.maxVertical, 1)} -> ${round(through.minVertical, 1)}..${round(through.maxVertical, 1)}`,
      load: `${round(calm.minLoad)}..${round(calm.maxLoad)} -> ${round(through.minLoad)}..${round(through.maxLoad)} (sd ${round(calm.loadDeviation, 3)} -> ${round(through.loadDeviation, 3)})`,
      airspeed: `${round(calm.minAirspeed, 1)}..${round(calm.maxAirspeed, 1)} -> ${round(through.minAirspeed, 1)}..${round(through.maxAirspeed, 1)}`,
      ground: `${round(calm.groundSpeed, 1)} -> ${round(through.groundSpeed, 1)}`,
      drift: `${round(calm.drift, 0)} -> ${round(through.drift, 0)}`,
      turbulence: round(through.maxTurbulence),
    };
    flightTable.push({ scenario: name, craft: entry.label, ...row });
    const verdict = expect(entry, calm, through);
    check('flight', `${entry.label} through the ${name}: ${verdict.what}`, verdict.pass, `vs ${row.vertical} m/s; g ${row.load}; airspeed ${row.airspeed}; ground ${row.ground} m/s; drift ${row.drift} m; turbulence ${row.turbulence}`);
    for (const [engine, instance] of instances) engine.dispose(instance);
  }
}
const flightTable = [];

function testFlight() {
  const along = (distance) => ({ x: -distance, z: 0 });
  const through = (entry, span) => ({ altitude: 0, heading: 90, start: along(span * 0.5), seconds: span / entry.speed });
  const modifier = (type, params, options = {}) => (lab) => [[lab.modifier, lab.spawn(lab.modifier, preset(type, 'windModifier', { type, fadeIn: 0, ...params }), {}, { duration: 900, ...options })]];
  // What each craft must feel. The glider (no assists) rides the air mass: it climbs in lift, sinks
  // in sink and drifts with the flow. The jet's fly-by-wire (100 %) holds 1 g on a centred stick, so
  // it keeps its flight path through vertical air and feels it as load and angle-of-attack bumps;
  // horizontal air shows in its airspeed.
  const isJet = (entry) => entry.label === 'jet';
  const bumped = (calm, air, factor = 2) => air.loadDeviation > calm.loadDeviation * factor;
  const airspeedSwing = (calm, air) => (air.maxAirspeed - air.minAirspeed) - (calm.maxAirspeed - calm.minAirspeed);

  scenario('updraft column', modifier('updraft', { radius: 220, strength: 9 }), (entry) => ({ ...through(entry, isJet(entry) ? 4000 : 1200), altitude: 400 }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'a load bump crossing the column', pass: bumped(calm, air, 4) && air.maxLoad > calm.maxLoad + 0.3 }
      : { what: 'climbs in the core', pass: air.maxVertical > calm.maxVertical + 3 }));
  scenario('downburst', modifier('downburst', {}), (entry) => ({ ...through(entry, isJet(entry) ? 5000 : 1600), altitude: 350 }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'load bumps and an airspeed swing through the outflow', pass: bumped(calm, air) && airspeedSwing(calm, air) > 5 }
      : { what: 'sinks in the core, airspeed swings through the outflow', pass: air.minVertical < calm.minVertical - 3 && airspeedSwing(calm, air) > 3 }));
  scenario('wake', modifier('wake', { direction: 'ambient', length: 4000, top: 300 }), (entry) => ({ altitude: 150, heading: 90, start: { x: 200, z: 0 }, seconds: Math.min(2600 / entry.speed, 60) }),
    (entry, calm, air) => ({ what: 'bumps (load factor spread) and the turbulence reading', pass: bumped(calm, air) && air.maxTurbulence > 0.3 }));
  // The tube fades in over its first 8 %: the craft flies in from its upwind end.
  scenario('jet stream', modifier('jetStream', { bend: 0, climb: 0, altitude: 1000, length: 12000 }, { heading: 90, position: { x: 6000, y: GROUND, z: 0 } }), (entry) => ({ altitude: 1000, heading: 90, start: { x: -200, z: 0 }, seconds: isJet(entry) ? 45 : 90 }),
    (entry, calm, air) => ({ what: 'a tailwind: ground speed well above airspeed', pass: air.groundSpeed - air.minAirspeed > (isJet(entry) ? 20 : 15) && air.groundSpeed > calm.groundSpeed + (isJet(entry) ? 3 : 15) }));
  scenario('slipstream', (lab) => {
    const body = { anchor: new THREE.Vector3(800, 600, 0), engine: 'fauna' };
    const instance = lab.spawn(lab.modifier, preset('slipstream', 'windModifier', { type: 'slipstream', fadeIn: 0, follow: 'fauna', length: 2500, width: 200, height: 120 }), {}, { duration: 900, position: { x: 800, y: 600, z: 0 }, id: 'lab:body', siblings: [body] });
    lab.bodyAnchor = body.anchor;
    return [[lab.modifier, instance]];
  }, (entry) => ({
    altitude: 600,
    heading: 90,
    start: { x: 0, z: 0 },
    seconds: 20,
    // The body flies east ahead of the craft, a little faster, so the craft stays in its lane.
    onFrame: (lab) => () => {
      lab.bodyAnchor.x += (entry.speed + 5) * FRAME;
    },
  }),
  (entry, calm, air) => (isJet(entry)
    ? { what: 'a speed lane: ground speed above airspeed', pass: air.groundSpeed - air.minAirspeed > calm.groundSpeed - calm.minAirspeed + 5 }
    : { what: 'a speed and lift lane: ground speed and climb up', pass: air.groundSpeed > calm.groundSpeed + 4 && air.altitudeChange > calm.altitudeChange + 10 }));
  scenario('wave lift', modifier('waveLift', { direction: 'ambient', crests: 2 }), (entry) => ({ altitude: 1500, heading: 90, start: { x: 3500, z: 0 }, seconds: Math.min(2400 / entry.speed, 60) }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'smooth (no turbulence, gentle loads)', pass: air.maxTurbulence < 0.3 && air.minLoad > 0.8 && air.maxLoad < 1.3 }
      : { what: 'smooth lift in the rising limb', pass: air.maxVertical > calm.maxVertical + 2 && air.maxTurbulence < 0.3 }));
  scenario('wave rotor', modifier('waveLift', { direction: 'ambient', crests: 2 }), (entry) => ({ altitude: 300, heading: 90, start: { x: 5000, z: 0 }, seconds: Math.min(2000 / entry.speed, 40) }),
    (entry, calm, air) => ({ what: 'rough air beneath the crest', pass: air.maxTurbulence > 0.45 && bumped(calm, air) }));
  scenario('gust front', modifier('gustFront', { drift: 12 }, { heading: 270, position: { x: 1200, y: GROUND, z: 0 } }), (entry) => ({ altitude: 400, heading: 90, start: { x: -600, z: 0 }, seconds: isJet(entry) ? 20 : 60 }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'a headwind jump in the outflow and bumps at the front', pass: air.maxAirspeed > calm.maxAirspeed + 5 && bumped(calm, air) }
      : { what: 'lift at the front, then a headwind jump in the outflow', pass: air.maxVertical > calm.maxVertical + 2 && air.maxAirspeed > calm.maxAirspeed + 5 }));
  scenario('downdraft curtain', modifier('curtain', { length: 600 }, { heading: 90 }), (entry) => ({ ...through(entry, isJet(entry) ? 3000 : 800), altitude: 300 }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'a load dip through the sheet', pass: air.minLoad < calm.minLoad - 0.2 }
      : { what: 'sinks through the sheet', pass: air.minVertical < calm.minVertical - 2 }));
  scenario('tornado (600 m abeam)', (lab) => [[lab.vortex, lab.spawn(lab.vortex, preset('tornado', 'vortex', {}), { startStage: 'mature' }, { duration: 900, position: { x: 0, y: GROUND, z: 600 } })]],
    (entry) => ({ altitude: 300, heading: 90, start: { x: isJet(entry) ? -2000 : -600, z: 0 }, seconds: isJet(entry) ? 18 : 40 }),
    (entry, calm, air) => (isJet(entry)
      ? { what: 'shaken: load bumps, an airspeed swing, the turbulence reading', pass: bumped(calm, air) && airspeedSwing(calm, air) > 5 && air.maxTurbulence > 0.3 }
      : { what: 'pulled toward the funnel (drift south) and shaken', pass: air.drift > calm.drift + 40 && air.maxTurbulence > 0.3 }));
  process.stdout.write('\nflight log (calm -> through the source)\n');
  for (const row of flightTable) {
    process.stdout.write(`  ${row.scenario.padEnd(22)} ${row.craft.padEnd(7)} vs ${row.vertical.padEnd(24)} g ${row.load.padEnd(44)} airspeed ${row.airspeed.padEnd(26)} ground ${row.ground.padEnd(14)} drift ${row.drift.padEnd(12)} turb ${row.turbulence}\n`);
  }
  process.stdout.write('\n');
}

// ============================================================================================
// ALLOCATION AND COST
// ============================================================================================
async function sampleAllocations(run) {
  const session = new Session();
  session.connect();
  const post = (method, params) => new Promise((resolvePost, rejectPost) => {
    session.post(method, params, (error, result) => (error ? rejectPost(error) : resolvePost(result)));
  });
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  run();
  const { profile } = await post('HeapProfiler.stopSampling');
  await post('HeapProfiler.disable');
  session.disconnect();
  // Own: the engines and their samplers. Field: the Phase 1 WindField around them (its layers box a
  // few doubles per sample whether or not a source is registered; measured against a calm field).
  let bytes = 0;
  let fieldBytes = 0;
  const sites = new Map();
  const walk = (node) => {
    const url = node.callFrame.url;
    if (node.selfSize > 0 && url.includes('/src/spawns/engines/')) {
      bytes += node.selfSize;
      const key = `${node.callFrame.functionName || '(anonymous)'} ${url.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    } else if (node.selfSize > 0 && url.includes('/src/env/WindField.js')) {
      fieldBytes += node.selfSize;
    }
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  return { bytes, fieldBytes, sites: [...sites.entries()].sort((first, second) => second[1] - first[1]).slice(0, 4) };
}

async function testAllocationAndCost() {
  const lab = createWorld();
  const instances = [
    [lab.vortex, lab.spawn(lab.vortex, preset('tornado', 'vortex', {}, { heavy: true }), { trackSpeed: 12, formSeconds: 5 }, { duration: 100000 })],
    [lab.vortex, lab.spawn(lab.vortex, preset('spout', 'vortex', {}), { startStage: 'mature', coreRadius: 16, topRadius: 80 }, { duration: 100000, position: { x: 3000, y: GROUND, z: 0 } })],
    [lab.modifier, lab.spawn(lab.modifier, preset('mix', 'windModifier', {
      drift: 6,
      sources: [
        { type: 'updraft', timeline: { keys: [[0, 0], [5, 1], [10, 0]], loop: 12 } },
        { type: 'downburst' },
        { type: 'wake', direction: 'ambient' },
        { type: 'jetStream' },
        { type: 'waveLift', direction: 'ambient' },
        { type: 'gustFront' },
        { type: 'curtain' },
      ],
    }), {}, { duration: 100000 })],
  ];
  const body = { anchor: new THREE.Vector3(0, 600, 0), engine: 'fauna' };
  instances.push([lab.modifier, lab.spawn(lab.modifier, preset('slip', 'windModifier', { type: 'slipstream', follow: 'fauna' }), {}, { duration: 100000, id: 'lab:alloc-body', siblings: [body] })]);
  const probes = [new THREE.Vector3(40, 200, 0), new THREE.Vector3(600, 400, 300), new THREE.Vector3(3000, 800, 100)];
  const out = { vel: new THREE.Vector3(), turbulence: 0 };
  const frame = () => {
    lab.frame();
    body.anchor.x += 0.3;
    for (let index = 0; index < instances.length; index++) instances[index][0].update(instances[index][1], FRAME, lab.ctx);
    for (let index = 0; index < probes.length; index++) {
      lab.wind.probe(probes[index], lab.state.time.elapsed, out);
      probes[index].x += 0.2;
    }
  };
  for (let index = 0; index < 30000; index++) frame();
  const frames = 20000;
  const sampled = await sampleAllocations(() => {
    for (let index = 0; index < frames; index++) frame();
  });
  const perFrame = sampled.bytes / frames;
  const calmLab = createWorld();
  const calmOut = { vel: new THREE.Vector3(), turbulence: 0 };
  const calmFrame = () => {
    calmLab.frame();
    for (let index = 0; index < probes.length; index++) calmLab.wind.probe(probes[index], calmLab.state.time.elapsed, calmOut);
  };
  for (let index = 0; index < 30000; index++) calmFrame();
  const calmSampled = await sampleAllocations(() => {
    for (let index = 0; index < frames; index++) calmFrame();
  });
  check('allocation', `${instances.length} instances (2 vortices, 9 wind modifier sources) and 3 wind samples per frame: the engines and their samplers allocate nothing (sampled, under 0.1 byte per frame)`, perFrame < 0.1, `${sampled.bytes} B over ${frames} frames = ${perFrame.toFixed(3)} B/frame${sampled.sites.length ? `; top: ${sampled.sites.map(([key, bytes]) => `${key} ${bytes} B`).join(', ')}` : ''}`);
  const fieldPerFrame = sampled.fieldBytes / frames;
  const calmPerFrame = calmSampled.fieldBytes / frames;
  check('allocation', 'the sources add nothing to what the Phase 1 WindField allocates per sample (report)', fieldPerFrame <= calmPerFrame * 1.5 + 1, `WindField ${fieldPerFrame.toFixed(1)} B/frame with the sources, ${calmPerFrame.toFixed(1)} B/frame in a calm field (3 samples a frame)`);

  const timeIt = (count, run) => {
    const started = process.hrtime.bigint();
    for (let index = 0; index < count; index++) run();
    return Number(process.hrtime.bigint() - started) / 1000 / count;
  };
  const vortexUpdate = timeIt(20000, () => {
    lab.frame();
    lab.vortex.update(instances[0][1], FRAME, lab.ctx);
  });
  const modifierUpdate = timeIt(20000, () => {
    lab.frame();
    lab.modifier.update(instances[2][1], FRAME, lab.ctx);
  });
  const sampleCost = timeIt(60000, () => lab.wind.probe(probes[0], lab.state.time.elapsed, out));
  const calm = createWorld();
  const calmCost = timeIt(60000, () => calm.wind.probe(probes[0], calm.state.time.elapsed, out));
  check('cost', 'CPU per update and per wind sample (report)', true, `vortex update ${vortexUpdate.toFixed(2)} us, wind modifier update (7 sources) ${modifierUpdate.toFixed(2)} us, WindField sample with all 10 sources ${sampleCost.toFixed(2)} us (calm field ${calmCost.toFixed(2)} us)`);
  for (const [engine, instance] of instances) engine.dispose(instance);
  check('allocation', 'every source removed after the run', lab.wind.sourceCount === 0, `${lab.wind.sourceCount} left`);
}

// ============================================================================================
testSources();
testVortex();
testModifierLifecycle();
testFlight();
await testAllocationAndCost();
const failed = results.filter((result) => !result.pass).length;
log(JSON.stringify(flightTable, null, 2));
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
