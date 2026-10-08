// Seaplane scenarios for ?test=craft (contract k.1 and Milestone P item 3): a takeoff and a landing on
// the ocean and on a lake, flown at 100 % assists by a scripted pilot, and the wheels-down water
// landing (the gear advisory, then the nose-over soft crash).
//
// The pilot works the way a player would through the test input path: flaps and the water rudders by
// their actions, the throttle, and the stick and pedals as closed loops on what the telemetry shows
// (at 100 % assists the stick commands load and the hands-off stick holds the flight path; on the
// water the water handling assist holds the planing trim). The lake run measures its lake first: it
// takes off along the longest open chord whose far shore has low ground beyond it, taxis to the back
// shore with the water rudders, turns, takes off, flies a circuit and lands back on the lake.
import { clamp, wrapDegrees } from '../../core/util.js';

const DEG = Math.PI / 180;
const SEARCH_HEADINGS = 36;
const SHORE_STEP = 5;
const MAX_SHORE = 1500;
/** Ground beyond the far shore is sampled this far (m) for the climb-out. */
const RIM_RANGE = 600;
/** Taxi power, slowing for the last 40 m before the turn; the turn's power. */
const TAXI_THROTTLE = Object.freeze({ cruise: 0.25, slow: 0.1, turn: 0.2 });
/** The circuit: out to this far from the lake (m), 120 m up, back on a 4 degree glide path. */
const CIRCUIT = Object.freeze({ outbound: 1500, height: 120, glide: 4 * DEG, approachSpeed: 26, climbRate: 3.5 });

/** Signed heading error (deg, -180..180): positive means the target is to the right. */
function headingError(target, heading) {
  return wrapDegrees(target - heading + 180) - 180;
}

/** Compass heading (deg) from (x, z) to (toX, toZ): 0 north (-z), 90 east (+x). */
function bearing(x, z, toX, toZ) {
  return wrapDegrees(Math.atan2(toX - x, -(toZ - z)) / DEG);
}

/** The approach keeps this high (m) over land until the water is below; the flare starts this high over it. */
const LAND_CLEARANCE = 9;
const FLARE_HEIGHT = 8;

/** Unit vector [x, z] of a compass heading. */
function headingVector(heading) {
  return [Math.sin(heading * DEG), -Math.cos(heading * DEG)];
}

/** The time step since the script's last frame (s), kept in memo. */
function stepSeconds(api) {
  const previous = Number.isFinite(api.memo.lastT) ? api.memo.lastT : api.t;
  api.memo.lastT = api.t;
  return Math.max(0, api.t - previous);
}

/**
 * Flies a heading, a vertical speed and an airspeed at 100 % assists: bank toward the heading (25
 * degrees at most), the stick on the vertical speed error (the hands-off stick holds the path), and
 * the throttle on the total energy: the airspeed error plus the vertical speed error, with a slow
 * integral on the airspeed.
 */
function flyAir(api, dt, { heading, verticalSpeed, airspeed }) {
  const flight = api.flight;
  const memo = api.memo;
  const bank = clamp(0.8 * headingError(heading, flight.heading), -25, 25);
  const speedError = airspeed - flight.airspeed;
  const climbError = verticalSpeed - flight.verticalSpeed;
  memo.throttle = clamp((Number.isFinite(memo.throttle) ? memo.throttle : 0.55) + 0.015 * speedError * dt, 0.1, 0.9);
  return {
    roll: clamp(0.05 * (bank - flight.roll), -0.6, 0.6),
    pitch: clamp(0.1 * climbError, -0.45, 0.45),
    yaw: 0,
    throttle: clamp(memo.throttle + 0.06 * speedError + 0.1 * climbError, 0, 1),
  };
}

/** Steers a heading on the water with the pedals (the water rudders when down), wings level. */
function steerWater(api, dt, heading, throttle) {
  const flight = api.flight;
  const memo = api.memo;
  const previous = Number.isFinite(memo.lastHeading) ? memo.lastHeading : flight.heading;
  const yawRate = dt > 0 ? headingError(flight.heading, previous) / dt : 0;
  memo.lastHeading = flight.heading;
  const error = headingError(heading, flight.heading);
  const command = clamp(0.06 * error - 0.12 * yawRate, -1, 1);
  return { roll: clamp(-0.05 * flight.roll, -0.5, 0.5), pitch: 0, yaw: command, throttle, brakeL: command < -0.9 ? 1 : 0, brakeR: command > 0.9 ? 1 : 0 };
}

