// Hot air balloon flight lab: flies SimBalloon headless (node, no renderer) with scripted controls
// through the same control stages the game runs every physics tick (the autopilot and the balloon
// assists) and prints its measured behaviour against the spec (Milestone E, HOT AIR BALLOON).
//
// The air is the shared density model (airDensity, rho 1.225 kg/m^3 at sea level) with the ISA
// temperature profile, still unless a test adds wind, over flat ground at sea level (a slope or a
// sea for the terrain and water tests). Physics runs at the game's fixed 120 Hz.
//
// Tests:
//   buoyancy     the model's net lift equals (rho_ambient - rho_hot) x V x g - m g for envelope
//                temperatures and heights (rho_hot = rho x T_ambient / T); the envelope volume from
//                the v1 profile; an airborne reset floats at the equilibrium temperature
//   equilibrium  the sea-level equilibrium temperature and the burner duty that holds the height (the
//                height drifts less than 8 m in 90 s: a balloon is neutrally stable); the float
//                ceiling below the red line
//   lag          a 6 s full burn from level flight: 63 % of the climb it starts is reached 20-30 s
//                after the burn begins (the thermal lag), and the climb has hardly begun 4 s in
//   vent         the parachute vent cools the envelope several times faster than the fabric alone
//   rotation     a held rotation vent turns the basket 90 degrees in 20-30 s; let go, the rotation
//                damping (50 %) stops it, at 0 % it keeps turning
//   drift        from still air in a 6 m/s wind: half the wind's speed within 20 s, 80 % within 70 s,
//                within 0.6 m/s of it after 150 s; an airborne reset drifts with the air from its first
//                tick
//   ceiling      continuous full burner from 3000 m: with the protection (50 %) the envelope never
//                passes the red line and the climb levels off near the float ceiling; at 0 % it does
//                pass it and the temperature flag drops
//   hold         100 %: a 25 s burn, then hands off: the altitude hold captures where the balloon can
//                stop, settles within +-8 m, overshoots that less than 40 m, and fires the burner in
//                blasts with silence between
//   autopilot    the autopilot climbs 300 m and descends 300 m (venting) to within 15 m, without a
//                big overshoot; it turns the basket to its heading with the rotation vents
//   terrain      holding over rising ground: the hold rises with the ground, the basket stays clear
//   landing      the copilot's assisted landing: a gentle touchdown (graded), then the vent collapses
//                the envelope and the basket stops in a 4 m/s wind within a minute; the journal gets
//                its stats
//   bounce       a pilot's descent at 2.5 m/s into the ground in a 5 m/s wind: the basket bounces,
//                drags and the rig leans, no soft crash (sink and strike under the craft limits);
//                the vent stops it and the emptied envelope lies down around a standing basket, with
//                no strike as it collapses
//   water        a basket touchdown on the sea floats (no penetration, floating contact)
//   hillside     0 %: drifting at 6 m/s into a steep slope, the envelope and basket brush it: no
//                strike over the craft's limit and no contact sinks in a metre (the soft crash's)
//   ground       a ground start sits in a 4 m/s breeze on its quick-release line (the basket moves
//                under 1 m); the burner lifts it off within 70 s; a lever left at 50 % (the boot default) lights nothing until the pilot
//                moves it, and does not keep the altitude hold off
//   snapshot     snapshot / restore replays the same flight to the bit
//   column       layer steering picks the band whose wind goes the asked way, none in still air
//   instruments  the envelope and wind-layer instruments draw in both themes and both unit systems
//                (a recording 2D context), with a full and an empty column
//   audio        the 'burner' family on a Web Audio stand-in: near silence when idle (the pilot
//                lights only), the roar and rumble with the burner, the whump as it lights, the vent's
//                rush, a creak at the touchdown and on a swing
//
// Usage: node tools/lab/balloon.mjs [--verbose]
// Prints a PASS / FAIL table and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import balloon, { WIND_BANDS, bestLayerToward } from '../../src/craft/balloon.js';
import { flightModels } from '../../src/flight/models.js';
import { ambientTemperature, equilibriumTemperature, floatCeiling, KELVIN } from '../../src/flight/SimBalloon.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { envelopeGeometry } from '../../src/world/balloonFamily.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { describeAssists } from '../../src/flight/assists.js';
import { DEG } from '../../src/core/util.js';
import { INSTRUMENTS } from '../../src/ui/instruments/index.js';
import { THEMES } from '../../src/ui/instruments/gaugeKit.js';
import { grouped, unitsFor } from '../../src/ui/instruments/units.js';
import { ENGINE_FAMILIES, resolveAudioProfile } from '../../src/audio/engines/index.js';

const DT = 1 / 120;
const GRAVITY = 9.81;
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

