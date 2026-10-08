// HOT AIR BALLOON: a medium sport balloon (about 2850 m^3, two aboard) of the v1 balloon family
// (src/world/balloonFamily.js: the fair landmarks' envelope profile, palette and gore pattern), built
// from code in the v1 style (flat-shaded, vertex-coloured lofts). A gored envelope with its charcoal
// skirt and parachute vent at the crown, glowing from inside when the burner fires; the burner frame
// on its uprights with a twin burner, the load cables to the mouth, and a wicker basket with a padded
// rim, three fuel tanks and the pilot.
//
// Animated parts: the burner flame (with a pilot light) and its glow through the fabric, the
// parachute vent lifting off the crown, the rotation vent flaps at the equator, the envelope breathing
// with the burner and collapsing on the ground when it is vented, and the pilot reaching for the
// blast valve. The whole rig swings about the envelope's centre of buoyancy (the model's tilt).
//
// It flies SimBalloon (src/flight/SimBalloon.js): buoyancy from the envelope's temperature with a
// 20-30 s thermal lag, the burner (throttle lever, Space), the parachute vent (Shift+Space), the
// rotation vents (stick X and the pedals); horizontally it drifts with the WindField at its height, so
// steering means choosing a wind layer (the wind-layer column instrument, the copilot's "take us
// north" picks one). Assists: over-temperature protection, rotation damping and altitude hold (an
// auto-burner). Basket landings bounce and drag until the pilot vents; a vented envelope collapses on
// the ground and the burner inflates it again.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp, compassName, headingFromVector, wrapDegrees } from '../core/util.js';
import { createMeshBuilder, getCraftMaterials, addSolid, disposeCraftMesh, smooth01 } from './kit.js';
import { BALLOON_MOUTH_RING, BALLOON_PALETTES, BALLOON_PROFILE, balloonPatternIndex, envelopeGeometry, envelopeRadiusAt } from '../world/balloonFamily.js';
import { floatCeiling } from '../flight/SimBalloon.js';

const { uniform, vec3, float, attribute, uv, length, saturate, pow, smoothstep, mix, color } = TSL;

// ============================================================================================
// LAYOUT (body axes relative to the mesh origin = the envelope's centre of buoyancy: x right, y up,
// z aft; m). The envelope is built from its mouth up; everything below hangs from the mouth.
// ============================================================================================
const ENVELOPE_HEIGHT = 17.5;
const ENVELOPE = envelopeGeometry(ENVELOPE_HEIGHT);
const MOUTH_Y = -ENVELOPE.centroid;
const CROWN_Y = MOUTH_Y + ENVELOPE_HEIGHT;
const MOUTH_RADIUS = BALLOON_PROFILE[BALLOON_MOUTH_RING][0] * ENVELOPE_HEIGHT;
const BURNER_Y = MOUTH_Y - 3;
const BASKET_FLOOR_Y = BURNER_Y - 2.45;
const BASKET_HEIGHT = 1.12;
const BASKET_RIM_Y = BASKET_FLOOR_Y + BASKET_HEIGHT;
const BASKET_HALF_BOTTOM = 0.62;
const BASKET_HALF_TOP = 0.7;
const FRAME_Y = BURNER_Y - 0.28;
const FRAME_HALF = 0.4;
/** The pilot stands aft of centre, looking over the front rim; the eye at 1.62 m above the floor. */
const EYE = Object.freeze([0, BASKET_FLOOR_Y + 1.62, 0.28]);
/** The profile ring where the parachute vent's panel starts (the crown cap above it lifts). */
const CAP_RING = BALLOON_PROFILE.length - 2;
/** The rotation vents sit at this share of the envelope height, on the left and right of the basket. */
const ROTATION_VENT_SHARE = 0.6;
const ENVELOPE_SEGMENTS = 16;
const PALETTE_INDEX = 0;
const PATTERN = 'gores';

const TINT = Object.freeze({
  wicker: new THREE.Color(0x8b5a2b),
  wickerDark: new THREE.Color(0x6b4320),
  wickerInside: new THREE.Color(0x9c6a38),
  leather: new THREE.Color(0x2c2f38),
  floor: new THREE.Color(0x3a2a1c),
  metal: new THREE.Color(0x8d9097),
  metalDark: new THREE.Color(0x3a3a40),
  cable: new THREE.Color(0x2b2a28),
  tank: new THREE.Color(0xe6d4b8),
  tankBand: new THREE.Color(0x2c2f38),
  skin: new THREE.Color(0xd9a07a),
  jacket: new THREE.Color(0xe0703a),
  trousers: new THREE.Color(0x2c2f38),
  cap: new THREE.Color(0xf1e4cf),
  skirt: new THREE.Color(0x2c2f38),
  ventFlap: new THREE.Color(0x2c2f38),
});

// ============================================================================================
// SIM: SimBalloon (src/flight/SimBalloon.js). Targets first, then the parameters that meet them.
// tools/lab/balloon.mjs measures the targets.
// ============================================================================================
/** The structure (everything but the air inside): mass (kg), height in body axes (m), spread from the axis (m). */
const STRUCTURE_PARTS = Object.freeze([
  Object.freeze({ part: 'envelope fabric', mass: 120, y: MOUTH_Y + ENVELOPE.centroid * 1.05, spread: 7.5 }),
  Object.freeze({ part: 'basket', mass: 85, y: BASKET_FLOOR_Y + 0.5, spread: 0.6 }),
  Object.freeze({ part: 'burner and frame', mass: 40, y: BURNER_Y, spread: 0.3 }),
  Object.freeze({ part: 'three fuel tanks', mass: 175, y: BASKET_FLOOR_Y + 0.45, spread: 0.5 }),
  Object.freeze({ part: 'pilot and passenger', mass: 160, y: BASKET_FLOOR_Y + 1, spread: 0.35 }),
  Object.freeze({ part: 'cables, instruments, ropes', mass: 40, y: (MOUTH_Y + BURNER_Y) / 2, spread: 1 }),
]);
const STRUCTURE_MASS = STRUCTURE_PARTS.reduce((sum, part) => sum + part.mass, 0);
const STRUCTURE_CENTRE_Y = STRUCTURE_PARTS.reduce((sum, part) => sum + part.mass * part.y, 0) / STRUCTURE_MASS;
/** The air the envelope swings and turns with it adds to the structure's own inertia (share). */
const ADDED_TILT_INERTIA = 0.4;
const ADDED_YAW_INERTIA = 0.3;
const TILT_INERTIA = (1 + ADDED_TILT_INERTIA) * STRUCTURE_PARTS.reduce((sum, part) => sum + part.mass * (part.y * part.y + 0.5 * part.spread * part.spread), 0);
const YAW_INERTIA = (1 + ADDED_YAW_INERTIA) * STRUCTURE_PARTS.reduce((sum, part) => sum + part.mass * part.spread * part.spread, 0);
/** Pendulum damping ratio of the swing (air on the envelope and the basket). */
const SWING_DAMPING_RATIO = 0.3;
const SWING_STIFFNESS = STRUCTURE_MASS * 9.81 * -STRUCTURE_CENTRE_Y;

