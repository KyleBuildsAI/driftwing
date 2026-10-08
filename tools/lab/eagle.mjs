// Eagle / dragon flight lab: flies SimFlapper headless (node, no renderer) with scripted controls
// through the same control stages the game runs every physics tick (the autopilot and the flapper
// assists) and prints its measured performance against the spec numbers (Milestone E, item 13), the
// perch behaviour and the ignition service the dragon's fire uses.
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3), still unless a test adds wind,
// over flat ground at sea level (a hill for the peak perch, a ridge for ridge lift). Physics runs at
// the game's fixed 120 Hz. Perch points come from a stand-in for the collider service's perchesNear.
//
// Tests:
//   glide       flap power 0, neutral stick: the best glide (about 12 : 1 near 45 km/h), steady
//   polar       the pitch range: the least sink (about 1 m/s) and the slowest unstalled glide
//   flapping    the cruise flap power holds height; full flap power climbs (about 2.5 m/s)
//   stoop       wings tucked, nose down: the dive reaches 60 m/s; untucked it pulls out
//   handling    a roll pulse turns it; 100 % assists keep full pull out of the stall; 0 % stalls and
//               recovers hands off
//   soaring     a thermal (rising air) and ridge lift (wind up a slope) carry it up with the flap
//               power at zero
//   perch       a slow approach catches a tree-top perch: the auto-landing, then standing still at
//               the perch point (the perched event); the same throttle stays perched, raised throttle
//               takes off (the perched false event) without catching the perch again; a fast pass
//               does not land; a perch behind a wall (a blocked line of flight) is refused
//   peak        a slow pass low over a hilltop lands on the peak
//   ground      a slow touchdown on flat ground stands (graded as a landing, no perched event); a
//               fast dive into the ground strikes the body (the soft crash)
//   placement   a resting reset at a perch point stands on it; at a ground point stands on the ground
//   autopilot   the copilot's perch approach (craftState.perchTarget) flies to the perch and lands
//   ignition    the ignition service: add, cone, ignite once, extinguish, remove, refusals
//
// Usage: node tools/lab/eagle.mjs [--verbose]
// Prints a PASS / FAIL table and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import eagle from '../../src/craft/eagle.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createIgnitionService } from '../../src/gameplay/ignition.js';
import { DEG, clamp } from '../../src/core/util.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
const KMH = 3.6;
const FEET = eagle.simProfile.perch.feet;
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

/** A round hill: height `height` at (x, z), falling off over `radius` metres (a gaussian). */
function createHillWorld(x, z, height, radius) {
  const surface = (px, pz) => height * Math.exp(-((px - x) ** 2 + (pz - z) ** 2) / (radius * radius));
  return { groundHeight: surface, heightAt: surface, WATER_LEVEL };
}

/** A ridge running east-west north of the origin: rising `gradient` metres per metre from z = start northward to `top`. */
function createRidgeWorld(gradient, start, top) {
  const surface = (px, pz) => clamp((start - pz) * gradient, 0, top);
  return { groundHeight: surface, heightAt: surface, WATER_LEVEL };
}

/** A stand-in for the collider service: perch points, and walls (axis-aligned boxes) that block the line of flight. */
function createColliders(perches = [], walls = []) {
  return {
    perchesNear(x, y, z, radius, visit) {
      for (const perch of perches) {
        if (Math.hypot(perch.x - x, perch.y - y, perch.z - z) <= radius) visit(perch.x, perch.y, perch.z, perch.kind, perch.id);
      }
    },
    raycast(origin, direction, maxDistance, filter, out) {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      for (const wall of walls) {
        for (let step = 0; step <= 64; step++) {
          const share = (step / 64) * maxDistance;
          const px = origin.x + (direction.x / length) * share;
          const py = origin.y + (direction.y / length) * share;
          const pz = origin.z + (direction.z / length) * share;
          if (px >= wall.min[0] && px <= wall.max[0] && py >= wall.min[1] && py <= wall.max[1] && pz >= wall.min[2] && pz <= wall.max[2]) {
            out.distance = share;
            return true;
          }
        }
      }
      return false;
    },
    insideSolid() {
      return null;
    },
    liftClear(x, y) {
      return y;
    },
  };
}

