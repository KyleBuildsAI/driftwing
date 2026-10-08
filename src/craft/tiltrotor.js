// TILTROTOR: an Osprey-style VTOL proprotor transport, built from code in the v1 glider's style
// (flat-shaded, vertex-coloured lofts in the v1 palette). A boxy fuselage with a stepped flight-deck
// glazing, gear sponsons and an upswept tail over the loading ramp; a thick straight wing on a dorsal
// fairing with full-span flaperons; tilting wingtip nacelles carrying three-blade proprotors with
// their blur discs; an H tail with twin fins and rudders; retractable tricycle gear.
// Moving parts: the nacelles tilt with craftState.nacelleAngle, the proprotors turn with the rotor
// speed and their discs flap with the cyclic, the flaperons droop by schedule and deflect with the
// roll command, the elevator and rudders follow the stick and pedals, and the gear folds into the
// sponsons and the nose.
// Its flight profile describes the real thing for SimTiltrotor (src/flight/SimTiltrotor.js),
// measured by tools/lab/tiltrotor.mjs.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, ellipseRing, mirrorPoint, getCraftMaterials, addSolid, createNavLights, disposeCraftMesh, smooth01,
} from './kit.js';
import { NACELLE, snapNacelle, corridorParameters, conversionCorridor, scheduledNacelle, nacelleMode } from '../flight/tiltrotorCorridor.js';

const { uniform, color, float, uv, length, smoothstep, mix } = TSL;

// ============================================================================================
// SIM: SimTiltrotor parameters. Body axes relative to the mesh origin (x right, y up, z aft; m);
// angles in degrees. Targets are what tools/lab/tiltrotor.mjs measures.
// ============================================================================================
const NACELLE_PIVOT = Object.freeze({ X: 7.1, Y: 1.75, Z: -0.36 });
const HUB_OFFSET = 2.6;
const ROTOR_RADIUS = 5.8;

