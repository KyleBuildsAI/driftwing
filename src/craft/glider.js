// GLIDER: the v1 motor-glider. Its mesh is the v1 model moved verbatim (15 m span, upturned
// winglets, T-tail, bubble canopy, nose prop, nav lights and strobe); its CLASSIC tuning is v1's
// arcade constants exactly; its SIM profile describes a 15 m class sailplane (L/D about 40,
// min sink about 0.6 m/s, stall about 65 km/h, Vne about 270 km/h) with spoilers and water ballast.
import * as THREE from 'three/webgpu';
import { CONFIG } from '../core/config.js';
import { DEG } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, piecewise, mirrorPoint, getCraftMaterials, addSolid, addPivot,
  createPropDisc, createNavLights, disposeCraftMesh,
} from './kit.js';

// ============================================================================================
// CLASSIC: v1's arcade constants, unchanged (ArcadeModel reads them by these names).
// ============================================================================================
const arcadeProfile = Object.freeze({
  SPEED: CONFIG.SPEED,
  GRAVITY: 9.81,
  DRAG_COEFFICIENT: 0.0011,
  THROTTLE_SPEED_EXPONENT: 1.3, // terminal speed = MAX * throttle^1.3 -> 62 m/s at 55 %
  THROTTLE_RATE: 0.42,
  INDUCED_DRAG: 0.5,
  INDUCED_MAX_EXTRA_G: 3,
  MAX_PITCH_RATE: 70 * DEG,
  MAX_ROLL_RATE: 130 * DEG,
  MAX_YAW_RATE: 18 * DEG,
  // Bank-to-turn: the roll axis commands a bank ANGLE (full input = MAX_BANK); releasing it
  // rolls back to level in about a second. Only the canned barrel roll goes past MAX_BANK.
  MAX_BANK: 72 * DEG,
  BANK_GAIN: 3.4,
  FINE_BANK_SCALE: 0.55,
  YAW_BANK: 10 * DEG,
  // Soft attitude limit: pitch input fades out between 50 and 78 degrees of nose elevation,
  // so the stick alone can never loop the glider onto its back.
  PITCH_LIMIT_START: 50 * DEG,
  PITCH_LIMIT_RANGE: 28 * DEG,
  TURN_GAIN: 1.6,
  MAX_TURN_RATE: 38 * DEG,
  BANK_NOSE_DROP: 4 * DEG,
  BANK_SETTLE_PITCH: 4 * DEG,
  FINE_CONTROL_SCALE: 0.45,
  AUTO_LEVEL_DELAY: 1.2,
  STALL_EXIT_MARGIN: 4,
  STALL_NOSE_TARGET: -20 * DEG,
  // Pitch authority tapers above this speed (m/s) toward SPEED.MAX.
  HIGH_SPEED_PITCH_START: 70,
  CUSHION_HEIGHT: 25,
  IMPACT_WARNING_SECONDS: 2.5,
  IMPACT_FULL_SECONDS: 0.7,
  CUSHION_PULL_RATE: 60 * DEG,
  GUARD_PROBE_SECONDS: Object.freeze([1.1, 2.2, 3.4]),
  GUARD_MARGIN: 18,
  // Slowest horizontal speed (m/s) the terrain guard assumes when probing ahead.
  GUARD_MIN_SPEED: 20,
  GUARD_EVADE_GRADIENT: Math.tan(28 * DEG),
  GUARD_EVADE_BANK: 55 * DEG,
  CEILING_BAND: 260,
  BOOST_DURATION: 2.2,
  BOOST_COOLDOWN: 6,
  BARREL_ROLL_DURATION: 1.1,
  BARREL_ROLL_RADIUS: 1.8,
  AUTOPILOT: Object.freeze({
    MAX_BANK: 30 * DEG,
    MAX_PITCH: 8 * DEG,
    TERRAIN_PITCH: 12 * DEG,
    CLEARANCE: 120,
    RING_CLEARANCE: 45,
    MIN_ALTITUDE: 60,
    CRUISE_THROTTLE: 0.55,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    TERRAIN_MAX_PITCH: 20 * DEG,
    LOOKAHEAD_DISTANCES: Object.freeze([0, 90, 180, 300, 450, 650, 900, 1300]),
    PATH_LOOKAHEAD_DISTANCES: Object.freeze([150, 350, 650]),
    // Heading hold / waypoint following: calm, wide turns.
    WAYPOINT_STEERING: Object.freeze({ BANK_PER_DEGREE: 1.2, MAX_BANK: 30 * DEG, DAMPING: 2.2, MAX_ROLL_RATE: 45 * DEG }),
    // Ring following threads 16 m rings: firmer banking toward a point on the ring's axis
    // (cross-track correction), altitude timed to arrive at the ring's height, and terrain
    // sampled only up to just past the ring (the course guarantees clearance there).
    RING_STEERING: Object.freeze({ BANK_PER_DEGREE: 2.0, MAX_BANK: 40 * DEG, DAMPING: 3.5, MAX_ROLL_RATE: 60 * DEG }),
    RING_MAX_PITCH: 12 * DEG,
    RING_MIN_TIME_TO_RING: 1.5,
    RING_VERTICAL_SPEED_GAIN: 0.015,
    RING_LOOKAHEAD_MARGIN: 150,
    RING_TRACK_LEAD_SECONDS: 2.4,
    RING_TRACK_LEAD_MIN: 100,
    RING_TRACK_LEAD_MAX: 200,
  }),
  // Load factor shown to fx / audio: ~1/cos(bank) in a level turn plus a modest share of
  // the pitch-rate pull, soft-capped (the arcade turn and pitch rates would read ~9 g).
  LOAD: Object.freeze({ PULL_SHARE: 0.2, KNEE: 3.5, CAP: 5, MIN: -1, SMOOTHING: 5, MIN_BANK_COS: 0.2, BARREL_ROLL_EXTRA: 0.8 }),
  // Visual deflection scales (rate -> surface) used by the control-surface animation.
  SURFACE_TURN_SHARE: 0.3,
});

