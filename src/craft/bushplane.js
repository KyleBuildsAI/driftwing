// BUSH PLANE: a Super Cub style backcountry taildragger, built from code in the v1 glider's style
// (flat-shaded, vertex-coloured lofts in the v1 palette). High constant-chord wing on V lift struts,
// boxy fabric fuselage with a glassy cabin, oversized tundra tires on spring gear, tail wheel,
// two-blade prop with a blur disc, and animated ailerons, elevator, rudder and 3-notch flaps.
// Its flight profile describes the real thing (stall about 55 km/h with full flaps, cruise about
// 170 km/h, climb about 5 m/s, strong prop torque).
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, mirrorPoint, getCraftMaterials, addSolid, addPivot,
  createPropDisc, createNavLights, disposeCraftMesh,
} from './kit.js';

// ============================================================================================
// SIM: a Super Cub style bush plane for SimFixedWing (src/flight/SimFixedWing.js). Targets first,
// then the physical parameters that meet them, then the contact points. Positions are body axes
// relative to the mesh origin (x right, y up, z aft; m); angles in degrees. tools/flight-lab.mjs
// measures the targets in flight.
// ============================================================================================
const simProfile = Object.freeze({
  model: 'fixedWing',
  targets: Object.freeze({
    stallSpeedFullFlaps: 15.28, // m/s = 55 km/h, power off
    stallSpeedClean: 19.17, // m/s = 69 km/h, power off (follows from the wing, not a spec target)
    cruiseSpeed: 47.2, // m/s = 170 km/h at 75 % power
    climbRate: 5, // m/s at full power, best climb speed
    vne: 68, // m/s = 245 km/h
  }),
  mass: Object.freeze({ empty: 500, pilot: 90, fuel: 60 }), // 650 kg, 39 kg/m^2
  // kg m^2 about body x (pitch), y (yaw) and z (roll); yawRoll is the y-z product of inertia.
  inertia: Object.freeze({ pitch: 1300, yaw: 2100, roll: 1150, yawRoll: 60 }),
  centerOfMass: Object.freeze([0, 0.1, -0.62]),
  wing: Object.freeze({
    span: 10.73,
    area: 16.6, // constant 1.6 m chord, rounded tips
    taper: 1,
    oswald: 0.75,
    incidence: 1,
    // 1 degree of geometric dihedral plus the high wing's keel effect.
    dihedral: 3.5,
    washout: 0,
    aerodynamicCenter: Object.freeze([0, 0.9, -0.65]),
    cm0: -0.08, // thick, cambered USA-35B section
  }),
  aero: Object.freeze({
    cd0: 0.05, // struts, wires, tundra tires and fabric
    clAlpha: 4.8, // per rad (AR 6.9)
    clMax: 1.72,
    clMin: -1,
    alphaCritical: 15,
    postStallClDrop: 0.5,
    stallDropWidth: 4,
    stallBlendWidth: 16,
  }),
  fuselage: Object.freeze({ sideArea: 4.2, sideForceSlope: 0.4, sideForceZ: -1.3, crossflowStations: Object.freeze([-1.6, 2.6]) }),
  tail: Object.freeze({
    horizontal: Object.freeze({ position: Object.freeze([0, 0.44, 3.48]), area: 2.7, aspectRatio: 3.8, incidence: 1.5, downwash: 1, wake: 0.75 }),
    // Offset a little to the left so the slipstream swirl is trimmed out at cruise power.
    vertical: Object.freeze({ position: Object.freeze([0, 0.95, 3.72]), area: 1.25, aspectRatio: 1.3, offset: -1, shadow: 0.6 }),
  }),
  // Max deflections (deg, matching the mesh), how much angle of attack a full deflection adds to its
  // surface (share of the deflection), the trim's range (share of full elevator) and servo speed (1/s).
  controls: Object.freeze({
    aileron: 20,
    elevator: 25,
    rudder: 25,
    effectiveness: Object.freeze({ aileron: 0.45, elevator: 0.9, rudder: 0.6 }),
    trimRange: 0.45,
    servoRate: 5,
  }),
  // Three notches past up (13, 27 and 40 degrees). The increments act across the wing (big slotted
  // flaps with drooping ailerons, STOL-kit style): full flaps add 1.0 to CLmax -> about 55 km/h.
  flaps: Object.freeze({ notches: Object.freeze([0, 1 / 3, 2 / 3, 1]), maxDeflection: 40, clMaxIncrement: 1.0, clIncrement: 0.85, cdIncrement: 0.06, pitchMoment: -0.14, deploySeconds: 3 }),
  spoilers: null,
  gear: Object.freeze({ retractable: false }),
  engine: Object.freeze({
    kind: 'piston',
    powerKw: 112, // 150 hp at 2700 rpm
    idlePower: 0.04,
    idleRpm: 700,
    maxRpm: 2700,
    propDiameter: 1.93,
    // Cruise-pitched fixed prop: 82 % efficient from 52 m/s; about 50 % at the 31 m/s climb speed.
    propEfficiency: 0.8,
    designSpeed: 52,
    staticThrustN: 2900,
    staticFade: 10,
    spoolSeconds: 0.9,
    position: Object.freeze([0, 0.02, -2.34]),
    // Strong left-turning tendencies (right-hand prop): torque roll, P-factor, slipstream swirl on the
    // fin and gyroscopic yaw when the tail comes up; right rudder holds them.
    rotation: 'clockwise-from-cockpit',
    propInertia: 1.6,
    pFactorArm: 0.22,
    swirl: 0.12,
    slipstreamTail: 0.65,
    slipstreamWing: 0.25,
    windmillDrag: 0.08,
  }),
  contacts: Object.freeze([
    Object.freeze({ id: 'leftMain', kind: 'wheel', gear: true, position: Object.freeze([-1.02, -1.4, -1]), spring: 42000, damping: 3600, rollingFriction: 0.07, sideFriction: 0.85, brake: true }),
    Object.freeze({ id: 'rightMain', kind: 'wheel', gear: true, position: Object.freeze([1.02, -1.4, -1]), spring: 42000, damping: 3600, rollingFriction: 0.07, sideFriction: 0.85, brake: true }),
    Object.freeze({ id: 'tailWheel', kind: 'wheel', gear: true, position: Object.freeze([0, -0.19, 4.32]), spring: 16000, damping: 1300, rollingFriction: 0.08, sideFriction: 0.7, steerable: true }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-5.36, 0.86, -0.25]) }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([5.36, 0.86, -0.25]) }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, 0.02, -2.55]) }),
    Object.freeze({ id: 'propTip', kind: 'body', gear: false, position: Object.freeze([0, -0.94, -2.32]) }),
    Object.freeze({ id: 'tail', kind: 'body', gear: false, position: Object.freeze([0, 0.4, 4.36]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 1.55, 4.1]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -0.44, -0.5]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin near the centre of mass)
