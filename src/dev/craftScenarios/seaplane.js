// Seaplane scenarios for ?test=craft (contract k.1 and Milestone P item 3): a takeoff and a landing on
// the ocean and on a lake, flown at 100 % assists by a scripted pilot, and the wheels-down water
// landing (the gear advisory, then the nose-over soft crash).
//
// The pilot works the way a player would through the test input path: flaps and the water rudders by
// their actions, the throttle, and the stick and pedals as closed loops on what the telemetry shows
// (at 100 % assists the stick commands load and the hands-off stick holds the flight path; on the
// water the water handling assist holds the planing trim). Both water runs fly one circuit:
//   survey     from the start, the open-water chord to take off along: long, into the wind, with the
//              climb-out and the final approach clear of the ground;
//   taxi       if the water ahead is too short for the run, taxi back on the water rudders, turn;
//   run        water rudders up, two notches of flaps, full power, rotate at the liftoff speed;
//   circuit    climb out at full power, a 180 degree turn to the side with the lower ground, the
//              downwind leg, the base turn onto the extended chord behind the touchdown point;
//   final      a 5 degree glide (never below a safe height over land, faster in gusts), the flare
//              over the water, power off and the run-out straight ahead.
//
// The starts are fixed points of the CRAFT-1 world with the water fixtures ('waters': the base
// terrain and ocean, plus the fixture lakes), so every run of every view starts in the same place: a
// fixture lake (about 400 m across in a shallow basin) and a wide sound of the sea west of the spawn,
// open for more than 1 km along the prevailing wind.
import { clamp, wrapDegrees } from '../../core/util.js';

const DEG = Math.PI / 180;
/** The CRAFT-1 'waters' world: the fixture lake's centre and a point in the sound west of the spawn. */
const LAKE_START = Object.freeze({ x: 1411, z: -336 });
const OCEAN_START = Object.freeze({ x: -8819, z: -288 });
const SEARCH_HEADINGS = 36;
const SHORE_STEP = 5;
/** Open water counts this far (m) at most along a heading, and needs this much depth (m) for the keels. */
const MAX_CHORD = 1500;
const MIN_DEPTH = 1.2;
/**
 * The climb-out and the final approach are checked this far (m) from the run's start: the climb-out
 * leaves the water at most LIFTOFF (m) along the run and climbs CLIMB_GRADIENT (m per m); the final
 * comes down the glide slope to the run's start. Ground within CLEARANCE_MARGIN (m) of either path
 * counts against the heading.
 */
const PATH_RANGE = 2500;
const LIFTOFF = 500;
const CLIMB_GRADIENT = 0.06;
const CLEARANCE_MARGIN = 10;
/**
 * The run wants this much water (m) from its start; a taxi back makes up what the water ahead lacks,
 * stopping BACK_MARGIN (m) from the back shore. A run shorter than RUN_MINIMUM is a last resort, and
 * each m/s of headwind counts as HEADWIND_METRES of extra water.
 */
const RUN_NEEDED = 1000;
const RUN_MINIMUM = 320;
const BACK_MARGIN = 75;
const HEADWIND_METRES = 30;
/** Each metre of ground into the climb-out's or the final's margin counts as this much less water. */
const OBSTRUCTION_METRES = 20;
/** Taxi power, slowing for the last 40 m before the turn; the turn's power. */
const TAXI_THROTTLE = Object.freeze({ cruise: 0.25, slow: 0.1, turn: 0.2 });
/**
 * The circuit (m, m/s): upwind to this far past the run's start, circuit height above the surface,
 * the base turn this far behind the touchdown point, the final fix on the extended chord, the glide.
 */