/** Ground rising to the east (+x) at `gradient` from x = start. */
function createSlopeWorld(gradient, start) {
  const height = (x) => Math.max(0, (x - start) * gradient);
  return { groundHeight: height, heightAt: height, WATER_LEVEL: -60 };
}

function createRig({ assists = 0, world = createFlatWorld(), wind = new THREE.Vector3() } = {}) {
  const craft = balloon;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], journalStat: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  bus.onTyped('journalStat', (payload) => events.journalStat.push(payload));
  const craftState = { ...craft.abilities.craftAbility.initialState(), ...craft.abilities.craftAbilityAlt.initialState() };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: wind, turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: world.WATER_LEVEL, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, env, context, events, craftState, autopilot, time: 0, held: new Set() };
  rig.tick = () => {
    craftState.burnerHeld = rig.held.has('craftAbility') || craftState.burnTimer > 0;
    craftState.ventHeld = rig.held.has('craftAbilityAlt') || craftState.ventTimer > 0;
    craftState.burnTimer = Math.max(0, craftState.burnTimer - DT);
    craftState.ventTimer = Math.max(0, craftState.ventTimer - DT);
    copyControlState(controls, pilot);
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
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
  rig.airborne = ({ altitude = 500, heading = 0, velocity = null } = {}) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading * DEG, 0, 'YXZ'));
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity: velocity ?? new THREE.Vector3(), onGround: false });
  };
  /** Standing on the ground (the basket's corners on the surface below x, z). */
  rig.grounded = (x = 0, z = 0) => {
    const surface = Math.max(world.groundHeight(x, z), world.WATER_LEVEL);
    model.reset({ position: new THREE.Vector3(x, surface - craft.simProfile.rig.basketFloorY, z), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), onGround: true });
  };
  /** The lever that exactly feeds the current losses (the perfect level-flight burner). */
  rig.levelLever = () => Math.min(1, model.flightData.heatLoss / model.flightData.burnerPower);
  rig.state = () => model.state;
  return rig;
}

// ============================================================================================
// TESTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = 0.1, compare = 'within', note = '', decimals = 1 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else if (compare === 'range') pass = measured >= target[0] && measured <= target[1];
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  const suffix = unit ? ` ${unit}` : '';
  let targetText = String(target);
  if (compare === 'within') targetText = `${format(target)}${suffix} +/-${Math.round(tolerance * 100)}%`;
  else if (compare === 'max') targetText = `<= ${format(target)}${suffix}`;
  else if (compare === 'min') targetText = `>= ${format(target)}${suffix}`;
  else if (compare === 'range') targetText = `${format(target[0])}-${format(target[1])}${suffix}`;
  results.push({ test, measured: `${format(measured)}${suffix}`, target: targetText, pass, note });
}

function buoyancyTest() {
  const geometry = envelopeGeometry(balloon.simProfile.envelope.height);
  record('envelope volume (v1 profile, 17.5 m)', geometry.volume, 2850, { unit: 'm^3', tolerance: 0.05, decimals: 0 });
  let worst = 0;
  for (const altitude of [0, 1500, 4000]) {
    for (const temperature of [60, 90, 115]) {
      const rig = createRig();
      rig.airborne({ altitude });
      rig.craftState.envelopeTemperature = temperature;
      rig.tick();
      const rho = airDensity(rig.state().position.y);
      const ambient = ambientTemperature(rig.state().position.y);
      const hot = (rho * ambient) / (rig.craftState.envelopeTemperature + KELVIN);
      const expected = (rho - hot) * geometry.volume - balloon.simProfile.mass;
      worst = Math.max(worst, Math.abs(rig.craftState.lift - expected));
      log(`lift at ${altitude} m, ${temperature} C: ${rig.craftState.lift.toFixed(2)} kg, formula ${expected.toFixed(2)} kg`);
    }
  }
  record('net lift = (rho - rho_hot) V g - m g', worst, 0.5, { unit: 'kg worst', compare: 'max', decimals: 3 });
  const rig = createRig();
  rig.airborne({ altitude: 800 });
  rig.tick();
  record('airborne reset floats (net lift)', Math.abs(rig.craftState.lift), 1, { unit: 'kg', compare: 'max', decimals: 2 });
}