function createRig({ assists = 0, world = createFlatWorld(), colliders = null } = {}) {
  const craft = eagle;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], perched: [], journalStat: [], invalid: 0 };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push({ ...payload }));
  bus.onTyped('perched', (payload) => events.perched.push({ ...payload, position: { ...payload.position } }));
  bus.onTyped('journalStat', (payload) => events.journalStat.push({ ...payload }));
  const craftState = { ...craft.abilities.craftAbility.initialState(), ...craft.abilities.craftAbilityAlt.initialState(), skin: 'eagle' };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry, colliders };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, env, context, events, craftState, time: 0, autopilot, windAt: null, nonFinite: 0 };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    if (rig.windAt) rig.windAt(model.state.position, env.wind.vel);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    const state = model.state;
    if (![state.position.x, state.position.y, state.position.z, state.velocity.x, state.velocity.y, state.velocity.z, state.quaternion.w].every(Number.isFinite)) rig.nonFinite++;
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
  /** In the air at `speed` heading `heading` (level, the model trims its own attitude). */
  rig.airborne = ({ speed = 12.5, heading = 0, altitude = 2000, x = 0, z = 0, path = 0 } = {}) => {
    const direction = new THREE.Quaternion().setFromEuler(new THREE.Euler(path * DEG, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(direction);
    model.reset({ position: new THREE.Vector3(x, altitude, z), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG), velocity, angularVelocity: new THREE.Vector3(), onGround: false, throttle: 0 });
  };
  rig.state = () => model.state;
  return rig;
}

/** Wings level (or a bank target) through the roll. */
function levelWings(rig, bank = 0) {
  const data = rig.data;
  rig.pilot.roll = clamp(1.5 * (bank * DEG - data.bank) - 0.3 * data.rollRate, -1, 1);
}

/** Glide ratio (ground referenced), mean airspeed and sink over `seconds`. */
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

// ============================================================================================
// TESTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = 0.1, compare = 'within', note = '', decimals = 1 } = {}) {
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

/** A steady glide at a fixed stick and flap power: settle 30 s, measure 15 s. */
function steadyGlide(pitch, throttle = 0) {
  const rig = createRig();
  rig.airborne({});
  rig.pilot.pitch = pitch;
  rig.pilot.throttle = throttle;
  rig.run(30, levelWings);
  const result = measureGlide(rig, 15, levelWings);
  return { ...result, aoa: rig.data.aoa / DEG, stalled: rig.data.stalled, rates: rig.state().angularVelocity.length(), nonFinite: rig.nonFinite };
}

function glideTest() {
  const targets = eagle.simProfile.targets;
  const neutral = steadyGlide(0);
  log('neutral', JSON.stringify(neutral));
  record('glide ratio, flap power 0, neutral stick', neutral.glide, targets.glideRatio, { unit: ': 1', decimals: 2 });
  record('glide speed, neutral stick', neutral.speed * KMH, targets.glideSpeed * KMH, { unit: 'km/h', decimals: 0 });
  record('steady (rates settle)', neutral.rates, 0.02, { unit: 'rad/s', compare: 'max', decimals: 3 });
}

