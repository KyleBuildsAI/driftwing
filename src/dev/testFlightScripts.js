// Scripted flights for the ?test=1 flight-test harness: one script per craft.
//
// Every script flies the craft through its real control path: the autopilot (flight.setAutopilot,
// which flies through the PID control stage), scripted ControlState deflections (stick, throttle,
// toe brakes) and flight actions (ControlState.actions: flaps, craft ability, relaunch, chute).
// Step times are fractions of the whole run (warmup included), so a shortened run still performs
// every manoeuvre.
//
// A step's run(pilot) receives the harness pilot (see createPilot in testHarness.js):
//   pilot.autopilot({ enabled, headingOffset, altitudeAgl, speed })
//   pilot.stick({ roll, pitch, yaw })   deflections -1..1 held until changed (null releases an axis)
//   pilot.throttle(value | null)        lever 0..1 (ControlState.throttle)
//   pilot.brakes(value | null)          both toe brakes 0..1 (spoilers / airbrake in the air)
//   pilot.action(id)                    one press of a flight-owned action
//   pilot.relaunch()                    the craft's relaunch
//   pilot.autopilotHeading(heading)     turns the engaged autopilot to a compass heading (its height kept)
//   pilot.steer(fn | null)              fn(view, pilot) runs every frame until replaced (view: { state,
//                                       wind, seen }): a closed-loop pilot such as the soak's lift seeker
// Sign conventions: pitch +1 pulls (nose up), roll +1 banks right, yaw +1 yaws right.
//
// Each script also lists checks: the observations (collected every frame by the harness) that
// prove the manoeuvres really happened. They are reported as script coverage. A check's test(seen,
// seconds) gets the run length, so its time thresholds scale down for shortened runs (testSeconds).
import { headingFromVector } from '../core/util.js';

/** Autopilot cruise: current heading, a safe height above the ground, the craft's own cruise speed. */
function cruise(pilot, headingOffset = 0) {
  pilot.stick({ roll: null, pitch: null, yaw: null });
  pilot.autopilot({ enabled: true, headingOffset, altitudeAgl: 380 });
}

function handsOff(pilot) {
  pilot.autopilot({ enabled: false });
  pilot.stick({ roll: 0, pitch: 0, yaw: 0 });
}

/** A time threshold: its full length on a 60 s run (63 s with warmup), scaled down for shorter runs. */
function seconds(full, runSeconds) {
  return Math.min(full, (full * runSeconds) / 63);
}

const CHECK = Object.freeze({
  autopilot: { id: 'autopilot', label: 'autopilot flew 5 s', test: (seen, run) => seen.autopilotSeconds >= seconds(5, run) },
  bank: { id: 'bank', label: 'manual bank past 20 deg', test: (seen) => seen.maxBank >= 20 },
  hover: { id: 'hover', label: 'hovered 2 s (ground speed under 3 m/s)', test: (seen, run) => seen.hoverSeconds >= seconds(2, run) },
  translate: { id: 'translate', label: 'hover moves above 6 m/s', test: (seen, run) => seen.translateSeconds >= seconds(1, run) },
  relaunch: { id: 'relaunch', label: 'relaunch', test: (seen) => seen.relaunches >= 1 },
  dive: { id: 'dive', label: 'dive below -20 deg pitch', test: (seen) => seen.minPitch <= -20 },
});

/**
 * Fixed wing: PID autopilot, a manual roll into a bank at 100 % assists (roll input and length
 * suit the craft's roll rate), hands off, then the craft's own systems.
 */
