// Helicopter flight lab: flies SimHelicopter headless (node, no renderer) through the same control
// stages the game runs every physics tick (the helicopter autopilot and assists), and prints the
// measured performance against the spec.
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3) over flat ground at sea level, with
// no wind unless a test sets it. Physics runs at the game's fixed 120 Hz.
//
// Tests:
//   hover         100 % assists hands off: out-of-ground-effect hover collective and torque
//   climb         full collective: vertical climb rate; best climb at 30 m/s; rotor rpm droop
//   ETL           power required in level flight from the hover to 20 m/s: translational lift onset
//   groundEffect  hover collective in ground effect (skids 1 m up) vs out of it; none past one diameter
//   torque        0 % assists, hands off: the torque yaws the nose right; the pedal holds it
//   VRS           vertical descent at 0.75 of the hover induced velocity, then full collective: the
//                 descent is not arrested (settling with power); forward cyclic flies it out
//   autorotation  engine off at 28 m/s: rotor rpm sustained by the upflow, steady descent rate; the
//                 flare and cushion (100 % assists) land softly on the skids; 0 % with the collective
//                 left up the rotor decays (low rpm horn)
//   Vne           retreating blade stall and its nose-up / roll-left tendency near Vne, none at 80 %
//   autoHover     100 % assists hands off for 60 s: drift in calm air and in a 9 m/s turbulent wind
//   landing       100 % assists: lever down from a 20 m hover -> graded touchdown, 10 s at rest on skids
//   pickup        respawn with the lever at full: the collective holds until the lever moves
//   strike        rotor strike on a steep bank near the ground; tail strike
//   engine        engine off on the ground and restart; rotor spins down and back up
//   autopilot     heading / altitude / speed hold; hands-off hold hovers
//
// Usage: node tools/lab/helicopter.mjs [--verbose]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import helicopter from '../../src/craft/helicopter.js';
import { flightModels } from '../../src/flight/models.js';
import { describeAssists } from '../../src/flight/assists.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { groundPose } from '../../src/flight/placement.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp } from '../../src/core/util.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
const KMH = 3.6;
const OPTIONS = { verbose: process.argv.includes('--verbose') };
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

function log(...parts) {
  if (OPTIONS.verbose) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/**
 * One helicopter in the lab: the model, the pilot's ControlState (what the scripted pilot writes;
 * the throttle axis is the collective, as the input profile maps it), the tick copy the control
 * stages shape, the environment. override(controls, rig) runs after the stages (a scripted pilot's
 * direct inputs).
 */
function createRig({ assists = 0, ground = 0 } = {}) {
  const craft = helicopter;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const world = createFlatWorld(ground);
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0.5;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, autopilot, env, context, events, telemetry, craftState, world, time: 0, override: null };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    if (craft.inputProfile.throttle === 'collective') controls.collective = controls.throttle;
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    if (rig.override) rig.override(controls, rig);
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
  rig.setAssists = (level) => {
    env.assists = level;
    context.assists = level;
    telemetry.assists = level;
  };
  /** Airborne at `altitude` m, heading, forward speed, the lever at `lever` (a hover spawn is 0.5). */
  rig.airborne = ({ altitude = 600, heading = 0, speed = 0, lever = 0.5, engineOn = true } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle: lever, onGround: false, engineOn });
    pilot.throttle = lever;
  };
  /** At rest on the skids on the flat ground. */
  rig.parked = ({ heading = 0, lever = 0 } = {}) => {
    const profile = craft.simProfile;
    const pose = groundPose(world, profile.contacts, 0, 0, heading, profile.centerOfMass[2]);
    model.reset({ position: pose.position, quaternion: pose.quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = lever;
  };
  rig.position = () => model.state.position;
  return rig;
}

/** A PID with a clamped, anti-windup integrator. */
function createPid(kp, ki, kd, min = -1, max = 1) {
  let integral = 0;
  return {
    reset(value = 0) {
      integral = value;
    },
    update(error, dt, rate = 0) {
      const output = integral + kp * error - kd * rate;
      if ((output < max || error < 0) && (output > min || error > 0)) integral = clamp(integral + ki * error * dt, min, max);
      return clamp(integral + kp * error - kd * rate, min, max);
    },
  };
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = 0.1, compare = 'within', note = '', decimals = 2 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else if (compare === 'range') pass = measured >= target[0] && measured <= target[1];
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  const suffix = unit ? ` ${unit}` : '';
  let targetText;
  if (compare === 'within') targetText = `${format(target)}${suffix} +/-${Math.round(tolerance * 100)}%`;
  else if (compare === 'max') targetText = `<= ${format(target)}${suffix}`;
  else if (compare === 'min') targetText = `>= ${format(target)}${suffix}`;
  else if (compare === 'range') targetText = `${format(target[0])}..${format(target[1])}${suffix}`;
  else targetText = String(target);
  results.push({ test, measured: `${format(measured)}${suffix}`, target: targetText, pass, note });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

// ============================================================================================
// TESTS
// ============================================================================================
const targets = helicopter.simProfile.targets;
const limits = helicopter.limits;

/** Out-of-ground-effect hover at 100 % assists, hands off: the collective and torque it settles on. */
function testHover() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 600 });
  rig.run(20);
  const collective = [];
  const torque = [];
  rig.run(10, (lab) => {
    collective.push(lab.data.collective);
    torque.push(lab.data.torque);
  });
  const mass = Object.values(helicopter.simProfile.mass).reduce((sum, value) => sum + value, 0);
  record('hover OGE collective', average(collective), targets.hoverCollective, { tolerance: 0.1, note: `lever share, sea level, ${mass} kg` });
  record('hover OGE torque', average(torque) * 100, targets.hoverTorque * 100, { unit: '%', tolerance: 0.1, decimals: 1 });
  return { collective: average(collective), torque: average(torque) };
}