// ============================================================================================
// Airfoils as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
const WING_PROFILE = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [1, 0], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
const WING_PROFILE_CUT = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [0.72, 0.1], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
const SURFACE_PROFILE = [[0.735, 0.29], [1, 0], [0.735, -0.1]];
const SURFACE_HINGE = [0.735, 0.095];
const TAIL_PROFILE_CUT = [[0, 0], [0.07, 0.45], [0.3, 0.5], [0.7, 0.3], [0.7, 0], [0.7, -0.3], [0.3, -0.5], [0.07, -0.45]];
const TAIL_SURFACE_PROFILE = [[0.715, 0.29], [1, 0], [0.715, -0.29]];
const TAIL_HINGE_FRACTION = 0.715;

// Wing: constant 1.6 m chord from the centreline to the rounded tip, 1 degree dihedral.
const WING = Object.freeze({ CHORD: 1.6, LEADING_EDGE: -1.05, ROOT_Y: 0.86, THICKNESS: 0.12, TIP_X: 5.36, DIHEDRAL: Math.tan(1 * DEG) });
const FLAP_SPAN = Object.freeze([0.52, 2.46]);
const AILERON_SPAN = Object.freeze([2.52, 5.06]);
function wingChordAt(x) {
  if (x <= 5.08) return WING.CHORD;
  return WING.CHORD - 0.55 * ((x - 5.08) / (WING.TIP_X - 5.08)) ** 1.6;
}
function wingLeadingEdgeAt(x) {
  if (x <= 5.08) return WING.LEADING_EDGE;
  return WING.LEADING_EDGE + 0.2 * ((x - 5.08) / (WING.TIP_X - 5.08)) ** 1.6;
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
  const lowerEdge = (edge) => edge >= 4;
  const tint = (edge) => (lowerEdge(edge) ? PALETTE.creamShade : PALETTE.cream);
  // Centre section over the cabin (no flap there), the flap / aileron bay, then the rounded tip.
  builder.loft([0, FLAP_SPAN[0]].map((x) => mirror(wingSection(x, WING_PROFILE))), (segment, edge) => tint(edge));
  const bay = [FLAP_SPAN[0], FLAP_SPAN[1], AILERON_SPAN[0], AILERON_SPAN[1]].map((x) => mirror(wingSection(x, WING_PROFILE_CUT)));
  builder.loft(bay, (segment, edge) => tint(edge));
  const tip = [AILERON_SPAN[1], 5.18, 5.28, WING.TIP_X].map((x) => mirror(wingSection(x, WING_PROFILE)));
  builder.loft(tip, (segment, edge) => (segment >= 1 ? PALETTE.orange : tint(edge)), { capEnd: PALETTE.orange });
}