function simFixedWing(extraSteps, extraChecks, { roll = 0.5, rollEnd = 0.54 } = {}) {
  return Object.freeze({
    steps: [
      { at: 0, label: 'autopilot cruise', run: (pilot) => cruise(pilot) },
      { at: 0.3, label: 'autopilot turn 90 deg right', run: (pilot) => cruise(pilot, 90) },
      { at: 0.48, label: 'autopilot off, manual bank right', run: (pilot) => { handsOff(pilot); pilot.stick({ roll, pitch: 0.1, yaw: 0.05 }); } },
      { at: rollEnd, label: 'hands off (assists hold the attitude)', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
      ...extraSteps,
      { at: 0.8, label: 'autopilot cruise, turn back', run: (pilot) => cruise(pilot, -90) },
    ],
    checks: [CHECK.autopilot, CHECK.bank, ...extraChecks],
  });
}

const GLIDER = simFixedWing([
  { at: 0.6, label: 'spoilers out (both toe brakes)', run: (pilot) => pilot.brakes(1) },
  { at: 0.7, label: 'spoilers in', run: (pilot) => pilot.brakes(null) },
], [{ id: 'spoilers', label: 'spoilers deployed', test: (seen) => seen.maxAirbrake >= 0.5 }]);

// One action press per step: presses in the same frame count once (ControlState.actions is a set).
const BUSHPLANE = simFixedWing([
  { at: 0.58, label: 'throttle 90 %, flaps down one notch', run: (pilot) => { pilot.throttle(0.9); pilot.action('flapsDown'); } },
  { at: 0.61, label: 'flaps down a second notch', run: (pilot) => pilot.action('flapsDown') },
  { at: 0.7, label: 'flaps up one notch, throttle 70 %', run: (pilot) => { pilot.action('flapsUp'); pilot.throttle(0.7); } },
  { at: 0.73, label: 'flaps up', run: (pilot) => pilot.action('flapsUp') },
], [{ id: 'flaps', label: 'flaps to notch 2', test: (seen) => seen.maxFlapNotch >= 2 }]);

// The jet rolls far faster than the others (no bank protection by design): a short, light input.
const JET = simFixedWing([
  { at: 0.56, label: 'full throttle, afterburner on (craft ability)', run: (pilot) => { pilot.throttle(1); pilot.action('craftAbility'); } },
  { at: 0.74, label: 'afterburner off, throttle 70 %', run: (pilot) => { pilot.action('craftAbility'); pilot.throttle(0.7); } },
], [{ id: 'afterburner', label: 'afterburner lit 3 s', test: (seen, run) => seen.afterburnerSeconds >= seconds(3, run) }], { roll: 0.25, rollEnd: 0.5 });

// The aerobatic rolls at about 400 deg/s (no bank protection at any level): a short, light input. Then
// the display smoke on, a colour change and off again.
const AEROBATIC = simFixedWing([
  { at: 0.58, label: 'smoke on (craft ability)', run: (pilot) => pilot.action('craftAbility') },
  { at: 0.64, label: 'smoke colour (second ability)', run: (pilot) => pilot.action('craftAbilityAlt') },
  { at: 0.74, label: 'smoke off', run: (pilot) => pilot.action('craftAbility') },
], [{ id: 'smoke', label: 'smoke on 3 s', test: (seen, run) => seen.smokeSeconds >= seconds(3, run) }], { roll: 0.15, rollEnd: 0.5 });

// The seaplane: the bush plane's flap work, and the amphibian wheels down and up again in flight.
const SEAPLANE = simFixedWing([
  { at: 0.58, label: 'throttle 90 %, flaps down one notch', run: (pilot) => { pilot.throttle(0.9); pilot.action('flapsDown'); } },
  { at: 0.61, label: 'flaps down a second notch', run: (pilot) => pilot.action('flapsDown') },
  { at: 0.64, label: 'amphibian wheels down', run: (pilot) => pilot.action('gearToggle') },
  { at: 0.7, label: 'flaps up one notch, throttle 70 %', run: (pilot) => { pilot.action('flapsUp'); pilot.throttle(0.7); } },
  { at: 0.73, label: 'flaps up', run: (pilot) => pilot.action('flapsUp') },
  { at: 0.76, label: 'amphibian wheels up', run: (pilot) => pilot.action('gearToggle') },
], [{ id: 'flaps', label: 'flaps to notch 2', test: (seen) => seen.maxFlapNotch >= 2 }]);

/** Hover craft (helicopter, FPV drone at 100 % assists): hover, stick moves, then autopilot. */
const HOVER = Object.freeze({
  steps: [
    { at: 0, label: 'hands-off hover (lever centred)', run: (pilot) => { handsOff(pilot); pilot.throttle(0.5); } },
    { at: 0.14, label: 'stick forward', run: (pilot) => pilot.stick({ roll: 0, pitch: -0.45, yaw: 0 }) },
    { at: 0.26, label: 'stick back (stop)', run: (pilot) => pilot.stick({ roll: 0, pitch: 0.35, yaw: 0 }) },
    { at: 0.32, label: 'sideways right', run: (pilot) => pilot.stick({ roll: 0.4, pitch: 0, yaw: 0 }) },
    { at: 0.4, label: 'pedal turn left', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: -0.5 }) },
    { at: 0.46, label: 'climb (lever up)', run: (pilot) => { pilot.stick({ roll: 0, pitch: 0, yaw: 0 }); pilot.throttle(0.68); } },
    { at: 0.54, label: 'lever centred, hover', run: (pilot) => pilot.throttle(0.5) },
    { at: 0.62, label: 'autopilot cruise', run: (pilot) => cruise(pilot) },
    { at: 0.82, label: 'autopilot turn 90 deg left', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [CHECK.hover, CHECK.translate, CHECK.autopilot],
});

/** Wingsuit: glide autopilot, a dive and pull-out, a peak relaunch, then the canopy. */
const WINGSUIT = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.22, label: 'autopilot off, dive (push)', run: (pilot) => { handsOff(pilot); pilot.stick({ roll: 0, pitch: -0.7, yaw: 0 }); } },
    { at: 0.26, label: 'hands off (assists recover)', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.4, label: 'relaunch from the nearest peak', run: (pilot) => pilot.action('relaunch') },
    { at: 0.46, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.68, label: 'autopilot off, deploy the chute', run: (pilot) => { handsOff(pilot); pilot.action('chuteDeploy'); } },
    { at: 0.8, label: 'canopy toggles: right turn', run: (pilot) => pilot.stick({ roll: 0.4, pitch: 0, yaw: 0 }) },
    { at: 0.88, label: 'canopy toggles released', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
  ],
  checks: [CHECK.autopilot, CHECK.dive, CHECK.relaunch, { id: 'canopy', label: 'canopy open', test: (seen) => seen.canopy }],
});