/** A lab pilot's collective that holds the torque at `target` (share of rated). */
function createTorquePilot(target, start) {
  const pid = createPid(0.3, 0.6, 0, 0, 1);
  pid.reset(start);
  return (controls, lab) => {
    controls.collective = pid.update(target - lab.data.torque, DT);
  };
}

/**
 * Climb at 100 % torque (the pilot's collective limit), zero airspeed with the position held by the
 * assists' cyclic, then at 30 m/s held by the autopilot. Full collective past the power available
 * droops the rotor (the low rpm horn); at 100 % assists the engine protection holds it back.
 */
function testClimb() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 300 });
  rig.run(8);
  rig.override = createTorquePilot(1, rig.data.collective);
  rig.run(14);
  const climbs = [];
  const rpm = [];
  rig.run(6, (lab) => {
    climbs.push(lab.data.verticalSpeed);
    rpm.push(lab.data.rotorRpm);
  });
  record('vertical climb at 100 % torque', average(climbs), targets.verticalClimb, { unit: 'm/s', tolerance: 0.25, note: `rotor ${(average(rpm) * 100).toFixed(1)} %, collective ${rig.data.collective.toFixed(2)}` });

  const forward = createRig({ assists: 1 });
  forward.airborne({ altitude: 300, speed: 30 });
  forward.autopilot.enabled = true;
  forward.autopilot.heading = 0;
  forward.autopilot.altitude = 300;
  forward.autopilot.speed = 30;
  forward.run(10);
  forward.override = createTorquePilot(1, forward.data.collective);
  forward.run(12);
  const forwardClimbs = [];
  const speeds = [];
  forward.run(6, (lab) => {
    forwardClimbs.push(lab.data.verticalSpeed);
    speeds.push(lab.data.airspeed);
  });
  record('best climb at 30 m/s, 100 % torque', average(forwardClimbs), targets.maxClimb, { unit: 'm/s', tolerance: 0.25, note: `at ${average(speeds).toFixed(1)} m/s airspeed` });

  // Over-pitching: full collective demands more than the engine has, the rotor droops.
  const overpitch = createRig({ assists: 0.5 });
  overpitch.airborne({ altitude: 600 });
  overpitch.run(2);
  overpitch.override = (controls) => {
    controls.collective = 1;
  };
  let hornAt = NaN;
  overpitch.run(6, (lab) => {
    lab.model.writeTelemetry(lab.telemetry);
    if (!Number.isFinite(hornAt) && lab.telemetry.stall.warning) hornAt = lab.time - 2;
  });
  record('full collective over-pitches: rotor rpm droops', overpitch.data.rotorRpm * 100, 92, { unit: '%', compare: 'max', decimals: 1, note: Number.isFinite(hornAt) ? `low rpm horn after ${hornAt.toFixed(1)} s, torque ${(overpitch.data.torque * 100).toFixed(0)} %` : 'no horn' });

  // 100 %: lever full up, the engine protection keeps the rpm and torque in their limits.
  const protectedRig = createRig({ assists: 1 });
  protectedRig.airborne({ altitude: 300 });
  protectedRig.run(3);
  protectedRig.pilot.throttle = 1;
  let minRpm = Infinity;
  let maxTorque = 0;
  protectedRig.run(15, (lab) => {
    if (lab.time > 5) {
      minRpm = Math.min(minRpm, lab.data.rotorRpm);
      maxTorque = Math.max(maxTorque, lab.data.torque);
    }
  });
  record('100 % lever full up: engine protection holds the rpm', minRpm * 100, 95, { unit: '%', compare: 'min', decimals: 1, note: `max torque ${(maxTorque * 100).toFixed(0)} %, climbing ${protectedRig.data.verticalSpeed.toFixed(1)} m/s` });
}

/**
 * A lab pilot for 0 % assists: holds a forward groundspeed (fly.forwardTarget, 0 = hover) and no
 * sideways drift with the cyclic (velocity -> attitude -> stick); with fly.holdHeading also the heading
 * with the pedals.
 */