const BASKET_CORNER = 0.66;
const RIM_CORNER = 0.72;
const ENVELOPE_RING_Y = ROTATION_VENT_SHARE * ENVELOPE_HEIGHT + MOUTH_Y;
const LOWER_RING_SHARE = 0.32;
const ENVELOPE_SPRING = 90000;
const ENVELOPE_DAMPING = 40000;

function basketContacts() {
  const contacts = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    contacts.push(Object.freeze({ id: `basket${x < 0 ? 'Left' : 'Right'}${z < 0 ? 'Front' : 'Back'}`, kind: 'skid', gear: true, position: Object.freeze([x * BASKET_CORNER, BASKET_FLOOR_Y, z * BASKET_CORNER]), spring: 120000, damping: 7000, friction: 0.65 }));
  }
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    contacts.push(Object.freeze({ id: `rim${x < 0 ? 'Left' : 'Right'}${z < 0 ? 'Front' : 'Back'}`, kind: 'skid', gear: false, position: Object.freeze([x * RIM_CORNER, BASKET_RIM_Y, z * RIM_CORNER]), spring: 60000, damping: 5000, friction: 0.7 }));
  }
  // The envelope: fabric that brushes a hillside or a lake rather than striking it (a slow drift into
  // a slope is a bump, never a strike); stiff and well damped, as the whole moving mass (about 6 t)
  // leans on a few points, so the contact never sinks a metre in.
  const equator = envelopeRadiusAt(ENVELOPE_HEIGHT, ROTATION_VENT_SHARE * ENVELOPE_HEIGHT) * 0.99;
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2;
    contacts.push(Object.freeze({ id: `envelope${index}`, kind: 'body', position: Object.freeze([Math.cos(angle) * equator, ENVELOPE_RING_Y, Math.sin(angle) * equator]), spring: ENVELOPE_SPRING, damping: ENVELOPE_DAMPING, friction: 0.4 }));
  }
  const lower = envelopeRadiusAt(ENVELOPE_HEIGHT, LOWER_RING_SHARE * ENVELOPE_HEIGHT) * 0.99;
  for (let index = 0; index < 4; index++) {
    const angle = (index / 4 + 0.125) * Math.PI * 2;
    contacts.push(Object.freeze({ id: `envelopeLow${index}`, kind: 'body', position: Object.freeze([Math.cos(angle) * lower, MOUTH_Y + LOWER_RING_SHARE * ENVELOPE_HEIGHT, Math.sin(angle) * lower]), spring: ENVELOPE_SPRING, damping: ENVELOPE_DAMPING, friction: 0.4 }));
  }
  contacts.push(Object.freeze({ id: 'crown', kind: 'body', position: Object.freeze([0, CROWN_Y, 0]), spring: ENVELOPE_SPRING, damping: ENVELOPE_DAMPING, friction: 0.4 }));
  return Object.freeze(contacts);
}

const simProfile = Object.freeze({
  model: 'balloon',
  targets: Object.freeze({
    equilibriumSeaLevel: 77, // deg C: neutral buoyancy at sea level (ISA)
    hoverBurnerDuty: 0.14, // share of full flame that holds the height at sea level
    thermalLag: Object.freeze([20, 30]), // s: a burn to 63 % of the climb it starts
    rotationQuarter: Object.freeze([20, 30]), // s: a held rotation vent turns the basket 90 degrees
    windMatch: 45, // s: from still air to 90 % of a 6 m/s wind's speed
    floatCeiling: Object.freeze([5500, 7000]), // m: the highest the envelope floats below its red line
  }),
  mass: STRUCTURE_MASS,
  centerOfMass: Object.freeze([0, 0, 0]),
  /** The structure's centre of mass (body), hanging below the pivot: the pendulum. */
  structureCentre: Object.freeze([0, STRUCTURE_CENTRE_Y, 0]),
  inertia: Object.freeze({ tilt: TILT_INERTIA, yaw: YAW_INERTIA }),
  envelope: Object.freeze({
    height: ENVELOPE_HEIGHT,
    // Nylon fabric (about 120 kg) and its coating: J/K.
    fabricHeatCapacity: 120 * 1700,
    // Overall heat transfer through the fabric: natural convection (W/m^2 K), the forced share per m/s
    // of air across it, and the effective emissivity for the radiation loss.
    heatTransfer: 2.6,
    forcedConvection: 0.9,
    emissivity: 0.34,
    redLine: 120, // deg C: the fabric's limit (the temperature flag)
    maxModelTemperature: 180, // deg C: the model's range, far past any real envelope
    cdSide: 0.45,
    cdUp: 0.45, // the round crown leads a climb
    cdDown: 0.65, // the skirt and the open mouth lead a descent
    addedMass: 0.5, // of the displaced air (a sphere)
  }),
  burner: Object.freeze({ power: 3e6, efficiency: 0.75, ignition: 0.12, plumeSeconds: 4 }),
  vent: Object.freeze({ area: 2.4, discharge: 0.62, rate: 1.6 }),
  rotationVents: Object.freeze({ area: 0.35, discharge: 0.65, heightShare: ROTATION_VENT_SHARE, arm: envelopeRadiusAt(ENVELOPE_HEIGHT, ROTATION_VENT_SHARE * ENVELOPE_HEIGHT), rate: 2.5 }),
  damping: Object.freeze({
    tilt: 2 * SWING_DAMPING_RATIO * Math.sqrt(SWING_STIFFNESS * TILT_INERTIA),
    yawLinear: 300,
    yawQuadratic: 5600,
    turbulentYaw: 25,
  }),
  deflation: Object.freeze({ ventSeconds: 12, inflateSeconds: 18 }),
  rig: Object.freeze({
    mouthY: MOUTH_Y,
    burnerY: BURNER_Y,
    basketFloorY: BASKET_FLOOR_Y,
    basketSideArea: 1.6,
    basketTopArea: 2,
  }),
  contacts: basketContacts(),
});

