// Tiltrotor nacelle schedule and conversion corridor: the pure maths shared by SimTiltrotor (the
// nacelle actuator, the auto-nacelle schedule, the corridor warnings), the tiltrotor assists and
// autopilot, the craft module (placements, copilot) and the 'nacelle' instrument.
//
// Nacelle angle n (degrees): 0 is airplane mode (the proprotor shafts point forward along the
// fuselage), 90 is helicopter mode (shafts vertical), and the stop at 97 tilts the thrust aft for
// hovering into a headwind or backing up. The pilot's selections snap to the detents at 0, 60 and 90.
//
// The conversion corridor is the band of nacelle angles the airspeed supports (true airspeed, so it
// tightens with altitude):
//   lower edge (wing stall)       the angle below which the wing, at liftMargin x its flapped CLmax,
//                                 and the rotors' lift component at thrustMargin x the weight cannot
//                                 hold 1 g: sin(n_min) = (1 - q S CLuse / W) / thrustMargin. Below it
//                                 the wing must fly past its stall to carry the load.
//   upper edge (rotor overspeed)  the angle above which the edgewise flow through the disc
//                                 (V sin n) passes edgewiseLimit: the discs flap back past the cyclic,
//                                 the upflow windmills the proprotors past their governed speed and the
//                                 retreating blades stall. Aft of 90 degrees only slow flight
//                                 (below aftTiltSpeed) is allowed.
//
// Pure: no three.js, no DOM, no allocation in the per-tick functions (they write into `out`).

const DEG = Math.PI / 180;
const SEA_LEVEL_DENSITY = 1.225;
const GRAVITY = 9.81;

export const NACELLE = Object.freeze({
  /** Travel (deg): airplane mode, the hover detent and the aft stop. */
  MIN: 0,
  HOVER: 90,
  MAX: 97,
  /** The detents the pilot's selections snap to, and the steps the detent buttons move through. */
  DETENTS: Object.freeze([0, 60, 90]),
  STEPS: Object.freeze([0, 60, 90, 97]),
  /** A HOTAS lever within this many degrees of a detent sits in it. */
  LEVER_SNAP: 3,
  /** Mode bands (deg): at or above HOVER_MODE the craft flies as a helicopter, at or below AIRPLANE_MODE as an airplane. */
  HOVER_MODE: 75,
  AIRPLANE_MODE: 1,
});

/** Corridor parameters with the defaults a profile may override (simProfile.conversion). */
export const CORRIDOR_DEFAULTS = Object.freeze({
  /** Share of the flapped CLmax the lower edge allows the wing to use. */
  liftMargin: 0.9,
  /** Rotor thrust (in weights) the lower edge counts on: what the rotors hold without running out of power. */
  thrustMargin: 1.15,
  /** Edgewise speed through the disc (m/s) at the upper edge. */
  edgewiseLimit: 55,
  /** Aft of 90 degrees the corridor closes above this airspeed (m/s). */
  aftTiltSpeed: 25,
  /** The auto-nacelle schedule keeps this far (deg) inside each edge. */
  margin: 5,
  /** A nacelle this far (deg) outside an edge is out of the corridor (the warnings). */
  tolerance: 3,
});

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * The corridor constants of a craft: { weight (N), wingArea (m^2), clUse, thrustMargin, edgewiseLimit,
 * aftTiltSpeed, margin, tolerance } from its simProfile (mass, wing.area, wing.clMax + wing.flapClMax,
 * conversion).
 */
export function corridorParameters(profile) {
  const mass = profile.mass.empty + profile.mass.pilot + (profile.mass.fuel ?? 0) + (profile.mass.payload ?? 0);
  const wing = profile.wing;
  const conversion = { ...CORRIDOR_DEFAULTS, ...(profile.conversion ?? {}) };
  return Object.freeze({
    weight: mass * GRAVITY,
    wingArea: wing.area,
    clUse: conversion.liftMargin * (wing.clMax + (wing.flapClMax ?? 0)),
    thrustMargin: conversion.thrustMargin,
    edgewiseLimit: conversion.edgewiseLimit,
    aftTiltSpeed: conversion.aftTiltSpeed,
    margin: conversion.margin,
    tolerance: conversion.tolerance,
  });
}

/**
 * The corridor at a true airspeed (m/s) and air density: writes { min, max } (deg) into out.
 * weightShare scales the load the wing must carry (1 = the craft's weight at 1 g).
 */