function createHoverPilot(rig) {
  const pitchPid = createPid(2.4, 0.9, 1);
  const rollPid = createPid(2.4, 0.9, 0.7);
  pitchPid.reset(rig.data.hoverCyclicPitch);
  rollPid.reset(rig.data.hoverCyclicRoll);
  const heading0 = rig.data.heading;
  const fly = (lab) => {
    const data = lab.data;
    const heading = data.heading * DEG;
    const velocity = lab.model.state.velocity;
    const forward = velocity.x * Math.sin(heading) - velocity.z * Math.cos(heading);
    const right = velocity.x * Math.cos(heading) + velocity.z * Math.sin(heading);
    const pitchTarget = clamp(0.05 * (forward - fly.forwardTarget), -0.2, 0.15);
    const bankTarget = clamp(-0.05 * right, -0.15, 0.15);
    lab.pilot.pitch = pitchPid.update(pitchTarget - data.pitch, DT, data.pitchRate);
    lab.pilot.roll = rollPid.update(bankTarget - data.bank, DT, data.rollRate);
    if (fly.holdHeading) {
      const error = ((((heading0 - data.heading + 180) % 360) + 360) % 360) - 180;
      lab.pilot.yaw = clamp(data.antiTorquePedal + 0.03 * error - 0.8 * data.yawRate, -1, 1);
    }
  };
  fly.forwardTarget = 0;
  fly.holdHeading = false;
  return fly;
}

/** Level-flight power (torque) from the hover to 20 m/s; translational lift onset where it has dropped 10 %. */
function testTranslationalLift() {
  const speeds = [0, 3, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 40, 50];
  const torques = [];
  for (const speed of speeds) {
    const rig = createRig({ assists: 1 });
    rig.airborne({ altitude: 600, speed });
    rig.autopilot.enabled = true;
    rig.autopilot.heading = 0;
    rig.autopilot.altitude = 600;
    rig.autopilot.speed = Math.max(speed, 3.01);
    if (speed === 0) rig.autopilot.enabled = false;
    rig.run(25);
    const samples = [];
    rig.run(8, (lab) => {
      samples.push(lab.data.torque);
    });
    torques.push(average(samples));
    log('ETL', speed, 'm/s torque', average(samples).toFixed(3), 'airspeed', rig.data.airspeed.toFixed(1), 'vs', rig.data.verticalSpeed.toFixed(2));
  }
  const hover = torques[0];
  let onset = NaN;
  for (let index = 1; index < speeds.length; index++) {
    if (torques[index] <= hover * 0.9) {
      const previous = torques[index - 1];
      const share = (previous - hover * 0.9) / Math.max(previous - torques[index], 1e-6);
      onset = speeds[index - 1] + share * (speeds[index] - speeds[index - 1]);
      break;
    }
  }
  const bucket = Math.min(...torques);
  record('translational lift onset (power -10 %)', onset * KMH, targets.translationalLift * KMH, { unit: 'km/h', tolerance: 0.3, decimals: 1, note: `torque ${speeds.map((speed, index) => `${speed}:${Math.round(torques[index] * 100)}`).join(' ')}` });
  record('minimum power (bucket) vs hover', bucket / hover, [0.5, 0.8], { compare: 'range', note: 'power bucket at 20-30 m/s' });
}

/** Hover collective in ground effect with the skids 1 m up vs out of ground effect, and none past one diameter. */
function testGroundEffect(hoverOge) {
  const measure = (skidHeight) => {
    const rig = createRig({ assists: 1 });
    const skidDepth = 1.52;
    rig.airborne({ altitude: skidHeight + skidDepth });
    rig.run(15);
    const collective = [];
    const torque = [];
    const heights = [];
    rig.run(8, (lab) => {
      collective.push(lab.data.collective);
      torque.push(lab.data.torque);
      heights.push(lab.data.agl);
    });
    return { collective: average(collective), torque: average(torque), height: average(heights) };
  };
  const low = measure(1);
  const diameter = measure(2 * helicopter.simProfile.rotor.radius + 1);
  const powerSaving = 1 - low.torque / hoverOge.torque;
  record('ground effect: power saved at 1 m skid height', powerSaving * 100, [8, 25], { unit: '%', compare: 'range', decimals: 1, note: `torque ${(low.torque * 100).toFixed(1)} % vs ${(hoverOge.torque * 100).toFixed(1)} % OGE; skids at ${low.height.toFixed(2)} m` });
  record('ground effect past one rotor diameter', Math.abs(1 - diameter.torque / hoverOge.torque) * 100, 1, { unit: '%', compare: 'max', decimals: 2 });
}