function equilibriumTest() {
  const targets = balloon.simProfile.targets;
  const geometry = envelopeGeometry(balloon.simProfile.envelope.height);
  const seaLevel = equilibriumTemperature(airDensity(0), ambientTemperature(0), geometry.volume, balloon.simProfile.mass) - KELVIN;
  record('equilibrium temperature at sea level', seaLevel, targets.equilibriumSeaLevel, { unit: 'C', tolerance: 0.04 });
  const rig = createRig();
  rig.airborne({ altitude: 0 + 20 });
  rig.tick();
  const start = rig.state().position.y;
  let dutySum = 0;
  let samples = 0;
  rig.run(90, (current) => {
    current.pilot.throttle = current.levelLever();
    dutySum += current.pilot.throttle;
    samples++;
  });
  record('burner duty holding the height (sea level)', dutySum / samples, targets.hoverBurnerDuty, { tolerance: 0.25, decimals: 3 });
  record('the level-flight burner holds the height', Math.abs(rig.state().position.y - start), 8, { unit: 'm', compare: 'max', note: '90 s: neutrally stable' });
  record('float ceiling below the red line', floatCeiling(balloon.simProfile), targets.floatCeiling, { unit: 'm', compare: 'range', decimals: 0 });
}

function lagTest() {
  const rig = createRig();
  rig.airborne({ altitude: 600 });
  rig.run(2, (current) => { current.pilot.throttle = current.levelLever(); });
  const level = rig.levelLever();
  const series = [];
  const begin = rig.time;
  rig.run(6, (current) => { current.pilot.throttle = 1; });
  rig.run(110, (current) => {
    current.pilot.throttle = level;
    series.push([current.time - begin, current.state().velocity.y]);
  });
  const peak = series.reduce((best, sample) => (sample[1] > best[1] ? sample : best));
  const reached = series.find((sample) => sample[1] >= 0.63 * peak[1]);
  const early = series.find((sample) => sample[0] >= 4);
  log(`lag: peak ${peak[1].toFixed(2)} m/s at ${peak[0].toFixed(1)} s, 63 % at ${reached[0].toFixed(1)} s`);
  record('thermal lag: a 6 s burn to 63 % of its climb', reached[0], balloon.simProfile.targets.thermalLag, { unit: 's', compare: 'range', note: `peak ${peak[1].toFixed(2)} m/s at ${peak[0].toFixed(0)} s` });
  record('4 s into the burn the climb has hardly begun', early[1], 0.15 * peak[1], { unit: 'm/s', compare: 'max', decimals: 2 });
}

function ventTest() {
  const natural = createRig();
  natural.airborne({ altitude: 600 });
  const startNatural = natural.craftState.envelopeTemperature;
  natural.run(10);
  const cooling = startNatural - natural.craftState.envelopeTemperature;
  const vented = createRig();
  vented.airborne({ altitude: 600 });
  const startVented = vented.craftState.envelopeTemperature;
  vented.held.add('craftAbilityAlt');
  vented.run(10);
  const venting = startVented - vented.craftState.envelopeTemperature;
  record('10 s of vent cools the envelope (vs the fabric alone)', venting / Math.max(cooling, 1e-6), 3, { unit: 'x', compare: 'min', note: `${venting.toFixed(2)} K vs ${cooling.toFixed(2)} K` });
  record('the vent opens (craftState.vent)', vented.craftState.vent, 0.99, { compare: 'min', decimals: 2 });
}

function rotationTest() {
  const rig = createRig();
  rig.airborne({ altitude: 600, heading: 0 });
  let quarter = null;
  rig.run(40, (current) => {
    current.pilot.roll = 1;
    const heading = current.data.heading;
    if (quarter === null && heading >= 90 && heading < 180) quarter = current.time;
  });
  record('held rotation vent: 90 degrees', quarter ?? Infinity, balloon.simProfile.targets.rotationQuarter, { unit: 's', compare: 'range', note: `rate ${rig.data.yawRate.toFixed(1)} deg/s` });
  const damped = createRig({ assists: 0.5 });
  damped.airborne({ altitude: 600 });
  damped.run(20, (current) => { current.pilot.roll = 1; });
  damped.run(25, (current) => { current.pilot.roll = 0; });
  record('let go at 50 %: the rotation damping stops it', Math.abs(damped.data.yawRate), 0.5, { unit: 'deg/s', compare: 'max', decimals: 2 });
  const raw = createRig({ assists: 0 });
  raw.airborne({ altitude: 600 });
  raw.run(20, (current) => { current.pilot.roll = 1; });
  raw.run(10, (current) => { current.pilot.roll = 0; });
  record('let go at 0 %: it keeps turning', Math.abs(raw.data.yawRate), 1.5, { unit: 'deg/s', compare: 'min', decimals: 2 });
}