// The structure probes (contract b.4): the basket and burner, and the envelope as overlapping spheres.
const collisionProbes = (() => {
  const probes = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    probes.push(Object.freeze({ id: `basket${probes.length}`, position: Object.freeze([x * 0.55, BASKET_FLOOR_Y + 0.4, z * 0.55]), radius: 0.4, gear: true }));
  }
  probes.push(Object.freeze({ id: 'basket', position: Object.freeze([0, BASKET_FLOOR_Y + 0.75, 0]), radius: 0.85 }));
  probes.push(Object.freeze({ id: 'burner', position: Object.freeze([0, BURNER_Y, 0]), radius: 0.7 }));
  probes.push(Object.freeze({ id: 'mouth', position: Object.freeze([0, MOUTH_Y + 0.8, 0]), radius: 2.6 }));
  probes.push(Object.freeze({ id: 'envelope', position: Object.freeze([0, 0.3, 0]), radius: 8.4 }));
  probes.push(Object.freeze({ id: 'envelopeLow', position: Object.freeze([0, -5.2, 0]), radius: 5.2 }));
  probes.push(Object.freeze({ id: 'crown', position: Object.freeze([0, CROWN_Y - 2.4, 0]), radius: 4.2 }));
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2;
    probes.push(Object.freeze({ id: `equator${index}`, position: Object.freeze([Math.cos(angle) * 7, ENVELOPE_RING_Y, Math.sin(angle) * 7]), radius: 2.6 }));
  }
  return Object.freeze(probes);
})();

