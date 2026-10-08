// SEAPLANE: a Beaver-style amphibious bush floatplane, built from code in the v1 glider's style
// (flat-shaded, vertex-coloured lofts in the v1 palette). High constant-chord wing on single lift
// struts, a boxy cabin behind a round radial-engine cowling with its nine cylinder heads showing, a
// three-blade prop with a blur disc, a tall fin with a ventral finlet, and two long V-bottomed
// amphibian floats on N-struts with spreader bars. Animated: ailerons, elevator, rudder, 3-notch
// flaps, the prop, the four amphibian wheels (nose wheels fold forward into the bows, mains swing up
// onto the float decks) and the water rudders at the float sterns (they swing down into the water
// and turn with the pedals).
//
// It flies on SimFixedWing with the floats extension (src/flight/floats.js): per-float buoyancy
// against the shared water query (the ocean's swell and every lake), the hump near 45 km/h and
// planing on the step, porpoising at the wrong trim, the water rudders, the gear advisory, the
// wheels-down nose-over and the wheels-up skid on land. Its flight profile describes the real
// thing (stall about 83 km/h with full flaps, cruise about 195 km/h, climb about 5.3 m/s, a long
// water run at the hump, then quick acceleration on the step).
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp, wrapDegrees } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, mirrorPoint, getCraftMaterials, addSolid, addPivot,
  createPropDisc, createNavLights, disposeCraftMesh, ellipseRing,
} from './kit.js';
import { createFloatsExtension, floatKeelHeight } from '../flight/floats.js';

// ============================================================================================
// SIM: a Beaver-class amphibian for SimFixedWing plus the floats extension. Targets first, then the
// physical parameters that meet them, then the floats and the contact points. Positions are body
// axes relative to the mesh origin (x right, y up, z aft; m); angles in degrees. tools/lab/seaplane.mjs
// measures the targets.
// ============================================================================================
const FLOATS = Object.freeze({
  waterDensity: 1000,
  /** The floats' centrelines (body x, m). */
  hulls: Object.freeze([-1.45, 1.45]),
  /**
   * Keel line: the step's keel height (body y), the step's position, the bow and the stern; the keel
   * rises toward the bow (rocker), steps up at the step and rises aft of it at the sternpost angle.
   */
  keel: Object.freeze({ stepY: -2.18, stepZ: -0.4, bowZ: -4.05, sternZ: 4.05, bowRise: 0.62, stepHeight: 0.07, sternpostAngle: 7.5 }),
  beam: 0.92,
  deadrise: 22,
  /** Keel to deck (m): deeper immersion than this is a fully submerged section. */
  deck: 0.85,
  foreStations: 4,
  aftStations: 3,
  /** The body pitch (deg) at which the forebody keel is level: the trim angle is pitch minus this. */
  keelIncidence: 0,
  // The hump (peak displacement drag) and the stable planing trim band (deg); porpoising outside it.
  hump: Object.freeze({
    speed: 12.5,
    waveDrag: 0.15,
    waveDragSpeed: 14,
    trimLow: 3.5,
    trimHigh: 9.5,
    humpTrim: 7,
    band: 2,
    porpoiseFrequency: 1.4,
    porpoiseGrowth: 1.4,
    porpoiseDecay: 2.2,
    porpoiseMoment: 0.035,
    porpoiseHeave: 0.12,
  }),
  /**
   * Planing (added-mass) lift, developing between two beam Froude numbers (speed / sqrt(g x beam))
   * from a share of it at displacement speeds (the bow wave on the rocker); cross-flow drag and
   * radiation damping (m/s) on the bottom.
   */
  planing: 1.1,
  planingOnset: Object.freeze([3.2, 6.4, 0.3]),
  crossflow: 1.1,
  heaveDamping: 0.9,
  /** Skin friction coefficient (with spray and rivets), side cross-flow drag and keel lift. */
  friction: 0.0045,
  sideDrag: 1.0,
  keelLift: 1.6,
  waterRudder: Object.freeze({ z: 4.0, depth: 0.45, area: 0.075, maxDeflection: 30, liftSlope: 3.2 }),
  /** The amphibian wheels (centres): drag in the water, the nose-over above limits.noseOverSpeed. */
  wheelDrag: 1.1,
  wheels: Object.freeze([
    Object.freeze({ id: 'leftNoseWheel', position: Object.freeze([-1.45, -2.32, -2.5]), radius: 0.2, area: 0.05 }),
    Object.freeze({ id: 'rightNoseWheel', position: Object.freeze([1.45, -2.32, -2.5]), radius: 0.2, area: 0.05 }),
    Object.freeze({ id: 'leftMainWheel', position: Object.freeze([-1.45, -2.27, 0]), radius: 0.26, area: 0.08 }),
    Object.freeze({ id: 'rightMainWheel', position: Object.freeze([1.45, -2.27, 0]), radius: 0.26, area: 0.08 }),
  ]),
});

