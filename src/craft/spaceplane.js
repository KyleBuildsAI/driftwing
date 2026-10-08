// SPACEPLANE: a suborbital rocket plane, built from code in the v1 glider's style (flat-shaded,
// vertex-coloured lofts in the v1 palette). A lifting fuselage with the black heat-shield belly of a real
// re-entry vehicle, a low double-delta wing, a tall dorsal fin, a bell nozzle in the tail and RCS
// thruster ports in the nose, the tail and the wingtips. Animated: elevons (pitch and roll), the body flap
// (pitch trim), the split rudder (yaw, and both halves out as the speed brake), the nozzle gimbal, the
// retractable tricycle gear through its transit, rolling wheels. Effects (src/render/spaceplaneEffects.js):
// the rocket plume (tight in dense air, ballooning in vacuum), the RCS puffs and the re-entry plasma.
// Its flight profile describes a craft of the SpaceShipOne class reaching 100-120 km on a full-power
// climb through SimFixedWing, its extension (src/flight/spaceplaneAero.js: the air-augmented rocket, the
// RCS blended in as the dynamic pressure falls, wave drag, heating) and its flight control system
// (src/flight/spaceplaneFcs.js: rate command and attitude hold on the jets and surfaces, entry guidance).
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp } from '../core/util.js';
import { createSpaceplaneExtension } from '../flight/spaceplaneAero.js';
import { SPACEPLANE_MODEL_KIND } from '../flight/spaceplaneFcs.js';
import { airDensity, SEA_LEVEL_DENSITY } from '../flight/telemetry.js';
import { createSpaceplaneEffects } from '../render/spaceplaneEffects.js';
import {
  PALETTE, createMeshBuilder, profileSection, piecewise, mirrorPoint, ellipseRing, getCraftMaterials, addSolid,
  addPivot, createNavLights, disposeCraftMesh,
} from './kit.js';

/** Space begins here (the Karman line, m): the journal counts the flights that cross it. */
export const SPACE_ALTITUDE = 100000;