/** The flight path to a touchdown point: the vertical speed that tracks the glide slope at the airspeed. */
function glideVerticalSpeed(api, aimX, aimZ, surface) {
  const player = api.player;
  const distance = Math.hypot(aimX - player.position.x, aimZ - player.position.z);
  const target = surface + 2.2 + distance * Math.tan(CIRCUIT.glide);
  const sink = CIRCUIT.approachSpeed * Math.sin(CIRCUIT.glide);
  return clamp(-sink + 0.25 * (target - player.position.y), -2.5, 1.5);
}

/**
 * The landing pilot: the glide slope, then the flare over the water, then power off and stick neutral
 * on the water. Over land it never sinks below LAND_CLEARANCE (the shore can stand above the lake).
 */
function flyLanding(api, dt, aimX, aimZ, surface) {
  const flight = api.flight;
  const player = api.player;
  if (api.memo.touched || flight.onGround) {
    api.memo.touched = true;
    return { roll: clamp(-0.05 * flight.roll, -0.5, 0.5), pitch: 0, yaw: 0, throttle: 0 };
  }
  const overWater = api.waterQuery.isWater(player.position.x, player.position.z);
  // The flare: over the water the sink rate eases off with the height (the keels are 2.2 m below).
  const flare = overWater && flight.agl < FLARE_HEIGHT;
  let verticalSpeed = flare ? -Math.max(0.4, 0.3 * (flight.agl - 2.2)) : glideVerticalSpeed(api, aimX, aimZ, surface);
  if (!overWater && flight.agl < LAND_CLEARANCE) verticalSpeed = Math.max(verticalSpeed, 0.5);
  const aimHeading = bearing(api.player.position.x, api.player.position.z, aimX, aimZ);
  const controls = flyAir(api, dt, { heading: aimHeading, verticalSpeed, airspeed: CIRCUIT.approachSpeed });
  if (flare) controls.throttle = Math.min(controls.throttle, 0.3);
  return controls;
}

/** Presses an action once (one frame), keyed so it fires only once per run. */
function press(api, key, action, actions) {
  if (api.once(key)) actions.push(action);
}

/** The landed event of this run on the water, or null. */
function waterLanding(api) {
  const landing = api.events.last('landed');
  return landing && landing.surface === 'water' ? landing : null;
}

// ---- The lake survey ------------------------------------------------------------------------------
/** Distance (m) from (x, z) to the shore along a heading (the water query's static outline). */
function shoreDistance(api, x, z, heading) {
  const [dx, dz] = headingVector(heading);
  let distance = 0;
  while (distance < MAX_SHORE && api.waterQuery.isWater(x + dx * distance, z + dz * distance)) distance += SHORE_STEP;
  return distance;
}

/**
 * Picks the takeoff heading from the lake's centre: the longest chord whose far shore has the lowest
 * ground beyond it (the climb-out), and the back-shore point to start the run from.
 */
function surveyLake(api) {
  const centre = api.player.position;
  const level = api.waterQuery.heightAt(centre.x, centre.z);
  let best = null;
  for (let index = 0; index < SEARCH_HEADINGS; index++) {
    const heading = (index * 360) / SEARCH_HEADINGS;
    const ahead = shoreDistance(api, centre.x, centre.z, heading);
    const behind = shoreDistance(api, centre.x, centre.z, heading + 180);
    const [dx, dz] = headingVector(heading);
    let rim = 0;
    for (let beyond = ahead; beyond <= ahead + RIM_RANGE; beyond += 20) rim = Math.max(rim, api.world.groundHeight(centre.x + dx * beyond, centre.z + dz * beyond) - level);
    const score = ahead + behind - 6 * rim;
    if (!best || score > best.score) best = { heading, ahead, behind, rim, score };
  }
  const [dx, dz] = headingVector(best.heading);
  // The turn at the back shore swings about 25 m further out: it starts 75 m short of the shore.
  const back = Math.max(0, best.behind - 75);
  return {
    ...best,
    level,
    centre: { x: centre.x, z: centre.z },
    back: { x: centre.x - dx * back, z: centre.z - dz * back },
    // The landing comes back the other way and touches down past the near (takeoff-side) shore.
    aim: { x: centre.x + dx * best.ahead * 0.35, z: centre.z + dz * best.ahead * 0.35 },
  };
}

