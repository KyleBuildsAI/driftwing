// Paraglider flight lab: flies SimParaglider headless (node, no renderer) with scripted controls through
// the same control stages the game runs every physics tick (the autopilot and the paraglider assists)
// and prints its measured performance against the spec numbers (Milestone D, PARAGLIDER).
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3), still unless a test adds wind, a
// thermal or turbulence, over flat ground (a slope or a sea for the ground tests). Physics runs at the
// game's fixed 120 Hz.
//
// Tests:
//   trim         hands up: the steady glide ratio (about 9 : 1), the trim speed (about 38 km/h), the sink
//   bar          full speed bar: about 50 km/h, a steeper glide than trim
//   brakes       half brakes: slower with a sink no worse than trim; both brakes deep: about 25 km/h
//   stall        0 % assists, both brakes fully down: the wing stalls; released, it surges and flies
//                again; at 100 % the stall protection keeps it flying
//   turn         one brake half down: a brisk turn the right way; fully down at 0 % it spins, at 100 % the
//                spin protection holds it to a hard turn; a full weight shift alone: a gentle one
//   ears         big ears: the sink at least doubles while the airspeed stays near trim
//   pendulum     a brake pulse then release: the canopy swings ahead of the pilot (the two-body
//                pendulum) and the swing damps out
//   thermal      a 4 m/s thermal core: circling at about 30 degrees of bank climbs
//   collapse     strong turbulence on full bar: collapses at 0 % (they reopen on their own once the air
//                calms), faster recovery at 50 %, none at 100 % (active piloting)
//   landing      a glide into flat ground: a graded landing (no crash), the wing killed and laid down
//   launch       standing on a slope: the launch run inflates the wing and lifts off; on the flat with
//                no wind it stops and says so
//   water        a glide into the sea: it floats, the landing is graded and the phase is landed
//   robust       two minutes of random stick, brakes, bar and big ears in turbulence: every value finite
//   allocation   the model module allocates no objects per tick, at most four boxed numbers (doubles
//                handed to the shared ground contact and the terrain query), sampled by V8's heap
//                profiler over two minutes of circling in turbulence at 100 % assists
//
// Usage: node tools/lab/paraglider.mjs [--verbose]
// Prints a PASS / FAIL table and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import paraglider from '../../src/craft/paraglider.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { Session } from 'node:inspector/promises';
import { DEG, clamp, headingFromVector } from '../../src/core/util.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const KMH = 3.6;
const TOLERANCE = 0.1;
const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createFlatWorld(ground = 0, waterLevel = -60) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL: waterLevel };
}

/** Ground falling to the south (+z) at `gradient` metres per metre around the origin, flat beyond 400 m. */
function createSlopeWorld(gradient) {
  const height = (x, z) => 200 - clamp(z, -400, 400) * gradient;
  return { groundHeight: height, heightAt: height, WATER_LEVEL: -60 };
}

/**
 * A thermal column centred at (x, z): core radius `radius`, `strength` m/s at its centre (1 - r^2
 * profile), sinking ring outside; probe() mirrors the WindField's call shape for the canopy.
 */
function createThermalField({ x = 0, z = 0, radius = 120, strength = 4 } = {}) {
  function sample(position, out) {
    const ratio = Math.hypot(position.x - x, position.z - z) / radius;
    let lift = 0;
    if (ratio < 1) lift = strength * (1 - ratio * ratio);
    else if (ratio < 3) lift = -0.28 * strength * Math.sin(Math.PI * Math.min(1, (ratio - 1) / 2));
    out.vel.set(0, lift, 0);
    out.turbulence = 0.1;
    return out;
  }
  return { sample, probe: (position, time, out) => sample(position, out) };
}