const simProfile = Object.freeze({
  model: 'tiltrotor',
  targets: Object.freeze({
    hoverCollective: 0.5, // thrust lever share for an out-of-ground-effect hover at sea level
    hoverPower: 0.7, // share of the engines' rated power in that hover
    verticalClimb: 6, // m/s at full lever, no airspeed (power limited)
    stallSpeed: 63, // m/s: the corridor's lower edge reaches 0 degrees (flaperons drooped)
    maxLevelSpeed: 135, // m/s in airplane mode at full lever, sea level
    cruiseLever: 0.5, // thrust lever for 110 m/s in airplane mode
    conversionSeconds: 30, // hover to airplane mode with the auto-nacelle schedule and full lever
  }),
  mass: Object.freeze({ empty: 15000, pilot: 200, fuel: 2000, payload: 800 }), // 18 t: a light mission weight
  // kg m^2 about body x (pitch), y (yaw) and z (roll): the nacelles and rotors far out on the wingtips.
  inertia: Object.freeze({ pitch: 320000, yaw: 520000, roll: 260000 }),
  centerOfMass: Object.freeze([0, 0.7, NACELLE_PIVOT.Z]),
  rotor: Object.freeze({
    radius: ROTOR_RADIUS,
    blades: 3,
    chord: 0.66,
    liftSlope: 5.7,
    profileDrag: 0.01,
    rpm: 397, // 100 % in helicopter mode
    airplaneRpm: 0.84, // share of it in airplane mode
    inertia: 23000, // kg m^2: both proprotors and the cross-shaft
    // Blade pitch at 3/4 radius over the thrust lever's travel in helicopter and in airplane mode
    // (the flight control computer adds the inflow bias and the governor trim on top).
    helicopterPitch: Object.freeze([1.1, 28.1]),
    airplanePitch: Object.freeze([-1.5, 4.5]),
    maxBias: 62,
    cyclic: 12, // longitudinal cyclic at full stick (helicopter mode)
    differentialCollective: 1.5, // roll at full stick (helicopter mode)
    differentialCyclic: 8, // yaw at full pedal (helicopter mode)
    flapLag: 0.1,
    flapDamping: 0.08,
    flapback: 0.6,
    flapLimit: 12, // the gimbal stop
    hubStiffness: 120000, // N m per rad of disc tilt (the gimbal spring)
    inducedPowerFactor: 1.15,
    coning: 2.5,
    washFactor: 1.4, // the wake's speed at the wing in hover-induced velocities
    hubOffset: HUB_OFFSET, // hub ahead of the nacelle pivot along the shaft
  }),
  nacelles: Object.freeze({
    pivots: Object.freeze([
      Object.freeze([-NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z]),
      Object.freeze([NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z]),
    ]),
    rate: 8, // deg/s
    groundMinimum: 60, // deg: the lowest angle with the weight on the wheels (proprotor ground clearance)
    dragAreas: Object.freeze([0.45, 5.5]), // flat-plate m^2 along the shaft and across it
  }),
  engine: Object.freeze({
    kind: 'turboshaft',
    powerKw: 7000, // two engines on a cross-shaft
    spoolSeconds: 0.8,
    startSeconds: 10,
    rundownSeconds: 5,
    governorGain: 3,
    governorIntegral: 2.5,
    densityLapse: 0.8,
    accessoryKw: 40,
  }),
  wing: Object.freeze({
    area: 36,
    span: 14,
    chord: 2.57,
    position: Object.freeze([0, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z]), // the aerodynamic centre
    incidence: 3,
    clMax: 1.45,
    alphaCritical: 14,
    postStallDrop: 0.45,
    flapCl: 0.55, // the drooped flaperons' lift increment...
    flapClMax: 0.6, // ...and their raise of CLmax
    cm0: -0.04,
    oswald: 0.75,
    washShare: 0.8, // share of the wing under the discs' wake
    flaperon: 15, // differential deflection at full roll
    droop: 40,
  }),
  tail: Object.freeze({
    horizontal: Object.freeze({ position: Object.freeze([0, 1.0, 7.9]), area: 8.2, aspectRatio: 4.1, incidence: 1.5, elevator: 20, effect: 0.5, trimRange: 0.3 }),
    vertical: Object.freeze({ positions: Object.freeze([Object.freeze([-3.0, 2.0, 8.3]), Object.freeze([3.0, 2.0, 8.3])]), area: 3.4, aspectRatio: 1.6, rudder: 22, effect: 0.45 }),
  }),
  fuselage: Object.freeze({
    // Flat-plate drag areas (m^2) broadside, from above and head-on.
    dragAreas: Object.freeze([26, 34, 1.8]),
    dragCenter: Object.freeze([0, 0, 0.4]),
  }),
  gear: Object.freeze({ retractable: true, transitSeconds: 6, dragArea: 1 }),
  vortexRing: Object.freeze({ start: 0.25, full: 0.6, fade: 1.2, end: 1.75, clearSpeed: 1.1, buildSeconds: 0.6, clearSeconds: 2.5, thrustLoss: 0.3, collectiveLoss: 0.85, roughness: 0.05 }),
  bladeStall: Object.freeze({ onsetAdvance: 0.24, width: 0.06, referenceLoading: 0.13, loadingSensitivity: 1.2, thrustLoss: 0.15, pitchMoment: 0.03, rollMoment: 0.03 }),
  // The conversion corridor (src/flight/tiltrotorCorridor.js).
  conversion: Object.freeze({ edgewiseLimit: 55, aftTiltSpeed: 25, liftMargin: 0.9, thrustMargin: 1.15, margin: 5, tolerance: 3 }),
  contacts: Object.freeze([
    Object.freeze({ id: 'noseWheel', kind: 'wheel', gear: true, retracts: true, steerable: true, steerAngle: 40, position: Object.freeze([0, -2.15, -5.4]), spring: 160000, damping: 30000, rollingFriction: 0.03, sideFriction: 0.8 }),
    Object.freeze({ id: 'leftMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([-1.95, -2.15, 0.45]), spring: 600000, damping: 90000, rollingFriction: 0.03, sideFriction: 0.85 }),
    Object.freeze({ id: 'rightMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([1.95, -2.15, 0.45]), spring: 600000, damping: 90000, rollingFriction: 0.03, sideFriction: 0.85 }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, -0.45, -8.7]) }),
    Object.freeze({ id: 'chin', kind: 'body', gear: false, position: Object.freeze([0, -1.2, -6.9]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -1.25, -2.4]) }),
    Object.freeze({ id: 'sponsonLeft', kind: 'body', gear: false, position: Object.freeze([-1.9, -1.25, 0.5]) }),
    Object.freeze({ id: 'sponsonRight', kind: 'body', gear: false, position: Object.freeze([1.9, -1.25, 0.5]) }),
    Object.freeze({ id: 'ramp', kind: 'body', gear: false, position: Object.freeze([0, -1.0, 4.4]) }),
    Object.freeze({ id: 'tailCone', kind: 'body', gear: false, position: Object.freeze([0, 0.6, 7.8]) }),
    Object.freeze({ id: 'nacelleLeft', kind: 'body', gear: false, position: Object.freeze([-NACELLE_PIVOT.X, 0.95, NACELLE_PIVOT.Z]) }),
    Object.freeze({ id: 'nacelleRight', kind: 'body', gear: false, position: Object.freeze([NACELLE_PIVOT.X, 0.95, NACELLE_PIVOT.Z]) }),
    Object.freeze({ id: 'stabilizerLeft', kind: 'body', gear: false, position: Object.freeze([-3.0, 0.4, 8.1]) }),
    Object.freeze({ id: 'stabilizerRight', kind: 'body', gear: false, position: Object.freeze([3.0, 0.4, 8.1]) }),
    Object.freeze({ id: 'finTopLeft', kind: 'body', gear: false, position: Object.freeze([-3.0, 3.4, 8.7]) }),
    Object.freeze({ id: 'finTopRight', kind: 'body', gear: false, position: Object.freeze([3.0, 3.4, 8.7]) }),
    Object.freeze({ id: 'cockpitRoof', kind: 'body', gear: false, position: Object.freeze([0, 1.15, -6.2]) }),
    Object.freeze({ id: 'wingTop', kind: 'body', gear: false, position: Object.freeze([0, 2.05, -0.4]) }),
  ]),
});

const CORRIDOR = corridorParameters(simProfile);

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin near the centre of mass)
// ============================================================================================
// Fuselage stations: [z, centre y, half width, half height]; octagonal sections read as the boxy
// transport hull with flat sides, roof and belly.
const FUSELAGE = [
  [-8.75, -0.45, 0.12, 0.1],
  [-8.3, -0.35, 0.6, 0.55],
  [-7.5, -0.2, 0.98, 0.95],
  [-6.3, 0, 1.14, 1.2],
  [-4.8, 0, 1.16, 1.25],
  [2.6, 0, 1.16, 1.25],
  [4.6, 0.3, 1.02, 0.95],
  [6.4, 0.62, 0.66, 0.55],
  [7.85, 0.85, 0.3, 0.28],
];
const FUSELAGE_SIDES = 8;
// Faces of the octagonal loft (edge e runs from corner e to e + 1, corners at 22.5 + 45 e degrees).
const FACE = Object.freeze({ UPPER_RIGHT: 0, ROOF: 1, UPPER_LEFT: 2, LEFT: 3, LOWER_LEFT: 4, BELLY: 5, LOWER_RIGHT: 6, RIGHT: 7 });
/** Flight-deck glazing: [segment, face]. Windshield, eyebrow and side windows, and the chin windows. */
const GLASS = Object.freeze([
  [1, FACE.UPPER_RIGHT], [1, FACE.ROOF], [1, FACE.UPPER_LEFT], [1, FACE.LOWER_LEFT], [1, FACE.LOWER_RIGHT],
  [2, FACE.UPPER_RIGHT], [2, FACE.UPPER_LEFT], [2, FACE.LEFT], [2, FACE.RIGHT],
]);

function fuselageSections() {
  return FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, FUSELAGE_SIDES, 22.5));
}