function lakeScript(t, api) {
  const memo = api.memo;
  const dt = stepSeconds(api);
  const actions = [];
  const flight = api.flight;
  const player = api.player;
  if (!memo.plan) {
    memo.plan = surveyLake(api);
    memo.phase = 'taxi';
    memo.taxiStart = flight.heading;
    memo.turned = 0;
  }
  const plan = memo.plan;
  const previousHeading = Number.isFinite(memo.headingSeen) ? memo.headingSeen : flight.heading;
  memo.turned += Math.abs(headingError(flight.heading, previousHeading));
  memo.headingSeen = flight.heading;
  let controls;
  if (memo.phase === 'taxi') {
    if (api.craftState.waterRudders !== true) press(api, 'ruddersDown', 'craftAbility', actions);
    const toBack = Math.hypot(plan.back.x - player.position.x, plan.back.z - player.position.z);
    controls = steerWater(api, dt, bearing(player.position.x, player.position.z, plan.back.x, plan.back.z), toBack > 40 ? TAXI_THROTTLE.cruise : TAXI_THROTTLE.slow);
    if (toBack < 10) memo.phase = 'turn';
  } else if (memo.phase === 'turn') {
    controls = steerWater(api, dt, plan.heading, TAXI_THROTTLE.turn);
    // The run's own steering finishes lining up: full power from 30 degrees off.
    if (Math.abs(headingError(plan.heading, flight.heading)) < 30) memo.phase = 'run';
  } else if (memo.phase === 'run') {
    if (api.craftState.waterRudders === true) press(api, 'ruddersUp', 'craftAbility', actions);
    else if (api.once('flaps1')) actions.push('flapsDown');
    else if (api.once('flaps2')) actions.push('flapsDown');
    controls = steerWater(api, dt, plan.heading, 1);
    // Rotate at the liftoff speed (flaps 2): a gentle pull lifts it off the step.
    if (flight.airspeed > 24) controls.pitch = 0.3;
    if (!flight.onGround && flight.agl > 3) memo.phase = 'climb';
  } else if (memo.phase === 'climb' || memo.phase === 'outbound') {
    const out = Math.hypot(player.position.x - plan.centre.x, player.position.z - plan.centre.z);
    const verticalSpeed = flight.agl < CIRCUIT.height ? CIRCUIT.climbRate : 0;
    controls = flyAir(api, dt, { heading: plan.heading, verticalSpeed, airspeed: 32 });
    if (out > CIRCUIT.outbound) memo.phase = 'reverse';
  } else if (memo.phase === 'reverse') {
    const inbound = bearing(player.position.x, player.position.z, plan.aim.x, plan.aim.z);
    controls = flyAir(api, dt, { heading: inbound, verticalSpeed: 0, airspeed: 30 });
    if (Math.abs(headingError(inbound, flight.heading)) < 10) memo.phase = 'approach';
  } else {
    if (api.once('flaps3')) actions.push('flapsDown');
    controls = flyLanding(api, dt, plan.aim.x, plan.aim.z, plan.level);
    if (memo.touched && Math.abs(api.craftState.waterSpeed) < 6 && api.craftState.waterRudders !== true) press(api, 'ruddersDownAfter', 'craftAbility', actions);
  }
  return { ...controls, actions };
}

// ---- The ocean ------------------------------------------------------------------------------------
function oceanScript(t, api) {
  const memo = api.memo;
  const dt = stepSeconds(api);
  const actions = [];
  const flight = api.flight;
  const player = api.player;
  if (!memo.phase) {
    memo.phase = 'run';
    memo.heading = flight.heading;
    memo.origin = { x: player.position.x, z: player.position.z };
  }
  let controls;
  if (memo.phase === 'run') {
    if (t > 0.3 && api.once('flaps1')) actions.push('flapsDown');
    else if (t > 0.6 && api.once('flaps2')) actions.push('flapsDown');
    controls = steerWater(api, dt, memo.heading, t > 1 ? 1 : 0);
    if (flight.airspeed > 25) controls.pitch = 0.3;
    if (!flight.onGround && flight.agl > 3) memo.phase = 'climb';
  } else if (memo.phase === 'climb') {
    const out = Math.hypot(player.position.x - memo.origin.x, player.position.z - memo.origin.z);
    controls = flyAir(api, dt, { heading: memo.heading, verticalSpeed: flight.agl < CIRCUIT.height ? CIRCUIT.climbRate : 0, airspeed: 32 });
    if (out > CIRCUIT.outbound + 600) {
      memo.phase = 'reverse';
      // Land back near where the run started, 300 m short of it.
      const [dx, dz] = headingVector(memo.heading);
      memo.aim = { x: memo.origin.x + dx * 300, z: memo.origin.z + dz * 300 };
    }
  } else if (memo.phase === 'reverse') {
    const inbound = bearing(player.position.x, player.position.z, memo.aim.x, memo.aim.z);
    controls = flyAir(api, dt, { heading: inbound, verticalSpeed: 0, airspeed: 30 });
    if (Math.abs(headingError(inbound, flight.heading)) < 10) memo.phase = 'approach';
  } else {
    if (api.once('flaps3')) actions.push('flapsDown');
    controls = flyLanding(api, dt, memo.aim.x, memo.aim.z, api.waterQuery.heightAt(memo.aim.x, memo.aim.z));
  }
  return { ...controls, actions };
}

