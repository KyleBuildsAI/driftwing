// HELICOPTER: a light utility turbine helicopter (JetRanger class), built from code in the v1 glider's
// style (flat-shaded, vertex-coloured lofts in the v1 palette). Bubble cabin with chin windows, skids
// on arched cross tubes, engine and transmission deck with the turbine exhaust, tail boom with a
// stabilizer and fins, a two-blade teetering main rotor with its blur disc and coning, and a two-blade
// tail rotor. The rotor turns with the rotor rpm and its disc tilts with the cyclic.
// CLASSIC flies it with the hover-capable arcade rules (src/flight/ArcadeModel.js, arcadeProfile.hover:
// forgiving, never tumbles); the SIM profile describes the real thing for SimHelicopter
// (src/flight/SimHelicopter.js), measured by tools/lab/helicopter.mjs.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, ellipseRing, getCraftMaterials, addSolid, createPropDisc, createNavLights,
  disposeCraftMesh, smooth01,
} from './kit.js';

const { uniform, color, float, uv, length, smoothstep, mix } = TSL;

// ============================================================================================
// CLASSIC: the hover-capable arcade rules (ArcadeModel's hover extension).
// ============================================================================================
const arcadeProfile = Object.freeze({
  // m/s. The dial shows the arcade envelope; the hover model reads hover.MAX_FORWARD_SPEED.
  SPEED: Object.freeze({ MIN: 0, STALL: 0, CRUISE: 45, MAX: 62, BOOST_MAX: 74 }),
  GRAVITY: 9.81,
  BOOST_DURATION: 2.4,
  BOOST_COOLDOWN: 6,
  AUTOPILOT: Object.freeze({
    // Throttle 0.5 holds the height: spawns and respawns hover there.
    CRUISE_THROTTLE: 0.5,
    MIN_ALTITUDE: 60,
    CLEARANCE: 80,
    CRUISE_SPEED: 45,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    LOOKAHEAD_SECONDS: Object.freeze([0, 2, 4, 7, 11]),
  }),
  hover: Object.freeze({
    MAX_FORWARD_SPEED: 62,
    MAX_REVERSE_SPEED: 8,
    MAX_SIDE_SPEED: 7,
    ACCELERATION: 5.5,
    BRAKING: 7,
    CLIMB_RATE: 8,
    DESCENT_RATE: 6,
    VERTICAL_RESPONSE: 1.6,
    THROTTLE_DEADBAND: 0.04,
    THROTTLE_RATE: 0.6,
    YAW_RATE: 55 * DEG,
    TURN_RATE: 32 * DEG,
    TURN_REFERENCE_SPEED: 16,
    MAX_BANK: 32 * DEG,
    MAX_PITCH: 16 * DEG,
    CRUISE_PITCH: 7 * DEG,
    ATTITUDE_RESPONSE: 3.5,
    /** Hovering floor above the ground or water (m, mesh origin) and the cushion band above it. */
    MIN_AGL: 5,
    CUSHION_HEIGHT: 22,
    /** Below this groundspeed a centred stick lets the helicopter settle into a hover (m/s). */
    SETTLE_SPEED: 8,
    ROTOR_SPEED: (394 * Math.PI) / 30,
    /** Disc tilt shown for full acceleration / bank commands (the mesh reads it through visual). */
    DISC_TILT: 0.8,
  }),
});