function driftTest() {
  const wind = new THREE.Vector3(6, 0, 0);
  const rig = createRig({ wind });
  rig.airborne({ altitude: 600 });
  rig.tick();
  record('an airborne reset drifts with the air at once', Math.abs(rig.state().velocity.x - wind.x), 0.1, { unit: 'm/s', compare: 'max', decimals: 3 });
  rig.state().velocity.set(0, rig.state().velocity.y, 0);
  let half = null;
  let most = null;
  rig.run(150, (current) => {
    current.pilot.throttle = current.levelLever();
    const speed = current.state().velocity.x;
    if (half === null && speed >= 3) half = current.time;
    if (most === null && speed >= 4.8) most = current.time;
  });
  const start = 2 * DT;
  record('from still air: half the wind speed', (half ?? Infinity) - start, 20, { unit: 's', compare: 'max' });
  record('from still air: 80 % of the wind speed', (most ?? Infinity) - start, 70, { unit: 's', compare: 'max' });
  record('after 150 s it moves with the wind', Math.abs(rig.state().velocity.x - wind.x), 0.6, { unit: 'm/s', compare: 'max', decimals: 2 });
}

function ceilingTest() {
  const ceiling = floatCeiling(balloon.simProfile);
  const protectedRig = createRig({ assists: 0.5 });
  protectedRig.airborne({ altitude: 3000 });
  let hottest = -Infinity;
  protectedRig.run(1500, (current) => {
    current.held.add('craftAbility');
    hottest = Math.max(hottest, current.craftState.envelopeTemperature);
  });
  record('50 %: the envelope never passes the red line', hottest, balloon.simProfile.envelope.redLine, { unit: 'C', compare: 'max' });
  record('50 %: the climb levels off near the float ceiling', Math.abs(protectedRig.state().position.y - ceiling), 600, { unit: 'm', compare: 'max', decimals: 0, note: `at ${protectedRig.state().position.y.toFixed(0)} m, ceiling ${ceiling.toFixed(0)} m, ${protectedRig.state().velocity.y.toFixed(2)} m/s` });
  const raw = createRig({ assists: 0 });
  raw.airborne({ altitude: 3000 });
  raw.run(240, (current) => { current.held.add('craftAbility'); });
  record('0 %: a long burn passes the red line (temperature flag)', raw.craftState.tempFlag === true ? 1 : 0, 1, { compare: raw.craftState.tempFlag === true, note: `${raw.craftState.envelopeTemperature.toFixed(0)} C` });
}

function holdTest() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500 });
  rig.run(25, (current) => { current.held.add('craftAbility'); });
  rig.held.clear();
  let captured = null;
  let highest = -Infinity;
  let blasts = 0;
  let lit = false;
  let litTicks = 0;
  let ticks = 0;
  rig.run(240, (current) => {
    if (captured === null && Number.isFinite(current.craftState.altitudeHold)) captured = current.craftState.altitudeHold;
    highest = Math.max(highest, current.state().position.y);
    const burning = current.craftState.burner > 0.5;
    if (burning && !lit) blasts++;
    lit = burning;
    if (current.time > 25 + 120) {
      ticks++;
      if (burning) litTicks++;
    }
  });
  const hold = rig.craftState.altitudeHold;
  record('100 %: the hold captures on release', Number.isFinite(captured) ? 1 : 0, 1, { compare: Number.isFinite(captured), note: Number.isFinite(captured) ? `at ${captured.toFixed(0)} m` : 'no capture' });
  record('100 %: settles on the held altitude', Math.abs(rig.state().position.y - hold), 8, { unit: 'm', compare: 'max', note: `${rig.state().velocity.y.toFixed(2)} m/s` });
  record('100 %: overshoot past the captured altitude', highest - captured, 40, { unit: 'm', compare: 'max' });
  record('100 %: the auto-burner fires in blasts', blasts, 3, { compare: 'min', decimals: 0, note: `burner lit ${((100 * litTicks) / Math.max(ticks, 1)).toFixed(0)} % of the last 120 s` });
  record('100 %: quiet between blasts (burner lit share)', litTicks / Math.max(ticks, 1), 0.4, { compare: 'max', decimals: 2 });
  record('assists listed at 100 %', describeAssists(1, 'balloon').length, 3, { compare: 'min', decimals: 0, note: describeAssists(1, 'balloon').join(', ') });
}

function autopilotTest() {
  for (const change of [300, -300]) {
    const rig = createRig({ assists: 0 });
    rig.airborne({ altitude: 800, heading: 0 });
    rig.autopilot.enabled = true;
    rig.autopilot.altitude = 800 + change;
    rig.autopilot.heading = 120;
    let extreme = 800;
    let within = null;
    rig.run(420, (current) => {
      const altitude = current.state().position.y;
      extreme = change > 0 ? Math.max(extreme, altitude) : Math.min(extreme, altitude);
      if (within === null && Math.abs(altitude - current.autopilot.altitude) < 15) within = current.time;
    });
    const label = change > 0 ? 'climbs' : 'descends';
    record(`autopilot ${label} 300 m: within 15 m`, within ?? Infinity, 360, { unit: 's', compare: 'max' });
    record(`autopilot ${label} 300 m: overshoot`, Math.abs(extreme - rig.autopilot.altitude), 40, { unit: 'm', compare: 'max' });
    record(`autopilot ${label}: holds there`, Math.abs(rig.state().position.y - rig.autopilot.altitude), 10, { unit: 'm', compare: 'max' });
    if (change > 0) record('autopilot turns the basket to its heading', Math.abs(((rig.data.heading - 120 + 540) % 360) - 180), 5, { unit: 'deg', compare: 'max' });
  }
}