// ============================================================================================
// SIM: a 9 t suborbital spaceplane for SimFixedWing plus the spaceplane extension. Targets first,
// then the physical parameters that meet them, then the contact points. Positions are body axes
// relative to the mesh origin (x right, y up, z aft; m); angles in degrees. tools/lab/spaceplane.mjs
// measures the targets in flight.
// ============================================================================================
const simProfile = Object.freeze({
  // SimFixedWing under its own kind, so the spaceplane gets its flight control system as assists.
  model: SPACEPLANE_MODEL_KIND,
  targets: Object.freeze({
    apogee: Object.freeze([100000, 120000]), // m: full power, a steady climb from the 'climb' start
    stallSpeed: 56, // m/s clean at sea level
    entryAoa: 40, // degrees: the auto re-entry attitude, trimmed
    gLimit: 6,
  }),
  mass: Object.freeze({ empty: 7400, pilot: 100, fuel: 1500 }),
  // kg m^2 about body x (pitch), y (yaw) and z (roll); yawRoll is the y-z product of inertia.
  inertia: Object.freeze({ pitch: 72000, yaw: 82000, roll: 16500, yawRoll: 900 }),
  centerOfMass: Object.freeze([0, -0.08, 0.95]),
  // Hypersonic: the speed guard sits far above anything the climb reaches; Vne is an equivalent airspeed.
  maxSpeed: 2600,
  vneBasis: 'equivalent',
  gEffects: true,
  wing: Object.freeze({
    span: 9.4,
    area: 34,
    taper: 0.12,
    oswald: 0.7,
    incidence: 1,
    // A low delta: no geometric dihedral, the sweep's effective dihedral.
    dihedral: 3,
    washout: 0,
    aerodynamicCenter: Object.freeze([0, -0.35, 0.95]),
    cm0: 0,
  }),
  aero: Object.freeze({
    cd0: 0.022,
    dragCenter: Object.freeze([0, -0.2, 1.4]),
    clAlpha: 2.9, // per rad: the low-aspect delta
    clMax: 1.35, // the delta's vortex lift carries it to a high critical angle
    clMin: -0.9,
    alphaCritical: 26,
    postStallClDrop: 0.15, // the delta's vortex lift fades gently
    stallDropWidth: 8,
    stallBlendWidth: 20,
  }),
  fuselage: Object.freeze({ sideArea: 14, sideForceSlope: 0.3, sideForceZ: -2.5, crossflowStations: Object.freeze([-5.0, 5.0]) }),
  tail: Object.freeze({
    // The elevons and the body flap at the trailing edge act as the pitch surface.
    horizontal: Object.freeze({ position: Object.freeze([0, -0.4, 4.6]), area: 7, aspectRatio: 2.6, incidence: 0, downwash: 0.35, wake: 0.25 }),
    vertical: Object.freeze({ position: Object.freeze([0, 1.9, 5.3]), area: 6.4, aspectRatio: 1.3, offset: 0, shadow: 0.45 }),
  }),
  controls: Object.freeze({
    aileron: 25,
    elevator: 35,
    rudder: 25,
    effectiveness: Object.freeze({ aileron: 0.45, elevator: 1, rudder: 0.5 }),
    trimRange: 0.4,
    servoRate: 4,
  }),
  flaps: null,
  // The split rudder opens as the speed brake (the airbrake action): drag only.
  spoilers: Object.freeze({ cdIncrement: 0.07, clLoss: 0, deploySeconds: 1.5 }),
  gear: Object.freeze({ retractable: true, transitSeconds: 3, cdIncrement: 0.02 }),
  engine: null,
  extension: createSpaceplaneExtension,
  space: Object.freeze({
    engine: Object.freeze({
      coreThrust: 53000, // N: the rocket core in vacuum (0.6 of the weight)
      backPressureLoss: 0.1, // share lost to the ambient pressure at sea level
      airThrust: 2500, // N per kg/(m^2 s) of entrained air mass flow
      airFlowCap: 75, // kg/(m^2 s): the inlet's limit (rho x V)
      airFlowMinSpeed: 150, // m/s: the ejector pulls air in even when standing still
      airFadeMach: Object.freeze([4, 6]),
      ignitionSeconds: 0.25,
      shutdownSeconds: 0.15,
      position: Object.freeze([0, -0.02, 6.9]),
    }),
    rcs: Object.freeze({
      torque: Object.freeze([16000, 15000, 7000]), // N m: pitch, yaw, roll at full stick
      blendFrom: 150, // Pa: full RCS authority below this dynamic pressure
      blendTo: 6000, // Pa: the surfaces alone above it
      yawEntryAoa: Object.freeze([22, 30]), // deg: the yaw jets stay on at entry angles of attack
      yawEntryMach: Object.freeze([1.2, 2]),
    }),
    supersonic: Object.freeze({
      waveDrag: Object.freeze([[0.8, 0], [0.9, 0.004], [1.0, 0.02], [1.1, 0.028], [1.3, 0.025], [2, 0.017], [3, 0.012], [5, 0.008], [8, 0.006]]),
      supersonicInduced: 0.18,
      inducedFrom: 0.95,
      inducedFull: 1.6,
    }),
    heating: Object.freeze({
      reference: 0.9e7, // rho V^3 (W/m^2 class) at heating 1
      machFrom: 3.6, // the flow starts to glow
      machFull: 4.4,
      maxIndex: 1.4,
      lagSeconds: 2.5, // the skin's thermal lag
      buffetFrom: 0.25,
    }),
    handling: Object.freeze({
      pitchDamping: 6,
      yawDamping: 0.12,
      buffetMoment: 0.006,
      buffetTelemetry: 0.85,
      // The stall cues need air: they fade in between these dynamic pressures (Pa).
      stallPressure: Object.freeze([1500, 4000]),
    }),
    fcs: Object.freeze({
      minAirspeed: 30,
      minPower: 0.02,
      rateGain: 3,
      rateIntegral: 3,
      maxRate: Object.freeze([12, 8, 45]), // deg/s: pitch, yaw, roll
      // rad/s^2 per unit stick per Pa of dynamic pressure (pitch, yaw, roll), from the lab.
      aeroPower: Object.freeze([3.4e-4, 1.3e-4, 7.5e-4]),
      attitudeGain: 1.2,
      pathGain: 1.2,
      bankGain: 1.5,
      sideslipGain: 2,
      aoaGain: 1.0,
      aoaMargin: 3,
      levelBank: 8,
      captureDelay: 0.4,
      captureRate: 1,
      captureTimeout: 3,
      trimPressure: 2500,
      // The wing's usable lift coefficient for the airborne share (the hold's path or attitude choice).
      liftCapacity: 1.2,
      reentry: Object.freeze({
        entryAoa: 40,
        glideAoa: 14,
        aoaTrim: 10,
        maxBank: 70,
        glideMach: 3,
        glideAltitude: 25000,
        glidePressure: 2500,
        handBackMach: 1.5,
        handBackAltitude: 20000,
        glideRampSeconds: 10,
        descentRate: 20,
        autoArmAbove: 60000,
        rearmBelow: 40000,
      }),
    }),
  }),
  contacts: Object.freeze([
    Object.freeze({ id: 'noseWheel', kind: 'wheel', gear: true, retracts: true, steerable: true, steerAngle: 20, position: Object.freeze([0, -1.95, -4.2]), spring: 150000, damping: 14000, rollingFriction: 0.02, sideFriction: 0.8 }),
    Object.freeze({ id: 'leftMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([-1.3, -1.95, 1.6]), spring: 380000, damping: 30000, rollingFriction: 0.02, sideFriction: 0.85 }),
    Object.freeze({ id: 'rightMain', kind: 'wheel', gear: true, retracts: true, brake: true, position: Object.freeze([1.3, -1.95, 1.6]), spring: 380000, damping: 30000, rollingFriction: 0.02, sideFriction: 0.85 }),
    Object.freeze({ id: 'noseTip', kind: 'body', gear: false, position: Object.freeze([0, -0.1, -7.6]) }),
    Object.freeze({ id: 'chin', kind: 'body', gear: false, position: Object.freeze([0, -0.75, -4.5]) }),
    Object.freeze({ id: 'belly', kind: 'body', gear: false, position: Object.freeze([0, -0.72, 1.2]) }),
    Object.freeze({ id: 'bodyFlap', kind: 'body', gear: false, position: Object.freeze([0, -0.6, 6.8]) }),
    Object.freeze({ id: 'nozzle', kind: 'body', gear: false, position: Object.freeze([0, -0.02, 7.45]) }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-4.7, -0.35, 4.1]) }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([4.7, -0.35, 4.1]) }),
    Object.freeze({ id: 'leftStrake', kind: 'body', gear: false, position: Object.freeze([-1.6, -0.35, -1.0]) }),
    Object.freeze({ id: 'rightStrake', kind: 'body', gear: false, position: Object.freeze([1.6, -0.35, -1.0]) }),
    Object.freeze({ id: 'finTop', kind: 'body', gear: false, position: Object.freeze([0, 3.0, 6.3]) }),
    Object.freeze({ id: 'canopy', kind: 'body', gear: false, position: Object.freeze([0, 1.1, -4.4]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin on the fuselage axis)
// ============================================================================================
// Fuselage stations: [z, centre y, half width, half height] on 16-sided rings: a lifting body,
// flattened under the black heat shield.
const FUSELAGE = [
  [-7.6, -0.1, 0.03, 0.03],
  [-7.2, -0.08, 0.24, 0.2],
  [-6.4, -0.04, 0.46, 0.4],
  [-5.3, 0.0, 0.66, 0.56],
  [-4.0, 0.03, 0.8, 0.66],
  [-2.6, 0.04, 0.9, 0.72],
  [-1.0, 0.04, 0.95, 0.74],
  [1.0, 0.03, 0.95, 0.72],
  [3.0, 0.02, 0.9, 0.68],
  [4.8, 0.02, 0.82, 0.62],
  [5.8, 0.02, 0.76, 0.58],
  [6.3, 0.02, 0.72, 0.56],
];
const FUSELAGE_SIDES = 16;
function fuselageAt(z) {
  const column = (index) => FUSELAGE.map((station) => [station[0], station[index]]);
  return { centreY: piecewise(column(1), z), halfWidth: piecewise(column(2), z), halfHeight: piecewise(column(3), z) };
}

/**
 * The skin over the cockpit tub (the upper faces of the fuselage segments from z -5.3 to -2.6): a
 * separate part the cockpit view hides, so the panel down in the tub is not covered by the nose.
 */
const COCKPIT_SKIN = Object.freeze({ FROM: 3, TO: 4, FACES: Object.freeze([2, 3, 4]) });

function fuselageTint(segment, face) {
  if (segment === 0) return PALETTE.charcoal;
  // Face k spans ring angles 11.25 + 22.5 k .. + 22.5: k 3-4 the top, 11-12 the belly. The belly is
  // the black heat shield; an orange band runs along each side.
  if (face >= 9 && face <= 14) return PALETTE.charcoal;
  if (face === 8 || face === 15) return PALETTE.creamShade;
  if ((face === 0 || face === 7) && segment >= 2 && segment <= 9) return PALETTE.orange;
  return PALETTE.cream;
}

/** The fuselage into `builder`, except the skin over the cockpit tub, which goes into `cockpitSkin`. */
function buildFuselage(builder, cockpitSkin) {
  const sections = FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => {
    const ring = ellipseRing(z, centreY, halfWidth, halfHeight, FUSELAGE_SIDES, 360 / FUSELAGE_SIDES / 2);
    // Flatten the belly: the lower half of the ring rides a squashed ellipse.
    return ring.map((point) => (point[1] < centreY ? [point[0], centreY + (point[1] - centreY) * 0.72, point[2]] : point));
  });
  const { FROM, TO } = COCKPIT_SKIN;
  builder.loft(sections.slice(0, FROM + 1), fuselageTint, { capStart: PALETTE.charcoal });
  builder.loft(sections.slice(TO + 1), (segment, face) => fuselageTint(segment + TO + 1, face), { capEnd: PALETTE.charcoal });
  for (let segment = FROM; segment <= TO; segment++) {
    const front = sections[segment];
    const back = sections[segment + 1];
    const inside = [0, (FUSELAGE[segment][1] + FUSELAGE[segment + 1][1]) / 2, (FUSELAGE[segment][0] + FUSELAGE[segment + 1][0]) / 2];
    for (let face = 0; face < FUSELAGE_SIDES; face++) {
      const next = (face + 1) % FUSELAGE_SIDES;
      const target = COCKPIT_SKIN.FACES.includes(face) ? cockpitSkin : builder;
      target.quad(front[face], front[next], back[next], back[face], fuselageTint(segment, face), inside);
    }
  }
}

// Double-delta wing: a strake from the fuselage to the break, then a 58 degree main delta to the tip;
// a straight trailing edge, with the elevons cut out of it between ELEVON_SPAN.
const WING_PROFILE = [[0, 0], [0.1, 0.5], [0.4, 0.55], [0.8, 0.3], [1, 0], [0.8, -0.3], [0.4, -0.55], [0.1, -0.5]];
const WING = Object.freeze({ Y: -0.35, THICKNESS: 0.045, ROOT_X: 0.85, BREAK_X: 1.6, TIP_X: 4.7, ROOT_LE: -4.5, BREAK_LE: -1.2, SWEEP: Math.tan(58 * DEG), TE: 4.6, HINGE: 3.85 });
const ELEVON_SPAN = Object.freeze([1.25, 3.95]);
function wingLeadingEdgeAt(x) {
  if (x <= WING.BREAK_X) return WING.ROOT_LE + ((WING.BREAK_LE - WING.ROOT_LE) * (x - WING.ROOT_X)) / (WING.BREAK_X - WING.ROOT_X);
  return WING.BREAK_LE + (x - WING.BREAK_X) * WING.SWEEP;
}
/** A wing section from the leading edge to `end` (the trailing edge, or the elevon hinge). */
function wingSection(x, end) {
  const leading = wingLeadingEdgeAt(x);
  return profileSection(WING_PROFILE, [x, WING.Y, leading], [0, 0, 1], [0, 1, 0], end - leading, WING.THICKNESS);
}

function buildWingHalf(builder, side) {
  const mirror = (section) => section.map((point) => mirrorPoint(point, side));
  const tint = (edge) => (edge >= 4 ? PALETTE.charcoal : PALETTE.cream);
  // Root to the elevon cut, the elevon bay (to the hinge), and the tip outboard of it.
  builder.loft([WING.ROOT_X, ELEVON_SPAN[0]].map((x) => mirror(wingSection(x, WING.TE))), (segment, edge) => tint(edge));
  builder.loft([ELEVON_SPAN[0], ELEVON_SPAN[0]].map((x, index) => mirror(wingSection(x, index === 0 ? WING.TE : WING.HINGE))), () => PALETTE.creamShade);
  builder.loft([ELEVON_SPAN[0], 2.6, ELEVON_SPAN[1]].map((x) => mirror(wingSection(x, WING.HINGE))), (segment, edge) => (segment === 1 && edge < 2 ? PALETTE.orange : tint(edge)));
  builder.loft([ELEVON_SPAN[1], ELEVON_SPAN[1]].map((x, index) => mirror(wingSection(x, index === 0 ? WING.HINGE : WING.TE))), () => PALETTE.creamShade);
  builder.loft([ELEVON_SPAN[1], WING.TIP_X - 0.02].map((x) => mirror(wingSection(x, WING.TE))), (segment, edge) => (edge < 4 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
}

/** One elevon: a wedge from the hinge to the trailing edge, pivoting on the hinge line. */
function buildElevon(side) {
  const builder = createMeshBuilder();
  const depth = WING.TE - WING.HINGE;
  const sections = [ELEVON_SPAN[0] + 0.03, ELEVON_SPAN[1] - 0.03].map((x) => {
    const leading = wingLeadingEdgeAt(x);
    const thickness = WING.THICKNESS * (WING.TE - leading) * 0.32;
    return [[x, WING.Y + thickness, WING.HINGE], [x, WING.Y, WING.HINGE + depth], [x, WING.Y - thickness, WING.HINGE]].map((point) => mirrorPoint(point, side));
  });
  builder.loft(sections, (segment, edge) => (edge === 1 ? PALETTE.charcoal : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const pivot = mirrorPoint([ELEVON_SPAN[0], WING.Y, WING.HINGE], side);
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

/** The body flap: a black heat-shield plate under the nozzle, hinged at its front edge. */
const BODY_FLAP = Object.freeze({ HINGE_Z: 5.75, LENGTH: 1.15, HALF_WIDTH: 0.72, Y: -0.42, MAX_ANGLE: 22 });
function buildBodyFlap() {
  const builder = createMeshBuilder();
  const sections = [0, BODY_FLAP.LENGTH].map((along) => {
    const z = BODY_FLAP.HINGE_Z + along;
    const half = BODY_FLAP.HALF_WIDTH * (1 - 0.12 * (along / BODY_FLAP.LENGTH));
    return [[-half, BODY_FLAP.Y, z], [half, BODY_FLAP.Y, z], [half, BODY_FLAP.Y - 0.09, z], [-half, BODY_FLAP.Y - 0.09, z]];
  });
  builder.loft(sections, (segment, edge) => (edge === 2 ? PALETTE.charcoal : PALETTE.creamShade), { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  const pivot = [0, BODY_FLAP.Y, BODY_FLAP.HINGE_Z];
  return { geometry: builder.toGeometry(pivot), pivot, axis: new THREE.Vector3(1, 0, 0) };
}

// Dorsal fin with a split rudder on its trailing edge (the halves open apart as the speed brake).
const FIN_PROFILE = [[0, 0], [0.12, 0.45], [0.42, 0.5], [0.76, 0.3], [1, 0], [0.76, -0.3], [0.42, -0.5], [0.12, -0.45]];
const FIN_PROFILE_CUT = [[0, 0], [0.12, 0.45], [0.42, 0.5], [0.72, 0.32], [0.72, 0], [0.72, -0.32], [0.42, -0.5], [0.12, -0.45]];
const FIN = Object.freeze({ BASE_Y: 0.55, TOP_Y: 3.05, BASE_LE: 2.4, TOP_LE: 5.35, BASE_TE: 6.25, TOP_TE: 6.75, THICKNESS: 0.06, RUDDER: Object.freeze([0.75, 2.8]) });
const finLeadingEdge = (y) => FIN.BASE_LE + ((FIN.TOP_LE - FIN.BASE_LE) * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y);
const finChord = (y) => FIN.BASE_TE + ((FIN.TOP_TE - FIN.BASE_TE) * (y - FIN.BASE_Y)) / (FIN.TOP_Y - FIN.BASE_Y) - finLeadingEdge(y);
function finSection(y, profile) {
  return profileSection(profile, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN.THICKNESS);
}
function buildFin(builder) {
  builder.loft([FIN.BASE_Y, FIN.RUDDER[0]].map((y) => finSection(y, FIN_PROFILE)), () => PALETTE.cream);
  builder.loft([FIN.RUDDER[0], 1.8, FIN.RUDDER[1]].map((y) => finSection(y, FIN_PROFILE_CUT)), () => PALETTE.cream);
  builder.loft([FIN.RUDDER[1], 2.95, FIN.TOP_Y].map((y) => finSection(y, FIN_PROFILE)), (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
}
/** One half of the split rudder (side -1 left, 1 right of the fin plane), hinged on its leading edge. */
function buildRudderHalf(side) {
  const builder = createMeshBuilder();
  const heights = [FIN.RUDDER[0] + 0.02, 1.8, FIN.RUDDER[1] - 0.02];
  const sections = heights.map((y) => {
    const hinge = finLeadingEdge(y) + 0.72 * finChord(y);
    const trailing = finLeadingEdge(y) + finChord(y);
    const half = FIN.THICKNESS * finChord(y) * 0.32;
    return [[0, y, hinge], [side * half, y, hinge], [0, y, trailing]];
  });
  builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const hinge = (y) => [0, y, finLeadingEdge(y) + 0.72 * finChord(y)];
  const start = hinge(heights[0]);
  const end = hinge(heights[heights.length - 1]);
  return { geometry: builder.toGeometry(start), pivot: start, axis: new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize() };
}

// Canopy: a two-seat windscreen over the cockpit: [z, half width, height above the fuselage top].
const CANOPY = [[-6.0, 0.1, 0.02], [-5.6, 0.36, 0.2], [-5.0, 0.5, 0.36], [-4.4, 0.54, 0.42], [-3.7, 0.5, 0.36], [-3.1, 0.34, 0.2], [-2.7, 0.1, 0.04]];
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

/** A straight faceted bar from a to b (gear legs, frames) with a lozenge section. */
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
/** The canopy frame bows and the crew's two helmets (seen from outside). */
function buildCanopyDetail(builder) {
  for (const z of [-5.0, -3.75]) {
    const bow = canopyArc(z, CANOPY.find((station) => station[0] === z)?.[1] ?? 0.5, CANOPY.find((station) => station[0] === z)?.[2] ?? 0.36, 0.02);
    for (let index = 0; index < bow.length - 1; index++) buildBar(builder, bow[index], bow[index + 1], 0.035, 0.03, PALETTE.charcoal);
  }
  for (const z of [EYE[2] + 0.12, EYE[2] + 1.3]) {
    const centre = [0, EYE[1] + 0.04, z];
    const rings = [[-0.14, 0.02], [-0.1, 0.1], [0, 0.14], [0.1, 0.12], [0.16, 0.05]].map(([offset, radius]) => ellipseRing(centre[2] + offset, centre[1], radius, radius * 1.1, 8, 22.5));
    builder.loft(rings, (segment, face) => (segment === 1 && face >= 4 && face <= 7 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  }
}

// The engine: a bell nozzle on a gimbal at the tail, its throat inside the aft fuselage.
const NOZZLE = Object.freeze({ GIMBAL_Z: 6.2, Y: -0.02, THROAT: 0.28, EXIT: 0.62, LENGTH: 1.25, MAX_GIMBAL: 5 });
function buildNozzle() {
  const builder = createMeshBuilder();
  const stations = [[0, NOZZLE.THROAT * 1.3], [0.18, NOZZLE.THROAT], [0.55, NOZZLE.THROAT + (NOZZLE.EXIT - NOZZLE.THROAT) * 0.55], [NOZZLE.LENGTH, NOZZLE.EXIT]];
  const outer = stations.map(([z, radius]) => ellipseRing(z, 0, radius, radius, 18));
  builder.loft(outer, (segment) => (segment === 3 ? PALETTE.charcoal : PALETTE.creamShade));
  // The bell's inner wall, dark, so the inside reads from behind.
  const inner = stations.slice(1).map(([z, radius]) => ellipseRing(z, 0, radius * 0.93, radius * 0.93, 18)).reverse();
  builder.loft(inner, () => PALETTE.charcoal);
  return builder.toGeometry(null);
}
/** The RCS ports: small dark blocks where the thrusters fire. */
function buildRcsPorts(builder) {
  for (const thruster of RCS_THRUSTERS) {
    const [x, y, z] = thruster.position;
    const size = 0.07;
    const sections = [[z - size, size], [z + size, size]].map(([at, half]) => [[x - half, y - half, at], [x + half, y - half, at], [x + half, y + half, at], [x - half, y + half, at]]);
    builder.loft(sections, () => PALETTE.charcoal, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  }
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

// Landing gear: legs pivot at their top; the nose leg swings forward into the nose, the mains forward
// into the wing roots.
const NOSE_GEAR = Object.freeze({ PIVOT: Object.freeze([0, -0.45, -4.0]), AXLE: Object.freeze([0, -1.65, -4.2]), RADIUS: 0.3, WIDTH: 0.2, RETRACT: -100 * DEG });
const MAIN_GEAR = Object.freeze({ PIVOT: Object.freeze([1.3, -0.45, 1.25]), AXLE: Object.freeze([1.3, -1.57, 1.6]), RADIUS: 0.38, WIDTH: 0.24, RETRACT: -100 * DEG });

function buildGearLeg(root, material, spec, side, wheelGeometry) {
  const pivotPoint = [spec.PIVOT[0] * side, spec.PIVOT[1], spec.PIVOT[2]];
  const axle = [spec.AXLE[0] * side, spec.AXLE[1], spec.AXLE[2]];
  const local = [axle[0] - pivotPoint[0], axle[1] - pivotPoint[1], axle[2] - pivotPoint[2]];
  const pivot = new THREE.Group();
  pivot.position.set(pivotPoint[0], pivotPoint[1], pivotPoint[2]);
  root.add(pivot);
  const legBuilder = createMeshBuilder();
  buildBar(legBuilder, [0, 0.05, 0], local, 0.055, 0.055, PALETTE.charcoal, [0, 0, 1]);
  buildBar(legBuilder, [local[0] * 0.45, local[1] * 0.45, local[2] * 0.45 + 0.12], [local[0], local[1] + 0.18, local[2] + 0.1], 0.025, 0.025, PALETTE.creamShade);
  addSolid(pivot, legBuilder.toGeometry(null), material);
  const wheel = new THREE.Group();
  wheel.position.set(local[0], local[1], local[2]);
  pivot.add(wheel);
  addSolid(wheel, wheelGeometry, material);
  return { pivot, wheel, radius: spec.RADIUS };
}

const EYE = Object.freeze([0, 1.0, -4.55]);
const TIP = Object.freeze([WING.TIP_X, WING.Y, 4.05]);

/**
 * The RCS thrusters (each fires its puff along `direction` when its axis command has `sign`): nose and
 * tail jets pitch and yaw the craft, wingtip jets roll it. Exhaust directions: a pitch-up command fires
 * the nose jets down and the tail jets up; yaw right, the nose jets left and the tail jets right; roll
 * right, the right tip's jet up and the left tip's down.
 */
const RCS_THRUSTERS = Object.freeze([
  Object.freeze({ position: [0, -0.42, -6.1], direction: [0, -1, 0], axis: 'pitch', sign: 1 }),
  Object.freeze({ position: [0, 0.36, -6.2], direction: [0, 1, 0], axis: 'pitch', sign: -1 }),
  Object.freeze({ position: [-0.72, 0.62, 5.95], direction: [0, 1, 0], axis: 'pitch', sign: 1 }),
  Object.freeze({ position: [0.72, 0.62, 5.95], direction: [0, 1, 0], axis: 'pitch', sign: 1 }),
  Object.freeze({ position: [-0.72, -0.4, 5.95], direction: [0, -1, 0], axis: 'pitch', sign: -1 }),
  Object.freeze({ position: [0.72, -0.4, 5.95], direction: [0, -1, 0], axis: 'pitch', sign: -1 }),
  Object.freeze({ position: [-0.5, 0.0, -6.0], direction: [-1, 0, 0], axis: 'yaw', sign: 1 }),
  Object.freeze({ position: [0.5, 0.0, -6.0], direction: [1, 0, 0], axis: 'yaw', sign: -1 }),
  Object.freeze({ position: [0.78, 0.1, 6.05], direction: [1, 0, 0], axis: 'yaw', sign: 1 }),
  Object.freeze({ position: [-0.78, 0.1, 6.05], direction: [-1, 0, 0], axis: 'yaw', sign: -1 }),
  Object.freeze({ position: [4.45, -0.3, 3.95], direction: [0, 1, 0], axis: 'roll', sign: 1 }),
  Object.freeze({ position: [4.45, -0.4, 3.95], direction: [0, -1, 0], axis: 'roll', sign: -1 }),
  Object.freeze({ position: [-4.45, -0.3, 3.95], direction: [0, 1, 0], axis: 'roll', sign: -1 }),
  Object.freeze({ position: [-4.45, -0.4, 3.95], direction: [0, -1, 0], axis: 'roll', sign: 1 }),
]);

const SURFACE_LIMITS = Object.freeze({ aileron: simProfile.controls.aileron, elevator: simProfile.controls.elevator, rudder: simProfile.controls.rudder });
const GEAR_TRANSIT_SECONDS = simProfile.gear.transitSeconds;
/** Split rudder halves open this far (degrees each) as the speed brake. */
const SPEED_BRAKE_ANGLE = 42;

/** The plume's expansion (0 dense .. 1 vacuum) from the density ratio at the craft. */
function plumeExpansion(altitude) {
  const ratio = airDensity(altitude) / SEA_LEVEL_DENSITY;
  return clamp(1 - Math.pow(ratio, 0.25) * 1.6, 0, 1);
}

/**
 * Builds the spaceplane. update(visual, dt) animates the elevons (visual.elevator and visual.aileron),
 * the body flap (pitch trim and elevator), the split rudder (visual.rudder, and visual.airbrake opening
 * both halves), the nozzle gimbal (the stick), the gear and wheels, and the effects from
 * state.flight.craftState (thrust level, RCS jets, heating) and the air flow.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'spaceplane';
  const flight = ctx.state.flight;

  const airframe = createMeshBuilder();
  const cockpitSkinBuilder = createMeshBuilder();
  buildFuselage(airframe, cockpitSkinBuilder);
  buildWingHalf(airframe, 1);
  buildWingHalf(airframe, -1);
  buildFin(airframe);
  buildRcsPorts(airframe);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);
  const cockpitSkin = addSolid(root, cockpitSkinBuilder.toGeometry(null), bodyMaterial);
  cockpitSkin.userData.hideInCockpit = true;

  const canopy = addSolid(root, buildCanopy(), materials.canopy);
  canopy.userData.hideInCockpit = true;
  const canopyDetail = createMeshBuilder();
  buildCanopyDetail(canopyDetail);
  const crew = addSolid(root, canopyDetail.toGeometry(null), bodyMaterial);
  crew.userData.hideInCockpit = true;

  const elevonRight = addPivot(root, buildElevon(1), bodyMaterial);
  const elevonLeft = addPivot(root, buildElevon(-1), bodyMaterial);
  const bodyFlap = addPivot(root, buildBodyFlap(), bodyMaterial);
  const rudderRight = addPivot(root, buildRudderHalf(1), bodyMaterial);
  const rudderLeft = addPivot(root, buildRudderHalf(-1), bodyMaterial);

  const gimbal = new THREE.Group();
  gimbal.position.set(0, NOZZLE.Y, NOZZLE.GIMBAL_Z);
  root.add(gimbal);
  addSolid(gimbal, buildNozzle(), bodyMaterial);

  const noseWheelGeometry = buildWheelGeometry(NOSE_GEAR.RADIUS, NOSE_GEAR.WIDTH);
  const mainWheelGeometry = buildWheelGeometry(MAIN_GEAR.RADIUS, MAIN_GEAR.WIDTH);
  const noseLeg = buildGearLeg(root, bodyMaterial, NOSE_GEAR, 0, noseWheelGeometry);
  const mainLegs = [1, -1].map((side) => buildGearLeg(root, bodyMaterial, MAIN_GEAR, side, mainWheelGeometry));

  const navLights = createNavLights(root, {
    red: { position: [-TIP[0], TIP[1] + 0.06, 3.9], glow: [-TIP[0] - 0.08, TIP[1] + 0.1, 3.85] },
    green: { position: [TIP[0], TIP[1] + 0.06, 3.9], glow: [TIP[0] + 0.08, TIP[1] + 0.1, 3.85] },
    strobe: { position: [0, FIN.TOP_Y + 0.05, 6.4], glow: [0, FIN.TOP_Y + 0.13, 6.4] },
  });

  const effects = createSpaceplaneEffects(ctx, root, {
    nozzle: { z: NOZZLE.GIMBAL_Z + NOZZLE.LENGTH, y: NOZZLE.Y, radius: NOZZLE.EXIT, depth: NOZZLE.LENGTH },
    thrusters: RCS_THRUSTERS,
    plasma: { centre: [0, -0.2, -0.3], radii: [5.0, 1.3, 8.3] },
  });
  // Test and debug readout of the effect levels (plume, expansion, puffs, plasma).
  root.userData.spaceplaneEffects = effects;

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(EYE[0], EYE[1], EYE[2]);
  root.add(eyeAnchor);

  let gearPosition = NaN;
  let wheelAngle = 0;
  let brakeAngle = 0;
  let flapAngle = 0;
  const jets = { pitch: 0, yaw: 0, roll: 0 };
  const flow = new THREE.Vector3(0, 0, 1);
  const inverse = new THREE.Quaternion();
  const effectFrame = { dt: 0, thrust: 0, expansion: 0, jets, heating: 0, flow, engineOn: true };

  function poseGear(position) {
    const extension = clamp(position, 0, 1);
    const retract = 1 - extension;
    noseLeg.pivot.rotation.x = NOSE_GEAR.RETRACT * retract;
    for (const leg of mainLegs) leg.pivot.rotation.x = MAIN_GEAR.RETRACT * retract;
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
      nozzle: new THREE.Vector3(0, NOZZLE.Y, NOZZLE.GIMBAL_Z + NOZZLE.LENGTH),
      tail: new THREE.Vector3(0, 0.4, 6.6),
    },

    update(visual, dt) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const craftState = flight.craftState || {};
      const roll = clamp(Number.isFinite(visual.aileron) ? visual.aileron : 0, -1, 1);
      const pitch = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1);
      const yaw = clamp(Number.isFinite(visual.rudder) ? visual.rudder : 0, -1, 1);

      // Elevons: pitch together (trailing edge up for nose up), roll differentially.
      elevonRight.quaternion.setFromAxisAngle(elevonRight.userData.axis, (pitch * SURFACE_LIMITS.elevator - roll * SURFACE_LIMITS.aileron) * DEG);
      elevonLeft.quaternion.setFromAxisAngle(elevonLeft.userData.axis, (pitch * SURFACE_LIMITS.elevator + roll * SURFACE_LIMITS.aileron) * DEG);
      // Body flap: trims with the pitch trim and follows a share of the elevator.
      const trim = clamp(Number.isFinite(flight.trim) ? flight.trim : 0, -1, 1);
      const flapTarget = clamp(trim * 0.7 + pitch * 0.3, -1, 1) * BODY_FLAP.MAX_ANGLE * DEG;
      flapAngle = step > 0 ? damp(flapAngle, flapTarget, 3, step) : flapTarget;
      bodyFlap.quaternion.setFromAxisAngle(bodyFlap.userData.axis, flapAngle);
      // Split rudder: both halves swing with the rudder; the speed brake opens them apart.
      const airbrake = clamp(Number.isFinite(visual.airbrake) ? visual.airbrake : 0, 0, 1);
      brakeAngle = airbrake * SPEED_BRAKE_ANGLE * DEG;
      const rudderAngle = yaw * SURFACE_LIMITS.rudder * DEG;
      rudderRight.quaternion.setFromAxisAngle(rudderRight.userData.axis, rudderAngle + brakeAngle);
      rudderLeft.quaternion.setFromAxisAngle(rudderLeft.userData.axis, rudderAngle - brakeAngle);
      // Nozzle gimbal: a few degrees with the stick.
      gimbal.rotation.x = -pitch * NOZZLE.MAX_GIMBAL * DEG;
      gimbal.rotation.y = -yaw * NOZZLE.MAX_GIMBAL * DEG;

      // Gear: follows the gear lever through the transit time.
      const gearTarget = visual.gearDown !== false ? 1 : 0;
      if (!Number.isFinite(gearPosition)) gearPosition = gearTarget;
      else if (step > 0) gearPosition = gearTarget > gearPosition ? Math.min(gearTarget, gearPosition + step / GEAR_TRANSIT_SECONDS) : Math.max(gearTarget, gearPosition - step / GEAR_TRANSIT_SECONDS);
      poseGear(gearPosition);
      if (visual.onGround && Number.isFinite(visual.groundSpeed) && step > 0) {
        wheelAngle = (wheelAngle - (visual.groundSpeed / MAIN_GEAR.RADIUS) * step) % (Math.PI * 2);
        for (const leg of mainLegs) leg.wheel.rotation.x = wheelAngle;
        noseLeg.wheel.rotation.x = (wheelAngle * MAIN_GEAR.RADIUS) / NOSE_GEAR.RADIUS;
      }

      // Effects: thrust, the RCS jets, the heating and the air flow in the craft's frame.
      jets.pitch = Number.isFinite(craftState.rcsPitch) ? craftState.rcsPitch : 0;
      jets.yaw = Number.isFinite(craftState.rcsYaw) ? craftState.rcsYaw : 0;
      jets.roll = Number.isFinite(craftState.rcsRoll) ? craftState.rcsRoll : 0;
      if (flight.airVelocity && flight.airspeed > 1) {
        inverse.copy(root.quaternion).invert();
        flow.copy(flight.airVelocity).normalize().applyQuaternion(inverse).negate();
      }
      effectFrame.dt = step;
      effectFrame.thrust = Number.isFinite(craftState.thrustLevel) ? craftState.thrustLevel : clamp(Number.isFinite(visual.throttle) ? visual.throttle : 0, 0, 1);
      effectFrame.expansion = plumeExpansion(Number.isFinite(flight.altitude) ? flight.altitude : 0);
      effectFrame.heating = Number.isFinite(craftState.heating) ? craftState.heating : 0;
      effectFrame.engineOn = visual.engineOn !== false;
      effects.update(effectFrame);
      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}


// ============================================================================================
// FLIGHT LOG: space crossings, apogees, the re-entry phases with the comms blackout, the journal
// stats and the copilot's lines. Runs once per frame from the ability update; its memory lives per
// craft state (a new flight in the spaceplane starts a new log).
// ============================================================================================
const REENTRY = Object.freeze({
  /** The re-entry begins (heating), the plasma cuts the link (blackout) and lets it go (with hysteresis). */
  heatingOn: 0.22,
  blackoutOn: 0.55,
  blackoutOff: 0.38,
  clearSeconds: 1.5,
  /** An arc that went above this (m) comes back as a re-entry. */
  highArc: 60000,
  /** Below this, climbing again, a new arc starts. */
  newArcBelow: 30000,
  /** Space crossings re-arm below this (m). */
  spaceRearm: 95000,
  buffetShake: 1.4,
});
const logs = new WeakMap();

function logFor(craftState) {
  let log = logs.get(craftState);
  if (!log) {
    log = { inSpace: false, highArc: false, phase: 'none', clearSeconds: 0, lastVerticalSpeed: 0, peakMach: 0, machArmed: true };
    logs.set(craftState, log);
  }
  return log;
}

function kilometres(metres) {
  return `${Math.round(metres / 1000)} km`;
}

/** WREN speaks a line (silent during the blackout: the copilot drops it to static). */
function copilotSay(api, text) {
  const copilot = api.systems ? api.systems.copilot : null;
  if (copilot && typeof copilot.speak === 'function') copilot.speak(text);
}

function setBlackout(craftState, active) {
  craftState.blackout = active;
  craftState.commsBlackout = active;
}

function updateFlightLog(api, dt) {
  const craftState = api.craftState;
  const telemetry = api.telemetry;
  const log = logFor(craftState);
  const bus = api.bus;
  if (telemetry.crash && telemetry.crash.active) {
    if (log.phase === 'blackout') setBlackout(craftState, false);
    log.phase = 'none';
    log.highArc = false;
    return;
  }
  const altitude = telemetry.altitude;
  const climb = telemetry.verticalSpeed;
  if (!Number.isFinite(altitude) || !Number.isFinite(climb)) return;
  craftState.maxAltitude = Math.max(Number.isFinite(craftState.maxAltitude) ? craftState.maxAltitude : 0, altitude);

  // Space: the Karman line, once per crossing.
  if (!log.inSpace && altitude >= SPACE_ALTITUDE) {
    log.inSpace = true;
    bus.emitTyped('journalStat', { key: 'spaceplaneSpaceFlights', value: 1, op: 'add' });
    api.notify('Space: 100 km.', 'success');
    copilotSay(api, "We're in space. Look at that horizon curve. The sky's black and the stars are out in daylight.");
  } else if (log.inSpace && altitude < REENTRY.spaceRearm) {
    log.inSpace = false;
  }
  // Apogee: the top of every arc above the airliners.
  if (log.lastVerticalSpeed > 0 && climb <= 0 && altitude > 20000) {
    bus.emitTyped('journalStat', { key: 'spaceplaneApogee', value: Math.round(altitude), op: 'max' });
    api.notify(`Apogee ${kilometres(altitude)}.`, 'info');
  }
  log.lastVerticalSpeed = climb;
  if (altitude > REENTRY.highArc) {
    log.highArc = true;
    // Back in space (a new climb, or a relaunch high up): the next way down is a new re-entry.
    if (log.phase === 'clear') log.phase = 'none';
  }
  if (climb > 0 && altitude < REENTRY.newArcBelow) {
    log.highArc = false;
    if (log.phase !== 'none' && log.phase !== 'blackout') log.phase = 'none';
  }
  // The fastest Mach of each acceleration goes to the journal once it is past (no toast per tenth).
  const mach = Number.isFinite(telemetry.mach) ? telemetry.mach : 0;
  if (log.machArmed) {
    log.peakMach = Math.max(log.peakMach, mach);
    if (log.peakMach > 1 && mach < log.peakMach - 0.3) {
      bus.emitTyped('journalStat', { key: 'spaceplaneMaxMach', value: Math.round(log.peakMach * 10) / 10, op: 'max' });
      log.machArmed = false;
      log.peakMach = mach;
    }
  } else {
    // Re-armed once the craft accelerates again from its slowest since.
    log.peakMach = Math.min(log.peakMach, mach);
    if (mach > log.peakMach + 0.3) log.machArmed = true;
  }

  // Re-entry: heating, then the blackout, then the link comes back.
  const heating = Number.isFinite(craftState.heating) ? craftState.heating : 0;
  if (log.highArc && climb < 0) {
    if (log.phase === 'none' && heating > REENTRY.heatingOn) {
      log.phase = 'heating';
      bus.emitTyped('reentry', { phase: 'heating', heating });
      copilotSay(api, `Entry interface at ${kilometres(altitude)}. It's going to get warm, and the plasma will cut us off for a bit. See you on the other side.`);
    } else if (log.phase === 'heating' && heating > REENTRY.blackoutOn) {
      log.phase = 'blackout';
      log.clearSeconds = 0;
      setBlackout(craftState, true);
      bus.emitTyped('reentry', { phase: 'blackout', heating });
    }
  }
  if (log.phase === 'blackout') {
    log.clearSeconds = heating < REENTRY.blackoutOff ? log.clearSeconds + dt : 0;
    if (log.clearSeconds >= REENTRY.clearSeconds || telemetry.onGround) {
      log.phase = 'clear';
      setBlackout(craftState, false);
      bus.emitTyped('reentry', { phase: 'clear', heating });
      bus.emitTyped('journalStat', { key: 'spaceplaneReentries', value: 1, op: 'add' });
      copilotSay(api, `WREN here, reading you again. Blackout's over: Mach ${mach.toFixed(1)} at ${kilometres(altitude)}. Nice entry. Let's glide her home.`);
    }
  } else if (log.phase === 'heating' && heating < REENTRY.heatingOn * 0.5) {
    log.phase = 'clear';
    bus.emitTyped('reentry', { phase: 'clear', heating });
    bus.emitTyped('journalStat', { key: 'spaceplaneReentries', value: 1, op: 'add' });
  }
  craftState.reentry = log.phase;

  // Buffeting: the chase camera feels the shock layer too (the airframe's own buffet is in the model).
  const buffet = smoothBuffet(heating);
  if (buffet > 0 && api.systems && api.systems.camera && typeof api.systems.camera.shake === 'function') {
    api.systems.camera.shake(buffet * REENTRY.buffetShake * dt);
  }
}

function smoothBuffet(heating) {
  const t = clamp((heating - 0.25) / 0.75, 0, 1);
  return t * t * (3 - 2 * t);
}

// ============================================================================================
// ABILITIES: Space arms or disarms the auto re-entry guidance (and runs the flight log every
// frame); Shift+Space toggles attitude hold (hands off holds the attitude at any assist level).
// ============================================================================================
function setAutoReentry(api, armed) {
  api.setCraftState('autoReentry', armed);
  if (!armed) api.setCraftState('reentryPhase', 'off');
}

const craftAbility = Object.freeze({
  label: 'Auto re-entry',
  initialState: () => ({
    autoReentry: false, reentryPhase: 'off', reentry: 'none', blackout: false, commsBlackout: false,
    apogee: null, dynamicPressure: 0, rcsBlend: 1, heating: 0, mach: 0, thrust: 0, thrustLevel: 0,
    rcsPitch: 0, rcsYaw: 0, rcsRoll: 0, maxAltitude: 0,
  }),
  run(api) {
    const armed = api.craftState.autoReentry !== true;
    setAutoReentry(api, armed);
    api.notify(armed ? 'Auto re-entry armed: 40 degrees nose up on the way down.' : 'Auto re-entry off.', armed ? 'success' : 'info');
    return true;
  },
  update(api, dt) {
    updateFlightLog(api, dt);
  },
});

const craftAbilityAlt = Object.freeze({
  label: 'Attitude hold',
  initialState: () => ({ attitudeHold: false }),
  run(api) {
    const holding = api.craftState.attitudeHold !== true;
    api.setCraftState('attitudeHold', holding);
    api.notify(holding ? 'Attitude hold on: hands off holds the attitude.' : 'Attitude hold off.', holding ? 'success' : 'info');
    return true;
  },
});

// ============================================================================================
// COPILOT: WREN's spaceplane commands and status line.
// ============================================================================================
/** On / off from a captured word ('on', 'arm', 'hold' are on; 'off', 'disarm', 'release' are off). */
function switchValue(value, current) {
  if (typeof value === 'boolean') return value;
  const word = String(value ?? '').toLowerCase();
  if (['on', 'arm', 'hold', 'engage'].includes(word)) return true;
  if (['off', 'disarm', 'release', 'disengage'].includes(word)) return false;
  return !current;
}

function apogeeLine(craftState, telemetry) {
  if (Number.isFinite(craftState.apogee)) {
    const above = craftState.apogee >= SPACE_ALTITUDE ? "That's space." : `${kilometres(SPACE_ALTITUDE - craftState.apogee)} short of space.`;
    return `Predicted apogee ${kilometres(craftState.apogee)}. ${above}`;
  }
  return `We're coming down: ${kilometres(Number.isFinite(telemetry.altitude) ? telemetry.altitude : 0)} and descending, no apogee ahead.`;
}

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'autoReentry',
      phrases: Object.freeze(['\\bauto(?:matic)?[ -]?re-?entry (on|off)\\b', '\\b(arm|disarm) (?:the )?(?:auto(?:matic)? )?re-?entry\\b']),
      run(api, value) {
        const armed = switchValue(value, api.craftState.autoReentry === true);
        setAutoReentry(api, armed);
        return armed ? "Auto re-entry armed. I'll hold forty degrees nose up through the heat." : 'Auto re-entry off. Your attitude on the way down.';
      },
    }),
    Object.freeze({
      id: 'attitudeHold',
      phrases: Object.freeze(['\\battitude hold (on|off)\\b', '\\b(hold|release) (?:the |our |this )?attitude\\b']),
      run(api, value) {
        const holding = switchValue(value, api.craftState.attitudeHold === true);
        api.setCraftState('attitudeHold', holding);
        return holding ? 'Attitude hold on. Let go and the jets keep her pointed.' : 'Attitude hold off.';
      },
    }),
    Object.freeze({
      id: 'apogee',
      phrases: Object.freeze(["\\b(?:what(?:'s| is) (?:our |the )?)?(?:predicted )?apogee\\b", '\\bhow high (?:will|are) we (?:get|go|going)\\b']),
      run(api) {
        return apogeeLine(api.craftState, api.telemetry);
      },
    }),
    Object.freeze({
      id: 'mach',
      phrases: Object.freeze(["\\bwhat(?:'s| is) (?:our |the )?mach(?: number)?\\b", '\\bhow many mach\\b']),
      run(api) {
        const mach = Number.isFinite(api.telemetry.mach) ? api.telemetry.mach : 0;
        return `Mach ${mach.toFixed(1)} at ${kilometres(Number.isFinite(api.telemetry.altitude) ? api.telemetry.altitude : 0)}.`;
      },
    }),
  ]),
  status(craftState, telemetry) {
    const mach = Number.isFinite(telemetry.mach) ? telemetry.mach : 0;
    const altitude = Number.isFinite(telemetry.altitude) ? telemetry.altitude : 0;
    const parts = [`Mach ${mach.toFixed(1)} at ${kilometres(altitude)}, ${telemetry.verticalSpeed >= 0 ? 'climbing' : 'descending'}.`];
    if (Number.isFinite(craftState.apogee)) parts.push(`Apogee ${kilometres(craftState.apogee)}.`);
    parts.push(`Reaction control ${Math.round((Number.isFinite(craftState.rcsBlend) ? craftState.rcsBlend : 0) * 100)} percent.`);
    if (craftState.heating > 0.05) parts.push(`Heating ${Math.round(craftState.heating * 100)} percent.`);
    if (craftState.autoReentry) parts.push(craftState.reentryPhase === 'entry' ? 'Holding entry attitude.' : craftState.reentryPhase === 'glide' ? 'Hypersonic glide.' : 'Auto re-entry armed.');
    if (craftState.attitudeHold) parts.push('Attitude hold on.');
    return parts.join(' ');
  },
});

// ============================================================================================
// PLACEMENT: after a craft switch the spaceplane climbs (contract h.4): 45 degrees at 250 m/s on full
// thrust, lifted clear of the ground when low.
// ============================================================================================
const CLIMB_START = Object.freeze({ pitch: 45, speed: 250, minAgl: 600 });

function situate(situation) {
  const position = { x: situation.position.x, y: situation.position.y, z: situation.position.z };
  if (!(situation.agl >= CLIMB_START.minAgl)) position.y = situation.surfaceHeight + CLIMB_START.minAgl;
  return { mode: 'climb', position, heading: situation.heading, pitch: CLIMB_START.pitch, speed: CLIMB_START.speed, throttle: 1 };
}

export default Object.freeze({
  id: 'spaceplane',
  name: 'Spaceplane',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: the throttle is the rocket's thrust (no idle: 0 is engine off); the stick
   * and pedals fly the elevons and the rudder in the air and fire the RCS jets as the air thins (the
   * pedals fire the yaw jets); gearToggle cycles the gear; the airbrake opens the split rudder; toe
   * brakes brake the mains and the rudder steers the nose wheel at taxi speed.
   */
  inputProfile: Object.freeze({ throttle: 'rocket', flapNotches: 0, toeBrakes: 'wheels', rudderSteersTailwheel: true }),
  bindings: Object.freeze({
    // The gamepad's left-stick press flies attitude hold here (every gamepad button is taken).
    standard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'button', index: 10 })]), waypointNearest: Object.freeze([]) }) }),
    // A T.16000M on its own: base button 14 (index 13) for attitude hold, in place of the ring course.
    t16000m: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'button', index: 13 })]), ringCourse: Object.freeze([]) }) }),
  }),
  audioProfile: Object.freeze({
    engine: 'rocket', roarHz: 95, rumbleHz: 34, airflowBasis: 'equivalent',
    airflowSpeed: 280, interiorCutoff: 600, stallHorn: true, stallHornStyle: 'beep', stallAoa: null,
    touchdown: 'wheels', callouts: true, motorPitch: 0.8, level: 1,
  }),
  capabilities: Object.freeze({ engine: true, chute: false, space: true }),
  cameraRig: Object.freeze({
    eye: EYE,
    // The chase camera's pull-back, FOV stretch and speed shake scale to the spaceplane's speeds (its
    // kilometres a second happen where there is no air for the wind streaks to show).
    chase: Object.freeze({ distance: 21, height: 4.8, lookAhead: 24, speedRange: Object.freeze({ CRUISE: 300, MAX: 3000, TOP: 3500 }) }),
    wing: Object.freeze({ position: Object.freeze([3.6, 1.2, 4.6]), target: Object.freeze([0.4, 0.2, -5]) }),
    fpv: null,
    // The pilot's seat under the windscreen: a narrow tub, the space panel wide and shallow (Mach,
    // speed, attitude, altitude and apogee on top; heating, heading, climb, RCS and thrust below).
    cockpit: Object.freeze({
      style: 'canopy',
      width: 0.8,
      sill: -0.32,
      floor: -0.9,
      front: -0.95,
      back: 0.55,
      roof: 0.32,
      panel: Object.freeze({
        width: 0.72,
        center: Object.freeze([0, -0.29, -0.58]),
        layout: Object.freeze([
          Object.freeze(['mach', 'airspeed', 'attitude', 'altitude', 'apogee']),
          Object.freeze(['heating', 'heading', 'vsi', 'rcs', 'throttle']),
        ]),
      }),
      frameColor: 0x2c2f38,
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'attitude', 'heading', 'vsi', 'aoa', 'g', 'throttle', 'mach', 'apogee', 'heating', 'rcs']),
  abilities: Object.freeze({ craftAbility, craftAbilityAlt }),
  // Cruise about 800 km/h low down; a take-off needs a long flat strip.
  spawn: Object.freeze({ cruise: 220, cruiseThrottle: 0.07, hover: false, relaunch: 'airstart', canStartOnGround: true, runwayLength: 900 }),
  // Vne: 340 m/s equivalent airspeed (about 70 kPa); 6 g; the climb tops out under 150 km.
  limits: Object.freeze({ vne: 340, gLimit: 6, crashSinkRate: 4, bodyStrikeSpeed: 3, floats: false, ceiling: 150000 }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'spaceplaneApogee', label: 'Highest apogee', unit: 'metres', op: 'max' }),
      Object.freeze({ key: 'spaceplaneMaxMach', label: 'Fastest Mach', unit: 'Mach', op: 'max' }),
      Object.freeze({ key: 'spaceplaneSpaceFlights', label: 'Flights into space', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'spaceplaneReentries', label: 'Re-entries', unit: 'count', op: 'add' }),
    ]),
  }),
  directorProfile: Object.freeze({
    above: Object.freeze([Object.freeze({ altitude: 20000, favor: Object.freeze({ categories: Object.freeze({ celestial: 2.5 }), tags: Object.freeze({ heavy: 2 }) }) })]),
  }),
});