// ============================================================================================
// SIM: SimHelicopter parameters. Body axes relative to the mesh origin (x right, y up, z aft; m);
// angles in degrees. Targets are what tools/lab/helicopter.mjs measures.
// ============================================================================================
const simProfile = Object.freeze({
  model: 'helicopter',
  targets: Object.freeze({
    stallSpeed: 0,
    hoverCollective: 0.5, // lever share for an out-of-ground-effect hover at sea level
    hoverTorque: 0.8, // share of rated torque in that hover
    verticalClimb: 5, // m/s, full power, no airspeed
    maxClimb: 7, // m/s at the best climb speed
    translationalLift: 7.8, // m/s = 28 km/h, where translational lift sets in
    vne: 69.4, // m/s = 250 km/h
    autorotationDescent: 8, // m/s at the best autorotation speed
  }),
  mass: Object.freeze({ empty: 900, pilot: 90, fuel: 160, payload: 100 }), // 1250 kg
  // kg m^2 about body x (pitch), y (yaw) and z (roll).
  inertia: Object.freeze({ pitch: 2600, yaw: 2200, roll: 1100 }),
  centerOfMass: Object.freeze([0, 0, 0.1]),
  rotor: Object.freeze({
    radius: 5.08,
    blades: 2,
    chord: 0.33,
    liftSlope: 5.7,
    profileDrag: 0.011,
    rpm: 394,
    inertia: 700, // kg m^2: about 600 kJ stored at 100 %
    hub: Object.freeze([0, 1.62, 0.1]),
    shaftTilt: 4,
    collectivePitch: Object.freeze([-0.5, 15.5]), // blade pitch at 3/4 radius over the lever's travel
    cyclic: Object.freeze({ longitudinal: 11, lateral: 8, trim: 0.3 }),
    flapLag: 0.08, // s: the disc follows the cyclic this fast
    flapDamping: 0.078, // s: disc tilt per body rate (rotor damping)
    flapback: 0.7, // share of the theoretical blowback with airspeed
    hubStiffness: 8000, // N m per rad of disc tilt (effective hinge offset)
    inducedPowerFactor: 1.15,
    coning: 3.5, // degrees at 1 g
    rotation: 'counterclockwise-from-above',
  }),
  tailRotor: Object.freeze({
    position: Object.freeze([-0.28, 0.62, 6.25]),
    radius: 0.82,
    blades: 2,
    ratio: 6.1,
    thrustNeutral: 560, // N at centred pedals, governed rpm, sea level
    thrustRange: 1000, // N per full pedal (left pedal adds thrust)
    inflowDamping: 120, // N per m/s of tail motion along the thrust line
    profilePowerKw: 3,
  }),
  engine: Object.freeze({
    kind: 'turboshaft',
    powerKw: 236, // takeoff rating, also the transmission limit
    spoolSeconds: 0.45,
    startSeconds: 6,
    rundownSeconds: 4,
    governorGain: 3,
    governorIntegral: 2.5,
    densityLapse: 0.8,
    accessoryKw: 6,
  }),
  fuselage: Object.freeze({
    // Flat-plate drag areas (m^2) broadside, from above and head-on.
    dragAreas: Object.freeze([4.2, 5, 0.85]),
    dragCenter: Object.freeze([0, -0.1, 0.4]),
    // Top area times drag coefficient under the rotor wash (hover download).
    download: 3,
  }),
  stabilizers: Object.freeze({
    horizontal: Object.freeze({ position: Object.freeze([0, 0.38, 4.6]), area: 1, aspectRatio: 4.2, incidence: -1 }),
    // Cambered to push the tail with the tail rotor once there is airspeed (unloads it in cruise).
    vertical: Object.freeze({ position: Object.freeze([0, 0.8, 6.1]), area: 0.8, aspectRatio: 1.4, offset: 4 }),
  }),
  // Vortex ring state: descent rate in hover-induced velocities (start, full, fade, end), the edgewise
  // ratio that clears it, the thrust lost and the roughness (share of the weight).
  vortexRing: Object.freeze({ start: 0.25, full: 0.6, fade: 1.2, end: 1.75, clearSpeed: 1.1, thrustLoss: 0.3, roughness: 0.06 }),
  // Retreating blade stall: onset advance ratio at the reference blade loading (CT / sigma), its width,
  // how much a heavier loading brings it forward, and its effects.
  bladeStall: Object.freeze({ onsetAdvance: 0.29, width: 0.05, referenceLoading: 0.07, loadingSensitivity: 1.2, thrustLoss: 0.12, pitchMoment: 0.04, rollMoment: 0.05 }),
  contacts: Object.freeze([
    Object.freeze({ id: 'leftSkidFront', kind: 'skid', gear: true, position: Object.freeze([-1.12, -1.52, -1.3]), spring: 45000, damping: 5000, friction: 0.45 }),
    Object.freeze({ id: 'leftSkidRear', kind: 'skid', gear: true, position: Object.freeze([-1.12, -1.52, 1.1]), spring: 45000, damping: 5000, friction: 0.45 }),
    Object.freeze({ id: 'rightSkidFront', kind: 'skid', gear: true, position: Object.freeze([1.12, -1.52, -1.3]), spring: 45000, damping: 5000, friction: 0.45 }),
    Object.freeze({ id: 'rightSkidRear', kind: 'skid', gear: true, position: Object.freeze([1.12, -1.52, 1.1]), spring: 45000, damping: 5000, friction: 0.45 }),
    Object.freeze({ id: 'tailStinger', kind: 'body', gear: false, position: Object.freeze([0, -0.3, 6.45]) }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, -0.45, -2.15]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -0.86, -0.4]) }),
    Object.freeze({ id: 'tailBoom', kind: 'body', gear: false, position: Object.freeze([0, 0.2, 3.6]) }),
    Object.freeze({ id: 'stabilizerLeft', kind: 'body', gear: false, position: Object.freeze([-1.08, 0.38, 4.6]) }),
    Object.freeze({ id: 'stabilizerRight', kind: 'body', gear: false, position: Object.freeze([1.08, 0.38, 4.6]) }),
    Object.freeze({ id: 'cabinRoof', kind: 'body', gear: false, position: Object.freeze([0, 0.9, -1]) }),
    Object.freeze({ id: 'mast', kind: 'body', gear: false, position: Object.freeze([0, 1.7, 0.1]) }),
    Object.freeze({ id: 'cabinLeft', kind: 'body', gear: false, position: Object.freeze([-0.76, 0, -0.6]) }),
    Object.freeze({ id: 'cabinRight', kind: 'body', gear: false, position: Object.freeze([0.76, 0, -0.6]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin near the centre of mass)
// ============================================================================================
// Cabin stations: [z, centre y, half width, half height]; ten-sided rings read as a rounded bubble.
const CABIN = [
  [-2.2, -0.3, 0.16, 0.18],
  [-2.0, -0.18, 0.52, 0.56],
  [-1.6, -0.05, 0.68, 0.78],
  [-1.0, 0.02, 0.74, 0.86],
  [-0.35, 0.03, 0.74, 0.86],
  [0.4, 0.03, 0.72, 0.84],
  [1.1, 0.06, 0.62, 0.74],
  [1.7, 0.18, 0.4, 0.5],
  [2.05, 0.3, 0.22, 0.26],
];
const CABIN_SIDES = 10;
// Faces of the ten-sided loft (edge e runs from corner e to e + 1, corners at 18 + 36 e degrees):
// 0 upper right, 1 roof right, 2 roof left, 3 upper left, 4 left side, 5 lower left, 6 belly left,
// 7 belly right, 8 lower right, 9 right side.
const FACE = Object.freeze({ UPPER_RIGHT: 0, ROOF_RIGHT: 1, ROOF_LEFT: 2, UPPER_LEFT: 3, LEFT: 4, LOWER_LEFT: 5, BELLY_LEFT: 6, BELLY_RIGHT: 7, LOWER_RIGHT: 8, RIGHT: 9 });
const UPPER_FACES = [FACE.UPPER_RIGHT, FACE.ROOF_RIGHT, FACE.ROOF_LEFT, FACE.UPPER_LEFT];
/** Glass: [segment, face]. The bubble (nose, windshield, roof panels), chin windows and door windows. */
const GLASS = Object.freeze([
  ...UPPER_FACES.map((face) => [0, face]), [0, FACE.LEFT], [0, FACE.RIGHT],
  ...UPPER_FACES.map((face) => [1, face]), [1, FACE.LEFT], [1, FACE.RIGHT], [1, FACE.LOWER_LEFT], [1, FACE.LOWER_RIGHT],
  ...UPPER_FACES.map((face) => [2, face]), [2, FACE.LEFT], [2, FACE.RIGHT],
  [3, FACE.UPPER_RIGHT], [3, FACE.UPPER_LEFT], [3, FACE.LEFT], [3, FACE.RIGHT],
  [4, FACE.UPPER_RIGHT], [4, FACE.UPPER_LEFT],
]);

function cabinSections() {
  return CABIN.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, CABIN_SIDES, 18));
}