const simProfile = Object.freeze({
  model: 'fixedWing',
  extension: createFloatsExtension,
  targets: Object.freeze({
    stallSpeedFullFlaps: 23, // m/s = 83 km/h, power off
    stallSpeedClean: 28.3, // m/s = 102 km/h, power off (follows from the wing, not a spec target)
    cruiseSpeed: 54, // m/s = 194 km/h at 70 % power
    climbRate: 5.3, // m/s at full power, best climb speed (about 1050 fpm)
    vne: 72, // m/s = 259 km/h
    humpSpeed: 12.5, // m/s = 45 km/h: peak water resistance, then planing on the step
  }),
  mass: Object.freeze({ empty: 1500, pilot: 90, fuel: 260 }), // 1850 kg with the amphibian floats, 80 kg/m^2
  // kg m^2 about body x (pitch), y (yaw) and z (roll); the floats add a lot of pitch and yaw inertia.
  inertia: Object.freeze({ pitch: 8400, yaw: 11800, roll: 6700, yawRoll: 120 }),
  centerOfMass: Object.freeze([0, -0.1, -0.75]),
  wing: Object.freeze({
    span: 14.6,
    area: 23.2, // constant 1.59 m chord, rounded tips
    taper: 1,
    oswald: 0.78,
    incidence: 2,
    // 1 degree of geometric dihedral plus the high wing's keel effect.
    dihedral: 3,
    washout: 1,
    aerodynamicCenter: Object.freeze([0, 1.05, -0.85]),
    cm0: -0.07,
  }),
  aero: Object.freeze({
    cd0: 0.072, // the floats, struts, spreader bars and the radial's cowling
    clAlpha: 5, // per rad (AR 9.2)
    clMax: 1.62,
    clMin: -1,
    alphaCritical: 15,
    postStallClDrop: 0.45,
    stallDropWidth: 4,
    stallBlendWidth: 16,
  }),
  // The floats add a lot of side area ahead of the centre of mass; the big fin and the finlet hold it.
  fuselage: Object.freeze({ sideArea: 8.5, sideForceSlope: 0.35, sideForceZ: -1.4, crossflowStations: Object.freeze([-2.6, 3.8]) }),
  tail: Object.freeze({
    horizontal: Object.freeze({ position: Object.freeze([0, 0.5, 5.0]), area: 3.6, aspectRatio: 3.8, incidence: 1, downwash: 1, wake: 0.75 }),
    vertical: Object.freeze({ position: Object.freeze([0, 1.3, 5.25]), area: 2.5, aspectRatio: 1.4, offset: -1, shadow: 0.55 }),
  }),
  controls: Object.freeze({
    aileron: 18,
    elevator: 24,
    rudder: 25,
    effectiveness: Object.freeze({ aileron: 0.45, elevator: 0.85, rudder: 0.6 }),
    trimRange: 0.45,
    servoRate: 4.5,
  }),
  // Three notches past up (13, 27 and 40 degrees) of big slotted flaps.
  flaps: Object.freeze({ notches: Object.freeze([0, 1 / 3, 2 / 3, 1]), maxDeflection: 40, clMaxIncrement: 0.95, clIncrement: 0.8, cdIncrement: 0.07, pitchMoment: -0.12, deploySeconds: 4 }),
  spoilers: null,
  // The amphibian wheels retract hydraulically into the floats.
  gear: Object.freeze({ retractable: true, transitSeconds: 8, cdIncrement: 0.004 }),
  engine: Object.freeze({
    kind: 'piston',
    powerKw: 336, // a 450 hp nine-cylinder radial at 2300 rpm
    idlePower: 0.04,
    idleRpm: 600,
    maxRpm: 2300,
    propDiameter: 2.59,
    propEfficiency: 0.8,
    designSpeed: 55,
    staticThrustN: 7400,
    staticFade: 12,
    spoolSeconds: 1.3,
    position: Object.freeze([0, 0.12, -3.55]),
    rotation: 'clockwise-from-cockpit',
    propInertia: 7,
    pFactorArm: 0.3,
    swirl: 0.12,
    slipstreamTail: 0.65,
    slipstreamWing: 0.25,
    windmillDrag: 0.08,
  }),
  floats: FLOATS,
  // The float keels skid on land with the wheels up; the wheels retract (gear toggle); the body points
  // strike the ground or the water (propeller, nose, wingtips, tail).
  contacts: Object.freeze([
    Object.freeze({ id: 'leftStepKeel', kind: 'skid', gear: true, position: Object.freeze([-1.45, -2.18, -0.42]), spring: 60000, damping: 5000, friction: 0.42 }),
    Object.freeze({ id: 'rightStepKeel', kind: 'skid', gear: true, position: Object.freeze([1.45, -2.18, -0.42]), spring: 60000, damping: 5000, friction: 0.42 }),
    Object.freeze({ id: 'leftBowKeel', kind: 'skid', gear: true, position: Object.freeze([-1.45, -1.8, -3.3]), spring: 40000, damping: 3500, friction: 0.42 }),
    Object.freeze({ id: 'rightBowKeel', kind: 'skid', gear: true, position: Object.freeze([1.45, -1.8, -3.3]), spring: 40000, damping: 3500, friction: 0.42 }),
    Object.freeze({ id: 'leftSternKeel', kind: 'skid', gear: true, position: Object.freeze([-1.45, -1.55, 3.9]), spring: 40000, damping: 3500, friction: 0.42 }),
    Object.freeze({ id: 'rightSternKeel', kind: 'skid', gear: true, position: Object.freeze([1.45, -1.55, 3.9]), spring: 40000, damping: 3500, friction: 0.42 }),
    Object.freeze({ id: 'leftNoseWheel', kind: 'wheel', gear: true, retracts: true, steerable: true, position: Object.freeze([-1.45, -2.52, -2.5]), spring: 52000, damping: 4400, rollingFriction: 0.05, sideFriction: 0.8 }),
    Object.freeze({ id: 'rightNoseWheel', kind: 'wheel', gear: true, retracts: true, steerable: true, position: Object.freeze([1.45, -2.52, -2.5]), spring: 52000, damping: 4400, rollingFriction: 0.05, sideFriction: 0.8 }),
    Object.freeze({ id: 'leftMainWheel', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([-1.45, -2.53, 0]), spring: 90000, damping: 7600, rollingFriction: 0.05, sideFriction: 0.85 }),
    Object.freeze({ id: 'rightMainWheel', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([1.45, -2.53, 0]), spring: 90000, damping: 7600, rollingFriction: 0.05, sideFriction: 0.85 }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-7.3, 1.12, -0.5]) }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([7.3, 1.12, -0.5]) }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, 0.12, -3.85]) }),
    Object.freeze({ id: 'propTip', kind: 'body', gear: false, position: Object.freeze([0, -1.17, -3.6]) }),
    Object.freeze({ id: 'tail', kind: 'body', gear: false, position: Object.freeze([0, 0.42, 5.95]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 2.55, 5.55]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -0.62, -1]) }),
  ]),
});

/** Power-off stall speed (m/s) at sea level, clean: the situate hook's approach speed is 1.3 x this. */
const STALL_SPEED_CLEAN = Math.sqrt((2 * (simProfile.mass.empty + simProfile.mass.pilot + simProfile.mass.fuel) * 9.81) / (1.225 * simProfile.wing.area * simProfile.aero.clMax));

// ============================================================================================
// MESH (local frame: nose -z, up +y; the origin on the fuselage axis under the wing's leading edge)
// ============================================================================================
// Airfoils as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
const WING_PROFILE = [[0, 0], [0.07, 0.5], [0.3, 0.6], [0.72, 0.3], [1, 0], [0.72, -0.1], [0.3, -0.28], [0.07, -0.22]];
const WING_PROFILE_CUT = [[0, 0], [0.07, 0.5], [0.3, 0.6], [0.72, 0.3], [0.72, 0.1], [0.72, -0.1], [0.3, -0.28], [0.07, -0.22]];
const SURFACE_PROFILE = [[0.735, 0.29], [1, 0], [0.735, -0.1]];
const SURFACE_HINGE = [0.735, 0.095];
const TAIL_PROFILE_CUT = [[0, 0], [0.07, 0.45], [0.3, 0.5], [0.7, 0.3], [0.7, 0], [0.7, -0.3], [0.3, -0.5], [0.07, -0.45]];
const TAIL_SURFACE_PROFILE = [[0.715, 0.29], [1, 0], [0.715, -0.29]];
const TAIL_HINGE_FRACTION = 0.715;