function createRig({ assists = 0, world = createFlatWorld(), field = null, turbulence = 0, wind = null } = {}) {
  const craft = paraglider;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], stats: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  bus.onTyped('journalStat', (payload) => events.stats.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = {
    time: 0,
    wind: { vel: new THREE.Vector3(), turbulence },
    groundHeight: world.groundHeight,
    waterLevel: world.WATER_LEVEL,
    rho: SEA_LEVEL_RHO,
    world,
    craftState,
    assists,
    handsOff: false,
    autopilot,
    telemetry,
    windField: field ? { probe: (position, time, out) => { field.probe(position, time, out); if (wind) out.vel.add(wind); out.turbulence = Math.max(out.turbulence, turbulence); return out; } } : null,
  };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [] };
  const rig = { craft, model, data: model.flightData, pilot, controls, env, context, events, craftState, time: 0, telemetry, collapseSeen: 0 };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    if (field) {
      field.sample(model.state.position, env.wind);
      env.wind.turbulence = Math.max(env.wind.turbulence, turbulence);
    } else {
      env.wind.turbulence = turbulence;
    }
    if (wind) env.wind.vel.add(wind);
    model.step(DT, controls, env);
    rig.time += DT;
    rig.collapseSeen = Math.max(rig.collapseSeen, craftState.collapse.left, craftState.collapse.right);
  };
  rig.run = (seconds, script) => {
    const ticks = Math.round(seconds / DT);
    for (let tick = 0; tick < ticks; tick++) {
      if (script && script(rig) === true) return true;
      rig.tick();
    }
    return false;
  };
  /** Flying level at `speed` toward `heading` at `altitude`. */
  rig.airborne = ({ speed = 10.5, heading = 0, altitude = 1500, x = 0, z = 0 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    const velocity = new THREE.Vector3(Math.sin(heading * DEG) * speed, 0, -Math.cos(heading * DEG) * speed);
    model.reset({ position: new THREE.Vector3(x, altitude, z), quaternion, velocity, angularVelocity: new THREE.Vector3(), onGround: false, throttle: 0 });
  };
  /** Standing on the ground at (x, z) facing heading. */
  rig.standing = ({ x = 0, z = 0, heading = 0 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    const ground = world.groundHeight(x, z);
    model.reset({ position: new THREE.Vector3(x, ground + 0.95, z), quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), onGround: true, throttle: 0 });
  };
  rig.state = () => model.state;
  return rig;
}

/** Glide ratio (horizontal over height lost) and mean airspeed and sink over `seconds`. */
function measureGlide(rig, seconds, script) {
  const start = rig.state().position.clone();
  let speedSum = 0;
  let samples = 0;
  rig.run(seconds, (current) => {
    if (script) script(current);
    speedSum += current.data.airspeed;
    samples++;
  });
  const end = rig.state().position;
  const distance = Math.hypot(end.x - start.x, end.z - start.z);
  const drop = start.y - end.y;
  return { glide: drop > 0 ? distance / drop : Infinity, speed: speedSum / Math.max(samples, 1), sink: drop / seconds, drop, distance };
}

/** Heading change rate (deg/s) over `seconds`, unwrapped. */
function measureTurn(rig, seconds, script) {
  let previous = rig.data.heading;
  let total = 0;
  rig.run(seconds, (current) => {
    if (script) script(current);
    const heading = current.data.heading;
    let delta = heading - previous;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    total += delta;
    previous = heading;
  });
  return total / seconds;
}

// ============================================================================================
// TESTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = TOLERANCE, compare = 'within', note = '', decimals = 1 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  results.push({
    test,
    measured: `${format(measured)}${unit ? ` ${unit}` : ''}`,
    target: compare === 'within' ? `${format(target)}${unit ? ` ${unit}` : ''} +/-${Math.round(tolerance * 100)}%` : compare === 'max' ? `<= ${format(target)}${unit ? ` ${unit}` : ''}` : compare === 'min' ? `>= ${format(target)}${unit ? ` ${unit}` : ''}` : String(target),
    pass,
    note,
  });
}

const targets = paraglider.simProfile.targets;

/** A steady glide with fixed inputs: settle, then measure. */
function steadyGlide(setup, { assists = 0, settle = 25, seconds = 20 } = {}) {
  const rig = createRig({ assists });
  rig.airborne({});
  setup(rig.pilot);
  rig.run(settle);
  const result = measureGlide(rig, seconds);
  return { ...result, aoa: rig.data.aoa / DEG, stalled: rig.data.stalled, rig };
}