export function conversionCorridor(airspeed, rho, parameters, out, weightShare = 1) {
  const speed = Math.max(0, Number.isFinite(airspeed) ? airspeed : 0);
  const density = Number.isFinite(rho) && rho > 0 ? rho : SEA_LEVEL_DENSITY;
  const wingLift = 0.5 * density * speed * speed * parameters.wingArea * parameters.clUse;
  const rotorShare = (1 - wingLift / Math.max(parameters.weight * weightShare, 1)) / parameters.thrustMargin;
  out.min = rotorShare >= 1 ? NACELLE.HOVER : rotorShare <= 0 ? NACELLE.MIN : Math.asin(rotorShare) / DEG;
  const limit = parameters.edgewiseLimit;
  if (speed <= limit) {
    out.max = NACELLE.HOVER + (NACELLE.MAX - NACELLE.HOVER) * (1 - smoothstep(parameters.aftTiltSpeed * 0.6, parameters.aftTiltSpeed, speed));
  } else {
    out.max = Math.asin(limit / speed) / DEG;
  }
  return out;
}

/** 'ok', 'wingStall' (below the lower edge) or 'overspeed' (above the upper edge) for a nacelle angle. */
export function corridorState(angle, corridor, tolerance) {
  if (angle > corridor.max + tolerance) return 'overspeed';
  if (angle < corridor.min - tolerance) return 'wingStall';
  return 'ok';
}

/**
 * The auto-nacelle schedule: the pilot's selection held inside the corridor, `margin` degrees from
 * each edge (the middle of the corridor when it is narrower than two margins). An edge at the hover
 * detent or beyond (no wing lift yet, or no edgewise limit yet) keeps no margin, so the hover detent
 * stays selectable when slow. Selecting airplane mode in a hover therefore lowers the nacelles only as
 * fast as the airspeed builds, and selecting the hover at speed raises them only as fast as the
 * airspeed decays.
 */
export function scheduledNacelle(selection, corridor, margin) {
  // The margin fades in from the airplane-mode stop and out toward the hover detent, so the schedule is continuous.
  const low = Math.min(corridor.min + margin * smoothstep(NACELLE.MIN, margin, corridor.min), Math.max(corridor.min, NACELLE.HOVER));
  const high = corridor.max >= NACELLE.HOVER ? Math.min(NACELLE.MAX, corridor.max) : corridor.max - margin;
  if (low > high) return clamp((corridor.min + corridor.max) / 2, NACELLE.MIN, NACELLE.MAX);
  return clamp(selection, low, high);
}

/**
 * The next step from a nacelle selection: direction 1 tilts the nacelles up (toward the hover and the
 * aft stop), -1 forward (toward airplane mode). A selection between steps goes to the nearest step in
 * that direction.
 */
export function stepNacelle(selection, direction) {
  const steps = NACELLE.STEPS;
  if (direction > 0) {
    for (const step of steps) if (step > selection + 0.5) return step;
    return steps[steps.length - 1];
  }
  for (let index = steps.length - 1; index >= 0; index--) if (steps[index] < selection - 0.5) return steps[index];
  return steps[0];
}

/** A HOTAS lever (0..1, the antenna) to a nacelle selection (deg): 0 is airplane mode, full is the aft stop; detents snap. */
export function leverToNacelle(lever) {
  const angle = clamp(Number.isFinite(lever) ? lever : 0, 0, 1) * NACELLE.MAX;
  for (const detent of NACELLE.DETENTS) {
    if (Math.abs(angle - detent) <= NACELLE.LEVER_SNAP) return detent;
  }
  return angle;
}

/** A spoken or typed nacelle angle (deg) clamped to the travel; within LEVER_SNAP of a detent it snaps. */
export function snapNacelle(angle) {
  const clamped = clamp(Number.isFinite(angle) ? angle : NACELLE.HOVER, NACELLE.MIN, NACELLE.MAX);
  for (const detent of NACELLE.DETENTS) {
    if (Math.abs(clamped - detent) <= NACELLE.LEVER_SNAP) return detent;
  }
  return clamped;
}

/** 'hover', 'conversion' or 'airplane' for a nacelle angle (deg). */
export function nacelleMode(angle) {
  if (angle >= NACELLE.HOVER_MODE) return 'hover';
  if (angle <= NACELLE.AIRPLANE_MODE) return 'airplane';
  return 'conversion';
}