function polarTest() {
  const targets = eagle.simProfile.targets;
  const points = [];
  for (const pitch of [-0.4, -0.2, 0, 0.2, 0.35, 0.5, 0.6]) {
    const point = steadyGlide(pitch);
    points.push({ pitch, ...point });
    log(`polar pitch ${pitch.toFixed(2)}: ${(point.speed * KMH).toFixed(1)} km/h glide ${point.glide.toFixed(2)} sink ${point.sink.toFixed(2)} aoa ${point.aoa.toFixed(1)} stalled ${point.stalled}`);
  }
  const flying = points.filter((point) => !point.stalled);
  const leastSink = flying.reduce((best, point) => (point.sink < best.sink ? point : best));
  const slowest = flying.reduce((best, point) => (point.speed < best.speed ? point : best));
  const fastest = flying.reduce((best, point) => (point.speed > best.speed ? point : best));
  record('least sink (wings out, slow end)', leastSink.sink, targets.minSink, { unit: 'm/s', compare: 'max', decimals: 2, note: `at ${(leastSink.speed * KMH).toFixed(0)} km/h` });
  record('slowest unstalled glide near the stall', slowest.speed, targets.stallSpeed * 1.3, { unit: 'm/s', compare: 'max', decimals: 1, note: `stall ${targets.stallSpeed} m/s` });
  record('push trades glide for speed', fastest.speed - slowest.speed, 4, { unit: 'm/s', compare: 'min', decimals: 1, note: `${(slowest.speed * KMH).toFixed(0)}-${(fastest.speed * KMH).toFixed(0)} km/h` });
}

function flappingTest() {
  const cruise = steadyGlide(0, eagle.spawn.cruiseThrottle);
  log('cruise', JSON.stringify(cruise));
  record('cruise flap power holds height', Math.abs(cruise.sink), 0.3, { unit: 'm/s', compare: 'max', decimals: 2, note: `flap power ${eagle.spawn.cruiseThrottle}` });
  const full = steadyGlide(0, 1);
  record('full flap power climbs', -full.sink, eagle.simProfile.targets.climbRate, { unit: 'm/s', tolerance: 0.3, decimals: 2, note: `at ${(full.speed * KMH).toFixed(0)} km/h` });
  const rig = createRig();
  rig.airborne({});
  rig.pilot.throttle = 1;
  let beats = 0;
  let last = rig.craftState.flapCount;
  rig.run(10, (current) => {
    if (current.craftState.flapCount !== last) {
      beats++;
      last = current.craftState.flapCount;
    }
  });
  record('wingbeat at full power (beats in 10 s)', beats, 30, { compare: beats >= 30 && beats <= 40, note: `${(beats / 10).toFixed(1)} Hz` });
  const gliding = createRig();
  gliding.airborne({});
  let glideBeats = 0;
  last = gliding.craftState.flapCount;
  gliding.run(10, (current) => {
    if (current.craftState.flapCount !== last) glideBeats++;
    last = current.craftState.flapCount;
  });
  record('flap power 0 is a glide (no wingbeat)', glideBeats, 0, { compare: glideBeats === 0 });
}

function stoopTest() {
  const rig = createRig();
  rig.airborne({ speed: 14, altitude: 3000 });
  let fastest = 0;
  rig.run(30, (current) => {
    current.craftState.tuckRequest = true;
    current.pilot.pitch = -0.3;
    levelWings(current);
    fastest = Math.max(fastest, current.data.airspeed);
  });
  record('stoop: wings tucked reach the stoop speed', fastest, eagle.simProfile.targets.stoopSpeed, { unit: 'm/s', compare: 'min', decimals: 1, note: `tuck ${rig.data.tuck.toFixed(2)}, ${(3000 - rig.state().position.y).toFixed(0)} m lost` });
  let lowestPath = 0;
  rig.run(12, (current) => {
    current.craftState.tuckRequest = false;
    current.pilot.pitch = 0.4;
    levelWings(current);
    lowestPath = Math.min(lowestPath, current.data.flightPath);
  });
  record('untucked, the stoop pulls out', rig.data.flightPath / DEG, -10, { unit: 'deg', compare: 'min', note: `${rig.data.airspeed.toFixed(1)} m/s, ${rig.data.gLoad.toFixed(2)} g` });
}