/** 0 % assists, hands off, hover collective: the main-rotor torque yaws the nose right; left pedal stops it. */
function testTorque() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 600 });
  rig.pilot.throttle = 0.5;
  // The lab pilot holds the hover with the cyclic; pedals centred, then the anti-torque pedal.
  const holdLevel = createHoverPilot(rig);
  rig.run(3, holdLevel);
  const rates = [];
  rig.run(3, (lab) => {
    holdLevel(lab);
    rates.push(lab.data.yawRate);
  });
  const pedalPid = createPid(1.5, 0.8, 0.4);
  const heldRates = [];
  rig.run(6, (lab) => {
    holdLevel(lab);
    lab.pilot.yaw = pedalPid.update(-lab.data.yawRate, DT);
  });
  let pedal = 0;
  rig.run(3, (lab) => {
    holdLevel(lab);
    lab.pilot.yaw = pedalPid.update(-lab.data.yawRate, DT);
    heldRates.push(lab.data.yawRate);
    pedal = lab.pilot.yaw;
  });
  record('torque: yaw rate hands off (nose right +)', average(rates) / DEG, [3, 30], { unit: 'deg/s', compare: 'range', decimals: 1, note: 'counterclockwise rotor, pedals centred' });
  record('torque: pedal holding the heading', pedal, [-0.6, -0.02], { compare: 'range', note: `left pedal; residual ${(average(heldRates) / DEG).toFixed(2)} deg/s` });
}

/**
 * Vortex ring state: stabilized vertical descent at 0.75 vh (position held by the assists' cyclic),
 * then full collective with no airspeed: the descent continues (settling with power). Then forward
 * cyclic (the autopilot accelerating to 20 m/s) with full collective: recovery.
 */
function testVortexRing() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 1200 });
  const pilot = createHoverPilot(rig);
  pilot.holdHeading = true;
  rig.run(4, pilot);
  const hoverInduced = rig.data.hoverInduced;
  const descent = 0.75 * hoverInduced;
  const sink = createPid(0.05, 0.05, 0, 0, 1);
  sink.reset(rig.data.collective);
  rig.run(10, (lab) => {
    pilot(lab);
    lab.pilot.throttle = sink.update(-descent - lab.data.verticalSpeed, DT);
  });
  const enteredDescent = -rig.data.verticalSpeed;
  const enteredRing = rig.data.vortexRing;
  rig.pilot.throttle = 1;
  const altitudeStart = rig.position().y;
  let worst = 0;
  rig.run(5, (lab) => {
    pilot(lab);
    worst = Math.max(worst, -lab.data.verticalSpeed);
  });
  const settledDescent = -rig.data.verticalSpeed;
  record('VRS entry: descent at 0.75 vh with zero airspeed', enteredRing, 0.5, { compare: 'min', note: `descending ${enteredDescent.toFixed(1)} m/s (vh ${hoverInduced.toFixed(1)} m/s)` });
  record('VRS: full collective does not arrest the descent', settledDescent, 2.5, { unit: 'm/s', compare: 'min', note: `after 5 s at full collective; worst ${worst.toFixed(1)} m/s, ${(altitudeStart - rig.position().y).toFixed(0)} m lost, rotor ${(rig.data.rotorRpm * 100).toFixed(0)} %` });
  // Recovery: forward cyclic to 15 m/s, collective back to the hover setting.
  pilot.forwardTarget = 15;
  rig.pilot.throttle = 0.55;
  const recoveryStart = rig.position().y;
  let recoveredAt = NaN;
  rig.run(15, (lab) => {
    pilot(lab);
    if (!Number.isFinite(recoveredAt) && lab.data.verticalSpeed > -1 && lab.data.vortexRing < 0.05) recoveredAt = lab.time;
  });
  const recoverySeconds = recoveredAt - (rig.time - 15);
  record('VRS recovery with forward cyclic', recoverySeconds, 8, { unit: 's', compare: 'max', decimals: 1, note: `descent below 1 m/s, out of the ring; ${(recoveryStart - rig.position().y).toFixed(0)} m lost` });
}