// ============================================================================================
// MESH
// ============================================================================================
/** Deterministic 0..1 per panel, for the slight dye variation of the gores. */
function panelShade(ring, segment) {
  const value = Math.sin(ring * 12.9898 + segment * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function ringPoint(ring, segment, target) {
  const [share, height] = BALLOON_PROFILE[ring];
  const angle = (segment / ENVELOPE_SEGMENTS) * Math.PI * 2;
  target[0] = Math.cos(angle) * share * ENVELOPE_HEIGHT;
  target[1] = height * ENVELOPE_HEIGHT;
  target[2] = Math.sin(angle) * share * ENVELOPE_HEIGHT;
  return target;
}

/**
 * The envelope from the skirt to the crown vent's opening (local frame: the mouth at y = 0), flat
 * shaded: position, colour and `glow` (how strongly the burner shines through each panel: most near
 * the mouth, as in the v1 fair balloons).
 */
function buildEnvelopeGeometry() {
  const palette = BALLOON_PALETTES[PALETTE_INDEX].map((hex) => new THREE.Color(hex));
  const positions = [];
  const colors = [];
  const glows = [];
  const rows = BALLOON_PROFILE.length - 2;
  const corners = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const shade = new THREE.Color();
  function pushTriangle(a, b, c, tint, glow) {
    edgeA.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    edgeB.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    normal.crossVectors(edgeA, edgeB);
    if (normal.lengthSq() < 1e-12) return;
    outward.set((a[0] + b[0] + c[0]) / 3, 0, (a[2] + b[2] + c[2]) / 3);
    const order = normal.dot(outward) >= 0 ? [a, b, c] : [a, c, b];
    for (const point of order) {
      positions.push(point[0], point[1], point[2]);
      colors.push(tint.r, tint.g, tint.b);
      glows.push(glow);
    }
  }
  for (let ring = 0; ring < CAP_RING; ring++) {
    for (let segment = 0; segment < ENVELOPE_SEGMENTS; segment++) {
      ringPoint(ring, segment, corners[0]);
      ringPoint(ring, segment + 1, corners[1]);
      ringPoint(ring + 1, segment + 1, corners[2]);
      ringPoint(ring + 1, segment, corners[3]);
      let glow = 0.6;
      if (ring < BALLOON_MOUTH_RING) {
        shade.copy(TINT.skirt);
      } else {
        const row = ring - BALLOON_MOUTH_RING;
        shade.copy(palette[balloonPatternIndex(PATTERN, row, segment)]).multiplyScalar(0.97 + 0.06 * panelShade(ring, segment));
        glow = 0.25 + 1.1 * Math.pow(1 - row / rows, 1.4);
      }
      pushTriangle(corners[0], corners[1], corners[2], shade, glow);
      pushTriangle(corners[0], corners[2], corners[3], shade, glow);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(glows), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The parachute vent's panel: the crown cap above the vent opening (local frame: its base ring at y = 0). */
function buildCrownCap() {
  const builder = createMeshBuilder();
  const crown = new THREE.Color(BALLOON_PALETTES[PALETTE_INDEX][2]);
  const base = BALLOON_PROFILE[CAP_RING][1] * ENVELOPE_HEIGHT;
  const ring = [];
  for (let segment = 0; segment < ENVELOPE_SEGMENTS; segment++) {
    const point = ringPoint(CAP_RING, segment, [0, 0, 0]);
    // The panel overlaps the opening a little so no gap shows while it is closed.
    ring.push([point[0] * 1.04, point[1] - base - 0.05, point[2] * 1.04]);
  }
  const apex = [0, ENVELOPE_HEIGHT - base, 0];
  const inside = [0, -1, 0];
  for (let segment = 0; segment < ENVELOPE_SEGMENTS; segment++) {
    builder.triangle(ring[segment], ring[(segment + 1) % ENVELOPE_SEGMENTS], apex, crown, inside);
    builder.triangle(ring[segment], ring[(segment + 1) % ENVELOPE_SEGMENTS], [0, -0.05, 0], crown, apex);
  }
  return builder.toGeometry(null);
}

/** Rings around a line from `from` to `to` (radius, sides), lofted into a tube with caps. */
function tube(builder, from, to, radius, sides, tint, capTint = tint) {
  const axis = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (axis.lengthSq() < 1e-10) return;
  axis.normalize();
  const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(axis, helper).normalize();
  const third = new THREE.Vector3().crossVectors(axis, side).normalize();
  const ringAt = (centre) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      const cosine = Math.cos(angle) * radius;
      const sine = Math.sin(angle) * radius;
      ring.push([centre[0] + side.x * cosine + third.x * sine, centre[1] + side.y * cosine + third.y * sine, centre[2] + side.z * cosine + third.z * sine]);
    }
    return ring;
  };
  builder.loft([ringAt(from), ringAt(to)], () => tint, { capStart: capTint, capEnd: capTint });
}

/** A square ring of points at height y with half width `half` (corners -x-z, +x-z, +x+z, -x+z). */
function square(y, half, centreZ = 0) {
  return [[-half, y, centreZ - half], [half, y, centreZ - half], [half, y, centreZ + half], [-half, y, centreZ + half]];
}

/** A quad wound to face the point `toward` (interior faces). */
function quadToward(builder, a, b, c, d, tint, toward) {
  const centre = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
  builder.quad(a, b, c, d, tint, [2 * centre[0] - toward[0], 2 * centre[1] - toward[1], 2 * centre[2] - toward[2]]);
}

/** A fuel tank standing at (x, floorY, z): cream cylinder with a charcoal collar and valve. */
function fuelTank(builder, x, floorY, z) {
  tube(builder, [x, floorY + 0.02, z], [x, floorY + 0.72, z], 0.16, 8, TINT.tank);
  tube(builder, [x, floorY + 0.72, z], [x, floorY + 0.8, z], 0.12, 8, TINT.tankBand);
  tube(builder, [x, floorY + 0.8, z], [x, floorY + 0.87, z], 0.035, 6, TINT.metal);
}

/** The wicker basket: tapered walls, padded rim, the inside walls and floor, and the fuel tanks. */
function buildBasket() {
  const builder = createMeshBuilder();
  const floor = BASKET_FLOOR_Y;
  const rim = BASKET_RIM_Y;
  builder.loft([square(floor, BASKET_HALF_BOTTOM), square(floor + 0.5, BASKET_HALF_BOTTOM + 0.035), square(rim - 0.12, BASKET_HALF_TOP - 0.01), square(rim - 0.1, BASKET_HALF_TOP + 0.02), square(rim, BASKET_HALF_TOP + 0.02)], (segment, face) => {
    if (segment >= 2) return TINT.leather;
    return (segment + face) % 2 === 0 ? TINT.wicker : TINT.wickerDark;
  }, { capStart: TINT.wickerDark });
  // The inside (seen from above and from the wing camera): walls, the rim's top and the floor.
  const inner = BASKET_HALF_TOP - 0.05;
  const axis = [0, floor + 0.5, 0];
  const innerBottom = square(floor + 0.03, BASKET_HALF_BOTTOM - 0.04);
  const innerTop = square(rim - 0.02, inner);
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    quadToward(builder, innerBottom[side], innerBottom[next], innerTop[next], innerTop[side], TINT.wickerInside, axis);
    const outerTop = square(rim, BASKET_HALF_TOP + 0.02);
    quadToward(builder, innerTop[side], innerTop[next], outerTop[next], outerTop[side], TINT.leather, [0, rim + 5, 0]);
  }
  quadToward(builder, innerBottom[0], innerBottom[1], innerBottom[2], innerBottom[3], TINT.floor, [0, rim, 0]);
  fuelTank(builder, -0.4, floor, -0.4);
  fuelTank(builder, 0.4, floor, -0.4);
  fuelTank(builder, -0.4, floor, 0.4);
  return builder.toGeometry(null);
}

/** Uprights, burner frame, twin burner and the load cables to the envelope's mouth. */
function buildRigging() {
  const builder = createMeshBuilder();
  const frame = square(FRAME_Y, FRAME_HALF);
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    tube(builder, [x * (BASKET_HALF_TOP - 0.03), BASKET_RIM_Y, z * (BASKET_HALF_TOP - 0.03)], [x * FRAME_HALF, FRAME_Y, z * FRAME_HALF], 0.028, 5, TINT.metal);
    // Load cables from the frame corners to the mouth's load tapes.
    const angle = Math.atan2(z, x);
    tube(builder, [x * FRAME_HALF, FRAME_Y, z * FRAME_HALF], [Math.cos(angle) * MOUTH_RADIUS * 0.98, MOUTH_Y - 0.05, Math.sin(angle) * MOUTH_RADIUS * 0.98], 0.014, 4, TINT.cable);
  }
  for (let side = 0; side < 4; side++) tube(builder, frame[side], frame[(side + 1) % 4], 0.03, 5, TINT.metalDark);
  // Twin burner: two cans with their coils on a cross bar, blast valve handles below.
  tube(builder, [-FRAME_HALF, FRAME_Y + 0.02, 0], [FRAME_HALF, FRAME_Y + 0.02, 0], 0.03, 5, TINT.metalDark);
  for (const x of [-0.17, 0.17]) {
    tube(builder, [x, BURNER_Y - 0.2, 0], [x, BURNER_Y + 0.18, 0], 0.16, 8, TINT.metal, TINT.metalDark);
    tube(builder, [x, BURNER_Y - 0.06, 0], [x, BURNER_Y + 0.06, 0], 0.19, 8, TINT.metalDark);
    tube(builder, [x, BURNER_Y - 0.2, 0.05], [x, BURNER_Y - 0.42, 0.12], 0.018, 4, TINT.leather);
  }
  return builder.toGeometry(null);
}

/** The pilot (body and head; the right arm is its own part): seen above the rim. */
function buildPilotBody() {
  const builder = createMeshBuilder();
  const floor = BASKET_FLOOR_Y;
  const x = -0.22;
  const z = 0.24;
  tube(builder, [x, floor + 0.05, z], [x, floor + 0.88, z], 0.13, 7, TINT.trousers);
  tube(builder, [x, floor + 0.88, z], [x, floor + 1.42, z], 0.17, 7, TINT.jacket);
  tube(builder, [x, floor + 1.42, z], [x, floor + 1.5, z], 0.06, 6, TINT.skin);
  tube(builder, [x, floor + 1.5, z], [x, floor + 1.72, z], 0.105, 7, TINT.skin, TINT.cap);
  tube(builder, [x, floor + 1.7, z], [x, floor + 1.76, z - 0.04], 0.115, 7, TINT.cap);
  tube(builder, [x - 0.17, floor + 1.38, z], [x - 0.22, floor + 1.0, z - 0.06], 0.045, 5, TINT.jacket);
  return builder.toGeometry(null);
}

const PILOT_SHOULDER = Object.freeze([-0.06, BASKET_FLOOR_Y + 1.38, 0.24]);
/** The right arm from the shoulder (pivot frame), resting down; it swings up to the blast valve. */
function buildPilotArm() {
  const builder = createMeshBuilder();
  tube(builder, [0, 0, 0], [0.05, -0.36, -0.06], 0.045, 5, TINT.jacket);
  tube(builder, [0.05, -0.36, -0.06], [0.07, -0.46, -0.08], 0.04, 5, TINT.skin);
  return builder.toGeometry(null);
}

/** A rotation vent flap (local frame: its hinge on the y axis, the flap along +z). */
function buildVentFlap() {
  const builder = createMeshBuilder();
  const section = (y) => [[-0.04, y, 0], [0.04, y, 0], [0.04, y, 0.9], [-0.04, y, 0.9]];
  builder.loft([section(-0.75), section(0.75)], () => TINT.ventFlap, { capStart: TINT.ventFlap, capEnd: TINT.ventFlap });
  return builder.toGeometry(null);
}

/** The flame: an additive cone, blue at the nozzle, orange to yellow at the tips. */
function createFlameMaterial(strength) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true });
  const along = saturate(uv().y);
  const base = mix(vec3(0.25, 0.45, 1.6), vec3(2.6, 1.1, 0.25), smoothstep(float(0.02), float(0.3), along));
  material.colorNode = mix(base, vec3(2.4, 1.8, 0.7), smoothstep(float(0.5), float(1), along));
  material.opacityNode = pow(float(1).sub(along), float(1.3)).mul(strength);
  return material;
}

function createGlowMaterial(strength) {
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const radial = saturate(float(1).sub(length(uv().sub(0.5)).mul(2)));
  material.colorNode = color(0xffa24a);
  material.opacityNode = pow(radial, float(3)).mul(strength);
  return material;
}