// Wing: constant 1.59 m chord from the root to the rounded tip, 1 degree dihedral.
const WING = Object.freeze({ CHORD: 1.59, LEADING_EDGE: -1.25, ROOT_Y: 1.05, THICKNESS: 0.13, TIP_X: 7.3, ROUND_FROM: 6.9, DIHEDRAL: Math.tan(1 * DEG) });
const FLAP_SPAN = Object.freeze([0.66, 3.8]);
const AILERON_SPAN = Object.freeze([3.86, 6.86]);
function wingChordAt(x) {
  if (x <= WING.ROUND_FROM) return WING.CHORD;
  return WING.CHORD - 0.55 * ((x - WING.ROUND_FROM) / (WING.TIP_X - WING.ROUND_FROM)) ** 1.6;
}
function wingLeadingEdgeAt(x) {
  if (x <= WING.ROUND_FROM) return WING.LEADING_EDGE;
  return WING.LEADING_EDGE + 0.2 * ((x - WING.ROUND_FROM) / (WING.TIP_X - WING.ROUND_FROM)) ** 1.6;
}
const wingHeightAt = (x) => WING.ROOT_Y + x * WING.DIHEDRAL;
function wingSection(x, profile) {
  return profileSection(profile, [x, wingHeightAt(x), wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS);
}
function wingHingePoint(x) {
  const chord = wingChordAt(x);
  return [x, wingHeightAt(x) + SURFACE_HINGE[1] * WING.THICKNESS * chord, wingLeadingEdgeAt(x) + SURFACE_HINGE[0] * chord];
}

function buildWingHalf(builder, side) {
  const mirror = (section) => section.map((point) => mirrorPoint(point, side));
  const tint = (edge) => (edge >= 4 ? PALETTE.creamShade : PALETTE.cream);
  builder.loft([0, FLAP_SPAN[0]].map((x) => mirror(wingSection(x, WING_PROFILE))), (segment, edge) => tint(edge));
  const bay = [FLAP_SPAN[0], FLAP_SPAN[1], AILERON_SPAN[0], AILERON_SPAN[1]].map((x) => mirror(wingSection(x, WING_PROFILE_CUT)));
  builder.loft(bay, (segment, edge) => tint(edge));
  const tip = [AILERON_SPAN[1], 7.02, 7.17, WING.TIP_X].map((x) => mirror(wingSection(x, WING_PROFILE)));
  // Orange wingtips (the bush-plane high-visibility scheme).
  builder.loft(tip, (segment, edge) => (segment >= 1 ? PALETTE.orange : tint(edge)), { capEnd: PALETTE.orange });
}

/** A trailing-edge surface between two span stations, hinged on its leading edge. */
function buildWingSurface(start, end, side, stripe) {
  const builder = createMeshBuilder();
  const stations = [start, (start + end) / 2, end];
  const sections = stations.map((x) => profileSection(SURFACE_PROFILE, [x, wingHeightAt(x), wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS)
    .map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment) => (stripe && segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hingeStart = mirrorPoint(wingHingePoint(start), side);
  const hingeEnd = mirrorPoint(wingHingePoint(end), side);
  const axis = new THREE.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
  return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
}

// Fuselage stations: [z, centre y, half width, half height]. The first three are the round radial
// cowling (front ring, its widest point, the firewall), then the boxy cabin and the tail cone.
const FUSELAGE = [
  [-3.45, 0.12, 0.56, 0.56],
  [-3.22, 0.12, 0.63, 0.63],
  [-2.62, 0.12, 0.6, 0.62],
  [-2.1, 0.16, 0.6, 0.68],
  [-1.3, 0.2, 0.62, 0.78],
  [0.3, 0.2, 0.6, 0.78],
  [1.5, 0.23, 0.48, 0.6],
  [3.0, 0.3, 0.32, 0.42],
  [4.6, 0.38, 0.17, 0.25],
  [5.95, 0.42, 0.06, 0.1],
];
const FUSELAGE_SIDES = 8;
// Faces of the octagon loft (edge e runs from corner e to e + 1, corners at 22.5 + 45 e degrees).
const FACE = Object.freeze({ UPPER_RIGHT: 0, ROOF: 1, UPPER_LEFT: 2, LEFT: 3, LOWER_LEFT: 4, BELLY: 5, LOWER_RIGHT: 6, RIGHT: 7 });
/** Glass panels: [segment, face]. The windshield (segment 3) and the cabin's side windows (segment 4). */
const WINDOWS = Object.freeze([
  [3, FACE.UPPER_RIGHT], [3, FACE.ROOF], [3, FACE.UPPER_LEFT],
  [4, FACE.UPPER_RIGHT], [4, FACE.UPPER_LEFT],
]);

function fuselageSections() {
  return FUSELAGE.map(([z, centreY, halfWidth, halfHeight], index) => {
    // The cowling is round (16 sides would cost too much: an octagon turned 22.5 degrees reads round).
    const ring = [];
    for (let corner = 0; corner < FUSELAGE_SIDES; corner++) {
      const angle = (22.5 + corner * 45) * DEG;
      const squareness = index < 3 ? 1 : 1.08;
      ring.push([halfWidth * clamp(Math.cos(angle) * squareness, -1, 1), centreY + halfHeight * clamp(Math.sin(angle) * squareness, -1, 1), z]);
    }
    return ring;
  });
}

function buildFuselage(builder, sections) {
  builder.loft(sections, (segment, face) => {
    if (segment <= 1) return PALETTE.charcoal; // the cowling
    if (face === FACE.BELLY || face === FACE.LOWER_LEFT || face === FACE.LOWER_RIGHT) return PALETTE.creamShade;
    // A long orange band down each side, from the firewall to the tail.
    if ((face === FACE.LEFT || face === FACE.RIGHT) && segment >= 2 && segment <= 7) return PALETTE.orange;
    return PALETTE.cream;
  }, { capEnd: PALETTE.orange });
}

/** The radial behind the cowl's front ring: a dark baffle with nine cylinder heads and a crankcase hub. */
function buildRadialFace(builder) {
  const faceZ = FUSELAGE[0][0] + 0.06;
  const centreY = FUSELAGE[0][1];
  const baffle = ellipseRing(faceZ, centreY, 0.53, 0.53, 9, 90);
  const centre = [0, centreY, faceZ];
  for (let index = 0; index < baffle.length; index++) builder.triangle(centre, baffle[index], baffle[(index + 1) % baffle.length], PALETTE.charcoal, [0, centreY, faceZ + 1]);
  for (let cylinder = 0; cylinder < 9; cylinder++) {
    const angle = (90 + cylinder * 40) * DEG;
    const radial = [Math.cos(angle), Math.sin(angle)];
    const across = [-radial[1], radial[0]];
    const inner = 0.2;
    const outer = 0.47;
    const half = 0.07;
    const corner = (along, side, depth) => [radial[0] * along + across[0] * side, centreY + radial[1] * along + across[1] * side, faceZ - depth];
    const front = [corner(inner, -half, 0.05), corner(outer, -half, 0.05), corner(outer, half, 0.05), corner(inner, half, 0.05)];
    const back = [corner(inner, -half, 0), corner(outer, -half, 0), corner(outer, half, 0), corner(inner, half, 0)];
    builder.loft([back, front], () => PALETTE.creamShade, { capEnd: PALETTE.cream });
  }
  const hub = ellipseRing(faceZ - 0.08, centreY, 0.16, 0.16, 8);
  const hubBack = ellipseRing(faceZ, centreY, 0.18, 0.18, 8);
  builder.loft([hubBack, hub], () => PALETTE.charcoal, { capEnd: PALETTE.charcoal });
}

/** Window panes: each glass face inset from its frame and lifted just off the skin. */
function buildWindows(sections) {
  const builder = createMeshBuilder();
  const inset = 0.12;
  const lift = 0.012;
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const [segment, face] of WINDOWS) {
    const next = (face + 1) % FUSELAGE_SIDES;
    const corners = [sections[segment][face], sections[segment][next], sections[segment + 1][next], sections[segment + 1][face]];
    const centre = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / 4);
    edgeA.set(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]);
    edgeB.set(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1], corners[3][2] - corners[0][2]);
    normal.crossVectors(edgeA, edgeB).normalize();
    const axisCentre = [0, FUSELAGE[segment][1], centre[2]];
    if ((centre[0] - axisCentre[0]) * normal.x + (centre[1] - axisCentre[1]) * normal.y < 0) normal.negate();
    const pane = corners.map((corner) => [0, 1, 2].map((axis) => corner[axis] + (centre[axis] - corner[axis]) * inset + normal.getComponent(axis) * lift));
    const inside = [centre[0] - normal.x, centre[1] - normal.y, centre[2] - normal.z];
    builder.quad(pane[0], pane[1], pane[2], pane[3], PALETTE.charcoal, inside);
  }
  return builder.toGeometry(null);
}

// Tail: a tall fin with a dorsal fillet and a ventral finlet (floatplanes need the extra keel area),
// the stabilizer with its elevator, straight hinge lines.
const FIN = Object.freeze({ BASE_Y: 0.5, TOP_Y: 2.5, THICKNESS: 0.1, HINGE_Z: 5.62 });
const finLeadingEdge = (y) => 4.55 + (0.72 * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y);
const finChord = (y) => (FIN.HINGE_Z - finLeadingEdge(y)) / TAIL_HINGE_FRACTION;
const STAB = Object.freeze({ Y: 0.5, HINGE_Z: 5.42, HALF_SPAN: 2.3, THICKNESS: 0.1 });
const stabChord = (x) => 1.1 - (0.34 * Math.abs(x) ** 2) / STAB.HALF_SPAN ** 2;
const stabLeadingEdge = (x) => STAB.HINGE_Z - TAIL_HINGE_FRACTION * stabChord(x);