function buildCabin(builder, sections) {
  const lower = new Set([FACE.LOWER_LEFT, FACE.BELLY_LEFT, FACE.BELLY_RIGHT, FACE.LOWER_RIGHT]);
  builder.loft(sections, (segment, face) => {
    if (lower.has(face)) return segment >= 5 ? PALETTE.creamShade : PALETTE.charcoal;
    // An orange band down each flank behind the doors, and the engine-bay cowl stripe.
    if ((face === FACE.LEFT || face === FACE.RIGHT) && segment >= 4 && segment <= 6) return PALETTE.orange;
    if (segment === 0) return PALETTE.orange;
    return PALETTE.cream;
  }, { capStart: PALETTE.orange, capEnd: PALETTE.cream });
}

/** Glass panes: each glass face inset from its frame and lifted just off the skin. */
function buildGlass(sections) {
  const builder = createMeshBuilder();
  const inset = 0.05;
  const lift = 0.012;
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const [segment, face] of GLASS) {
    const next = (face + 1) % CABIN_SIDES;
    const corners = [sections[segment][face], sections[segment][next], sections[segment + 1][next], sections[segment + 1][face]];
    const centre = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / 4);
    edgeA.set(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]);
    edgeB.set(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1], corners[3][2] - corners[0][2]);
    normal.crossVectors(edgeA, edgeB);
    if (normal.lengthSq() < 1e-10) {
      // The nose cap's first ring is tiny: fall back to the direction away from the cabin axis.
      normal.set(centre[0], centre[1] - CABIN[segment][1], 0);
    }
    normal.normalize();
    const axisCentre = [0, (CABIN[segment][1] + CABIN[segment + 1][1]) / 2, centre[2]];
    if ((centre[0] - axisCentre[0]) * normal.x + (centre[1] - axisCentre[1]) * normal.y + (segment === 0 ? -normal.z : 0) < 0) normal.negate();
    const pane = corners.map((corner) => [0, 1, 2].map((axis) => corner[axis] + (centre[axis] - corner[axis]) * inset + normal.getComponent(axis) * lift));
    const inside = [centre[0] - normal.x, centre[1] - normal.y, centre[2] - normal.z];
    builder.quad(pane[0], pane[1], pane[2], pane[3], PALETTE.charcoal, inside);
  }
  return builder.toGeometry(null);
}