/** Engine off at 28 m/s, 100 % assists: rpm held by the upflow, steady descent; the flare lands softly. */
function testAutorotation() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500, speed: 28 });
  rig.run(4);
  rig.pilot.actions.add('engineToggle');
  rig.tick();
  const rates = [];
  const rpm = [];
  const speeds = [];
  rig.run(20, (lab) => {
    if (lab.time > 12) {
      rates.push(-lab.data.verticalSpeed);
      rpm.push(lab.data.rotorRpm);
      speeds.push(lab.data.airspeed);
    }
  });
  record('autorotation descent rate', average(rates), targets.autorotationDescent, { unit: 'm/s', tolerance: 0.3, note: `at ${average(speeds).toFixed(1)} m/s airspeed, engine off` });
  record('autorotation rotor rpm (sustained by the upflow)', average(rpm) * 100, [95, 106], { unit: '%', compare: 'range', decimals: 1 });
  let touchdownSink = NaN;
  let touchdownSpeed = NaN;
  let minRpm = Infinity;
  rig.run(90, (lab) => {
    if (!lab.data.onGround) minRpm = Math.min(minRpm, lab.data.rotorRpm);
    if (lab.events.landed.length > 0) return true;
    if (lab.model.contact.touchdown && !Number.isFinite(touchdownSink)) {
      touchdownSink = lab.model.contact.touchdown.sinkRate;
      touchdownSpeed = lab.model.contact.touchdown.groundSpeed;
    }
    return false;
  });
  const landed = rig.events.landed[0];
  const sinkRate = landed ? landed.sinkRate : touchdownSink;
  record('autorotation flare: touchdown sink rate', sinkRate, 1.2, { unit: 'm/s', compare: 'max', note: landed ? `${landed.grade}, rotor down to ${(minRpm * 100).toFixed(0)} %` : `no graded landing (${Number.isFinite(touchdownSpeed) ? touchdownSpeed.toFixed(1) : '-'} m/s)` });
  record('autorotation flare: touchdown ground speed', landed ? landed.groundSpeed : 99, 13, { unit: 'm/s', compare: 'max', decimals: 1, note: 'a run-on landing on the skids' });

  // 0 %: the collective left at the hover setting after the engine quits -> the rotor decays.
  const raw = createRig({ assists: 0.5 });
  raw.airborne({ altitude: 800, speed: 28 });
  raw.run(3);
  raw.pilot.actions.add('engineToggle');
  raw.tick();
  let hornAt = NaN;
  raw.run(6, (lab) => {
    lab.model.writeTelemetry(lab.telemetry);
    if (!Number.isFinite(hornAt) && lab.telemetry.stall.warning) hornAt = lab.time;
  });
  record('engine off, collective left up: rotor decays, low-rpm horn', raw.data.rotorRpm * 100, 88, { unit: '%', compare: 'max', decimals: 1, note: Number.isFinite(hornAt) ? `horn after ${(hornAt - 3).toFixed(1)} s` : 'no horn' });
  // Lowering the collective recovers the rpm in the descent.
  raw.pilot.throttle = 0.12;
  raw.run(8);
  record('lower collective: rpm recovers in autorotation', raw.data.rotorRpm * 100, [95, 112], { unit: '%', compare: 'range', decimals: 1, note: `descending ${(-raw.data.verticalSpeed).toFixed(1)} m/s` });
}

/**
 * Retreating blade stall near Vne: none at 80 %, clear at Vne with a nose-up / roll-left tendency.
 * A lab pilot (0 % assists) holds a shallow descent at 4 m/s with the collective, the airspeed with
 * the pitch attitude and the wings level; the trim stick at each speed shows the stall's moments.
 */
function testVne() {
  const measure = (speed) => {
    const rig = createRig({ assists: 0 });
    rig.airborne({ altitude: 2500, speed, lever: 0.5 });
    const pitchPid = createPid(2, 1.2, 1);
    const rollPid = createPid(2, 1.2, 0.6);
    const collectivePid = createPid(0.06, 0.08, 0, 0, 1);
    const speedPid = createPid(0.03, 0.01, 0, -0.35, 0.2);
    pitchPid.reset(-0.4);
    collectivePid.reset(0.55);
    speedPid.reset(-0.1);
    let stall = 0;
    let buffet = 0;
    const fly = (lab) => {
      const pitchTarget = -speedPid.update(speed - lab.data.airspeed, DT) - 0.05;
      lab.pilot.pitch = pitchPid.update(pitchTarget - lab.data.pitch, DT, lab.data.pitchRate);
      lab.pilot.roll = rollPid.update(-lab.data.bank, DT, lab.data.rollRate);
      lab.pilot.throttle = collectivePid.update(-4 - lab.data.verticalSpeed, DT);
      lab.pilot.yaw = clamp(1.6 * lab.data.sideslip + lab.data.antiTorquePedal, -1, 1);
    };
    rig.run(20, fly);
    const sticks = { pitch: [], roll: [] };
    rig.run(4, (lab) => {
      fly(lab);
      sticks.pitch.push(lab.pilot.pitch);
      sticks.roll.push(lab.pilot.roll);
      stall = Math.max(stall, lab.data.bladeStall);
      lab.model.writeTelemetry(lab.telemetry);
      buffet = Math.max(buffet, lab.telemetry.stall.buffet);
    });
    return { stall, buffet, stickPitch: average(sticks.pitch), stickRoll: average(sticks.roll), overspeed: rig.data.overspeed, airspeed: rig.data.airspeed };
  };
  const cruise = measure(limits.vne * 0.8);
  const atVne = measure(limits.vne * 1.02);
  log('Vne', JSON.stringify(cruise), JSON.stringify(atVne));
  record('retreating blade stall at 0.8 Vne', cruise.stall, 0.05, { compare: 'max', note: `${(cruise.airspeed * KMH).toFixed(0)} km/h` });
  record('retreating blade stall at Vne', atVne.stall, 0.3, { compare: 'min', note: `${(atVne.airspeed * KMH).toFixed(0)} km/h, buffet ${atVne.buffet.toFixed(2)}, overspeed ${atVne.overspeed}` });
  record('blade stall: forward stick to hold the nose (pitch-up)', atVne.stickPitch - cruise.stickPitch, -0.03, { compare: 'max', note: `trim stick ${cruise.stickPitch.toFixed(2)} -> ${atVne.stickPitch.toFixed(2)}` });
  record('blade stall: right stick to hold the wings (roll left)', atVne.stickRoll - cruise.stickRoll, 0.02, { compare: 'min', note: `trim stick ${cruise.stickRoll.toFixed(2)} -> ${atVne.stickRoll.toFixed(2)}` });
}

