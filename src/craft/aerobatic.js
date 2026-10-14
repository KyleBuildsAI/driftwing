// AEROBATIC: an Extra 330 style unlimited-category monoplane, built from code in the v1 glider's style
// (flat-shaded, vertex-coloured lofts in the v1 palette). Low tapered wing on a symmetric section with
// near-full-span ailerons carrying their spades, slab-sided fuselage under a big bubble canopy, big
// rudder and elevator, spring-steel main gear in wheel pants, tail wheel, and a three-blade prop with a
// blur disc; ailerons (spades with them), elevator, rudder, tail wheel and prop animate. Display smoke
// streams from a generator pipe under the tail as a sunlit ribbon (src/render/smokeRibbon.js) that
// hangs in the sky for 30 s, plus puffs at the nozzle; the colour cycles through SMOKE_COLORS.
//
// It flies SimFixedWing under its own model kind, 'aerobatic' (src/flight/aerobaticAssists.js: no
// attitude protections at any assist level), with the aerobaticAero extension that judges figures on
// the flight clock (src/flight/aerobaticAero.js, src/flight/maneuverRecognizer.js). Its profile
// describes the real thing: about 400 deg/s of roll, a symmetric wing that flies inverted like upright,
// +-10 g, a power-to-weight ratio past 1 at full power (prop hang, torque roll), snap rolls from a
// stalled wing with rudder and elevator, and a fuselage side force that holds a knife-edge on the rudder.
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp } from '../core/util.js';
import { createAerobaticExtension } from '../flight/aerobaticAero.js';
import { AEROBATIC_MODEL_KIND } from '../flight/aerobaticAssists.js';
import { FIGURES, figureName } from '../flight/maneuverRecognizer.js';
import { SMOKE_COLORS, smokeColorTint } from '../flight/trails.js';
import { createSmokeRibbon } from '../render/smokeRibbon.js';
import {
  PALETTE, createMeshBuilder, profileSection, mirrorPoint, getCraftMaterials, addSolid, addPivot,
  createPropDisc, createNavLights, disposeCraftMesh,
} from './kit.js';