function handlingTest() {
  const turning = createRig({ assists: 0.5 });
  turning.airborne({});
  const heading = turning.data.heading;
  turning.run(1.5, (current) => {
    current.pilot.roll = 0.6;
  });
  turning.run(3, (current) => {
    current.pilot.roll = 0;
  });
  const change = (((turning.data.heading - heading) % 360) + 360) % 360;
  record('a roll pulse turns it (heading change)', change, 25, { unit: 'deg', compare: 'min', note: `bank ${(turning.data.bank / DEG).toFixed(0)} deg` });

  const protectedRig = createRig({ assists: 1 });
  protectedRig.airborne({});
  let stalledFrames = 0;
  protectedRig.run(12, (current) => {
    current.pilot.pitch = 1;
    current.pilot.roll = 0.5;
    if (current.data.stalled) stalledFrames++;
  });
  record('100 %: full pull and roll stay out of the stall', stalledFrames, 0, { compare: stalledFrames === 0, note: `aoa ${(protectedRig.data.aoa / DEG).toFixed(1)} deg` });

  const raw = createRig({ assists: 0 });
  raw.airborne({});
  let stalled = false;
  raw.run(6, (current) => {
    current.pilot.pitch = 1;
    if (current.data.stalled) stalled = true;
  });
  raw.run(10, (current) => {
    current.pilot.pitch = 0;
    levelWings(current);
  });
  record('0 %: full pull stalls', stalled ? 1 : 0, 1, { compare: stalled });
  record('0 %: hands off recovers', raw.data.stalled ? 1 : 0, 0, { compare: !raw.data.stalled && raw.data.airspeed > eagle.simProfile.targets.stallSpeed, note: `${raw.data.airspeed.toFixed(1)} m/s, NaN ticks ${raw.nonFinite}` });
}

function soaringTest() {
  // A thermal: rising air at 2 m/s inside 150 m of the origin, circling in it with the flap power at zero.
  const thermal = createRig({ assists: 0.5 });
  thermal.windAt = (position, out) => out.set(0, Math.hypot(position.x - 60, position.z) < 150 ? 2 : 0, 0);
  thermal.airborne({ altitude: 800 });
  thermal.run(8, (current) => levelWings(current, 25));
  const before = thermal.state().position.y;
  thermal.run(30, (current) => levelWings(current, 25));
  const climb = (thermal.state().position.y - before) / 30;
  record('thermal (2 m/s): circles up gliding', climb, 0.5, { unit: 'm/s', compare: 'min', decimals: 2, note: `soarGain ${thermal.craftState.soarGain.toFixed(0)} m` });
  const soarStat = thermal.events.journalStat.find((entry) => entry.key === 'eagleBestSoar');
  record('the soaring climb reaches the journal', soarStat ? soarStat.value : 0, 25, { unit: 'm', compare: 'min', decimals: 0 });

  // Ridge lift: 9 m/s of wind blowing north up a 0.5 slope; the air rises over the slope (w = u x grade).
  const ridgeWorld = createRidgeWorld(0.5, -100, 200);
  const ridge = createRig({ assists: 0.5, world: ridgeWorld });
  ridge.windAt = (position, out) => {
    const onSlope = position.z < -100 && position.z > -500;
    const height = position.y - ridgeWorld.groundHeight(position.x, position.z);
    out.set(0, onSlope && height < 120 ? 9 * 0.5 * clamp(1 - height / 120, 0, 1) : 0, -9);
  };
  ridge.airborne({ altitude: 150, z: -250, heading: 90 });
  const ridgeStart = ridge.state().position.y;
  // Beats east-west along the slope, holding station by heading into the wind a little.
  ridge.run(40, (current) => {
    const height = current.state().position.y - ridgeWorld.groundHeight(current.state().position.x, current.state().position.z);
    current.pilot.pitch = height < 30 ? 0.2 : 0;
    levelWings(current);
  });
  record('ridge lift: gains height along the slope gliding', ridge.state().position.y - ridgeStart, 10, { unit: 'm', compare: 'min', decimals: 0, note: `NaN ticks ${ridge.nonFinite}` });
}

/** A slow approach at a perch from 80 m out: returns { rig, landedAt, perchedAt }. */
function approachPerch(perch, { speed = 10.5, pitch = 0.3, altitude = perch.y + 10, walls = [] } = {}) {
  const rig = createRig({ assists: 1, colliders: createColliders([perch], walls) });
  rig.airborne({ speed, altitude, z: perch.z + 80, x: perch.x });
  rig.pilot.throttle = 0.25;
  rig.pilot.pitch = pitch;
  let landingAt = null;
  let landingZ = null;
  let perchedAt = null;
  rig.run(16, (current) => {
    if (landingAt === null && current.model.phase === 'landing') {
      landingAt = current.time;
      landingZ = current.state().position.z;
    }
    if (perchedAt === null && current.model.phase === 'perched') perchedAt = current.time;
  });
  return { rig, landingAt, landingZ, perchedAt };
}