function terrainTest() {
  const world = createSlopeWorld(0.12, 300);
  const rig = createRig({ assists: 1, world, wind: new THREE.Vector3(8, 0, 0) });
  rig.airborne({ altitude: 120 });
  rig.run(1, (current) => { current.held.add('craftAbility'); });
  rig.held.clear();
  let lowest = Infinity;
  rig.run(240, (current) => { lowest = Math.min(lowest, current.data.radarAltitude); });
  record('hold over rising ground: the basket stays clear', lowest, 20, { unit: 'm', compare: 'min', note: `ground ${world.groundHeight(rig.state().position.x).toFixed(0)} m after ${rig.state().position.x.toFixed(0)} m of drift` });
}

function landingTest() {
  const rig = createRig({ assists: 1, wind: new THREE.Vector3(4, 0, 0) });
  rig.airborne({ altitude: 120 });
  rig.run(5);
  rig.craftState.landing = true;
  let touchdown = null;
  let stopped = null;
  rig.run(240, (current) => {
    if (touchdown === null && current.events.landed.length > 0) touchdown = current.time;
    if (touchdown !== null && stopped === null && current.data.inflation < 0.2 && current.data.groundSpeed < 0.3 && current.data.onGround) stopped = current.time;
  });
  const landed = rig.events.landed[0];
  record('assisted landing: touchdown graded', landed ? landed.sinkRate : Infinity, 1.2, { unit: 'm/s', compare: 'max', decimals: 2, note: landed ? landed.grade : 'no landing' });
  record('assisted landing: the vent collapses the envelope and it stops', stopped !== null && touchdown !== null ? stopped - touchdown : Infinity, 60, { unit: 's', compare: 'max', note: `inflation ${rig.data.inflation.toFixed(2)}` });
  const keys = rig.events.journalStat.map((stat) => stat.key);
  record('journal stats at the touchdown', keys.includes('balloonLandings') && keys.includes('balloonMaxAltitude') && keys.includes('balloonLongestDrift') ? 1 : 0, 1, { compare: keys.length >= 3, note: keys.join(', ') });
}

function bounceTest() {
  const rig = createRig({ assists: 0, wind: new THREE.Vector3(5, 0, 0) });
  rig.airborne({ altitude: 60 });
  const geometry = envelopeGeometry(balloon.simProfile.envelope.height);
  let firstContact = null;
  let bounced = false;
  let dragged = 0;
  let leaned = 0;
  let maxSink = 0;
  let vented = false;
  let strikeMax = 0;
  rig.run(150, (current) => {
    // Hold about 2.5 m/s down until the first contact (the envelope cooled by the vent), then let it bounce and drag.
    if (firstContact === null) {
      const sink = -current.state().velocity.y;
      if (sink < 2.5) current.held.add('craftAbilityAlt');
      else current.held.delete('craftAbilityAlt');
      maxSink = Math.max(maxSink, sink);
    } else if (current.time - firstContact > 25 && !vented) {
      vented = true;
      current.held.add('craftAbilityAlt');
    } else if (!vented) {
      current.held.delete('craftAbilityAlt');
    }
    const report = current.model.contact;
    if (report.bodyStrike) strikeMax = Math.max(strikeMax, report.bodyStrike.speed);
    if (firstContact === null && report.onGround) firstContact = current.time;
    if (firstContact !== null && !report.onGround && current.data.radarAltitude > 0.3) bounced = true;
    if (report.onGround && current.data.groundSpeed > 1) dragged += DT;
    if (report.onGround) leaned = Math.max(leaned, current.data.tilt);
  });
  const touchdowns = rig.events.landed;
  log(`bounce: first contact ${firstContact?.toFixed(1)} s, max sink ${maxSink.toFixed(2)}, drag ${dragged.toFixed(1)} s, lean ${leaned.toFixed(1)} deg, volume ${geometry.volume.toFixed(0)}`);
  record('descent into the ground at about 2.5 m/s', maxSink, [2, 3.5], { unit: 'm/s', compare: 'range', decimals: 2 });
  record('the basket bounces', bounced ? 1 : 0, 1, { compare: bounced });
  record('the basket drags in the wind', dragged, 2, { unit: 's', compare: 'min' });
  record('the rig leans while dragging', leaned, 5, { unit: 'deg', compare: 'min' });
  const strike = rig.model.contact.bodyStrike;
  record('no soft crash (sink under the limit)', touchdowns.reduce((worst, landing) => Math.max(worst, landing.sinkRate), 0), balloon.limits.crashSinkRate, { unit: 'm/s', compare: 'max', decimals: 2, note: strike ? `strike ${strike.speed.toFixed(1)} m/s` : 'no strike' });
  record('the vent stops it', rig.data.groundSpeed, 0.4, { unit: 'm/s', compare: 'max', decimals: 2, note: `inflation ${rig.data.inflation.toFixed(2)}` });
  record('the emptied envelope lies down, the basket stands', rig.data.tilt, 10, { unit: 'deg', compare: 'max', note: `${rig.events.landed.length} graded touchdowns` });
  record('nothing struck while it collapsed', strikeMax, balloon.limits.bodyStrikeSpeed, { unit: 'm/s', compare: 'max', decimals: 2 });
}

