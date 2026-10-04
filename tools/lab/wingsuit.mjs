// Wingsuit flight lab: flies SimWingsuit headless (node, no renderer) with scripted controls through
// the same control stages the game runs every physics tick (the autopilot and the wingsuit assists)
// and prints its measured performance against the spec numbers (Milestone E, WINGSUIT).
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3), still unless a test adds wind,
// over flat ground at sea level (a sloped world for the proximity test). Physics runs at the game's
// fixed 120 Hz.
//
// Tests:
//   glide        neutral stick, wings level: steady glide ratio and speed (about 2.5 : 1 at 180 km/h)
//   polar        the pitch range from full push to the slowest unstalled glide: the speed range
//                (150-220 km/h) and the speed-vs-glide trade (the slow end glides flatter)
//   flare        from the neutral glide, a 3 s pull: the glide over the flare beats the steady glide
//                while the speed bleeds
//   turn         full roll for 3 s, then level: the heading changes (roll to turn)
//   tumble       0 % assists: full pull and full roll -> stall and tumble; hands off -> recovered glide
//   protection   100 % assists: the same inputs stay below the stall; auto-level from a 45 deg bank
//   canopy       deploy from the glide: opening shock, then the steady descent (about 5 m/s) and the
//                forward speed (30-40 km/h); a full toggle turns it
//   landing      canopy landings: flared (the landed event grades it smooth or better) and unflared
//                (hard but no crash); the landed phase counts the pause before the auto relaunch
//   proximity    toward rising terrain: the warning at 50 %, none at 0 %; a strike at speed in the suit
//   wind         a 10 m/s headwind: the ground-referenced glide falls, the airspeed holds
//
// Usage: node tools/lab/wingsuit.mjs [--verbose]
// Prints a PASS / FAIL table and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import wingsuit from '../../src/craft/wingsuit.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { describeAssists } from '../../src/flight/assists.js';
import { DEG, clamp } from '../../src/core/util.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
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
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/** A slope rising to the north (-z): `gradient` metres per metre, from `start` metres north of the origin. */
function createSlopeWorld(gradient, start) {
  const height = (x, z) => Math.max(0, (-z - start) * gradient);
  return { groundHeight: height, heightAt: height, WATER_LEVEL };
}

function createRig({ assists = 0, world = createFlatWorld() } = {}) {
  const craft = wingsuit;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, env, context, events, craftState, time: 0, telemetry };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    controls.throttle = 0;
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    rig.time += DT;
  };
  rig.run = (seconds, script) => {
    const ticks = Math.round(seconds / DT);
    for (let tick = 0; tick < ticks; tick++) {
      if (script && script(rig) === true) return true;
      rig.tick();
    }
    return false;
  };
  /** In the air at `speed` along a path `path` degrees below the horizon, body `aoa` degrees above it. */
  rig.airborne = ({ speed = 50, path = -22, aoa = 5, heading = 0, altitude = 3000, bank = 0 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler((path + aoa) * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    const direction = new THREE.Quaternion().setFromEuler(new THREE.Euler(path * DEG, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(direction);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), onGround: false });
  };
  rig.deploy = () => {
    pilot.actions.add('chuteDeploy');
  };
  rig.state = () => model.state;
  return rig;
}

/** Wings level with the arms (or a bank target), for tests that fly straight. */
function levelWings(rig, bank = 0) {
  const data = rig.data;
  rig.pilot.roll = clamp(1.4 * (bank * DEG - data.bank) - 0.3 * data.rollRate, -1, 1);
  rig.pilot.yaw = clamp(2 * data.sideslip, -1, 1);
}

/** Glide ratio (horizontal distance over height lost, ground referenced) and mean airspeed over `seconds`. */
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
  return { glide: drop > 0 ? distance / drop : Infinity, speed: speedSum / Math.max(samples, 1), drop, distance };
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

/** A steady glide at a fixed stick: settle 25 s, measure 15 s. */
function steadyGlide(pitch) {
  const rig = createRig();
  rig.airborne({});
  rig.pilot.pitch = pitch;
  rig.run(25, levelWings);
  const result = measureGlide(rig, 15, levelWings);
  return { ...result, aoa: rig.data.aoa / DEG, stalled: rig.data.stalled, rates: rig.state().angularVelocity.length() };
}

