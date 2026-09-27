// JET: a single-engine supersonic fighter, built from code in the v1 glider's style (flat-shaded,
// vertex-coloured lofts in the v1 palette). Blended cropped-delta wing with leading-edge extensions,
// chin intake, bubble canopy with the pilot's helmet, single fin, tail booms, all-moving stabilators,
// variable exhaust nozzle, split speed brakes and a retractable tricycle gear with doors. Animated:
// flaperons, leading-edge flaps (scheduled with angle of attack and Mach), stabilators (pitch and
// roll), rudder, speed brakes, nozzle petals, gear and doors through their transit, rolling wheels.
// Effects (src/render/jetEffects.js): afterburner flame, vapor cones, wingtip vapour.
// CLASSIC flies it with v1's forgiving arcade rules at jet speeds; the SIM profile describes the real
// thing (about 1300 km/h at sea level and Mach 1.6 at 10 km in afterburner, 9 g, 25 degree critical
// angle of attack, lift-off near 300 km/h and touchdown near 250 km/h) through SimFixedWing, its jet
// extension (src/flight/jetAero.js) and its flight control system (src/flight/jetFcs.js).
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp } from '../core/util.js';
import { createJetExtension } from '../flight/jetAero.js';
import { JET_MODEL_KIND } from '../flight/jetFcs.js';
import { createJetEffects } from '../render/jetEffects.js';
import {
  PALETTE, createMeshBuilder, profileSection, piecewise, mirrorPoint, ellipseRing, getCraftMaterials, addSolid,
  addPivot, createNavLights, disposeCraftMesh,
} from './kit.js';

// ============================================================================================
// CLASSIC: v1's arcade rules at jet speeds: fast, punchy throttle, crisp roll.
// ============================================================================================
const arcadeProfile = Object.freeze({
  // m/s: stall about 250 km/h, cruise about 680 km/h, top about 1080 km/h, boost about 1370 km/h.
  SPEED: Object.freeze({ MIN: 55, STALL: 70, CRUISE: 190, MAX: 300, BOOST_MAX: 380 }),
  GRAVITY: 9.81,
  // Terminal speed = MAX * throttle^1.1; thrust minus drag gives about 1.5 g of push from cruise.
  DRAG_COEFFICIENT: 0.00022,
  THROTTLE_SPEED_EXPONENT: 1.1, // 190 m/s at 66 %
  THROTTLE_RATE: 0.6,
  INDUCED_DRAG: 1.2,
  INDUCED_MAX_EXTRA_G: 6,
  MAX_PITCH_RATE: 38 * DEG,
  MAX_ROLL_RATE: 220 * DEG,
  MAX_YAW_RATE: 10 * DEG,
  MAX_BANK: 80 * DEG,
  BANK_GAIN: 5.5,
  FINE_BANK_SCALE: 0.5,
  YAW_BANK: 10 * DEG,
  PITCH_LIMIT_START: 55 * DEG,
  PITCH_LIMIT_RANGE: 25 * DEG,
  TURN_GAIN: 1.4,
  MAX_TURN_RATE: 24 * DEG,
  BANK_NOSE_DROP: 3 * DEG,
  BANK_SETTLE_PITCH: 3 * DEG,
  FINE_CONTROL_SCALE: 0.45,
  AUTO_LEVEL_DELAY: 1.2,
  STALL_EXIT_MARGIN: 10,
  STALL_NOSE_TARGET: -20 * DEG,
  HIGH_SPEED_PITCH_START: 220,
  CUSHION_HEIGHT: 40,
  IMPACT_WARNING_SECONDS: 2.5,
  IMPACT_FULL_SECONDS: 0.7,
  CUSHION_PULL_RATE: 60 * DEG,
  GUARD_PROBE_SECONDS: Object.freeze([1.1, 2.2, 3.4]),
  GUARD_MARGIN: 30,
  GUARD_MIN_SPEED: 60,
  GUARD_EVADE_GRADIENT: Math.tan(28 * DEG),
  GUARD_EVADE_BANK: 60 * DEG,
  CEILING_BAND: 400,
  BOOST_DURATION: 3,
  BOOST_COOLDOWN: 6,
  BARREL_ROLL_DURATION: 0.9,
  BARREL_ROLL_RADIUS: 2.5,
  AUTOPILOT: Object.freeze({
    MAX_BANK: 35 * DEG,
    MAX_PITCH: 8 * DEG,
    TERRAIN_PITCH: 12 * DEG,
    CLEARANCE: 180,
    RING_CLEARANCE: 60,
    MIN_ALTITUDE: 90,
    CRUISE_THROTTLE: 0.66,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    TERRAIN_MAX_PITCH: 20 * DEG,
    LOOKAHEAD_DISTANCES: Object.freeze([0, 250, 500, 850, 1300, 1900, 2600, 3600]),
    PATH_LOOKAHEAD_DISTANCES: Object.freeze([400, 1000, 1800]),
    WAYPOINT_STEERING: Object.freeze({ BANK_PER_DEGREE: 1.2, MAX_BANK: 35 * DEG, DAMPING: 2.2, MAX_ROLL_RATE: 60 * DEG }),
    RING_STEERING: Object.freeze({ BANK_PER_DEGREE: 2.0, MAX_BANK: 50 * DEG, DAMPING: 3.5, MAX_ROLL_RATE: 80 * DEG }),
    RING_MAX_PITCH: 15 * DEG,
    RING_MIN_TIME_TO_RING: 1.5,
    RING_VERTICAL_SPEED_GAIN: 0.015,
    RING_LOOKAHEAD_MARGIN: 300,
    RING_TRACK_LEAD_SECONDS: 2.4,
    RING_TRACK_LEAD_MIN: 200,
    RING_TRACK_LEAD_MAX: 450,
  }),
  // Load factor shown to fx / audio / the G effects: fighters pull hard, so a higher knee and cap.
  LOAD: Object.freeze({ PULL_SHARE: 0.35, KNEE: 6, CAP: 9, MIN: -2, SMOOTHING: 5, MIN_BANK_COS: 0.12, BARREL_ROLL_EXTRA: 1.2 }),
  SURFACE_TURN_SHARE: 0.3,
});