function waterTest() {
  const world = createFlatWorld(-40, 0);
  const rig = createRig({ assists: 0, world });
  rig.airborne({ altitude: 40 });
  let floating = false;
  let deepest = 0;
  rig.run(90, (current) => {
    current.held.add('craftAbilityAlt');
    const report = current.model.contact;
    if (report.floating) floating = true;
    deepest = Math.max(deepest, report.penetration);
  });
  record('basket touchdown on the sea floats', floating ? 1 : 0, 1, { compare: floating });
  record('afloat, never sinking in', deepest, 0.5, { unit: 'm', compare: 'max', decimals: 2 });
}

function hillsideTest() {
  const world = createSlopeWorld(0.7, 200);
  const rig = createRig({ assists: 0, world, wind: new THREE.Vector3(6, 0, 0) });
  rig.airborne({ altitude: 60 });
  let deepest = 0;
  let fastest = 0;
  let touched = false;
  rig.run(90, (current) => {
    current.pilot.throttle = current.levelLever();
    const report = current.model.contact;
    if (report.onGround) touched = true;
    deepest = Math.max(deepest, report.penetration);
    if (report.bodyStrike) fastest = Math.max(fastest, report.bodyStrike.speed);
  });
  record('drifting into a steep slope: it touches', touched ? 1 : 0, 1, { compare: touched });
  record('drifting into a steep slope: no contact sinks 1 m', deepest, 0.9, { unit: 'm', compare: 'max', decimals: 2 });
  record('drifting into a steep slope: no strike over the limit', fastest, balloon.limits.bodyStrikeSpeed, { unit: 'm/s', compare: 'max', decimals: 2 });
}

function groundTest() {
  const rig = createRig({ assists: 1, wind: new THREE.Vector3(4, 0, 0) });
  rig.grounded();
  rig.run(20);
  const basket = new THREE.Vector3(0, balloon.simProfile.rig.basketFloorY, 0).applyQuaternion(rig.state().quaternion).add(rig.state().position);
  const slid = Math.hypot(basket.x, basket.z);
  record('a ground start sits in a 4 m/s breeze (tied down)', slid, 1, { unit: 'm in 20 s', compare: 'max', decimals: 2, note: `the envelope leans ${rig.data.tilt.toFixed(0)} deg, tethered ${rig.craftState.tethered}` });
  let liftoff = null;
  rig.run(90, (current) => {
    current.held.add('craftAbility');
    if (liftoff === null && current.data.radarAltitude > 2) liftoff = current.time - 20;
  });
  record('the burner lifts it off', liftoff ?? Infinity, 70, { unit: 's', compare: 'max' });
  const boot = createRig({ assists: 1 });
  boot.airborne({ altitude: 500 });
  boot.pilot.throttle = 0.5;
  boot.run(30);
  const holding = Number.isFinite(boot.craftState.altitudeHold);
  record('100 %: an untouched lever at 50 % leaves the hold flying', holding ? 1 : 0, 1, { compare: holding, note: holding ? `holding ${boot.craftState.altitudeHold.toFixed(0)} m` : 'no hold' });
  const raw = createRig({ assists: 0 });
  raw.airborne({ altitude: 500 });
  raw.pilot.throttle = 0.5;
  let rawLit = 0;
  raw.run(10, (current) => { rawLit = Math.max(rawLit, current.craftState.burner); });
  raw.pilot.throttle = 0.6;
  raw.run(2);
  record('0 %: untouched lever stays dark, then the moved lever burns', rawLit < 0.01 && raw.craftState.burner > 0.5 ? 1 : 0, 1, { compare: rawLit < 0.01 && raw.craftState.burner > 0.5, note: `before ${rawLit.toFixed(3)}, after ${raw.craftState.burner.toFixed(2)}` });
}