function glideTest() {
  const targets = wingsuit.simProfile.targets;
  const neutral = steadyGlide(0);
  log('neutral', JSON.stringify(neutral));
  record('glide ratio, neutral stick', neutral.glide, targets.glideRatio, { unit: ': 1', decimals: 2 });
  record('glide speed, neutral stick', neutral.speed * KMH, targets.glideSpeed * KMH, { unit: 'km/h', decimals: 0 });
  record('steady (rates settle)', neutral.rates, 0.05, { unit: 'rad/s', compare: 'max', decimals: 3 });
}

function polarTest() {
  const targets = wingsuit.simProfile.targets;
  const points = [];
  for (const pitch of [-1, -0.75, -0.5, -0.25, 0, 0.1, 0.2, 0.3, 0.45, 0.55, 0.62]) {
    const point = steadyGlide(pitch);
    points.push({ pitch, ...point });
    log(`polar pitch ${pitch.toFixed(2)}: ${(point.speed * KMH).toFixed(0)} km/h glide ${point.glide.toFixed(2)} aoa ${point.aoa.toFixed(1)} stalled ${point.stalled}`);
  }
  const flying = points.filter((point) => !point.stalled);
  const fastest = flying.reduce((best, point) => (point.speed > best.speed ? point : best));
  const slowest = flying.reduce((best, point) => (point.speed < best.speed ? point : best));
  const band = flying.filter((point) => point.speed >= targets.speedMin && point.speed <= targets.speedMax);
  const worst = band.reduce((far, point) => (Math.abs(point.glide - targets.glideRatio) > Math.abs(far.glide - targets.glideRatio) ? point : far));
  const nearSlow = band.reduce((best, point) => (point.speed < best.speed ? point : best));
  const nearFast = band.reduce((best, point) => (point.speed > best.speed ? point : best));
  record('full push reaches the fast end', fastest.speed * KMH, targets.speedMax * KMH, { unit: 'km/h', decimals: 0, note: `glide ${fastest.glide.toFixed(2)} : 1` });
  record('pull reaches the slow end unstalled', slowest.speed * KMH, targets.speedMin * KMH, { unit: 'km/h', compare: 'max', decimals: 0, note: `glide ${slowest.glide.toFixed(2)} : 1` });
  record('glide across 150-220 km/h', worst.glide, targets.glideRatio, { unit: ': 1', decimals: 2, tolerance: 0.15, note: `${band.length} stick positions, worst at ${(worst.speed * KMH).toFixed(0)} km/h` });
  record('pitch trades glide for speed', nearSlow.glide - nearFast.glide, 0.3, { unit: ': 1', compare: 'min', decimals: 2, note: `${(nearSlow.speed * KMH).toFixed(0)} km/h ${nearSlow.glide.toFixed(2)} vs ${(nearFast.speed * KMH).toFixed(0)} km/h ${nearFast.glide.toFixed(2)}` });
}

function flareTest() {
  const rig = createRig();
  rig.airborne({});
  rig.run(25, levelWings);
  const steady = measureGlide(rig, 6, levelWings);
  const speedBefore = rig.data.airspeed;
  rig.pilot.pitch = 0.7;
  const flare = measureGlide(rig, 3, levelWings);
  const speedAfter = rig.data.airspeed;
  log(`flare: steady ${steady.glide.toFixed(2)} flare ${flare.glide.toFixed(2)} (drop ${flare.drop.toFixed(1)} m) speed ${(speedBefore * KMH).toFixed(0)} -> ${(speedAfter * KMH).toFixed(0)} km/h`);
  record('flare glide (3 s pull)', flare.glide, steady.glide * 1.3, { unit: ': 1', compare: 'min', decimals: 2, note: `steady ${steady.glide.toFixed(2)} : 1` });
  record('flare bleeds speed', (speedBefore - speedAfter) * KMH, 15, { unit: 'km/h', compare: 'min', decimals: 0 });
}