function trimTest() {
  const trim = steadyGlide(() => {});
  log('trim', JSON.stringify({ glide: trim.glide, speed: trim.speed, sink: trim.sink, aoa: trim.aoa }));
  record('glide ratio at trim', trim.glide, targets.glideRatio, { unit: ': 1', decimals: 2 });
  record('trim speed', trim.speed * KMH, targets.trimSpeed * KMH, { unit: 'km/h', tolerance: 0.05 });
  record('sink at trim', trim.sink, targets.trimSink, { unit: 'm/s', decimals: 2, tolerance: 0.12 });
  record('pendulum settles at trim', Math.abs(trim.rig.data.pendulumRate), 0.01, { unit: 'rad/s', compare: 'max', decimals: 3 });
  return trim;
}

function barTest(trim) {
  const bar = steadyGlide((pilot) => { pilot.throttle = 1; });
  log('bar', JSON.stringify({ glide: bar.glide, speed: bar.speed, sink: bar.sink, aoa: bar.aoa }));
  record('full speed bar speed', bar.speed * KMH, targets.fullBarSpeed * KMH, { unit: 'km/h', tolerance: 0.06 });
  record('full speed bar glides steeper than trim', bar.glide, trim.glide, { unit: ': 1', compare: 'max', decimals: 2 });
}

function brakesTest(trim) {
  const half = steadyGlide((pilot) => { pilot.brakeL = 0.5; pilot.brakeR = 0.5; });
  const deep = steadyGlide((pilot) => { pilot.brakeL = 1; pilot.brakeR = 1; }, { assists: 1 });
  log('half', JSON.stringify({ speed: half.speed, sink: half.sink, aoa: half.aoa }), 'deep', JSON.stringify({ speed: deep.speed, sink: deep.sink, aoa: deep.aoa, stalled: deep.stalled }));
  record('half brakes: slower than trim', half.speed * KMH, trim.speed * KMH * 0.9, { unit: 'km/h', compare: 'max' });
  record('half brakes: sink no worse than trim', half.sink, trim.sink, { unit: 'm/s', compare: 'max', decimals: 2 });
  record('deep brakes (100 % assists): minimum speed', deep.speed * KMH, targets.minSpeed * KMH, { unit: 'km/h', tolerance: 0.15 });
  record('deep brakes (100 % assists): not stalled', deep.stalled ? 'stalled' : 'flying', 'flying', { compare: !deep.stalled });
}

function stallTest() {
  const rig = createRig({ assists: 0 });
  rig.airborne({});
  rig.run(10);
  rig.pilot.brakeL = 1;
  rig.pilot.brakeR = 1;
  let stalled = false;
  let stallSink = 0;
  rig.run(10, (current) => {
    if (current.data.stalled) {
      stalled = true;
      stallSink = Math.max(stallSink, -current.state().velocity.y);
    }
  });
  rig.pilot.brakeL = 0;
  rig.pilot.brakeR = 0;
  let recoveredAt = null;
  rig.run(12, (current) => {
    if (recoveredAt === null && !current.data.stalled && current.data.stallDepth === 0 && current.data.airspeed > 9 && current.state().velocity.y > -3) recoveredAt = current.time;
  });
  const recovered = recoveredAt !== null;
  log('stall', JSON.stringify({ stalled, stallSink, recovered, recoveredAt, speed: rig.data.airspeed }));
  record('0 %: both brakes held fully down stall the wing', stalled ? 'stalled' : 'flying', 'stalled', { compare: stalled, note: `peak sink ${stallSink.toFixed(1)} m/s` });
  record('0 %: released, it surges and flies again', recovered ? 'flying' : 'stalled', 'flying', { compare: recovered && rig.data.airspeed > 8 });
}

/** A steady turn with one set of inputs from trim: settle, then the heading rate (deg/s) and the bank. */
function steadyTurn(assists, inputs, settle = 4, seconds = 6) {
  const rig = createRig({ assists });
  rig.airborne({});
  rig.run(10);
  Object.assign(rig.pilot, inputs);
  rig.run(settle);
  let bank = 0;
  const rate = measureTurn(rig, seconds, (current) => { bank = Math.max(bank, Math.abs(current.data.bank / DEG)); });
  return { rate, bank };
}