// ============================================================================================
// SIM: an F-16 class single-engine fighter for SimFixedWing plus the jet extension. Targets first,
// then the physical parameters that meet them, then the contact points. Positions are body axes
// relative to the mesh origin (x right, y up, z aft; m); angles in degrees. tools/lab/jet.mjs
// measures the targets in flight.
// ============================================================================================
const simProfile = Object.freeze({
  // SimFixedWing under its own kind, so the jet gets its flight control system (jetFcs.js) as assists.
  model: JET_MODEL_KIND,
  targets: Object.freeze({
    topSpeedSeaLevel: 361, // m/s = 1300 km/h, afterburner
    topMachAltitude: 1.6, // at 10 km, afterburner
    stallSpeed: 60, // m/s = 218 km/h clean at 25 degrees angle of attack
    liftOffSpeed: 80, // m/s = 290 km/h, half flaps
    touchdownSpeed: 74, // m/s = 265 km/h, full flaps, 13 degrees
    gLimit: 9,
  }),
  mass: Object.freeze({ empty: 8700, pilot: 100, fuel: 2700 }), // 11.5 t combat weight
  // kg m^2 about body x (pitch), y (yaw) and z (roll); yawRoll is the y-z product of inertia.
  inertia: Object.freeze({ pitch: 75000, yaw: 85000, roll: 12900, yawRoll: 1300 }),
  centerOfMass: Object.freeze([0, -0.05, 1.25]),
  // A fast jet: the speed guard sits above Mach 2 at altitude, Vne is an equivalent airspeed.
  maxSpeed: 700,
  vneBasis: 'equivalent',
  // Gray-out, tunnel vision and red-out in the post stack (src/render/post.js, SIM).
  gEffects: true,
  wing: Object.freeze({
    span: 9.96,
    area: 27.87,
    taper: 0.23,
    oswald: 0.72,
    incidence: 0,
    // No geometric dihedral; the 40 degree sweep's effective dihedral.
    dihedral: 3,
    washout: 0,
    aerodynamicCenter: Object.freeze([0, -0.05, 1.1]),
    cm0: -0.01,
  }),
  aero: Object.freeze({
    cd0: 0.021, // subsonic, clean
    dragCenter: Object.freeze([0, -0.05, 1.3]),
    clAlpha: 4.2, // per rad: low aspect ratio plus the strakes' vortex lift
    clMax: 1.8,
    clMin: -1.0,
    alphaCritical: 25,
    postStallClDrop: 0.3, // vortex lift fades gently
    stallDropWidth: 6,
    stallBlendWidth: 18,
  }),
  fuselage: Object.freeze({ sideArea: 12, sideForceSlope: 0.3, sideForceZ: -2.2, crossflowStations: Object.freeze([-4.5, 5.0]) }),
  tail: Object.freeze({
    // All-moving stabilators below the wing plane.
    horizontal: Object.freeze({ position: Object.freeze([0, -0.12, 6.2]), area: 6.3, aspectRatio: 3, incidence: -1, downwash: 0.55, wake: 0.3 }),
    vertical: Object.freeze({ position: Object.freeze([0, 1.9, 5.8]), area: 5.1, aspectRatio: 1.3, offset: 0, shadow: 0.35 }),
  }),
  // Max deflections (deg, matching the mesh), how much angle of attack a full deflection adds to its
  // surface (share of the deflection), the trim's range (share of full elevator) and servo speed (1/s).
  controls: Object.freeze({
    aileron: 20,
    elevator: 25,
    rudder: 30,
    effectiveness: Object.freeze({ aileron: 0.4, elevator: 1, rudder: 0.5 }),
    trimRange: 0.3,
    servoRate: 5,
  }),
  // Trailing-edge flaperons as flaps: half for take-off, full for landing.
  flaps: Object.freeze({ notches: Object.freeze([0, 0.5, 1]), maxDeflection: 20, clMaxIncrement: 0.25, clIncrement: 0.32, cdIncrement: 0.03, pitchMoment: -0.04, deploySeconds: 2 }),
  // Split speed brakes beside the nozzle (the airbrake action): drag only, no lift loss.
  spoilers: Object.freeze({ cdIncrement: 0.055, clLoss: 0, deploySeconds: 1.1 }),
  gear: Object.freeze({ retractable: true, transitSeconds: 3.2, cdIncrement: 0.022 }),
  engine: null,
  extension: createJetExtension,
  jet: Object.freeze({
    engine: Object.freeze({
      dryThrust: 64000, // N, military power, sea level static
      abThrust: 100000, // N, full afterburner, sea level static
      lapse: 0.74, // thrust ~ (rho / rho0)^lapse
      ram: 0.15, // ram recovery: thrust * (1 + ram * Mach)
      inletMach: 2.1, // the fixed inlet runs out of pressure recovery past this
      idleSpool: 0.62,
      idleThrust: 0.03, // share of military thrust at idle (parked on its wheels it does not creep)
      spoolUpSeconds: 1.75,
      spoolDownSeconds: 1.1,
      abLightOffSeconds: 0.35,
      abRampSeconds: 0.9,
      abMinimum: 0.55, // share of the afterburner increment at the lowest afterburner stage
      nozzleSeconds: 0.7,
      position: Object.freeze([0, -0.02, 6.9]),
    }),
    transonic: Object.freeze({
      // Wave drag on the wing area: drag divergence near Mach 0.88, the peak just past Mach 1,
      // easing off supersonic.
      waveDrag: Object.freeze([[0.8, 0], [0.88, 0.002], [0.95, 0.012], [1.0, 0.024], [1.08, 0.031], [1.2, 0.028], [1.6, 0.019], [2.2, 0.015]]),
      supersonicInduced: 0.2,
      inducedFrom: 0.95,
      inducedFull: 1.5,
      acShift: 0.1,
      acShiftFrom: 0.85,
      acShiftFull: 1.25,
    }),
    // Flight control system (src/flight/jetFcs.js): gains are scaled by referencePressure / q.
    fcs: Object.freeze({
      minAirspeed: 40,
      referencePressure: 30000,
      maxScale: 10,
      feedForward: 0.06,
      gain: 0.3,
      integral: 0.4,
      // The integrator is scaled by sqrt(q_ref / q): full 1 / q makes it lag at approach speeds.
      integralExponent: 0.5,
      rateDamping: 1.5,
      rateWashoutSeconds: 1.2,
      negativeShare: 0.4,
      aoaMargin: 2,
      aoaLead: 0.25,
      aoaFeedback: 6,
      aoaBleed: 40,
      aoaRateSmoothing: 18,
      negativeAoa: -10,
      coordinationGain: 4,
      coordinationRateGain: 0.8,
      yawDamper: 0.8,
      rollDamper: 1.2,
      rollDamperFrom: 12,
      rollDamperFull: 19,
      autoLevelDelay: 0.5,
      autoLevelBank: 1.2,
      autoLevelRate: 0.35,
      trimFollowSeconds: 3,
      trimIdleDelay: 0.25,
      trimHoldIntegral: 0.6,
      trimHoldDamping: 0.3,
      trimLimit: 0.6,
      trimGroundDecaySeconds: 6,
    }),
    handling: Object.freeze({
      // Above this dynamic pressure (Pa) the stabilator's authority falls as 1 / q, so full aft stick
      // without the flight control system stays near 11 g at any speed past corner speed.
      pitchAuthorityPressure: 15000,
      pitchAuthorityFloor: 0.1,
      // Extra pitch damping (Cm_q of the wing, strakes and body, per rad of q c / 2V).
      pitchDamping: 8,
      wingRock: Object.freeze({ from: 19, full: 23, fadeFrom: 34, fadeTo: 42, gain: 0.8, rateLimit: 0.5, seed: 0.002, seedFrequency: 0.45 }),
      negativeShare: 0.4,
      // Past the limit by more than the tolerance (g) the airframe buffets and the warning shows.
      overGTolerance: 0.4,
      overGBuffetRange: 1.5,
      machBuffet: 0.35,
      buffetMoment: 0.012,
    }),
  }),
  contacts: Object.freeze([
    Object.freeze({ id: 'noseWheel', kind: 'wheel', gear: true, retracts: true, steerable: true, steerAngle: 22, position: Object.freeze([0, -2.08, -3.3]), spring: 180000, damping: 16000, rollingFriction: 0.02, sideFriction: 0.8 }),
    Object.freeze({ id: 'leftMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([-1.1, -2.08, 1.85]), spring: 450000, damping: 36000, rollingFriction: 0.02, sideFriction: 0.85 }),
    Object.freeze({ id: 'rightMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([1.1, -2.08, 1.85]), spring: 450000, damping: 36000, rollingFriction: 0.02, sideFriction: 0.85 }),
    Object.freeze({ id: 'noseTip', kind: 'body', gear: false, position: Object.freeze([0, -0.05, -7.4]) }),
    Object.freeze({ id: 'intake', kind: 'body', gear: false, position: Object.freeze([0, -1.3, -3.5]) }),
    Object.freeze({ id: 'leftFairing', kind: 'body', gear: false, position: Object.freeze([-1.3, -0.86, 1.0]) }),
    Object.freeze({ id: 'rightFairing', kind: 'body', gear: false, position: Object.freeze([1.3, -0.86, 1.0]) }),
    Object.freeze({ id: 'leftVentral', kind: 'body', gear: false, position: Object.freeze([-0.62, -1.1, 5.3]) }),
    Object.freeze({ id: 'rightVentral', kind: 'body', gear: false, position: Object.freeze([0.62, -1.1, 5.3]) }),
    Object.freeze({ id: 'nozzle', kind: 'body', gear: false, position: Object.freeze([0, -0.48, 7.25]) }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-5.02, -0.05, 2.4]) }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([5.02, -0.05, 2.4]) }),
    Object.freeze({ id: 'leftStabilator', kind: 'body', gear: false, position: Object.freeze([-3.1, -0.36, 7.3]) }),
    Object.freeze({ id: 'rightStabilator', kind: 'body', gear: false, position: Object.freeze([3.1, -0.36, 7.3]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 3.25, 6.5]) }),
    Object.freeze({ id: 'canopy', kind: 'body', gear: false, position: Object.freeze([0, 1.12, -3.6]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin on the fuselage axis ahead of the centre of mass)
// ============================================================================================
// Thin fighter sections as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
const WING_PROFILE = [[0, 0], [0.08, 0.4], [0.35, 0.5], [0.78, 0.26], [1, 0], [0.78, -0.26], [0.35, -0.5], [0.08, -0.4]];
/** The wing box between the leading-edge flap and the flaperon. */
const WING_BOX = [[0.16, 0.46], [0.35, 0.5], [0.78, 0.26], [0.78, -0.26], [0.35, -0.5], [0.16, -0.46]];
/** Outboard of the flaperon: behind the leading-edge flap to the trailing edge. */
const WING_OUTBOARD = [[0.16, 0.46], [0.35, 0.5], [0.78, 0.26], [1, 0], [0.78, -0.26], [0.35, -0.5], [0.16, -0.46]];
const LEADING_FLAP_PROFILE = [[0, 0], [0.08, 0.4], [0.16, 0.46], [0.16, -0.46], [0.08, -0.4]];
const FLAPERON_PROFILE = [[0.785, 0.25], [1, 0], [0.785, -0.25]];
const FIN_PROFILE = [[0, 0], [0.1, 0.45], [0.4, 0.5], [0.74, 0.3], [1, 0], [0.74, -0.3], [0.4, -0.5], [0.1, -0.45]];
const FIN_PROFILE_CUT = [[0, 0], [0.1, 0.45], [0.4, 0.5], [0.74, 0.3], [0.74, 0], [0.74, -0.3], [0.4, -0.5], [0.1, -0.45]];
const RUDDER_PROFILE = [[0.745, 0.29], [1, 0], [0.745, -0.29]];

// Wing: strake from the fuselage (x 0.6) to the wing root (x 1.3), then a 40 degree leading edge to
// the tip rail at x 4.95; straight trailing edge. No dihedral; the wing sits at the fuselage axis.
const WING = Object.freeze({ Y: -0.05, THICKNESS: 0.05, ROOT_X: 1.3, TIP_X: 4.95, ROOT_LE: -1.25, ROOT_CHORD: 4.85, TIP_CHORD: 1.1, SWEEP: Math.tan(40 * DEG), STRAKE_X: 0.6, STRAKE_LE: -4.0, TRAILING_EDGE_ROOT: 3.6 });
const FLAPERON_SPAN = Object.freeze([1.4, 3.25]);
const LEADING_FLAP_SPAN = Object.freeze([1.4, 4.85]);
function wingLeadingEdgeAt(x) {
  if (x <= WING.ROOT_X) return WING.STRAKE_LE + ((WING.ROOT_LE - WING.STRAKE_LE) * (x - WING.STRAKE_X)) / (WING.ROOT_X - WING.STRAKE_X);
  return WING.ROOT_LE + (x - WING.ROOT_X) * WING.SWEEP;
}
function wingChordAt(x) {
  if (x <= WING.ROOT_X) return WING.TRAILING_EDGE_ROOT - wingLeadingEdgeAt(x);
  return WING.ROOT_CHORD + ((WING.TIP_CHORD - WING.ROOT_CHORD) * (x - WING.ROOT_X)) / (WING.TIP_X - WING.ROOT_X);
}
function wingSection(x, profile) {
  return profileSection(profile, [x, WING.Y, wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS);
}
/** A point on the wing at chord fraction `fraction` and thickness fraction `across` (right side). */
function wingPoint(x, fraction, across) {
  const chord = wingChordAt(x);
  return [x, WING.Y + across * WING.THICKNESS * chord, wingLeadingEdgeAt(x) + fraction * chord];
}

function buildWingHalf(builder, side) {
  const mirror = (section) => section.map((point) => mirrorPoint(point, side));
  const tint = (edge, count) => (edge >= count / 2 ? PALETTE.creamShade : PALETTE.cream);
  builder.loft([WING.STRAKE_X, WING.ROOT_X, FLAPERON_SPAN[0]].map((x) => mirror(wingSection(x, WING_PROFILE))), (segment, edge) => tint(edge, 8));
  builder.loft([FLAPERON_SPAN[0], 2.3, FLAPERON_SPAN[1]].map((x) => mirror(wingSection(x, WING_BOX))), (segment, edge) => tint(edge, 6));
  builder.loft([FLAPERON_SPAN[1], 4.1, LEADING_FLAP_SPAN[1]].map((x) => mirror(wingSection(x, WING_OUTBOARD))), (segment, edge) => (segment === 1 && edge < 3 ? PALETTE.orange : tint(edge, 7)));
  builder.loft([LEADING_FLAP_SPAN[1], WING.TIP_X].map((x) => mirror(wingSection(x, WING_PROFILE))), () => PALETTE.orange, { capEnd: PALETTE.orange });
  // Wingtip rail: a slim faceted pod along the tip.
  const rail = [[1.35, 0.01], [1.6, 0.07], [2.9, 0.07], [3.25, 0.03]].map(([z, radius]) => mirror(ellipseRing(z, WING.Y, radius, radius, 8).map((point) => [point[0] + WING.TIP_X + 0.05, point[1], point[2]])));
  builder.loft(rail, (segment) => (segment === 0 ? PALETTE.charcoal : PALETTE.creamShade), { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
}

/** A hinged part lofted through span stations with a profile; the hinge runs through `hinge(x)`. */
function buildWingPart(profile, stations, side, hinge, tintAt) {
  const builder = createMeshBuilder();
  const sections = stations.map((x) => wingSection(x, profile).map((point) => mirrorPoint(point, side)));
  builder.loft(sections, tintAt, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const start = mirrorPoint(hinge(stations[0]), side);
  const end = mirrorPoint(hinge(stations[stations.length - 1]), side);
  const axis = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize();
  return { geometry: builder.toGeometry(start), pivot: start, axis };
}

function buildFlaperon(side) {
  return buildWingPart(FLAPERON_PROFILE, [FLAPERON_SPAN[0], 2.3, FLAPERON_SPAN[1]], side, (x) => wingPoint(x, 0.785, 0), () => PALETTE.cream);
}

function buildLeadingFlap(side) {
  return buildWingPart(LEADING_FLAP_PROFILE, [LEADING_FLAP_SPAN[0], FLAPERON_SPAN[1], LEADING_FLAP_SPAN[1]], side, (x) => wingPoint(x, 0.16, -0.46), (segment, edge) => (edge === 0 || edge === 4 ? PALETTE.creamShade : PALETTE.cream));
}

// Fuselage stations: [z, centre y, half width, half height] on 16-sided rings.
const FUSELAGE = [
  [-7.4, -0.05, 0.02, 0.02],
  [-7.0, -0.03, 0.2, 0.2],
  [-6.2, 0.0, 0.38, 0.38],
  [-5.3, 0.02, 0.5, 0.5],
  [-4.2, 0.02, 0.58, 0.58],
  [-3.2, -0.02, 0.64, 0.62],
  [-2.0, -0.05, 0.7, 0.66],
  [-0.5, -0.05, 0.76, 0.68],
  [1.5, -0.02, 0.78, 0.66],
  [3.5, 0.0, 0.74, 0.62],
  [5.0, 0.02, 0.66, 0.58],
  [6.0, 0.02, 0.58, 0.55],
  [6.4, 0.02, 0.55, 0.53],
];
const FUSELAGE_SIDES = 16;
function fuselageAt(z) {
  const column = (index) => FUSELAGE.map((station) => [station[0], station[index]]);
  return { centreY: piecewise(column(1), z), halfWidth: piecewise(column(2), z), halfHeight: piecewise(column(3), z) };
}
const fuselageTop = (z) => {
  const body = fuselageAt(z);
  return body.centreY + body.halfHeight;
};

function buildFuselage(builder) {
  const sections = FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, FUSELAGE_SIDES, 360 / FUSELAGE_SIDES / 2));
  // Face k spans ring angles 11.25 + 22.5 k .. + 22.5: k 3-4 is the top, 11-12 the belly.
  builder.loft(sections, (segment, face) => {
    if (segment <= 1) return PALETTE.charcoal;
    if (face >= 8 && face <= 15) return face === 8 || face === 15 ? PALETTE.cream : PALETTE.creamShade;
    // An orange cheat line along each side from behind the radome to the tail.
    if ((face === 0 || face === 7) && segment >= 3 && segment <= 10) return PALETTE.orange;
    return PALETTE.cream;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
}

// Dorsal spine from the canopy to the fin, with an orange stripe on its crest.
const SPINE = [[-2.0, 0.2, 0.16], [-0.5, 0.26, 0.2], [1.5, 0.25, 0.15], [3.6, 0.2, 0.05]];
function buildSpine(builder) {
  const sections = SPINE.map(([z, halfWidth, height]) => {
    const top = fuselageTop(z) - 0.04;
    return [[-halfWidth, top, z], [-halfWidth * 0.62, top + height * 0.85, z], [0, top + height, z], [halfWidth * 0.62, top + height * 0.85, z], [halfWidth, top, z]];
  });
  builder.loft(sections, (segment, edge) => (edge === 1 || edge === 2 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
}

// Chin intake: [z, top y, bottom y, half width]; the mouth is a dark recessed face.
const INTAKE = [[-3.6, -0.42, -1.3, 0.52], [-2.6, -0.48, -1.31, 0.56], [-1.0, -0.52, -1.2, 0.6], [0.6, -0.55, -0.98, 0.62], [2.2, -0.55, -0.66, 0.56]];
function intakeRing(z, top, bottom, halfWidth) {
  const corner = Math.min(0.16, (top - bottom) * 0.3);
  return [
    [-halfWidth + corner, top, z], [halfWidth - corner, top, z], [halfWidth, top - corner, z], [halfWidth, bottom + corner, z],
    [halfWidth - corner, bottom, z], [-halfWidth + corner, bottom, z], [-halfWidth, bottom + corner, z], [-halfWidth, top - corner, z],
  ];
}
function buildIntake(builder) {
  const sections = INTAKE.map(([z, top, bottom, halfWidth]) => intakeRing(z, top, bottom, halfWidth));
  // Edges 4 (the flat belly) and 3 / 5 (lower corners) take the shade; the lip ring stays cream.
  builder.loft(sections, (segment, edge) => (edge >= 3 && edge <= 6 ? PALETTE.creamShade : PALETTE.cream), { capEnd: PALETTE.creamShade });
  const [z, top, bottom, halfWidth] = INTAKE[0];
  const mouth = intakeRing(z + 0.08, top - 0.07, bottom + 0.07, halfWidth - 0.07);
  const inside = [0, (top + bottom) / 2, z + 1];
  for (let index = 1; index < mouth.length - 1; index++) builder.triangle(mouth[0], mouth[index], mouth[index + 1], PALETTE.charcoal, inside);
  // The lip: from the outer ring to the recessed mouth.
  const outer = sections[0];
  for (let index = 0; index < outer.length; index++) {
    const next = (index + 1) % outer.length;
    builder.quad(outer[index], outer[next], mouth[next], mouth[index], PALETTE.charcoal, inside);
  }
}

// Blended belly under the wing roots: [z, half width, bottom]; it houses the main gear.
const FAIRING = [[-0.9, 0.6, -0.62], [-0.2, 1.2, -0.8], [0.8, 1.46, -0.86], [1.9, 1.38, -0.84], [2.9, 1.02, -0.76], [3.6, 0.66, -0.64]];
function buildFairings(builder) {
  const sections = FAIRING.map(([z, halfWidth, bottom]) => [
    [-halfWidth, WING.Y - 0.06, z], [halfWidth, WING.Y - 0.06, z], [halfWidth * 0.97, bottom + 0.16, z], [halfWidth * 0.8, bottom + 0.03, z],
    [halfWidth * 0.36, bottom, z], [-halfWidth * 0.36, bottom, z], [-halfWidth * 0.8, bottom + 0.03, z], [-halfWidth * 0.97, bottom + 0.16, z],
  ]);
  builder.loft(sections, () => PALETTE.creamShade, { capStart: PALETTE.creamShade, capEnd: PALETTE.creamShade });
}

// Tail booms beside the engine carry the stabilators and the split speed brakes.
const BOOM = Object.freeze({ X: 0.8, Y: -0.08, FROM: 4.2, TO: 6.95, RADIUS: 0.19 });
function buildBooms(builder) {
  for (const side of [1, -1]) {
    const stations = [[BOOM.FROM, 0.05], [BOOM.FROM + 0.6, BOOM.RADIUS], [BRAKE.HINGE_Z, BOOM.RADIUS]];
    const sections = stations.map(([z, radius]) => ellipseRing(z, BOOM.Y, radius, radius * 1.1, 8, 22.5).map((point) => [point[0] + BOOM.X * side, point[1], point[2]]));
    builder.loft(sections, () => PALETTE.cream, { capEnd: PALETTE.charcoal });
  }
}

// Split speed brakes: an upper and a lower petal at the aft end of each boom.
const BRAKE = Object.freeze({ HINGE_Z: 6.05, LENGTH: 0.9, HALF_WIDTH: 0.19, MAX_ANGLE: 55 });
function buildBrakePetal(side, upper) {
  const builder = createMeshBuilder();
  const sign = upper ? 1 : -1;
  const x = BOOM.X * side;
  const y = BOOM.Y + sign * BOOM.RADIUS * 0.85;
  const sections = [0, BRAKE.LENGTH].map((length) => {
    const z = BRAKE.HINGE_Z + length;
    const width = BRAKE.HALF_WIDTH * (1 - 0.25 * (length / BRAKE.LENGTH));
    return [[x - width, y, z], [x + width, y, z], [x + width * 0.9, y - sign * 0.12, z], [x - width * 0.9, y - sign * 0.12, z]];
  });
  builder.loft(sections, () => PALETTE.cream, { capStart: PALETTE.creamShade, capEnd: PALETTE.charcoal });
  const pivot = [x, y, BRAKE.HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

// Stabilators: all-moving, 40 degree sweep, 6 degrees anhedral, pivoting on a spigot from the booms.
const STAB = Object.freeze({ ROOT_X: 0.95, TIP_X: 3.1, ROOT_LE: 5.05, ROOT_CHORD: 2.05, TIP_CHORD: 0.62, Y: -0.1, ANHEDRAL: Math.tan(6 * DEG), THICKNESS: 0.045, PIVOT_Z: 6.05 });
const stabLeadingEdge = (x) => STAB.ROOT_LE + (x - STAB.ROOT_X) * WING.SWEEP;
const stabChord = (x) => STAB.ROOT_CHORD + ((STAB.TIP_CHORD - STAB.ROOT_CHORD) * (x - STAB.ROOT_X)) / (STAB.TIP_X - STAB.ROOT_X);
const stabHeight = (x) => STAB.Y - (x - STAB.ROOT_X) * STAB.ANHEDRAL;
function buildStabilator(side) {
  const builder = createMeshBuilder();
  const stations = [STAB.ROOT_X, 2.1, STAB.TIP_X];
  const sections = stations.map((x) => profileSection(WING_PROFILE, [x, stabHeight(x), stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS).map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment, edge) => (segment === 1 ? PALETTE.orange : edge >= 4 ? PALETTE.creamShade : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  const pivot = [STAB.ROOT_X * side, STAB.Y, STAB.PIVOT_Z];
  // Pitch axis along the (anhedral) span, pointing to +x on both sides so one angle moves both alike.
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, -side * STAB.ANHEDRAL, 0).normalize() };
}

// Fin: 45 degree leading edge from the spine to the tip, rudder on the lower trailing edge.
const FIN = Object.freeze({ BASE_Y: 0.5, TOP_Y: 3.25, BASE_LE: 3.3, TOP_LE: 5.9, BASE_TE: 6.75, TOP_TE: 7.0, THICKNESS: 0.055, RUDDER: Object.freeze([0.95, 2.75]) });
const finLeadingEdge = (y) => FIN.BASE_LE + ((FIN.TOP_LE - FIN.BASE_LE) * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y);
const finChord = (y) => FIN.BASE_TE + ((FIN.TOP_TE - FIN.BASE_TE) * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y) - finLeadingEdge(y);
function finSection(y, profile) {
  return profileSection(profile, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS);
}
function buildFin(builder) {
  builder.loft([FIN.BASE_Y, FIN.RUDDER[0]].map((y) => finSection(y, FIN_PROFILE)), () => PALETTE.cream);
  builder.loft([FIN.RUDDER[0], 1.9, FIN.RUDDER[1]].map((y) => finSection(y, FIN_PROFILE_CUT)), () => PALETTE.cream);
  builder.loft([FIN.RUDDER[1], 2.95, FIN.TOP_Y].map((y) => finSection(y, FIN_PROFILE)), (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  // Ventral fins, canted out 15 degrees under the booms.
  for (const side of [1, -1]) {
    const cant = 15 * DEG;
    const root = [0.62 * side, -0.52, 4.5];
    const down = [Math.sin(cant) * side, -Math.cos(cant), 0];
    const sections = [0, 0.55].map((depth) => profileSection(FIN_PROFILE, [root[0] + down[0] * depth, root[1] + down[1] * depth, root[2] + depth * 0.5], [0, 0, 1], [Math.cos(cant), Math.sin(cant) * side, 0], 1.1 - depth * 0.8, 0.06));
    builder.loft(sections, () => PALETTE.creamShade, { capEnd: PALETTE.charcoal });
  }
}
function buildRudder() {
  const builder = createMeshBuilder();
  const heights = [FIN.RUDDER[0] + 0.02, 1.9, FIN.RUDDER[1] - 0.02];
  builder.loft(heights.map((y) => finSection(y, RUDDER_PROFILE)), (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hinge = (y) => [0, y, finLeadingEdge(y) + 0.745 * finChord(y)];
  const start = hinge(heights[0]);
  const end = hinge(heights[heights.length - 1]);
  return { geometry: builder.toGeometry(start), pivot: start, axis: new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize() };
}

// Bubble canopy: [z, half width, bubble height above the fuselage top].
const CANOPY = [[-5.15, 0.1, 0.02], [-4.8, 0.3, 0.2], [-4.2, 0.42, 0.42], [-3.6, 0.46, 0.52], [-3.0, 0.45, 0.5], [-2.4, 0.38, 0.38], [-1.9, 0.22, 0.2], [-1.55, 0.08, 0.04]];
function canopyArc(z, halfWidth, bubble, inflate = 0) {
  const body = fuselageAt(z);
  const surfaceAt = (x) => body.centreY + body.halfHeight * Math.sqrt(Math.max(0, 1 - (x / body.halfWidth) ** 2)) - 0.02;
  const topY = body.centreY + body.halfHeight + bubble;
  const arc = [];
  for (let index = 0; index <= 8; index++) {
    const angle = Math.PI - (index / 8) * Math.PI;
    const x = (halfWidth + inflate) * Math.cos(angle);
    arc.push([x, surfaceAt(x) + (topY + inflate - surfaceAt(0)) * Math.sin(angle), z]);
  }
  return arc;
}
function buildCanopy() {
  const builder = createMeshBuilder();
  builder.loft(CANOPY.map(([z, halfWidth, bubble]) => canopyArc(z, halfWidth, bubble)), () => PALETTE.charcoal, { closed: false });
  return builder.toGeometry(null);
}
/** The canopy's single frame bow behind the pilot's head, and the sill rails. */
function buildCanopyFrame(builder) {
  const bow = canopyArc(-2.72, 0.43, 0.46, 0.02);
  for (let index = 0; index < bow.length - 1; index++) buildBar(builder, bow[index], bow[index + 1], 0.035, 0.03, PALETTE.charcoal);
}
/** The pilot's helmet (seen from outside through the canopy), with an orange visor band. */
function buildHelmet(builder) {
  const centre = [0, EYE[1] + 0.06, EYE[2] + 0.12];
  const rings = [[-0.14, 0.02], [-0.1, 0.1], [0, 0.14], [0.1, 0.12], [0.16, 0.05]].map(([offset, radius]) => ellipseRing(centre[2] + offset, centre[1], radius, radius * 1.1, 8, 22.5));
  builder.loft(rings, (segment, face) => (segment === 1 && face >= 4 && face <= 7 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
}

/** A straight faceted bar from a to b (gear legs, struts, frames) with a lozenge section. */
function buildBar(builder, from, to, halfWidth, halfDepth, tint, widthAxis = [1, 0, 0]) {
  const direction = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const width = new THREE.Vector3(widthAxis[0], widthAxis[1], widthAxis[2]);
  width.addScaledVector(direction, -width.dot(direction));
  if (width.lengthSq() < 1e-6) width.set(0, 0, 1).addScaledVector(direction, -direction.z);
  width.normalize();
  const depth = new THREE.Vector3().crossVectors(direction, width).normalize();
  const ring = (point) => [[halfWidth, 0], [0, halfDepth], [-halfWidth, 0], [0, -halfDepth]].map(([along, across]) => [
    point[0] + width.x * along + depth.x * across,
    point[1] + width.y * along + depth.y * across,
    point[2] + width.z * along + depth.z * across,
  ]);
  builder.loft([ring(from), ring(to)], () => tint, { capStart: tint, capEnd: tint });
}

/** A tire around an axle along x, centred at the origin: charcoal tread, cream hubs. */
function buildWheelGeometry(radius, width) {
  const builder = createMeshBuilder();
  const profile = [[-0.5, 0.66], [-0.4, 0.94], [-0.18, 1], [0.18, 1], [0.4, 0.94], [0.5, 0.66]];
  const sides = 14;
  const sections = profile.map(([across, scale]) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      ring.push([across * width, Math.cos(angle) * radius * scale, Math.sin(angle) * radius * scale]);
    }
    return ring;
  });
  builder.loft(sections, () => PALETTE.charcoal, { capStart: PALETTE.creamShade, capEnd: PALETTE.creamShade });
  return builder.toGeometry(null);
}

// Landing gear: legs pivot at their top; the nose leg swings aft into the intake belly, the mains
// swing forward into the fairings, twisting their wheels flat. Doors open while the gear is out.
const NOSE_GEAR = Object.freeze({ PIVOT: Object.freeze([0, -1.0, -3.0]), AXLE: Object.freeze([0, -1.78, -3.3]), RADIUS: 0.3, WIDTH: 0.2, RETRACT: -112 * DEG });
const MAIN_GEAR = Object.freeze({ PIVOT: Object.freeze([0.85, -0.62, 1.5]), AXLE: Object.freeze([1.1, -1.7, 1.85]), RADIUS: 0.38, WIDTH: 0.24, RETRACT: 108 * DEG, TWIST: 90 * DEG });

/**
 * One gear leg as nested groups: pivot (swing) -> leg bar and the wheel on a twist group at the axle.
 * Returns { pivot, wheel, twist, twistAxis (leg direction, pivot local), radius }.
 */
function buildGearLeg(root, material, spec, side, wheelGeometry) {
  const pivotPoint = [spec.PIVOT[0] * side, spec.PIVOT[1], spec.PIVOT[2]];
  const axle = [spec.AXLE[0] * side, spec.AXLE[1], spec.AXLE[2]];
  const local = [axle[0] - pivotPoint[0], axle[1] - pivotPoint[1], axle[2] - pivotPoint[2]];
  const pivot = new THREE.Group();
  pivot.position.set(pivotPoint[0], pivotPoint[1], pivotPoint[2]);
  root.add(pivot);
  const legBuilder = createMeshBuilder();
  const inboard = side === 0 ? 0 : -side * spec.WIDTH * 0.62;
  buildBar(legBuilder, [0, 0.05, 0], [local[0] + inboard, local[1], local[2]], 0.055, 0.055, PALETTE.charcoal, [0, 0, 1]);
  // Torque link and axle stub.
  buildBar(legBuilder, [local[0] * 0.45, local[1] * 0.45, local[2] * 0.45 + 0.12], [local[0] + inboard, local[1] + 0.18, local[2] + 0.1], 0.025, 0.025, PALETTE.creamShade);
  addSolid(pivot, legBuilder.toGeometry(null), material);
  const twist = new THREE.Group();
  twist.position.set(local[0], local[1], local[2]);
  pivot.add(twist);
  const wheel = new THREE.Group();
  twist.add(wheel);
  addSolid(wheel, wheelGeometry, material);
  const twistAxis = new THREE.Vector3(local[0], local[1], local[2]).normalize();
  return { pivot, twist, wheel, twistAxis, radius: spec.RADIUS };
}

/** A flat gear door hinged along one edge: { geometry, pivot, axis } (axis along the hinge). */
function buildDoor(hingeStart, hingeEnd, width, outward, tint = PALETTE.creamShade) {
  const builder = createMeshBuilder();
  const thickness = 0.03;
  const edge = (point, offset, lift) => [point[0] + outward[0] * offset, point[1] + lift, point[2] + outward[2] * offset];
  const sections = [hingeStart, hingeEnd].map((point) => [edge(point, 0, 0), edge(point, width, 0), edge(point, width, thickness), edge(point, 0, thickness)]);
  builder.loft(sections, () => tint, { capStart: tint, capEnd: tint });
  const axis = new THREE.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
  return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
}

// Variable nozzle: petals hinged on the engine's exit ring, converging at idle and military power
// and opening wide in afterburner.
const NOZZLE = Object.freeze({ Z: 6.4, Y: 0.02, RADIUS: 0.55, LENGTH: 0.85, PETALS: 14, CLOSED_EXIT: 0.42, OPEN_EXIT: 0.6 });
function buildNozzlePetal() {
  const builder = createMeshBuilder();
  const rootHalf = (Math.PI * NOZZLE.RADIUS) / NOZZLE.PETALS + 0.012;
  const tipHalf = rootHalf * 0.82;
  const thickness = 0.035;
  const sections = [[0, rootHalf], [NOZZLE.LENGTH, tipHalf]].map(([z, half]) => [[-half, 0, z], [half, 0, z], [half, -thickness, z], [-half, -thickness, z]]);
  builder.loft(sections, () => PALETTE.charcoal, { capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

/** Petal convergence (radians, inward positive) for a nozzle opening 0..1. */
function petalAngle(opening) {
  const exit = NOZZLE.CLOSED_EXIT + (NOZZLE.OPEN_EXIT - NOZZLE.CLOSED_EXIT) * clamp(opening, 0, 1);
  return Math.asin(clamp((NOZZLE.RADIUS - exit) / NOZZLE.LENGTH, -0.5, 0.5));
}

const EYE = Object.freeze([0, 0.88, -3.75]);
const TIP = Object.freeze([WING.TIP_X + 0.05, WING.Y, 2.4]);
const SURFACE_LIMITS = Object.freeze({ aileron: simProfile.controls.aileron, elevator: simProfile.controls.elevator, rudder: simProfile.controls.rudder });
const FLAP_MAX_DEFLECTION = simProfile.flaps.maxDeflection;
const GEAR_TRANSIT_SECONDS = simProfile.gear.transitSeconds;
/** Leading-edge flap schedule: droop with angle of attack, up again through the transonic band. */
const LEADING_FLAP = Object.freeze({ PER_DEGREE: 1.1, MAX: 25, TAKEOFF: 12 });

/**
 * Builds the jet. update(visual, dt) animates flaperons (visual.aileron and visual.flaps),
 * stabilators (elevator plus differential roll), rudder, leading-edge flaps (angle of attack and
 * Mach from state.flight), speed brakes (visual.airbrake), the nozzle and the effects (throttle,
 * afterburner, state.flight.craftState), the gear and doors through their transit (visual.gearDown
 * in SIM; CLASSIC flies clean) and the wheels on the ground (visual.groundSpeed).
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'jet';
  const flight = ctx.state.flight;

  const airframe = createMeshBuilder();
  buildFuselage(airframe);
  buildSpine(airframe);
  buildIntake(airframe);
  buildFairings(airframe);
  buildWingHalf(airframe, 1);
  buildWingHalf(airframe, -1);
  buildFin(airframe);
  buildBooms(airframe);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);

  // Canopy glass, its frame and the pilot would sit around the eye: the cockpit view hides them.
  const canopy = addSolid(root, buildCanopy(), materials.canopy);
  canopy.userData.hideInCockpit = true;
  const canopyDetail = createMeshBuilder();
  buildCanopyFrame(canopyDetail);
  buildHelmet(canopyDetail);
  const pilot = addSolid(root, canopyDetail.toGeometry(null), bodyMaterial);
  pilot.userData.hideInCockpit = true;

  const flaperonRight = addPivot(root, buildFlaperon(1), bodyMaterial);
  const flaperonLeft = addPivot(root, buildFlaperon(-1), bodyMaterial);
  const leadingRight = addPivot(root, buildLeadingFlap(1), bodyMaterial);
  const leadingLeft = addPivot(root, buildLeadingFlap(-1), bodyMaterial);
  const stabRight = addPivot(root, buildStabilator(1), bodyMaterial);
  const stabLeft = addPivot(root, buildStabilator(-1), bodyMaterial);
  const rudder = addPivot(root, buildRudder(), bodyMaterial);
  const brakes = [
    { pivot: addPivot(root, buildBrakePetal(1, true), bodyMaterial), sign: -1 },
    { pivot: addPivot(root, buildBrakePetal(1, false), bodyMaterial), sign: 1 },
    { pivot: addPivot(root, buildBrakePetal(-1, true), bodyMaterial), sign: -1 },
    { pivot: addPivot(root, buildBrakePetal(-1, false), bodyMaterial), sign: 1 },
  ];

  // Nozzle petals around the exit ring.
  const petalGeometry = buildNozzlePetal();
  const petals = [];
  for (let index = 0; index < NOZZLE.PETALS; index++) {
    const around = new THREE.Group();
    around.position.set(0, NOZZLE.Y, NOZZLE.Z);
    around.rotation.z = (index / NOZZLE.PETALS) * Math.PI * 2;
    const hinge = new THREE.Group();
    hinge.position.set(0, NOZZLE.RADIUS, 0);
    around.add(hinge);
    addSolid(hinge, petalGeometry, bodyMaterial);
    root.add(around);
    petals.push(hinge);
  }

  // Gear legs, wheels and doors.
  const noseWheelGeometry = buildWheelGeometry(NOSE_GEAR.RADIUS, NOSE_GEAR.WIDTH);
  const mainWheelGeometry = buildWheelGeometry(MAIN_GEAR.RADIUS, MAIN_GEAR.WIDTH);
  const noseLeg = buildGearLeg(root, bodyMaterial, NOSE_GEAR, 0, noseWheelGeometry);
  const mainLegs = [1, -1].map((side) => ({ side, ...buildGearLeg(root, bodyMaterial, MAIN_GEAR, side, mainWheelGeometry) }));
  const doors = [];
  for (const side of [1, -1]) {
    // Nose doors hinge along the bay's sides and swing down; main doors hinge inboard and swing down.
    doors.push({ pivot: addPivot(root, buildDoor([0.2 * side, -1.325, -3.2], [0.2 * side, -1.325, -1.85], 0.2, [-side, 0, 0]), bodyMaterial), angle: side * 88 * DEG });
    doors.push({ pivot: addPivot(root, buildDoor([0.5 * side, -0.87, -0.15], [0.5 * side, -0.87, 1.7], 0.96, [side, 0, 0]), bodyMaterial), angle: -side * 95 * DEG });
  }

  const navLights = createNavLights(root, {
    red: { position: [-TIP[0], TIP[1] + 0.09, 1.9], glow: [-TIP[0] - 0.08, TIP[1] + 0.12, 1.85] },
    green: { position: [TIP[0], TIP[1] + 0.09, 1.9], glow: [TIP[0] + 0.08, TIP[1] + 0.12, 1.85] },
    strobe: { position: [0, FIN.TOP_Y + 0.05, 6.7], glow: [0, FIN.TOP_Y + 0.13, 6.7] },
  });

  const effects = createJetEffects(ctx, root, {
    nozzle: { z: NOZZLE.Z + NOZZLE.LENGTH, y: NOZZLE.Y, radius: NOZZLE.OPEN_EXIT, depth: NOZZLE.LENGTH },
    cone: { apexZ: -3.3, baseZ: 1.7, apexRadius: 0.8, baseRadius: 3.5, y: 0.1 },
    wingtips: [[-TIP[0], TIP[1], 2.9], [TIP[0], TIP[1], 2.9]],
  });

  // Test and debug readout of the effect levels (flame, heat, cone, tips).
  root.userData.jetEffects = effects;

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let gearPosition = NaN;
  let wheelAngle = 0;
  let nozzleOpening = 0.25;
  let leadingAngle = 0;
  let brakeAngle = 0;

  function poseGear(position) {
    const extension = clamp(position, 0, 1);
    const retract = 1 - extension;
    noseLeg.pivot.rotation.x = NOSE_GEAR.RETRACT * retract;
    for (const leg of mainLegs) {
      leg.pivot.rotation.x = MAIN_GEAR.RETRACT * retract;
      leg.twist.quaternion.setFromAxisAngle(leg.twistAxis, leg.side * MAIN_GEAR.TWIST * retract);
    }
    // Doors open as soon as the gear starts to move and stay open while it is down.
    const doorOpen = clamp(extension / 0.15, 0, 1);
    const eased = doorOpen * doorOpen * (3 - 2 * doorOpen);
    for (const door of doors) door.pivot.quaternion.setFromAxisAngle(door.pivot.userData.axis, door.angle * eased);
    const visible = extension > 0.001;
    noseLeg.pivot.visible = visible;
    for (const leg of mainLegs) leg.pivot.visible = visible;
  }

  return {
    root,
    wingtips: [new THREE.Vector3(-TIP[0], TIP[1], TIP[2]), new THREE.Vector3(TIP[0], TIP[1], TIP[2])],
    eyeAnchor,
    /** Local attachment points: the nozzle exit and the tail. */
    anchors: {
      nozzle: new THREE.Vector3(0, NOZZLE.Y, NOZZLE.Z + NOZZLE.LENGTH),
      tail: new THREE.Vector3(0, 0.4, 7.0),
    },

    update(visual, dt) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const sim = flight.mode === 'sim';
      const craftState = flight.craftState || {};
      const roll = clamp(Number.isFinite(visual.aileron) ? visual.aileron : 0, -1, 1);
      const pitch = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1);
      const yaw = clamp(Number.isFinite(visual.rudder) ? visual.rudder : 0, -1, 1);
      const flaps = clamp(Number.isFinite(visual.flaps) ? visual.flaps : 0, 0, 1);

      // Flaperons: ailerons plus flaps (trailing edge down positive on the right hinge axis).
      const aileronAngle = -roll * SURFACE_LIMITS.aileron * DEG;
      const flapAngle = flaps * FLAP_MAX_DEFLECTION * DEG;
      flaperonRight.quaternion.setFromAxisAngle(flaperonRight.userData.axis, aileronAngle + flapAngle);
      flaperonLeft.quaternion.setFromAxisAngle(flaperonLeft.userData.axis, aileronAngle - flapAngle);
      // Stabilators: pitch together (trailing edge up for nose up), a share of roll differentially.
      const stabPitch = pitch * SURFACE_LIMITS.elevator;
      const stabRoll = roll * 0.35 * SURFACE_LIMITS.elevator;
      stabRight.quaternion.setFromAxisAngle(stabRight.userData.axis, -(stabPitch + stabRoll) * DEG);
      stabLeft.quaternion.setFromAxisAngle(stabLeft.userData.axis, -(stabPitch - stabRoll) * DEG);
      rudder.quaternion.setFromAxisAngle(rudder.userData.axis, yaw * SURFACE_LIMITS.rudder * DEG);

      // Leading-edge flaps: scheduled with angle of attack, retracted through the transonic band,
      // set for take-off on the ground.
      const aoa = sim && Number.isFinite(flight.aoa) ? flight.aoa : 2 + Math.max(0, pitch) * 10;
      const mach = Number.isFinite(flight.mach) ? flight.mach : 0;
      const scheduled = visual.onGround ? LEADING_FLAP.TAKEOFF * (flaps > 0 ? 1 : 0.5) : clamp((aoa - 2) * LEADING_FLAP.PER_DEGREE, 0, LEADING_FLAP.MAX) * (1 - clamp((mach - 0.85) / 0.2, 0, 1));
      leadingAngle = step > 0 ? damp(leadingAngle, scheduled, 4, step) : scheduled;
      leadingRight.quaternion.setFromAxisAngle(leadingRight.userData.axis, -leadingAngle * DEG);
      leadingLeft.quaternion.setFromAxisAngle(leadingLeft.userData.axis, leadingAngle * DEG);

      // Speed brakes.
      const airbrake = clamp(Number.isFinite(visual.airbrake) ? visual.airbrake : 0, 0, 1);
      brakeAngle = airbrake * BRAKE.MAX_ANGLE * DEG;
      for (const brake of brakes) brake.pivot.quaternion.setFromAxisAngle(brake.pivot.userData.axis, brake.sign * brakeAngle);

      // Nozzle: the SIM engine's own nozzle; CLASSIC opens it with the throttle and the boost.
      const throttle = clamp(Number.isFinite(visual.throttle) ? visual.throttle : 0, 0, 1);
      const burner = sim ? clamp(Number.isFinite(craftState.afterburner) ? craftState.afterburner : 0, 0, 1) : visual.boost ? 1 : 0;
      const nozzleTarget = sim && Number.isFinite(craftState.nozzle) ? craftState.nozzle : 0.2 + 0.1 * (1 - throttle) + 0.7 * burner;
      nozzleOpening = step > 0 ? damp(nozzleOpening, nozzleTarget, 5, step) : nozzleTarget;
      const convergence = petalAngle(nozzleOpening);
      for (const petal of petals) petal.rotation.x = convergence;

      // Gear: SIM follows the gear lever through the transit time; CLASSIC always flies clean.
      const gearTarget = sim && visual.gearDown !== false ? 1 : 0;
      if (!Number.isFinite(gearPosition)) gearPosition = gearTarget;
      else if (step > 0) gearPosition = gearTarget > gearPosition ? Math.min(gearTarget, gearPosition + step / GEAR_TRANSIT_SECONDS) : Math.max(gearTarget, gearPosition - step / GEAR_TRANSIT_SECONDS);
      poseGear(gearPosition);
      if (visual.onGround && Number.isFinite(visual.groundSpeed) && step > 0) {
        wheelAngle = (wheelAngle - (visual.groundSpeed / MAIN_GEAR.RADIUS) * step) % (Math.PI * 2);
        for (const leg of mainLegs) leg.wheel.rotation.x = wheelAngle;
        noseLeg.wheel.rotation.x = (wheelAngle * MAIN_GEAR.RADIUS) / NOSE_GEAR.RADIUS;
      }

      effects.update({
        dt: step,
        time: visual.time,
        sim,
        throttle,
        burner,
        spool: sim && Number.isFinite(craftState.spool) ? craftState.spool : 0.62 + 0.38 * throttle,
        engineOn: visual.engineOn !== false,
        nozzle: nozzleOpening,
        mach,
        altitude: Number.isFinite(flight.altitude) ? flight.altitude : 0,
        airspeed: Number.isFinite(flight.airspeed) ? flight.airspeed : 0,
        gLoad: Number.isFinite(flight.gLoad) ? flight.gLoad : 1,
        aoa,
      });
      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: afterburner. Space (SIM) pushes the throttle through the detent to full afterburner, or
// brings it back; a HOTAS throttle lights it by passing the detent itself. In CLASSIC the button is
// v1's boost, which lights the burner too.
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Afterburner',
  modes: Object.freeze(['sim']),
  initialState: () => ({ abDetent: false, abRequest: null, afterburner: 0, nozzle: 0.25, spool: 0, mach: 0, overG: false, thrust: 0 }),
  run(flight) {
    flight.craftState.abRequest = 'toggle';
    return true;
  },
});

export default Object.freeze({
  id: 'jet',
  name: 'Jet',
  buildMesh,
  arcadeProfile,
  simProfile,
  /**
   * ControlState mapping: throttle is engine power up to the afterburner detent (a HOTAS lever passes
   * it; Space pushes any other throttle through); flapsUp / flapsDown and the flap axis step through
   * the 2 flaperon notches; gearToggle cycles the gear; the airbrake opens the speed brakes; toe brakes
   * brake the mains (differential steers) and the rudder steers the nose wheel at taxi speed.
   */
  inputProfile: Object.freeze({ throttle: 'throttle', flapNotches: 2, toeBrakes: 'wheels', rudderSteersTailwheel: true, afterburnerDetent: true }),
  audioProfile: Object.freeze({
    engine: 'jet', whineHz: 3300, rumbleHz: 40, idleSpool: 0.62, spoolUp: 0.4, spoolDown: 0.6, afterburnerRoar: 1.15,
    airflowSpeed: 300, classicAirflowSpeed: 300, interiorCutoff: 650, stallHorn: true, stallHornStyle: 'beep', stallAoa: 24,
    touchdown: 'wheels', callouts: true, motorPitch: 0.8, level: 1,
  }),
  capabilities: Object.freeze({ engine: true, chute: false }),
  cameraRig: Object.freeze({
    eye: EYE,
    // The chase camera's pull-back, FOV stretch and speed shake scale to the jet's speeds.
    chase: Object.freeze({ distance: 19, height: 4.4, lookAhead: 22, speedRange: arcadeProfile.SPEED }),
    wing: Object.freeze({ position: Object.freeze([5.6, 0.9, 3.4]), target: Object.freeze([0.6, 0.2, -3]) }),
    fpv: null,
    // Fighter cockpit under the bubble canopy: a narrow tub with high sills, a low glareshield and a
    // wide, shallow panel (flight instruments centre, engine and gear right).
    cockpit: Object.freeze({
      style: 'canopy',
      width: 0.72,
      sill: -0.3,
      floor: -0.85,
      front: -0.95,
      back: 0.5,
      roof: 0.3,
      panel: Object.freeze({
        width: 0.6,
        center: Object.freeze([0, -0.27, -0.55]),
        layout: Object.freeze([
          Object.freeze(['aoa', 'airspeed', 'attitude', 'altitude', 'vsi']),
          Object.freeze(['g', 'heading', 'throttle', 'flapsGear']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'throttle', 'flapsGear']),
  abilities: Object.freeze({ craftAbility }),
  // Cruise about 800 km/h; a take-off needs a long flat strip.
  spawn: Object.freeze({ cruise: 222, cruiseThrottle: 0.34, hover: false, relaunch: 'airstart', canStartOnGround: true, runwayLength: 900 }),
  // Vne: 410 m/s equivalent airspeed (about 1480 km/h indicated) or Mach 1.7, whichever comes first.
  limits: Object.freeze({ vne: 410, vneMach: 1.7, gLimit: 9, crashSinkRate: 4.5, bodyStrikeSpeed: 3, floats: false }),
});