function snapshotTest() {
  const rig = createRig({ assists: 1, wind: new THREE.Vector3(3, 0, 1) });
  rig.airborne({ altitude: 400 });
  const script = (current) => {
    current.pilot.roll = Math.sin(current.time * 0.3) * 0.5;
    if (current.time > 4 && current.time < 9) current.held.add('craftAbility');
    else current.held.delete('craftAbility');
  };
  rig.run(10, script);
  const snapshot = JSON.parse(JSON.stringify(rig.model.snapshot()));
  const time = rig.time;
  const envTime = rig.env.time;
  rig.run(10, script);
  const first = rig.state().position.clone();
  const firstTemperature = rig.craftState.envelopeTemperature;
  rig.model.restore(snapshot);
  rig.time = time;
  rig.env.time = envTime;
  rig.run(10, script);
  const drift = first.distanceTo(rig.state().position);
  record('snapshot / restore replays the flight', drift + Math.abs(firstTemperature - rig.craftState.envelopeTemperature), 1e-6, { compare: 'max', decimals: 9 });
}

function columnTest() {
  const column = WIND_BANDS.map((agl, index) => {
    const toward = (index * 25) % 360;
    return { agl, altitude: agl, primed: true, speed: 3 + index * 0.5, towardDegrees: toward };
  });
  const east = bestLayerToward(column, 90);
  record('layer steering picks the band going east', east ? east.band.towardDegrees : NaN, 100, { unit: 'deg', compare: east && east.error <= 12.5, note: east ? `error ${east.error.toFixed(1)} deg` : 'none' });
  record('no layer when the air is still', bestLayerToward(column.map((band) => ({ ...band, speed: 0.2 })), 90) === null ? 1 : 0, 1, { compare: true });
}

/** A 2D context that records the text it draws (every other canvas method a gauge uses is a no-op). */
function createRecordingPen() {
  const calls = { fillText: [], total: 0 };
  const gradient = { addColorStop() {} };
  return new Proxy({ calls }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'fillText') {
        return (text) => {
          calls.fillText.push(String(text));
          calls.total++;
        };
      }
      return () => {
        calls.total++;
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

function instrumentsTest() {
  const rig = createRig({ wind: new THREE.Vector3(5, 0, -2) });
  rig.airborne({ altitude: 700 });
  rig.run(3, (current) => { current.held.add('craftAbility'); });
  const column = rig.craftState.windColumn;
  column.forEach((band, index) => {
    band.altitude = 100 + band.agl;
    band.speed = 2 + index;
    band.towardDegrees = index * 20;
    band.fromDegrees = (index * 20 + 180) % 360;
    band.primed = true;
  });
  const flight = { altitude: 700, groundSpeed: 5.4, velocity: new THREE.Vector3(5, 0, -2), autopilot: { enabled: false }, craftState: rig.craftState, radarAltitude: 680 };
  const failures = [];
  let texts = 0;
  for (const id of ['envelope', 'windColumn']) {
    for (const theme of ['panel', 'glass']) {
      for (const system of ['metric', 'aviation']) {
        for (const state of [rig.craftState, { ...rig.craftState, windColumn: [], equilibriumTemperature: null, tempFlag: true }]) {
          const pen = createRecordingPen();
          try {
            INSTRUMENTS[id].draw(pen, { flight: { ...flight, craftState: state }, craft: balloon, units: unitsFor(system) }, THEMES[theme], null);
            texts += pen.calls.fillText.length;
          } catch (error) {
            failures.push(`${id}/${theme}/${system}: ${error.message}`);
          }
        }
      }
    }
  }
  record('envelope and wind-column instruments draw', failures.length, 0, { compare: failures.length === 0, note: failures.length ? failures[0] : `${texts} labels drawn` });
  const pen = createRecordingPen();
  INSTRUMENTS.windColumn.draw(pen, { flight, craft: balloon, units: unitsFor('metric') }, THEMES.glass, null);
  const rows = WIND_BANDS.filter((agl) => pen.calls.fillText.includes(grouped(100 + agl))).length;
  record('the wind column shows every band', rows, WIND_BANDS.length, { compare: rows === WIND_BANDS.length, decimals: 0 });
}

/**
 * A minimal Web Audio graph: nodes connect, sources start and stop, and every parameter keeps its
 * automation events (set, linear ramp, exponential approach) and reads its value at the context's
 * current time, as an AudioParam does.
 */
function createAudioStandIn() {
  const context = { currentTime: 0 };
  const createParam = (initial) => {
    const events = [];
    let base = initial;
    const valueAt = (now) => {
      let value = base;
      let previousTime = 0;
      for (const event of events) {
        if (event.time > now) {
          if (event.kind === 'ramp') value += (event.value - value) * ((now - previousTime) / Math.max(event.time - previousTime, 1e-9));
          break;
        }
        if (event.kind === 'target') {
          const next = events[events.indexOf(event) + 1];
          const until = next && next.time <= now ? next.time : now;
          value = event.value + (value - event.value) * Math.exp(-(until - event.time) / event.constant);
        } else {
          value = event.value;
        }
        previousTime = event.time;
      }
      return value;
    };
    const add = (event) => {
      events.push(event);
      events.sort((first, second) => first.time - second.time);
    };
    return {
      get value() { return valueAt(context.currentTime); },
      set value(next) { base = next; events.length = 0; },
      setTargetAtTime(value, time, constant) { add({ kind: 'target', value, time, constant }); },
      setValueAtTime(value, time) { add({ kind: 'set', value, time }); },
      linearRampToValueAtTime(value, time) { add({ kind: 'ramp', value, time }); },
      cancelAndHoldAtTime(time) {
        const held = valueAt(time);
        for (let index = events.length - 1; index >= 0; index--) if (events[index].time >= time) events.splice(index, 1);
        add({ kind: 'set', value: held, time });
      },
      cancelScheduledValues(time) {
        for (let index = events.length - 1; index >= 0; index--) if (events[index].time >= time) events.splice(index, 1);
      },
    };
  };
  const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });
  Object.assign(context, {
    createGain: () => node({ gain: createParam(1) }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: createParam(350), Q: createParam(1), gain: createParam(0) }),
    createOscillator: () => node({ type: 'sine', frequency: createParam(440), start() {}, stop() {}, setPeriodicWave() {} }),
    createBufferSource: () => node({ buffer: null, loop: false, playbackRate: createParam(1), start() {}, stop() {} }),
    createPeriodicWave: () => ({}),
  });
  return { context, noise: { duration: 2 }, destination: node() };
}