function turnTest() {
  const half = steadyTurn(0, { brakeR: 0.5 });
  const spin = steadyTurn(0, { brakeR: 1 });
  const protectedTurn = steadyTurn(1, { brakeR: 1 });
  const shift = steadyTurn(0, { roll: -1 });
  const coordinated = steadyTurn(1, { roll: 1 });
  log('turn', JSON.stringify({ half, spin, protectedTurn, shift, coordinated }));
  record('right brake half down: turn rate (right)', half.rate, targets.halfBrakeTurn, { unit: 'deg/s', tolerance: 0.4 });
  record('0 %: right brake held fully down spins the wing', spin.rate, 60, { unit: 'deg/s', compare: 'min' });
  record('100 %: the same brake turns hard but never spins', Math.abs(protectedTurn.rate), 60, { unit: 'deg/s', compare: 'max', note: `peak bank ${protectedTurn.bank.toFixed(0)} deg` });
  record('full weight shift left alone: turn rate (left)', -shift.rate, targets.weightShiftTurn, { unit: 'deg/s', tolerance: 0.45 });
  record('100 %: weight shift with turn coordination turns faster', coordinated.rate, Math.abs(shift.rate) * 1.3, { unit: 'deg/s', compare: 'min' });
}

function earsTest(trim) {
  const ears = steadyGlide((pilot) => pilot, { settle: 0, seconds: 0 });
  ears.rig.craftState.bigEars = true;
  ears.rig.run(15);
  const result = measureGlide(ears.rig, 20);
  log('ears', JSON.stringify({ speed: result.speed, sink: result.sink, fold: ears.rig.craftState.earsFold }));
  record('big ears: sink', result.sink, targets.bigEarsSink, { unit: 'm/s', decimals: 2, tolerance: 0.25 });
  record('big ears: sink at least twice the trim sink', result.sink, trim.sink * 2, { unit: 'm/s', compare: 'min', decimals: 2 });
  record('big ears: airspeed near trim', result.speed * KMH, trim.speed * KMH, { unit: 'km/h', tolerance: 0.15 });
  ears.rig.craftState.bigEars = false;
  ears.rig.run(6);
  record('big ears released: the tips reopen', ears.rig.craftState.earsFold, 0.01, { compare: 'max', decimals: 2 });
}

function pendulumTest() {
  const rig = createRig({ assists: 0 });
  rig.airborne({});
  rig.run(15);
  const baseline = rig.data.pendulum / DEG;
  rig.pilot.brakeL = 0.8;
  rig.pilot.brakeR = 0.8;
  rig.run(2.5);
  rig.pilot.brakeL = 0;
  rig.pilot.brakeR = 0;
  // The swings ahead of the pilot after the release: each peak above the baseline.
  const series = [];
  rig.run(30, (current) => { series.push(current.data.pendulum / DEG - baseline); });
  const peaks = [];
  for (let index = 1; index < series.length - 1; index++) {
    if (series[index] > series[index - 1] && series[index] >= series[index + 1] && series[index] > 0.3) peaks.push(series[index]);
  }
  const [first = 0, second = 0, third = 0] = peaks;
  log('pendulum', JSON.stringify({ baseline, peaks: peaks.slice(0, 4) }));
  record('brakes released: the canopy surges ahead of the pilot', first, 8, { unit: 'deg', compare: 'min' });
  record('the next swing is under 40 % of the surge', second, first * 0.4, { unit: 'deg', compare: 'max' });
  record('the one after under 15 %', third, first * 0.15, { unit: 'deg', compare: 'max' });
}