// ============================================================================================
// SIM: a 15 m class sailplane. Targets first, then the physical parameters that meet them
// (derivations in the comments), then contact points in body axes (x right, y up, z aft; m).
// ============================================================================================
const simProfile = Object.freeze({
  model: 'fixedWing',
  targets: Object.freeze({
    liftToDrag: 40,
    minSink: 0.6, // m/s at about 20.5 m/s (CL 1.31)
    stallSpeed: 18.1, // m/s = 65 km/h dry, clean
    bestGlideSpeed: 27, // m/s (CL 0.76)
    cruiseSpeed: 30,
    vne: 75, // m/s = 270 km/h
  }),
  mass: Object.freeze({ empty: 270, pilot: 90 }), // kg; 360 kg dry, wing loading 34 kg/m^2
  // Water ballast in the wings; craftState.ballast is the fill fraction (0..1) the SIM model adds
  // to the mass: 150 kg full raises the stall to about 77 km/h and the best-glide speed with it.
  ballast: Object.freeze({ capacity: 150, dumpSeconds: 60 }),
  inertia: Object.freeze({ pitch: 900, yaw: 3300, roll: 2600 }), // kg m^2 about body x, y, z
  centerOfMass: Object.freeze([0, 0, -0.3]),
  wing: Object.freeze({
    span: 15,
    area: 10.5, // m^2
    aspectRatio: 21.4,
    meanChord: 0.72,
    oswald: 0.9,
    incidence: 1.5, // deg
    dihedral: 3.2, // deg
    aerodynamicCenter: Object.freeze([0, 0.35, -0.2]),
  }),
  aero: Object.freeze({
    cd0: 0.0095, // L/Dmax = 0.5 * sqrt(pi * e * AR / cd0) = 40
    clAlpha: 5.6, // per rad
    cl0: 0.35,
    clMax: 1.65, // stall 18.1 m/s dry
    alphaCritical: 15, // deg, then a post-stall drop
    postStallClDrop: 0.45,
    sideForcePerRad: 0.9,
  }),
  tail: Object.freeze({ arm: 4.5, horizontalArea: 1.1, verticalArea: 0.95 }),
  controls: Object.freeze({ aileron: 20, elevator: 18, rudder: 22 }), // max deflection, deg (matches the mesh)
  spoilers: Object.freeze({ cdIncrement: 0.03, clLoss: 0.25, deploySeconds: 0.8 }),
  flaps: null,
  gear: Object.freeze({ retractable: false }),
  engine: null,
  contacts: Object.freeze([
    Object.freeze({ id: 'mainWheel', kind: 'wheel', gear: true, position: Object.freeze([0, -0.62, -0.3]), spring: 60000, damping: 4200, rollingFriction: 0.03, sideFriction: 0.8, brake: true }),
    Object.freeze({ id: 'noseSkid', kind: 'skid', gear: true, position: Object.freeze([0, -0.5, -1.9]), spring: 40000, damping: 3000, friction: 0.45 }),
    Object.freeze({ id: 'tailWheel', kind: 'wheel', gear: true, position: Object.freeze([0, 0.12, 4.5]), spring: 20000, damping: 1500, rollingFriction: 0.05, sideFriction: 0.6 }),
    Object.freeze({ id: 'leftWingtip', kind: 'skid', gear: true, position: Object.freeze([-7.4, 0.66, 0.05]), spring: 15000, damping: 1200, friction: 0.5 }),
    Object.freeze({ id: 'rightWingtip', kind: 'skid', gear: true, position: Object.freeze([7.4, 0.66, 0.05]), spring: 15000, damping: 1200, friction: 0.5 }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, -0.02, -3.07]) }),
    Object.freeze({ id: 'canopy', kind: 'body', gear: false, position: Object.freeze([0, 0.86, -0.8]) }),
    Object.freeze({ id: 'tailCone', kind: 'body', gear: false, position: Object.freeze([0, 0.25, 4.78]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 1.8, 4.3]) }),
  ]),
});