function buildFuselage(builder, sections) {
  const lower = new Set([FACE.LOWER_LEFT, FACE.BELLY, FACE.LOWER_RIGHT]);
  builder.loft(sections, (segment, face) => {
    if (segment === 0) return PALETTE.charcoal;
    if (lower.has(face)) return segment === 5 && face === FACE.BELLY ? PALETTE.charcoal : PALETTE.creamShade;
    // An orange cheat line along the cabin, and an orange band round the tail cone.
    if ((face === FACE.LEFT || face === FACE.RIGHT) && segment === 4) return PALETTE.orange;
    if (segment === 7) return PALETTE.orange;
    return PALETTE.cream;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.cream });
}

/** Glass panes: each glass face inset from its frame and lifted just off the skin. */
function buildGlass(sections) {
  const builder = createMeshBuilder();
  const inset = 0.06;
  const lift = 0.014;
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const [segment, face] of GLASS) {
    const next = (face + 1) % FUSELAGE_SIDES;
    const corners = [sections[segment][face], sections[segment][next], sections[segment + 1][next], sections[segment + 1][face]];
    const centre = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / 4);
    edgeA.set(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]);
    edgeB.set(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1], corners[3][2] - corners[0][2]);
    normal.crossVectors(edgeA, edgeB).normalize();
    const axisCentreY = (FUSELAGE[segment][1] + FUSELAGE[segment + 1][1]) / 2;
    if (centre[0] * normal.x + (centre[1] - axisCentreY) * normal.y - normal.z * 0.3 < 0) normal.negate();
    const pane = corners.map((corner) => [0, 1, 2].map((axis) => corner[axis] + (centre[axis] - corner[axis]) * inset + normal.getComponent(axis) * lift));
    const inside = [centre[0] - normal.x, centre[1] - normal.y, centre[2] - normal.z];
    builder.quad(pane[0], pane[1], pane[2], pane[3], PALETTE.charcoal, inside);
  }
  return builder.toGeometry(null);
}

/** Gear sponsons along the lower flanks: [z, centre y, half width, half height] around an offset axis. */
const SPONSON = [
  [-1.6, -0.75, 0.12, 0.3],
  [-1.1, -0.82, 0.38, 0.42],
  [1.8, -0.82, 0.4, 0.43],
  [2.7, -0.78, 0.16, 0.3],
];
function buildSponsons(builder) {
  for (const side of [-1, 1]) {
    const sections = SPONSON.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, 8, 22.5)
      .map((point) => [point[0] + side * 1.38, point[1], point[2]]));
    builder.loft(sections, (segment, face) => (face >= 4 && face <= 6 ? PALETTE.creamShade : segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  }
}