function thermalTest() {
  const radius = 120;
  const field = createThermalField({ radius, strength: 4 });
  const rig = createRig({ assists: 1, field });
  rig.airborne({ x: 30, z: 0, heading: 0, altitude: 600 });
  // A scripted thermal pilot circling right around the core: it flies the tangent of a 22 m circle,
  // turning in when wide and out when tight, with weight shift and the inner brake.
  const circle = (current) => {
    const position = current.state().position;
    const distance = Math.hypot(position.x, position.z);
    const bearing = headingFromVector(position.x, position.z);
    const desired = bearing + 90 + clamp(2.5 * (distance - 22), -70, 70);
    const error = ((((desired - current.data.heading) % 360) + 540) % 360) - 180;
    current.pilot.roll = clamp(0.5 + error / 40, -1, 1);
    current.pilot.brakeR = clamp(0.3 + error / 90, 0, 0.8);
    current.pilot.brakeL = clamp(-error / 90, 0, 0.5);
  };
  rig.run(20, circle);
  const start = rig.state().position.y;
  rig.run(60, circle);
  const climb = (rig.state().position.y - start) / 60;
  log('thermal', JSON.stringify({ climb, distance: Math.hypot(rig.state().position.x, rig.state().position.z), bank: rig.data.bank / DEG }));
  record('4 m/s thermal: circling climb rate', climb, 1.5, { unit: 'm/s', compare: 'min', decimals: 2 });
  const tracked = rig.craftState.climb.active && rig.craftState.climb.gain > 50;
  // Out of the thermal on a straight glide: the climb ends and the journal hears its numbers.
  rig.pilot.roll = 0;
  rig.pilot.brakeL = 0;
  rig.pilot.brakeR = 0;
  rig.run(40);
  const gain = rig.events.stats.find((stat) => stat.key === 'paragliderBestGain');
  const best = rig.events.stats.find((stat) => stat.key === 'paragliderBestClimb');
  record('the climb is tracked while circling (craftState.climb)', tracked ? 'tracking' : 'not tracking', 'tracking', { compare: tracked });
  record('leaving it: the journal hears the height gain and best climb', gain && best ? `${gain.value} m, ${best.value} m/s` : 'nothing', 'both', { compare: Boolean(gain && best && gain.value > 50 && best.value > 1) });
}

function collapseRun(assists, seconds = 60) {
  const rig = createRig({ assists, turbulence: 1 });
  rig.airborne({ altitude: 2500 });
  rig.pilot.throttle = 1;
  let collapsedSeconds = 0;
  rig.run(seconds, (current) => {
    if (Math.max(current.craftState.collapse.left, current.craftState.collapse.right) > 0.05) collapsedSeconds += DT;
  });
  const count = rig.craftState.collapses;
  const peak = rig.collapseSeen;
  // Calm air, hands off: every collapse reopens on its own.
  rig.env.wind.turbulence = 0;
  rig.pilot.throttle = 0;
  let reopenedAt = null;
  const turbulenceRig = rig;
  turbulenceRig.run(15, (current) => {
    current.env.wind.turbulence = 0;
    if (reopenedAt === null && current.craftState.collapse.left <= 0 && current.craftState.collapse.right <= 0) reopenedAt = current.time;
  });
  return { count, peak, collapsedSeconds, reopened: reopenedAt !== null, rig };
}

function collapseTest() {
  const raw = collapseRun(0);
  const assisted = collapseRun(0.5);
  const full = collapseRun(1);
  log('collapse', JSON.stringify({ raw: { count: raw.count, peak: raw.peak, seconds: raw.collapsedSeconds }, assisted: { count: assisted.count, seconds: assisted.collapsedSeconds }, full: { count: full.count, peak: full.peak } }));
  record('0 %: strong turbulence on full bar collapses the wing', raw.count, 1, { compare: 'min', decimals: 0, note: `peak ${raw.peak.toFixed(2)}, ${raw.collapsedSeconds.toFixed(1)} s collapsed` });
  record('0 %: collapses reopen on their own in calm air', raw.reopened ? 'reopened' : 'still collapsed', 'reopened', { compare: raw.reopened });
  const rawShare = raw.count > 0 ? raw.collapsedSeconds / raw.count : 0;
  const assistedShare = assisted.count > 0 ? assisted.collapsedSeconds / assisted.count : 0;
  record('50 %: auto recovery reopens collapses faster', assistedShare, rawShare * 0.75, { unit: 's per collapse', compare: 'max', decimals: 2 });
  record('100 %: active piloting prevents collapses', full.count, 0, { compare: 'max', decimals: 0, note: `deepest ${full.peak.toFixed(3)}` });
}

