// Scripted flights for the ?test=1 flight-test harness: one script per craft and mode.
//
// Every script flies the craft through its real control path: the autopilot (flight.setAutopilot,
// which in SIM flies through the PID control stage and in CLASSIC through the v1 arcade autopilot),
// scripted ControlState / v1 input deflections (stick, throttle, toe brakes) and flight actions
// (ControlState.actions: flaps, craft ability, relaunch, chute), plus the v1 CLASSIC moves (boost,
// barrel roll). Step times are fractions of the whole run (warmup included), so a shortened run
// still performs every manoeuvre.
//
// A step's run(pilot) receives the harness pilot (see createPilot in testHarness.js):
//   pilot.autopilot({ enabled, headingOffset, altitudeAgl, speed })
//   pilot.stick({ roll, pitch, yaw })   deflections -1..1 held until changed (null releases an axis)
//   pilot.throttle(value | null)        lever 0..1 (SIM ControlState.throttle, CLASSIC throttle target)
//   pilot.brakes(value | null)          both toe brakes 0..1 (SIM: spoilers / airbrake in the air)
//   pilot.brakeToHover()                hover craft: stick back while moving forward, centred once
//                                       slow (closed loop, like a pilot stopping); any stick() ends it
//   pilot.action(id)                    one press of a flight-owned action
//   pilot.boost(), pilot.barrelRoll(direction), pilot.relaunch()   (v1 CLASSIC moves, relaunch any mode)
// Sign conventions: pitch +1 pulls (nose up), roll +1 banks right, yaw +1 yaws right.
//
// Each script also lists checks: the observations (collected every frame by the harness) that
// prove the manoeuvres really happened. They are reported as script coverage. A check's test(seen,
// seconds) gets the run length, so its time thresholds scale down for shortened runs (testSeconds).

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
  barrelRoll: { id: 'barrelRoll', label: 'barrel roll', test: (seen) => seen.barrelRoll },
  boost: { id: 'boost', label: 'boost', test: (seen) => seen.boost },
  bank: { id: 'bank', label: 'manual bank past 20 deg', test: (seen) => seen.maxBank >= 20 },
  hover: { id: 'hover', label: 'hovered 2 s (ground speed under 3 m/s)', test: (seen, run) => seen.hoverSeconds >= seconds(2, run) },
  translate: { id: 'translate', label: 'hover moves above 6 m/s', test: (seen, run) => seen.translateSeconds >= seconds(1, run) },
  relaunch: { id: 'relaunch', label: 'relaunch', test: (seen) => seen.relaunches >= 1 },
  dive: { id: 'dive', label: 'dive below -20 deg pitch', test: (seen) => seen.minPitch <= -20 },
});

/** CLASSIC fixed wing (glider, bush plane, jet): v1 autopilot, barrel roll, boost, manual turn. */
const CLASSIC_FIXED_WING = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot cruise', run: (pilot) => cruise(pilot) },
    { at: 0.3, label: 'autopilot turn 90 deg right', run: (pilot) => cruise(pilot, 90) },
    { at: 0.5, label: 'autopilot off, barrel roll right', run: (pilot) => { handsOff(pilot); pilot.barrelRoll(1); } },
    { at: 0.56, label: 'boost', run: (pilot) => pilot.boost() },
    { at: 0.62, label: 'manual bank left', run: (pilot) => pilot.stick({ roll: -0.6, pitch: 0.15, yaw: 0 }) },
    { at: 0.7, label: 'wings level', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.75, label: 'autopilot cruise, turn back', run: (pilot) => cruise(pilot, -90) },
  ],
  checks: [CHECK.autopilot, CHECK.barrelRoll, CHECK.boost, CHECK.bank],
});

