// AIRSHIP: a 62 m semi-rigid airship of the Zeppelin NT class, built from code in the v1 glider's style
// (flat-shaded, vertex-coloured lofts in the v1 palette). A streamlined cream envelope with an orange
// belly band and nose cap, a cruciform tail with elevators and rudders, a glazed gondola under the
// front half, two swivelling propeller pods on outriggers (the rocker turns them from 45 degrees
// down through forward to 120 degrees up and back) and a lateral stern thruster on the tail cone.
// The envelope breathes with the ballonets, the pods turn with the vector angle, the props and the
// stern fan spin with their thrust and the control surfaces follow the elevator and rudder.
// Its flight profile describes the real thing for SimAirship (src/flight/SimAirship.js), measured by
// tools/lab/airship.mjs; its scenic cruise lives in airshipCruise.js.
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, profileSection, ellipseRing, piecewise, getCraftMaterials, addSolid, createPropDisc, createNavLights,
  disposeCraftMesh, smooth01,
} from './kit.js';
import { airshipBuoyancy, levelThrottle } from '../flight/SimAirship.js';
import { SCENIC_CRUISE, createCruiseState, startCruise, stopCruise, updateCruise } from './airshipCruise.js';

// ============================================================================================
// SIM: SimAirship parameters. Body axes relative to the mesh origin, the centre of the envelope
// (x right, y up, z aft; m). Targets are what tools/lab/airship.mjs measures.
// ============================================================================================
const ENVELOPE_LENGTH = 62;
const ENVELOPE_RADIUS = 7.5;
const simProfile = Object.freeze({
  model: 'airship',
  targets: Object.freeze({
    cruise: 22, // m/s (79 km/h) at the cruise throttle
    topSpeed: 29, // m/s (104 km/h) at full throttle
    pressureHeight: 2400, // m, with the ballonets at neutral trim
    heavinessRange: 260, // kg of static heaviness either way at the ballonet end stops
    staticClimb: 2.6, // m/s climb with the ballonets empty (light), hands off at rest in the air
    vectorClimb: 5, // m/s climb with full throttle vectored straight up, no airspeed
    turnRate: 2.5, // deg/s at full rudder from the cruise (the turn bleeds the speed)
    stopTime: 220, // s for the engines off at the cruise to coast under 5 m/s (huge inertia, little drag)
  }),
  // Dry mass (kg): structure and envelope, gondola and engines, crew, fuel, passengers. The helium
  // that makes the half-filled ballonets exactly neutral follows from it (airshipBuoyancy).
  mass: Object.freeze({ structure: 3420, gondola: 880, crew: 240, fuel: 420, payload: 420 }),
  // kg m^2 about body x (pitch), y (yaw) and z (roll), the added inertia of the air included.
  inertia: Object.freeze({ pitch: 3.3e6, yaw: 3.3e6, roll: 4.6e5 }),
  // The gondola and engines hang the centre of mass 2.5 m under the centre of buoyancy (pendulum).
  centerOfMass: Object.freeze([0, -2.5, 0]),
  envelope: Object.freeze({
    length: ENVELOPE_LENGTH,
    diameter: ENVELOPE_RADIUS * 2,
    volume: 6800, // m^3
    gasRatio: 0.138, // helium density over air density at the same pressure and temperature
    storage: 0.08, // share of the helium the full ballonets push into the compression tanks
    blowerSeconds: 20, // ballonets end to end
    leverRate: 0.15, // ballonet target per second while a flap key is held
    axialAddedMass: 0.06, // k1, share of the displaced air moving with the hull along it
    lateralAddedMass: 0.82, // k2, across it (sideways and vertically)
  }),
  hull: Object.freeze({
    dragCoefficient: 0.028, // on volume^(2/3): hull, fins, gondola and pods together
    crossflowDrag: 0.6, // crossflow drag coefficient on the plan area
    planArea: 700, // m^2
    liftSlope: 0.25, // viscous hull lift per radian on volume^(2/3)
    munk: 0.1, // effective (k2 - k1): the Munk moment after the tail cone's crossflow lift
    rotationalDamping: 4.2e5, // N m s^2 / (rad^2 kg/m^3): the long hull's crossflow drag when it turns
    pitchDamping: 5e5, // N m s / rad: the hull's viscous damping of small swings in pitch,
    yawDamping: 2.5e5, // in yaw
    rollDamping: 1.8e5, // and in roll
    gustMoment: 9e4, // N m of shaking at full turbulence
  }),
  // The cruciform tail: four fins in the + layout, each with its own local flow (rotation included).
  fins: Object.freeze([
    Object.freeze({ id: 'finRight', position: Object.freeze([6.2, 0, 25]), normal: 'y', area: 15, liftSlope: 2.6, controlSlope: 1.1, maxDeflection: 25 }),
    Object.freeze({ id: 'finLeft', position: Object.freeze([-6.2, 0, 25]), normal: 'y', area: 15, liftSlope: 2.6, controlSlope: 1.1, maxDeflection: 25 }),
    Object.freeze({ id: 'finTop', position: Object.freeze([0, 6.2, 25]), normal: 'x', area: 15, liftSlope: 2.6, controlSlope: 1.1, maxDeflection: 25 }),
    Object.freeze({ id: 'finBottom', position: Object.freeze([0, -6.2, 25]), normal: 'x', area: 15, liftSlope: 2.6, controlSlope: 1.1, maxDeflection: 25 }),
  ]),
  props: Object.freeze({
    positions: Object.freeze([Object.freeze([-9.8, -2.5, -2]), Object.freeze([9.8, -2.5, -2])]),
    radius: 1.7,
    staticThrust: 10000, // N, both props at full throttle and no inflow
    zeroThrustSpeed: 70, // m/s of inflow where the thrust has gone
    differential: 0.15, // share of the thrust the rudder moves from one prop to the other
    vector: Object.freeze({ down: 45, up: 120, rate: 30 }), // deg below and above forward, servo deg/s
    visualSpeed: 30, // displayed prop spin at full power (rad/s)
  }),
  sternThruster: Object.freeze({
    position: Object.freeze([0, 0, 31.8]),
    thrust: 900, // N sideways at full rudder
    fadeSpeed: Object.freeze([6, 14]), // m/s of forward airspeed where the fins take over from it
  }),
  contacts: Object.freeze([
    Object.freeze({ id: 'gondolaWheel', kind: 'wheel', gear: true, position: Object.freeze([0, -10.9, -10]), spring: 60000, damping: 22000, rollingFriction: 0.05, sideFriction: 0.6 }),
    Object.freeze({ id: 'tailWheel', kind: 'wheel', gear: true, position: Object.freeze([0, -10.6, 27.4]), spring: 50000, damping: 18000, rollingFriction: 0.05, sideFriction: 0.5 }),
    Object.freeze({ id: 'gondolaNose', kind: 'body', gear: false, position: Object.freeze([0, -9.8, -16.6]), spring: 40000, damping: 12000 }),
    Object.freeze({ id: 'gondolaTail', kind: 'body', gear: false, position: Object.freeze([0, -10.0, -4.5]), spring: 40000, damping: 12000 }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, 0, -31]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'tail', kind: 'body', gear: false, position: Object.freeze([0, 0, 32.6]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'envelopeBelowFront', kind: 'body', gear: false, position: Object.freeze([0, -6.6, -21]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'envelopeBelowAft', kind: 'body', gear: false, position: Object.freeze([0, -6.9, 8]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'envelopeTop', kind: 'body', gear: false, position: Object.freeze([0, 7.5, -2]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'envelopeLeft', kind: 'body', gear: false, position: Object.freeze([-7.5, 0, -2]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'envelopeRight', kind: 'body', gear: false, position: Object.freeze([7.5, 0, -2]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'podLeft', kind: 'body', gear: false, position: Object.freeze([-11.5, -2.5, -2]), spring: 40000, damping: 9000 }),
    Object.freeze({ id: 'podRight', kind: 'body', gear: false, position: Object.freeze([11.5, -2.5, -2]), spring: 40000, damping: 9000 }),
    Object.freeze({ id: 'finLeftTip', kind: 'body', gear: false, position: Object.freeze([-9.6, 0, 27]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'finRightTip', kind: 'body', gear: false, position: Object.freeze([9.6, 0, 27]), spring: 30000, damping: 9000 }),
    Object.freeze({ id: 'finTopTip', kind: 'body', gear: false, position: Object.freeze([0, 9.6, 27]), spring: 30000, damping: 9000 }),
  ]),
});

const STATICS = airshipBuoyancy(simProfile);
const CRUISE_SPEED = simProfile.targets.cruise;
const CRUISE_THROTTLE = Math.round(levelThrottle(simProfile, CRUISE_SPEED) * 100) / 100;

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin at the centre of the envelope)
// ============================================================================================
// Envelope radius along the hull: [share of the length from the nose, share of the radius].
const ENVELOPE_PROFILE = Object.freeze([
  [0, 0.02], [0.015, 0.26], [0.04, 0.47], [0.08, 0.66], [0.13, 0.81], [0.2, 0.92], [0.3, 0.985], [0.4, 1],
  [0.5, 0.99], [0.6, 0.955], [0.7, 0.87], [0.78, 0.76], [0.86, 0.6], [0.92, 0.43], [0.965, 0.25], [0.99, 0.11], [1, 0.07],
]);
const ENVELOPE_SIDES = 18;

/** Envelope radius (m) at body z. */
function envelopeRadius(z) {
  return ENVELOPE_RADIUS * piecewise(ENVELOPE_PROFILE, (z + ENVELOPE_LENGTH / 2) / ENVELOPE_LENGTH);
}

function buildEnvelope() {
  const builder = createMeshBuilder();
  const sections = ENVELOPE_PROFILE.map(([share]) => {
    const z = -ENVELOPE_LENGTH / 2 + share * ENVELOPE_LENGTH;
    const radius = Math.max(envelopeRadius(z), 0.05);
    return ellipseRing(z, 0, radius, radius, ENVELOPE_SIDES, 90 / ENVELOPE_SIDES);
  });
  // Faces 0..17 run counterclockwise from the right side seen from the nose; the bottom band (faces
  // around 270 degrees) is orange, the nose cap orange, the tail cone charcoal.
  const belly = new Set([12, 13, 14]);
  builder.loft(sections, (segment, face) => {
    if (segment === 0) return PALETTE.orange;
    if (segment >= sections.length - 3) return PALETTE.charcoal;
    if (belly.has(face)) return segment === 6 || segment === 7 ? PALETTE.cream : PALETTE.orange;
    if (segment === 5 && (face === 4 || face === 5)) return PALETTE.orange;
    return face >= 10 && face <= 16 ? PALETTE.creamShade : PALETTE.cream;
  }, { capStart: PALETTE.orange, capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

// ---- Tail: four fins (built for the right fin, then turned about the hull axis) -----------------
const FIN = Object.freeze({ ROOT_X: 2.6, TIP_X: 9.6, ROOT_LEAD: 18.6, TIP_LEAD: 23.2, HINGE: 27.6, ROOT_TRAIL: 29.4, TIP_TRAIL: 29.0, THICKNESS: 0.09 });
const FIN_PROFILE = [[0, 0], [0.08, 0.55], [0.3, 0.6], [0.7, 0.35], [1, 0.08], [1, -0.08], [0.7, -0.35], [0.3, -0.6], [0.08, -0.55]];
const SURFACE_PROFILE = [[0, 0.3], [0.5, 0.2], [1, 0], [0.5, -0.2], [0, -0.3]];
/** The four fins: turn about the hull axis, which surface it carries and its deflection sign. */
const TAIL_FINS = Object.freeze([
  Object.freeze({ id: 'finRight', angle: 0, control: 'elevator', sign: -1 }),
  Object.freeze({ id: 'finTop', angle: Math.PI / 2, control: 'rudder', sign: 1 }),
  Object.freeze({ id: 'finLeft', angle: Math.PI, control: 'elevator', sign: 1 }),
  Object.freeze({ id: 'finBottom', angle: -Math.PI / 2, control: 'rudder', sign: -1 }),
]);

/** The fixed part of the right fin (in the x-z plane, extending along +x). */
function buildFin() {
  const builder = createMeshBuilder();
  const root = profileSection(FIN_PROFILE, [FIN.ROOT_X, 0, FIN.ROOT_LEAD], [0, 0, 1], [0, 1, 0], FIN.HINGE - FIN.ROOT_LEAD, FIN.THICKNESS);
  const tip = profileSection(FIN_PROFILE, [FIN.TIP_X, 0, FIN.TIP_LEAD], [0, 0, 1], [0, 1, 0], FIN.HINGE - FIN.TIP_LEAD, FIN.THICKNESS * 1.3);
  builder.loft([root, tip], (segment, face) => (face <= 3 ? PALETTE.cream : PALETTE.creamShade), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

/** The control surface of the right fin, in its hinge frame (hinge line along x at the origin). */
function buildControlSurface() {
  const builder = createMeshBuilder();
  const root = profileSection(SURFACE_PROFILE, [FIN.ROOT_X + 0.15, 0, 0], [0, 0, 1], [0, 1, 0], FIN.ROOT_TRAIL - FIN.HINGE, 0.18);
  const tip = profileSection(SURFACE_PROFILE, [FIN.TIP_X, 0, 0], [0, 0, 1], [0, 1, 0], FIN.TIP_TRAIL - FIN.HINGE, 0.22);
  builder.loft([root, tip], () => PALETTE.orange, { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

// ---- Gondola: a glazed cabin under the front of the envelope -----------------------------------
// Stations: [z, bottom y, top y, half width at the floor, half width at the window line].
const GONDOLA = Object.freeze([
  [-16.6, -9.95, -7.6, 0.55, 0.65],
  [-16.0, -10.15, -7.25, 1.05, 1.2],
  [-14.6, -10.35, -7.1, 1.25, 1.42],
  [-10.5, -10.4, -7.05, 1.3, 1.45],
  [-7.0, -10.35, -7.05, 1.28, 1.42],
  [-5.0, -10.15, -7.1, 1.05, 1.2],
  [-4.4, -9.95, -7.3, 0.6, 0.75],
]);
const GONDOLA_SIDES = 8;
/** Window band: y between these (m), on the side faces (1, 2 right; 5, 6 left) and the nose. */
const WINDOW_TOP = -7.65;
const WINDOW_BOTTOM = -9.6;

/** An eight-sided gondola ring at one station: floor corners, window-line corners, roof. */
function gondolaRing([z, bottom, top, floorHalf, windowHalf]) {
  return [
    [floorHalf * 0.7, bottom, z],
    [floorHalf, bottom + 0.35, z],
    [windowHalf, WINDOW_BOTTOM, z],
    [windowHalf * 0.98, WINDOW_TOP, z],
    [-windowHalf * 0.98, WINDOW_TOP, z],
    [-windowHalf, WINDOW_BOTTOM, z],
    [-floorHalf, bottom + 0.35, z],
    [-floorHalf * 0.7, bottom, z],
  ].map((point, index) => (index === 3 || index === 4 ? [point[0], Math.max(point[1], top - 0.45), point[2]] : point));
}

function buildGondola(builder, glass) {
  const sections = GONDOLA.map(gondolaRing);
  // Faces: 0 belly right, 1 lower right, 2 window right, 3 roof, 4 window left, 5 lower left, 6 belly left, 7 belly.
  builder.loft(sections, (segment, face) => {
    if (face === 2 || face === 4) return PALETTE.charcoal;
    if (face === 1 || face === 5) return segment === 0 || segment === sections.length - 2 ? PALETTE.cream : PALETTE.orange;
    return face === 3 ? PALETTE.cream : PALETTE.creamShade;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.cream });
  // Roof pylon up into the envelope.
  const pylon = [[-0.9, -7.0, -15], [0.9, -7.0, -15], [0.9, -7.0, -5.5], [-0.9, -7.0, -5.5]];
  const pylonTop = pylon.map(([x, , z]) => [x * 0.8, -6.2, z]);
  builder.loft([pylon, pylonTop], () => PALETTE.creamShade, { capEnd: PALETTE.cream });
  // Glass panes on the window band, inset from their frames and lifted off the skin.
  for (let segment = 0; segment < sections.length - 1; segment++) {
    for (const face of [2, 4]) {
      const next = face + 1;
      const corners = [sections[segment][face], sections[segment][next], sections[segment + 1][next], sections[segment + 1][face]];
      addPane(glass, corners, face === 2 ? 1 : -1);
    }
  }
  // The windshield: the nose cap's upper half.
  const nose = sections[0];
  addPane(glass, [nose[2], nose[3], sections[1][3], sections[1][2]], 1);
  addPane(glass, [nose[4], nose[5], sections[1][5], sections[1][4]], -1);
  addPane(glass, [nose[3], nose[4], sections[1][4], sections[1][3]], 0);
}

/** A glass pane on a gondola face (side: 1 right, -1 left, 0 the nose), inset and lifted 2 cm outward. */
function addPane(glass, corners, side) {
  const centre = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / 4);
  const outward = side === 0 ? [0, 0.3, -1] : [side, 0.15, 0];
  const length = Math.hypot(outward[0], outward[1], outward[2]);
  const pane = corners.map((corner) => [0, 1, 2].map((axis) => corner[axis] + (centre[axis] - corner[axis]) * 0.1 + (outward[axis] / length) * 0.02));
  glass.quad(pane[0], pane[1], pane[2], pane[3], PALETTE.charcoal, [centre[0] - outward[0], centre[1] - outward[1], centre[2] - outward[2]]);
}

/** A square-section strut from `from` to `to` (outward-facing). */
function addStrut(builder, from, to, half, tint) {
  const axis = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(axis, helper).normalize().multiplyScalar(half);
  const up = new THREE.Vector3().crossVectors(side, axis).normalize().multiplyScalar(half * 0.45);
  const ring = (point) => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s, u]) => [
    point[0] + side.x * s + up.x * u, point[1] + side.y * s + up.y * u, point[2] + side.z * s + up.z * u,
  ]);
  builder.loft([ring(from), ring(to)], () => tint, { capStart: tint, capEnd: tint });
}

/** A small landing wheel (an octagonal disc about x) centred on `centre`. */
function addWheel(builder, centre, radius, width) {
  const ring = (x) => {
    const points = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      points.push([centre[0] + x, centre[1] + Math.cos(angle) * radius, centre[2] + Math.sin(angle) * radius]);
    }
    return points;
  };
  builder.loft([ring(-width / 2), ring(width / 2)], () => PALETTE.charcoal, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
}

// ---- Propeller pods (swivel about x with the vector angle) ---------------------------------------
const POD = Object.freeze({ LENGTH: 2.6, RADIUS: 0.5 });
const POD_X = simProfile.props.positions[1][0];
const POD_Y = simProfile.props.positions[1][1];
const POD_Z = simProfile.props.positions[1][2];
const PROP_RADIUS = simProfile.props.radius;
const PROP_BLADES = 4;

/** A pod nacelle around the swivel point: nose forward (-z), the pusher prop at its tail (+z). */
function buildPod() {
  const builder = createMeshBuilder();
  const stations = [[-1.3, 0.12], [-1.05, 0.38], [-0.6, 0.5], [0.4, 0.48], [1.0, 0.32], [1.3, 0.14]];
  const sections = stations.map(([z, radius]) => ellipseRing(z, 0, radius, radius, 8, 22.5));
  builder.loft(sections, (segment) => (segment === 0 ? PALETTE.orange : segment >= 3 ? PALETTE.charcoal : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

/** Four pusher blades about the z axis (the spinner group turns them). */
function buildPropBlades(radius, blades, chord) {
  const builder = createMeshBuilder();
  for (let blade = 0; blade < blades; blade++) {
    const angle = (blade / blades) * Math.PI * 2;
    const along = [Math.cos(angle), Math.sin(angle), 0];
    const across = [-Math.sin(angle), Math.cos(angle), 0];
    const sections = [0.12, radius * 0.6, radius].map((r, index) => {
      const width = (index === 2 ? 0.55 : 1) * chord;
      const twist = index === 0 ? 0.6 : 0.3;
      return [
        [along[0] * r - across[0] * width / 2, along[1] * r - across[1] * width / 2, -twist * 0.12],
        [along[0] * r, along[1] * r, 0.04],
        [along[0] * r + across[0] * width / 2, along[1] * r + across[1] * width / 2, twist * 0.12],
        [along[0] * r, along[1] * r, -0.04],
      ];
    });
    builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  return builder.toGeometry(null);
}

// ---- Stern thruster: a lateral ducted fan on the tail cone ---------------------------------------
const STERN = Object.freeze({ Z: simProfile.sternThruster.position[2], RADIUS: 0.85 });

function buildSternHub() {
  const builder = createMeshBuilder();
  const stations = [[30.6, 0.62], [31.2, 0.66], [32.4, 0.5], [32.8, 0.12]];
  builder.loft(stations.map(([z, radius]) => ellipseRing(z, 0, radius, radius, 8, 22.5)), () => PALETTE.charcoal, { capEnd: PALETTE.orange });
  // The duct: a short ring around the x axis through the hub.
  const ring = (x, radius) => {
    const points = [];
    for (let index = 0; index < 12; index++) {
      const angle = (index / 12) * Math.PI * 2;
      points.push([x, Math.cos(angle) * radius, STERN.Z + Math.sin(angle) * radius]);
    }
    return points;
  };
  builder.loft([ring(-0.45, STERN.RADIUS + 0.12), ring(0.45, STERN.RADIUS + 0.12)], () => PALETTE.orange, { closed: true });
  builder.loft([ring(0.45, STERN.RADIUS), ring(-0.45, STERN.RADIUS)], () => PALETTE.charcoal, { closed: true });
  return builder.toGeometry(null);
}

const EYE = Object.freeze([0, -8.95, -15.0]);
const BREATHING = Object.freeze({ PERIOD: 7, AMOUNT: 0.0025, BALLONET: 0.006 });
const ENGINE_RAMP = 3;

/**
 * Builds the airship. update(visual, dt): the pods turn with craftState.vectorAngle, the props spin
 * with visual.propSpeed, the stern fan with craftState.sternThrust, the elevators and rudders follow
 * visual.elevator / visual.rudder, the envelope breathes (slightly slacker as the ballonets fill),
 * and the nav lights run from visual.time.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'airship';

  const envelope = addSolid(root, buildEnvelope(), bodyMaterial);
  envelope.name = 'envelope';

  // Tail: each fin turned about the hull axis, its control surface on a hinge.
  const finGeometry = buildFin();
  const surfaceGeometry = buildControlSurface();
  const controlSurfaces = TAIL_FINS.map((fin) => {
    const frame = new THREE.Group();
    frame.rotation.z = fin.angle;
    root.add(frame);
    addSolid(frame, finGeometry, bodyMaterial);
    const hinge = new THREE.Group();
    hinge.position.z = FIN.HINGE;
    frame.add(hinge);
    addSolid(hinge, surfaceGeometry, bodyMaterial);
    return { hinge, control: fin.control, sign: fin.sign };
  });

  // Gondola, its glass (the eye sits inside: the cockpit view hides both), the outriggers.
  const airframe = createMeshBuilder();
  const glassBuilder = createMeshBuilder();
  buildGondola(airframe, glassBuilder);
  for (const side of [-1, 1]) {
    const hullX = side * Math.sqrt(Math.max(ENVELOPE_RADIUS ** 2 - POD_Y ** 2, 0)) * 0.97;
    addStrut(airframe, [hullX, POD_Y, POD_Z - 0.6], [side * (POD_X - 0.35), POD_Y, POD_Z], 0.42, PALETTE.creamShade);
    addStrut(airframe, [hullX, POD_Y - 1.6, POD_Z + 0.4], [side * (POD_X - 0.45), POD_Y - 0.15, POD_Z], 0.18, PALETTE.charcoal);
  }
  // The landing wheels: one under the gondola, one under the lower fin, each on a short strut.
  for (const [z, top, axle] of [[-10, GONDOLA[3][1] + 0.05, -10.55], [27.4, -FIN.TIP_X + 0.3, -10.25]]) {
    addStrut(airframe, [0, top, z], [0, axle, z], 0.16, PALETTE.charcoal);
    addWheel(airframe, [0, axle, z], 0.35, 0.2);
  }
  const gondolaGeometry = airframe.toGeometry(null);
  addSolid(root, gondolaGeometry, bodyMaterial);
  const glass = addSolid(root, glassBuilder.toGeometry(null), materials.canopy);
  glass.userData.hideInCockpit = true;

  // Vectored pods: swivel group -> nacelle and the pusher prop spinner.
  const podGeometry = buildPod();
  const bladeGeometry = buildPropBlades(PROP_RADIUS, PROP_BLADES, 0.32);
  const pods = [-1, 1].map((side) => {
    const swivel = new THREE.Group();
    swivel.position.set(side * POD_X, POD_Y, POD_Z);
    root.add(swivel);
    addSolid(swivel, podGeometry, bodyMaterial);
    const spinner = new THREE.Group();
    spinner.position.z = POD.LENGTH / 2 + 0.12;
    swivel.add(spinner);
    addSolid(spinner, bladeGeometry, bodyMaterial);
    const disc = createPropDisc(PROP_RADIUS);
    disc.mesh.position.z = POD.LENGTH / 2 + 0.14;
    swivel.add(disc.mesh);
    return { swivel, spinner, disc, direction: side };
  });

  // Stern thruster: the hub and duct, the fan spinning about x.
  addSolid(root, buildSternHub(), bodyMaterial);
  const sternSpinner = new THREE.Group();
  sternSpinner.position.set(0, 0, STERN.Z);
  root.add(sternSpinner);
  const sternFan = buildPropBlades(STERN.RADIUS - 0.08, 5, 0.22);
  const sternBlades = addSolid(sternSpinner, sternFan, bodyMaterial);
  sternBlades.rotation.y = Math.PI / 2;
  const sternDisc = createPropDisc(STERN.RADIUS);
  sternDisc.mesh.rotation.y = Math.PI / 2;
  sternSpinner.add(sternDisc.mesh);

  const navLights = createNavLights(root, {
    red: { position: [-(FIN.TIP_X + 0.05), 0.1, FIN.HINGE - 0.6], glow: [-(FIN.TIP_X + 0.2), 0.12, FIN.HINGE - 0.6] },
    green: { position: [FIN.TIP_X + 0.05, 0.1, FIN.HINGE - 0.6], glow: [FIN.TIP_X + 0.2, 0.12, FIN.HINGE - 0.6] },
    strobe: { position: [0, FIN.TIP_X + 0.08, FIN.HINGE - 0.6], glow: [0, FIN.TIP_X + 0.25, FIN.HINGE - 0.6] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let propAngle = 0;
  let sternAngle = 0;
  let breathingClock = 0;
  let sternShare = 0;

  return {
    root,
    wingtips: [new THREE.Vector3(-FIN.TIP_X, 0, FIN.HINGE), new THREE.Vector3(FIN.TIP_X, 0, FIN.HINGE)],
    eyeAnchor,
    /** Local attachment points: the tail (trails), the gondola and the two prop pods. */
    anchors: {
      tail: new THREE.Vector3(0, 0, 32.6),
      gondola: new THREE.Vector3(0, -9.8, -10),
      podLeft: new THREE.Vector3(-POD_X, POD_Y, POD_Z + 1.4),
      podRight: new THREE.Vector3(POD_X, POD_Y, POD_Z + 1.4),
    },

    update(visual, dt) {
      const step = dt > 0 ? dt : 0;
      const craftState = visual.craftState || {};
      const vectorAngle = Number.isFinite(craftState.vectorAngle) ? craftState.vectorAngle : 0;
      const ballonet = Number.isFinite(craftState.ballonet) ? craftState.ballonet : 0.5;
      const propSpeed = Number.isFinite(visual.propSpeed) ? visual.propSpeed : 0;

      for (const pod of pods) {
        pod.swivel.rotation.x = vectorAngle * DEG;
        pod.spinner.rotation.z = pod.direction * propAngle;
        pod.disc.setSpeed(propSpeed > 0.5 ? 8 + 24 * smooth01(propSpeed / simProfile.props.visualSpeed) : 0);
      }
      propAngle = (propAngle + propSpeed * step) % (Math.PI * 2);
      if (!Number.isFinite(propAngle)) propAngle = 0;

      const sternTarget = Number.isFinite(craftState.sternThrust) ? craftState.sternThrust : 0;
      sternShare += (sternTarget - sternShare) * (1 - Math.exp(-step * ENGINE_RAMP));
      sternAngle = (sternAngle + sternShare * 40 * step) % (Math.PI * 2);
      if (!Number.isFinite(sternAngle)) sternAngle = 0;
      sternSpinner.rotation.x = sternAngle;
      sternDisc.setSpeed(Math.abs(sternShare) > 0.05 ? 8 + 24 * Math.abs(sternShare) : 0);

      const elevator = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1);
      const rudder = clamp(Number.isFinite(visual.rudder) ? visual.rudder : 0, -1, 1);
      for (const surface of controlSurfaces) {
        const command = surface.control === 'elevator' ? elevator : rudder;
        surface.hinge.rotation.x = surface.sign * command * simProfile.fins[0].maxDeflection * DEG;
      }

      // The envelope breathes; fuller ballonets (less helium in the gas cells) slacken it a touch.
      breathingClock = (breathingClock + step) % BREATHING.PERIOD;
      const breath = 1 + BREATHING.AMOUNT * Math.sin((breathingClock / BREATHING.PERIOD) * Math.PI * 2) - BREATHING.BALLONET * (ballonet - 0.5);
      envelope.scale.set(breath, breath, 1);

      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// COCKPIT: the gondola seen from the pilot's seat (a custom cockpit; camera/cockpit.js builds the
// instrument panel under the windshield). Frame relative to the eye: x right, y up, -z forward.
// ============================================================================================
const CABIN = Object.freeze({
  FLOOR: GONDOLA[3][1] + 0.12 - EYE[1],
  SILL: WINDOW_BOTTOM - EYE[1],
  WINDOW_TOP: WINDOW_TOP - EYE[1],
  ROOF: -7.15 - EYE[1],
  HALF_WIDTH: 1.3,
  FRONT: GONDOLA[1][0] - EYE[2] + 0.1,
  BACK: GONDOLA[5][0] - EYE[2] - 0.1,
  POST_SPACING: 1.35,
});
const CABIN_TINT = Object.freeze({
  wall: new THREE.Color(0xd9c7aa),
  wallLow: new THREE.Color(0xb9a68a),
  floor: new THREE.Color(0x3a3c44),
  frame: new THREE.Color(0x2c2f38),
  seat: new THREE.Color(0x4a4d57),
  cushion: PALETTE.orange,
});

/** A quad facing the eye (the eye is the origin of the cockpit frame). */
function cabinQuad(builder, a, b, c, d, tint) {
  const centre = [0, 1, 2].map((axis) => (a[axis] + b[axis] + c[axis] + d[axis]) / 4);
  builder.quad(a, b, c, d, tint, [centre[0] * 2, centre[1] * 2, centre[2] * 2]);
}

/** A box between two corners (outward-facing faces: seats, consoles, posts). */
function cabinBox(builder, min, max, tint) {
  const inside = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const corner = (ix, iy, iz) => [ix ? max[0] : min[0], iy ? max[1] : min[1], iz ? max[2] : min[2]];
  const faces = [
    [corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)],
    [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)],
    [corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)],
    [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)],
    [corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)],
    [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)],
  ];
  for (const face of faces) builder.quad(face[0], face[1], face[2], face[3], tint, inside);
}

/**
 * The gondola interior: floor, low side walls under a continuous window band with slim posts, the
 * roof with the envelope pylon's hatch, a raked windshield frame, the rear bulkhead and the two
 * pilots' seats. The panel (panel.layout) sits under the windshield.
 */
function buildGondolaCockpit(builder) {
  const { FLOOR, SILL, WINDOW_TOP: TOP, ROOF, HALF_WIDTH: HALF, FRONT, BACK } = CABIN;
  const noseHalf = HALF * 0.72;
  // Floor and roof.
  cabinQuad(builder, [-HALF, FLOOR, FRONT + 0.4], [HALF, FLOOR, FRONT + 0.4], [HALF, FLOOR, BACK], [-HALF, FLOOR, BACK], CABIN_TINT.floor);
  cabinQuad(builder, [-HALF, ROOF, FRONT + 0.25], [HALF, ROOF, FRONT + 0.25], [HALF, ROOF, BACK], [-HALF, ROOF, BACK], CABIN_TINT.wall);
  // Side walls under the sill and the strip over the windows.
  for (const side of [-1, 1]) {
    const x = side * HALF;
    cabinQuad(builder, [x, FLOOR, FRONT + 0.4], [x, FLOOR, BACK], [x, SILL, BACK], [x, SILL, FRONT + 0.4], CABIN_TINT.wallLow);
    cabinQuad(builder, [x, TOP, FRONT + 0.25], [x, TOP, BACK], [x, ROOF, BACK], [x, ROOF, FRONT + 0.25], CABIN_TINT.wall);
    // Window posts and the sill rail.
    for (let z = FRONT + 0.4 + CABIN.POST_SPACING; z < BACK - 0.3; z += CABIN.POST_SPACING) {
      cabinBox(builder, [x - side * 0.06 - 0.035, SILL, z - 0.04], [x - side * 0.06 + 0.035, TOP, z + 0.04], CABIN_TINT.frame);
    }
    cabinBox(builder, [Math.min(x, x - side * 0.1), SILL - 0.04, FRONT + 0.4], [Math.max(x, x - side * 0.1), SILL + 0.02, BACK], CABIN_TINT.frame);
  }
  // The raked windshield: corner posts from the sill to the roof, a centre post, the lower nose panel.
  for (const side of [-1, 1]) {
    cabinBox(builder, [side * noseHalf - 0.04, SILL, FRONT - 0.04], [side * noseHalf + 0.04, SILL + 0.06, FRONT + 0.04], CABIN_TINT.frame);
  }
  const post = (fromX, toX) => {
    const steps = 6;
    for (let index = 0; index < steps; index++) {
      const share = index / steps;
      const nextShare = (index + 1) / steps;
      const y0 = SILL + (TOP - SILL) * share;
      const y1 = SILL + (TOP - SILL) * nextShare;
      const z0 = FRONT + 0.3 * share;
      const z1 = FRONT + 0.3 * nextShare;
      const x0 = fromX + (toX - fromX) * share;
      const x1 = fromX + (toX - fromX) * nextShare;
      cabinBox(builder, [Math.min(x0, x1) - 0.035, y0, Math.min(z0, z1) - 0.035], [Math.max(x0, x1) + 0.035, y1, Math.max(z0, z1) + 0.035], CABIN_TINT.frame);
    }
  };
  post(-noseHalf, -HALF);
  post(noseHalf, HALF);
  cabinQuad(builder, [-noseHalf, FLOOR + 0.3, FRONT], [noseHalf, FLOOR + 0.3, FRONT], [noseHalf, SILL, FRONT], [-noseHalf, SILL, FRONT], CABIN_TINT.wallLow);
  cabinQuad(builder, [-HALF, ROOF, FRONT + 0.25], [HALF, ROOF, FRONT + 0.25], [noseHalf, TOP, FRONT + 0.3], [-noseHalf, TOP, FRONT + 0.3], CABIN_TINT.frame);
  // Rear bulkhead with a door.
  cabinQuad(builder, [-HALF, FLOOR, BACK], [HALF, FLOOR, BACK], [HALF, ROOF, BACK], [-HALF, ROOF, BACK], CABIN_TINT.wall);
  cabinBox(builder, [-0.38, FLOOR, BACK - 0.03], [0.38, FLOOR + 1.85, BACK - 0.01], CABIN_TINT.wallLow);
  // The overhead hatch to the envelope (the keel walkway).
  cabinBox(builder, [-0.4, ROOF - 0.03, 3.2], [0.4, ROOF, 4.4], CABIN_TINT.frame);
  // Two pilots' seats behind the eye, and a centre console with the vector and ballonet levers.
  for (const x of [-0.62, 0.62]) {
    cabinBox(builder, [x - 0.26, FLOOR, 0.15], [x + 0.26, FLOOR + 0.48, 0.65], CABIN_TINT.seat);
    cabinBox(builder, [x - 0.24, FLOOR + 0.48, 0.55], [x + 0.24, FLOOR + 1.25, 0.68], CABIN_TINT.cushion);
  }
  cabinBox(builder, [-0.14, FLOOR, -0.9], [0.14, FLOOR + 0.62, -0.1], CABIN_TINT.seat);
  cabinBox(builder, [-0.09, FLOOR + 0.62, -0.62], [-0.05, FLOOR + 0.8, -0.58], CABIN_TINT.cushion);
  cabinBox(builder, [0.05, FLOOR + 0.62, -0.42], [0.09, FLOOR + 0.78, -0.38], CABIN_TINT.cushion);
}

// ============================================================================================
// ABILITY: the scenic cruise (Space). The autopilot tours the sites around the airship
// (airshipCruise.js); the stick or the autopilot key hands the controls back.
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Scenic cruise',
  initialState: () => ({ scenicCruise: createCruiseState(), ballonetTarget: 0.5, vectorTarget: 0, ballonet: 0.5, vectorAngle: 0 }),
  run(api) {
    const cruise = api.craftState.scenicCruise;
    api.notify(cruise.active ? stopCruise(api, true) : startCruise(api));
    return true;
  },
  update(api) {
    updateCruise(api);
  },
});

// ============================================================================================
// COPILOT: scenic cruise, ballonet trim and the vector angle by voice; the status line.
// ============================================================================================
const BALLONET_STEP = 0.25;

function describeTrim(craftState) {
  const heaviness = Number.isFinite(craftState.heaviness) ? craftState.heaviness : 0;
  if (Math.abs(heaviness) < 15) return 'neutral buoyancy';
  return `${Math.abs(heaviness)} kilograms ${heaviness > 0 ? 'heavy' : 'light'}`;
}

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'scenicCruise',
      phrases: Object.freeze(['\\bscenic (?:cruise|tour)(?: (on|off|start|stop))?\\b', '\\b(?:take|give) (?:me|us) (?:on )?(?:a|the) (?:scenic )?tour\\b']),
      run(api, value) {
        const cruise = api.craftState.scenicCruise;
        const wantOff = value === 'off' || value === 'stop';
        const wantOn = value === 'on' || value === 'start';
        if (cruise.active && (wantOff || !wantOn)) return stopCruise(api, true);
        if (cruise.active) return `Already cruising: next, the ${cruise.waypoints[cruise.index] ? cruise.waypoints[cruise.index].name : 'next site'}.`;
        if (wantOff) return 'The scenic cruise is already off.';
        return startCruise(api);
      },
    }),
    Object.freeze({
      id: 'ballonet',
      phrases: Object.freeze(['\\bballonets? (?:to |at )?(\\d{1,3}) ?(?:%|percent)?', '\\b(?:make (?:us|the ship) |go |get )(heavier|lighter)\\b', '\\b(neutral) (?:buoyancy|trim)\\b']),
      run(api, value) {
        const current = Number.isFinite(api.craftState.ballonetTarget) ? api.craftState.ballonetTarget : 0.5;
        let target = current;
        if (typeof value === 'number') target = value / 100;
        else if (value === 'heavier') target = current + BALLONET_STEP;
        else if (value === 'lighter') target = current - BALLONET_STEP;
        else if (value === 'neutral') target = 0.5;
        else return 'Say a ballonet fill, like ballonets to 60 percent.';
        target = clamp(target, 0, 1);
        api.setCraftState('ballonetTarget', target);
        const percent = Math.round(target * 100);
        const trim = target === 0.5 ? 'neutral' : target > 0.5 ? 'heavy' : 'light';
        return `Ballonets to ${percent} percent: we'll trim ${trim} as the blowers catch up.`;
      },
    }),
    Object.freeze({
      id: 'vector',
      phrases: Object.freeze(['\\bvector (?:the )?(?:props? |thrust )?(?:to )?(-?\\d{1,3}) ?(?:degrees?)?\\b', '\\b(?:props?|pods?) (up|down|forward|level)\\b']),
      run(api, value) {
        const vector = simProfile.props.vector;
        let target;
        if (typeof value === 'number') target = value;
        else if (value === 'up') target = 90;
        else if (value === 'down') target = -vector.down;
        else if (value === 'forward' || value === 'level') target = 0;
        else return 'Say a vector angle, like vector the props to 60 degrees.';
        target = clamp(target, -vector.down, vector.up);
        api.setCraftState('vectorTarget', target);
        return target === 0 ? 'Props forward.' : `Props vectored ${Math.abs(Math.round(target))} degrees ${target > 0 ? 'up' : 'down'}.`;
      },
    }),
  ]),
  status(craftState, telemetry) {
    const ballonet = Math.round((Number.isFinite(craftState.ballonet) ? craftState.ballonet : 0.5) * 100);
    const vector = Math.round(Number.isFinite(craftState.vectorAngle) ? craftState.vectorAngle : 0);
    const pressureHeight = Number.isFinite(craftState.pressureHeight) ? Math.round(craftState.pressureHeight / 10) * 10 : Math.round(STATICS.pressureHeight / 10) * 10;
    const cruise = craftState.scenicCruise;
    const cruiseText = cruise && cruise.active
      ? `Scenic cruise on, ${cruise.visited} ${cruise.visited === 1 ? 'site' : 'sites'} so far${cruise.waypoints[cruise.index] ? `, next the ${cruise.waypoints[cruise.index].name}` : ''}.`
      : 'Scenic cruise off.';
    const height = telemetry && Number.isFinite(telemetry.altitude) && telemetry.altitude > pressureHeight ? ' We are above it, so expect to sink.' : '';
    return `Ballonets at ${ballonet} percent, ${describeTrim(craftState)}, props vectored ${vector} degrees, pressure height ${pressureHeight} metres.${height} ${cruiseText}`;
  },
});