/** 100 % assists hands off for 60 s: horizontal and vertical drift in calm air and in wind. */
function testAutoHover() {
  const drift = (windSpeed, turbulence) => {
    const rig = createRig({ assists: 1 });
    rig.airborne({ altitude: 400 });
    rig.env.wind.vel.set(windSpeed * Math.sin(60 * DEG), 0, -windSpeed * Math.cos(60 * DEG));
    rig.env.wind.turbulence = turbulence;
    const base = new THREE.Vector3();
    let maxDrift = 0;
    let maxHeight = 0;
    let maxHeading = 0;
    let gustTime = 0;
    rig.run(8, (lab) => {
      if (turbulence > 0) {
        gustTime += DT;
        lab.env.wind.vel.set(windSpeed * Math.sin(60 * DEG) + 2 * Math.sin(gustTime * 0.7), 0.6 * Math.sin(gustTime * 1.3), -windSpeed * Math.cos(60 * DEG) + 1.5 * Math.sin(gustTime * 0.45 + 1));
      }
    });
    base.copy(rig.position());
    const heading = rig.data.heading;
    rig.run(60, (lab) => {
      if (turbulence > 0) {
        gustTime += DT;
        lab.env.wind.vel.set(windSpeed * Math.sin(60 * DEG) + 2 * Math.sin(gustTime * 0.7), 0.6 * Math.sin(gustTime * 1.3), -windSpeed * Math.cos(60 * DEG) + 1.5 * Math.sin(gustTime * 0.45 + 1));
      }
      const position = lab.position();
      maxDrift = Math.max(maxDrift, Math.hypot(position.x - base.x, position.z - base.z));
      maxHeight = Math.max(maxHeight, Math.abs(position.y - base.y));
      maxHeading = Math.max(maxHeading, Math.abs(((((lab.data.heading - heading + 180) % 360) + 360) % 360) - 180));
    });
    return { maxDrift, maxHeight, maxHeading, activeAssists: [...rig.context.activeAssists] };
  };
  const calm = drift(0, 0);
  record('auto-hover 60 s calm: horizontal drift', calm.maxDrift, 2, { unit: 'm', compare: 'max', note: `height ${calm.maxHeight.toFixed(2)} m, heading ${calm.maxHeading.toFixed(1)} deg; active: ${calm.activeAssists.join(', ')}` });
  const windy = drift(9, 0.4);
  record('auto-hover 60 s in 9 m/s gusting wind: drift', windy.maxDrift, 5, { unit: 'm', compare: 'max', note: `height ${windy.maxHeight.toFixed(2)} m, heading ${windy.maxHeading.toFixed(1)} deg` });
  record('auto-hover in wind: height hold', windy.maxHeight, 2, { unit: 'm', compare: 'max' });
}