// The chase view frames the whole balloon: from 46 m behind it, a little above the centre.
const chaseRig = Object.freeze({ distance: 46, height: 7, lookAhead: 0 });

const windScratch = { local: new THREE.Vector3() };

/**
 * Builds the balloon. update(visual, dt) animates the flame, the glow through the fabric, the vents,
 * the breathing and the collapse from visual.craftState (burner, vent, rotationVent, inflation) and
 * the wind it is lying down in (state.flight.wind).
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const telemetry = ctx.state.flight;
  const uniforms = ctx.uniforms;
  const burnGlow = uniform(0);
  const flameStrength = uniform(0);
  const pilotStrength = uniform(0.9);
  const glowStrength = uniform(0);

  // Envelope: outside lit by the sun with the burner shining through near the mouth; inside, the
  // fabric glows with daylight passing through it and with the flame.
  const glowWeight = attribute('glow', 'float');
  const fabricColor = attribute('color', 'vec3');
  const outerMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.74, metalness: 0 });
  outerMaterial.emissiveNode = fabricColor.mul(vec3(1, 0.72, 0.42)).mul(glowWeight).mul(burnGlow);
  const innerMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.BackSide });
  const daylight = float(1).sub(uniforms.nightFactor).mul(0.42);
  innerMaterial.emissiveNode = fabricColor.mul(daylight.add(burnGlow.mul(glowWeight).mul(1.4)));

  const root = new THREE.Group();
  root.name = 'balloon';
  const envelopeGroup = new THREE.Group();
  envelopeGroup.name = 'balloon-envelope';
  envelopeGroup.position.set(0, MOUTH_Y, 0);
  root.add(envelopeGroup);
  const envelopeGeometryBuffer = buildEnvelopeGeometry();
  addSolid(envelopeGroup, envelopeGeometryBuffer, outerMaterial);
  const inside = new THREE.Mesh(envelopeGeometryBuffer, innerMaterial);
  inside.receiveShadow = true;
  envelopeGroup.add(inside);
  const capBase = BALLOON_PROFILE[CAP_RING][1] * ENVELOPE_HEIGHT;
  const cap = addSolid(envelopeGroup, buildCrownCap(), materials.body);
  cap.position.set(0, capBase, 0);
  const flapGeometry = buildVentFlap();
  const ventRadius = envelopeRadiusAt(ENVELOPE_HEIGHT, ROTATION_VENT_SHARE * ENVELOPE_HEIGHT);
  const flaps = [-1, 1].map((side) => {
    const hinge = new THREE.Group();
    hinge.position.set(side * (ventRadius + 0.03), ROTATION_VENT_SHARE * ENVELOPE_HEIGHT, -0.45);
    addSolid(hinge, flapGeometry, materials.body);
    envelopeGroup.add(hinge);
    return { hinge, side };
  });

  addSolid(root, buildRigging(), materials.body);
  const basket = addSolid(root, buildBasket(), materials.body);
  basket.userData.hideInCockpit = true;
  const pilot = addSolid(root, buildPilotBody(), materials.body);
  pilot.userData.hideInCockpit = true;
  const armPivot = new THREE.Group();
  armPivot.position.fromArray(PILOT_SHOULDER);
  armPivot.userData.hideInCockpit = true;
  addSolid(armPivot, buildPilotArm(), materials.body);
  root.add(armPivot);

  // Flames above both burner cans, a pilot light each, and a glow sprite for the bloom.
  const flameGeometry = new THREE.ConeGeometry(0.2, 2.6, 10, 1, true);
  flameGeometry.translate(0, 1.3, 0);
  const pilotGeometry = new THREE.ConeGeometry(0.03, 0.14, 6, 1, true);
  pilotGeometry.translate(0, 0.07, 0);
  const flameMaterial = createFlameMaterial(flameStrength);
  const pilotMaterial = createFlameMaterial(pilotStrength);
  const flames = [-0.17, 0.17].map((x) => {
    const flame = new THREE.Mesh(flameGeometry, flameMaterial);
    flame.position.set(x, BURNER_Y + 0.18, 0);
    flame.renderOrder = 3;
    flame.visible = false;
    root.add(flame);
    const pilotLight = new THREE.Mesh(pilotGeometry, pilotMaterial);
    pilotLight.position.set(x, BURNER_Y + 0.18, 0);
    pilotLight.renderOrder = 3;
    root.add(pilotLight);
    return flame;
  });
  const glow = new THREE.Sprite(createGlowMaterial(glowStrength));
  glow.position.set(0, BURNER_Y + 1, 0);
  glow.renderOrder = 4;
  glow.visible = false;
  root.add(glow);

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.fromArray(EYE);
  root.add(eyeAnchor);

  const wingtips = [new THREE.Vector3(-BASKET_HALF_TOP, BASKET_FLOOR_Y + 0.5, 0), new THREE.Vector3(BASKET_HALF_TOP, BASKET_FLOOR_Y + 0.5, 0)];
  const pose = { arm: 0, collapse: 0, leanAxisX: 1, leanAxisZ: 0 };
  const leanAxis = new THREE.Vector3(1, 0, 0);
  const leanQuaternion = new THREE.Quaternion();
  const inverseRoot = new THREE.Quaternion();

  return {
    root,
    wingtips,
    eyeAnchor,
    /** Named local points: the burner (smoke, sparks), the basket floor and the crown. */
    anchors: {
      burner: new THREE.Vector3(0, BURNER_Y + 0.4, 0),
      basket: new THREE.Vector3(0, BASKET_FLOOR_Y, 0),
      crown: new THREE.Vector3(0, CROWN_Y, 0),
      tail: new THREE.Vector3(0, BASKET_FLOOR_Y + 0.5, BASKET_HALF_TOP),
    },

    update(visual, dt) {
      const step = Math.max(0, Math.min(dt, 0.05));
      const craftState = visual.craftState || {};
      const time = visual.time ? visual.time.elapsed : 0;
      const burner = clamp(Number(craftState.burner) || 0, 0, 1);
      const vent = clamp(Number(craftState.vent) || 0, 0, 1);
      const rotation = clamp(Number(craftState.rotationVent) || 0, -1, 1);
      const inflation = clamp(Number.isFinite(craftState.inflation) ? craftState.inflation : 1, 0, 1);

      // Flame: length with the valve, a fast ragged flicker; the fabric glows with it.
      const flicker = 0.82 + 0.1 * Math.sin(time * 37.1) + 0.08 * Math.sin(time * 61.7 + 1.3);
      const lit = burner > 0.02;
      for (const flame of flames) {
        flame.visible = lit;
        flame.scale.set(0.8 + 0.35 * burner, (0.25 + 0.75 * burner) * flicker, 0.8 + 0.35 * burner);
      }
      flameStrength.value = lit ? 0.55 + 0.45 * burner : 0;
      glow.visible = lit;
      glow.scale.setScalar(2.2 + 3.4 * burner * flicker);
      glowStrength.value = burner * (0.55 + 0.25 * flicker);
      const night = clamp(uniforms.nightFactor.value, 0, 1);
      burnGlow.value = burner * flicker * (0.35 + 1.1 * night);

      // The parachute vent lifts off the crown; the rotation vent on the turning side opens.
      cap.position.y = capBase + vent * 1.1;
      for (const flap of flaps) {
        const opening = Math.max(0, rotation * flap.side);
        flap.hinge.rotation.y = flap.side * opening * 55 * DEG;
      }

      // Breathing: the fabric swells a little with every blast; collapsing on the ground, it falls
      // over downwind and flattens.
      const collapse = 1 - smooth01(inflation);
      pose.collapse = step > 0 ? pose.collapse + (collapse - pose.collapse) * (1 - Math.exp(-3 * step)) : collapse;
      const breathe = 1 + 0.004 * Math.sin(time * 0.9) + 0.012 * burner * Math.sin(time * 6.3);
      const flat = pose.collapse;
      envelopeGroup.scale.set(breathe * (1 - 0.62 * flat), breathe * (1 - 0.08 * flat), breathe * (1 - 0.62 * flat));
      if (flat > 0.01 && telemetry && telemetry.wind) {
        inverseRoot.copy(root.quaternion).invert();
        windScratch.local.copy(telemetry.wind).applyQuaternion(inverseRoot);
        const horizontal = Math.hypot(windScratch.local.x, windScratch.local.z);
        if (horizontal > 0.3) {
          pose.leanAxisX = windScratch.local.z / horizontal;
          pose.leanAxisZ = -windScratch.local.x / horizontal;
        }
      }
      leanAxis.set(pose.leanAxisX, 0, pose.leanAxisZ);
      envelopeGroup.quaternion.copy(leanQuaternion.setFromAxisAngle(leanAxis, 84 * DEG * flat));

      // The pilot reaches up to the blast valve while burning.
      pose.arm = step > 0 ? pose.arm + ((lit ? 1 : 0) - pose.arm) * (1 - Math.exp(-6 * step)) : lit ? 1 : 0;
      armPivot.rotation.x = pose.arm * 2.7;
      armPivot.rotation.z = -pose.arm * 0.35;
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// FIRST PERSON: standing in the basket. The basket is drawn from inside (wicker walls, the padded
// rim, the floor and the fuel tanks); the burner, its frame and the envelope overhead are the craft
// mesh itself (look up into the glowing envelope).
// ============================================================================================
function buildBasketView(builder) {
  const floor = BASKET_FLOOR_Y - EYE[1];
  const rim = BASKET_RIM_Y - EYE[1];
  const offsetZ = -EYE[2];
  const bottom = square(floor, BASKET_HALF_BOTTOM - 0.04, offsetZ);
  const top = square(rim - 0.02, BASKET_HALF_TOP - 0.05, offsetZ);
  const outerTop = square(rim, BASKET_HALF_TOP + 0.03, offsetZ);
  const eye = [0, 0, 0];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    const middle = (point, other, share) => [point[0] + (other[0] - point[0]) * share, point[1] + (other[1] - point[1]) * share, point[2] + (other[2] - point[2]) * share];
    // Woven bands: alternating light and dark courses up the wall.
    for (let course = 0; course < 4; course++) {
      const low = course / 4;
      const high = (course + 1) / 4;
      quadToward(builder, middle(bottom[side], top[side], low), middle(bottom[next], top[next], low), middle(bottom[next], top[next], high), middle(bottom[side], top[side], high), course % 2 === 0 ? TINT.wickerInside : TINT.wicker, eye);
    }
    quadToward(builder, top[side], top[next], outerTop[next], outerTop[side], TINT.leather, [0, rim + 3, offsetZ]);
  }
  quadToward(builder, bottom[0], bottom[1], bottom[2], bottom[3], TINT.floor, eye);
  fuelTank(builder, -0.4, floor, offsetZ - 0.4);
  fuelTank(builder, 0.4, floor, offsetZ - 0.4);
  fuelTank(builder, -0.4, floor, offsetZ + 0.4);
  return { objects: [] };
}