// ============================================================================================
// MESH: the v1 glider model (built from code, flat-shaded, vertex-coloured, local frame: nose -z, up +y)
// ============================================================================================
// Airfoils as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
const WING_PROFILE = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [1, 0], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
const WING_PROFILE_CUT = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [0.72, 0.1], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
const AILERON_PROFILE = [[0.735, 0.29], [1, 0], [0.735, -0.1]];
const AILERON_HINGE = [0.735, 0.095];
const TAIL_PROFILE_CUT = [[0, 0], [0.07, 0.45], [0.3, 0.5], [0.7, 0.3], [0.7, 0], [0.7, -0.3], [0.3, -0.5], [0.07, -0.45]];
const TAIL_SURFACE_PROFILE = [[0.715, 0.29], [1, 0], [0.715, -0.29]];
const TAIL_HINGE_FRACTION = 0.715;

// Wing planform (right half; x spanwise). LE and chord are linear across the aileron span,
// so the aileron hinge line is straight.
const WING_CHORD = [[0.25, 1.18], [3.3, 0.98], [4.4, 0.88], [7.35, 0.46]];
const WING_TIP_X = 7.35;
const DIHEDRAL_SLOPE = Math.tan(3.2 * DEG);
const wingChord = (x) => piecewise(WING_CHORD, x);
const wingLeadingEdge = (x) => -0.48 + 0.041 * (x - 0.25);
const wingHeight = (x) => 0.3 + (x - 0.25) * DIHEDRAL_SLOPE;
const wingThickness = (x) => 0.15 - (0.04 * (x - 0.25)) / (WING_TIP_X - 0.25);
function wingSection(x, profile) {
  return profileSection(profile, [x, wingHeight(x), wingLeadingEdge(x)], [0, 0, 1], [0, 1, 0], wingChord(x), wingThickness(x));
}
function aileronHingePoint(x) {
  const chord = wingChord(x);
  return [x, wingHeight(x) + AILERON_HINGE[1] * wingThickness(x) * chord, wingLeadingEdge(x) + AILERON_HINGE[0] * chord];
}