/** 100 % assists: lever below the detent from a 20 m hover -> cushioned touchdown on the skids, then at rest. */
function testLanding() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 21.5 });
  rig.run(6);
  rig.pilot.throttle = 0.2;
  rig.run(40, (lab) => lab.events.landed.length > 0);
  const landed = rig.events.landed[0];
  record('landing at 100 %: touchdown sink rate', landed ? landed.sinkRate : 99, 0.8, { unit: 'm/s', compare: 'max', note: landed ? `graded ${landed.grade}` : 'no graded landing' });
  const start = rig.position().clone();
  let maxVertical = 0;
  let strike = null;
  rig.run(10, (lab) => {
    maxVertical = Math.max(maxVertical, Math.abs(lab.model.state.velocity.y));
    if (lab.model.contact.bodyStrike) strike = lab.model.contact.bodyStrike.part;
  });
  const moved = Math.hypot(rig.position().x - start.x, rig.position().z - start.z);
  record('at rest on the skids 10 s: creep', moved, 0.2, { unit: 'm', compare: 'max', decimals: 3, note: `${rig.model.contact.contacts} contacts, collective ${rig.data.collective.toFixed(2)}, max bounce ${maxVertical.toFixed(3)} m/s${strike ? `, strike ${strike}` : ''}` });

  // 0 %: a hard arrival past the skids' limit is a soft crash, not a landing.
  const hard = createRig({ assists: 0 });
  hard.airborne({ altitude: 8, lever: 0.1 });
  let touchdown = null;
  hard.run(6, (lab) => {
    if (lab.model.contact.touchdown) {
      touchdown = { ...lab.model.contact.touchdown };
      return true;
    }
    return false;
  });
  record('hard arrival on the skids exceeds the crash sink rate', touchdown ? touchdown.sinkRate : 0, limits.crashSinkRate, { unit: 'm/s', compare: 'min', note: `limit ${limits.crashSinkRate} m/s -> soft crash in the controller; graded landings ${hard.events.landed.length}` });

  // 100 %: no touchdown on a 22 degree slope or on water; the auto-hover holds a low hover instead.
  for (const surface of ['slope', 'water']) {
    const guarded = createRig({ assists: 1 });
    if (surface === 'slope') {
      const rise = Math.tan(22 * DEG);
      guarded.world.groundHeight = (x) => x * rise;
      guarded.env.groundHeight = guarded.world.groundHeight;
    } else {
      guarded.world.groundHeight = () => -6;
      guarded.env.groundHeight = guarded.world.groundHeight;
      guarded.env.waterLevel = 0;
    }
    guarded.airborne({ altitude: 16 });
    guarded.run(4);
    guarded.pilot.throttle = 0.15;
    let touched = false;
    let strike = '';
    guarded.run(25, (lab) => {
      if (lab.model.contact.onGround || lab.model.contact.water) touched = true;
      if (lab.model.contact.bodyStrike) strike = lab.model.contact.bodyStrike.part;
    });
    record(`100 % landing guard over ${surface === 'slope' ? 'a 22 deg slope' : 'water'}`, guarded.data.agl, [1.5, 4], { unit: 'm', compare: touched || strike ? false : 'range', decimals: 2, note: touched || strike ? `touched ${strike}` : 'holds a low hover (lever down)' });
  }

  // Lift off from the ground at 100 %: lever above the detent.
  const liftoff = createRig({ assists: 1 });
  liftoff.parked({ lever: 0.5 });
  liftoff.run(3);
  const restingCollective = liftoff.data.collective;
  liftoff.pilot.throttle = 0.8;
  liftoff.run(8);
  record('lift-off at 100 %: lever up climbs away', liftoff.data.agl, 10, { unit: 'm', compare: 'min', decimals: 1, note: `collective at rest ${restingCollective.toFixed(2)}, climbing ${liftoff.data.verticalSpeed.toFixed(1)} m/s` });
}

/** A respawn with the lever at full: the collective holds (hover) until the lever moves, then slews. */
function testPickup() {
  for (const level of [0, 1]) {
    const rig = createRig({ assists: level });
    rig.airborne({ altitude: 600, lever: 0.5 });
    rig.pilot.throttle = 1;
    let maxClimb = 0;
    rig.run(3, (lab) => {
      if (level === 0) {
        lab.pilot.pitch = clamp(2 * (0.01 - lab.data.pitch) - 0.8 * lab.data.pitchRate + lab.data.hoverCyclicPitch, -1, 1);
        lab.pilot.roll = clamp(2 * (-0.03 - lab.data.bank) - 0.5 * lab.data.rollRate + lab.data.hoverCyclicRoll, -1, 1);
      }
      maxClimb = Math.max(maxClimb, Math.abs(lab.data.verticalSpeed));
    });
    rig.pilot.throttle = 0.95;
    rig.run(3);
    record(`collective pickup at ${level * 100} %: lever unmoved`, maxClimb, 1, { unit: 'm/s', compare: 'max', note: `then the moved lever climbs ${rig.data.verticalSpeed.toFixed(1)} m/s` });
  }
}

/** Rotor strike on a steep bank next to the ground; the tail stinger strike when flaring hard at the ground. */
function testStrikes() {
  const rig = createRig({ assists: 0 });
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -40 * DEG, 'YXZ'));
  rig.model.reset({ position: new THREE.Vector3(0, 3.2, 0), quaternion, velocity: new THREE.Vector3(0, -1, 0), angularVelocity: new THREE.Vector3(), throttle: 0.4, onGround: false, engineOn: true });
  let part = '';
  let speed = 0;
  rig.run(1.5, (lab) => {
    const strike = lab.model.contact.bodyStrike;
    if (strike && strike.speed > speed) {
      part = strike.part;
      speed = strike.speed;
    }
  });
  record('rotor strike: 40 deg bank at 3 m', part === 'main rotor' ? 1 : 0, 1, { compare: part === 'main rotor', note: `${part || 'none'} at ${speed.toFixed(0)} m/s (limit ${limits.bodyStrikeSpeed} m/s -> soft crash)` });
  const tail = createRig({ assists: 0 });
  const nosed = new THREE.Quaternion().setFromEuler(new THREE.Euler(12 * DEG, 0, 0, 'YXZ'));
  tail.model.reset({ position: new THREE.Vector3(0, 2.2, 0), quaternion: nosed, velocity: new THREE.Vector3(0, -4, 3), angularVelocity: new THREE.Vector3(), throttle: 0.3, onGround: false, engineOn: true });
  let tailPart = '';
  let tailSpeed = 0;
  tail.run(1.5, (lab) => {
    const strike = lab.model.contact.bodyStrike;
    if (strike && strike.speed > tailSpeed) {
      tailPart = strike.part;
      tailSpeed = strike.speed;
    }
  });
  const tailStruck = tailPart === 'tailStinger' && tailSpeed > limits.bodyStrikeSpeed;
  record('tail strike: backing down 12 deg nose-up', tailStruck ? 1 : 0, 1, { compare: tailStruck, note: `${tailPart || 'none'} at ${tailSpeed.toFixed(1)} m/s (limit ${limits.bodyStrikeSpeed} m/s)` });
}