/** A trailing-edge surface between two span stations, hinged on its leading edge. */
function buildWingSurface(start, end, side, stripe) {
  const builder = createMeshBuilder();
  const middle = (start + end) / 2;
  const stations = [start, middle, end];
  const sections = stations.map((x) => profileSection(SURFACE_PROFILE, [x, wingHeightAt(x), wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS)
    .map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment) => (stripe && segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hingeStart = mirrorPoint(wingHingePoint(start), side);
  const hingeEnd = mirrorPoint(wingHingePoint(end), side);
  const axis = new THREE.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
  return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
}

// Fuselage stations: [z, centre y, half width, half height]; octagonal sections read as a boxy
// fabric-covered tube with flat sides, roof and belly.
const FUSELAGE = [
  [-2.25, 0.02, 0.3, 0.28],
  [-2.0, 0.04, 0.4, 0.38],
  [-1.45, 0.08, 0.46, 0.47],
  [-1.05, 0.12, 0.47, 0.6],
  [-0.2, 0.14, 0.47, 0.64],
  [0.55, 0.16, 0.44, 0.6],
  [1.4, 0.22, 0.32, 0.42],
  [2.6, 0.3, 0.2, 0.28],
  [3.6, 0.36, 0.12, 0.18],
  [4.2, 0.4, 0.06, 0.1],
];
const FUSELAGE_SIDES = 8;
// Faces of the octagon loft (edge e runs from corner e to e + 1, corners at 22.5 + 45 e degrees):
// 0 upper right, 1 roof, 2 upper left, 3 left side, 4 lower left, 5 belly, 6 lower right, 7 right side.
const FACE = Object.freeze({ UPPER_RIGHT: 0, ROOF: 1, UPPER_LEFT: 2, LEFT: 3, LOWER_LEFT: 4, BELLY: 5, LOWER_RIGHT: 6, RIGHT: 7 });
/** Glass panels: [segment, face]. Windshield (segment 2) and the cabin's upper side windows. */
const WINDOWS = Object.freeze([
  [2, FACE.UPPER_RIGHT], [2, FACE.ROOF], [2, FACE.UPPER_LEFT],
  [3, FACE.UPPER_RIGHT], [3, FACE.UPPER_LEFT], [4, FACE.UPPER_RIGHT], [4, FACE.UPPER_LEFT],
  [5, FACE.UPPER_RIGHT], [5, FACE.UPPER_LEFT],
]);

function fuselageSections() {
  return FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => {
    const ring = [];
    for (let index = 0; index < FUSELAGE_SIDES; index++) {
      const angle = (22.5 + index * 45) * DEG;
      ring.push([halfWidth * Math.cos(angle), centreY + halfHeight * Math.sin(angle), z]);
    }
    return ring;
  });
}

function buildFuselage(builder, sections) {
  builder.loft(sections, (segment, face) => {
    if (segment <= 1) return PALETTE.orange;
    if (face === FACE.BELLY || face === FACE.LOWER_LEFT || face === FACE.LOWER_RIGHT) return PALETTE.creamShade;
    // A long orange cheat line down each side, from the cabin door to the tail.
    if ((face === FACE.LEFT || face === FACE.RIGHT) && segment >= 3 && segment <= 7) return PALETTE.orange;
    return PALETTE.cream;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
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

// Tail: fin with a rounded top, stabilizer with elevator, straight hinge lines.
const FIN = Object.freeze({ BASE_Y: 0.46, TOP_Y: 1.5, THICKNESS: 0.1, HINGE_Z: 4.05 });
const finLeadingEdge = (y) => 3.2 + (0.62 * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y);
const finChord = (y) => (FIN.HINGE_Z - finLeadingEdge(y)) / TAIL_HINGE_FRACTION;
const STAB = Object.freeze({ Y: 0.44, HINGE_Z: 3.92, HALF_SPAN: 1.6, THICKNESS: 0.1 });
const stabChord = (x) => 0.95 - (0.3 * Math.abs(x) ** 2) / STAB.HALF_SPAN ** 2;
const stabLeadingEdge = (x) => STAB.HINGE_Z - TAIL_HINGE_FRACTION * stabChord(x);

function buildTail(builder) {
  const finSections = [FIN.BASE_Y, 1.1, 1.38, FIN.TOP_Y].map((y) => profileSection(TAIL_PROFILE_CUT, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(finSections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  const stabSections = [-STAB.HALF_SPAN, -1.1, 0, 1.1, STAB.HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(stabSections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
}
function buildRudder() {
  const builder = createMeshBuilder();
  // Starts just above the stabilizer so it swings clear of the elevator.
  const heights = [STAB.Y + 0.07, 1.1, 1.38, FIN.TOP_Y];
  const sections = heights.map((y) => profileSection(TAIL_SURFACE_PROFILE, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(sections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  const start = [0, heights[0], FIN.HINGE_Z];
  const end = [0, heights[heights.length - 1], FIN.HINGE_Z];
  return { geometry: builder.toGeometry(start), pivot: start, axis: new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize() };
}
function buildElevator() {
  const builder = createMeshBuilder();
  const stations = [-1.58, -1.1, -0.08, 0.08, 1.1, 1.58];
  const sections = stations.map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(sections, (segment) => (segment === 0 || segment === 4 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  const pivot = [0, STAB.Y, STAB.HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

/** A straight faceted bar (strut, gear leg) from a to b with a lozenge or rectangular section. */
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

/** A fat tundra tire (axle along x): bulging tread in charcoal, a cream hub cap each side. */
function buildWheel(builder, centre, radius, width, sides = 14) {
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

// Landing gear: spring-steel legs from the lower longerons to the axles; tail wheel on a leaf spring.
const MAIN_WHEEL = Object.freeze({ X: 1.02, Y: -0.98, Z: -1, RADIUS: 0.42, WIDTH: 0.3 });
const TAIL_WHEEL = Object.freeze({ Y: -0.08, Z: 4.32, RADIUS: 0.11, WIDTH: 0.07 });
function buildGear(builder) {
  for (const side of [1, -1]) {
    buildBar(builder, [0.3 * side, -0.36, -1.15], [(MAIN_WHEEL.X - 0.17) * side, MAIN_WHEEL.Y + 0.02, MAIN_WHEEL.Z], 0.06, 0.018, PALETTE.charcoal, [0, 0, 1]);
    buildBar(builder, [0.3 * side, -0.36, -0.72], [(MAIN_WHEEL.X - 0.17) * side, MAIN_WHEEL.Y + 0.04, MAIN_WHEEL.Z + 0.06], 0.03, 0.03, PALETTE.charcoal);
    buildBar(builder, [(MAIN_WHEEL.X - 0.2) * side, MAIN_WHEEL.Y, MAIN_WHEEL.Z], [(MAIN_WHEEL.X + 0.02) * side, MAIN_WHEEL.Y, MAIN_WHEEL.Z], 0.035, 0.035, PALETTE.charcoal);
  }
  buildBar(builder, [0, 0.26, 3.95], [0, TAIL_WHEEL.Y + 0.04, TAIL_WHEEL.Z], 0.035, 0.012, PALETTE.charcoal, [1, 0, 0]);
}

// Lift struts: a V on each side from one fuselage fitting to the front and rear spars.
function buildStruts(builder) {
  for (const side of [1, -1]) {
    const root = [0.44 * side, -0.3, -0.42];
    buildBar(builder, root, [2.92 * side, wingHeightAt(2.92) - 0.05, -0.64], 0.055, 0.02, PALETTE.charcoal, [0, 0, 1]);
    buildBar(builder, root, [2.92 * side, wingHeightAt(2.92) - 0.05, -0.02], 0.055, 0.02, PALETTE.charcoal, [0, 0, 1]);
    // Jury strut from mid-strut up to the wing.
    buildBar(builder, [1.72 * side, 0.26, -0.52], [1.72 * side, wingHeightAt(1.72) - 0.05, -0.62], 0.02, 0.02, PALETTE.charcoal);
  }
}

// Propeller: faceted spinner + two twisted blades with orange tips (rotates about local z).
const PROP_PIVOT = [0, 0.02, -2.26];
const PROP_PLANE_Z = -0.08;
const PROP_RADIUS = 0.96;
function buildPropeller() {
  const builder = createMeshBuilder();
  const spinner = [[0.02, 0.24], [-0.1, 0.22], [-0.2, 0.16], [-0.27, 0.07], [-0.3, 0]].map(([z, radius]) => {
    const ring = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
    return ring;
  });
  builder.loft(spinner, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream });
  const bladeStations = [[0.14, 0.13, 42], [0.36, 0.16, 30], [0.62, 0.14, 21], [0.84, 0.1, 16], [PROP_RADIUS, 0.06, 14]];
  const bladeThickness = 0.024;
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

const TIP_Y = wingHeightAt(WING.TIP_X);
const EYE = Object.freeze([0, 0.52, -0.62]);
const FLAP_MAX_DEFLECTION = simProfile.flaps.maxDeflection;
const SURFACE_LIMITS = Object.freeze({ aileron: simProfile.controls.aileron, elevator: simProfile.controls.elevator, rudder: simProfile.controls.rudder });

/**
 * Builds the bush plane. update(visual, dt) animates ailerons / elevator / rudder (visual.aileron,
 * elevator, rudder in -1..1), flaps (visual.flaps 0..1), the prop (visual.propSpeed in rad/s, or a
 * throttle-driven spin that winds down with the engine off), rolls the wheels on the ground
 * (visual.groundSpeed) and runs the nav lights from visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'bushplane';

  const sections = fuselageSections();
  const airframe = createMeshBuilder();
  buildFuselage(airframe, sections);
  buildWingHalf(airframe, 1);
  buildWingHalf(airframe, -1);
  buildTail(airframe);
  buildStruts(airframe);
  buildGear(airframe);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  // The window panes would sit around the pilot's head: the cockpit view hides them.
  const windows = addSolid(root, buildWindows(sections), materials.canopy);
  windows.userData.hideInCockpit = true;

  const aileronRight = addPivot(root, buildWingSurface(AILERON_SPAN[0], AILERON_SPAN[1], 1, true), bodyMaterial);
  const aileronLeft = addPivot(root, buildWingSurface(AILERON_SPAN[0], AILERON_SPAN[1], -1, true), bodyMaterial);
  const flapRight = addPivot(root, buildWingSurface(FLAP_SPAN[0], FLAP_SPAN[1], 1, false), bodyMaterial);
  const flapLeft = addPivot(root, buildWingSurface(FLAP_SPAN[0], FLAP_SPAN[1], -1, false), bodyMaterial);
  const elevator = addPivot(root, buildElevator(), bodyMaterial);
  const rudder = addPivot(root, buildRudder(), bodyMaterial);

  // Wheels are their own groups so they can roll.
  const wheels = [];
  for (const side of [1, -1]) {
    const builder = createMeshBuilder();
    buildWheel(builder, [0, 0, 0], MAIN_WHEEL.RADIUS, MAIN_WHEEL.WIDTH);
    const wheel = new THREE.Group();
    wheel.position.set(MAIN_WHEEL.X * side, MAIN_WHEEL.Y, MAIN_WHEEL.Z);
    addSolid(wheel, builder.toGeometry(null), bodyMaterial);
    root.add(wheel);
    wheels.push({ group: wheel, radius: MAIN_WHEEL.RADIUS });
  }
  {
    const builder = createMeshBuilder();
    buildWheel(builder, [0, 0, 0], TAIL_WHEEL.RADIUS, TAIL_WHEEL.WIDTH, 10);
    const wheel = new THREE.Group();
    wheel.position.set(0, TAIL_WHEEL.Y, TAIL_WHEEL.Z);
    addSolid(wheel, builder.toGeometry(null), bodyMaterial);
    root.add(wheel);
    wheels.push({ group: wheel, radius: TAIL_WHEEL.RADIUS });
  }

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
    strobe: { position: [0, FIN.TOP_Y + 0.06, 4.0], glow: [0, FIN.TOP_Y + 0.14, 4.0] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let propAngle = 0;
  let propSpeed = 0;
  let wheelAngle = 0;

  return {
    root,
    wingtips: [new THREE.Vector3(-WING.TIP_X - 0.05, TIP_Y + 0.05, -0.2), new THREE.Vector3(WING.TIP_X + 0.05, TIP_Y + 0.05, -0.2)],
    eyeAnchor,
    /** Local attachment points: smoke generator and tow hitch at the tail. */
    anchors: {
      smoke: new THREE.Vector3(0, 0.3, 4.45),
      towHitch: new THREE.Vector3(0, 0.22, 4.25),
      tail: new THREE.Vector3(0, 0.4, 4.36),
    },

    update(visual, dt) {
      // Right aileron trailing edge rises for a right roll; the left hinge axis is mirrored, so the same
      // signed angle lowers the left aileron. Flaps: both trailing edges go down.
      const aileronAngle = -clamp(visual.aileron, -1, 1) * SURFACE_LIMITS.aileron * DEG;
      aileronRight.quaternion.setFromAxisAngle(aileronRight.userData.axis, aileronAngle);
      aileronLeft.quaternion.setFromAxisAngle(aileronLeft.userData.axis, aileronAngle);
      const flapAngle = clamp(Number.isFinite(visual.flaps) ? visual.flaps : 0, 0, 1) * FLAP_MAX_DEFLECTION * DEG;
      flapRight.quaternion.setFromAxisAngle(flapRight.userData.axis, flapAngle);
      flapLeft.quaternion.setFromAxisAngle(flapLeft.userData.axis, -flapAngle);
      elevator.quaternion.setFromAxisAngle(elevator.userData.axis, -clamp(visual.elevator, -1, 1) * SURFACE_LIMITS.elevator * DEG);
      rudder.quaternion.setFromAxisAngle(rudder.userData.axis, clamp(visual.rudder, -1, 1) * SURFACE_LIMITS.rudder * DEG);

      const throttle = Number.isFinite(visual.throttle) ? visual.throttle : 0;
      const targetSpeed = Number.isFinite(visual.propSpeed) ? visual.propSpeed : visual.engineOn === false ? 0 : 9 + 24 * throttle;
      propSpeed = dt > 0 ? damp(propSpeed, targetSpeed, visual.engineOn === false ? 1.2 : 6, dt) : propSpeed;
      propAngle = (propAngle + propSpeed * dt) % (Math.PI * 2);
      if (!Number.isFinite(propAngle)) propAngle = 0;
      propeller.rotation.z = propAngle;
      propDisc.setSpeed(propSpeed > 0.5 ? propSpeed : 0);

      if (visual.onGround && Number.isFinite(visual.groundSpeed) && dt > 0) {
        wheelAngle = (wheelAngle - (visual.groundSpeed / MAIN_WHEEL.RADIUS) * dt) % (Math.PI * 2);
        for (const wheel of wheels) wheel.group.rotation.x = (wheelAngle * MAIN_WHEEL.RADIUS) / wheel.radius;
      }

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: smoke trail. A smoke generator in the tail lays a soft white trail for formation-style
// flying and for marking the wind; it toggles on and off.
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Smoke trail',
  initialState: () => ({ smoke: false }),
  run(flight) {
    const craftState = flight.craftState;
    craftState.smoke = !craftState.smoke;
    flight.notify(craftState.smoke ? 'Smoke on.' : 'Smoke off.');
    return true;
  },
  update(flight, dt) {
    const craftState = flight.craftState;
    if (!craftState.smoke) return;
    flight.emitTrail('smoke', 'smoke', dt);
  },
});

export default Object.freeze({
  id: 'bushplane',
  name: 'Bush plane',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: throttle is engine power; flapsUp / flapsDown and the flap axis step through
   * the 3 notches; toe brakes brake the mains on the ground (differential steers) and the rudder
   * steers the tail wheel at taxi speed.
   */
  inputProfile: Object.freeze({ throttle: 'throttle', flapNotches: 3, toeBrakes: 'wheels', rudderSteersTailwheel: true }),
  audioProfile: Object.freeze({ engine: 'prop', cylinders: 4, idleRpm: 700, maxRpm: 2700, blades: 2, propDiameter: 1.93, exhaustRoughness: 0.35 }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 14.5, height: 3.6, lookAhead: 14 }),
    wing: Object.freeze({ position: Object.freeze([4.3, 1.3, 1.5]), target: Object.freeze([0.4, 0.6, -2.6]) }),
    fpv: null,
    // Enclosed cabin under the high wing: windshield pillars, door frames and roof rails around a
    // skylight (the wing's underside shows through it), and a six-pack panel with the throttle.
    cockpit: Object.freeze({
      style: 'cabin',
      width: 0.8,
      sill: -0.2,
      floor: -0.68,
      front: -0.95,
      back: 0.75,
      roof: 0.25,
      panel: Object.freeze({
        width: 0.62,
        center: Object.freeze([0, -0.2, -0.6]),
        layout: Object.freeze([
          Object.freeze(['airspeed', 'attitude', 'altitude', 'vsi', 'throttle']),
          Object.freeze(['aoa', 'heading', 'g', 'flapsGear']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'throttle', 'flapsGear']),
  abilities: Object.freeze({ craftAbility }),
  spawn: Object.freeze({ cruise: 47, cruiseThrottle: 0.75, hover: false, relaunch: 'airstart', canStartOnGround: true }),
  limits: Object.freeze({ vne: 68, gLimit: 4.4, crashSinkRate: 4.5, bodyStrikeSpeed: 5, floats: false }),
});
