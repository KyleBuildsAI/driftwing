// WINGSUIT: a proximity flyer, built from code in the v1 glider's style (flat-shaded, vertex-coloured
// lofts in the v1 palette): helmet with visor, suited body, arms and legs on joints, fabric arm wings
// and a leg wing stretched between the limbs (re-skinned every frame so they stay attached and
// flutter at speed), and the rig container on the back. The arms sweep and drop with pitch and roll,
// the legs spread for a flare and close for a dive. The parachute (src/render/wingsuitEffects.js)
// deploys from the container: the pilot swings from prone to hanging under a nine-cell ram-air canopy,
// hands on the toggles, and stands up after landing.
//
// CLASSIC flies it with v1's forgiving arcade rules at wingsuit speeds and without an engine: it glides
// down about 2.5 : 1, the stick trades glide for speed, the ground cushion keeps it off the terrain and
// the relaunch (or running out of height) brings it back up to a peak. SIM flies SimWingsuit
// (src/flight/SimWingsuit.js) with its canopy mode.
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp } from '../core/util.js';
import { PALETTE, createMeshBuilder, getCraftMaterials, addSolid, createNavLights, disposeCraftMesh, smooth01 } from './kit.js';
import { createCanopyRig } from '../render/wingsuitEffects.js';

// ============================================================================================
// CLASSIC: v1's arcade rules at wingsuit speeds. No engine: the throttle does nothing, the settled
// attitude is the glide (LEVEL_PITCH), boost is a short dive burst that cannot power a climb.
// ============================================================================================
const GLIDE_PITCH = -Math.atan(1 / 2.5);
const arcadeProfile = Object.freeze({
  // m/s: stall about 120 km/h, glide about 180 km/h, dive limit about 245 km/h.
  SPEED: Object.freeze({ MIN: 26, STALL: 33, CRUISE: 50, MAX: 68, BOOST_MAX: 78 }),
  GRAVITY: 9.81,
  ENGINE: false,
  LEVEL_PITCH: GLIDE_PITCH,
  // Drag that balances gravity along a 2.5 : 1 glide path at 50 m/s: g sin(21.8 deg) / 50^2.
  DRAG_COEFFICIENT: (9.81 * Math.sin(-GLIDE_PITCH)) / (50 * 50),
  THROTTLE_SPEED_EXPONENT: 1,
  THROTTLE_RATE: 0,
  INDUCED_DRAG: 0.6,
  INDUCED_MAX_EXTRA_G: 3,
  MAX_PITCH_RATE: 60 * DEG,
  MAX_ROLL_RATE: 110 * DEG,
  MAX_YAW_RATE: 20 * DEG,
  MAX_BANK: 65 * DEG,
  BANK_GAIN: 3.4,
  FINE_BANK_SCALE: 0.55,
  YAW_BANK: 10 * DEG,
  // The nose cannot be held far above the horizon: a wingsuit only zooms briefly.
  PITCH_LIMIT_START: 25 * DEG,
  PITCH_LIMIT_RANGE: 25 * DEG,
  TURN_GAIN: 1.5,
  MAX_TURN_RATE: 42 * DEG,
  BANK_NOSE_DROP: 5 * DEG,
  BANK_SETTLE_PITCH: 6 * DEG,
  FINE_CONTROL_SCALE: 0.45,
  AUTO_LEVEL_DELAY: 1,
  STALL_EXIT_MARGIN: 5,
  STALL_NOSE_TARGET: -40 * DEG,
  HIGH_SPEED_PITCH_START: 56,
  // Proximity flying: the ground cushion lets it skim lower than the aircraft.
  CUSHION_HEIGHT: 20,
  IMPACT_WARNING_SECONDS: 2.2,
  IMPACT_FULL_SECONDS: 0.7,
  CUSHION_PULL_RATE: 65 * DEG,
  GUARD_PROBE_SECONDS: Object.freeze([1, 2, 3.2]),
  GUARD_MARGIN: 14,
  GUARD_MIN_SPEED: 26,
  GUARD_EVADE_GRADIENT: Math.tan(24 * DEG),
  GUARD_EVADE_BANK: 55 * DEG,
  CEILING_BAND: 260,
  BOOST_DURATION: 1.6,
  BOOST_COOLDOWN: 7,
  BARREL_ROLL_DURATION: 1,
  BARREL_ROLL_RADIUS: 1,
  AUTOPILOT: Object.freeze({
    MAX_BANK: 30 * DEG,
    MAX_PITCH: 8 * DEG,
    TERRAIN_PITCH: 12 * DEG,
    CLEARANCE: 120,
    RING_CLEARANCE: 45,
    MIN_ALTITUDE: 60,
    CRUISE_THROTTLE: 0,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    TERRAIN_MAX_PITCH: 20 * DEG,
    LOOKAHEAD_DISTANCES: Object.freeze([0, 80, 160, 260, 400, 560, 780, 1100]),
    PATH_LOOKAHEAD_DISTANCES: Object.freeze([120, 280, 520]),
    WAYPOINT_STEERING: Object.freeze({ BANK_PER_DEGREE: 1.2, MAX_BANK: 30 * DEG, DAMPING: 2.2, MAX_ROLL_RATE: 45 * DEG }),
    RING_STEERING: Object.freeze({ BANK_PER_DEGREE: 2.0, MAX_BANK: 40 * DEG, DAMPING: 3.5, MAX_ROLL_RATE: 60 * DEG }),
    RING_MAX_PITCH: 12 * DEG,
    RING_MIN_TIME_TO_RING: 1.5,
    RING_VERTICAL_SPEED_GAIN: 0.015,
    RING_LOOKAHEAD_MARGIN: 150,
    RING_TRACK_LEAD_SECONDS: 2.4,
    RING_TRACK_LEAD_MIN: 90,
    RING_TRACK_LEAD_MAX: 180,
  }),
  LOAD: Object.freeze({ PULL_SHARE: 0.2, KNEE: 3.5, CAP: 5, MIN: -1, SMOOTHING: 5, MIN_BANK_COS: 0.2, BARREL_ROLL_EXTRA: 0.8 }),
  SURFACE_TURN_SHARE: 0.3,
});