function turnTest() {
  const rig = createRig();
  rig.airborne({});
  rig.run(15, levelWings);
  const heading = rig.data.heading;
  rig.pilot.roll = 1;
  let rollRate = 0;
  rig.run(1.5, (current) => {
    rollRate = Math.max(rollRate, current.data.rollRate / DEG);
    if (Math.round(current.time * 120) % 30 === 0) log(`  roll: t ${current.time.toFixed(2)} bank ${(current.data.bank / DEG).toFixed(0)} rate ${(current.data.rollRate / DEG).toFixed(0)} deg/s heading ${current.data.heading.toFixed(0)}`);
  });
  rig.run(6, (current) => {
    levelWings(current, 45);
    if (Math.round(current.time * 120) % 60 === 0) log(`  turn: t ${current.time.toFixed(2)} bank ${(current.data.bank / DEG).toFixed(0)} heading ${current.data.heading.toFixed(0)} sideslip ${(current.data.sideslip / DEG).toFixed(1)}`);
  });
  const change = Math.abs(((((rig.data.heading - heading + 180) % 360) + 360) % 360) - 180);
  log(`turn: heading change ${change.toFixed(0)} deg, bank ${(rig.data.bank / DEG).toFixed(0)}`);
  record('peak roll rate, full stick', rollRate, 60, { unit: 'deg/s', compare: 'min', decimals: 0 });
  record('roll to turn (6 s at 45 deg bank)', change, 45, { unit: 'deg', compare: 'min', decimals: 0 });
}

function tumbleTest() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 3500 });
  rig.run(15, levelWings);
  let peakRate = 0;
  let stalled = false;
  let maxAoa = -Infinity;
  rig.pilot.pitch = 1;
  rig.pilot.roll = 1;
  rig.pilot.yaw = 0;
  rig.run(5, (current) => {
    peakRate = Math.max(peakRate, current.state().angularVelocity.length());
    stalled = stalled || current.data.stalled;
    maxAoa = Math.max(maxAoa, current.data.aoa / DEG);
  });
  record('0 %: full pull and roll stalls', stalled ? 1 : 0, 1, { compare: stalled, note: `max AoA ${maxAoa.toFixed(0)} deg` });
  record('0 %: tumble (peak body rate)', peakRate, 2.5, { unit: 'rad/s', compare: 'min', decimals: 2 });
  // Hands off: the suit's stability rights the flyer; recovered = flying, unstalled, rates calm.
  rig.pilot.pitch = 0;
  rig.pilot.roll = 0;
  const altitude = rig.state().position.y;
  const releasedAt = rig.time;
  let recoveredAt = NaN;
  let calm = 0;
  rig.run(15, (current) => {
    const settled = !current.data.stalled && current.state().angularVelocity.length() < 0.6 && current.data.airspeed > 35 && Math.abs(current.data.aoa - current.data.trimAoa) < 6 * DEG;
    calm = settled ? calm + DT : 0;
    if (calm > 1 && !Number.isFinite(recoveredAt)) recoveredAt = current.time;
    return Number.isFinite(recoveredAt);
  });
  const recovered = Number.isFinite(recoveredAt);
  const lost = altitude - rig.state().position.y;
  log(`tumble: peak ${peakRate.toFixed(2)} rad/s, recovered ${recovered} ${(recoveredAt - releasedAt).toFixed(1)} s after release, lost ${lost.toFixed(0)} m`);
  record('0 %: hands-off recovery', recovered ? recoveredAt - releasedAt : Infinity, 12, { unit: 's', compare: 'max', note: `glide again, ${lost.toFixed(0)} m lost` });
}

function protectionTest() {
  const rig = createRig({ assists: 1 });
  rig.airborne({});
  rig.run(10);
  let stalled = false;
  let maxAoa = -Infinity;
  rig.pilot.pitch = 1;
  rig.pilot.roll = 1;
  rig.run(6, (current) => {
    stalled = stalled || current.data.stalled;
    maxAoa = Math.max(maxAoa, current.data.aoa / DEG);
  });
  const critical = rig.data.aoaCritical / DEG;
  record('100 %: stall protection', maxAoa, critical, { unit: 'deg', compare: 'max', note: stalled ? 'stalled' : 'never stalled' });
  record('100 %: no stall', stalled ? 0 : 1, 1, { compare: !stalled });
  // Auto-level: from a 45 degree bank, hands off.
  rig.pilot.pitch = 0;
  rig.pilot.roll = 0;
  rig.airborne({ bank: 45 });
  rig.run(6);
  record('100 %: auto-level from 45 deg', Math.abs(rig.data.bank / DEG), 5, { unit: 'deg', compare: 'max' });
  const active = describeAssists(1, 'wingsuit').join(', ');
  const half = describeAssists(0.5, 'wingsuit').join(', ');
  const none = describeAssists(0, 'wingsuit').join(', ') || 'none';
  record('assist catalog 100 %', active, 'stability, warning, auto-level, stall protection', { compare: active === 'stability, terrain proximity warning, auto-level, stall protection' });
  record('assist catalog 50 %', half, 'stability, warning', { compare: half === 'stability, terrain proximity warning' });
  record('assist catalog 0 %', none, 'raw', { compare: none === 'none' });
}