/** Paraglider: heading autopilot, a weight-shift turn, big ears in and out (B), a peak relaunch. */
const PARAGLIDER = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.3, label: 'autopilot off, weight shift right (turn coordination adds the brake)', run: (pilot) => { handsOff(pilot); pilot.stick({ roll: 0.8, pitch: 0, yaw: 0 }); } },
    { at: 0.42, label: 'hands off', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.5, label: 'big ears in (B)', run: (pilot) => pilot.action('airbrake') },
    { at: 0.62, label: 'big ears out (B)', run: (pilot) => pilot.action('airbrake') },
    { at: 0.72, label: 'relaunch from the nearest peak', run: (pilot) => pilot.action('relaunch') },
    { at: 0.78, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
  ],
  checks: [CHECK.autopilot, CHECK.bank, CHECK.relaunch, { id: 'bigEars', label: 'big ears folded', test: (seen) => seen.maxAirbrake >= 0.5 }],
});

/**
 * Hot air balloon (100 % assists): the autopilot's altitude, hands off under the altitude hold, the
 * burner lever, the rotation vents, a vent pull, then the autopilot again. It drifts with the wind
 * throughout: there is no bank to hold.
 */
const BALLOON = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot altitude', run: (pilot) => cruise(pilot) },
    { at: 0.28, label: 'autopilot off, hands off (the altitude hold)', run: (pilot) => { handsOff(pilot); pilot.throttle(0); } },
    { at: 0.36, label: 'burner lever full', run: (pilot) => pilot.throttle(1) },
    { at: 0.46, label: 'burner lever closed', run: (pilot) => pilot.throttle(0) },
    { at: 0.5, label: 'rotation vents right', run: (pilot) => pilot.stick({ roll: 0.8, pitch: 0, yaw: 0 }) },
    { at: 0.62, label: 'rotation vents closed', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.66, label: 'parachute vent pull', run: (pilot) => pilot.action('craftAbilityAlt') },
    { at: 0.76, label: 'autopilot altitude', run: (pilot) => cruise(pilot) },
  ],
  checks: [CHECK.autopilot, { id: 'vent', label: 'parachute vent opened', test: (seen) => seen.maxAirbrake >= 0.5 }],
});