const CIRCUIT = Object.freeze({ upwind: 800, height: 80, base: 700, fix: 550, glide: 5 * DEG, approachSpeed: 26, climbRate: 3.5, cruiseSpeed: 32, climbOutRate: 3.5, climbOutSpeed: 29 });
/** After the touchdown, below this airspeed (m/s; under the full-flap stall) the stick comes back. */
const PLOW_SPEED = 20;
/** Off a skip after the touchdown the stick holds this nose attitude (deg). */
const SKIP_ATTITUDE = 6;
/** The run rotates at this airspeed (m/s; 1.1 x the flaps-2 stall). */
const ROTATE_SPEED = 26;
/** The touchdown point is this far (m) past the run's start along the chord (negative: short of it). */
const TOUCHDOWN_AFTER_START = 0;
/**
 * The approach keeps this high (m) over land until the water is below, and TERRAIN_CLEARANCE (m) above
 * the ground under it while it is more than SHORT_FINAL (m) from the touchdown point; the flare starts
 * FLARE_HEIGHT (m) over the water.
 */
const LAND_CLEARANCE = 9;
const TERRAIN_CLEARANCE = 20;
const SHORT_FINAL = 250;
const FLARE_HEIGHT = 8;
/** The nose-over's approach wants this much open water (m) ahead of its start. */
const NOSE_OVER_WATER = 1200;
/** The final adds up to this much airspeed (m/s) in full turbulence. */
const GUST_MARGIN = 3;

/** The flown climb gives way by this many m/s per m/s of airspeed more than SPEED_MARGIN (m/s) below the target. */
const SPEED_PRIORITY = 1.5;
const SPEED_MARGIN = 2;

/** Signed heading error (deg, -180..180): positive means the target is to the right. */
function headingError(target, heading) {
  return wrapDegrees(target - heading + 180) - 180;
}

/** Compass heading (deg) from (x, z) to (toX, toZ): 0 north (-z), 90 east (+x). */
function bearing(x, z, toX, toZ) {
  return wrapDegrees(Math.atan2(toX - x, -(toZ - z)) / DEG);
}

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
 * integral on the airspeed. Airspeed comes first: more than SPEED_MARGIN below the target, the climb
 * asked for gives way (the nose comes down) so it never wallows toward the stall in gusts.
 */