function perchTest() {
  const perch = { x: 0, y: 30, z: -80, kind: 'tree', id: 'perch:pine:1' };
  const { rig, landingAt, perchedAt } = approachPerch(perch);
  record('slow approach: the auto-landing starts', landingAt === null ? -1 : landingAt, 0, { unit: 's', compare: landingAt !== null, decimals: 2 });
  record('auto-landing length', perchedAt !== null && landingAt !== null ? perchedAt - landingAt : -1, eagle.simProfile.perch.landSeconds[1], { unit: 's', compare: 'max', decimals: 2 });
  const position = rig.state().position;
  const offset = Math.hypot(position.x - perch.x, position.y - (perch.y + FEET), position.z - perch.z);
  record('perched: feet on the perch point', offset, 0.01, { unit: 'm', compare: 'max', decimals: 3, note: `${rig.craftState.perchKind}, ${rig.craftState.perchId}` });
  const perchedEvent = rig.events.perched.find((entry) => entry.perched === true);
  record('perched event (kind, id, position)', perchedEvent ? 1 : 0, 1, { compare: Boolean(perchedEvent && perchedEvent.kind === 'tree' && perchedEvent.perchId === perch.id && Math.abs(perchedEvent.position.y - perch.y) < 0.01) });
  record('journal counts the perch', rig.events.journalStat.filter((entry) => entry.key === 'eaglePerches').length, 1, { compare: rig.events.journalStat.filter((entry) => entry.key === 'eaglePerches').length === 1 });
  const held = rig.state().position.clone();
  rig.run(5);
  record('holds still on the perch (5 s, same flap power)', rig.state().position.distanceTo(held), 0.001, { unit: 'm', compare: rig.craftState.perched && rig.state().position.distanceTo(held) <= 0.001, decimals: 4 });
  const headingBefore = rig.data.heading;
  rig.run(1, (current) => {
    current.pilot.yaw = 1;
  });
  rig.pilot.yaw = 0;
  const turned = Math.abs((((rig.data.heading - headingBefore + 540) % 360) - 180));
  record('turns on the spot with the pedals', turned, 30, { unit: 'deg', compare: 'min', note: `still perched: ${rig.craftState.perched}` });
  rig.pilot.throttle = 0.7;
  rig.run(0.2);
  record('raised flap power takes off', rig.model.phase === 'flight' ? 1 : 0, 1, { compare: rig.model.phase === 'flight' });
  const offEvent = rig.events.perched.find((entry) => entry.perched === false);
  record('perched false event on takeoff', offEvent ? 1 : 0, 1, { compare: Boolean(offEvent && offEvent.perchId === perch.id) });
  rig.pilot.pitch = 0;
  rig.run(5);
  const away = Math.hypot(rig.state().position.x - perch.x, rig.state().position.z - perch.z);
  record('flies away without catching the perch again', away, 20, { unit: 'm', compare: rig.model.phase === 'flight' && away >= 20, decimals: 0, note: `height ${(rig.state().position.y - perch.y).toFixed(1)} m over the perch` });

  const fast = approachPerch(perch, { speed: 16, pitch: -0.1 });
  record('a fast pass does not land', fast.landingAt === null ? 0 : 1, 0, { compare: fast.landingAt === null });
  // The stand-in walls do not stop the bird: it flies on through, and only past the wall is the line clear.
  const blocked = approachPerch(perch, { walls: [{ min: [-5, 0, -76], max: [5, 60, -70] }] });
  record('a perch behind a wall is refused (line of flight)', blocked.landingZ ?? 0, -76, { unit: 'm', compare: blocked.landingAt === null || blocked.landingZ < -76, note: blocked.landingAt === null ? 'never caught' : `caught past the wall at z ${blocked.landingZ.toFixed(1)}` });
}