// ============================================================================================
// ABILITIES: the burner (Space, held; a tap is a short blast) and the parachute vent (Shift+Space,
// held). The burner's update also samples the wind-layer column once a second.
// ============================================================================================
/** Seconds of burner (or vent) a single tap gives. */
const TAP_BURN_SECONDS = 1.2;
const TAP_VENT_SECONDS = 1;
/** The wind-layer column: the heights above the surface (m, of the envelope's centre) it samples, once a second, smoothed. */
export const WIND_BANDS = Object.freeze([40, 120, 250, 400, 600, 850, 1150, 1500, 2000]);
const COLUMN_SECONDS = 1;
const COLUMN_SMOOTHING_SECONDS = 4;
const columnPoint = new THREE.Vector3();
const columnSample = { vel: new THREE.Vector3(), turbulence: 0 };

/** Resamples craftState.windColumn at the craft's position: the WindField at every band's height. */
function sampleWindColumn(api, craftState, interval) {
  const field = api.wind;
  const position = api.player ? api.player.position : null;
  if (!field || typeof field.probe !== 'function' || !position || !api.world) return;
  const world = api.world;
  const waterLevel = Number.isFinite(world.WATER_LEVEL) ? world.WATER_LEVEL : -Infinity;
  const surface = Math.max(world.groundHeight(position.x, position.z), waterLevel);
  const blend = 1 - Math.exp(-interval / COLUMN_SMOOTHING_SECONDS);
  const time = api.state && api.state.time ? api.state.time.elapsed : 0;
  for (const band of craftState.windColumn) {
    columnPoint.set(position.x, surface + band.agl, position.z);
    field.probe(columnPoint, time, columnSample);
    if (band.primed) {
      band.vx += (columnSample.vel.x - band.vx) * blend;
      band.vz += (columnSample.vel.z - band.vz) * blend;
    } else {
      band.vx = columnSample.vel.x;
      band.vz = columnSample.vel.z;
      band.primed = true;
    }
    band.altitude = surface + band.agl;
    band.speed = Math.hypot(band.vx, band.vz);
    band.towardDegrees = band.speed > 0.05 ? headingFromVector(band.vx, band.vz) : 0;
    band.fromDegrees = wrapDegrees(band.towardDegrees + 180);
  }
}