// ============================================================================================
// SIM: an Extra 330 class aerobatic monoplane for SimFixedWing. Targets first, then the physical
// parameters that meet them, then the contact points. Positions are body axes relative to the mesh
// origin (x right, y up, z aft; m); angles in degrees. tools/lab/aerobatic.mjs measures the targets.
// ============================================================================================
const simProfile = Object.freeze({
  model: AEROBATIC_MODEL_KIND,
  extension: createAerobaticExtension,
  targets: Object.freeze({
    stallSpeed: 30, // m/s = 108 km/h, power off, upright and inverted alike
    cruiseSpeed: 85, // m/s = 306 km/h at 75 % power
    climbRate: 15, // m/s at full power
    rollRate: 400, // deg/s, full aileron at 80 m/s
    vne: 113, // m/s = 407 km/h
  }),
  mass: Object.freeze({ empty: 600, pilot: 90, fuel: 60 }), // 750 kg, 70 kg/m^2
  // kg m^2 about body x (pitch), y (yaw) and z (roll): short wings and the mass on the centreline.
  inertia: Object.freeze({ pitch: 1150, yaw: 1750, roll: 720, yawRoll: 20 }),
  centerOfMass: Object.freeze([0, 0, -0.32]),
  wing: Object.freeze({
    span: 7.5,
    area: 10.7, // 1.85 m root, 1.0 m tip, straight trailing edge
    taper: 0.54,
    oswald: 0.8,
    // A symmetric section at zero incidence: inverted flight is the mirror of upright flight.
    incidence: 0,
    // No geometric dihedral; the low wing's keel effect leaves the roll almost neutral.
    dihedral: 0.5,
    washout: 0,
    aerodynamicCenter: Object.freeze([0, -0.28, -0.2]),
    cm0: 0,
  }),
  aero: Object.freeze({
    cd0: 0.034, // spring-steel gear, wheel pants and the big canopy
    clAlpha: 4.33, // per rad (AR 5.3)
    clMax: 1.45,
    clMin: -1.45,
    alphaCritical: 19.19, // clMax / clAlpha from zero lift at zero angle of attack
    // A sharp-edged symmetric section: past the stall the lift keeps falling for 14 degrees, so the wing
    // that drops (more angle of attack) loses lift: the autorotation of a snap roll or a spin.
    postStallClDrop: 0.75,
    stallDropWidth: 14,
    stallBlendWidth: 16,
  }),
  // The stalled wing's roll-damping reversal (aerobaticAero.js): full from 1 to 14 degrees past the
  // critical angle of attack (rad), gone by 26.
  autorotation: Object.freeze({ gain: 0.25, from: 0, full: 1 * DEG, fadeFrom: 14 * DEG, fadeTo: 26 * DEG }),
  // The slab-sided fuselage, canopy and gear legs make a big side force: with rudder it holds the
  // craft up in a knife-edge at about 15 degrees of sideslip near 80 m/s.
  fuselage: Object.freeze({ sideArea: 6.4, sideForceSlope: 0.85, sideForceZ: -1.0, crossflowStations: Object.freeze([-1.9, 2.8]) }),
  tail: Object.freeze({
    horizontal: Object.freeze({ position: Object.freeze([0, 0.17, 3.6]), area: 2.4, aspectRatio: 3.6, incidence: 0, downwash: 1, wake: 0.6 }),
    vertical: Object.freeze({ position: Object.freeze([0, 0.72, 3.9]), area: 1.55, aspectRatio: 1.25, offset: -0.6, shadow: 0.5 }),
  }),
  // Big, fast surfaces (deg, matching the mesh): the ailerons give about 400 deg/s.
  controls: Object.freeze({
    aileron: 30,
    elevator: 28,
    rudder: 30,
    effectiveness: Object.freeze({ aileron: 0.52, elevator: 0.7, rudder: 0.75 }),
    trimRange: 0.35,
    servoRate: 7,
  }),
  flaps: null,
  spoilers: null,
  gear: Object.freeze({ retractable: false }),
  engine: Object.freeze({
    kind: 'piston',
    powerKw: 235, // 315 hp six-cylinder at 2700 rpm
    idlePower: 0.04,
    idleRpm: 800,
    maxRpm: 2700,
    propDiameter: 1.98,
    propEfficiency: 0.82,
    designSpeed: 70,
    // More static thrust than weight (about 1.25 : 1): the craft hangs on its prop.
    staticThrustN: 9800,
    staticFade: 22,
    spoolSeconds: 0.5,
    // On the centre of mass's waterline: a hang on the prop does not pitch the nose over.
    position: Object.freeze([0, 0, -2.72]),
    // Right-hand prop: torque rolls the craft left in a hang; the big blades' angular momentum gives the
    // gyroscopic yaw and pitch couplings of tumbles.
    rotation: 'clockwise-from-cockpit',
    propInertia: 3.2,
    pFactorArm: 0.25,
    swirl: 0.12,
    slipstreamTail: 0.7,
    slipstreamWing: 0.25,
    windmillDrag: 0.1,
  }),
  contacts: Object.freeze([
    Object.freeze({ id: 'leftMain', kind: 'wheel', gear: true, position: Object.freeze([-0.98, -1.47, -1.0]), spring: 52000, damping: 4200, rollingFriction: 0.05, sideFriction: 0.85, brake: true }),
    Object.freeze({ id: 'rightMain', kind: 'wheel', gear: true, position: Object.freeze([0.98, -1.47, -1.0]), spring: 52000, damping: 4200, rollingFriction: 0.05, sideFriction: 0.85, brake: true }),
    Object.freeze({ id: 'tailWheel', kind: 'wheel', gear: true, position: Object.freeze([0, -0.4, 4.15]), spring: 18000, damping: 1500, rollingFriction: 0.07, sideFriction: 0.7, steerable: true }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-3.76, -0.28, 0.4]) }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([3.76, -0.28, 0.4]) }),
    Object.freeze({ id: 'nose', kind: 'body', gear: false, position: Object.freeze([0, 0.03, -3.08]) }),
    Object.freeze({ id: 'propTip', kind: 'body', gear: false, position: Object.freeze([0, -0.96, -2.8]) }),
    Object.freeze({ id: 'tail', kind: 'body', gear: false, position: Object.freeze([0, 0.2, 4.3]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 1.34, 4.05]) }),
    Object.freeze({ id: 'canopyTop', kind: 'body', gear: false, position: Object.freeze([0, 0.94, -0.1]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -0.5, -0.6]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin near the centre of mass)
// ============================================================================================
// Symmetric sections as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
const SYMMETRIC_PROFILE = [[0, 0], [0.06, 0.5], [0.25, 0.62], [0.55, 0.45], [1, 0], [0.55, -0.45], [0.25, -0.62], [0.06, -0.5]];
const AILERON_HINGE = 0.75;
const SYMMETRIC_PROFILE_CUT = [[0, 0], [0.06, 0.5], [0.25, 0.62], [0.55, 0.45], [AILERON_HINGE, 0.3], [AILERON_HINGE, -0.3], [0.55, -0.45], [0.25, -0.62], [0.06, -0.5]];
const AILERON_PROFILE = [[AILERON_HINGE, 0.3], [1, 0], [AILERON_HINGE, -0.3]];
const TAIL_HINGE = 0.55;
const TAIL_PROFILE_CUT = [[0, 0], [0.08, 0.5], [0.3, 0.55], [TAIL_HINGE, 0.42], [TAIL_HINGE, -0.42], [0.3, -0.55], [0.08, -0.5]];
const TAIL_SURFACE_PROFILE = [[TAIL_HINGE, 0.42], [1, 0], [TAIL_HINGE, -0.42]];

// Wing: 1.85 m root to 1.0 m tip, straight trailing edge, low on the fuselage, square tips.
const WING = Object.freeze({ ROOT_CHORD: 1.85, TIP_CHORD: 1.0, TRAILING_EDGE: 0.9, Y: -0.28, TIP_X: 3.75, THICKNESS: 0.24 });
const AILERON_SPAN = Object.freeze([0.75, 3.55]);
/** Spanwise stations of the aileron bay: the sunburst rays alternate between them. */
const BAY_STATIONS = Object.freeze([0.75, 1.15, 1.55, 1.95, 2.35, 2.75, 3.15, 3.55]);
const SPADE = Object.freeze({ X: 2.6, HALF_SPAN: 0.17, CHORD: 0.26, DROP: 0.3, LEAD: 0.42 });
const wingChordAt = (x) => WING.ROOT_CHORD + (WING.TIP_CHORD - WING.ROOT_CHORD) * (Math.abs(x) / WING.TIP_X);
const wingLeadingEdgeAt = (x) => WING.TRAILING_EDGE - wingChordAt(x);
function wingSection(x, profile) {
  return profileSection(profile, [x, WING.Y, wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS);
}
function aileronHinge(x) {
  return [x, WING.Y, wingLeadingEdgeAt(x) + AILERON_HINGE * wingChordAt(x)];
}

function buildWingHalf(builder, side) {
  const mirror = (section) => section.map((point) => mirrorPoint(point, side));
  const isUpper = (edge) => edge < 4;
  // Root section under the cockpit, the aileron bay with the sunburst rays, the square tip.
  builder.loft([0, AILERON_SPAN[0]].map((x) => mirror(wingSection(x, SYMMETRIC_PROFILE))), (segment, edge) => (isUpper(edge) ? PALETTE.cream : PALETTE.creamShade));
  const bay = BAY_STATIONS.map((x) => mirror(wingSection(x, SYMMETRIC_PROFILE_CUT)));
  builder.loft(bay, (segment, edge) => {
    if (edge === 4) return PALETTE.charcoal;
    if (isUpper(edge)) return segment % 2 === 0 ? PALETTE.orange : PALETTE.cream;
    return PALETTE.creamShade;
  });
  const tip = [AILERON_SPAN[1], WING.TIP_X].map((x) => mirror(wingSection(x, SYMMETRIC_PROFILE)));
  builder.loft(tip, (segment, edge) => (isUpper(edge) ? PALETTE.orange : PALETTE.creamShade), { capEnd: PALETTE.charcoal });
  // Sight gauge on the tip: the triangle an aerobatic pilot lines up with the horizon on vertical lines.
  const tipX = side * (WING.TIP_X + 0.01);
  const tipLeadingEdge = wingLeadingEdgeAt(WING.TIP_X);
  builder.triangle([tipX, WING.Y + 0.05, tipLeadingEdge + 0.3], [tipX, WING.Y + 0.05, tipLeadingEdge + 0.7], [tipX, WING.Y + 0.32, tipLeadingEdge + 0.5], PALETTE.charcoal, [0, WING.Y, tipLeadingEdge + 0.5]);
}

/** An aileron with its spade (a small plate on an arm below and ahead of the hinge), hinged on its leading edge. */
function buildAileron(side) {
  const builder = createMeshBuilder();
  const stations = [AILERON_SPAN[0], (AILERON_SPAN[0] + AILERON_SPAN[1]) / 2, AILERON_SPAN[1]];
  const sections = stations.map((x) => profileSection(AILERON_PROFILE, [x, WING.Y, wingLeadingEdgeAt(x)], [0, 0, 1], [0, 1, 0], wingChordAt(x), WING.THICKNESS)
    .map((point) => mirrorPoint(point, side)));
  builder.loft(sections, (segment, edge) => (edge === 0 && segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  // The spade: a flat plate hanging below the wing ahead of the hinge line, on a thin arm.
  const hinge = aileronHinge(SPADE.X);
  const plateY = WING.Y - wingChordAt(SPADE.X) * WING.THICKNESS * 0.62 - SPADE.DROP;
  const front = hinge[2] - SPADE.LEAD;
  const back = front + SPADE.CHORD;
  const inner = SPADE.X - SPADE.HALF_SPAN;
  const outer = SPADE.X + SPADE.HALF_SPAN;
  const plate = [[inner, plateY, front], [outer, plateY, front], [outer, plateY, back], [inner, plateY, back]].map((point) => mirrorPoint(point, side));
  builder.quad(plate[0], plate[1], plate[2], plate[3], PALETTE.charcoal, mirrorPoint([SPADE.X, plateY + 1, back], side));
  builder.quad(plate[0], plate[3], plate[2], plate[1], PALETTE.charcoal, mirrorPoint([SPADE.X, plateY - 1, back], side));
  const armTop = mirrorPoint([SPADE.X, WING.Y - 0.05, hinge[2] + 0.02], side);
  const armFoot = mirrorPoint([SPADE.X, plateY, back - 0.02], side);
  buildBar(builder, armFoot, armTop, 0.012, 0.03, PALETTE.charcoal, [0, 0, 1]);
  const hingeStart = mirrorPoint(aileronHinge(AILERON_SPAN[0]), side);
  const hingeEnd = mirrorPoint(aileronHinge(AILERON_SPAN[1]), side);
  const axis = new THREE.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
  return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
}

// Fuselage stations: [z, centre y, half width, half height]; octagonal sections read as a slab-sided
// fuselage with a round cowl in front and a slim tail cone.
const FUSELAGE = [
  [-2.62, 0.02, 0.36, 0.36],
  [-2.4, 0.03, 0.43, 0.44],
  [-1.9, 0.05, 0.47, 0.5],
  [-1.2, 0.06, 0.48, 0.54],
  [-0.5, 0.05, 0.47, 0.54],
  [0.4, 0.06, 0.42, 0.5],
  [1.4, 0.1, 0.32, 0.4],
  [2.5, 0.14, 0.21, 0.29],
  [3.5, 0.17, 0.12, 0.2],
  [4.25, 0.2, 0.05, 0.1],
];
const FUSELAGE_SIDES = 8;
// Faces of the octagon loft (edge e runs from corner e to e + 1, corners at 22.5 + 45 e degrees):
// 0 upper right, 1 roof, 2 upper left, 3 left side, 4 lower left, 5 belly, 6 lower right, 7 right side.
const FACE = Object.freeze({ UPPER_RIGHT: 0, ROOF: 1, UPPER_LEFT: 2, LEFT: 3, LOWER_LEFT: 4, BELLY: 5, LOWER_RIGHT: 6, RIGHT: 7 });

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

/** The fuselage's paint: an orange cowl with a charcoal anti-glare panel, a cream body with an orange belly and side stripes. */
function fuselageTint(segment, face) {
  if (segment <= 1) return face === FACE.ROOF ? PALETTE.charcoal : PALETTE.orange;
  if (segment === 2 && face === FACE.ROOF) return PALETTE.charcoal;
  if (face === FACE.BELLY) return PALETTE.orange;
  if (face === FACE.LOWER_LEFT || face === FACE.LOWER_RIGHT) return PALETTE.creamShade;
  if ((face === FACE.LEFT || face === FACE.RIGHT) && segment >= 4 && segment <= 7) return PALETTE.orange;
  return PALETTE.cream;
}

/** Segments under the canopy, whose top faces are the cockpit deck (hidden in the cockpit view: the pilot sits in the opening). */
const DECK_SEGMENTS = Object.freeze([3, 4]);
const DECK_FACES = Object.freeze([FACE.UPPER_RIGHT, FACE.ROOF, FACE.UPPER_LEFT]);

/** The fuselage loft into `builder`, its cockpit deck faces into `deck`. */
function buildFuselage(builder, deck) {
  const sections = fuselageSections();
  const centres = sections.map((ring) => [0, 1, 2].map((axis) => ring.reduce((sum, point) => sum + point[axis], 0) / ring.length));
  for (let segment = 0; segment < sections.length - 1; segment++) {
    const inside = [0, 1, 2].map((axis) => (centres[segment][axis] + centres[segment + 1][axis]) / 2);
    for (let face = 0; face < FUSELAGE_SIDES; face++) {
      const next = (face + 1) % FUSELAGE_SIDES;
      const target = DECK_SEGMENTS.includes(segment) && DECK_FACES.includes(face) ? deck : builder;
      target.quad(sections[segment][face], sections[segment][next], sections[segment + 1][next], sections[segment + 1][face], fuselageTint(segment, face), inside);
    }
  }
  const last = sections.length - 1;
  for (let face = 0; face < FUSELAGE_SIDES; face++) {
    const next = (face + 1) % FUSELAGE_SIDES;
    builder.triangle(centres[0], sections[0][face], sections[0][next], PALETTE.charcoal, centres[1]);
    builder.triangle(centres[last], sections[last][face], sections[last][next], PALETTE.orange, centres[last - 1]);
  }
}

// Bubble canopy: [z, half width, height above the fuselage top]; arcs from sill to sill.
const CANOPY = Object.freeze({ BASE_Y: 0.48, STATIONS: Object.freeze([[-1.05, 0.2, 0.05], [-0.8, 0.36, 0.28], [-0.45, 0.42, 0.42], [-0.05, 0.43, 0.46], [0.35, 0.4, 0.42], [0.7, 0.3, 0.3], [0.95, 0.12, 0.08]]) });
const CANOPY_ARC_POINTS = 9;
function buildCanopy() {
  const builder = createMeshBuilder();
  const sections = CANOPY.STATIONS.map(([z, halfWidth, height]) => {
    const arc = [];
    for (let index = 0; index < CANOPY_ARC_POINTS; index++) {
      const angle = (index / (CANOPY_ARC_POINTS - 1)) * Math.PI;
      arc.push([halfWidth * Math.cos(angle), CANOPY.BASE_Y + height * Math.sin(angle), z]);
    }
    return arc;
  });
  builder.loft(sections, () => PALETTE.charcoal, { closed: false });
  return builder.toGeometry(null);
}

// Tail: a big fin with a rounded top and a stabilizer, both hinged at 55 % chord (big surfaces).
const FIN = Object.freeze({ BASE_Y: 0.3, TOP_Y: 1.32, THICKNESS: 0.12, HINGE_Z: 3.98 });
const finLeadingEdge = (y) => 3.12 + (0.62 * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y);
const finChord = (y) => (FIN.HINGE_Z - finLeadingEdge(y)) / TAIL_HINGE;
const STAB = Object.freeze({ Y: 0.17, HINGE_Z: 3.62, HALF_SPAN: 1.6, THICKNESS: 0.12 });
const stabChord = (x) => 1.12 - (0.4 * Math.abs(x)) / STAB.HALF_SPAN;
const stabLeadingEdge = (x) => STAB.HINGE_Z - TAIL_HINGE * stabChord(x);

function buildTail(builder) {
  const finSections = [FIN.BASE_Y, 0.95, 1.2, FIN.TOP_Y].map((y) => profileSection(TAIL_PROFILE_CUT, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(finSections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
  const stabSections = [-STAB.HALF_SPAN, -0.8, 0, 0.8, STAB.HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(stabSections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
}
function buildRudder() {
  const builder = createMeshBuilder();
  const heights = [STAB.Y + 0.09, 0.95, 1.2, FIN.TOP_Y];
  const sections = heights.map((y) => profileSection(TAIL_SURFACE_PROFILE, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS));
  builder.loft(sections, (segment) => (segment === 2 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
  const start = [0, heights[0], FIN.HINGE_Z];
  const end = [0, heights[heights.length - 1], FIN.HINGE_Z];
  return { geometry: builder.toGeometry(start), pivot: start, axis: new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize() };
}
function buildElevator() {
  const builder = createMeshBuilder();
  const stations = [-1.58, -0.8, -0.07, 0.07, 0.8, 1.58];
  const sections = stations.map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB.Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB.THICKNESS));
  builder.loft(sections, (segment) => (segment === 0 || segment === 4 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  const pivot = [0, STAB.Y, STAB.HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

/** A straight faceted bar (gear leg, strut, pipe) from a to b with a lozenge section. */
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

/** A tyre (axle along x) in charcoal with cream hubs. */
function buildWheel(builder, centre, radius, width, sides = 12) {
  const profile = [[-0.5, 0.7], [-0.35, 0.95], [0.35, 0.95], [0.5, 0.7]];
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

// Main gear: spring-steel legs from the lower longerons to the axles, wheels in streamlined pants.
const MAIN_WHEEL = Object.freeze({ X: 0.98, Y: -1.22, Z: -1.0, RADIUS: 0.25, WIDTH: 0.14 });
/** Wheel pant: [z, half width, half height] around the axle. */
const WHEEL_PANT = Object.freeze([[-1.45, 0.03, 0.04], [-1.32, 0.09, 0.16], [-1.08, 0.12, 0.23], [-0.78, 0.11, 0.21], [-0.5, 0.04, 0.07]]);
function buildGear(builder) {
  for (const side of [1, -1]) {
    buildBar(builder, [0.36 * side, -0.42, -1.12], [(MAIN_WHEEL.X - 0.1) * side, MAIN_WHEEL.Y + 0.06, MAIN_WHEEL.Z], 0.075, 0.016, PALETTE.charcoal, [0, 0, 1]);
    buildWheel(builder, [MAIN_WHEEL.X * side, MAIN_WHEEL.Y, MAIN_WHEEL.Z], MAIN_WHEEL.RADIUS, MAIN_WHEEL.WIDTH);
    const pant = WHEEL_PANT.map(([z, halfWidth, halfHeight]) => {
      const ring = [];
      for (let index = 0; index < 10; index++) {
        const angle = (index / 10) * Math.PI * 2;
        ring.push([MAIN_WHEEL.X * side + halfWidth * Math.cos(angle), MAIN_WHEEL.Y + 0.05 + halfHeight * Math.sin(angle), z]);
      }
      return ring;
    });
    builder.loft(pant, (segment) => (segment === 1 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  }
}

// Tail wheel on a leaf spring; it steers with the rudder (its own group).
const TAIL_WHEEL = Object.freeze({ Y: -0.32, Z: 4.15, RADIUS: 0.08, WIDTH: 0.05 });
function buildTailWheel() {
  const builder = createMeshBuilder();
  buildBar(builder, [0, 0.27, -0.25], [0, 0.03, 0], 0.03, 0.01, PALETTE.charcoal, [1, 0, 0]);
  buildWheel(builder, [0, 0, 0], TAIL_WHEEL.RADIUS, TAIL_WHEEL.WIDTH, 8);
  return builder.toGeometry(null);
}

// Exhaust stacks under the cowl and the smoke generator pipe under the tail cone.
const SMOKE_NOZZLE = Object.freeze([0, -0.06, 4.36]);
function buildPipes(builder) {
  for (const side of [1, -1]) buildBar(builder, [0.24 * side, -0.38, -1.7], [0.27 * side, -0.52, -1.98], 0.035, 0.035, PALETTE.charcoal);
  buildBar(builder, [0, 0.06, 3.9], [SMOKE_NOZZLE[0], SMOKE_NOZZLE[1], SMOKE_NOZZLE[2]], 0.035, 0.035, PALETTE.charcoal);
}

// Propeller: spinner and three wide composite blades with orange tips (rotates about local z).
const PROP_PIVOT = [0, 0.03, -2.66];
const PROP_PLANE_Z = -0.1;
const PROP_RADIUS = 0.99;
const PROP_BLADES = 3;
function buildPropeller() {
  const builder = createMeshBuilder();
  const spinner = [[0.02, 0.21], [-0.1, 0.2], [-0.22, 0.15], [-0.32, 0.07], [-0.36, 0]].map(([z, radius]) => {
    const ring = [];
    for (let index = 0; index < 9; index++) {
      const angle = (index / 9) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
    return ring;
  });
  builder.loft(spinner, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream });
  const bladeStations = [[0.16, 0.12, 44], [0.38, 0.19, 30], [0.62, 0.18, 21], [0.85, 0.13, 16], [PROP_RADIUS, 0.07, 13]];
  const bladeThickness = 0.026;
  for (let blade = 0; blade < PROP_BLADES; blade++) {
    const turn = (blade / PROP_BLADES) * Math.PI * 2;
    const radial = [Math.cos(turn), Math.sin(turn)];
    const tangential = [-Math.sin(turn), Math.cos(turn)];
    const sections = bladeStations.map(([radius, width, pitchDegrees]) => {
      const pitch = pitchDegrees * DEG;
      const centre = [radial[0] * radius, radial[1] * radius, PROP_PLANE_Z];
      const chordAlong = [tangential[0] * Math.cos(pitch), tangential[1] * Math.cos(pitch), -Math.sin(pitch)];
      const thickAlong = [tangential[0] * Math.sin(pitch), tangential[1] * Math.sin(pitch), Math.cos(pitch)];
      const point = (chordShare, thickShare) => [
        centre[0] + chordAlong[0] * chordShare + thickAlong[0] * thickShare,
        centre[1] + chordAlong[1] * chordShare + thickAlong[1] * thickShare,
        centre[2] + chordAlong[2] * chordShare + thickAlong[2] * thickShare,
      ];
      return [point(width * 0.5, 0), point(0, bladeThickness), point(-width * 0.5, 0), point(0, -bladeThickness)];
    });
    builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  return builder.toGeometry(null);
}

const EYE = Object.freeze([0, 0.78, -0.1]);
const SURFACE_LIMITS = Object.freeze({ aileron: simProfile.controls.aileron, elevator: simProfile.controls.elevator, rudder: simProfile.controls.rudder });
/** The tail wheel steers this far (deg) with full rudder. */
const TAIL_WHEEL_STEER = 25;
const EMPTY_STATE = Object.freeze({});

/**
 * Builds the aerobatic craft. update(visual, dt) animates the ailerons (with their spades), elevator,
 * rudder and tail wheel (visual.aileron, elevator, rudder in -1..1), the prop (visual.propSpeed in
 * rad/s, or a throttle-driven spin that winds down with the engine off) and the nav lights, and lays the
 * smoke ribbon from the nozzle while visual.craftState.smoke is on (in visual.craftState.smokeColor).
 * The ribbon hangs in the scene, not on the craft; mesh.root.userData.smokeRibbon reaches it (tests).
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'aerobatic';

  const airframe = createMeshBuilder();
  const deck = createMeshBuilder();
  buildFuselage(airframe, deck);
  buildWingHalf(airframe, 1);
  buildWingHalf(airframe, -1);
  buildTail(airframe);
  buildGear(airframe);
  buildPipes(airframe);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  // The bubble would sit around the pilot's head: the cockpit view draws its own canopy frame.
  const canopy = addSolid(root, buildCanopy(), materials.canopy);
  canopy.userData.hideInCockpit = true;
  const cockpitDeck = addSolid(root, deck.toGeometry(null), bodyMaterial);
  cockpitDeck.userData.hideInCockpit = true;

  const aileronRight = addPivot(root, buildAileron(1), bodyMaterial);
  const aileronLeft = addPivot(root, buildAileron(-1), bodyMaterial);
  const elevator = addPivot(root, buildElevator(), bodyMaterial);
  const rudder = addPivot(root, buildRudder(), bodyMaterial);
  const tailWheel = new THREE.Group();
  tailWheel.position.set(0, TAIL_WHEEL.Y, TAIL_WHEEL.Z);
  addSolid(tailWheel, buildTailWheel(), bodyMaterial);
  root.add(tailWheel);

  const propeller = new THREE.Group();
  propeller.position.set(PROP_PIVOT[0], PROP_PIVOT[1], PROP_PIVOT[2]);
  addSolid(propeller, buildPropeller(), bodyMaterial);
  const propDisc = createPropDisc(PROP_RADIUS);
  propDisc.mesh.position.z = PROP_PLANE_Z - 0.03;
  propeller.add(propDisc.mesh);
  root.add(propeller);

  const tipLeadingEdge = wingLeadingEdgeAt(WING.TIP_X);
  const navLights = createNavLights(root, {
    red: { position: [-WING.TIP_X - 0.02, WING.Y, tipLeadingEdge + 0.2], glow: [-WING.TIP_X - 0.1, WING.Y + 0.01, tipLeadingEdge + 0.15] },
    green: { position: [WING.TIP_X + 0.02, WING.Y, tipLeadingEdge + 0.2], glow: [WING.TIP_X + 0.1, WING.Y + 0.01, tipLeadingEdge + 0.15] },
    strobe: { position: [0, FIN.TOP_Y + 0.05, 3.9], glow: [0, FIN.TOP_Y + 0.13, 3.9] },
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  // The smoke ribbon lives in the scene (it stays where it was laid) and goes with the mesh.
  const ribbon = ctx.scene ? createSmokeRibbon(ctx) : null;
  root.userData.smokeRibbon = ribbon;
  const smokeAnchor = new THREE.Vector3(SMOKE_NOZZLE[0], SMOKE_NOZZLE[1], SMOKE_NOZZLE[2]);
  const nozzle = new THREE.Vector3();
  const noWind = new THREE.Vector3();
  const ribbonFrame = { emitting: false, position: nozzle, velocity: noWind, wind: noWind, tint: SMOKE_COLORS[0].tint, time: 0 };

  let propAngle = 0;
  let propSpeed = 0;

  /**
   * The ribbon from the nozzle. The flight controller updates the mesh before it moves the root, so
   * the nozzle comes from the player's pose of this frame (ctx.state.player) when there is one.
   */
  function updateSmoke(visual, dt) {
    if (!ribbon) return;
    const craftState = visual.craftState || EMPTY_STATE;
    const player = ctx.state ? ctx.state.player : null;
    if (player && player.position && player.quaternion) {
      nozzle.copy(smokeAnchor).applyQuaternion(player.quaternion).add(player.position);
      ribbonFrame.velocity = player.velocity ?? noWind;
    } else {
      nozzle.copy(smokeAnchor).applyQuaternion(root.quaternion).add(root.position);
      ribbonFrame.velocity = noWind;
    }
    const flight = ctx.state ? ctx.state.flight : null;
    ribbonFrame.wind = flight && flight.wind ? flight.wind : noWind;
    ribbonFrame.emitting = craftState.smoke === true;
    ribbonFrame.tint = smokeColorTint(craftState.smokeColor);
    ribbonFrame.time = visual.time && Number.isFinite(visual.time.elapsed) ? visual.time.elapsed : 0;
    ribbon.update(dt, ribbonFrame);
  }

  return {
    root,
    wingtips: [new THREE.Vector3(-WING.TIP_X - 0.05, WING.Y, 0.5), new THREE.Vector3(WING.TIP_X + 0.05, WING.Y, 0.5)],
    eyeAnchor,
    /** Local attachment points: the smoke pipe under the tail cone, and the tail. */
    anchors: {
      smoke: smokeAnchor,
      tail: new THREE.Vector3(0, 0.2, 4.3),
    },

    update(visual, dt) {
      // Right aileron trailing edge rises for a right roll; the mirrored hinge axis lowers the left one.
      const aileronAngle = -clamp(visual.aileron, -1, 1) * SURFACE_LIMITS.aileron * DEG;
      aileronRight.quaternion.setFromAxisAngle(aileronRight.userData.axis, aileronAngle);
      aileronLeft.quaternion.setFromAxisAngle(aileronLeft.userData.axis, aileronAngle);
      elevator.quaternion.setFromAxisAngle(elevator.userData.axis, -clamp(visual.elevator, -1, 1) * SURFACE_LIMITS.elevator * DEG);
      const rudderShare = clamp(visual.rudder, -1, 1);
      rudder.quaternion.setFromAxisAngle(rudder.userData.axis, rudderShare * SURFACE_LIMITS.rudder * DEG);
      tailWheel.rotation.y = -rudderShare * TAIL_WHEEL_STEER * DEG;

      const throttle = Number.isFinite(visual.throttle) ? visual.throttle : 0;
      const targetSpeed = Number.isFinite(visual.propSpeed) ? visual.propSpeed : visual.engineOn === false ? 0 : 9 + 24 * throttle;
      propSpeed = dt > 0 ? damp(propSpeed, targetSpeed, visual.engineOn === false ? 1.2 : 6, dt) : propSpeed;
      propAngle = (propAngle + propSpeed * dt) % (Math.PI * 2);
      if (!Number.isFinite(propAngle)) propAngle = 0;
      propeller.rotation.z = propAngle;
      propDisc.setSpeed(propSpeed > 0.5 ? propSpeed : 0);

      navLights.animate(visual.time);
      updateSmoke(visual, dt);
    },

    dispose() {
      if (ribbon) ribbon.dispose();
      root.userData.smokeRibbon = null;
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITIES: display smoke on / off (Space) and its colour (Shift+Space)
// ============================================================================================
function smokeColorName(index) {
  const colour = SMOKE_COLORS[((Number.isInteger(index) ? index : 0) % SMOKE_COLORS.length + SMOKE_COLORS.length) % SMOKE_COLORS.length];
  return colour.id;
}

function setSmoke(api, on) {
  api.setCraftState('smoke', on);
  return on ? `Smoke on, ${smokeColorName(api.craftState.smokeColor)}.` : 'Smoke off.';
}

function setSmokeColor(api, index) {
  const count = SMOKE_COLORS.length;
  api.setCraftState('smokeColor', ((index % count) + count) % count);
  return `Smoke colour ${smokeColorName(api.craftState.smokeColor)}.`;
}

const craftAbility = Object.freeze({
  label: 'Smoke',
  initialState: () => ({ smoke: false, figureInProgress: null, lastFigure: null }),
  run(api) {
    api.notify(setSmoke(api, !api.craftState.smoke));
    return true;
  },
  /** Dense puffs at the nozzle on top of the ribbon (the mesh lays the ribbon itself). */
  update(api, dt) {
    if (api.craftState.smoke) api.emitTrail('smokeColor', 'smoke', dt);
  },
});

const craftAbilityAlt = Object.freeze({
  label: 'Smoke colour',
  initialState: () => ({ smokeColor: 0 }),
  run(api) {
    const current = Number.isInteger(api.craftState.smokeColor) ? api.craftState.smokeColor : 0;
    api.notify(setSmokeColor(api, current + 1));
    return true;
  },
});

// ============================================================================================
// COPILOT: smoke, its colour, and the figures
// ============================================================================================
const COLOUR_WORDS = SMOKE_COLORS.map((colour) => colour.id).join('|');

function describeLastFigure(craftState) {
  const last = craftState && craftState.lastFigure;
  if (!last || !figureName(last.figure)) return 'No figures yet. Try a loop: full power, pull firmly, and keep the wings level over the top.';
  const verdict = last.score >= 90 ? 'Judges would love it.' : last.score >= 75 ? 'Nicely flown.' : last.score >= 50 ? 'Clean it up and the score climbs.' : 'Recognisable, but ragged.';
  return `${figureName(last.figure)}, ${last.score} points. ${verdict}`;
}

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'smoke',
      phrases: Object.freeze(['\\bsmoke (on|off)\\b', '\\b(start|stop) (?:the )?smoke\\b']),
      run(api, value) {
        const on = value === 'on' || value === 'start' || (value === undefined && !api.craftState.smoke);
        return setSmoke(api, on);
      },
    }),
    Object.freeze({
      id: 'smokeColor',
      phrases: Object.freeze([`\\b(${COLOUR_WORDS}) smoke\\b`, `\\bsmoke colou?r (${COLOUR_WORDS})\\b`, '\\b(?:next|change|cycle)(?: the)? (?:smoke )?colou?r\\b']),
      run(api, value) {
        if (typeof value === 'string') {
          const index = SMOKE_COLORS.findIndex((colour) => colour.id === value.toLowerCase());
          if (index >= 0) return setSmokeColor(api, index);
        }
        const current = Number.isInteger(api.craftState.smokeColor) ? api.craftState.smokeColor : 0;
        return setSmokeColor(api, current + 1);
      },
    }),
    Object.freeze({
      id: 'lastFigure',
      phrases: Object.freeze(['\\b(?:last|my) (?:figure|manoeuvre|maneuver)\\b', '\\bhow was (?:that|my) (?:figure|loop|roll|manoeuvre|maneuver)\\b', '\\b(?:figure|aerobatic) score\\b']),
      run(api) {
        return describeLastFigure(api.craftState);
      },
    }),
    Object.freeze({
      id: 'figures',
      phrases: Object.freeze(['\\bwhat (?:figures|manoeuvres|maneuvers|aerobatics) can (?:i|we) (?:fly|do)\\b', '\\blist (?:the )?figures\\b']),
      run() {
        const names = FIGURES.map((figure) => figure.name.toLowerCase());
        return `I judge ${names.slice(0, -1).join(', ')} and the ${names[names.length - 1]}, the last only with assists at 25 percent or less. Start each one from straight and level flight, and finish level.`;
      },
    }),
  ]),
  status(craftState, telemetry) {
    const smoke = craftState.smoke ? `Smoke on, ${smokeColorName(craftState.smokeColor)}.` : 'Smoke off.';
    const load = telemetry && Number.isFinite(telemetry.gLoad) ? ` Pulling ${telemetry.gLoad.toFixed(1)} g.` : '';
    const figure = craftState.figureInProgress ? ` That looks like a ${figureName(craftState.figureInProgress).toLowerCase()} in progress.` : '';
    return `${smoke} Last figure: ${describeLastFigure(craftState)}${figure}${load}`;
  },
});

// ============================================================================================
// INPUT: per-craft default bindings. The craft has fixed gear and no flaps, so the gear buttons of the
// gamepad and the T.16000M run the smoke colour (craftAbilityAlt) instead.
// ============================================================================================
const button = (index) => Object.freeze({ type: 'button', index });
const bindings = Object.freeze({
  standard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([button(2)]), gearToggle: Object.freeze([]) }) }),
  t16000m: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([button(4)]), gearToggle: Object.freeze([]) }) }),
});

export default Object.freeze({
  id: 'aerobatic',
  name: 'Aerobatic',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: throttle is engine power; the toe brakes brake the mains on the ground
   * (differential steers) and the rudder steers the tail wheel at taxi speed. No flaps.
   */
  inputProfile: Object.freeze({ throttle: 'throttle', flapNotches: 0, toeBrakes: 'wheels', rudderSteersTailwheel: true }),
  bindings,
  audioProfile: Object.freeze({ engine: 'aerobaticProp', cylinders: 6, idleRpm: 800, maxRpm: 2700, blades: 3, propDiameter: 1.98, exhaustRoughness: 0.45, airflowSpeed: 80, stallAoa: 17 }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: Object.freeze({ distance: 13, height: 3.2, lookAhead: 14, speedRange: Object.freeze({ CRUISE: 80, MAX: 105, TOP: 115 }) }),
    wing: Object.freeze({ position: Object.freeze([3.2, 0.4, 1.6]), target: Object.freeze([0.3, 0.3, -2.4]) }),
    fpv: null,
    // Single seat under the bubble: low sills, a short glareshield, and a small panel with the flight
    // instruments, the G meter, and the smoke and figure displays.
    cockpit: Object.freeze({
      style: 'canopy',
      width: 0.62,
      sill: -0.22,
      floor: -0.72,
      front: -0.85,
      back: 0.55,
      roof: 0.18,
      panel: Object.freeze({
        width: 0.56,
        center: Object.freeze([0, -0.3, -0.6]),
        layout: Object.freeze([
          Object.freeze(['airspeed', 'attitude', 'altitude', 'g', 'throttle']),
          Object.freeze(['aoa', 'heading', 'vsi', 'smoke', 'figure']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'throttle', 'smoke', 'figure']),
  abilities: Object.freeze({ craftAbility, craftAbilityAlt }),
  spawn: Object.freeze({ cruise: 80, cruiseThrottle: 0.7, hover: false, relaunch: 'airstart', canStartOnGround: true, runwayLength: 300 }),
  limits: Object.freeze({ vne: 113, gLimit: 10, crashSinkRate: 4, bodyStrikeSpeed: 5, floats: false }),
  capabilities: Object.freeze({ engine: true, smoke: true }),
  /**
   * After a switch: on the ground when the previous craft was, else flying on at a speed for figures
   * (55-85 m/s) on the old heading, climbing gently at full power when low.
   */
  situate(situation) {
    if ((situation.wasOnGround && !situation.wasOnWater) || (Number.isFinite(situation.agl) && situation.agl < 3 && !situation.overWater)) {
      return { mode: 'ground', flatSpot: true };
    }
    const airspeed = Number.isFinite(situation.airspeed) ? situation.airspeed : 80;
    const low = Number.isFinite(situation.agl) && situation.agl < 150;
    return { mode: 'air', speed: clamp(airspeed, 55, 85), pitch: low ? 10 : 0, throttle: low ? 1 : 0.7 };
  },
  copilot,
  journal: Object.freeze({
    stats: Object.freeze(FIGURES.map((figure) => Object.freeze({ key: figure.stat, label: `Best ${figure.name.toLowerCase()}`, unit: 'points', op: 'max' }))),
  }),
});