// ============================================================================================
// SIM: SimWingsuit (src/flight/SimWingsuit.js). Targets first, then the parameters that meet them.
// Body axes relative to the mesh origin (the flyer's centre of mass at the hips): x right, y up (the
// back), z aft (the feet); angles in degrees. tools/lab/wingsuit.mjs measures the targets.
// ============================================================================================
const simProfile = Object.freeze({
  model: 'wingsuit',
  targets: Object.freeze({
    glideRatio: 2.5, // at the neutral-stick glide
    glideSpeed: 50, // m/s = 180 km/h, neutral stick
    speedMin: 41.7, // m/s = 150 km/h: the slow end of the pitch range (flat, best glide)
    speedMax: 61.1, // m/s = 220 km/h: the fast end (dive)
    canopySink: 5, // m/s under the open canopy, hands up
    canopyForwardMin: 8.3, // m/s = 30 km/h
    canopyForwardMax: 11.1, // m/s = 40 km/h
  }),
  mass: 92, // pilot, suit and rig
  // kg m^2 about body x (pitch), y (yaw) and z (roll): a prone human with the wings out.
  inertia: Object.freeze({ pitch: 14, yaw: 16, roll: 7 }),
  // The suit as one low aspect-ratio wing: lift curve and drag polar (best glide about 2.7 : 1).
  suit: Object.freeze({
    area: 1.5,
    span: 1.9,
    chord: 0.8,
    clAlpha: 2.9, // per rad (AR 2.4)
    clMax: 0.95,
    clMin: -0.6,
    alphaCritical: 17,
    postStallDrop: 0.3,
    stallDropWidth: 5,
    stallBlendWidth: 20,
    cd0: 0.097,
    inducedDrag: 0.34,
    sideArea: 0.9,
    sideForceSlope: 1.1,
  }),
  // Body shape sets the trim angle of attack: neutral glides, full pull reaches past the stall, full push dives.
  pitch: Object.freeze({ trimAoa: 5.3, pullRange: 18, pushRange: 2.6, stiffness: 0.6, damping: 8, stallBreak: 0.42 }),
  roll: Object.freeze({ authority: 0.014, damping: 0.45, dihedral: 0.08, autorotation: 1.6, stallReversal: 2 }),
  yaw: Object.freeze({ weathervane: 0.07, damping: 0.8, authority: 0.012, adverse: 0.002 }),
  // Ram-air canopy (about 220 sq ft): trim glide about 2 : 1 at about 36 km/h, 5 m/s down; the brakes
  // add angle of attack (the flare) and drag; front risers (push) steepen the dive.
  canopy: Object.freeze({
    area: 22,
    lineLength: 6,
    clAlpha: 3,
    trimAoa: 9,
    brakeAoa: 14,
    riserAoa: 3,
    cd0: 0.2085,
    inducedDrag: 0.12,
    brakeDrag: 0.08,
    maxBank: 40,
    bankLag: 0.6,
    aoaLag: 0.22,
    toggleRate: 5,
    pedalShare: 0.6,
    sideDamping: 2,
    swingDamping: 0.35,
  }),
  // Deployment: pilot chute and bag, then inflation; the opening shock is the drag capped at shockG.
  deploy: Object.freeze({ seconds: 2.8, bagSeconds: 0.5, suitFadeSeconds: 1, contactSwitch: 1.4, pilotChuteArea: 0.7, inflatedDrag: 0.8, shockG: 3.8 }),
  // Lowest point below the origin: the suit in flight, the feet under the canopy (radar altitude).
  radarOffset: Object.freeze({ flight: 0.2, canopy: 1.55 }),
  contacts: Object.freeze({
    // In the suit every point is the body: touching the terrain at speed is a strike.
    flight: Object.freeze([
      Object.freeze({ id: 'helmet', kind: 'body', gear: false, position: Object.freeze([0, 0.07, -1.04]) }),
      Object.freeze({ id: 'leftHand', kind: 'body', gear: false, position: Object.freeze([-0.92, 0.02, -0.42]) }),
      Object.freeze({ id: 'rightHand', kind: 'body', gear: false, position: Object.freeze([0.92, 0.02, -0.42]) }),
      Object.freeze({ id: 'chest', kind: 'body', gear: false, position: Object.freeze([0, -0.13, -0.4]) }),
      Object.freeze({ id: 'hips', kind: 'body', gear: false, position: Object.freeze([0, -0.12, 0.08]) }),
      Object.freeze({ id: 'feet', kind: 'body', gear: false, position: Object.freeze([0, -0.04, 1.0]) }),
      Object.freeze({ id: 'container', kind: 'body', gear: false, position: Object.freeze([0, 0.22, -0.25]) }),
    ]),
    // Under the canopy the pilot hangs from the shoulders: the feet are the gear (running out the
    // landing on a grippy skid), the hips a body point.
    canopy: Object.freeze([
      Object.freeze({ id: 'feet', kind: 'skid', gear: true, position: Object.freeze([0, -1.55, -0.66]), spring: 9000, damping: 1500, friction: 1.1 }),
      Object.freeze({ id: 'hips', kind: 'body', gear: false, position: Object.freeze([0, -0.72, -0.62]), spring: 20000, damping: 2500, friction: 0.9 }),
    ]),
  }),
});