const craftAbility = Object.freeze({
  label: 'Burner',
  initialState: () => ({
    envelopeTemperature: 77,
    ambientTemperature: 15,
    equilibriumTemperature: 77,
    redLine: simProfile.envelope.redLine,
    overTemperature: false,
    tempFlag: false,
    burner: 0,
    vent: 0,
    rotationVent: 0,
    inflation: 1,
    lift: 0,
    altitudeHold: null,
    landing: false,
    burnerHeld: false,
    burnTimer: 0,
    windColumnTimer: 0,
    windColumn: WIND_BANDS.map((agl) => ({ altitude: 0, agl, fromDegrees: 0, towardDegrees: 0, speed: 0, vx: 0, vz: 0, primed: false })),
  }),
  run(api) {
    api.craftState.burnTimer = Math.max(api.craftState.burnTimer || 0, TAP_BURN_SECONDS);
    return true;
  },
  update(api, dt) {
    const craftState = api.craftState;
    craftState.burnTimer = Math.max(0, (craftState.burnTimer || 0) - dt);
    craftState.burnerHeld = api.isHeld('craftAbility') || craftState.burnTimer > 0;
    craftState.windColumnTimer = (craftState.windColumnTimer || 0) - dt;
    if (craftState.windColumnTimer <= 0 && Array.isArray(craftState.windColumn)) {
      craftState.windColumnTimer = COLUMN_SECONDS;
      sampleWindColumn(api, craftState, COLUMN_SECONDS);
    }
  },
});

const craftAbilityAlt = Object.freeze({
  label: 'Parachute vent',
  initialState: () => ({ ventHeld: false, ventTimer: 0 }),
  run(api) {
    api.craftState.ventTimer = Math.max(api.craftState.ventTimer || 0, TAP_VENT_SECONDS);
    return true;
  },
  update(api, dt) {
    const craftState = api.craftState;
    craftState.ventTimer = Math.max(0, (craftState.ventTimer || 0) - dt);
    craftState.ventHeld = api.isHeld('craftAbilityAlt') || craftState.ventTimer > 0;
  },
});

// ============================================================================================
// COPILOT: timed burns and vents, a wind report, steering by wind layer, an assisted landing.
// ============================================================================================
const COMPASS_WORDS = Object.freeze({ north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 });
const COMPASS_PATTERN = '(north(?:[ -]?(?:east|west))?|south(?:[ -]?(?:east|west))?|east|west)';
/** A layer is worth steering by only with this much wind (m/s). */
const STEER_MIN_WIND = 0.6;

function compassDegrees(value) {
  const key = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : '';
  return Object.prototype.hasOwnProperty.call(COMPASS_WORDS, key) ? COMPASS_WORDS[key] : null;
}

function kmh(speed) {
  return Math.round(speed * 3.6);
}

/** The column's band whose wind goes closest to a direction: { band, error (deg) } or null. */
export function bestLayerToward(column, towardDegrees) {
  let best = null;
  for (const band of Array.isArray(column) ? column : []) {
    if (!band.primed || band.speed < STEER_MIN_WIND) continue;
    const error = Math.abs(((band.towardDegrees - towardDegrees + 540) % 360) - 180);
    if (!best || error < best.error) best = { band, error };
  }
  return best;
}

function describeBand(band) {
  return `${Math.round(band.altitude)} metres: ${kmh(band.speed)} km/h toward the ${compassName(band.towardDegrees)}`;
}

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'burn',
      phrases: Object.freeze(['\\bburn (?:for )?(\\d+(?:\\.\\d+)?) ?(?:s|sec|secs|seconds?)\\b', '\\b(?:fire|light|hit|blast) the burners?\\b', '\\bgive (?:it|us) (?:some )?heat\\b', '\\bburn\\b']),
      run(api, value) {
        const seconds = Number.isFinite(value) ? clamp(value, 1, 20) : 4;
        api.craftState.burnTimer = Math.max(api.craftState.burnTimer || 0, seconds);
        api.craftState.landing = false;
        return `Burning for ${Math.round(seconds)} seconds. The envelope answers in about twenty.`;
      },
    }),
    Object.freeze({
      id: 'vent',
      phrases: Object.freeze(['\\bvent (?:for )?(\\d+(?:\\.\\d+)?) ?(?:s|sec|secs|seconds?)\\b', '\\b(?:open|pull) the (?:parachute |top )?vent\\b', '\\bdump (?:some )?heat\\b', '\\bvent\\b']),
      run(api, value) {
        const seconds = Number.isFinite(value) ? clamp(value, 1, 15) : 3;
        api.craftState.ventTimer = Math.max(api.craftState.ventTimer || 0, seconds);
        api.craftState.landing = false;
        return `Venting for ${Math.round(seconds)} seconds. We'll start down shortly.`;
      },
    }),
    Object.freeze({
      id: 'steer',
      phrases: Object.freeze([
        `\\b(?:take us|drift|steer|head|float|carry us|go) (?:to the |towards? (?:the )?)?${COMPASS_PATTERN}\\b`,
        `\\b(?:a |the )?(?:wind )?layer (?:to the |towards? (?:the )?|going |blowing )?${COMPASS_PATTERN}\\b`,
      ]),
      run(api, value) {
        const toward = compassDegrees(value);
        if (toward === null) return 'Which way? North, east, south or west.';
        const best = bestLayerToward(api.craftState.windColumn, toward);
        if (!best) return 'The air is nearly still at every height here, so no layer will carry us anywhere yet.';
        const band = best.band;
        api.craftState.landing = false;
        api.setAutopilot({ enabled: true, altitude: band.altitude, reason: 'wind layer' });
        const where = compassName(toward);
        if (best.error > 60) return `No layer goes ${where}. The closest is at ${describeBand(band)}. Taking us there.`;
        return `The layer at ${describeBand(band)}. Taking us there; it'll take a while to settle in.`;
      },
    }),
    Object.freeze({
      id: 'windReport',
      phrases: Object.freeze(['\\bwind (?:layers?|column|aloft)\\b', '\\bwhat(?:\'s| is) the wind (?:doing )?(?:up|above|aloft|higher|lower|below)\\b', '\\bwinds? (?:above|below) us\\b']),
      run(api) {
        const column = Array.isArray(api.craftState.windColumn) ? api.craftState.windColumn.filter((band) => band.primed) : [];
        if (column.length === 0) return 'Still sampling the winds. Ask again in a moment.';
        const picks = [column[0], column[Math.floor(column.length / 2)], column[column.length - 1]];
        return `Winds: ${picks.map(describeBand).join('; ')}.`;
      },
    }),
    Object.freeze({
      id: 'land',
      phrases: Object.freeze(['\\b(?:land|set (?:us|it) down|bring (?:us|it) down|put (?:us|it) down)(?: here| now| the balloon)?$', '\\blet\'?s land\\b', '\\btime to land\\b']),
      run(api) {
        if (api.telemetry.onGround) return "We're already down.";
        api.setAutopilot({ enabled: false, reason: 'landing' });
        api.craftState.landing = true;
        return "Bringing us down gently. I'll vent the envelope once the basket is down.";
      },
    }),
  ]),
  status(craftState, telemetry) {
    const temperature = Math.round(Number(craftState.envelopeTemperature) || 0);
    const parts = [`Envelope ${temperature} degrees${craftState.overTemperature ? ', over the red line' : ''}`];
    if (Number.isFinite(craftState.equilibriumTemperature)) parts.push(`we float at ${Math.round(craftState.equilibriumTemperature)}`);
    let text = `${parts.join(', ')}.`;
    if (craftState.burner > 0.05) text += ' Burner on.';
    if (craftState.vent > 0.05) text += ' Vent open.';
    if (craftState.landing) text += ' Landing.';
    else if (Number.isFinite(craftState.altitudeHold)) text += ` Holding ${Math.round(craftState.altitudeHold)} metres.`;
    if (craftState.inflation < 0.95) text += ` The envelope is ${craftState.inflation < 0.2 ? 'down' : 'partly deflated'}.`;
    const groundSpeed = Number.isFinite(telemetry.groundSpeed) ? telemetry.groundSpeed : 0;
    if (groundSpeed > 0.5 && telemetry.velocity) text += ` Drifting toward the ${compassName(headingFromVector(telemetry.velocity.x, telemetry.velocity.z))} at ${kmh(groundSpeed)} km/h.`;
    else text += ' Barely drifting.';
    return text;
  },
});