function buildWingHalf(builder, side) {
  const mirror = (section) => section.map((point) => mirrorPoint(point, side));
  const lowerEdge = (edge) => edge >= 4;
  const inboard = [0.25, 0.9, 3.3, 4.4].map((x) => mirror(wingSection(x, WING_PROFILE)));
  builder.loft(inboard, (segment, edge) => (lowerEdge(edge) ? PALETTE.creamShade : PALETTE.cream), { capEnd: PALETTE.cream });
  const outboard = [4.4, 5.9, 6.5, WING_TIP_X].map((x) => mirror(wingSection(x, WING_PROFILE_CUT)));
  builder.loft(outboard, (segment, edge) => {
    if (segment === 1) return PALETTE.orange;
    return lowerEdge(edge) ? PALETTE.creamShade : PALETTE.cream;
  }, { capEnd: PALETTE.cream });
  // Upturned winglet: sections rotate from horizontal to near-vertical, sweeping back.
  const tipY = wingHeight(WING_TIP_X);
  const winglet = [
    { x: WING_TIP_X, y: tipY, le: wingLeadingEdge(WING_TIP_X), chord: wingChord(WING_TIP_X), thickness: wingThickness(WING_TIP_X), cant: 0 },
    { x: 7.47, y: tipY + 0.1, le: -0.14, chord: 0.4, thickness: 0.1, cant: 40 },
    { x: 7.56, y: tipY + 0.36, le: -0.02, chord: 0.31, thickness: 0.1, cant: 76 },
    { x: 7.6, y: tipY + 0.62, le: 0.08, chord: 0.22, thickness: 0.1, cant: 84 },
  ].map((station) => mirror(profileSection(
    WING_PROFILE,
    [station.x, station.y, station.le],
    [0, 0, 1],
    [-Math.sin(station.cant * DEG), Math.cos(station.cant * DEG), 0],
    station.chord,
    station.thickness,
  )));
  builder.loft(winglet, () => PALETTE.orange, { capEnd: PALETTE.orange });
}

function buildAileron(side) {
  const builder = createMeshBuilder();
  const stations = [4.45, 5.9, 6.5, 7.32];
  const sections = stations.map((x) => profileSection(AILERON_PROFILE, [x, wingHeight(x), wingLeadingEdge(x)], [0, 0, 1], [0, 1, 0], wingChord(x), wingThickness(x))
    .map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hingeStart = mirrorPoint(aileronHingePoint(stations[0]), side);
  const hingeEnd = mirrorPoint(aileronHingePoint(stations[stations.length - 1]), side);
  const axis = new THREE.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
  return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
}

// Fuselage stations: [z, centre y, half width, half height].
const FUSELAGE = [
  [-2.62, -0.02, 0.26, 0.27],
  [-2.3, 0.0, 0.42, 0.45],
  [-1.6, 0.02, 0.5, 0.55],
  [-0.6, 0.05, 0.52, 0.58],
  [0.4, 0.08, 0.46, 0.52],
  [1.4, 0.14, 0.32, 0.37],
  [2.6, 0.22, 0.2, 0.25],
  [3.8, 0.3, 0.14, 0.19],
  [4.78, 0.34, 0.08, 0.11],
];
const FUSELAGE_SIDES = 12;
function fuselageAt(z) {
  const column = (index) => FUSELAGE.map((station) => [station[0], station[index]]);
  return { centreY: piecewise(column(1), z), halfWidth: piecewise(column(2), z), halfHeight: piecewise(column(3), z) };
}
function buildFuselage(builder) {
  const sections = FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => {
    const ring = [];
    for (let index = 0; index < FUSELAGE_SIDES; index++) {
      const angle = (15 + index * 30) * DEG;
      ring.push([halfWidth * Math.cos(angle), centreY + halfHeight * Math.sin(angle), z]);
    }
    return ring;
  });
  builder.loft(sections, (segment, face) => {
    if (segment === 0) return PALETTE.orange;
    if (segment === 1 && face >= 1 && face <= 3) return PALETTE.charcoal;
    if ((face === 11 || face === 5) && segment <= 6) return PALETTE.orange;
    if (face >= 7 && face <= 9) return PALETTE.creamShade;
    return PALETTE.cream;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.cream });
}