function canopyTest() {
  const targets = wingsuit.simProfile.targets;
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 2000 });
  rig.run(10);
  rig.deploy();
  let peak = 0;
  rig.run(4, (current) => {
    peak = Math.max(peak, current.data.gLoad);
  });
  record('deploy: craftState.canopy', rig.craftState.canopy ? 1 : 0, 1, { compare: rig.craftState.canopy === true && rig.craftState.phase === 'canopy' });
  record('opening shock', peak, 3.5, { unit: 'g', tolerance: 0.3, note: `openingG ${rig.craftState.openingG.toFixed(1)}` });
  rig.run(12);
  let sink = 0;
  let forward = 0;
  let samples = 0;
  rig.run(10, (current) => {
    const velocity = current.state().velocity;
    sink += -velocity.y;
    forward += Math.hypot(velocity.x, velocity.z);
    samples++;
  });
  sink /= samples;
  forward /= samples;
  log(`canopy: sink ${sink.toFixed(2)} m/s, forward ${(forward * KMH).toFixed(1)} km/h`);
  record('canopy descent rate', sink, targets.canopySink, { unit: 'm/s', decimals: 2, tolerance: 0.15 });
  record('canopy forward speed (min)', forward * KMH, targets.canopyForwardMin * KMH, { unit: 'km/h', compare: 'min' });
  record('canopy forward speed (max)', forward * KMH, targets.canopyForwardMax * KMH, { unit: 'km/h', compare: 'max' });
  // Steering: a full right toggle for 6 s.
  const heading = rig.data.heading;
  rig.pilot.roll = 1;
  let turnSink = 0;
  let turnSamples = 0;
  rig.run(6, (current) => {
    turnSink += -current.state().velocity.y;
    turnSamples++;
  });
  rig.pilot.roll = 0;
  const change = ((((rig.data.heading - heading) % 360) + 360) % 360);
  log(`canopy turn: ${change.toFixed(0)} deg in 6 s, sink ${(turnSink / turnSamples).toFixed(2)} m/s`);
  record('canopy turn, full right toggle (6 s)', change, 120, { unit: 'deg', compare: 'min', decimals: 0, note: `sink ${(turnSink / turnSamples).toFixed(1)} m/s in the turn` });
  // Pedals steer too (brake lines on the rudder pedals).
  rig.run(4);
  const pedalHeading = rig.data.heading;
  rig.pilot.yaw = -1;
  rig.run(4);
  rig.pilot.yaw = 0;
  const pedalChange = ((((pedalHeading - rig.data.heading) % 360) + 360) % 360);
  record('canopy turn, left pedal (4 s)', pedalChange, 40, { unit: 'deg', compare: 'min', decimals: 0 });
}

/**
 * Canopy landing: deploy at 600 m, fly straight in, and flare progressively from `flareAt` m (feet
 * above the ground: the stick comes back smoothly to full at `fullAt` m), or not at all (NaN).
 */
function canopyLanding(flareAt, fullAt = 0.8) {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 600 });
  rig.run(3);
  rig.deploy();
  rig.run(8);
  let touchdownSink = NaN;
  rig.run(120, (current) => {
    const feet = current.state().position.y - wingsuit.simProfile.radarOffset.canopy;
    if (Number.isFinite(flareAt) && feet < flareAt) current.pilot.pitch = Math.max(current.pilot.pitch, clamp((flareAt - feet) / (flareAt - fullAt), 0, 1));
    const report = current.model.contact;
    if (report.touchdown && !Number.isFinite(touchdownSink)) touchdownSink = report.touchdown.sinkRate;
    return current.craftState.phase === 'landed' && current.craftState.landedSeconds > 3.2;
  });
  return { rig, touchdownSink, landed: rig.events.landed[0] ?? null };
}

