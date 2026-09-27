// Aerodynamics shared by the SIM flight models: the atmosphere, lift and drag curves that carry on
// past the stall (a post-stall drop, then a flat plate at high angles, on both signs), the force of
// one lifting surface in its local airflow, ground effect, and a propeller thrust model.
//
// Conventions (docs/architecture.md): body axes x right, y up, z aft. A surface's local velocity is
// its velocity relative to the air mass in body axes (flying forward through still air gives
// (0, 0, -V)). Angles are radians here; profiles give degrees and are converted when a model is built.
import * as THREE from 'three/webgpu';
import { DEG } from '../core/util.js';
import { airDensity, speedOfSound, SEA_LEVEL_DENSITY } from './telemetry.js';

export { airDensity, speedOfSound, SEA_LEVEL_DENSITY };

export const GRAVITY = 9.81;

/**
 * Deep-stall regime: the flat-plate lift peak (at 45 degrees). Once the flow has separated the
 * section loses its leading-edge suction, so the force acts normal to the chord: the drag rises to
 * CL * tan(alpha) (plus skin friction), capped at a finite wing's drag at 90 degrees.
 */
const FLAT_PLATE = Object.freeze({ LIFT: 1.05, MAX_DRAG: 1.3, FRICTION: 0.02 });

export function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(angle) {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped <= -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

/** 3D lift-curve slope (per rad) of a surface of aspect ratio `aspectRatio` (Helmbold). */
export function liftSlope(aspectRatio) {
  return (2 * Math.PI * aspectRatio) / (2 + Math.sqrt(aspectRatio * aspectRatio + 4));
}

/**
 * A lift curve from profile numbers: linear from the zero-lift angle up to the stall at clMax (the
 * critical angle of attack, degrees), then the lift falls by postStallDrop over dropWidth degrees and
 * blends into a flat plate over blendWidth more; the negative side mirrors it down to clMin.
 */
export function createLiftCurve({ clAlpha, clMax, alphaCritical, clMin = -0.8 * clMax, postStallDrop = 0.4, dropWidth = 4, blendWidth = 16 }) {
  return Object.freeze({
    clAlpha,
    clMax,
    clMin,
    alphaZero: alphaCritical * DEG - clMax / clAlpha,
    postStallDrop,
    dropWidth: dropWidth * DEG,
    blendWidth: blendWidth * DEG,
  });
}

/**
 * Lift coefficient at angle of attack alpha (rad, wrapped). deltaCl shifts the linear part (flaps,
 * spoilers) and deltaClMax moves the stall peak. Writes { cl, stall (0..1 depth past the peak),
 * stallAngle (rad, the positive stall angle for this configuration) } into result.
 */
export function evaluateLift(curve, alpha, deltaCl, deltaClMax, result) {
  const clMax = curve.clMax + deltaClMax;
  const clMin = curve.clMin;
  const stallPositive = curve.alphaZero + (clMax - deltaCl) / curve.clAlpha;
  const stallNegative = curve.alphaZero + (clMin - deltaCl) / curve.clAlpha;
  result.stallAngle = stallPositive;
  if (alpha >= stallNegative && alpha <= stallPositive) {
    result.cl = curve.clAlpha * (alpha - curve.alphaZero) + deltaCl;
    result.stall = 0;
    return result;
  }
  const plate = FLAT_PLATE.LIFT * Math.sin(2 * alpha);
  const beyond = alpha > stallPositive ? alpha - stallPositive : stallNegative - alpha;
  const depth = smoothstep(0, curve.dropWidth, beyond);
  const toPlate = smoothstep(curve.dropWidth, curve.dropWidth + curve.blendWidth, beyond);
  const dropped = alpha > stallPositive ? clMax - curve.postStallDrop * depth : clMin + curve.postStallDrop * 0.8 * depth;
  result.cl = dropped + (plate - dropped) * toPlate;
  result.stall = depth;
  return result;
}

/**
 * A lifting surface: a panel with a unit normal (its lift direction at zero angle of attack), a
 * chord direction (leading edge, normally (0, 0, -1)) and span axis = chord x normal. `position` is
 * relative to the centre of mass (body axes, m); `inducedFactor` is 1 / (pi e AR).
 */
export function createSurface({ id, position, normal, chord = new THREE.Vector3(0, 0, -1), area, meanChord, curve, inducedFactor, incidence = 0, cm0 = 0 }) {
  const unitNormal = normal.clone().normalize();
  const unitChord = chord.clone().normalize();
  return {
    id,
    position: position.clone(),
    normal: unitNormal,
    chord: unitChord,
    span: new THREE.Vector3().crossVectors(unitChord, unitNormal).normalize(),
    area,
    meanChord,
    curve,
    inducedFactor,
    incidence,
    cm0,
  };
}

/** Per-call inputs of surfaceForce (reused, never allocated per tick). */
export function createSurfaceInput() {
  return { alphaOffset: 0, deltaCl: 0, deltaClMax: 0, extraDrag: 0, inducedScale: 1, cm: 0 };
}

/** Per-surface outputs of surfaceForce. */
export function createSurfaceResult() {
  return { alpha: 0, cl: 0, cd: 0, stall: 0, stallAngle: 0, dynamicPressure: 0, force: new THREE.Vector3(), moment: new THREE.Vector3() };
}

const planarScratch = new THREE.Vector3();
const liftDirection = new THREE.Vector3();
const liftResult = { cl: 0, stall: 0, stallAngle: 0 };

/**
 * Aerodynamic force (body axes, N) of one surface and its own pitching moment about its span axis,
 * from the surface's local air velocity. Spanwise flow makes no lift (simple sweep theory). The
 * angle of attack includes the surface incidence and input.alphaOffset (control deflections).
 */
export function surfaceForce(surface, localVelocity, rho, input, result) {
  const planar = planarScratch.copy(localVelocity).addScaledVector(surface.span, -localVelocity.dot(surface.span));
  const speedSquared = planar.lengthSq();
  result.force.set(0, 0, 0);
  result.moment.set(0, 0, 0);
  if (speedSquared < 1e-4) {
    result.alpha = 0;
    result.cl = 0;
    result.cd = 0;
    result.stall = 0;
    result.dynamicPressure = 0;
    return result;
  }
  const speed = Math.sqrt(speedSquared);
  // Moving along the chord (leading edge first) is zero; moving against the normal (sinking) is positive.
  const alpha = wrapAngle(Math.atan2(-planar.dot(surface.normal), planar.dot(surface.chord)) + surface.incidence + input.alphaOffset);
  evaluateLift(surface.curve, alpha, input.deltaCl, input.deltaClMax, liftResult);
  const cl = liftResult.cl;
  const induced = surface.inducedFactor * cl * cl * input.inducedScale;
  const cosine = Math.cos(alpha);
  const separated = Math.min(FLAT_PLATE.MAX_DRAG, Math.abs((cl * Math.sin(alpha)) / Math.max(Math.abs(cosine), 0.05)) + FLAT_PLATE.FRICTION);
  const cd = induced + liftResult.stall * Math.max(0, separated - induced) + input.extraDrag;
  const dynamicPressure = 0.5 * rho * speedSquared;
  const load = dynamicPressure * surface.area;
  // Lift is perpendicular to the airflow and the span; drag acts along the relative wind.
  liftDirection.crossVectors(surface.span, planar).divideScalar(speed);
  result.force.copy(liftDirection).multiplyScalar(load * cl).addScaledVector(planar, (-load * cd) / speed);
  const cm = surface.cm0 + input.cm;
  if (cm !== 0) result.moment.copy(surface.span).multiplyScalar(load * surface.meanChord * cm * (1 - liftResult.stall * 0.5));
  result.alpha = alpha;
  result.cl = cl;
  result.cd = cd;
  result.stall = liftResult.stall;
  result.stallAngle = liftResult.stallAngle;
  result.dynamicPressure = dynamicPressure;
  return result;
}

/**
 * Induced-drag factor in ground effect (McCormick): 1 far from the ground, falling as the wing gets
 * within about a span of it (0.72 at a tenth of the span), which is what makes a flare float.
 */
export function groundEffectFactor(height, span) {
  if (!Number.isFinite(height) || !(span > 0)) return 1;
  const ratio = (16 * Math.max(height, 0.05)) / span;
  const squared = ratio * ratio;
  return Math.max(0.25, squared / (1 + squared));
}

/** Normally aspirated piston power lapse with air density (Gagg-Ferrar). */
export function pistonPowerLapse(rho) {
  return Math.max(0, 1.132 * (rho / SEA_LEVEL_DENSITY) - 0.132);
}

/**
 * Fixed-pitch propeller thrust (N) along the thrust line from shaft power (W). A cruise-pitched prop
 * reaches its peak efficiency at its design speed; below it the efficiency falls with speed, so the
 * power-limited thrust stays at efficiency * P / designSpeed, and near standstill the static thrust
 * (momentum scaling with power and density) takes over, fading out over staticFade m/s.
 * engine: { ratedPower (W), efficiency, designSpeed (m/s), staticThrust (N, rated power, sea level), staticFade (m/s) }.
 */
export function propellerThrust(engine, power, axialSpeed, rho) {
  if (!(power > 0)) return 0;
  const share = power / engine.ratedPower;
  const speed = Math.max(axialSpeed, 0);
  const dynamicThrust = (engine.efficiency * power) / Math.max(speed, engine.designSpeed);
  const staticThrust = engine.staticThrust * Math.cbrt(share * share * (rho / SEA_LEVEL_DENSITY));
  if (staticThrust <= dynamicThrust) return dynamicThrust;
  return dynamicThrust + (staticThrust - dynamicThrust) * Math.exp(-speed / engine.staticFade);
}

/** Fully developed slipstream speed increment (m/s) behind a disc of `area` making `thrust` (momentum theory). */
export function slipstreamIncrement(thrust, axialSpeed, rho, area) {
  if (!(thrust > 0) || !(area > 0)) return 0;
  const speed = Math.max(axialSpeed, 0);
  return Math.sqrt(speed * speed + (2 * thrust) / (rho * area)) - speed;
}