// ---- Wheels down on the water ---------------------------------------------------------------------
function noseOverScript(t, api) {
  const dt = stepSeconds(api);
  const actions = [];
  if (t > 0.5) press(api, 'gearDown', 'gearToggle', actions);
  if (t > 0.8 && api.once('flaps1')) actions.push('flapsDown');
  else if (t > 1.1 && api.once('flaps2')) actions.push('flapsDown');
  else if (t > 1.4 && api.once('flaps3')) actions.push('flapsDown');
  return { ...flyAir(api, dt, { heading: api.start.heading, verticalSpeed: -1.5, airspeed: CIRCUIT.approachSpeed }), actions };
}

export default Object.freeze({
  craft: 'seaplane',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'seaplane-ocean',
      views: ['third', 'first'],
      start: { at: 'ocean', mode: 'water' },
      seconds: 220,
      script: oceanScript,
      checks: [
        { id: 'afloat', label: 'starts afloat on the ocean, wheels up', until: 2, test: (api) => api.flight.onWater && api.craftState.onWater && api.flight.gear.down === false },
        { id: 'step', label: 'over the hump and onto the step', until: 40, test: (api) => api.craftState.onStep === true },
        { id: 'spray', label: 'spray off the floats on the run', until: 40, test: (api) => api.craftState.spray > 0.3 },
        { id: 'airborne', label: 'takes off from the ocean (30 m up)', until: 90, test: (api) => !api.flight.onGround && api.agl() > 30 },
        { id: 'landed', label: "lands back on the ocean (landed, surface 'water', open ocean)", from: 30, test: (api) => { const landing = waterLanding(api); return Boolean(landing) && api.waterQuery.isOcean(landing.position.x, landing.position.z); } },
        { id: 'stopped', label: 'slows to taxi speed afloat after the landing', from: 30, test: (api) => Boolean(waterLanding(api)) && api.craftState.onWater && Math.abs(api.craftState.waterSpeed) < 6 },
      ],
    }),
    Object.freeze({
      id: 'seaplane-lake',
      views: ['third', 'first'],
      world: 'waters',
      start: { at: 'lake', mode: 'water', craftState: { waterRudders: true } },
      seconds: 330,
      script: lakeScript,
      checks: [
        { id: 'afloat', label: 'starts afloat on a lake', until: 2, test: (api) => api.flight.onWater && !api.waterQuery.isOcean(api.player.position.x, api.player.position.z) },
        { id: 'waterRudders', label: 'taxis and turns on the water rudders (more than 120 degrees of heading)', until: 150, test: (api) => api.memo.phase === 'run' && api.memo.turned > 120 },
        { id: 'airborne', label: 'takes off from the lake and climbs out (40 m up)', until: 220, test: (api) => !api.flight.onGround && api.agl() > 40 },
        { id: 'landed', label: "lands back on the lake (landed, surface 'water', not the ocean)", from: 30, test: (api) => { const landing = waterLanding(api); return Boolean(landing) && api.waterQuery.isWater(landing.position.x, landing.position.z) && !api.waterQuery.isOcean(landing.position.x, landing.position.z); } },
        { id: 'stopped', label: 'slows to taxi speed on the lake', from: 30, test: (api) => Boolean(waterLanding(api)) && api.craftState.onWater && Math.abs(api.craftState.waterSpeed) < 6 },
      ],
    }),
    Object.freeze({
      id: 'seaplane-nose-over',
      views: ['third'],
      start: { at: 'ocean', mode: 'air', agl: 45, speed: 30 },
      seconds: 60,
      allowCrash: true,
      script: noseOverScript,
      checks: [
        { id: 'gearDown', label: 'the wheels go down over the water', until: 12, test: (api) => api.flight.gear.down === true },
        { id: 'warning', label: 'the gear advisory: the nose-over warning and WREN speaks it before the water', until: 50, test: (api) => api.craftState.noseOverWarning === true && api.craftState.gearAdvisories >= 1 && !api.flight.onWater },
        { id: 'noseOver', label: "wheels in the water: the nose-over soft crash ('nose-over strike')", until: 60, test: (api) => api.events.count('softCrash') >= 1 && api.events.last('softCrash').reason === 'nose-over strike' },
      ],
    }),
  ]),
});