function landingTest() {
  for (const height of [3, 4, 5, 6, 7, 8]) {
    const trial = canopyLanding(height);
    log(`  flare at ${height} m: touchdown ${trial.touchdownSink.toFixed(2)} m/s ${trial.landed ? trial.landed.grade : 'none'}`);
  }
  const flared = canopyLanding(3.2);
  log(`flared landing: sink ${flared.touchdownSink.toFixed(2)} m/s, grade ${flared.landed ? flared.landed.grade : 'none'}`);
  const goodGrade = Boolean(flared.landed) && (flared.landed.grade === 'butter' || flared.landed.grade === 'smooth');
  record('flared canopy landing: sink rate', flared.touchdownSink, 1.2, { unit: 'm/s', compare: 'max', decimals: 2 });
  record('flared canopy landing: grade', flared.landed ? flared.landed.grade : 'none', 'smooth or butter', { compare: goodGrade });
  record('landed phase (auto relaunch pause)', flared.rig.craftState.landedSeconds, 3, { unit: 's', compare: 'min', decimals: 1, note: `phase ${flared.rig.craftState.phase}` });
  const unflared = canopyLanding(NaN);
  const crashLimit = wingsuit.limits.crashSinkRate;
  log(`unflared landing: sink ${unflared.touchdownSink.toFixed(2)} m/s, grade ${unflared.landed ? unflared.landed.grade : 'none'}`);
  record('unflared canopy landing: sink rate', unflared.touchdownSink, crashLimit, { unit: 'm/s', compare: 'max', decimals: 2, note: 'below the crash limit' });
  record('unflared canopy landing: grade', unflared.landed ? unflared.landed.grade : 'none', 'graded (firm or hard)', { compare: Boolean(unflared.landed) && (unflared.landed.grade === 'hard' || unflared.landed.grade === 'firm') });
}

function proximityTest() {
  for (const assists of [0.5, 0]) {
    // Flying north into a 30 % slope that starts 900 m ahead, 250 m up: the path meets it.
    const rig = createRig({ assists, world: createSlopeWorld(0.9, 600) });
    rig.airborne({ altitude: 320 });
    let warned = false;
    let warnedImpact = Infinity;
    rig.run(20, (current) => {
      levelWings(current);
      if (current.craftState.proximityWarning === true && !warned) {
        warned = true;
        warnedImpact = current.craftState.impactSeconds;
      }
      return current.model.contact.bodyStrike !== null;
    });
    const strike = rig.model.contact.bodyStrike;
    if (assists > 0) {
      record('50 %: terrain proximity warning', warned ? 1 : 0, 1, { compare: warned, note: Number.isFinite(warnedImpact) ? `${warnedImpact.toFixed(1)} s before impact` : '' });
      record('suit strikes the terrain at speed', strike ? strike.speed : 0, wingsuit.limits.bodyStrikeSpeed, { unit: 'm/s', compare: 'min', note: strike ? `${strike.part}` : 'no strike' });
    } else {
      record('0 %: no warning (raw)', warned ? 1 : 0, 0, { compare: !warned });
    }
  }
}

function windTest() {
  const still = steadyGlide(0);
  const rig = createRig();
  rig.env.wind.vel.set(0, 0, 10);
  rig.airborne({});
  rig.run(25, levelWings);
  const windy = measureGlide(rig, 15, levelWings);
  log(`wind: still ${still.glide.toFixed(2)} headwind ${windy.glide.toFixed(2)}`);
  record('10 m/s headwind: ground glide falls', windy.glide, still.glide * 0.9, { unit: ': 1', compare: 'max', decimals: 2, note: `still ${still.glide.toFixed(2)} : 1` });
  record('10 m/s headwind: airspeed holds', windy.speed * KMH, still.speed * KMH, { unit: 'km/h', decimals: 0 });
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} wingsuit checks within target (sea-level standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
glideTest();
polarTest();
flareTest();
turnTest();
tumbleTest();
protectionTest();
canopyTest();
landingTest();
proximityTest();
windTest();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