/** Airship: autopilot cruise and turn, then the elevators nose it down and the rudders turn it by hand. */
const AIRSHIP = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot cruise', run: (pilot) => cruise(pilot) },
    { at: 0.3, label: 'autopilot turn 90 deg right', run: (pilot) => cruise(pilot, 90) },
    { at: 0.44, label: 'autopilot off, nose down and rudder left', run: (pilot) => { handsOff(pilot); pilot.stick({ roll: 0, pitch: -1, yaw: -0.6 }); } },
    { at: 0.66, label: 'hands off (assists level it and hold the heading)', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.8, label: 'autopilot cruise, turn back', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [CHECK.autopilot, { id: 'noseDown', label: 'pitched 2 deg nose down by hand (an airship pitches slowly)', test: (seen) => seen.minPitch <= -2 }],
});

/** Eagle / dragon: autopilot cruise (it works the flap power), a manual bank, a stoop and pull-out. */
const EAGLE = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot cruise (the autopilot works the flap power)', run: (pilot) => cruise(pilot) },
    { at: 0.3, label: 'autopilot turn 90 deg right', run: (pilot) => cruise(pilot, 90) },
    { at: 0.48, label: 'autopilot off, manual bank right', run: (pilot) => { handsOff(pilot); pilot.throttle(0.3); pilot.stick({ roll: 0.5, pitch: 0.1, yaw: 0 }); } },
    { at: 0.53, label: 'hands off (assists level the wings)', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.6, label: 'stoop: stick pushed hard, the wings fold', run: (pilot) => { pilot.throttle(0); pilot.stick({ roll: 0, pitch: -0.9, yaw: 0 }); } },
    { at: 0.66, label: 'pull out, wings out', run: (pilot) => pilot.stick({ roll: 0, pitch: 0.3, yaw: 0 }) },
    { at: 0.72, label: 'hands off, flapping', run: (pilot) => { pilot.stick({ roll: 0, pitch: 0, yaw: 0 }); pilot.throttle(0.6); } },
    { at: 0.8, label: 'autopilot cruise, turn back', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [CHECK.autopilot, CHECK.bank, CHECK.dive],
});

// The spaceplane: a rocket on the throttle and attitude hold on the second ability, the speed brake on
// both toe brakes; its roll is quick on the elevons and the jets, so a short, light input.
const SPACEPLANE = simFixedWing([
  { at: 0.56, label: 'full rocket thrust, attitude hold on (second ability)', run: (pilot) => { pilot.throttle(1); pilot.action('craftAbilityAlt'); } },
  { at: 0.64, label: 'attitude hold off, thrust back, speed brake out', run: (pilot) => { pilot.action('craftAbilityAlt'); pilot.throttle(0.07); pilot.brakes(1); } },
  { at: 0.72, label: 'speed brake in', run: (pilot) => pilot.brakes(null) },
], [{ id: 'speedBrake', label: 'speed brake out', test: (seen) => seen.maxAirbrake >= 0.5 }], { roll: 0.25, rollEnd: 0.5 });

const SCRIPTS = Object.freeze({
  glider: GLIDER,
  bushplane: BUSHPLANE,
  jet: JET,
  helicopter: HOVER,
  wingsuit: WINGSUIT,
  fpv: HOVER,
  aerobatic: AEROBATIC,
  seaplane: SEAPLANE,
  // The tiltrotor flies the hover script in helicopter mode; its autopilot cruise converts to airplane mode.
  tiltrotor: HOVER,
  paraglider: PARAGLIDER,
  balloon: BALLOON,
  airship: AIRSHIP,
  eagle: EAGLE,
  spaceplane: SPACEPLANE,
});

// ---- The soak's legs (testPlan=soak, contract k.5) ---------------------------------------------------
// A soak leg flies one craft for two runs in a row (third person, then first person: the view swap)
// without a reset between them, so step times are fractions of the whole leg. Craft without a leg
// script of their own fly their flight-test script over the leg. Each leg flies its craft the way a
// player would: the gliders seek lift, the balloon burns, the spaceplane climbs.

/** How far (m) the lift seeker looks for a thermal, and how often (s) it looks again. */
const LIFT_SEARCH_RADIUS = 2500;
const LIFT_RESEARCH_SECONDS = 6;
/** The circle (m) flown around a thermal's core, and the reach (m) inside which the seeker circles. */
const LIFT_CIRCLE_RADIUS = 60;
const LIFT_CIRCLING_REACH = 160;
/** The seeker turns the autopilot once a second. */
const LIFT_STEER_SECONDS = 1;