/**
 * SIM fixed wing: PID autopilot, a manual roll into a bank at 100 % assists (roll input and length
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

const SIM_GLIDER = simFixedWing([
  { at: 0.6, label: 'spoilers out (both toe brakes)', run: (pilot) => pilot.brakes(1) },
  { at: 0.7, label: 'spoilers in', run: (pilot) => pilot.brakes(null) },
], [{ id: 'spoilers', label: 'spoilers deployed', test: (seen) => seen.maxAirbrake >= 0.5 }]);

// One action press per step: presses in the same frame count once (ControlState.actions is a set).
const SIM_BUSHPLANE = simFixedWing([
  { at: 0.58, label: 'throttle 90 %, flaps down one notch', run: (pilot) => { pilot.throttle(0.9); pilot.action('flapsDown'); } },
  { at: 0.61, label: 'flaps down a second notch', run: (pilot) => pilot.action('flapsDown') },
  { at: 0.7, label: 'flaps up one notch, throttle 70 %', run: (pilot) => { pilot.action('flapsUp'); pilot.throttle(0.7); } },
  { at: 0.73, label: 'flaps up', run: (pilot) => pilot.action('flapsUp') },
], [{ id: 'flaps', label: 'flaps to notch 2', test: (seen) => seen.maxFlapNotch >= 2 }]);

// The jet rolls far faster than the others (no bank protection by design): a short, light input.
const SIM_JET = simFixedWing([
  { at: 0.56, label: 'full throttle, afterburner on (craft ability)', run: (pilot) => { pilot.throttle(1); pilot.action('craftAbility'); } },
  { at: 0.74, label: 'afterburner off, throttle 70 %', run: (pilot) => { pilot.action('craftAbility'); pilot.throttle(0.7); } },
], [{ id: 'afterburner', label: 'afterburner lit 3 s', test: (seen, run) => seen.afterburnerSeconds >= seconds(3, run) }], { roll: 0.25, rollEnd: 0.5 });

/** Hover craft in SIM (helicopter, FPV drone at 100 % assists): hover, stick moves, then autopilot. */
const SIM_HOVER = Object.freeze({
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

/**
 * Hover craft in CLASSIC (the arcade hover extension): throttle 0.5 holds height. It cruises on the
 * autopilot first and ends in a hover, so the SIM run that follows starts from a hover.
 */
const CLASSIC_HOVER = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot cruise', run: (pilot) => { cruise(pilot); pilot.throttle(0.5); } },
    { at: 0.2, label: 'autopilot turn 90 deg left', run: (pilot) => cruise(pilot, -90) },
    { at: 0.4, label: 'autopilot off, brake to a hover', run: (pilot) => { handsOff(pilot); pilot.throttle(0.5); pilot.brakeToHover(); } },
    { at: 0.55, label: 'stick forward', run: (pilot) => pilot.stick({ roll: 0, pitch: -0.6, yaw: 0 }) },
    { at: 0.62, label: 'banked turn right, climb, boost', run: (pilot) => { pilot.stick({ roll: 0.5, pitch: -0.3, yaw: 0 }); pilot.throttle(0.8); pilot.boost(); } },
    { at: 0.7, label: 'throttle 50 %, brake to a hover', run: (pilot) => { pilot.throttle(0.5); pilot.brakeToHover(); } },
  ],
  checks: [CHECK.hover, CHECK.translate, CHECK.autopilot],
});

/** Wingsuit in SIM: glide autopilot, a dive and pull-out, a peak relaunch, then the canopy. */
const SIM_WINGSUIT = Object.freeze({
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

/** Wingsuit in CLASSIC: v1 glide autopilot, a dive, a peak relaunch and a boost. */
const CLASSIC_WINGSUIT = Object.freeze({
  steps: [
    { at: 0, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.25, label: 'autopilot off, dive (push)', run: (pilot) => { handsOff(pilot); pilot.stick({ roll: 0, pitch: -0.8, yaw: 0 }); } },
    { at: 0.33, label: 'hands off', run: (pilot) => pilot.stick({ roll: 0, pitch: 0, yaw: 0 }) },
    { at: 0.42, label: 'relaunch from the nearest peak', run: (pilot) => pilot.relaunch() },
    { at: 0.5, label: 'boost', run: (pilot) => pilot.boost() },
    { at: 0.56, label: 'autopilot glide', run: (pilot) => cruise(pilot) },
    { at: 0.78, label: 'autopilot turn 90 deg right', run: (pilot) => cruise(pilot, 90) },
  ],
  checks: [CHECK.autopilot, CHECK.dive, CHECK.relaunch],
});

const SCRIPTS = Object.freeze({
  classic: Object.freeze({
    glider: CLASSIC_FIXED_WING,
    bushplane: CLASSIC_FIXED_WING,
    jet: CLASSIC_FIXED_WING,
    helicopter: CLASSIC_HOVER,
    wingsuit: CLASSIC_WINGSUIT,
    fpv: CLASSIC_HOVER,
  }),
  sim: Object.freeze({
    glider: SIM_GLIDER,
    bushplane: SIM_BUSHPLANE,
    jet: SIM_JET,
    helicopter: SIM_HOVER,
    wingsuit: SIM_WINGSUIT,
    fpv: SIM_HOVER,
  }),
});

/** The script for a craft in a mode ({ steps, checks }), or null when none exists. */
export function flightScriptFor(craft, mode) {
  return SCRIPTS[mode]?.[craft] ?? null;
}

/** Every craft id with a script in both modes, in the harness's run order. */
export const SCRIPTED_CRAFT = Object.freeze(['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv']);