// Engine and transmission deck on the cabin roof, with the turbine exhaust stack at its tail.
const DECK = [
  [-0.6, 0.86, 0.26, 0.08],
  [-0.2, 0.98, 0.42, 0.18],
  [0.5, 1.02, 0.44, 0.22],
  [1.25, 0.98, 0.4, 0.2],
  [1.85, 0.72, 0.2, 0.12],
];
function buildDeck(builder) {
  const sections = DECK.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, 8, 22.5));
  builder.loft(sections, (segment, face) => (face === 1 || face === 2 ? (segment === 2 ? PALETTE.orange : PALETTE.cream) : PALETTE.creamShade), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
}

/** A straight faceted tube from a to b (octagonal or square section). */
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

/** A tube through a list of points (each segment a straight tube; joints overlap). */
function buildPolyTube(builder, points, radius, tint, sides = 6) {
  for (let index = 0; index < points.length - 1; index++) buildTube(builder, points[index], points[index + 1], radius, tint, sides);
}

function buildExhaust(builder) {
  // The turbine exhaust: a short stack leaning aft out of the deck, charcoal inside a cream collar.
  buildTube(builder, [0, 1.05, 1.5], [0, 1.34, 1.74], 0.14, PALETTE.creamShade, 8, PALETTE.charcoal);
  buildTube(builder, [0, 1.3, 1.71], [0, 1.37, 1.77], 0.155, PALETTE.orange, 8, PALETTE.charcoal);
}

// Tail boom: a tapering tube from the cabin to the fins.
const BOOM = [
  [1.6, 0.3, 0.26, 0.3],
  [3.0, 0.38, 0.19, 0.21],
  [4.8, 0.44, 0.14, 0.15],
  [6.4, 0.5, 0.09, 0.1],
];
function buildBoom(builder) {
  const sections = BOOM.map(([z, centreY, halfWidth, halfHeight]) => ellipseRing(z, centreY, halfWidth, halfHeight, 8, 22.5));
  builder.loft(sections, (segment, face) => (segment === 2 && (face === 3 || face === 0 || face === 7 || face === 4) ? PALETTE.orange : face >= 4 && face <= 6 ? PALETTE.creamShade : PALETTE.cream), { capEnd: PALETTE.cream });
}