/**
 * A closed-loop lift seeker for the gliders (pilot.steer): every LIFT_RESEARCH_SECONDS it asks the
 * WindField for the thermals within LIFT_SEARCH_RADIUS and picks the strongest near one (rising at
 * least 1 m/s); then once a second it turns the engaged autopilot toward the core, and inside
 * LIFT_CIRCLING_REACH onto a circle around it. With no thermal in reach (night, the sea) it glides on.
 * It books its searches, the thermals found and the seconds circled into the run's observations.
 */
function createLiftSeeker() {
  const memo = { x: 0, z: 0, found: false, searchedAt: -Infinity, steeredAt: -Infinity };
  const best = { x: 0, z: 0, fromX: 0, fromZ: 0, score: -Infinity };
  const visit = (thermal) => {
    if (!(thermal.strength >= 1)) return;
    const score = thermal.strength - Math.hypot(thermal.x - best.fromX, thermal.z - best.fromZ) / 500;
    if (score <= best.score) return;
    best.score = score;
    best.x = thermal.x;
    best.z = thermal.z;
  };
  return function seekLift(view, pilot) {
    const { state, wind, seen } = view;
    const now = state.time.elapsed;
    const position = state.player.position;
    if (now - memo.searchedAt >= LIFT_RESEARCH_SECONDS && wind && typeof wind.thermalsNear === 'function') {
      memo.searchedAt = now;
      best.score = -Infinity;
      best.fromX = position.x;
      best.fromZ = position.z;
      wind.thermalsNear(position.x, position.z, LIFT_SEARCH_RADIUS, visit);
      seen.liftSearches++;
      memo.found = best.score > -Infinity;
      if (memo.found) {
        memo.x = best.x;
        memo.z = best.z;
        seen.thermalsFound++;
      }
    }
    if (!memo.found || now - memo.steeredAt < LIFT_STEER_SECONDS) return;
    memo.steeredAt = now;
    const offsetX = position.x - memo.x;
    const offsetZ = position.z - memo.z;
    const distance = Math.hypot(offsetX, offsetZ);
    if (distance > LIFT_CIRCLING_REACH) {
      pilot.autopilotHeading(headingFromVector(-offsetX, -offsetZ));
      return;
    }
    // On the circle: the tangent (circling right), turning in when wide and out when tight.
    const correction = Math.min(60, Math.max(-60, (distance - LIFT_CIRCLE_RADIUS) * 0.8));
    pilot.autopilotHeading(headingFromVector(offsetX, offsetZ) + 90 + correction);
    seen.circlingSeconds += LIFT_STEER_SECONDS;
  };
}

function seekLift(pilot) {
  pilot.stick({ roll: null, pitch: null, yaw: null });
  pilot.steer(createLiftSeeker());
}

const LIFT_CHECK = Object.freeze({
  id: 'lift',
  label: `seeks lift: circles a thermal 15 s when one rises within ${LIFT_SEARCH_RADIUS / 1000} km, else glides on`,
  test: (seen) => seen.liftSearches > 0 && (seen.thermalsFound === 0 || seen.circlingSeconds >= 15),
});

/** Glider leg: a glide on the autopilot, the lift seeker, the spoilers, then on along the autopilot. */
const GLIDER_LEG = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.1, label: 'seek lift (thermals within 2.5 km)', run: (pilot) => seekLift(pilot) },
    { at: 0.6, label: 'stop seeking, spoilers out (both toe brakes)', run: (pilot) => { pilot.steer(null); pilot.brakes(1); } },
    { at: 0.68, label: 'spoilers in, autopilot glide', run: (pilot) => { pilot.brakes(null); cruise(pilot); } },
    { at: 0.82, label: 'autopilot turn 90 deg left', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [CHECK.autopilot, LIFT_CHECK, { id: 'spoilers', label: 'spoilers deployed', test: (seen) => seen.maxAirbrake >= 0.5 }],
});

/** Paraglider leg: a glide, the lift seeker, big ears in and out (B), then a glide on. */
const PARAGLIDER_LEG = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.08, label: 'seek lift (thermals within 2.5 km)', run: (pilot) => seekLift(pilot) },
    { at: 0.6, label: 'stop seeking, big ears in (B)', run: (pilot) => { pilot.steer(null); pilot.action('airbrake'); } },
    { at: 0.7, label: 'big ears out (B)', run: (pilot) => pilot.action('airbrake') },
    { at: 0.74, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
  ],
  checks: [CHECK.autopilot, LIFT_CHECK, { id: 'bigEars', label: 'big ears folded', test: (seen) => seen.maxAirbrake >= 0.5 }],
});