function buildTail(builder) {
  const finSections = [FIN.BASE_Y, 1.6, 2.2, FIN.TOP_Y].map((y) => profileSection(TAIL_PROFILE_CUT, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(finSections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  // Dorsal fillet from the fuselage spine up the fin's leading edge.
  const fillet = [[0, 0.62, 3.1], [0, 0.66, 4.6], [0, 0.98, 4.65]];
  builder.triangle(fillet[0], fillet[1], fillet[2], PALETTE.cream, [0.5, 0.7, 4.3]);
  builder.triangle(fillet[0], fillet[2], fillet[1], PALETTE.cream, [-0.5, 0.7, 4.3]);
  // Ventral finlet under the tail cone.
  const finlet = [[0, 0.3, 4.9], [0, 0.32, 5.8], [0, -0.22, 5.75], [0, -0.18, 5.3]];
  builder.quad(finlet[0], finlet[1], finlet[2], finlet[3], PALETTE.charcoal, [0.5, 0.1, 5.4]);
  builder.quad(finlet[0], finlet[3], finlet[2], finlet[1], PALETTE.charcoal, [-0.5, 0.1, 5.4]);
  const stabSections = [-STAB.HALF_SPAN, -1.5, 0, 1.5, STAB.HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(stabSections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
}
function buildRudder() {
  const builder = createMeshBuilder();
  const heights = [STAB.Y + 0.07, 1.6, 2.2, FIN.TOP_Y];
  const sections = heights.map((y) => profileSection(TAIL_SURFACE_PROFILE, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(sections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  const start = [0, heights[0], FIN.HINGE_Z];
  const end = [0, heights[heights.length - 1], FIN.HINGE_Z];
  return { geometry: builder.toGeometry(start), pivot: start, axis: new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize() };
}
function buildElevator() {
  const builder = createMeshBuilder();
  const stations = [-2.28, -1.5, -0.08, 0.08, 1.5, 2.28];
  const sections = stations.map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(sections, (segment) => (segment === 0 || segment === 4 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  const pivot = [0, STAB.Y, STAB.HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

/** A straight faceted bar (strut, gear leg) from a to b with a lozenge section. */
function buildBar(builder, from, to, halfWidth, halfDepth, tint, widthAxis = [1, 0, 0]) {
  const direction = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const width = new THREE.Vector3(widthAxis[0], widthAxis[1], widthAxis[2]);
  width.addScaledVector(direction, -width.dot(direction)).normalize();
  const depth = new THREE.Vector3().crossVectors(direction, width).normalize();
  const ring = (point) => [[halfWidth, 0], [0, halfDepth], [-halfWidth, 0], [0, -halfDepth]].map(([along, across]) => [
    point[0] + width.x * along + depth.x * across,
    point[1] + width.y * along + depth.y * across,
    point[2] + width.z * along + depth.z * across,
  ]);
  builder.loft([ring(from), ring(to)], () => tint, { capStart: tint, capEnd: tint });
}

/** A tire (axle along x): bulging tread in charcoal, a cream hub cap each side. */
function buildWheel(builder, centre, radius, width, sides = 12) {
  const profile = [[-0.5, 0.62], [-0.42, 0.9], [-0.2, 1], [0.2, 1], [0.42, 0.9], [0.5, 0.62]];
  const sections = profile.map(([across, scale]) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      ring.push([centre[0] + across * width, centre[1] + Math.cos(angle) * radius * scale, centre[2] + Math.sin(angle) * radius * scale]);
    }
    return ring;
  });
  builder.loft(sections, () => PALETTE.charcoal, { capStart: PALETTE.creamShade, capEnd: PALETTE.creamShade });
}

// ---- Floats ----------------------------------------------------------------------------------
/** Float hull stations along z: the keel follows the physics' keel line (floats.js), the deck its sheer. */
const FLOAT_STATIONS = Object.freeze([-4.05, -3.75, -3.15, -2.2, -1.2, -0.42, -0.38, 0.9, 2.3, 3.4, 4.05]);
const FLOAT_DECK_Y = FLOATS.keel.stepY + FLOATS.deck;
function floatBeamScale(z) {
  const keel = FLOATS.keel;
  if (z <= keel.stepZ) {
    const toBow = clamp((keel.stepZ - z) / (keel.stepZ - keel.bowZ), 0, 1);
    return Math.max(0.12, 0.45 + 0.55 * Math.sqrt(Math.max(0, 1 - toBow * toBow)) - (toBow > 0.97 ? 0.3 : 0));
  }
  return 1 - 0.55 * clamp((z - keel.stepZ) / (keel.sternZ - keel.stepZ), 0, 1);
}
function floatDeckY(z) {
  const keel = FLOATS.keel;
  const toEnd = z <= keel.stepZ ? (keel.stepZ - z) / (keel.stepZ - keel.bowZ) : (z - keel.stepZ) / (keel.sternZ - keel.stepZ);
  return FLOAT_DECK_Y - (z <= keel.stepZ ? 0.12 : 0.18) * clamp(toEnd, 0, 1) ** 2;
}
/** One float cross-section at z (six corners: keel, chines, deck edges, crowned deck). */
function floatSection(z, hullX) {
  const keelY = floatKeelHeight(FLOATS, z);
  const deckY = Math.max(floatDeckY(z), keelY + 0.08);
  const half = (FLOATS.beam / 2) * floatBeamScale(z);
  const chineY = Math.min(keelY + half * Math.tan(FLOATS.deadrise * DEG), deckY - 0.02);
  return [
    [hullX, keelY, z],
    [hullX + half, chineY, z],
    [hullX + half * 0.92, deckY, z],
    [hullX, deckY + 0.04, z],
    [hullX - half * 0.92, deckY, z],
    [hullX - half, chineY, z],
  ];
}
function buildFloats(builder) {
  for (const hullX of FLOATS.hulls) {
    const sections = FLOAT_STATIONS.map((z) => floatSection(z, hullX));
    builder.loft(sections, (segment, edge) => {
      // Edges: 0 right bottom, 1 right side, 2 right deck, 3 left deck, 4 left side, 5 left bottom.
      if (edge === 0 || edge === 5) return PALETTE.creamShade;
      if ((edge === 2 || edge === 3) && segment <= 1) return PALETTE.orange; // the bow caps
      if ((edge === 1 || edge === 4) && segment >= 3 && segment <= 7) return PALETTE.orange; // the side stripe
      return PALETTE.cream;
    }, { capStart: PALETTE.orange, capEnd: PALETTE.cream });
  }
}
/** N-struts from each float deck up to the fuselage, and spreader bars between the floats. */
function buildFloatStruts(builder) {
  for (const hullX of FLOATS.hulls) {
    const side = Math.sign(hullX);
    const front = [hullX, floatDeckY(-1.95), -1.95];
    const rear = [hullX, floatDeckY(0.15), 0.15];
    buildBar(builder, front, [0.42 * side, -0.48, -1.75], 0.05, 0.02, PALETTE.charcoal, [0, 0, 1]);
    buildBar(builder, rear, [0.42 * side, -0.46, 0.25], 0.05, 0.02, PALETTE.charcoal, [0, 0, 1]);
    buildBar(builder, front, [0.42 * side, -0.46, 0.25], 0.035, 0.02, PALETTE.charcoal, [0, 0, 1]);
  }
  for (const z of [-1.95, 0.15]) {
    buildBar(builder, [FLOATS.hulls[0], floatDeckY(z) + 0.02, z], [FLOATS.hulls[1], floatDeckY(z) + 0.02, z], 0.035, 0.035, PALETTE.charcoal, [0, 0, 1]);
  }
  // A cross-wire X between the spreader bars and the fuselage.
  buildBar(builder, [FLOATS.hulls[0], floatDeckY(-1.95), -1.95], [0.4, -0.48, 0.2], 0.012, 0.012, PALETTE.charcoal);
  buildBar(builder, [FLOATS.hulls[1], floatDeckY(-1.95), -1.95], [-0.4, -0.48, 0.2], 0.012, 0.012, PALETTE.charcoal);
}

// Lift struts: one on each side from the lower fuselage to the wing, with a jury strut.
function buildStruts(builder) {
  for (const side of [1, -1]) {
    buildBar(builder, [0.5 * side, -0.4, -0.8], [3.7 * side, wingHeightAt(3.7) - 0.06, -0.72], 0.07, 0.022, PALETTE.charcoal, [0, 0, 1]);
    buildBar(builder, [2.1 * side, 0.36, -0.75], [2.1 * side, wingHeightAt(2.1) - 0.06, -0.75], 0.02, 0.02, PALETTE.charcoal);
  }
}

// Propeller: faceted spinner + three twisted blades with orange tips (rotates about local z).
const PROP_PIVOT = [0, 0.12, -3.5];
const PROP_PLANE_Z = -0.1;
const PROP_RADIUS = 1.295;
const PROP_BLADES = 3;
function buildPropeller() {
  const builder = createMeshBuilder();
  const spinner = [[0.02, 0.26], [-0.12, 0.24], [-0.24, 0.17], [-0.32, 0.08], [-0.35, 0]].map(([z, radius]) => ellipseRing(z, 0, radius, radius, 8));
  builder.loft(spinner, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal });
  const bladeStations = [[0.16, 0.15, 40], [0.45, 0.2, 28], [0.8, 0.18, 20], [1.1, 0.13, 15], [PROP_RADIUS, 0.07, 13]];
  const bladeThickness = 0.028;
  for (let blade = 0; blade < PROP_BLADES; blade++) {
    const turn = (blade / PROP_BLADES) * Math.PI * 2;
    const cosTurn = Math.cos(turn);
    const sinTurn = Math.sin(turn);
    const rotate = (point) => [point[0] * cosTurn - point[1] * sinTurn, point[0] * sinTurn + point[1] * cosTurn, point[2]];
    const sections = bladeStations.map(([radius, width, pitchDegrees]) => {
      const pitch = pitchDegrees * DEG;
      const chord = [Math.cos(pitch), 0, -Math.sin(pitch)];
      const across = [Math.sin(pitch), 0, Math.cos(pitch)];
      const centre = [0, radius, PROP_PLANE_Z];
      return [
        [centre[0] + chord[0] * width * 0.5, centre[1], centre[2] + chord[2] * width * 0.5],
        [centre[0] + across[0] * bladeThickness, centre[1], centre[2] + across[2] * bladeThickness],
        [centre[0] - chord[0] * width * 0.5, centre[1], centre[2] - chord[2] * width * 0.5],
        [centre[0] - across[0] * bladeThickness, centre[1], centre[2] - across[2] * bladeThickness],
      ].map(rotate);
    });
    builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  return builder.toGeometry(null);
}

// Amphibian wheels: each on a leg that swings about a pivot inside the float. Nose wheels fold forward
// into the bows; mains swing up and aft onto the float decks (the gear position from craftState).
const NOSE_LEG = Object.freeze({ PIVOT_Y: -1.62, Z: -2.5, LENGTH: 0.7, RETRACTED: 110 * DEG, RADIUS: 0.2, WIDTH: 0.13 });
const MAIN_LEG = Object.freeze({ PIVOT_Y: -1.5, Z: 0, LENGTH: 0.77, RETRACTED: -140 * DEG, RADIUS: 0.26, WIDTH: 0.17 });
function buildLeg(spec) {
  const builder = createMeshBuilder();
  buildBar(builder, [0, 0, 0], [0, -spec.LENGTH + spec.RADIUS * 0.4, 0], 0.045, 0.045, PALETTE.charcoal, [0, 0, 1]);
  buildBar(builder, [-spec.WIDTH * 0.7, -spec.LENGTH, 0], [spec.WIDTH * 0.7, -spec.LENGTH, 0], 0.03, 0.03, PALETTE.charcoal);
  return builder.toGeometry(null);
}
function buildWheelGeometry(spec) {
  const builder = createMeshBuilder();
  buildWheel(builder, [0, 0, 0], spec.RADIUS, spec.WIDTH);
  return builder.toGeometry(null);
}

// Water rudders: a blade hanging from each float's stern on a hinge that swings it up out of the water.
const WATER_RUDDER = Object.freeze({ Z: FLOATS.waterRudder.z, DEPTH: FLOATS.waterRudder.depth, CHORD: 0.17, UP_ANGLE: -95 * DEG });
function buildWaterRudderBlade() {
  const builder = createMeshBuilder();
  const half = 0.012;
  const top = 0;
  const bottom = -WATER_RUDDER.DEPTH;
  const front = -0.02;
  const back = WATER_RUDDER.CHORD;
  const left = [[-half, top, front], [-half, top, back], [-half, bottom, back - 0.03], [-half, bottom, front + 0.03]];
  const right = left.map((point) => [half, point[1], point[2]]);
  builder.loft([left, right], () => PALETTE.charcoal, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

const TIP_Y = wingHeightAt(WING.TIP_X);
/** The mesh's named anchors (body axes): the spray roots, bow waves and prop wash the ability sprays from. */
const ANCHOR_POINTS = Object.freeze({
  sprayLeft: Object.freeze([FLOATS.hulls[0] - FLOATS.beam * 0.5, FLOATS.keel.stepY + 0.18, -1.1]),
  sprayRight: Object.freeze([FLOATS.hulls[1] + FLOATS.beam * 0.5, FLOATS.keel.stepY + 0.18, -1.1]),
  bowLeft: Object.freeze([FLOATS.hulls[0], FLOATS.keel.stepY + 0.42, -3.3]),
  bowRight: Object.freeze([FLOATS.hulls[1], FLOATS.keel.stepY + 0.42, -3.3]),
  propWash: Object.freeze([0, FLOATS.keel.stepY + 0.4, -2.6]),
  tail: Object.freeze([0, 0.42, 5.95]),
});
const EYE = Object.freeze([0, 0.62, -1.15]);
const FLAP_MAX_DEFLECTION = simProfile.flaps.maxDeflection;
const SURFACE_LIMITS = Object.freeze({ aileron: simProfile.controls.aileron, elevator: simProfile.controls.elevator, rudder: simProfile.controls.rudder });
const WATER_RUDDER_DEFLECTION = FLOATS.waterRudder.maxDeflection * DEG;

/**
 * Builds the seaplane. update(visual, dt) animates the ailerons / elevator / rudder (visual.aileron,
 * elevator, rudder in -1..1), the flaps (visual.flaps 0..1), the prop (visual.propSpeed in rad/s, or a
 * throttle-driven spin that winds down with the engine off), the wheels (craftState.gearPosition;
 * rolling on the ground with visual.groundSpeed), the water rudders (craftState.waterRudders, turning
 * with the rudder) and the nav lights from visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'seaplane';

  const sections = fuselageSections();
  const airframe = createMeshBuilder();
  buildFuselage(airframe, sections);
  buildRadialFace(airframe);
  buildWingHalf(airframe, 1);
  buildWingHalf(airframe, -1);
  buildTail(airframe);
  buildStruts(airframe);
  buildFloats(airframe);
  buildFloatStruts(airframe);
  // Exhaust stack on the right of the cowling.
  buildBar(airframe, [0.55, -0.32, -2.75], [0.62, -0.5, -2.2], 0.05, 0.05, PALETTE.charcoal);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  const windows = addSolid(root, buildWindows(sections), materials.canopy);
  windows.userData.hideInCockpit = true;

  const aileronRight = addPivot(root, buildWingSurface(AILERON_SPAN[0], AILERON_SPAN[1], 1, true), bodyMaterial);
  const aileronLeft = addPivot(root, buildWingSurface(AILERON_SPAN[0], AILERON_SPAN[1], -1, true), bodyMaterial);
  const flapRight = addPivot(root, buildWingSurface(FLAP_SPAN[0], FLAP_SPAN[1], 1, false), bodyMaterial);
  const flapLeft = addPivot(root, buildWingSurface(FLAP_SPAN[0], FLAP_SPAN[1], -1, false), bodyMaterial);
  const elevator = addPivot(root, buildElevator(), bodyMaterial);
  const rudder = addPivot(root, buildRudder(), bodyMaterial);

  // Gear legs (pivot groups) carrying their wheels (rolling groups).
  const noseLegGeometry = buildLeg(NOSE_LEG);
  const mainLegGeometry = buildLeg(MAIN_LEG);
  const noseWheelGeometry = buildWheelGeometry(NOSE_LEG);
  const mainWheelGeometry = buildWheelGeometry(MAIN_LEG);
  const legs = [];
  for (const hullX of FLOATS.hulls) {
    for (const spec of [NOSE_LEG, MAIN_LEG]) {
      const leg = new THREE.Group();
      leg.position.set(hullX, spec.PIVOT_Y, spec.Z);
      addSolid(leg, spec === NOSE_LEG ? noseLegGeometry : mainLegGeometry, bodyMaterial);
      const wheel = new THREE.Group();
      wheel.position.set(0, -spec.LENGTH, 0);
      addSolid(wheel, spec === NOSE_LEG ? noseWheelGeometry : mainWheelGeometry, bodyMaterial);
      leg.add(wheel);
      root.add(leg);
      legs.push({ leg, wheel, spec });
    }
  }

  // Water rudders: a hinge group (swings up and down) holding a steering group (turns with the pedals).
  const bladeGeometry = buildWaterRudderBlade();
  const waterRudders = FLOATS.hulls.map((hullX) => {
    const hinge = new THREE.Group();
    hinge.position.set(hullX, floatKeelHeight(FLOATS, WATER_RUDDER.Z), WATER_RUDDER.Z);
    const steer = new THREE.Group();
    addSolid(steer, bladeGeometry, bodyMaterial);
    hinge.add(steer);
    root.add(hinge);
    return { hinge, steer };
  });

  const propeller = new THREE.Group();
  propeller.position.set(PROP_PIVOT[0], PROP_PIVOT[1], PROP_PIVOT[2]);
  addSolid(propeller, buildPropeller(), bodyMaterial);
  const propDisc = createPropDisc(PROP_RADIUS);
  propDisc.mesh.position.z = PROP_PLANE_Z - 0.03;
  propeller.add(propDisc.mesh);
  root.add(propeller);

  const tipLeadingEdge = wingLeadingEdgeAt(WING.TIP_X);
  const navLights = createNavLights(root, {
    red: { position: [-WING.TIP_X - 0.02, TIP_Y + 0.01, tipLeadingEdge + 0.25], glow: [-WING.TIP_X - 0.1, TIP_Y + 0.02, tipLeadingEdge + 0.2] },
    green: { position: [WING.TIP_X + 0.02, TIP_Y + 0.01, tipLeadingEdge + 0.25], glow: [WING.TIP_X + 0.1, TIP_Y + 0.02, tipLeadingEdge + 0.2] },
    strobe: { position: [0, FIN.TOP_Y + 0.06, 5.3], glow: [0, FIN.TOP_Y + 0.14, 5.3] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let propAngle = 0;
  let propSpeed = 0;
  let wheelAngle = 0;
  let rudderDeploy = 0;

  return {
    root,
    wingtips: [new THREE.Vector3(-WING.TIP_X - 0.05, TIP_Y + 0.05, -0.45), new THREE.Vector3(WING.TIP_X + 0.05, TIP_Y + 0.05, -0.45)],
    eyeAnchor,
    /**
     * Local attachment points: the chine spray roots just ahead of the steps, the bow waves, the prop
     * wash on the water under the propeller, and the tail.
     */
    anchors: Object.fromEntries(Object.entries(ANCHOR_POINTS).map(([name, point]) => [name, new THREE.Vector3(point[0], point[1], point[2])])),

    update(visual, dt) {
      const aileronAngle = -clamp(visual.aileron, -1, 1) * SURFACE_LIMITS.aileron * DEG;
      aileronRight.quaternion.setFromAxisAngle(aileronRight.userData.axis, aileronAngle);
      aileronLeft.quaternion.setFromAxisAngle(aileronLeft.userData.axis, aileronAngle);
      const flapAngle = clamp(Number.isFinite(visual.flaps) ? visual.flaps : 0, 0, 1) * FLAP_MAX_DEFLECTION * DEG;
      flapRight.quaternion.setFromAxisAngle(flapRight.userData.axis, flapAngle);
      flapLeft.quaternion.setFromAxisAngle(flapLeft.userData.axis, -flapAngle);
      elevator.quaternion.setFromAxisAngle(elevator.userData.axis, -clamp(visual.elevator, -1, 1) * SURFACE_LIMITS.elevator * DEG);
      const rudderInput = clamp(visual.rudder, -1, 1);
      rudder.quaternion.setFromAxisAngle(rudder.userData.axis, rudderInput * SURFACE_LIMITS.rudder * DEG);

      const throttle = Number.isFinite(visual.throttle) ? visual.throttle : 0;
      const targetSpeed = Number.isFinite(visual.propSpeed) ? visual.propSpeed : visual.engineOn === false ? 0 : 8 + 20 * throttle;
      propSpeed = dt > 0 ? damp(propSpeed, targetSpeed, visual.engineOn === false ? 1 : 5, dt) : propSpeed;
      propAngle = (propAngle + propSpeed * dt) % (Math.PI * 2);
      if (!Number.isFinite(propAngle)) propAngle = 0;
      propeller.rotation.z = propAngle;
      propDisc.setSpeed(propSpeed > 0.5 ? propSpeed : 0);

      const craftState = visual.craftState ?? null;
      const gear = craftState && Number.isFinite(craftState.gearPosition) ? clamp(craftState.gearPosition, 0, 1) : visual.gearDown === false ? 0 : 1;
      if (visual.onGround && gear > 0.98 && Number.isFinite(visual.groundSpeed) && dt > 0) wheelAngle = (wheelAngle - (visual.groundSpeed / MAIN_LEG.RADIUS) * dt) % (Math.PI * 2);
      for (const entry of legs) {
        entry.leg.rotation.x = (1 - gear) * entry.spec.RETRACTED;
        entry.wheel.rotation.x = (wheelAngle * MAIN_LEG.RADIUS) / entry.spec.RADIUS;
      }

      const deployed = craftState && craftState.waterRudders === true ? 1 : 0;
      rudderDeploy = dt > 0 ? damp(rudderDeploy, deployed, 2.5, dt) : rudderDeploy;
      for (const blade of waterRudders) {
        blade.hinge.rotation.x = (1 - rudderDeploy) * WATER_RUDDER.UP_ANGLE;
        // Right pedal: the blades' trailing edges swing right, as the air rudder's do.
        blade.steer.rotation.y = rudderInput * WATER_RUDDER_DEFLECTION * rudderDeploy;
      }

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: water rudders up / down. Its update runs every frame for the spray off the floats, the
// prop wash on the water, and the copilot's gear advisory (wheels down over water, wheels up over
// land) and the water-rudder reminder.
// ============================================================================================
/** Spray droplets per second at full spray from each chine (and from the prop wash at full power). */
const SPRAY_RATE = Object.freeze({ chine: 110, bow: 45, propWash: 60 });
/**
 * A gear advisory speaks once per approach: it re-arms when the craft climbs above REARM_AGL (m), the
 * gear is moved, or its warning has been clear for ADVISORY_REARM_SECONDS (s).
 */
const ADVISORY_REARM_SECONDS = 20;
const ADVISORY_REARM_AGL = 200;
const ADVISORY = Object.freeze({
  noseOver: 'Gear is down! Wheels in the water will flip us. Gear up for a water landing.',
  skid: 'Gear is up for a land landing. Wheels down for the runway, or the floats will skid.',
  waterRudders: 'Water rudders are still down. Up for the takeoff run.',
});

/** Per-flight memory of the update (keyed by the live craft state, so a new craft starts fresh). */
const abilityMemories = new WeakMap();
/** Spray descriptors per water effects layer (created once, mutated per emission). */
const sprayDescriptors = new WeakMap();
const anchorWorld = new THREE.Vector3();
const outwardWorld = new THREE.Vector3();

function abilityMemory(craftState) {
  let memory = abilityMemories.get(craftState);
  if (!memory) {
    memory = { chine: 0, bow: 0, propWash: 0, noseOverClear: ADVISORY_REARM_SECONDS, skidClear: ADVISORY_REARM_SECONDS, noseOverArmed: true, skidArmed: true, ruddersReminded: false, gearDown: null };
    abilityMemories.set(craftState, memory);
  }
  return memory;
}

function sprayFor(effects) {
  let descriptor = sprayDescriptors.get(effects);
  if (!descriptor) {
    descriptor = effects.createSpray({ count: 0, speed: 5, up: 0.7, spread: 0.55, size: 0.55, sizeGrowth: 0.9, life: 1.2, drag: 1.1, gravity: 1, alpha: 0.55 });
    sprayDescriptors.set(effects, descriptor);
  }
  return descriptor;
}

/** Emits `count` droplets at an anchor point (body axes), thrown outward (body x sign) and up. */
function emitSprayAt(api, effects, anchor, outward, count, speed) {
  if (count <= 0) return;
  const player = api.player;
  anchorWorld.set(anchor[0], anchor[1], anchor[2]).applyQuaternion(player.quaternion).add(player.position);
  outwardWorld.set(outward, 0, 0).applyQuaternion(player.quaternion);
  const spray = sprayFor(effects);
  const velocity = api.telemetry.velocity;
  spray.x = anchorWorld.x;
  spray.y = anchorWorld.y;
  spray.z = anchorWorld.z;
  spray.count = count;
  spray.speed = 2.5 + 0.35 * speed;
  spray.inheritX = velocity.x * 0.35 + outwardWorld.x * (1.5 + 0.25 * speed);
  spray.inheritY = 0;
  spray.inheritZ = velocity.z * 0.35 + outwardWorld.z * (1.5 + 0.25 * speed);
  effects.emitSpray(spray);
}

function updateSpray(api, dt, memory) {
  const effects = api.systems.water && api.systems.water.effects;
  const craftState = api.craftState;
  if (!effects || craftState.onWater !== true) return;
  const spray = Number.isFinite(craftState.spray) ? craftState.spray : 0;
  const speed = Math.abs(Number.isFinite(craftState.waterSpeed) ? craftState.waterSpeed : 0);
  const anchors = ANCHOR_POINTS;
  memory.chine += SPRAY_RATE.chine * spray * dt;
  memory.bow += SPRAY_RATE.bow * spray * (1 - clamp((speed - 8) / 10, 0, 1)) * dt;
  const throttle = Number.isFinite(api.telemetry.throttle) ? api.telemetry.throttle : 0;
  memory.propWash += SPRAY_RATE.propWash * Math.max(0, throttle - 0.5) * 2 * (1 - clamp(speed / 14, 0, 1)) * dt;
  const chine = Math.floor(memory.chine);
  const bow = Math.floor(memory.bow);
  const wash = Math.floor(memory.propWash);
  memory.chine -= chine;
  memory.bow -= bow;
  memory.propWash -= wash;
  emitSprayAt(api, effects, anchors.sprayLeft, -1, chine, speed);
  emitSprayAt(api, effects, anchors.sprayRight, 1, chine, speed);
  emitSprayAt(api, effects, anchors.bowLeft, -1, bow, speed * 0.6);
  emitSprayAt(api, effects, anchors.bowRight, 1, bow, speed * 0.6);
  emitSprayAt(api, effects, anchors.propWash, 0, wash, 6);
}

/** Speaks a gear advisory (WREN's voice and a warning toast) and counts it. */
function advise(api, text) {
  api.notify(text, 'warning');
  const copilot = api.systems.copilot;
  if (copilot && typeof copilot.speak === 'function') copilot.speak(text);
  api.setCraftState('gearAdvisories', (Number.isFinite(api.craftState.gearAdvisories) ? api.craftState.gearAdvisories : 0) + 1);
}

function updateAdvisories(api, dt, memory) {
  const craftState = api.craftState;
  const telemetry = api.telemetry;
  const gearDown = Boolean(telemetry.gear && telemetry.gear.down);
  if (memory.gearDown !== gearDown || (Number.isFinite(telemetry.agl) && telemetry.agl > ADVISORY_REARM_AGL)) {
    memory.gearDown = gearDown;
    memory.noseOverArmed = true;
    memory.skidArmed = true;
  }
  if (craftState.noseOverWarning === true) {
    memory.noseOverClear = 0;
    if (memory.noseOverArmed) {
      memory.noseOverArmed = false;
      advise(api, ADVISORY.noseOver);
    }
  } else {
    memory.noseOverClear += dt;
    if (memory.noseOverClear >= ADVISORY_REARM_SECONDS) memory.noseOverArmed = true;
  }
  if (craftState.skidWarning === true) {
    memory.skidClear = 0;
    if (memory.skidArmed) {
      memory.skidArmed = false;
      advise(api, ADVISORY.skid);
    }
  } else {
    memory.skidClear += dt;
    if (memory.skidClear >= ADVISORY_REARM_SECONDS) memory.skidArmed = true;
  }
  const speed = Math.abs(Number.isFinite(craftState.waterSpeed) ? craftState.waterSpeed : 0);
  if (craftState.waterRudders === true && craftState.onWater === true && speed > FLOATS.hump.speed * 0.7) {
    if (!memory.ruddersReminded) {
      memory.ruddersReminded = true;
      api.notify(ADVISORY.waterRudders, 'info');
    }
  } else if (speed < 4) {
    memory.ruddersReminded = false;
  }
}

/** Sets the water rudders (true = down) and answers with the line WREN or the toast says. */
function setWaterRudders(api, down) {
  api.setCraftState('waterRudders', down);
  return down ? 'Water rudders down: steer with the pedals.' : 'Water rudders up.';
}

const craftAbility = Object.freeze({
  label: 'Water rudders',
  initialState: () => ({
    waterRudders: false,
    onWater: false,
    onStep: false,
    porpoise: 0,
    noseOverWarning: false,
    skidWarning: false,
    spray: 0,
    trim: 0,
    waterSpeed: 0,
    gearPosition: 0,
    gearRequest: null,
    gearAdvisories: 0,
  }),
  run(api) {
    api.notify(setWaterRudders(api, api.craftState.waterRudders !== true));
    return true;
  },
  update(api, dt) {
    const memory = abilityMemory(api.craftState);
    updateSpray(api, dt, memory);
    updateAdvisories(api, dt, memory);
  },
});

// ============================================================================================
// COPILOT, PLACEMENT
// ============================================================================================
const DOWN_WORDS = /^(down|on|lower|drop|deploy)$/;
const UP_WORDS = /^(up|off|raise|retract)$/;
const WATER_WORDS = /^(water|lake|ocean|sea)$/;

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'waterRudders',
      phrases: Object.freeze(['\\bwater rudders? (up|down|on|off)\\b', '\\b(raise|lower|drop|retract|deploy) (?:the )?water rudders?\\b']),
      run(api, value) {
        const word = typeof value === 'string' ? value.toLowerCase() : value;
        const down = word === true || (typeof word === 'string' && DOWN_WORDS.test(word)) ? true : word === false || (typeof word === 'string' && UP_WORDS.test(word)) ? false : api.craftState.waterRudders !== true;
        return setWaterRudders(api, down);
      },
    }),
    Object.freeze({
      id: 'landingConfig',
      phrases: Object.freeze([
        '\\b(?:set up|configure|ready|gear) for (?:a )?(water|lake|ocean|sea|runway|land|ground|airfield) landing\\b',
        '\\b(water|lake|runway|land) landing (?:check|checks|checklist|config|configuration)\\b',
      ]),
      run(api, value) {
        const word = typeof value === 'string' ? value.toLowerCase() : 'water';
        if (WATER_WORDS.test(word)) {
          api.setCraftState('gearRequest', 'up');
          api.setCraftState('waterRudders', false);
          return 'Gear up, water rudders up: set for a water landing.';
        }
        api.setCraftState('gearRequest', 'down');
        return 'Gear down: set for the runway. Four wheels when they lock.';
      },
    }),
    Object.freeze({
      id: 'stepCheck',
      phrases: Object.freeze(['\\b(?:are we|am i) on the step\\b', '\\bstep (?:status|check)\\b', '\\bwater status\\b']),
      run(api) {
        return seaplaneStatus(api.craftState, api.telemetry);
      },
    }),
  ]),
  status: seaplaneStatus,
});

/** WREN's seaplane status line: the gear for the surface below, the water rudders, the step. */
function seaplaneStatus(craftState, telemetry) {
  const gearDown = telemetry && telemetry.gear ? telemetry.gear.down === true : false;
  const parts = [gearDown ? 'Gear down, set for a runway.' : 'Gear up, set for water.'];
  parts.push(craftState.waterRudders === true ? 'Water rudders down.' : 'Water rudders up.');
  if (craftState.onWater === true) {
    const kmh = Math.round(Math.abs(craftState.waterSpeed || 0) * 3.6);
    if (craftState.onStep === true) parts.push(`On the step at ${kmh} km/h, trim ${Math.round(craftState.trim || 0)} degrees.`);
    else parts.push(kmh > 3 ? `Plowing through the water at ${kmh} km/h.` : 'Afloat.');
    if ((craftState.porpoise || 0) > 0.25) parts.push(`We're porpoising: ease the nose ${(craftState.trim || 0) > 7 ? 'down' : 'up'}.`);
  }
  return parts.join(' ');
}

/** Low approaches start this high (m above the water): at most, and at least. */
const APPROACH_AGL = Object.freeze({ max: 150, min: 60 });
/** Below this height (m) over water, or landed on it, the seaplane starts afloat. */
const AFLOAT_AGL = 30;

/**
 * Contract h.4: over water, afloat when low or landed (water rudders down, nose into the wind when
 * slow), else a low approach into the wind at 1.3 x the stall speed; on land, standing on the wheels
 * when landed or low, else the Phase 1 rules (flying on at cruise where it is).
 */
function situate(situation, api) {
  const position = situation.position;
  const intoWind = api.headingIntoWind(position.x, position.z);
  if (situation.overWater && Number.isFinite(situation.waterHeight)) {
    if (situation.wasOnWater || situation.wasOnGround || situation.agl < AFLOAT_AGL) {
      const moving = situation.groundSpeed > 3;
      return {
        mode: 'water',
        position: { x: position.x, y: situation.waterHeight, z: position.z },
        heading: moving ? situation.trackHeading : intoWind,
        speed: moving ? Math.min(situation.groundSpeed, 6) : 0,
        throttle: 0,
        craftState: { waterRudders: true },
      };
    }
    const height = situation.waterHeight + clamp(situation.agl, APPROACH_AGL.min, APPROACH_AGL.max);
    return {
      mode: 'air',
      position: { x: position.x, y: height, z: position.z },
      heading: wrapDegrees(intoWind),
      speed: 1.3 * STALL_SPEED_CLEAN,
      throttle: 0.45,
      craftState: { waterRudders: false },
    };
  }
  if (situation.wasOnGround || situation.agl < 3) return { mode: 'ground', flatSpot: true, craftState: { waterRudders: false } };
  return { craftState: { waterRudders: false } };
}

export default Object.freeze({
  id: 'seaplane',
  name: 'Seaplane',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: throttle is engine power; flapsUp / flapsDown and the flap axis step through
   * the 3 notches; the gear toggle raises and lowers the amphibian wheels (also on the water). On the
   * water the pedals and the differential toe brakes steer the water rudders (when down); on land the
   * toe brakes brake the main wheels and the pedals steer the castering nose wheels.
   */
  inputProfile: Object.freeze({ throttle: 'throttle', flapNotches: 3, toeBrakes: 'waterRudders', rudderSteersTailwheel: true }),
  bindings: Object.freeze({
    // TWCS button 6 (index 5, the parachute on other craft) raises and lowers the water rudders under
    // the throttle hand.
    twcs: Object.freeze({ actions: Object.freeze({ craftAbility: Object.freeze([Object.freeze({ type: 'button', index: 5 })]), chuteDeploy: Object.freeze([]) }) }),
  }),
  audioProfile: Object.freeze({ engine: 'radial', cylinders: 9, idleRpm: 600, maxRpm: 2300, blades: PROP_BLADES, interiorCutoff: 850, stallHorn: true, stallAoa: 15 }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 19, height: 4.6, lookAhead: 16 }),
    wing: Object.freeze({ position: Object.freeze([5.6, 1.6, 1.8]), target: Object.freeze([0.4, -0.4, -3]) }),
    fpv: null,
    // Enclosed cabin under the high wing: windshield pillars, door frames, the roof under the wing and
    // a panel with the water-rudder and gear advisory gauge beside the flaps and gear.
    cockpit: Object.freeze({
      style: 'cabin',
      width: 0.86,
      sill: -0.2,
      floor: -0.7,
      front: -0.98,
      back: 0.8,
      roof: 0.3,
      panel: Object.freeze({
        width: 0.7,
        center: Object.freeze([0, -0.2, -0.62]),
        layout: Object.freeze([
          Object.freeze(['airspeed', 'attitude', 'altitude', 'vsi', 'throttle']),
          Object.freeze(['aoa', 'heading', 'g', 'flapsGear', 'waterRudder']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'throttle', 'flapsGear', 'waterRudder']),
  abilities: Object.freeze({ craftAbility }),
  spawn: Object.freeze({ cruise: 52, cruiseThrottle: 0.7, hover: false, relaunch: 'airstart', canStartOnGround: true }),
  limits: Object.freeze({ vne: 72, gLimit: 3.8, crashSinkRate: 4, bodyStrikeSpeed: 5, floats: false, waterLanding: 'floats', noseOverSpeed: 4.5, skidCrashSpeed: 5.6 }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'seaplaneWaterLandings', label: 'Water landings', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'seaplaneLakeLandings', label: 'Lake landings', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'seaplaneStepSeconds', label: 'Longest run on the step', unit: 'seconds', op: 'max' }),
    ]),
  }),
  directorProfile: Object.freeze({ favor: Object.freeze({ tags: Object.freeze({ water: 1.6, lake: 1.8 }) }) }),
  capabilities: Object.freeze({ engine: true, water: true }),
});