function landingTest() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 40 });
  rig.run(60, (current) => current.data.phase === 'landed' && current.craftState.inflation < 0.05);
  rig.run(3);
  const landed = rig.events.landed[0];
  const contact = rig.model.contact;
  log('landing', JSON.stringify({ landed, phase: rig.data.phase, inflation: rig.craftState.inflation, offset: rig.craftState.canopyOffset }));
  record('glide into flat ground: a graded landing', landed ? landed.grade : 'none', 'graded', { compare: Boolean(landed) && landed.sinkRate <= paraglider.limits.crashSinkRate, note: landed ? `${landed.sinkRate} m/s` : '' });
  record('landed: the wing is killed and lies down', rig.craftState.inflation, 0.05, { compare: 'max', decimals: 2 });
  record('landed: the pilot stands on the feet', contact.onGround && !contact.bodyStrike ? 'standing' : 'not', 'standing', { compare: contact.onGround && !contact.bodyStrike });
  const canopy = rig.model.canopy.position;
  record('landed: the canopy rests on the ground', canopy.y - 0, 1, { unit: 'm', compare: 'max', decimals: 2 });
}

function launchTest() {
  const world = createSlopeWorld(0.3);
  const rig = createRig({ assists: 1, world });
  rig.standing({ heading: 90 });
  rig.run(1);
  rig.model.requestLaunch();
  let airborneAt = null;
  rig.run(16, (current) => {
    if (airborneAt === null && current.data.phase === 'flight') airborneAt = current.time;
  });
  const ground = world.groundHeight(rig.state().position.x, rig.state().position.z);
  const launches = rig.events.stats.filter((stat) => stat.key === 'paragliderSlopeLaunches').length;
  log('launch', JSON.stringify({ airborneAt, phase: rig.data.phase, agl: rig.state().position.y - ground, heading: rig.data.heading, notes: rig.events.notify }));
  record('slope launch: airborne', airborneAt === null ? 'still running' : 'airborne', 'airborne', { compare: airborneAt !== null, note: airborneAt === null ? '' : `${(airborneAt - 1).toFixed(1)} s after the request` });
  record('slope launch: faces downhill (south)', Math.abs(((rig.data.heading - 180 + 540) % 360) - 180), 30, { unit: 'deg off', compare: 'max', decimals: 0 });
  record('slope launch: flying clear of the slope', rig.state().position.y - ground, 5, { unit: 'm AGL', compare: 'min' });
  record('slope launch: counted for the journal', launches, 1, { compare: launches === 1, decimals: 0 });
  const flat = createRig({ assists: 1 });
  flat.standing({});
  flat.run(1);
  flat.model.requestLaunch();
  flat.run(18);
  const refused = flat.data.phase === 'landed' && flat.events.notify.some((text) => text.startsWith('Not enough slope'));
  record('flat ground, no wind: the run stops and says why', refused ? 'stopped' : flat.data.phase, 'stopped', { compare: refused });
}

function waterTest() {
  const world = createFlatWorld(-30, 0);
  const rig = createRig({ assists: 1, world });
  rig.airborne({ altitude: 30 });
  rig.run(40, (current) => current.data.phase === 'landed' && current.time > 2);
  rig.run(1);
  const landed = rig.events.landed[0];
  log('water', JSON.stringify({ landed, phase: rig.data.phase, onWater: rig.craftState.onWater, y: rig.state().position.y }));
  record('glide into the sea: a graded landing on the water', landed ? `${landed.grade} on ${landed.surface}` : 'none', 'graded on water', { compare: Boolean(landed) && landed.surface === 'water' });
  record('afloat: the phase is landed and the craft is on the water', `${rig.data.phase}, ${rig.craftState.onWater ? 'on water' : 'dry'}`, 'landed, on water', { compare: rig.data.phase === 'landed' && rig.craftState.onWater });
  record('afloat: the pilot stays at the surface', Math.abs(rig.state().position.y), 1.2, { unit: 'm', compare: 'max', decimals: 2 });
}