// ============================================================================================
// MESH (local frame: head -z, back +y, origin at the hips; the flyer pivots at the shoulders)
// ============================================================================================
const SHOULDER_PIVOT = Object.freeze([0, 0.02, -0.62]);
const EYE = Object.freeze([0, 0.1, -1.0]);
const SHOULDER_JOINT = Object.freeze([0.2, 0.03, -0.6]);
const HIP_JOINT = Object.freeze([0.1, -0.01, 0.1]);
/** Arm (along +x from the shoulder) and leg (along +z from the hip) centre lines: [along, y, radius]. */
const ARM_PATH = Object.freeze([[0, 0, 0.065], [0.3, 0, 0.055], [0.58, 0, 0.045], [0.66, 0, 0.042], [0.74, 0.005, 0.02]]);
const LEG_PATH = Object.freeze([[0, 0, 0.085], [0.45, 0, 0.066], [0.84, 0, 0.046], [0.92, -0.02, 0.05], [0.99, -0.03, 0.028]]);
const ELBOW = 0.3;
const WRIST = 0.6;
const HAND = 0.68;
const KNEE = 0.45;
const ANKLE = 0.86;
const TUBE_SIDES = 7;

function relativeToPivot(point) {
  return [point[0] - SHOULDER_PIVOT[0], point[1] - SHOULDER_PIVOT[1], point[2] - SHOULDER_PIVOT[2]];
}

/** Rings around a centre line (points [x, y, z] with radii), lofted into a closed tube with caps. */
function tube(builder, points, radii, tintAt) {
  const direction = new THREE.Vector3();
  const basisU = new THREE.Vector3();
  const basisW = new THREE.Vector3();
  const reference = new THREE.Vector3();
  const sections = points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    direction.set(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]).normalize();
    reference.set(0, 1, 0);
    if (Math.abs(direction.dot(reference)) > 0.9) reference.set(1, 0, 0);
    basisU.crossVectors(direction, reference).normalize();
    basisW.crossVectors(direction, basisU).normalize();
    const ring = [];
    for (let side = 0; side < TUBE_SIDES; side++) {
      const angle = (side / TUBE_SIDES) * Math.PI * 2;
      const cosine = Math.cos(angle) * radii[index];
      const sine = Math.sin(angle) * radii[index];
      ring.push([
        point[0] + basisU.x * cosine + basisW.x * sine,
        point[1] + basisU.y * cosine + basisW.y * sine,
        point[2] + basisU.z * cosine + basisW.z * sine,
      ]);
    }
    return ring;
  });
  builder.loft(sections, tintAt, { capStart: tintAt(0, 0), capEnd: tintAt(points.length - 2, 0) });
}