/** Engine off on the ground, the rotor runs down; engine start spins it back to governed. */
function testEngine() {
  const rig = createRig({ assists: 1 });
  rig.parked({ lever: 0.5 });
  rig.run(2);
  rig.pilot.actions.add('engineToggle');
  rig.tick();
  rig.run(30);
  const rundown = rig.data.rotorRpm;
  rig.pilot.actions.add('engineToggle');
  rig.tick();
  let governedAt = NaN;
  rig.run(20, (lab) => {
    if (!Number.isFinite(governedAt) && lab.data.engineRunning && Math.abs(lab.data.rotorRpm - 1) < 0.02) governedAt = lab.time;
  });
  const startSeconds = governedAt - (rig.time - 20);
  record('engine off on the ground: rotor runs down (30 s)', rundown * 100, [5, 70], { unit: '%', compare: 'range', decimals: 1 });
  record('engine start: rotor governed again', startSeconds, 12, { unit: 's', compare: 'max', decimals: 1, note: `notices: ${rig.events.notify.slice(-2).join(' | ')}` });
}

/** Autopilot heading / altitude / speed hold; the hands-off hold hovers. */
function testAutopilot() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500, speed: 40 });
  rig.autopilot.enabled = true;
  rig.autopilot.heading = 90;
  rig.autopilot.altitude = 600;
  rig.autopilot.speed = 45;
  rig.run(60);
  const headingError = Math.abs(((((rig.data.heading - 90 + 180) % 360) + 360) % 360) - 180);
  record('autopilot heading +90 deg (60 s)', headingError, 3, { unit: 'deg', compare: 'max', decimals: 1 });
  record('autopilot altitude +100 m (60 s)', Math.abs(rig.position().y - 600), 8, { unit: 'm', compare: 'max', decimals: 1 });
  record('autopilot speed hold 45 m/s', Math.abs(rig.data.airspeed - 45), 3, { unit: 'm/s', compare: 'max', decimals: 1 });
  // Hands-off hold (device disconnected): the autopilot hovers where it is.
  const hold = createRig({ assists: 1 });
  hold.airborne({ altitude: 500, speed: 20 });
  hold.context.handsOff = true;
  hold.env.handsOff = true;
  hold.autopilot.enabled = true;
  hold.autopilot.heading = 0;
  hold.autopilot.altitude = 500;
  hold.autopilot.speed = 50;
  hold.run(40);
  record('hands-off hold: hovering', hold.data.groundSpeed, 1, { unit: 'm/s', compare: 'max', note: `altitude ${hold.position().y.toFixed(1)} m` });
  // Engine off with the autopilot engaged: the autopilot stands aside and the assists autorotate.
  hold.pilot.actions.add('engineToggle');
  hold.tick();
  hold.run(15);
  record('autopilot engaged, engine off: autorotation holds the rotor', hold.data.rotorRpm * 100, [92, 110], { unit: '%', compare: 'range', decimals: 1, note: `descending ${(-hold.data.verticalSpeed).toFixed(1)} m/s at ${hold.data.airspeed.toFixed(1)} m/s` });
}

/** The assist catalog the UI tooltip lists. */
function testCatalog() {
  const full = describeAssists(1, 'helicopter');
  const half = describeAssists(0.5, 'helicopter');
  const none = describeAssists(0, 'helicopter');
  const expectedFull = ['auto-hover', 'heading hold', 'attitude limits', 'torque auto-compensation'].every((name) => full.includes(name));
  const expectedHalf = half.includes('heading hold') && half.some((name) => name.includes('stability')) && !half.includes('auto-hover');
  record('assist catalog 100 / 50 / 0 %', expectedFull && expectedHalf && none.length === 0 ? 1 : 0, 1, { compare: expectedFull && expectedHalf && none.length === 0, note: `100: ${full.join(', ')} | 50: ${half.join(', ')} | 0: none` });
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} helicopter checks within target (sea-level standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
const hoverResult = testHover();
testClimb();
testTranslationalLift();
testGroundEffect(hoverResult);
testTorque();
testVortexRing();
testAutorotation();
testVne();
testAutoHover();
testLanding();
testPickup();
testStrikes();
testEngine();
testAutopilot();
testCatalog();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