// ============================================================================================
// PLACEMENT (contract h.4): drifting with the wind at the current height, the envelope at
// equilibrium (the model floats every airborne reset); on the ground or on the water when the
// previous craft was; never lower than MIN_DRIFT_BASKET m (basket above the surface) nor above
// the height the envelope can float at.
// ============================================================================================
const MIN_DRIFT_BASKET = 60;
const FLOAT_CEILING = floatCeiling(simProfile);

function situate(situation, api) {
  const position = situation.position;
  const surface = Number.isFinite(situation.surfaceHeight) ? situation.surfaceHeight : api.surfaceHeight(position.x, position.z);
  const heading = situation.heading;
  if (situation.wasOnWater && situation.overWater) return { mode: 'water', position: { x: position.x, y: surface, z: position.z }, heading, throttle: 0 };
  if (situation.wasOnGround) return { mode: 'ground', position: { x: position.x, y: surface, z: position.z }, heading, throttle: 0 };
  const ceiling = Math.min(FLOAT_CEILING, Number.isFinite(api.ceiling) ? api.ceiling : Infinity) - 200;
  const lowest = surface - BASKET_FLOOR_Y + MIN_DRIFT_BASKET;
  const y = Math.max(Math.min(position.y, ceiling), lowest);
  return { mode: 'drift', position: { x: position.x, y, z: position.z }, heading, throttle: 0 };
}

export default Object.freeze({
  id: 'balloon',
  name: 'Hot air balloon',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: the throttle axis is the burner valve; stick X (and the pedals) work the
   * rotation vents. Space holds the burner open, Shift+Space the parachute vent.
   */
  inputProfile: Object.freeze({ throttle: 'burner', stickX: 'rotationVents', toeBrakes: 'none', flapNotches: 0 }),
  // Per-craft defaults: the vent also on keys and buttons the balloon has no use for (the airbrake's
  // B and gamepad B, the stick's gear button, the TWCS airbrake button).
  bindings: Object.freeze({
    keyboard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'key', code: 'Space', shift: true }), Object.freeze({ type: 'key', code: 'KeyB' })]), airbrake: Object.freeze([]) }) }),
    standard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'button', index: 1 })]), airbrake: Object.freeze([]) }) }),
    t16000m: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'button', index: 4 })]), gearToggle: Object.freeze([]) }) }),
    twcs: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([Object.freeze({ type: 'button', index: 9 }), Object.freeze({ type: 'button', index: 1 })]), airbrake: Object.freeze([]) }) }),
  }),
  audioProfile: Object.freeze({ engine: 'burner', airflowSpeed: 25, interiorCutoff: 0, touchdown: 'body', callouts: false, stallHorn: false, vario: false }),
  capabilities: Object.freeze({ engine: false, chute: false, smoke: false, water: true, perch: false, space: false }),
  cameraRig: Object.freeze({
    eye: EYE,
    chase: chaseRig,
    // A camera on the basket's corner looking up past the burner into the envelope's mouth.
    wing: Object.freeze({ position: Object.freeze([2.4, BASKET_FLOOR_Y + 0.6, 2.4]), target: Object.freeze([0, BURNER_Y + 2.2, 0]) }),
    fpv: null,
    cockpit: Object.freeze({
      style: 'custom',
      build: buildBasketView,
      near: 0.05,
      // The instrument pack hangs on the front right upright just above the rim, clear of the view ahead.
      panel: Object.freeze({
        width: 0.32,
        center: Object.freeze([0.3, BASKET_RIM_Y - EYE[1] + 0.2, -0.62]),
        layout: Object.freeze([Object.freeze(['envelope', 'altitude', 'vsi']), Object.freeze(['windColumn', 'radarAlt', 'heading'])]),
      }),
    }),
  }),
  instruments: Object.freeze(['envelope', 'windColumn', 'altitude', 'vsi', 'radarAlt', 'heading']),
  /** Readouts the third-person HUD shows even with the instrument overlay off (the wind-layer column). */
  hudInstruments: Object.freeze(['windColumn', 'envelope']),
  abilities: Object.freeze({ craftAbility, craftAbilityAlt }),
  // No airspeed to speak of: it starts and respawns drifting (the model matches the air's motion).
  spawn: Object.freeze({ cruise: 0, hover: false, relaunch: 'airstart', canStartOnGround: true }),
  // A basket takes a firm arrival (bounces, drags) and floats on water; the envelope brushes hills.
  limits: Object.freeze({ vne: 60, gLimit: 3, crashSinkRate: 6, bodyStrikeSpeed: 8, floats: false, ceiling: 7000, waterLanding: 'basket' }),
  collision: Object.freeze({ probes: collisionProbes }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'balloonMaxAltitude', label: 'Highest balloon flight', unit: 'metres', op: 'max' }),
      Object.freeze({ key: 'balloonLongestDrift', label: 'Longest balloon drift', unit: 'metres', op: 'max' }),
      Object.freeze({ key: 'balloonLandings', label: 'Basket landings', unit: 'count', op: 'add' }),
    ]),
  }),
  directorProfile: Object.freeze({ favor: Object.freeze({ tags: Object.freeze({ calm: 1.6, slow: 1.5, spectacle: 1.4 }) }) }),
  // Drifting silently, a balloon unsettles a flock far less than a powered craft.
  faunaThreat: 0.6,
});