function peakTest() {
  const world = createHillWorld(0, -120, 80, 90);
  const rig = createRig({ assists: 1, world, colliders: createColliders() });
  rig.airborne({ speed: 10.5, altitude: 87, z: -40 });
  rig.pilot.throttle = 0.25;
  rig.pilot.pitch = 0.3;
  let perchedAt = null;
  rig.run(25, (current) => {
    if (perchedAt === null && current.model.phase === 'perched') perchedAt = current.time;
  });
  const position = rig.state().position;
  const top = world.groundHeight(position.x, position.z);
  record('peak: lands on the hilltop', perchedAt === null ? -1 : perchedAt, 0, { unit: 's', compare: perchedAt !== null && rig.craftState.perchKind === 'peak', decimals: 2, note: `kind ${rig.craftState.perchKind}, feet ${(position.y - FEET - top).toFixed(2)} m over the ground, ${Math.hypot(position.x, position.z + 120).toFixed(1)} m from the top` });
}

function groundTest() {
  const rig = createRig({ assists: 1, colliders: createColliders() });
  rig.airborne({ speed: 10.5, altitude: 9 });
  rig.pilot.throttle = 0;
  rig.pilot.pitch = 0.45;
  rig.run(30);
  record('slow touchdown on flat ground stands', rig.craftState.perched ? 1 : 0, 1, { compare: rig.craftState.perched === true && rig.craftState.perchKind === 'ground', note: `kind ${rig.craftState.perchKind}, landed ${rig.events.landed.map((entry) => entry.grade).join(',') || 'none'}` });
  record('standing on plain ground is no perched event', rig.events.perched.length, 0, { compare: rig.events.perched.length === 0 });
  const dive = createRig({ assists: 0 });
  dive.airborne({ speed: 35, altitude: 14, path: -60 });
  dive.pilot.pitch = -0.4;
  let strike = null;
  dive.run(6, (current) => {
    if (current.model.contact.bodyStrike) {
      strike = { ...current.model.contact.bodyStrike };
      return true;
    }
    return false;
  });
  record('a fast dive into the ground strikes the body', strike ? strike.speed : 0, eagle.limits.bodyStrikeSpeed, { unit: 'm/s', compare: 'min', note: strike ? strike.part : 'no strike' });
}

function placementTest() {
  const perch = { x: 10, y: 22, z: -5, kind: 'tree', id: 'perch:redwood:7' };
  const rig = createRig({ colliders: createColliders([perch]) });
  rig.model.reset({ position: new THREE.Vector3(perch.x, perch.y, perch.z), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), onGround: true });
  rig.run(0.5);
  const position = rig.state().position;
  record('perch placement stands on the perch point', Math.abs(position.y - (perch.y + FEET)), 0.01, { unit: 'm', compare: rig.craftState.perched && rig.craftState.perchKind === 'tree' && Math.abs(position.y - (perch.y + FEET)) <= 0.01, decimals: 3, note: `kind ${rig.craftState.perchKind}` });
  const ground = createRig({ colliders: createColliders() });
  ground.model.reset({ position: new THREE.Vector3(0, FEET, 0), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), onGround: true });
  ground.run(0.5);
  record('ground placement stands on the ground', Math.abs(ground.state().position.y - FEET), 0.01, { unit: 'm', compare: ground.craftState.perched && Math.abs(ground.state().position.y - FEET) <= 0.01, decimals: 3 });
  // From standing on the ground, full flap power takes off and climbs away.
  ground.pilot.throttle = 1;
  ground.run(8);
  record('ground takeoff at full flap power climbs away', ground.state().position.y, 8, { unit: 'm', compare: 'min', decimals: 1, note: `${ground.data.airspeed.toFixed(1)} m/s` });
}