/** The dorsal wing fairing over the cabin roof. */
const FAIRING = [
  [-2.6, 1.1, 0.2, 0.12],
  [-1.6, 1.32, 0.62, 0.36],
  [1.6, 1.32, 0.66, 0.38],
  [3.4, 1.16, 0.3, 0.14],
];
function buildFairing(builder) {
  const sections = FAIRING.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, 8, 22.5));
  builder.loft(sections, (segment, face) => (face >= 4 && face <= 6 ? PALETTE.creamShade : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
}

// Wing: a thick straight wing with full-span flaperons, from the fuselage to the nacelle housings.
const WING_PROFILE = [[0, 0], [0.06, 0.55], [0.3, 0.62], [0.72, 0.28], [0.74, 0.1], [0.72, -0.12], [0.3, -0.36], [0.06, -0.3]];
const FLAPERON_PROFILE = [[0.74, 0.27], [1, 0], [0.74, -0.12]];
const WING = Object.freeze({ CHORD: 2.57, LEADING_EDGE: NACELLE_PIVOT.Z - 0.25 * 2.57, Y: NACELLE_PIVOT.Y - 0.05, THICKNESS: 0.19, TIP_X: NACELLE_PIVOT.X - 0.66 });
const FLAPERON = Object.freeze({ START: 1.3, END: WING.TIP_X - 0.15, HINGE: 0.74 });

function wingSection(x, profile) {
  return profileSection(profile, [x, WING.Y, WING.LEADING_EDGE], [0, 0, 1], [0, 1, 0], WING.CHORD, WING.THICKNESS);
}

function buildWing(builder) {
  const tint = (edge) => (edge >= 5 ? PALETTE.creamShade : PALETTE.cream);
  const stations = [-WING.TIP_X, -FLAPERON.END, -FLAPERON.START, FLAPERON.START, FLAPERON.END, WING.TIP_X];
  builder.loft(stations.map((x) => wingSection(x, WING_PROFILE)), (segment, edge) => (segment === 0 || segment === 4 ? PALETTE.orange : tint(edge)), { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  // The trailing edge over the fuselage (no flaperon there).
  const centre = [-FLAPERON.START, FLAPERON.START].map((x) => profileSection(FLAPERON_PROFILE, [x, WING.Y, WING.LEADING_EDGE], [0, 0, 1], [0, 1, 0], WING.CHORD, WING.THICKNESS));
  builder.loft(centre, () => PALETTE.cream, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
}

/** One flaperon, hinged on its leading edge (geometry relative to the hinge). */
function buildFlaperon(side) {
  const builder = createMeshBuilder();
  const stations = [FLAPERON.START, (FLAPERON.START + FLAPERON.END) / 2, FLAPERON.END];
  const sections = stations.map((x) => profileSection(FLAPERON_PROFILE, [x, WING.Y, WING.LEADING_EDGE], [0, 0, 1], [0, 1, 0], WING.CHORD, WING.THICKNESS).map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment) => (segment === 1 ? PALETTE.creamShade : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hinge = [0, WING.Y + 0.08 * WING.THICKNESS * WING.CHORD, WING.LEADING_EDGE + FLAPERON.HINGE * WING.CHORD];
  return { geometry: builder.toGeometry(hinge), hinge };
}

/** A straight faceted tube from a to b. */
function buildTube(builder, from, to, radius, tint, sides = 6, endTint = tint) {
  const direction = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const helper = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(direction, helper).normalize();
  const up = new THREE.Vector3().crossVectors(side, direction).normalize();
  const ring = (point) => {
    const points = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      points.push([
        point[0] + (side.x * Math.cos(angle) + up.x * Math.sin(angle)) * radius,
        point[1] + (side.y * Math.cos(angle) + up.y * Math.sin(angle)) * radius,
        point[2] + (side.z * Math.cos(angle) + up.z * Math.sin(angle)) * radius,
      ]);
    }
    return points;
  };
  builder.loft([ring(from), ring(to)], () => tint, { capStart: endTint, capEnd: endTint });
}

// Nacelle (local frame at the pivot, shaft along -z at 0 degrees): [z, half width, half height].
const NACELLE_BODY = [
  [2.35, 0.3, 0.3],
  [1.7, 0.66, 0.68],
  [-0.4, 0.74, 0.78],
  [-1.6, 0.66, 0.68],
  [-2.05, 0.46, 0.46],
];
const SPINNER = [[-2.05, 0.44], [-2.45, 0.34], [-2.8, 0.14], [-2.92, 0.02]];
function buildNacelle(builder) {
  const sections = NACELLE_BODY.map(([z, halfWidth, halfHeight]) => ellipseRing(z, 0, halfWidth, halfHeight, 10, 18));
  builder.loft(sections, (segment, face) => (segment === 2 && (face === 2 || face === 3) ? PALETTE.charcoal : segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.charcoal, capEnd: PALETTE.cream });
  // The engine intake scoop on the outboard face and the exhaust at the aft end.
  buildTube(builder, [0, 0.62, -0.9], [0, 0.66, 0.4], 0.24, PALETTE.creamShade, 8, PALETTE.charcoal);
  buildTube(builder, [0, 0, 2.2], [0, 0, 2.55], 0.22, PALETTE.charcoal, 8, PALETTE.charcoal);
}
function buildSpinner(builder) {
  const sections = SPINNER.map(([z, radius]) => ellipseRing(z, 0, radius, radius, 10, 18));
  builder.loft(sections, () => PALETTE.charcoal, { capEnd: PALETTE.orange });
}
/** The wingtip pivot fairing (fixed to the wing). */
function buildPivotFairing(builder, side) {
  const x = side * NACELLE_PIVOT.X;
  buildTube(builder, [x - side * 0.72, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z], [x - side * 0.5, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z], 0.55, PALETTE.creamShade, 10, PALETTE.charcoal);
}

// Proprotor blades: tapered, orange tips; a counterclockwise rotor (left) leads with -z, a clockwise one with +z.
const BLADE = Object.freeze({ ROOT: 0.55, ROOT_CHORD: 0.78, TIP_CHORD: 0.46, THICKNESS: 0.12 });
const BLADE_PROFILE = [[0, 0], [0.12, 0.6], [0.4, 0.5], [1, 0], [0.4, -0.3], [0.12, -0.35]];
function buildBlade(lead) {
  const builder = createMeshBuilder();
  const stations = [BLADE.ROOT, 1.6, ROTOR_RADIUS - 0.6, ROTOR_RADIUS - 0.55, ROTOR_RADIUS];
  const sections = stations.map((r) => {
    const share = (r - BLADE.ROOT) / (ROTOR_RADIUS - BLADE.ROOT);
    const chord = BLADE.ROOT_CHORD + (BLADE.TIP_CHORD - BLADE.ROOT_CHORD) * share;
    return profileSection(BLADE_PROFILE, [r, 0, lead * chord * 0.35], [0, 0, -lead], [0, 1, 0], chord, BLADE.THICKNESS);
  });
  builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

/** Rotor blur: a shallow cone of soft rings whose opacity follows the rotor speed (vertices at y = r). */
function createDiscGeometry(radius) {
  const geometry = new THREE.CircleGeometry(radius, 56);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) positions.setY(index, Math.hypot(positions.getX(index), positions.getZ(index)));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
function createDiscMaterial(opacity) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const distance = length(uv().sub(0.5)).mul(2);
  const band = smoothstep(float(0.08), float(0.16), distance).mul(float(1).sub(smoothstep(float(0.93), float(1), distance)));
  const tipRing = smoothstep(float(0.88), float(0.9), distance).mul(float(1).sub(smoothstep(float(0.9), float(0.94), distance)));
  material.colorNode = mix(color(0x3a3d46), color(0xd98a5c), tipRing.mul(0.45));
  material.opacityNode = band.mul(distance.mul(0.4).add(0.6)).mul(opacity).mul(tipRing.mul(0.25).add(1));
  return material;
}

// H tail: the horizontal stabilizer with its elevator on top of the tail cone, a fin and rudder at each tip.
const TAIL_PROFILE_CUT = [[0, 0], [0.07, 0.45], [0.3, 0.5], [0.7, 0.3], [0.7, 0], [0.7, -0.3], [0.3, -0.5], [0.07, -0.45]];
const TAIL_SURFACE_PROFILE = [[0.7, 0.29], [1, 0], [0.7, -0.29]];
const STAB = Object.freeze({ Y: 1.02, LEADING_EDGE: 7.1, CHORD: 1.55, HALF_SPAN: 3.0, THICKNESS: 0.11 });
const FIN = Object.freeze({ BOTTOM: 0.25, TOP: 3.45, ROOT_CHORD: 1.9, TIP_CHORD: 1.25, LEADING_EDGE: 7.2, SWEEP: 0.55, THICKNESS: 0.12 });
const finChord = (y) => FIN.ROOT_CHORD + (FIN.TIP_CHORD - FIN.ROOT_CHORD) * ((y - FIN.BOTTOM) / (FIN.TOP - FIN.BOTTOM));
const finLeadingEdge = (y) => FIN.LEADING_EDGE + FIN.SWEEP * ((y - FIN.BOTTOM) / (FIN.TOP - FIN.BOTTOM));

function buildTail(builder) {
  const stab = [-STAB.HALF_SPAN, -0.6, 0.6, STAB.HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB.Y, STAB.LEADING_EDGE], [0, 0, 1], [0, 1, 0], STAB.CHORD, STAB.THICKNESS));
  builder.loft(stab, (segment, edge) => (edge >= 5 ? PALETTE.creamShade : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  for (const side of [-1, 1]) {
    const fin = [FIN.BOTTOM, STAB.Y, 2.6, FIN.TOP].map((y) => profileSection(TAIL_PROFILE_CUT, [side * STAB.HALF_SPAN, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
    builder.loft(fin, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  }
}

/** The elevator (hinged on the stabilizer's rear spar), geometry relative to its hinge. */
function buildElevator() {
  const builder = createMeshBuilder();
  const sections = [-STAB.HALF_SPAN + 0.1, 0, STAB.HALF_SPAN - 0.1].map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB.Y, STAB.LEADING_EDGE], [0, 0, 1], [0, 1, 0], STAB.CHORD, STAB.THICKNESS));
  builder.loft(sections, () => PALETTE.cream, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hinge = [0, STAB.Y, STAB.LEADING_EDGE + 0.7 * STAB.CHORD];
  return { geometry: builder.toGeometry(hinge), hinge };
}

/** One rudder (hinged on the fin's rear spar, a straight hinge line), geometry relative to its hinge. */
function buildRudder(side) {
  const builder = createMeshBuilder();
  const hingeZ = (y) => finLeadingEdge(y) + 0.7 * finChord(y);
  const sections = [FIN.BOTTOM + 0.15, (FIN.BOTTOM + FIN.TOP) / 2, FIN.TOP - 0.1].map((y) => profileSection(TAIL_SURFACE_PROFILE, [side * STAB.HALF_SPAN, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const middle = (FIN.BOTTOM + FIN.TOP) / 2;
  const hinge = [side * STAB.HALF_SPAN, middle, hingeZ(middle)];
  return { geometry: builder.toGeometry(hinge), hinge };
}

// Gear: twin nose wheels folding forward into the nose, single mains folding aft into the sponsons.
const NOSE_GEAR = Object.freeze({ PIVOT: Object.freeze([0, -0.95, -5.6]), WHEEL: Object.freeze([0, -1.73, -5.4]), RADIUS: 0.42 });
const MAIN_GEAR = Object.freeze({ PIVOT_X: 1.72, PIVOT_Y: -0.78, PIVOT_Z: 0.2, WHEEL_X: 1.95, RADIUS: 0.42 });
function buildWheel(builder, centre, halfWidth) {
  buildTube(builder, [centre[0] - halfWidth, centre[1], centre[2]], [centre[0] + halfWidth, centre[1], centre[2]], NOSE_GEAR.RADIUS, PALETTE.charcoal, 10, PALETTE.creamShade);
}
function buildNoseGear() {
  const builder = createMeshBuilder();
  const pivot = NOSE_GEAR.PIVOT;
  const wheel = NOSE_GEAR.WHEEL;
  buildTube(builder, [0, 0, 0], [wheel[0] - pivot[0], wheel[1] - pivot[1], wheel[2] - pivot[2]], 0.08, PALETTE.creamShade, 6);
  for (const side of [-1, 1]) buildWheel(builder, [side * 0.26, wheel[1] - pivot[1], wheel[2] - pivot[2]], 0.12);
  return builder.toGeometry(null);
}
function buildMainGear(side) {
  const builder = createMeshBuilder();
  const wheelY = -2.15 + MAIN_GEAR.RADIUS;
  const offset = [side * (MAIN_GEAR.WHEEL_X - MAIN_GEAR.PIVOT_X), wheelY - MAIN_GEAR.PIVOT_Y, 0.45 - MAIN_GEAR.PIVOT_Z];
  buildTube(builder, [0, 0, 0], [offset[0] * 0.6, offset[1], offset[2]], 0.1, PALETTE.creamShade, 6);
  buildWheel(builder, offset, 0.16);
  return builder.toGeometry(null);
}

const EYE = Object.freeze([0, 0.62, -6.6]);
const GOVERNED_SPEED = (simProfile.rotor.rpm * Math.PI) / 30;
/** Displayed rotor spin (rad/s) at 100 % rpm: fast enough to read as turning, slow enough not to strobe. */
const ROTOR_DISPLAY_SPEED = 11;
const GEAR_SECONDS = simProfile.gear.transitSeconds;

/**
 * Builds the tiltrotor. update(visual, dt): the nacelles tilt to visual.craftState.nacelleAngle, the
 * proprotors turn with the rotor speed (visual.propSpeed, rad/s) and cone with the thrust lever, the
 * flaperons droop with visual.flaps and deflect with visual.aileron, the elevator and rudders follow
 * visual.elevator and visual.rudder, the gear folds with visual.gearDown, the nav lights run from
 * visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'tiltrotor';

  const sections = fuselageSections();
  const airframe = createMeshBuilder();
  buildFuselage(airframe, sections);
  buildSponsons(airframe);
  buildFairing(airframe);
  buildWing(airframe);
  buildTail(airframe);
  for (const side of [-1, 1]) buildPivotFairing(airframe, side);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  const glass = addSolid(root, buildGlass(sections), materials.canopy);
  glass.userData.hideInCockpit = true;

  // Flaperons, elevator and rudders on hinge pivots.
  const flaperons = [-1, 1].map((side) => {
    const part = buildFlaperon(side);
    const pivot = new THREE.Group();
    pivot.position.set(part.hinge[0], part.hinge[1], part.hinge[2]);
    addSolid(pivot, part.geometry, bodyMaterial);
    root.add(pivot);
    return pivot;
  });
  const elevatorPart = buildElevator();
  const elevator = new THREE.Group();
  elevator.position.set(elevatorPart.hinge[0], elevatorPart.hinge[1], elevatorPart.hinge[2]);
  addSolid(elevator, elevatorPart.geometry, bodyMaterial);
  root.add(elevator);
  const rudders = [-1, 1].map((side) => {
    const part = buildRudder(side);
    const pivot = new THREE.Group();
    pivot.position.set(part.hinge[0], part.hinge[1], part.hinge[2]);
    addSolid(pivot, part.geometry, bodyMaterial);
    root.add(pivot);
    return pivot;
  });

  // Nacelles: pivot (tilt about x) -> housing and spinner -> rotor mount (flapping) -> spinner (rotation) -> blades.
  const housingBuilder = createMeshBuilder();
  buildNacelle(housingBuilder);
  buildSpinner(housingBuilder);
  const housingGeometry = housingBuilder.toGeometry(null);
  const bladeGeometries = [buildBlade(1), buildBlade(-1)];
  const discGeometry = createDiscGeometry(ROTOR_RADIUS);
  const discOpacity = uniform(0);
  const discMaterial = createDiscMaterial(discOpacity);
  const rotation = [1, -1];
  const nacelles = [-1, 1].map((side, index) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z);
    root.add(pivot);
    addSolid(pivot, housingGeometry, bodyMaterial);
    const mount = new THREE.Group();
    mount.position.set(0, 0, -HUB_OFFSET);
    mount.rotation.x = -Math.PI / 2;
    pivot.add(mount);
    const spinner = new THREE.Group();
    mount.add(spinner);
    const bladePivots = [];
    for (let blade = 0; blade < 3; blade++) {
      const arm = new THREE.Group();
      arm.rotation.y = (blade * Math.PI * 2) / 3;
      const bladePivot = new THREE.Group();
      arm.add(bladePivot);
      addSolid(bladePivot, bladeGeometries[index], bodyMaterial);
      spinner.add(arm);
      bladePivots.push(bladePivot);
    }
    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.renderOrder = 2;
    disc.position.y = 0.02;
    mount.add(disc);
    return { pivot, mount, spinner, bladePivots, disc, rotation: rotation[index], angle: index * 0.9 };
  });

  // Gear legs on their fold pivots.
  const noseGear = new THREE.Group();
  noseGear.position.set(NOSE_GEAR.PIVOT[0], NOSE_GEAR.PIVOT[1], NOSE_GEAR.PIVOT[2]);
  addSolid(noseGear, buildNoseGear(), bodyMaterial);
  root.add(noseGear);
  const mainGear = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * MAIN_GEAR.PIVOT_X, MAIN_GEAR.PIVOT_Y, MAIN_GEAR.PIVOT_Z);
    addSolid(pivot, buildMainGear(side), bodyMaterial);
    root.add(pivot);
    return pivot;
  });

  const navLights = createNavLights(root, {
    red: { position: [-(NACELLE_PIVOT.X + 0.78), NACELLE_PIVOT.Y, NACELLE_PIVOT.Z], glow: [-(NACELLE_PIVOT.X + 0.88), NACELLE_PIVOT.Y, NACELLE_PIVOT.Z] },
    green: { position: [NACELLE_PIVOT.X + 0.78, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z], glow: [NACELLE_PIVOT.X + 0.88, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z] },
    strobe: { position: [0, STAB.Y + 0.12, STAB.LEADING_EDGE + STAB.CHORD], glow: [0, STAB.Y + 0.22, STAB.LEADING_EDGE + STAB.CHORD + 0.05] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let rotorShare = 1;
  let coning = simProfile.rotor.coning * DEG;
  let gear = 1;
  let nacelleAngle = Math.PI / 2;

  return {
    root,
    wingtips: [new THREE.Vector3(-NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z), new THREE.Vector3(NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z)],
    eyeAnchor,
    /** Local attachment points: the tail (trails) and the nacelle pivots. */
    anchors: {
      tail: new THREE.Vector3(0, 0.85, 7.9),
      nacelleLeft: new THREE.Vector3(-NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z),
      nacelleRight: new THREE.Vector3(NACELLE_PIVOT.X, NACELLE_PIVOT.Y, NACELLE_PIVOT.Z),
    },

    update(visual, dt) {
      const step = dt > 0 ? dt : 0;
      const craftState = visual.craftState ?? null;
      const angleDegrees = craftState && Number.isFinite(craftState.nacelleAngle) ? craftState.nacelleAngle : NACELLE.HOVER;
      nacelleAngle = clamp(angleDegrees, NACELLE.MIN, NACELLE.MAX) * DEG;
      const throttle = Number.isFinite(visual.throttle) ? clamp(visual.throttle, 0, 1) : 0.5;
      const targetShare = Number.isFinite(visual.propSpeed) ? clamp(visual.propSpeed / GOVERNED_SPEED, 0, 1.3) : visual.engineOn === false ? 0 : 1;
      rotorShare += (targetShare - rotorShare) * (1 - Math.exp(-step * 6));
      // Coning: blades droop at rest, rise with the thrust lever once the rotor carries load (less in airplane mode).
      const flying = smooth01((rotorShare - 0.35) / 0.55);
      const lift = Math.sin(nacelleAngle);
      const targetConing = (-1.5 + flying * (1.5 + 4 * throttle * lift)) * DEG;
      coning += (targetConing - coning) * (1 - Math.exp(-step * 5));
      const disc = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1) * simProfile.rotor.cyclic * DEG * smooth01((angleDegrees - 10) / 70);
      for (let index = 0; index < nacelles.length; index++) {
        const nacelle = nacelles[index];
        nacelle.pivot.rotation.x = nacelleAngle;
        nacelle.mount.rotation.x = -Math.PI / 2 + disc;
        nacelle.angle = (nacelle.angle + nacelle.rotation * rotorShare * ROTOR_DISPLAY_SPEED * step) % (Math.PI * 2);
        if (!Number.isFinite(nacelle.angle)) nacelle.angle = 0;
        nacelle.spinner.rotation.y = nacelle.angle;
        for (const bladePivot of nacelle.bladePivots) bladePivot.rotation.z = coning;
        nacelle.disc.visible = rotorShare > 0.03;
        nacelle.disc.scale.y = Math.tan(Math.max(coning, 0));
      }
      discOpacity.value = rotorShare > 0.03 ? 0.05 + 0.17 * smooth01((rotorShare - 0.1) / 0.8) : 0;

      const flaps = Number.isFinite(visual.flaps) ? clamp(visual.flaps, 0, 1) : 0;
      const roll = Number.isFinite(visual.aileron) ? clamp(visual.aileron, -1, 1) : 0;
      const droop = flaps * simProfile.wing.droop * DEG;
      flaperons[0].rotation.x = droop + roll * simProfile.wing.flaperon * DEG;
      flaperons[1].rotation.x = droop - roll * simProfile.wing.flaperon * DEG;
      elevator.rotation.x = -(Number.isFinite(visual.elevator) ? clamp(visual.elevator, -1, 1) : 0) * simProfile.tail.horizontal.elevator * DEG;
      const rudder = (Number.isFinite(visual.rudder) ? clamp(visual.rudder, -1, 1) : 0) * simProfile.tail.vertical.rudder * DEG;
      for (const pivot of rudders) pivot.rotation.y = rudder;

      const gearTarget = visual.gearDown !== false ? 1 : 0;
      gear = gearTarget > gear ? Math.min(gearTarget, gear + step / GEAR_SECONDS) : Math.max(gearTarget, gear - step / GEAR_SECONDS);
      const fold = 1 - gear;
      noseGear.rotation.x = -fold * 1.75;
      for (const pivot of mainGear) pivot.rotation.x = fold * 1.6;
      noseGear.visible = gear > 0.02;
      for (const pivot of mainGear) pivot.visible = gear > 0.02;

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// COCKPIT: the side-by-side flight deck with its glareshield panel
// ============================================================================================
const cockpit = Object.freeze({
  style: 'cabin',
  width: 2.1,
  sill: -0.32,
  floor: -1.05,
  front: -1.2,
  back: 1.1,
  roof: 0.5,
  stick: true,
  panel: Object.freeze({
    width: 1.15,
    center: Object.freeze([0, -0.42, -0.92]),
    layout: Object.freeze([
      Object.freeze(['airspeed', 'attitude', 'altitude', 'nacelle', 'rotorRpm']),
      Object.freeze(['radarAlt', 'heading', 'vsi', 'torque', 'throttle']),
    ]),
  }),
  frameColor: 0x2c2f38,
});

// ============================================================================================
// ABILITY: the auto-nacelle schedule on / off (the flight control computer's, at every assist level)
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Auto-nacelle',
  initialState: () => ({
    autoNacelle: true,
    nacelleAngle: NACELLE.HOVER,
    nacelleTarget: NACELLE.HOVER,
    nacelleCommand: NACELLE.HOVER,
    mode: 'hover',
    corridor: { min: NACELLE.HOVER, max: NACELLE.MAX, state: 'ok' },
    proprotorRpm: simProfile.rotor.rpm,
  }),
  run(api) {
    const craftState = api.craftState;
    craftState.autoNacelle = !craftState.autoNacelle;
    api.notify(craftState.autoNacelle
      ? 'Auto-nacelle on: the nacelles follow your selection inside the conversion corridor.'
      : 'Auto-nacelle off: the nacelles go straight to your selection. Watch the corridor.', craftState.autoNacelle ? 'info' : 'warning');
    return true;
  },
});

// ============================================================================================
// PLACEMENT after a craft switch (contract h.4): hover when slow or low, else airplane mode
// ============================================================================================
const SITUATE = Object.freeze({ HOVER_BELOW_SPEED: 40, HOVER_BELOW_AGL: 60, MIN_AIRPLANE_SPEED: 80, MAX_AIRPLANE_SPEED: 125, HOVER_LEVER: 0.5, CRUISE_LEVER: 0.5 });
const situateCorridor = { min: 0, max: NACELLE.MAX };

function situate(situation) {
  if (situation.wasOnGround && !situation.wasOnWater) {
    return { mode: 'ground', flatSpot: true, craftState: { nacelleAngle: NACELLE.HOVER, nacelleTarget: NACELLE.HOVER } };
  }
  if (situation.airspeed < SITUATE.HOVER_BELOW_SPEED || situation.agl < SITUATE.HOVER_BELOW_AGL) {
    return { mode: 'hover', throttle: SITUATE.HOVER_LEVER, craftState: { nacelleAngle: NACELLE.HOVER, nacelleTarget: NACELLE.HOVER } };
  }
  const speed = clamp(situation.airspeed, SITUATE.MIN_AIRPLANE_SPEED, SITUATE.MAX_AIRPLANE_SPEED);
  conversionCorridor(speed, 1.225 * Math.exp(-Math.max(situation.position.y, 0) / 8500), CORRIDOR, situateCorridor);
  const angle = scheduledNacelle(NACELLE.MIN, situateCorridor, CORRIDOR.margin);
  return { mode: 'air', speed, throttle: SITUATE.CRUISE_LEVER, craftState: { nacelleAngle: angle, nacelleTarget: NACELLE.MIN } };
}

// ============================================================================================
// COPILOT: nacelle angle, airplane / helicopter mode, auto-nacelle
// ============================================================================================
function nacelleReply(api, angle, words) {
  const craftState = api.craftState;
  api.setCraftState('nacelleTarget', angle);
  const corridor = craftState.corridor;
  if (craftState.autoNacelle && corridor && (angle < corridor.min || angle > corridor.max)) {
    return `${words} Auto-nacelle holds them inside the corridor until the airspeed allows.`;
  }
  if (!craftState.autoNacelle && corridor && angle < corridor.min) return `${words} Careful: that is below the corridor at this airspeed, the wing will stall.`;
  if (!craftState.autoNacelle && corridor && angle > corridor.max) return `${words} Careful: that is above the corridor at this airspeed, expect rotor overspeed.`;
  return words;
}

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'nacelle',
      phrases: Object.freeze(['\\bnacelles? (?:to |at )?(\\d{1,3})(?: degrees?)?\\b', '\\btilt (?:the )?nacelles? (?:to )?(\\d{1,3})\\b']),
      run(api, value) {
        const angle = snapNacelle(Number(value));
        if (!Number.isFinite(Number(value))) return 'Say an angle from 0 to 97 degrees.';
        return nacelleReply(api, angle, `Nacelles to ${Math.round(angle)} degrees.`);
      },
    }),
    Object.freeze({
      id: 'airplaneMode',
      phrases: Object.freeze(['\\b(?:airplane|aeroplane|plane|cruise) mode\\b', '\\bconvert to (?:airplane|aeroplane|plane|cruise)\\b']),
      run(api) {
        return nacelleReply(api, NACELLE.MIN, 'Converting to airplane mode.');
      },
    }),
    Object.freeze({
      id: 'hoverMode',
      phrases: Object.freeze(['\\b(?:helicopter|hover|vtol) mode\\b', '\\bconvert to (?:helicopter|hover)\\b']),
      run(api) {
        return nacelleReply(api, NACELLE.HOVER, 'Converting to helicopter mode.');
      },
    }),
    Object.freeze({
      id: 'autoNacelle',
      phrases: Object.freeze(['\\bauto[- ]?nacelles? (on|off)\\b']),
      run(api, value) {
        const wanted = String(value).toLowerCase() === 'on';
        if (api.craftState.autoNacelle !== wanted) api.runAbility('craftAbility');
        return wanted ? 'Auto-nacelle on.' : 'Auto-nacelle off. The corridor is yours.';
      },
    }),
  ]),
  status(craftState, telemetry) {
    const angle = Math.round(Number.isFinite(craftState.nacelleAngle) ? craftState.nacelleAngle : NACELLE.HOVER);
    const mode = nacelleMode(angle);
    const target = Math.round(Number.isFinite(craftState.nacelleTarget) ? craftState.nacelleTarget : angle);
    const corridor = craftState.corridor ?? { min: 0, max: NACELLE.MAX, state: 'ok' };
    const modeText = mode === 'hover' ? 'helicopter mode' : mode === 'airplane' ? 'airplane mode' : `converting toward ${target} degrees`;
    const corridorText = corridor.state === 'wingStall' ? 'below the corridor: wing stall' : corridor.state === 'overspeed' ? 'above the corridor: rotor overspeed' : 'inside the corridor';
    const speed = Math.round(Number.isFinite(telemetry.airspeed) ? telemetry.airspeed : 0);
    return `Nacelles at ${angle} degrees, ${modeText}, ${corridorText} (${Math.round(corridor.min)} to ${Math.round(corridor.max)} degrees at ${speed} metres per second). Auto-nacelle ${craftState.autoNacelle ? 'on' : 'off'}, proprotors at ${craftState.proprotorRpm ?? simProfile.rotor.rpm} rpm.`;
  },
});

export default Object.freeze({
  id: 'tiltrotor',
  name: 'Tiltrotor',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: the throttle axis (W / S, the TWCS lever) is the thrust control lever (the
   * proprotors' collective); the stick is cyclic plus differential collective in the hover and the
   * flaperons and elevator in airplane mode; the pedals are differential cyclic and the rudders; the
   * HOTAS antenna sets the nacelle angle (0 airplane .. full the 97 degree stop, detents at 0, 60, 90);
   * the flap buttons step the nacelles a detent (flaps down: up toward the hover; flaps up: forward).
   */
  inputProfile: Object.freeze({ throttle: 'collective', antenna: 'nacelle', toeBrakes: 'wheels', flapNotches: 0 }),
  /**
   * Per-craft default bindings: Page Up / Page Down step the nacelles too (beside F / Shift+F). The
   * HOTAS keeps its defaults: the TWCS antenna is the nacelle lever and the T.16000M flap buttons
   * (5 and 6) step the detents; the gamepad's D-pad up / down step them.
   */
  bindings: Object.freeze({
    keyboard: Object.freeze({
      actions: Object.freeze({
        flapsDown: Object.freeze([Object.freeze({ type: 'key', code: 'KeyF', shift: false }), Object.freeze({ type: 'key', code: 'PageUp' })]),
        flapsUp: Object.freeze([Object.freeze({ type: 'key', code: 'KeyF', shift: true }), Object.freeze({ type: 'key', code: 'PageDown' })]),
      }),
    }),
  }),
  audioProfile: Object.freeze({
    engine: 'proprotor', blades: simProfile.rotor.blades, rotorRpm: simProfile.rotor.rpm, turbineHz: 4300,
    touchdown: 'wheels', stallHorn: true, stallHornStyle: 'beep', interiorCutoff: 850, airflowSpeed: 120,
  }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 30, height: 7.5, lookAhead: 16, speedRange: Object.freeze({ CRUISE: 90, MAX: 130, TOP: 155 }) }),
    // A camera on the wing fairing looking out along the right wing at the nacelle.
    wing: Object.freeze({ position: Object.freeze([0.9, 2.9, 2.8]), target: Object.freeze([6.8, 2.2, -1.6]) }),
    fpv: null,
    cockpit,
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'nacelle', 'rotorRpm', 'torque', 'radarAlt', 'throttle']),
  abilities: Object.freeze({ craftAbility }),
  capabilities: Object.freeze({ engine: true, chute: false }),
  spawn: Object.freeze({ cruise: 110, cruiseThrottle: 0.5, hover: true, relaunch: 'airstart', canStartOnGround: true }),
  limits: Object.freeze({ vne: 154, gLimit: 3, crashSinkRate: 3.5, bodyStrikeSpeed: 4, floats: false, ceiling: 7600 }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'tiltrotorConversions', label: 'Tiltrotor conversions', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'tiltrotorFastestConversion', label: 'Fastest conversion to airplane mode', unit: 'seconds', op: 'min' }),
    ]),
  }),
});