function ellipseSections(stations, sides, pivot) {
  return stations.map(([z, centreY, halfWidth, halfHeight]) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      ring.push([halfWidth * Math.cos(angle) - pivot[0], centreY + halfHeight * Math.sin(angle) - pivot[1], z - pivot[2]]);
    }
    return ring;
  });
}

/** Torso (suit), neck and the rig container, in the flyer frame (relative to the shoulder pivot). */
function buildBody() {
  const builder = createMeshBuilder();
  // [z, centre y, half width, half height]
  const torso = [[-0.72, 0.03, 0.1, 0.08], [-0.63, 0.03, 0.21, 0.12], [-0.45, 0.02, 0.2, 0.13], [-0.2, 0, 0.165, 0.11], [0.05, 0, 0.175, 0.105], [0.16, -0.01, 0.14, 0.085]];
  builder.loft(ellipseSections(torso, 10, SHOULDER_PIVOT), (segment, face) => {
    if ((face === 0 || face === 5) && segment >= 1 && segment <= 3) return PALETTE.orange;
    return PALETTE.charcoal;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  // Rig container on the back: a low box with orange closing flaps.
  const box = (z, halfWidth, top) => [[-halfWidth, 0.1, z], [halfWidth, 0.1, z], [halfWidth, top, z], [-halfWidth, top, z]].map((point) => relativeToPivot(point));
  builder.loft([box(-0.58, 0.15, 0.2), box(-0.5, 0.16, 0.24), box(-0.08, 0.15, 0.23), box(0.02, 0.12, 0.17)], (segment, face) => (face === 2 && segment === 1 ? PALETTE.creamShade : segment === 1 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  // Neck.
  tube(builder, [relativeToPivot([0, 0.03, -0.7]), relativeToPivot([0, 0.05, -0.79])], [0.06, 0.055], () => PALETTE.charcoal);
  return builder.toGeometry(null);
}

/** Helmet: cream shell with a dark visor over the face (the face looks down and ahead). */
function buildHelmet() {
  const builder = createMeshBuilder();
  const rings = [[-0.76, 0.06], [-0.8, 0.11], [-0.88, 0.135], [-0.97, 0.127], [-1.03, 0.088], [-1.065, 0.03]];
  const sections = rings.map(([z, radius]) => {
    const ring = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      ring.push([radius * Math.cos(angle) - SHOULDER_PIVOT[0], 0.07 + radius * 0.92 * Math.sin(angle) - SHOULDER_PIVOT[1], z - SHOULDER_PIVOT[2]]);
    }
    return ring;
  });
  builder.loft(sections, (segment, face) => {
    if (segment >= 2 && segment <= 4 && face >= 4 && face <= 7) return PALETTE.charcoal;
    if (segment === 1 && (face === 1 || face === 2)) return PALETTE.orange;
    return PALETTE.cream;
  }, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  return builder.toGeometry(null);
}

/** One arm along side * x from the shoulder joint (joint frame), charcoal with an orange cuff. */
function buildArm(side) {
  const builder = createMeshBuilder();
  const points = ARM_PATH.map(([along, y]) => [side * along, y, 0]);
  tube(builder, points, ARM_PATH.map((entry) => entry[2]), (segment) => (segment === 2 ? PALETTE.orange : PALETTE.charcoal));
  return builder.toGeometry(null);
}

/** One leg along +z from the hip joint (joint frame), charcoal with an orange knee band and boots. */
function buildLeg() {
  const builder = createMeshBuilder();
  const points = LEG_PATH.map(([along, y]) => [0, y, along]);
  tube(builder, points, LEG_PATH.map((entry) => entry[2]), (segment) => (segment === 1 ? PALETTE.orange : PALETTE.charcoal));
  return builder.toGeometry(null);
}

/**
 * A fabric panel re-skinned every frame from moving points: `triangles` index into the point list;
 * `tints` colour each triangle. Double-sided so it reads from above and below.
 */
function createFabricPanel(material, pointCount, triangles, tints) {
  const positions = new Float32Array(triangles.length * 9);
  const colors = new Float32Array(triangles.length * 9);
  triangles.forEach((triangle, index) => {
    for (let corner = 0; corner < 3; corner++) {
      colors[index * 9 + corner * 3] = tints[index].r;
      colors[index * 9 + corner * 3 + 1] = tints[index].g;
      colors[index * 9 + corner * 3 + 2] = tints[index].b;
    }
  });
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const normalAttribute = new THREE.BufferAttribute(new Float32Array(triangles.length * 9), 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.6), 2.2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const points = Array.from({ length: pointCount }, () => new THREE.Vector3());
  return {
    mesh,
    points,
    /** Writes the triangles from the current points. */
    refresh() {
      triangles.forEach((triangle, index) => {
        for (let corner = 0; corner < 3; corner++) {
          const point = points[triangle[corner]];
          positions[index * 9 + corner * 3] = point.x;
          positions[index * 9 + corner * 3 + 1] = point.y;
          positions[index * 9 + corner * 3 + 2] = point.z;
        }
      });
      positionAttribute.needsUpdate = true;
      geometry.computeVertexNormals();
    },
  };
}

// The chase framing widens while the canopy is out (read by the chase camera every frame).
const chaseFraming = { canopy: 0 };
const chaseRig = Object.freeze({
  get distance() {
    return 8.5 + (17 - 8.5) * chaseFraming.canopy;
  },
  get height() {
    return 2.1 + (4.6 - 2.1) * chaseFraming.canopy;
  },
  get lookAhead() {
    return 12 - 6 * chaseFraming.canopy;
  },
});

/**
 * Builds the wingsuit flyer and its canopy. update(visual, dt) animates the limbs from the normalized
 * deflections (visual.aileron = roll, elevator = pitch / flare, rudder = yaw; under the canopy they are
 * the toggles), the fabric flutter from the airspeed, and the parachute from state.flight.craftState
 * (deploy, phase, brakes, landedSeconds).
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const fabricMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0 });
  const telemetry = ctx.state.flight;
  chaseFraming.canopy = 0;

  const root = new THREE.Group();
  root.name = 'wingsuit';
  const flyer = new THREE.Group();
  flyer.name = 'wingsuit-flyer';
  flyer.position.set(SHOULDER_PIVOT[0], SHOULDER_PIVOT[1], SHOULDER_PIVOT[2]);
  root.add(flyer);

  addSolid(flyer, buildBody(), bodyMaterial);
  // The helmet would sit over the eye: the first-person view hides it.
  const helmet = addSolid(flyer, buildHelmet(), bodyMaterial);
  helmet.userData.hideInCockpit = true;

  const arms = [];
  const legs = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.fromArray(relativeToPivot([side * SHOULDER_JOINT[0], SHOULDER_JOINT[1], SHOULDER_JOINT[2]]));
    addSolid(arm, buildArm(side), bodyMaterial);
    flyer.add(arm);
    arms.push({ group: arm, side, rest: new THREE.Vector3(side, 0, 0), direction: new THREE.Vector3(side, 0, 0) });
    const leg = new THREE.Group();
    leg.position.fromArray(relativeToPivot([side * HIP_JOINT[0], HIP_JOINT[1], HIP_JOINT[2]]));
    addSolid(leg, buildLeg(), bodyMaterial);
    flyer.add(leg);
    legs.push({ group: leg, side, rest: new THREE.Vector3(0, 0, 1), direction: new THREE.Vector3(0, 0, 1) });
  }

  // Arm wings (per side): shoulder root, elbow, wrist, trailing-edge billow, hip root.
  const armWings = [-1, 1].map((side) => {
    const panel = createFabricPanel(fabricMaterial, 5, [[0, 1, 4], [1, 3, 4], [1, 2, 3]], [PALETTE.orange, PALETTE.cream, PALETTE.orange]);
    flyer.add(panel.mesh);
    return { panel, side };
  });
  // Leg wing: crotch, left knee, left ankle, trailing billow, right ankle, right knee.
  const legWing = createFabricPanel(fabricMaterial, 6, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]], [PALETTE.orange, PALETTE.cream, PALETTE.cream, PALETTE.orange]);
  flyer.add(legWing.mesh);

  // Small wrist-side lights and a helmet strobe, so the flyer reads at night.
  const navLights = createNavLights(flyer, {
    red: { position: relativeToPivot([-0.42, 0.06, -0.6]), glow: relativeToPivot([-0.44, 0.08, -0.62]) },
    green: { position: relativeToPivot([0.42, 0.06, -0.6]), glow: relativeToPivot([0.44, 0.08, -0.62]) },
    strobe: { position: relativeToPivot([0, 0.2, -0.9]), glow: relativeToPivot([0, 0.26, -0.9]) },
  });

  const canopy = createCanopyRig(materials);
  root.add(canopy.group);
  root.add(canopy.lines);

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.fromArray(relativeToPivot(EYE));
  flyer.add(eyeAnchor);

  // Animated pose (damped toward the targets every frame).
  const pose = { hang: 0, sweep: [12 * DEG, 12 * DEG], droop: [4 * DEG, 4 * DEG], spread: [9 * DEG, 9 * DEG], landed: 0, flare: 0 };
  const wingtips = [new THREE.Vector3(-0.92, 0.03, -0.42), new THREE.Vector3(0.92, 0.03, -0.42)];
  const scratch = new THREE.Vector3();
  const armFlight = new THREE.Vector3();
  const armCanopy = new THREE.Vector3();
  const legFlight = new THREE.Vector3();
  const legCanopy = new THREE.Vector3();
  const rootMatrix = new THREE.Matrix4();
  const risers = [new THREE.Vector3(), new THREE.Vector3()];
  const hands = [new THREE.Vector3(), new THREE.Vector3()];
  const back = new THREE.Vector3();
  const canopyPose = { deploy: 0, collapse: 0, brakeLeft: 0, brakeRight: 0, risers, hands, back, time: 0 };
  const shoulderRoots = [new THREE.Vector3().fromArray(relativeToPivot([-0.19, 0.01, -0.6])), new THREE.Vector3().fromArray(relativeToPivot([0.19, 0.01, -0.6]))];
  const hipRoots = [new THREE.Vector3().fromArray(relativeToPivot([-0.17, 0, 0.14])), new THREE.Vector3().fromArray(relativeToPivot([0.17, 0, 0.14]))];
  const crotch = new THREE.Vector3().fromArray(relativeToPivot([0, -0.02, 0.2]));
  const riserLocal = [new THREE.Vector3().fromArray(relativeToPivot([-0.15, 0.16, -0.57])), new THREE.Vector3().fromArray(relativeToPivot([0.15, 0.16, -0.57]))];
  const backLocal = new THREE.Vector3().fromArray(relativeToPivot([0, 0.24, -0.3]));

  /** Local point of a limb (arm along side * x, leg along z) in the flyer frame. */
  function limbPoint(limb, local, target) {
    return target.copy(local).applyQuaternion(limb.group.quaternion).add(limb.group.position);
  }

  function aim(limb, target, lambda, dt) {
    if (dt > 0) limb.direction.lerp(target, 1 - Math.exp(-lambda * dt)).normalize();
    else limb.direction.copy(target);
    limb.group.quaternion.setFromUnitVectors(limb.rest, limb.direction);
  }

  return {
    root,
    wingtips,
    eyeAnchor,
    /** Local attachment points: the container (smoke / trails) and the feet. */
    anchors: {
      tail: new THREE.Vector3(0, -0.02, 1.0),
      container: new THREE.Vector3(0, 0.24, -0.3),
    },

    update(visual, dt) {
      const step = Math.max(0, Math.min(dt, 0.05));
      const craftState = telemetry.craftState || {};
      const deploy = craftState.canopy ? clamp(Number.isFinite(craftState.deploy) ? craftState.deploy : 1, 0, 1) : 0;
      const landed = craftState.phase === 'landed' ? smooth01((Number(craftState.landedSeconds) || 0) / 1.2) : 0;
      const time = visual.time ? visual.time.elapsed : 0;
      const airspeed = Number.isFinite(telemetry.airspeed) ? telemetry.airspeed : 0;
      const roll = clamp(Number.isFinite(visual.aileron) ? visual.aileron : 0, -1, 1);
      const pitch = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1);
      const yaw = clamp(Number.isFinite(visual.rudder) ? visual.rudder : 0, -1, 1);
      const brakeLeft = clamp(Number(craftState.brakeLeft) || 0, 0, 1);
      const brakeRight = clamp(Number(craftState.brakeRight) || 0, 0, 1);

      // Swing from prone to hanging as the canopy opens.
      const hangTarget = smooth01((deploy - 0.3) / 0.5);
      pose.hang = step > 0 ? damp(pose.hang, hangTarget, 3.5, step) : hangTarget;
      pose.landed = step > 0 ? damp(pose.landed, landed, 4, step) : landed;
      flyer.rotation.x = pose.hang * Math.PI * 0.5;
      chaseFraming.canopy = smooth01(deploy * 1.4);

      // Arms: sweep back to dive, forward to flare; the low wing's arm sweeps back and drops.
      const sweepBase = 12 * DEG - 10 * DEG * Math.max(0, pitch) + 22 * DEG * Math.max(0, -pitch);
      for (const arm of arms) {
        const index = arm.side < 0 ? 0 : 1;
        const sweepTarget = sweepBase + arm.side * 7 * DEG * roll;
        const droopTarget = 4 * DEG + arm.side * 12 * DEG * roll;
        pose.sweep[index] = step > 0 ? damp(pose.sweep[index], sweepTarget, 8, step) : sweepTarget;
        pose.droop[index] = step > 0 ? damp(pose.droop[index], droopTarget, 8, step) : droopTarget;
        const sweep = pose.sweep[index];
        const droop = pose.droop[index];
        armFlight.set(arm.side * Math.cos(sweep) * Math.cos(droop), -Math.sin(droop), Math.sin(sweep) * Math.cos(droop));
        // Under the canopy: hands up on the toggles (toward the head), pulled down by the brakes;
        // after landing the arms drop to the sides.
        const brake = arm.side < 0 ? brakeLeft : brakeRight;
        armCanopy.set(arm.side * (0.35 + 0.5 * brake), 0.22, -1 + 1.25 * brake).normalize();
        scratch.set(arm.side * 0.28, -0.1, 1).normalize();
        armCanopy.lerp(scratch, pose.landed).normalize();
        armFlight.lerp(armCanopy, pose.hang).normalize();
        aim(arm, armFlight, 10, step);
      }
      // Legs: spread to flare, together to dive, the pedal side opens; hanging: together and slightly
      // forward, then straight to stand.
      const spreadBase = 9 * DEG + 7 * DEG * Math.max(0, pitch) - 5 * DEG * Math.max(0, -pitch);
      for (const leg of legs) {
        const index = leg.side < 0 ? 0 : 1;
        const spreadTarget = spreadBase + leg.side * 5 * DEG * yaw;
        pose.spread[index] = step > 0 ? damp(pose.spread[index], spreadTarget, 6, step) : spreadTarget;
        legFlight.set(leg.side * Math.sin(pose.spread[index]), 0, Math.cos(pose.spread[index]));
        legCanopy.set(leg.side * 0.07, -0.22 * (1 - pose.landed), 1).normalize();
        legFlight.lerp(legCanopy, pose.hang).normalize();
        aim(leg, legFlight, 8, step);
      }

      // Fabric: re-skin the wings between the moving limbs, fluttering at the trailing edges.
      const flutterAmplitude = (0.006 + 0.022 * clamp(airspeed / 55, 0, 1.4)) * (1 - 0.7 * pose.hang);
      const flutterPhase = time * (7 + 5 * clamp(airspeed / 50, 0, 1.5)) * Math.PI * 2;
      for (const wing of armWings) {
        const index = wing.side < 0 ? 0 : 1;
        const arm = arms[index];
        const points = wing.panel.points;
        points[0].copy(shoulderRoots[index]);
        limbPoint(arm, scratch.set(arm.side * ELBOW, 0, 0), points[1]);
        limbPoint(arm, scratch.set(arm.side * WRIST, 0, 0), points[2]);
        points[4].copy(hipRoots[index]);
        points[3].lerpVectors(points[2], points[4], 0.5);
        points[3].z += 0.1;
        points[3].x -= wing.side * 0.06;
        points[3].y += flutterAmplitude * Math.sin(flutterPhase + index * 1.7);
        wing.panel.refresh();
      }
      {
        const points = legWing.points;
        points[0].copy(crotch);
        limbPoint(legs[0], scratch.set(0, 0, KNEE), points[1]);
        limbPoint(legs[0], scratch.set(0, 0, ANKLE), points[2]);
        limbPoint(legs[1], scratch.set(0, 0, ANKLE), points[4]);
        limbPoint(legs[1], scratch.set(0, 0, KNEE), points[5]);
        points[3].lerpVectors(points[2], points[4], 0.5);
        points[3].z -= 0.12;
        points[3].y += flutterAmplitude * 1.3 * Math.sin(flutterPhase * 0.83 + 0.9);
        legWing.refresh();
      }

      // Contrail points at the hands (root frame).
      flyer.updateMatrix();
      rootMatrix.copy(flyer.matrix);
      for (let index = 0; index < 2; index++) {
        limbPoint(arms[index], scratch.set(arms[index].side * HAND, 0, 0), wingtips[index]);
        wingtips[index].applyMatrix4(rootMatrix);
      }

      // Canopy: risers at the shoulders, brake lines to the hands, the container on the back.
      canopyPose.deploy = deploy;
      canopyPose.collapse = landed;
      canopyPose.brakeLeft = brakeLeft;
      canopyPose.brakeRight = brakeRight;
      canopyPose.time = time;
      for (let index = 0; index < 2; index++) {
        risers[index].copy(riserLocal[index]).applyMatrix4(rootMatrix);
        hands[index].copy(wingtips[index]);
      }
      back.copy(backLocal).applyMatrix4(rootMatrix);
      canopy.update(canopyPose);

      navLights.animate(visual.time);
    },

    dispose() {
      chaseFraming.canopy = 0;
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: deploy the parachute (SIM; in CLASSIC the button boosts like v1). It also keeps the
// wingsuit's speed and proximity cue (craftState.proximity, craftState.windStreaks for the wind
// streaks) and brings the flyer back up: after a canopy landing (SIM) it relaunches from the nearest
// peak after a short pause, and in CLASSIC once the flyer has run out of height and speed.
// ============================================================================================
const AUTO_RELAUNCH_SECONDS = 3;
const CLASSIC_LOW = Object.freeze({ AGL: 60, SECONDS: 4 });
const PROXIMITY_RANGE = 90;

const craftAbility = Object.freeze({
  label: 'Deploy parachute',
  modes: Object.freeze(['sim']),
  initialState: () => ({
    canopy: false,
    phase: 'flight',
    deploy: 0,
    deployRequested: false,
    brakeLeft: 0,
    brakeRight: 0,
    landedSeconds: 0,
    openingG: 0,
    swing: 0,
    proximityWarning: null,
    clearance: Infinity,
    impactSeconds: Infinity,
    proximity: 0,
    windStreaks: 0,
    lowSeconds: 0,
  }),
  run(flight) {
    const craftState = flight.craftState;
    if (craftState.canopy) {
      flight.notify(craftState.phase === 'landed' ? 'Already down. Relaunch to fly again.' : 'The canopy is already out.');
      return false;
    }
    craftState.deployRequested = true;
    return true;
  },
  update(flight, dt) {
    const craftState = flight.craftState;
    const telemetry = flight.telemetry;
    const agl = Number.isFinite(telemetry.agl) ? telemetry.agl : Infinity;
    const airspeed = Number.isFinite(telemetry.airspeed) ? telemetry.airspeed : 0;
    const flying = !craftState.canopy && !telemetry.onGround;
    const proximity = flying ? Math.pow(clamp(1 - agl / PROXIMITY_RANGE, 0, 1), 1.4) * smooth01((airspeed - 20) / 20) : 0;
    craftState.proximity = proximity;
    craftState.windStreaks = flying ? clamp(smooth01((airspeed - 36) / 28) * 0.5 + proximity * 0.8, 0, 1) : 0;
    if (flight.mode === 'sim') {
      craftState.lowSeconds = 0;
      if (craftState.phase === 'landed' && craftState.landedSeconds >= AUTO_RELAUNCH_SECONDS && typeof flight.relaunch === 'function') {
        flight.notify('Packed up. Back to a peak.');
        flight.relaunch();
      }
      return;
    }
    // CLASSIC: skimming the ground stalled means the glide is over; take the flyer back up.
    const low = agl < CLASSIC_LOW.AGL && flight.player.stalled;
    craftState.lowSeconds = low ? craftState.lowSeconds + dt : 0;
    if (craftState.lowSeconds > CLASSIC_LOW.SECONDS && typeof flight.relaunch === 'function') {
      craftState.lowSeconds = 0;
      flight.notify('Out of height. Back up to a peak.');
      flight.relaunch();
    }
  },
});

export default Object.freeze({
  id: 'wingsuit',
  name: 'Wingsuit',
  buildMesh,
  arcadeProfile,
  simProfile,
  /**
   * ControlState mapping: no throttle (the axis is ignored and hidden in the hints); the HOTAS antenna
   * zooms the lens. Under the canopy the stick roll, rudder pedals and toe brakes pull the toggles and
   * pulling the stick flares.
   */
  inputProfile: Object.freeze({ throttle: 'none', antenna: 'zoom', toeBrakes: 'canopyToggles', flapNotches: 0 }),
  audioProfile: Object.freeze({ engine: 'wingsuit', flutterHz: 14, proximityRange: PROXIMITY_RANGE, airflowSpeed: 55, classicAirflowSpeed: 68 }),
  capabilities: Object.freeze({ chute: true, engine: false }),
  cameraRig: Object.freeze({
    // First person from the helmet (hidden in that view): the arm wings in the corners of the view.
    eye: EYE,
    chase: chaseRig,
    // A wrist camera looking back along the arm wing at the pilot.
    wing: Object.freeze({ position: Object.freeze([1.02, 0.28, -0.3]), target: Object.freeze([0.05, 0.02, -0.55]) }),
    fpv: null,
    cockpit: Object.freeze({ style: 'none', near: 0.05 }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'heading', 'vsi', 'glide', 'proximity']),
  abilities: Object.freeze({ craftAbility }),
  // Starts from a peak: diving off the edge at a sensible speed (SIM and CLASSIC); a soft crash also
  // restarts from a peak (a flyer that cannot climb, respawned over water or low ground, would sink again).
  spawn: Object.freeze({ cruise: 50, hover: false, relaunch: 'peak', respawn: 'peak', canStartOnGround: false, peakDive: Object.freeze({ angle: 30, speed: 38, classicSpeed: 42 }) }),
  limits: Object.freeze({ vne: 85, gLimit: 5, crashSinkRate: 7, bodyStrikeSpeed: 8, floats: false }),
});