function autopilotTest() {
  const perch = { x: 220, y: 40, z: -260, kind: 'structure', id: 'landmark:arch:lintel' };
  const rig = createRig({ assists: 1, colliders: createColliders([perch]) });
  rig.airborne({ speed: 12.5, altitude: 90 });
  rig.pilot.throttle = 0.3;
  rig.craftState.perchTarget = { x: perch.x, y: perch.y, z: perch.z, kind: perch.kind, id: perch.id };
  rig.autopilot.enabled = true;
  rig.autopilot.heading = 0;
  rig.autopilot.altitude = 90;
  rig.autopilot.speed = 12;
  let perchedAt = null;
  rig.run(90, (current) => {
    if (perchedAt === null && current.model.phase === 'perched') {
      perchedAt = current.time;
      return true;
    }
    return false;
  });
  record('autopilot perch approach lands on the perch', perchedAt === null ? -1 : perchedAt, 90, { unit: 's', compare: perchedAt !== null && rig.craftState.perchKind === 'structure', decimals: 1, note: `kind ${rig.craftState.perchKind}, NaN ticks ${rig.nonFinite}` });
}

function ignitionTest() {
  const ignition = createIgnitionService();
  const lit = [];
  ignition.add({ id: 'lantern:a', position: { x: 0, y: 0, z: -8 }, radius: 0.5, onIgnite: (source) => lit.push(['a', source.kind]) });
  ignition.add({ id: 'lantern:b', position: { x: 6, y: 0, z: -8 }, radius: 0.5, onIgnite: () => lit.push(['b']) });
  ignition.add({ id: 'torch:c', position: { x: 0, y: 0, z: 30 }, radius: 1, onIgnite: () => lit.push(['c']) });
  const seen = [];
  const origin = { x: 0, y: 0, z: 0 };
  const direction = { x: 0, y: 0, z: -2 };
  ignition.cone(origin, direction, 12, 13 * DEG, (id, wasLit) => {
    seen.push(id);
    if (!wasLit) ignition.ignite(id, { kind: 'dragonFire', craft: 'eagle', position: origin });
  });
  record('ignition: the cone touches only what is in it', seen.join(','), 'lantern:a', { compare: seen.join(',') === 'lantern:a' });
  const again = ignition.ignite('lantern:a', { kind: 'dragonFire' });
  record('ignition: lights once (onIgnite once, source passed)', lit.length, 1, { compare: lit.length === 1 && lit[0][1] === 'dragonFire' && again === false && ignition.isLit('lantern:a') && ignition.litCount === 1 });
  ignition.extinguish('lantern:a');
  ignition.ignite('lantern:a', { kind: 'dragonFire' });
  record('ignition: extinguish re-arms it', lit.length, 2, { compare: lit.length === 2 });
  let duplicate = false;
  try {
    ignition.add({ id: 'lantern:b', position: { x: 0, y: 0, z: 0 }, onIgnite() {} });
  } catch (error) {
    duplicate = /already registered/.test(error.message);
  }
  let invalid = false;
  try {
    ignition.add({ id: 'bad id!', position: { x: 0, y: 0, z: 0 }, onIgnite() {} });
  } catch (error) {
    invalid = /needs an id/.test(error.message);
  }
  record('ignition: refuses duplicates and bad ids', duplicate && invalid ? 1 : 0, 1, { compare: duplicate && invalid });
  ignition.move('lantern:b', 0, 0, -5);
  const moved = [];
  ignition.cone(origin, direction, 12, 13 * DEG, (id) => moved.push(id));
  record('ignition: a moved ignitable is found where it went', moved.join(','), 'lantern:a,lantern:b', { compare: moved.join(',') === 'lantern:a,lantern:b' });
  const removed = ignition.remove('lantern:a') && ignition.remove('lantern:b') && ignition.remove('torch:c') && !ignition.remove('torch:c');
  record('ignition: owners remove theirs (count back to 0)', ignition.count, 0, { compare: removed && ignition.count === 0 });
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} eagle checks within target (sea-level standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
glideTest();
polarTest();
flappingTest();
stoopTest();
handlingTest();
soaringTest();
perchTest();
peakTest();
groundTest();
placementTest();
autopilotTest();
ignitionTest();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