function flyAir(api, dt, { heading, verticalSpeed, airspeed }) {
  const flight = api.flight;
  const memo = api.memo;
  const bank = clamp(0.8 * headingError(heading, flight.heading), -25, 25);
  const speedError = airspeed - flight.airspeed;
  const climbError = verticalSpeed - SPEED_PRIORITY * Math.max(0, speedError - SPEED_MARGIN) - flight.verticalSpeed;
  memo.throttle = clamp((Number.isFinite(memo.throttle) ? memo.throttle : 0.55) + 0.015 * speedError * dt, 0.1, 0.9);
  return {
    roll: clamp(0.05 * (bank - flight.roll), -0.6, 0.6),
    // Damped by the pitch rate (rad/s): the floats' pitch inertia would make the loop hunt.
    pitch: clamp(0.08 * climbError - 0.6 * (Number.isFinite(flight.angularVelocity?.x) ? flight.angularVelocity.x : 0), -0.45, 0.45),
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

/** Water the floats can run on at (x, z): open water at least MIN_DEPTH deep. */
function runnable(api, x, z) {
  if (!api.waterQuery.isWater(x, z)) return false;
  return api.waterQuery.heightAt(x, z) - api.world.groundHeight(x, z) >= MIN_DEPTH;
}

/** Distance (m) from (x, z) along a heading over runnable water, at most MAX_CHORD. */
function waterAhead(api, x, z, heading) {
  const [dx, dz] = headingVector(heading);
  let distance = 0;
  while (distance < MAX_CHORD && runnable(api, x + dx * distance, z + dz * distance)) distance += SHORE_STEP;
  return distance;
}

/**
 * How far (m) the ground along a heading from (x, z) stands above a path that runs level with the
 * water (`level`) for `flat` m and then rises `gradient` m per m (negative: the path clears it).
 */
function pathObstruction(api, x, z, heading, level, flat, gradient) {
  const [dx, dz] = headingVector(heading);
  let worst = -Infinity;
  for (let distance = 0; distance <= PATH_RANGE; distance += 25) {
    const ground = api.world.groundHeight(x + dx * distance, z + dz * distance) - level;
    worst = Math.max(worst, ground - Math.max(0, distance - flat) * gradient);
  }
  return worst;
}

/**
 * The circuit plan from the start: the takeoff heading (the longest open chord into the wind with the
 * most clearance under the climb-out and the final), where the run starts (a taxi back when the water ahead is short),
 * the touchdown point and the side of the circuit with the lower ground.
 */
function planCircuit(api) {
  const start = api.player.position;
  const level = api.waterQuery.heightAt(start.x, start.z);
  const wind = api.wind && typeof api.wind.ambientAt === 'function' ? api.wind.ambientAt({ x: start.x, y: level + 10, z: start.z }) : { speed: 0, fromDegrees: 0 };
  let best = null;
  for (let index = 0; index < SEARCH_HEADINGS; index++) {
    const heading = (index * 360) / SEARCH_HEADINGS;
    const ahead = waterAhead(api, start.x, start.z, heading);
    const behind = waterAhead(api, start.x, start.z, heading + 180);
    const headwind = wind.speed * Math.cos(headingError(heading, wind.fromDegrees) * DEG);
    const back = clamp(RUN_NEEDED - ahead, 0, Math.max(0, behind - BACK_MARGIN));
    const run = ahead + back;
    // The climb-out from the run's start and the final down to it (the touchdown point).
    const [dx, dz] = headingVector(heading);
    const runX = start.x - dx * back;
    const runZ = start.z - dz * back;
    const obstruction = Math.max(
      pathObstruction(api, runX, runZ, heading, level, Math.min(run, LIFTOFF), CLIMB_GRADIENT),
      pathObstruction(api, runX, runZ, heading + 180, level, 0, Math.tan(CIRCUIT.glide)),
    );
    const score = Math.min(run, RUN_NEEDED) + HEADWIND_METRES * headwind - OBSTRUCTION_METRES * Math.max(0, obstruction + CLEARANCE_MARGIN) - (run < RUN_MINIMUM ? 1000 : 0);
    if (!best || score > best.score) best = { heading, ahead, behind, back, run, obstruction, headwind, score };
  }
  const [dx, dz] = headingVector(best.heading);
  const back = best.back;
  const runStart = { x: start.x - dx * back, z: start.z - dz * back };
  // The circuit turns to the side whose downwind leg (400 m off the chord) has the lower ground.
  let side = 1;
  let lowest = Infinity;
  for (const candidate of [1, -1]) {
    let highest = -Infinity;
    for (let along = -CIRCUIT.base; along <= CIRCUIT.upwind; along += 100) {
      const x = runStart.x + dx * along - dz * candidate * DOWNWIND_OFFSET;
      const z = runStart.z + dz * along + dx * candidate * DOWNWIND_OFFSET;
      highest = Math.max(highest, api.world.groundHeight(x, z));
    }
    if (highest < lowest) {
      lowest = highest;
      side = candidate;
    }
  }
  return {
    ...best,
    level,
    direction: [dx, dz],
    runStart,
    side,
    aim: { x: runStart.x + dx * TOUCHDOWN_AFTER_START, z: runStart.z + dz * TOUCHDOWN_AFTER_START },
    fix: { x: runStart.x + dx * (TOUCHDOWN_AFTER_START - CIRCUIT.fix), z: runStart.z + dz * (TOUCHDOWN_AFTER_START - CIRCUIT.fix) },
  };
}

/** The downwind leg flies this far (m) off the chord; the legs steer this many degrees per m off their line. */
const DOWNWIND_OFFSET = 400;
const TRACK_GAIN = 0.08;
const TRACK_LIMIT = 35;

/** How far (m) the craft is to the right of the chord (seen along the takeoff heading). */
function acrossChord(api, plan) {
  const position = api.player.position;
  return -(position.x - plan.runStart.x) * plan.direction[1] + (position.z - plan.runStart.z) * plan.direction[0];
}

/**
 * The heading that flies a leg parallel to the chord (outbound: along the takeoff heading, else back)
 * at `offset` m to the right of it, steering back onto the line against the wind's drift.
 */
function legHeading(api, plan, offset, outbound) {
  const correction = clamp(TRACK_GAIN * (offset - acrossChord(api, plan)), -TRACK_LIMIT, TRACK_LIMIT);
  return wrapDegrees(outbound ? plan.heading + correction : plan.heading + 180 - correction);
}

/** How far (m) the craft is along the chord from the run's start (negative behind it). */
function alongChord(api, plan) {
  const position = api.player.position;
  return (position.x - plan.runStart.x) * plan.direction[0] + (position.z - plan.runStart.z) * plan.direction[1];
}

/** The vertical speed (m/s) that tracks the glide slope to the touchdown point, clear of the ground under it. */
function glideVerticalSpeed(api, plan) {
  const player = api.player;
  const distance = Math.hypot(plan.aim.x - player.position.x, plan.aim.z - player.position.z);
  let target = plan.level + 2.2 + distance * Math.tan(CIRCUIT.glide);
  if (distance > SHORT_FINAL) target = Math.max(target, api.world.groundHeight(player.position.x, player.position.z) + TERRAIN_CLEARANCE);
  const sink = CIRCUIT.approachSpeed * Math.sin(CIRCUIT.glide);
  return clamp(-sink + 0.25 * (target - player.position.y), -2.5, 1.5);
}

/**
 * The final: toward the fix on the extended chord, then the touchdown point on the glide slope; the
 * flare over the water; power off and stick neutral once the floats are on the water. Over land it
 * never sinks below LAND_CLEARANCE (the shore can stand above the water).
 */
function flyFinal(api, dt, plan) {
  const flight = api.flight;
  const player = api.player;
  const memo = api.memo;
  if (memo.touched || flight.onGround) {
    memo.touched = true;
    // Straight ahead on the touchdown heading (a turn on the step at speed would dig a float in and roll
    // it onto a wingtip) with the power off. On the water the stick is neutral, full back below flying
    // airspeed (the heels dig in); off a skip it holds the landing attitude so the floats come back
    // down flat instead of nose first.
    if (!Number.isFinite(memo.touchdownHeading)) memo.touchdownHeading = flight.heading;
    const speed = Math.abs(api.craftState.waterSpeed);
    const pitchRate = Number.isFinite(flight.angularVelocity?.x) ? flight.angularVelocity.x : 0;
    let pitch = 0;
    if (!flight.onGround) pitch = clamp(0.06 * (SKIP_ATTITUDE - player.pitch) - 0.6 * pitchRate, -0.45, 0.45);
    else if (flight.airspeed < PLOW_SPEED && speed > 4) pitch = 0.9;
    // A skip that starts to drop fast (a gust's sink) gets a burst of power to cushion it.
    const throttle = flight.onGround ? 0 : clamp(0.3 * (-flight.verticalSpeed - 1), 0, 0.6);
    return { ...steerWater(api, dt, memo.touchdownHeading, throttle), pitch };
  }
  if (!memo.passedFix && (Math.hypot(plan.fix.x - player.position.x, plan.fix.z - player.position.z) < 200 || alongChord(api, plan) > TOUCHDOWN_AFTER_START - CIRCUIT.fix + 100)) memo.passedFix = true;
  const target = memo.passedFix ? plan.aim : plan.fix;
  const overWater = api.waterQuery.isWater(player.position.x, player.position.z);
  const flare = overWater && flight.agl < FLARE_HEIGHT;
  let verticalSpeed = flare ? -Math.max(0.4, 0.3 * (flight.agl - 2.2)) : glideVerticalSpeed(api, plan);
  if (!overWater && flight.agl < LAND_CLEARANCE) verticalSpeed = Math.max(verticalSpeed, 0.5);
  // Half the gust factor on top of the approach speed, so a lull near the water never stalls it.
  const gusts = clamp(Number.isFinite(flight.turbulence) ? flight.turbulence : 0, 0, 1);
  const controls = flyAir(api, dt, { heading: bearing(player.position.x, player.position.z, target.x, target.z), verticalSpeed, airspeed: CIRCUIT.approachSpeed + GUST_MARGIN * gusts });
  // The flare bleeds the speed off: little power, none in the last few metres (in smooth air; in
  // gusts more power is allowed against a sinking gust, and some stays on until the floats touch).
  if (flare) controls.throttle = Math.min(controls.throttle, flight.agl < 4.5 ? 0.4 * gusts : 0.3 + 0.4 * gusts);
  return controls;
}

/** Presses an action once (one frame), keyed so it fires only once per run. */
function press(api, key, action, actions) {
  if (api.once(key)) actions.push(action);
}

/** The circuit's vertical speed: climb to circuit height, then hold it. */
function circuitClimb(api) {
  return api.flight.agl < CIRCUIT.height ? CIRCUIT.climbRate : clamp(0.1 * (CIRCUIT.height - api.flight.agl), -1.5, 1.5);
}

/** The water circuit (both water scenarios): survey, taxi, run, circuit, final. */
function waterCircuitScript(t, api) {
  const memo = api.memo;
  const dt = stepSeconds(api);
  const actions = [];
  const flight = api.flight;
  const player = api.player;
  if (!memo.plan) {
    memo.plan = planCircuit(api);
    const toRunStart = Math.hypot(memo.plan.runStart.x - player.position.x, memo.plan.runStart.z - player.position.z);
    memo.phase = toRunStart > 10 ? 'taxi' : 'turn';
    memo.turned = 0;
  }
  const plan = memo.plan;
  const previousHeading = Number.isFinite(memo.headingSeen) ? memo.headingSeen : flight.heading;
  memo.turned += Math.abs(headingError(flight.heading, previousHeading));
  memo.headingSeen = flight.heading;
  const along = alongChord(api, plan);
  let controls;
  switch (memo.phase) {
    case 'taxi': {
      if (api.craftState.waterRudders !== true) press(api, 'ruddersDown', 'craftAbility', actions);
      const toStart = Math.hypot(plan.runStart.x - player.position.x, plan.runStart.z - player.position.z);
      controls = steerWater(api, dt, bearing(player.position.x, player.position.z, plan.runStart.x, plan.runStart.z), toStart > 40 ? TAXI_THROTTLE.cruise : TAXI_THROTTLE.slow);
      if (toStart < 10) memo.phase = 'turn';
      break;
    }
    case 'turn':
      if (api.craftState.waterRudders !== true) press(api, 'ruddersDownTurn', 'craftAbility', actions);
      controls = steerWater(api, dt, plan.heading, TAXI_THROTTLE.turn);
      // The run's own steering finishes lining up: full power from 30 degrees off.
      if (Math.abs(headingError(plan.heading, flight.heading)) < 30) memo.phase = 'run';
      break;
    case 'run':
      if (api.craftState.waterRudders === true) press(api, 'ruddersUp', 'craftAbility', actions);
      else if (api.once('flaps1')) actions.push('flapsDown');
      else if (api.once('flaps2')) actions.push('flapsDown');
      controls = steerWater(api, dt, plan.heading, 1);
      // Hands off on the step (the water assist holds the planing trim: pulling early drags the heels),
      // then a firm pull at the liftoff speed (flaps 2) flies it off.
      if (flight.airspeed > ROTATE_SPEED) controls.pitch = 0.45;
      if (!flight.onGround && flight.agl > 3) memo.phase = 'upwind';
      break;
    case 'upwind':
      // The climb-out at full power and the flaps-2 climb speed (airspeed first in the gusts); flaps up
      // a notch once clear of the shore and fast enough, then the circuit speed.
      if (!memo.flapsUp && flight.agl > 25 && flight.airspeed > 28) {
        memo.flapsUp = true;
        actions.push('flapsUp');
      }
      controls = flyAir(api, dt, {
        heading: legHeading(api, plan, 0, true),
        verticalSpeed: memo.flapsUp ? circuitClimb(api) : Math.min(circuitClimb(api), CIRCUIT.climbOutRate),
        airspeed: memo.flapsUp ? CIRCUIT.cruiseSpeed : CIRCUIT.climbOutSpeed,
      });
      // Full power until the flaps come up: the stick holds the airspeed and the climb takes the rest.
      if (!memo.flapsUp) controls.throttle = 1;
      if (along > CIRCUIT.upwind && flight.agl > 40) memo.phase = 'crosswind';
      break;
    case 'crosswind':
      controls = flyAir(api, dt, { heading: wrapDegrees(plan.heading + 90 * plan.side), verticalSpeed: circuitClimb(api), airspeed: CIRCUIT.cruiseSpeed });
      if (Math.abs(headingError(plan.heading + 90 * plan.side, flight.heading)) < 15) memo.phase = 'downwind';
      break;
    case 'downwind':
      controls = flyAir(api, dt, { heading: legHeading(api, plan, plan.side * DOWNWIND_OFFSET, false), verticalSpeed: circuitClimb(api), airspeed: CIRCUIT.cruiseSpeed });
      if (along < TOUCHDOWN_AFTER_START - CIRCUIT.base) memo.phase = 'final';
      break;
    default:
      // Full flaps for the final (from the climb's notch 1: two presses, a frame apart).
      if (api.once('flapsFinal1')) actions.push('flapsDown');
      else if (api.once('flapsFinal2')) actions.push('flapsDown');
      controls = flyFinal(api, dt, plan);
      if (memo.touched && Math.abs(api.craftState.waterSpeed) < 6 && api.craftState.waterRudders !== true) press(api, 'ruddersDownAfter', 'craftAbility', actions);
  }
  return { ...controls, actions };
}

/** The landed event of this run on the water, or null. */
function waterLanding(api) {
  const landing = api.events.last('landed');
  return landing && landing.surface === 'water' ? landing : null;
}

// ---- Wheels down on the water ---------------------------------------------------------------------
/**
 * The nose-over's approach heading: the one most into the wind with open water (no shoals or islets)
 * for NOSE_OVER_WATER m ahead of the start, checked along the track the wind's drift will fly.
 */
function approachHeading(api) {
  const position = api.player.position;
  const wind = api.wind && typeof api.wind.ambientAt === 'function' ? api.wind.ambientAt({ x: position.x, y: position.y, z: position.z }) : { speed: 0, fromDegrees: 0 };
  // The wind's drift per metre flown (blowing toward fromDegrees + 180) at the approach speed.
  const [windX, windZ] = headingVector(wind.fromDegrees + 180);
  const drift = wind.speed / CIRCUIT.approachSpeed;
  let best = api.start.heading;
  let bestScore = -Infinity;
  for (let index = 0; index < SEARCH_HEADINGS; index++) {
    const heading = (index * 360) / SEARCH_HEADINGS;
    const [dx, dz] = headingVector(heading);
    let clear = true;
    for (let distance = 0; distance <= NOSE_OVER_WATER && clear; distance += 25) {
      clear = runnable(api, position.x + (dx + windX * drift) * distance, position.z + (dz + windZ * drift) * distance);
    }
    const score = (clear ? 0 : -1000) + wind.speed * Math.cos(headingError(heading, wind.fromDegrees) * DEG) + 0.01 * Math.cos(headingError(heading, api.start.heading) * DEG);
    if (score > bestScore) {
      bestScore = score;
      best = heading;
    }
  }
  return best;
}

function noseOverScript(t, api) {
  const dt = stepSeconds(api);
  const actions = [];
  const memo = api.memo;
  if (!Number.isFinite(memo.heading)) memo.heading = approachHeading(api);
  if (t > 0.3 && api.once('flaps1')) actions.push('flapsDown');
  else if (t > 0.6 && api.once('flaps2')) actions.push('flapsDown');
  else if (t > 0.9 && api.once('flaps3')) actions.push('flapsDown');
  else if (t > 1.2) press(api, 'gearDown', 'gearToggle', actions);
  // Over open water, slowing to the approach speed (plus the gust margin), then down at 1.5 m/s and a
  // flare onto the water.
  const agl = api.flight.agl;
  const verticalSpeed = t < 6 ? 0 : agl < FLARE_HEIGHT ? -Math.max(0.4, 0.3 * (agl - 2.2)) : -1.5;
  const gusts = clamp(Number.isFinite(api.flight.turbulence) ? api.flight.turbulence : 0, 0, 1);
  return { ...flyAir(api, dt, { heading: memo.heading, verticalSpeed, airspeed: CIRCUIT.approachSpeed + GUST_MARGIN * gusts }), actions };
}

export default Object.freeze({
  craft: 'seaplane',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'seaplane-ocean',
      views: ['third', 'first'],
      seed: 'CRAFT-1',
      world: 'waters',
      start: { at: OCEAN_START, mode: 'water', heading: 14 },
      seconds: 320,
      script: waterCircuitScript,
      checks: [
        { id: 'afloat', label: 'starts afloat on the ocean, wheels up', until: 2, test: (api) => api.flight.onWater && api.craftState.onWater && api.flight.gear.down === false && api.waterQuery.isOcean(api.player.position.x, api.player.position.z) },
        { id: 'step', label: 'over the hump and onto the step', until: 80, test: (api) => api.craftState.onStep === true },
        { id: 'spray', label: 'spray off the floats on the run', until: 80, test: (api) => api.craftState.spray > 0.3 },
        { id: 'airborne', label: 'takes off from the ocean and climbs out (40 m up)', until: 130, test: (api) => !api.flight.onGround && api.agl() > 40 },
        { id: 'landed', label: "lands back on the ocean (landed, surface 'water', open ocean)", from: 30, test: (api) => { const landing = waterLanding(api); return Boolean(landing) && api.waterQuery.isOcean(landing.position.x, landing.position.z); } },
        { id: 'stopped', label: 'slows to taxi speed afloat after the landing', from: 30, test: (api) => Boolean(waterLanding(api)) && api.craftState.onWater && Math.abs(api.craftState.waterSpeed) < 6 },
      ],
    }),
    Object.freeze({
      id: 'seaplane-lake',
      views: ['third', 'first'],
      seed: 'CRAFT-1',
      world: 'waters',
      start: { at: LAKE_START, mode: 'water', craftState: { waterRudders: true } },
      seconds: 330,
      script: waterCircuitScript,
      checks: [
        { id: 'afloat', label: 'starts afloat on a lake', until: 2, test: (api) => api.flight.onWater && api.waterQuery.isWater(api.player.position.x, api.player.position.z) && !api.waterQuery.isOcean(api.player.position.x, api.player.position.z) },
        { id: 'waterRudders', label: 'taxis and turns on the water rudders (more than 120 degrees of heading)', until: 150, test: (api) => api.memo.phase === 'run' && api.memo.turned > 120 },
        { id: 'airborne', label: 'takes off from the lake and climbs out (40 m up)', until: 220, test: (api) => !api.flight.onGround && api.agl() > 40 },
        { id: 'landed', label: "lands back on the lake (landed, surface 'water', not the ocean)", from: 30, test: (api) => { const landing = waterLanding(api); return Boolean(landing) && api.waterQuery.isWater(landing.position.x, landing.position.z) && !api.waterQuery.isOcean(landing.position.x, landing.position.z); } },
        { id: 'stopped', label: 'slows to taxi speed on the lake', from: 30, test: (api) => Boolean(waterLanding(api)) && api.craftState.onWater && Math.abs(api.craftState.waterSpeed) < 6 },
      ],
    }),
    Object.freeze({
      id: 'seaplane-nose-over',
      views: ['third'],
      seed: 'CRAFT-1',
      world: 'waters',
      start: { at: OCEAN_START, mode: 'air', agl: 40, speed: 36, heading: 14 },
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