function buildCanopyGeometry() {
  const builder = createMeshBuilder();
  const stations = [[-1.95, 0.06, 0.012], [-1.65, 0.24, 0.12], [-1.2, 0.32, 0.22], [-0.6, 0.34, 0.25], [-0.05, 0.3, 0.19], [0.35, 0.2, 0.1], [0.6, 0.07, 0.02]];
  const sections = stations.map(([z, halfWidth, bubble]) => {
    const body = fuselageAt(z);
    const surfaceAt = (x) => body.centreY + body.halfHeight * Math.sqrt(Math.max(0, 1 - (x / body.halfWidth) ** 2)) - 0.025;
    const topY = body.centreY + body.halfHeight + bubble;
    const arc = [];
    for (let index = 0; index <= 6; index++) {
      const angle = Math.PI - (index / 6) * Math.PI;
      const x = halfWidth * Math.cos(angle);
      arc.push([x, surfaceAt(x) + (topY - surfaceAt(0)) * Math.sin(angle), z]);
    }
    return arc;
  });
  builder.loft(sections, () => PALETTE.charcoal, { closed: false });
  return builder.toGeometry(null);
}

// Tail: vertical fin (y spanwise) and T-tail stabilizer (x spanwise) with straight hinge lines.
const finLeadingEdge = (y) => 3.15 + ((4.02 - 3.15) * (y - 0.3)) / 1.4;
const finChord = (y) => 1.45 + ((0.78 - 1.45) * (y - 0.3)) / 1.4;
const FIN_THICKNESS = 0.11;
const STAB_Y = 1.72;
const STAB_HINGE_Z = 4.52;
const STAB_HALF_SPAN = 1.55;
const stabChord = (x) => 0.8 - ((0.8 - 0.46) * Math.abs(x)) / STAB_HALF_SPAN;
const stabLeadingEdge = (x) => STAB_HINGE_Z - TAIL_HINGE_FRACTION * stabChord(x);
const STAB_THICKNESS = 0.1;