// ============================================================================================
// PLACEMENT (contract h.4): trimmed neutral at the current height, under the pressure height and
// clear of the ground, at no more than the airship's cruise.
// ============================================================================================
const SITUATE = Object.freeze({ CLEARANCE: 90, PRESSURE_MARGIN: 80, DRIFT_SPEED: 3 });

function situate(situation, api) {
  const ceiling = Math.min(api.ceiling, STATICS.pressureHeight - SITUATE.PRESSURE_MARGIN);
  const floor = situation.surfaceHeight + SITUATE.CLEARANCE;
  const height = clamp(situation.position.y, floor, Math.max(floor, ceiling));
  const speed = clamp(Number.isFinite(situation.airspeed) ? situation.airspeed : 0, 0, CRUISE_SPEED);
  const drifting = speed < SITUATE.DRIFT_SPEED;
  return {
    mode: drifting ? 'drift' : 'air',
    position: { x: situation.position.x, y: height, z: situation.position.z },
    heading: situation.heading,
    ...(drifting ? {} : { speed }),
    throttle: drifting ? 0 : Math.round(levelThrottle(simProfile, speed) * 100) / 100,
    craftState: { ballonetTarget: 0.5, vectorTarget: 0 },
  };
}

export default Object.freeze({
  id: 'airship',
  name: 'Airship',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: the throttle axis drives both props; stick and pedals work the elevators and
   * rudders (the stick's X axis steers too: an airship cannot roll); the rocker (trim) swivels the
   * pods; the HOTAS antenna, or the flap keys / buttons held, trims the ballonets.
   */
  inputProfile: Object.freeze({ throttle: 'throttle', antenna: 'ballonet', rocker: 'vector', toeBrakes: 'none', flapNotches: 0 }),
  // The standard gamepad swivels the pods on B (up) and X (down), buttons an airship has no other use for.
  bindings: Object.freeze({
    standard: Object.freeze({
      actions: Object.freeze({ airbrake: Object.freeze([]), gearToggle: Object.freeze([]) }),
      axes: Object.freeze({ trim: Object.freeze([Object.freeze({ type: 'buttonRate', positive: 1, negative: 2, rate: 0.4 })]) }),
    }),
  }),
  audioProfile: Object.freeze({
    engine: 'airshipProp', cylinders: 4, blades: PROP_BLADES, maxRpm: 2300, idleRpm: 700,
    touchdown: 'wheels', stallHorn: false, interiorCutoff: 900, airflowSpeed: 30, callouts: false,
  }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 92, height: 20, lookAhead: 36, speedRange: Object.freeze({ CRUISE: 22, MAX: 30, TOP: 36 }) }),
    // Behind the right prop pod, looking forward along the envelope.
    wing: Object.freeze({ position: Object.freeze([14, 0.5, 9]), target: Object.freeze([2, -5, -40]) }),
    fpv: null,
    // The gondola: a custom cockpit (the pilot's seat behind a raked windshield and a long window band).
    cockpit: Object.freeze({
      style: 'custom',
      build: buildGondolaCockpit,
      width: CABIN.HALF_WIDTH * 2,
      sill: CABIN.SILL,
      floor: CABIN.FLOOR,
      front: CABIN.FRONT,
      back: CABIN.BACK,
      roof: CABIN.ROOF,
      near: 0.1,
      panel: Object.freeze({
        width: 0.72,
        center: Object.freeze([0, -0.6, -0.85]),
        layout: Object.freeze([
          Object.freeze(['airspeed', 'attitude', 'altitude', 'ballonet']),
          Object.freeze(['heading', 'vsi', 'throttle']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'throttle', 'ballonet']),
  abilities: Object.freeze({ craftAbility }),
  capabilities: Object.freeze({ engine: true, chute: false, smoke: false, water: false, perch: false, space: false }),
  collision: Object.freeze({
    probes: Object.freeze([
      Object.freeze({ id: 'nose', position: Object.freeze([0, 0, -29.5]), radius: 1.6 }),
      Object.freeze({ id: 'hullFront', position: Object.freeze([0, 0, -23]), radius: 5 }),
      Object.freeze({ id: 'hullForward', position: Object.freeze([0, 0, -14]), radius: 6.6 }),
      Object.freeze({ id: 'hullMiddle', position: Object.freeze([0, 0, -4]), radius: 7.2 }),
      Object.freeze({ id: 'hullAft', position: Object.freeze([0, 0, 6]), radius: 7 }),
      Object.freeze({ id: 'hullRear', position: Object.freeze([0, 0, 15]), radius: 6 }),
      Object.freeze({ id: 'tailCone', position: Object.freeze([0, 0, 23]), radius: 4.2 }),
      Object.freeze({ id: 'tail', position: Object.freeze([0, 0, 30]), radius: 1.4 }),
      Object.freeze({ id: 'gondolaFront', position: Object.freeze([0, -9.0, -14.5]), radius: 1.5 }),
      Object.freeze({ id: 'gondolaRear', position: Object.freeze([0, -9.0, -7.5]), radius: 1.5 }),
      Object.freeze({ id: 'podLeft', position: Object.freeze([-POD_X, POD_Y, POD_Z]), radius: 1.5 }),
      Object.freeze({ id: 'podRight', position: Object.freeze([POD_X, POD_Y, POD_Z]), radius: 1.5 }),
      Object.freeze({ id: 'finLeft', position: Object.freeze([-8.4, 0, 26.5]), radius: 1.2 }),
      Object.freeze({ id: 'finRight', position: Object.freeze([8.4, 0, 26.5]), radius: 1.2 }),
      Object.freeze({ id: 'finTop', position: Object.freeze([0, 8.4, 26.5]), radius: 1.2 }),
      Object.freeze({ id: 'finBottom', position: Object.freeze([0, -8.4, 26.5]), radius: 1.2 }),
      Object.freeze({ id: 'gondolaWheel', position: Object.freeze([0, -10.55, -10]), radius: 0.4, gear: true }),
      Object.freeze({ id: 'tailWheel', position: Object.freeze([0, -10.25, 27.4]), radius: 0.4, gear: true }),
    ]),
  }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'airshipCruiseSites', label: 'Sites seen on scenic cruises', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'airshipLongestCruise', label: 'Longest scenic cruise', unit: 'seconds', op: 'max' }),
    ]),
  }),
  // Calm, slow spectacles suit a scenic cruise (contract i.2; the director reads it in branch P).
  directorProfile: Object.freeze({ favor: Object.freeze({ tags: Object.freeze({ calm: 1.4, slow: 1.4, spectacle: 1.5 }) }) }),
  spawn: Object.freeze({ cruise: CRUISE_SPEED, cruiseThrottle: CRUISE_THROTTLE, hover: false, relaunch: 'airstart', canStartOnGround: false }),
  // A soft envelope: brushing the ground under 4 m/s is a bump. The ceiling is the airframe's, well over
  // the pressure height, where the airship turns heavy on its own anyway.
  limits: Object.freeze({ vne: 36, gLimit: 2, crashSinkRate: 3, bodyStrikeSpeed: 4, floats: false, ceiling: 5000, waterLanding: null }),
});

export { SCENIC_CRUISE, STATICS as AIRSHIP_STATICS };