function finiteRig(rig) {
  const { position, velocity, quaternion, angularVelocity } = rig.state();
  const canopy = rig.model.canopy;
  return [position.x, position.y, position.z, velocity.x, velocity.y, velocity.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, angularVelocity.x, angularVelocity.y, angularVelocity.z, canopy.position.x, canopy.position.y, canopy.velocity.x, rig.data.aoa, rig.data.airspeed, rig.data.pendulum].every(Number.isFinite);
}

function robustTest() {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let finite = true;
  let ticks = 0;
  for (const assists of [0, 1]) {
    const rig = createRig({ assists, turbulence: 0.8 });
    rig.airborne({ altitude: 4000 });
    rig.run(120, (current) => {
      if (Math.round(current.time / DT) % 90 === 0) {
        current.pilot.roll = random() * 2 - 1;
        current.pilot.pitch = random() * 2 - 1;
        current.pilot.yaw = random() * 2 - 1;
        current.pilot.brakeL = random() < 0.3 ? random() : 0;
        current.pilot.brakeR = random() < 0.3 ? random() : 0;
        current.pilot.throttle = random() < 0.4 ? random() : 0;
        current.craftState.bigEars = random() < 0.2;
      }
      ticks++;
      if (!finiteRig(current)) finite = false;
    });
  }
  record('random inputs in turbulence (0 % and 100 %): every value finite', finite ? 'finite' : 'non-finite', 'finite', { compare: finite, note: `${ticks} ticks` });
}

/**
 * Allocation in the model's own module (src/flight/SimParaglider.js: the model, its assists and its
 * autopilot), sampled by V8's heap profiler including collected objects over two minutes of circling in
 * a thermal with turbulence at 100 % assists. A per-tick allocation is at least one heap number (16
 * bytes): the doubles handed to the shared ground contact and to the terrain query (every fourth tick in
 * the air) are boxed as they cross into those modules, and V8 may box a few more where it declines to
 * inline; four heap numbers a tick is the bound, and no objects. The shared modules' own allocations
 * (the ground contact, the landing monitor, the assist stage) are not counted.
 */
async function allocationTest() {
  const field = createThermalField({ radius: 150, strength: 3 });
  const rig = createRig({ assists: 1, field, turbulence: 0.4 });
  rig.airborne({ altitude: 3000 });
  rig.pilot.roll = 0.3;
  rig.run(60);
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const seconds = 120;
  rig.run(seconds);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const sites = new Map();
  const visit = (node) => {
    const url = node.callFrame.url || '';
    if (url.includes('SimParaglider.js') && node.selfSize > 0) {
      bytes += node.selfSize;
      const site = `${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber + 1}`;
      sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
    }
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  const perTick = bytes / (seconds / DT);
  const note = [...sites.entries()].map(([site, size]) => `${site} ${(size / (seconds / DT)).toFixed(1)}`).join(', ');
  record('the model allocates no objects, at most four boxed numbers per tick', perTick, 64, { unit: 'B/tick', compare: 'max', decimals: 1, note: note || 'nothing sampled' });
}

// ============================================================================================
// REPORT
// ============================================================================================
function printTable() {
  const columns = [
    { key: 'test', title: 'test' },
    { key: 'measured', title: 'measured' },
    { key: 'target', title: 'target' },
    { key: 'status', title: 'result' },
    { key: 'note', title: 'notes' },
  ];
  const rows = results.map((row) => ({ ...row, status: row.pass ? 'PASS' : 'FAIL' }));
  const widths = columns.map((column) => Math.max(column.title.length, ...rows.map((row) => String(row[column.key]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join(' | ');
  process.stdout.write(`${line(columns.map((column) => column.title))}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('-|-')}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map((column) => row[column.key]))}\n`);
  const failed = rows.filter((row) => !row.pass).length;
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} paraglider checks within target (sea-level standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
const trim = trimTest();
barTest(trim);
brakesTest(trim);
stallTest();
turnTest();
earsTest(trim);
pendulumTest();
thermalTest();
collapseTest();
landingTest();
launchTest();
waterTest();
robustTest();
await allocationTest();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