/** Balloon leg: the altitude autopilot, a long burn by hand, the rotation vents, a vent pull, a second burn. */
const BALLOON_LEG = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot altitude', run: (pilot) => cruise(pilot) },
    { at: 0.18, label: 'autopilot off, burner lever full', run: (pilot) => { handsOff(pilot); pilot.throttle(1); } },
    { at: 0.36, label: 'burner lever closed', run: (pilot) => pilot.throttle(0) },
    { at: 0.42, label: 'rotation vents right', run: (pilot) => pilot.stick({ roll: 0.8, pitch: 0, yaw: 0 }) },
    { at: 0.52, label: 'rotation vents closed', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.56, label: 'parachute vent pull', run: (pilot) => pilot.action('craftAbilityAlt') },
    { at: 0.64, label: 'burner lever full again', run: (pilot) => pilot.throttle(1) },
    { at: 0.74, label: 'burner lever released, autopilot altitude', run: (pilot) => { pilot.throttle(null); cruise(pilot); } },
  ],
  checks: [
    CHECK.autopilot,
    { id: 'burn', label: 'the burner heats the envelope 3 K', test: (seen) => seen.envelopeRise >= 3 },
    { id: 'vent', label: 'parachute vent opened', test: (seen) => seen.maxAirbrake >= 0.5 },
  ],
});

/**
 * Spaceplane leg: cruise, then the rocket at full thrust pulled into a climb and held there by the
 * attitude hold, then the thrust back with the speed brake out, and the autopilot brings it down.
 */
const SPACEPLANE_LEG = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot cruise', run: (pilot) => cruise(pilot) },
    { at: 0.12, label: 'autopilot off, full rocket thrust, pull up', run: (pilot) => { handsOff(pilot); pilot.throttle(1); pilot.stick({ roll: 0, pitch: 0.6, yaw: 0 }); } },
    { at: 0.17, label: 'hands off, attitude hold on (second ability): the climb', run: (pilot) => { pilot.stick({ roll: 0, pitch: 0, yaw: 0 }); pilot.action('craftAbilityAlt'); } },
    { at: 0.4, label: 'attitude hold off, thrust back, speed brake out', run: (pilot) => { pilot.action('craftAbilityAlt'); pilot.throttle(0.07); pilot.brakes(1); } },
    { at: 0.5, label: 'speed brake in, autopilot down to cruise', run: (pilot) => { pilot.brakes(null); pilot.throttle(null); cruise(pilot); } },
    { at: 0.8, label: 'autopilot turn 90 deg left', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [
    CHECK.autopilot,
    { id: 'climb', label: 'climbed 2000 m on the rocket', test: (seen) => seen.maxClimb >= 2000 },
    { id: 'speedBrake', label: 'speed brake out', test: (seen) => seen.maxAirbrake >= 0.5 },
  ],
});

const LEG_SCRIPTS = Object.freeze({
  glider: GLIDER_LEG,
  paraglider: PARAGLIDER_LEG,
  balloon: BALLOON_LEG,
  spaceplane: SPACEPLANE_LEG,
});

/** The soak's ten legs in order (contract k.5; testSoakCraft overrides). */
export const SOAK_CRAFT = Object.freeze(['aerobatic', 'seaplane', 'tiltrotor', 'paraglider', 'balloon', 'airship', 'eagle', 'spaceplane', 'jet', 'glider']);

/** The soak leg script for a craft: its own leg script, else its flight-test script; null when none exists. */
export function soakScriptFor(craft) {
  return LEG_SCRIPTS[craft] ?? SCRIPTS[craft] ?? null;
}

/** The script for a craft ({ steps, checks }), or null when none exists. */
export function flightScriptFor(craft) {
  return SCRIPTS[craft] ?? null;
}

/** Every craft id with a script, in the harness's run order. */
export const SCRIPTED_CRAFT = Object.freeze(['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv', 'aerobatic', 'seaplane', 'tiltrotor', 'paraglider', 'balloon', 'airship', 'eagle', 'spaceplane']);