function buildTail(builder) {
  const finSections = [0.3, 1.3, 1.7].map((y) => profileSection(TAIL_PROFILE_CUT, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN_THICKNESS));
  builder.loft(finSections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  const stabSections = [-STAB_HALF_SPAN, -1.2, 0, 1.2, STAB_HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB_Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB_THICKNESS));
  builder.loft(stabSections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
}
function buildRudder() {
  const builder = createMeshBuilder();
  const heights = [0.32, 1.3, 1.67];
  const sections = heights.map((y) => profileSection(TAIL_SURFACE_PROFILE, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN_THICKNESS));
  builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  const hinge = (y) => [0, y, finLeadingEdge(y) + TAIL_HINGE_FRACTION * finChord(y)];
  const start = hinge(heights[0]);
  const end = hinge(heights[heights.length - 1]);
  const axis = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize();
  return { geometry: builder.toGeometry(start), pivot: start, axis };
}
function buildElevator() {
  const builder = createMeshBuilder();
  const stations = [-1.53, -1.2, 0, 1.2, 1.53];
  const sections = stations.map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB_Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB_THICKNESS));
  builder.loft(sections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  const pivot = [0, STAB_Y, STAB_HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

// Propeller: faceted spinner + two twisted blades with orange tips (rotates about local z).
const PROP_PIVOT = [0, -0.02, -2.62];
const PROP_PLANE_Z = -0.16;
function buildPropeller() {
  const builder = createMeshBuilder();
  const spinner = [[0, 0.255], [-0.16, 0.24], [-0.3, 0.17], [-0.4, 0.075], [-0.45, 0.0]].map(([z, radius]) => {
    const ring = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
    return ring;
  });
  builder.loft(spinner, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal });
  const bladeStations = [[0.12, 0.12, 48], [0.35, 0.15, 32], [0.62, 0.12, 22], [0.8, 0.09, 18], [0.91, 0.055, 16]];
  const bladeThickness = 0.022;
  for (const direction of [1, -1]) {
    const sections = bladeStations.map(([radius, width, pitchDegrees]) => {
      const pitch = pitchDegrees * DEG;
      const chord = [Math.cos(pitch) * direction, 0, -Math.sin(pitch)];
      const across = [Math.sin(pitch) * direction, 0, Math.cos(pitch)];
      const centre = [0, radius * direction, PROP_PLANE_Z];
      return [
        [centre[0] + chord[0] * width * 0.5, centre[1], centre[2] + chord[2] * width * 0.5],
        [centre[0] + across[0] * bladeThickness, centre[1], centre[2] + across[2] * bladeThickness],
        [centre[0] - chord[0] * width * 0.5, centre[1], centre[2] - chord[2] * width * 0.5],
        [centre[0] - across[0] * bladeThickness, centre[1], centre[2] - across[2] * bladeThickness],
      ];
    });
    builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  return builder.toGeometry(null);
}

const TIP_Y = wingHeight(WING_TIP_X);
const TIP_LEADING_EDGE = wingLeadingEdge(WING_TIP_X);
const EYE = Object.freeze([0, 0.52, -0.95]);

/**
 * Builds the glider. update(visual, dt) animates ailerons / elevator / rudder from the normalized
 * deflections (visual.aileron, elevator, rudder in -1..1), spins the prop (visual.propSpeed in
 * rad/s, or v1's throttle / boost rule when absent) and runs the nav lights from visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const planeMesh = new THREE.Group();
  planeMesh.name = 'glider';

  const airframeBuilder = createMeshBuilder();
  buildFuselage(airframeBuilder);
  buildWingHalf(airframeBuilder, 1);
  buildWingHalf(airframeBuilder, -1);
  buildTail(airframeBuilder);
  addSolid(planeMesh, airframeBuilder.toGeometry(null), bodyMaterial);
  addSolid(planeMesh, buildCanopyGeometry(), materials.canopy);
  const aileronRight = addPivot(planeMesh, buildAileron(1), bodyMaterial);
  const aileronLeft = addPivot(planeMesh, buildAileron(-1), bodyMaterial);
  const elevator = addPivot(planeMesh, buildElevator(), bodyMaterial);
  const rudder = addPivot(planeMesh, buildRudder(), bodyMaterial);

  const propeller = new THREE.Group();
  propeller.position.set(PROP_PIVOT[0], PROP_PIVOT[1], PROP_PIVOT[2]);
  addSolid(propeller, buildPropeller(), bodyMaterial);
  const propDisc = createPropDisc(0.93);
  propDisc.mesh.position.z = PROP_PLANE_Z - 0.03;
  propeller.add(propDisc.mesh);
  planeMesh.add(propeller);

  const navLights = createNavLights(planeMesh, {
    red: { position: [-7.4, TIP_Y + 0.02, TIP_LEADING_EDGE + 0.08], glow: [-7.5, TIP_Y + 0.03, TIP_LEADING_EDGE + 0.02] },
    green: { position: [7.4, TIP_Y + 0.02, TIP_LEADING_EDGE + 0.08], glow: [7.5, TIP_Y + 0.03, TIP_LEADING_EDGE + 0.02] },
    strobe: { position: [0, STAB_Y + 0.08, 4.36], glow: [0, STAB_Y + 0.16, 4.36] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  planeMesh.add(eyeAnchor);

  let propAngle = 0;

  return {
    root: planeMesh,
    wingtips: [new THREE.Vector3(-7.45, TIP_Y + 0.05, 0.26), new THREE.Vector3(7.45, TIP_Y + 0.05, 0.26)],
    eyeAnchor,
    /** Local attachment points: tow hook under the nose, ballast outlets under the wing roots, tail. */
    anchors: {
      towHook: new THREE.Vector3(0, -0.36, -2.2),
      ballastLeft: new THREE.Vector3(-1.5, 0.27, 0.12),
      ballastRight: new THREE.Vector3(1.5, 0.27, 0.12),
      tail: new THREE.Vector3(0, 0.34, 4.8),
    },

    update(visual, dt) {
      // Right aileron trailing edge rises for a right roll; the left hinge axis is mirrored,
      // so the same signed angle lowers the left aileron.
      const aileronAngle = -visual.aileron * 20 * DEG;
      aileronRight.quaternion.setFromAxisAngle(aileronRight.userData.axis, aileronAngle);
      aileronLeft.quaternion.setFromAxisAngle(aileronLeft.userData.axis, aileronAngle);
      elevator.quaternion.setFromAxisAngle(elevator.userData.axis, -visual.elevator * 18 * DEG);
      rudder.quaternion.setFromAxisAngle(rudder.userData.axis, visual.rudder * 22 * DEG);

      const propSpeed = Number.isFinite(visual.propSpeed) ? visual.propSpeed : 5 + 23 * visual.throttle + (visual.boost ? 8 : 0);
      propAngle = (propAngle + propSpeed * dt) % (Math.PI * 2);
      if (!Number.isFinite(propAngle)) propAngle = 0;
      propeller.rotation.z = propAngle;
      propDisc.setSpeed(propSpeed);

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(planeMesh, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: water ballast (SIM). Opening the dump valve drains the wing tanks over about a minute,
// lowering the wing loading (slower stall and best-glide speed); fine spray trails from the outlets.
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Dump water ballast',
  modes: Object.freeze(['sim']),
  initialState: () => ({ ballast: 1, dumping: false }),
  run(flight) {
    const craftState = flight.craftState;
    if (craftState.ballast <= 0) {
      flight.notify('The ballast tanks are already empty.');
      return false;
    }
    craftState.dumping = !craftState.dumping;
    flight.notify(craftState.dumping ? 'Dumping water ballast.' : 'Ballast valves closed.');
    return true;
  },
  update(flight, dt) {
    const craftState = flight.craftState;
    if (!craftState.dumping) return;
    craftState.ballast = Math.max(0, craftState.ballast - dt / simProfile.ballast.dumpSeconds);
    flight.emitTrail('spray', 'ballastLeft', dt);
    flight.emitTrail('spray', 'ballastRight', dt);
    if (craftState.ballast <= 0) {
      craftState.dumping = false;
      flight.notify('Ballast dumped. The wing is lighter now.');
    }
  },
});

export default Object.freeze({
  id: 'glider',
  name: 'Glider',
  buildMesh,
  arcadeProfile,
  simProfile,
  /**
   * ControlState mapping: no engine, so the throttle axis is ignored in SIM; the airbrake action or
   * both toe brakes in the air open the spoilers; toe brakes on the ground brake the main wheel.
   */
  inputProfile: Object.freeze({ throttle: 'none', spoilers: 'airbrake', toeBrakes: 'wheelsAndSpoilers', flapNotches: 0 }),
  audioProfile: Object.freeze({ engine: 'glider', variometer: true }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 17.5, height: 4.2, lookAhead: 16 }),
    wing: Object.freeze({ position: Object.freeze([3.4, 0.95, 1.5]), target: Object.freeze([0, 0.45, -1.8]) }),
    fpv: null,
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'flapsGear', 'vario', 'ld']),
  abilities: Object.freeze({ craftAbility }),
  spawn: Object.freeze({ cruise: 30, hover: false, relaunch: 'aerotow', canStartOnGround: true }),
  limits: Object.freeze({ vne: 75, gLimit: 5.3, crashSinkRate: 4, bodyStrikeSpeed: 6, floats: false }),
});