const TAIL_PROFILE = [[0, 0], [0.1, 0.5], [0.35, 0.55], [0.7, 0.3], [1, 0], [0.7, -0.3], [0.35, -0.55], [0.1, -0.5]];
const STAB = Object.freeze({ Z: 4.6, Y: 0.38, HALF_SPAN: 1.05, CHORD: 0.5, THICKNESS: 0.1 });
function buildStabilizer(builder) {
  const stations = [-STAB.HALF_SPAN, -0.2, 0.2, STAB.HALF_SPAN];
  const sections = stations.map((x) => profileSection(TAIL_PROFILE, [x, STAB.Y, STAB.Z - STAB.CHORD / 2], [0, 0, 1], [0, 1, 0], STAB.CHORD, STAB.THICKNESS));
  builder.loft(sections, () => PALETTE.cream, { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  // Endplates: small vertical fins at the stabilizer tips.
  for (const side of [-1, 1]) {
    const heights = [STAB.Y - 0.16, STAB.Y + 0.2];
    const plates = heights.map((y) => profileSection(TAIL_PROFILE, [side * (STAB.HALF_SPAN + 0.02), y, STAB.Z - 0.22], [0, 0, 1], [1, 0, 0], 0.42, 0.12));
    builder.loft(plates, () => PALETTE.orange, { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  }
}

const FIN = Object.freeze({ Z_ROOT: 5.85, CHORD_ROOT: 0.62, CHORD_TIP: 0.38, SWEEP: 0.42, TOP: 1.5, BOTTOM: -0.22, THICKNESS: 0.12 });
function buildFins(builder) {
  const upper = [0.46, 1.0, FIN.TOP].map((y) => {
    const share = (y - 0.46) / (FIN.TOP - 0.46);
    const chord = FIN.CHORD_ROOT + (FIN.CHORD_TIP - FIN.CHORD_ROOT) * share;
    return profileSection(TAIL_PROFILE, [0, y, FIN.Z_ROOT + FIN.SWEEP * share], [0, 0, 1], [1, 0, 0], chord, FIN.THICKNESS);
  });
  builder.loft(upper, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  const lower = [0.46, FIN.BOTTOM].map((y) => {
    const share = (0.46 - y) / (0.46 - FIN.BOTTOM);
    return profileSection(TAIL_PROFILE, [0, y, FIN.Z_ROOT + 0.15 * share], [0, 0, 1], [1, 0, 0], FIN.CHORD_ROOT - 0.2 * share, FIN.THICKNESS);
  });
  builder.loft(lower, () => PALETTE.cream, { capEnd: PALETTE.cream });
  // Tail stinger protecting the tail rotor.
  buildTube(builder, [0, FIN.BOTTOM + 0.04, FIN.Z_ROOT + 0.35], [0, -0.3, 6.45], 0.03, PALETTE.charcoal, 5);
}

// Skids: two tubes on arched cross tubes, upturned at the front.
const SKID = Object.freeze({ X: 1.12, Y: -1.52, FRONT: -1.55, BACK: 1.3, RADIUS: 0.045 });
function buildSkids(builder) {
  for (const side of [-1, 1]) {
    const x = side * SKID.X;
    buildPolyTube(builder, [[x, SKID.Y + 0.28, SKID.FRONT - 0.32], [x, SKID.Y + 0.1, SKID.FRONT - 0.12], [x, SKID.Y, SKID.FRONT + 0.1], [x, SKID.Y, SKID.BACK]], SKID.RADIUS, PALETTE.charcoal, 6);
    for (const z of [-0.85, 0.72]) {
      // Arched cross tube from the belly to the skid.
      buildPolyTube(builder, [[side * 0.42, -0.72, z], [side * 0.82, -0.98, z], [side * 1.06, -1.3, z], [x, SKID.Y + 0.02, z]], 0.04, PALETTE.charcoal, 6);
    }
  }
  for (const z of [-0.85, 0.72]) buildTube(builder, [-0.45, -0.72, z], [0.45, -0.72, z], 0.04, PALETTE.charcoal, 6);
}

// Main rotor: hub at the mast top, two blades (airfoil loft), orange tips.
const HUB = Object.freeze([0, 1.62, 0.1]);
const ROTOR_RADIUS = simProfile.rotor.radius;
const BLADE = Object.freeze({ ROOT: 0.34, CHORD: 0.33, THICKNESS: 0.12 });
const BLADE_PROFILE = [[0, 0], [0.12, 0.6], [0.4, 0.5], [1, 0], [0.4, -0.3], [0.12, -0.35]];
function buildBlade() {
  const builder = createMeshBuilder();
  // Leading edge toward -z (a counterclockwise rotor moves the +x blade that way).
  const stations = [BLADE.ROOT, 1.2, ROTOR_RADIUS - 0.55, ROTOR_RADIUS - 0.5, ROTOR_RADIUS];
  const sections = stations.map((r, index) => profileSection(BLADE_PROFILE, [r, 0, -BLADE.CHORD / 2], [0, 0, 1], [0, 1, 0], index === 0 ? BLADE.CHORD * 0.8 : BLADE.CHORD, BLADE.THICKNESS));
  builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

function buildRotorHub() {
  const builder = createMeshBuilder();
  // Mast and the teetering hub with its pitch links.
  buildTube(builder, [0, -0.46, 0], [0, 0.04, 0], 0.07, PALETTE.creamShade, 8, PALETTE.charcoal);
  buildTube(builder, [-0.4, 0.02, 0], [0.4, 0.02, 0], 0.07, PALETTE.charcoal, 6);
  buildTube(builder, [0, 0.02, -0.12], [0, 0.02, 0.12], 0.09, PALETTE.creamShade, 6);
  buildTube(builder, [0, 0.04, 0], [0, 0.14, 0], 0.05, PALETTE.orange, 6, PALETTE.orange);
  return builder.toGeometry(null);
}

// Tail rotor: on the left side of the fin, spinning about x.
const TAIL_ROTOR = Object.freeze({ POSITION: simProfile.tailRotor.position, RADIUS: simProfile.tailRotor.radius });
function buildTailRotor() {
  const builder = createMeshBuilder();
  const chord = 0.12;
  for (const direction of [1, -1]) {
    const sections = [0.08, TAIL_ROTOR.RADIUS - 0.14, TAIL_ROTOR.RADIUS].map((r) => [
      [0, direction * r, -chord / 2],
      [0.02, direction * r, 0],
      [0, direction * r, chord / 2],
      [-0.02, direction * r, 0],
    ]);
    builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  buildTube(builder, [-0.06, 0, 0], [0.24, 0, 0], 0.04, PALETTE.creamShade, 6, PALETTE.charcoal);
  return builder.toGeometry(null);
}

/**
 * The rotor blur: a shallow cone (the disc cones up with the blades) of soft rings whose opacity
 * follows the rotor speed. Vertices sit at y = r; mesh.scale.y = tan(coning) shapes the cone.
 */
function createRotorDisc(radius) {
  const opacity = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const distance = length(uv().sub(0.5)).mul(2);
  const band = smoothstep(float(0.06), float(0.14), distance).mul(float(1).sub(smoothstep(float(0.93), float(1), distance)));
  const tipRing = smoothstep(float(0.86), float(0.9), distance).mul(float(1).sub(smoothstep(float(0.9), float(0.95), distance)));
  material.colorNode = mix(color(0x33363f), color(0xe0703a), tipRing.mul(0.6));
  material.opacityNode = band.mul(distance.mul(0.35).add(0.65)).mul(opacity).add(tipRing.mul(opacity).mul(0.25));
  const geometry = new THREE.CircleGeometry(radius, 56);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    positions.setY(index, Math.hypot(positions.getX(index), positions.getZ(index)));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  return {
    mesh,
    /** Faint while the rotor spins up, a soft disc at governed speed; hidden while it is stopped. */
    update(share, coning) {
      opacity.value = share > 0.03 ? 0.04 + 0.2 * smooth01((share - 0.1) / 0.8) : 0;
      mesh.visible = share > 0.03;
      mesh.scale.y = Math.tan(coning);
    },
  };
}

const EYE = Object.freeze([0, 0.3, -1.05]);
const GOVERNED_SPEED = (simProfile.rotor.rpm * Math.PI) / 30;
/** Displayed rotor spin (rad/s) at 100 % rpm: fast enough to read as a turning rotor, slow enough not to strobe. */
const ROTOR_DISPLAY_SPEED = 12.5;
const TAIL_DISPLAY_SPEED = 34;
const CYCLIC_LONGITUDINAL = simProfile.rotor.cyclic.longitudinal * DEG;
const CYCLIC_LATERAL = simProfile.rotor.cyclic.lateral * DEG;

/**
 * Builds the helicopter. update(visual, dt): the rotor turns with the rotor speed (visual.propSpeed,
 * rad/s; or throttle-driven when it is not given), the disc tilts with the cyclic (visual.elevator
 * aft and visual.aileron right, as shares of full cyclic), the blades cone with the collective
 * (visual.throttle) and droop at rest, the tail rotor spins, and the nav lights run from visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'helicopter';

  const sections = cabinSections();
  const airframe = createMeshBuilder();
  buildCabin(airframe, sections);
  buildDeck(airframe);
  buildExhaust(airframe);
  buildBoom(airframe);
  buildStabilizer(airframe);
  buildFins(airframe);
  buildSkids(airframe);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  // The bubble would sit around the pilot's head: the cockpit view hides it.
  const glass = addSolid(root, buildGlass(sections), materials.canopy);
  glass.userData.hideInCockpit = true;

  // Main rotor: mount (shaft tilt) -> head (disc tilt) -> spinner (rotation) -> blade pivots (coning).
  const rotorMount = new THREE.Group();
  rotorMount.position.set(HUB[0], HUB[1], HUB[2]);
  rotorMount.rotation.x = -simProfile.rotor.shaftTilt * DEG;
  root.add(rotorMount);
  const rotorHead = new THREE.Group();
  rotorMount.add(rotorHead);
  const spinner = new THREE.Group();
  rotorHead.add(spinner);
  addSolid(spinner, buildRotorHub(), bodyMaterial);
  const bladeGeometry = buildBlade();
  const bladePivots = [];
  for (const heading of [0, Math.PI]) {
    const arm = new THREE.Group();
    arm.rotation.y = heading;
    const pivot = new THREE.Group();
    arm.add(pivot);
    addSolid(pivot, bladeGeometry, bodyMaterial);
    spinner.add(arm);
    bladePivots.push(pivot);
  }
  const rotorDisc = createRotorDisc(ROTOR_RADIUS);
  rotorDisc.mesh.position.y = 0.02;
  rotorHead.add(rotorDisc.mesh);

  // Tail rotor on the left of the fin, spinning about x.
  const tailMount = new THREE.Group();
  tailMount.position.set(TAIL_ROTOR.POSITION[0], TAIL_ROTOR.POSITION[1], TAIL_ROTOR.POSITION[2]);
  root.add(tailMount);
  const tailSpinner = new THREE.Group();
  tailMount.add(tailSpinner);
  addSolid(tailSpinner, buildTailRotor(), bodyMaterial);
  const tailDisc = createPropDisc(TAIL_ROTOR.RADIUS);
  tailDisc.mesh.rotation.y = Math.PI / 2;
  tailDisc.mesh.position.x = -0.03;
  tailMount.add(tailDisc.mesh);

  const navLights = createNavLights(root, {
    red: { position: [-(STAB.HALF_SPAN + 0.04), STAB.Y + 0.22, STAB.Z - 0.1], glow: [-(STAB.HALF_SPAN + 0.12), STAB.Y + 0.24, STAB.Z - 0.12] },
    green: { position: [STAB.HALF_SPAN + 0.04, STAB.Y + 0.22, STAB.Z - 0.1], glow: [STAB.HALF_SPAN + 0.12, STAB.Y + 0.24, STAB.Z - 0.12] },
    strobe: { position: [0, FIN.TOP + 0.05, FIN.Z_ROOT + FIN.SWEEP + 0.12], glow: [0, FIN.TOP + 0.13, FIN.Z_ROOT + FIN.SWEEP + 0.12] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let rotorAngle = 0;
  let tailAngle = 0;
  let rotorShare = 1;
  let coning = simProfile.rotor.coning * DEG;

  return {
    root,
    wingtips: [new THREE.Vector3(-(STAB.HALF_SPAN + 0.05), STAB.Y, STAB.Z), new THREE.Vector3(STAB.HALF_SPAN + 0.05, STAB.Y, STAB.Z)],
    eyeAnchor,
    /** Local attachment points: the tail (trails) and the rotor hub. */
    anchors: {
      tail: new THREE.Vector3(0, 0.5, 6.4),
      hub: new THREE.Vector3(HUB[0], HUB[1], HUB[2]),
    },

    update(visual, dt) {
      const step = dt > 0 ? dt : 0;
      const throttle = Number.isFinite(visual.throttle) ? clamp(visual.throttle, 0, 1) : 0.5;
      const targetShare = Number.isFinite(visual.propSpeed) ? clamp(visual.propSpeed / GOVERNED_SPEED, 0, 1.25) : visual.engineOn === false ? 0 : 1;
      rotorShare += (targetShare - rotorShare) * (1 - Math.exp(-step * 6));
      // Coning: blades droop at rest, rise with the collective once the rotor carries load.
      const flying = smooth01((rotorShare - 0.35) / 0.55);
      const targetConing = (-2 + flying * (3 + 5 * throttle)) * DEG;
      coning += (targetConing - coning) * (1 - Math.exp(-step * 5));
      for (let index = 0; index < bladePivots.length; index++) bladePivots[index].rotation.z = coning;

      rotorAngle = (rotorAngle + rotorShare * ROTOR_DISPLAY_SPEED * step) % (Math.PI * 2);
      if (!Number.isFinite(rotorAngle)) rotorAngle = 0;
      spinner.rotation.y = rotorAngle;
      rotorDisc.update(rotorShare, Math.max(coning, 0));

      const discPitch = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1.5, 1.5) * CYCLIC_LONGITUDINAL;
      const discRoll = clamp(Number.isFinite(visual.aileron) ? visual.aileron : 0, -1.5, 1.5) * CYCLIC_LATERAL;
      rotorHead.rotation.x = discPitch;
      rotorHead.rotation.z = -discRoll;

      tailAngle = (tailAngle + rotorShare * TAIL_DISPLAY_SPEED * step) % (Math.PI * 2);
      if (!Number.isFinite(tailAngle)) tailAngle = 0;
      tailSpinner.rotation.x = tailAngle;
      tailDisc.setSpeed(rotorShare > 0.05 ? 8 + 24 * rotorShare : 0);

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: hover hold. Locks the current position, height and heading at any assist level (SIM);
// the stick and pedals then move the hold point slowly. In CLASSIC the button boosts (v1).
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Hover hold',
  modes: Object.freeze(['sim']),
  initialState: () => ({ hoverHold: false }),
  run(flight) {
    const craftState = flight.craftState;
    if (!craftState.hoverHold && flight.telemetry.engineOn === false) {
      flight.notify('Hover hold needs the engine running.');
      return false;
    }
    craftState.hoverHold = !craftState.hoverHold;
    flight.notify(craftState.hoverHold ? 'Hover hold on: holding position, height and heading.' : 'Hover hold off.');
    return true;
  },
  update(flight) {
    const craftState = flight.craftState;
    if (!craftState.hoverHold) return;
    if (flight.mode !== 'sim' || flight.telemetry.engineOn === false) {
      craftState.hoverHold = false;
      flight.notify(flight.mode !== 'sim' ? 'Hover hold off.' : 'Hover hold off: the engine stopped.', 'warning');
    }
  },
});

export default Object.freeze({
  id: 'helicopter',
  name: 'Helicopter',
  buildMesh,
  arcadeProfile,
  simProfile,
  /**
   * ControlState mapping: the throttle axis (W / S, the TWCS lever) is the collective; stick is the
   * cyclic; pedals / Q-E / twist are the anti-torque pedals; the antenna zooms the view.
   */
  inputProfile: Object.freeze({ throttle: 'collective', antenna: 'zoom', toeBrakes: 'none', flapNotches: 0 }),
  audioProfile: Object.freeze({
    engine: 'heli', blades: 2, rotorRpm: simProfile.rotor.rpm, tailBlades: 2, tailRatio: simProfile.tailRotor.ratio, turbineHz: 5400,
    touchdown: 'skids', stallHorn: true, stallHornStyle: 'horn', interiorCutoff: 1200, airflowSpeed: 65,
  }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 16, height: 4.6, lookAhead: 10 }),
    wing: Object.freeze({ position: Object.freeze([2.3, -0.9, 0.6]), target: Object.freeze([0, 0.2, -2]) }),
    fpv: null,
    // Bubble cabin: low sills, a centre spine and door bows, and a centre console with the flight and
    // engine instruments under the glareshield; the cyclic between the knees.
    cockpit: Object.freeze({
      style: 'bubble',
      width: 1.2,
      sill: -0.42,
      floor: -0.92,
      front: -0.95,
      back: 0.6,
      roof: 0.52,
      stick: true,
      panel: Object.freeze({
        width: 0.66,
        center: Object.freeze([0, -0.34, -0.66]),
        layout: Object.freeze([
          Object.freeze(['airspeed', 'attitude', 'altitude', 'rotorRpm', 'torque']),
          Object.freeze(['radarAlt', 'heading', 'vsi', 'throttle']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'rotorRpm', 'torque', 'radarAlt', 'throttle']),
  abilities: Object.freeze({ craftAbility }),
  capabilities: Object.freeze({ engine: true, chute: false }),
  spawn: Object.freeze({ cruise: 50, cruiseThrottle: 0.5, hover: true, relaunch: 'airstart', canStartOnGround: true }),
  limits: Object.freeze({ vne: 69.4, gLimit: 3.5, crashSinkRate: 3.2, bodyStrikeSpeed: 4, floats: false }),
});