function audioTest() {
  const profile = resolveAudioProfile(balloon.audioProfile, balloon.instruments);
  record('the balloon flies the burner family', profile.engine === 'burner' ? 1 : 0, 1, { compare: profile.engine === 'burner' && Boolean(ENGINE_FAMILIES.burner) });
  const kit = createAudioStandIn();
  const synth = ENGINE_FAMILIES.burner.create(kit, profile);
  const craftState = { burner: 0, vent: 0 };
  const flight = { craftState, angularVelocity: { x: 0, y: 0, z: 0 }, gLoad: 1, onGround: false, groundSpeed: 0 };
  const frame = { time: 0, interval: 1 / 30, flight };
  const runFrames = (count) => {
    for (let index = 0; index < count; index++) {
      frame.time += frame.interval;
      kit.context.currentTime = frame.time;
      synth.update(frame, 1);
    }
  };
  runFrames(30);
  const idle = synth.describe().layers;
  record('idle: near silence, the pilot lights only', idle.roar + idle.rumble + idle.jet + idle.vent, 0.001, { compare: 'max', decimals: 3, note: `pilot ${idle.pilot.toFixed(3)}` });
  craftState.burner = 1;
  runFrames(1);
  kit.context.currentTime += 0.04;
  record('the burner lights with a whump', synth.describe().layers.whump, 0.5, { compare: 'min', decimals: 2 });
  kit.context.currentTime -= 0.04;
  runFrames(30);
  const burning = synth.describe().layers;
  record('the roar and rumble follow the burner', Math.min(burning.roar, burning.rumble), 0.5, { compare: 'min', decimals: 2 });
  craftState.burner = 0;
  craftState.vent = 1;
  runFrames(30);
  record('the vent rushes', synth.describe().layers.vent, 0.1, { compare: 'min', decimals: 2 });
  const before = synth.describe().target.creaks;
  flight.onGround = true;
  runFrames(2);
  const touchdown = synth.describe().target.creaks;
  flight.onGround = false;
  flight.angularVelocity.x = 0.08;
  runFrames(300);
  const swinging = synth.describe().target.creaks;
  const creaked = touchdown > before && swinging > touchdown + 2;
  record('the basket creaks at the touchdown and on a swing', creaked ? 1 : 0, 1, { compare: creaked, note: `${touchdown - before} at the touchdown, ${swinging - touchdown} in 10 s of swing` });
  synth.stop(frame.time);
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} balloon checks within target (shared density model, ISA temperatures, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
buoyancyTest();
equilibriumTest();
lagTest();
ventTest();
rotationTest();
driftTest();
ceilingTest();
holdTest();
autopilotTest();
terrainTest();
landingTest();
bounceTest();
waterTest();
hillsideTest();
groundTest();
snapshotTest();
columnTest();
instrumentsTest();
audioTest();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
