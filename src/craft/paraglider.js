// PARAGLIDER: an EN-B class paraglider, built from code in the v1 craft style (flat-shaded,
// vertex-coloured lofts in the v1 palette): a sixteen-cell elliptical ram-air wing on an arc, re-skinned
// every frame so its trailing edge deflects under each brake, its tips fold under for big ears or in a
// collapse, the fabric flutters with the airspeed, and it lies down crumpled behind the pilot after a
// landing and rises on its arc during an inflation; the suspension lines and brake lines run from the
// cells to the risers and the pilot's hands; the pilot sits in a harness with a back protector, hands
// on the brake handles (they come down with the brakes), legs on the speed bar (they push it out),
// leaning into a weight shift, and stands up to land and to run on a launch.
//
// It flies SimParaglider (src/flight/SimParaglider.js): a two-body pendulum, canopy and pilot.
import * as THREE from 'three/webgpu';
import { DEG, clamp, damp, headingFromVector, wrapDegrees } from '../core/util.js';
import { PALETTE, createMeshBuilder, getCraftMaterials, addSolid, createNavLights, disposeCraftMesh, smooth01 } from './kit.js';

// ============================================================================================
// SIM: SimParaglider (src/flight/SimParaglider.js). Targets first, then the parameters that meet them.
// Body axes relative to the mesh origin (the pilot's centre of mass at the harness seat): x right,
// y up (along the lines), z aft; angles in degrees. tools/lab/paraglider.mjs measures the targets.
// ============================================================================================
const simProfile = Object.freeze({
  model: 'paraglider',
  targets: Object.freeze({
    glideRatio: 9, // at trim, hands up
    trimSpeed: 10.56, // m/s = 38 km/h
    fullBarSpeed: 13.9, // m/s = 50 km/h with the speed bar fully out
    minSpeed: 6.9, // m/s = 25 km/h, both brakes deep
    trimSink: 1.17, // m/s
    bigEarsSink: 2.8, // m/s with the big ears in, hands off
    fullBrakeTurn: 40, // deg/s with one brake fully down
    weightShiftTurn: 9, // deg/s with a full weight shift alone
  }),
  // All up 97.5 kg: pilot, harness and gear hang under 5.5 kg of wing.
  pilot: Object.freeze({ mass: 92, dragArea: 0.5 }),
  // The wing: its fabric weighs 5.5 kg and carries about 6.5 kg of air inside and around it.
  canopy: Object.freeze({ mass: 5.5, airMass: 6.5 }),
  // From the pilot's centre of mass to the canopy's aerodynamic centre.
  lines: Object.freeze({ length: 7.2 }),
  // Projected area and span (flat: about 25.5 m^2 and 11.4 m), the polar and the lift curve, the
  // rigging incidence that puts the trim at 38 km/h, the side force of the arc, and the moment arms
  // of the halves (drag difference: yaw; lift difference: roll).
  wing: Object.freeze({
    area: 22,
    span: 9.6,
    clAlpha: 3.6,
    clMax: 1.35,
    clMin: -0.4,
    alphaCritical: 18,
    postStallDrop: 0.35,
    stallDropWidth: 5,
    stallBlendWidth: 30,
    cd0: 0.03,
    inducedDrag: 0.045,
    incidence: 2.3,
    incidenceLag: 0.22,
    // The canopy's pitch inertia: the incidence it gains per rad/s of the lines swinging forward.
    pitchInertia: 0.25,
    sideForce: 0.75,
    yawArm: 2.3,
    rollArm: 2.2,
    // Out of a stall with the brakes coming up (below surgeBrake), the canopy pitches forward by up to this.
    surgePitch: 30,
    surgeBrake: 0.55,
  }),
  // Pilot inputs: brake travel (camber lift, stall lift, drag, the incidence the brakes add and the
  // pressure they give the cells), the speed bar's incidence, released trimmers as a share of the bar,
  // weight shift (how far a full shift tilts the wing's lift), and how fast arms and legs move (1/s).
  controls: Object.freeze({
    brakeCl: 0.45,
    brakeClMax: 0.35,
    brakeDrag: 0.12,
    brakeIncidence: 5.5,
    brakePressure: 6,
    barIncidence: 5.5,
    trimmerShare: 0.5,
    weightShiftTilt: 1.6,
    brakeRate: 3.2,
    barRate: 2,
    weightShiftRate: 2.5,
  }),
  // Canopy yaw: inertia (kg m^2, fabric and the air it carries), weathervane stability, rate damping
  // and the warp of a full weight shift.
  yaw: Object.freeze({ inertia: 60, weathervane: 0.08, damping: 0.03, weightShift: 0.0016 }),
  // Big ears: the share of each half that folds under, the folded fabric's drag, the incidence change
  // (the outer A lines pulled down lower the leading edge, which keeps the wing near its trim speed
  // against the drag of the folded tips) and how long the fold takes to pull in and to reopen.
  bigEars: Object.freeze({ share: 0.17, foldDrag: 0.7, incidence: -5, foldSeconds: 1.2, openSeconds: 2 }),
  // Collapses: the pressure angle below which a half folds, the deficit that folds it fully (to
  // maxDepth), the span-scale gust at full turbulence and its frequency (Hz), the onset rate (1/s) once
  // the cells have lost pressure for onsetDelay seconds, recovery rates (1/s; recovery grows with
  // airspeed, a pumped brake and a held half brake), the folded drag and how deep a collapse counts.
  collapse: Object.freeze({
    angle: 0.5,
    span: 5,
    maxDepth: 0.7,
    share: 0.85,
    gust: 6,
    frequency: 0.8,
    onsetRate: 4,
    onsetDelay: 0.1,
    recoverRate: 0.16,
    pumpRecover: 0.9,
    brakeRecover: 0.25,
    foldDrag: 1,
    minAirspeed: 4,
    countDepth: 0.15,
  }),
  // Ground handling and launches: the wing lies at lyingAngle behind the pilot, inflates over
  // inflateSeconds (faster in a breeze), pulls back while rising, sits at trimTilt overhead; the pilot
  // runs at up to runSpeed; a run that has not lifted off after abortSeconds stops. A landed wing
  // deflates over deflateSeconds and slides with groundFriction (1/s).
  launch: Object.freeze({
    lyingAngle: 80,
    trimTilt: 2,
    inflateSeconds: 2.2,
    inflateAirspeed: 4,
    inflationPull: 140,
    runSpeed: 5.5,
    runAccel: 3.2,
    abortSeconds: 14,
    deflateSeconds: 1.4,
    groundFriction: 6,
    minGrade: 0.06,
  }),
  // The feet below the pilot's centre of mass (radar altitude).
  radarOffset: 0.95,
  // The feet roll like a braked wheel (standing, running, the run-out after a touchdown); the seat
  // slides (a sit-down landing); the head is the body (a strike at speed is a soft crash).
  contacts: Object.freeze([
    Object.freeze({ id: 'feet', kind: 'wheel', gear: true, brake: true, position: Object.freeze([0, -0.95, -0.1]), spring: 14000, damping: 2200, rollingFriction: 0.05, brakeFriction: 1.2, sideFriction: 1.1 }),
    Object.freeze({ id: 'seat', kind: 'skid', gear: true, position: Object.freeze([0, -0.36, 0.22]), spring: 18000, damping: 2600, friction: 0.9 }),
    Object.freeze({ id: 'head', kind: 'body', gear: false, position: Object.freeze([0, 0.74, 0.06]) }),
  ]),
});

// ============================================================================================
// MESH (local frame: forward -z, up +y along the lines, origin at the pilot's centre of mass)
// ============================================================================================
const EYE = Object.freeze([0, 0.64, -0.06]);
const RIBS = 17;
const CELLS = RIBS - 1;
/** The wing on its arc: radius, half angle, root and tip chord, the tips' sweep back. */
const WING = Object.freeze({ ARC_RADIUS: 5.9, HALF_ANGLE: 0.95, ROOT_CHORD: 2.75, TIP_CHORD: 0.95, SWEEP: 0.45, THICKNESS: 0.15, CENTER_CHORD: 0.42 });
/** Section (LE top -> upper -> TE -> lower -> LE bottom), [chord fraction, thickness units]; the face from the last point to the first is the cell mouth. */
const PROFILE = Object.freeze([[0.02, 0.32], [0.12, 0.62], [0.35, 0.68], [0.65, 0.46], [1, 0.02], [0.65, -0.06], [0.3, -0.12], [0.04, -0.2]]);
const POINTS = PROFILE.length;
const MOUTH_EDGE = POINTS - 1;
/** Brake flap: points aft of the hinge chord fraction turn down; each rib takes a share of its side's brake (tips most). */
const FLAP_HINGE = 0.55;
const MAX_FLAP = 42 * DEG;
/** Big ears fold the outer share of each half; a collapse folds from its tip inward with its depth. */
const EARS_HINGE = 1 - 2 * 0.17;
const EARS_ANGLE = 150 * DEG;
const COLLAPSE_ANGLE = 165 * DEG;
/** Line attachments on every other rib: A and C rows (chord fractions, on the lower surface). */
const LINE_STATIONS = Object.freeze([0.12, 0.62]);
const LINE_RIB_STEP = 2;
/** Brake lines from these ribs' trailing edges to the hands. */
const BRAKE_RIBS = Object.freeze([0, 1, 2, 3, 4, 12, 13, 14, 15, 16]);
const RISER_TOPS = Object.freeze([Object.freeze([-0.2, 0.68, 0.02]), Object.freeze([0.2, 0.68, 0.02])]);
const CARABINERS = Object.freeze([Object.freeze([-0.19, 0.16, 0.02]), Object.freeze([0.19, 0.16, 0.02])]);
const SHOULDERS = Object.freeze([Object.freeze([-0.19, 0.42, 0.05]), Object.freeze([0.19, 0.42, 0.05])]);
const HIPS = Object.freeze([Object.freeze([-0.1, -0.13, -0.02]), Object.freeze([0.1, -0.13, -0.02])]);
const ARM = Object.freeze({ UPPER: 0.3, FOREARM: 0.3 });
const LEG = Object.freeze({ THIGH: 0.44, SHIN: 0.44 });
const TUBE_SIDES = 6;
const SEGMENT_COUNT = Math.ceil(RIBS / LINE_RIB_STEP) * LINE_STATIONS.length + BRAKE_RIBS.length + 2 + 2;

/** Upper-surface colours per cell (mirrored): the v1 orange and cream; the lower surface is shaded. */
const SHADED_ORANGE = PALETTE.orange.clone().multiplyScalar(0.84);
const CELL_TINTS = Object.freeze(['charcoal', 'cream', 'orange', 'orange', 'cream', 'cream', 'orange', 'cream']);

function cellTint(cell, edge) {
  if (edge === MOUTH_EDGE) return PALETTE.charcoal;
  const name = CELL_TINTS[cell < CELLS / 2 ? cell : CELLS - 1 - cell];
  const lower = edge >= 4;
  const base = PALETTE[name];
  if (!lower) return base;
  return name === 'cream' ? PALETTE.creamShade : name === 'orange' ? SHADED_ORANGE : PALETTE.charcoal;
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
    reference.set(1, 0, 0);
    if (Math.abs(direction.dot(reference)) > 0.9) reference.set(0, 0, 1);
    basisU.crossVectors(direction, reference).normalize();
    basisW.crossVectors(direction, basisU).normalize();
    const ring = [];
    for (let side = 0; side < TUBE_SIDES; side++) {
      const angle = (side / TUBE_SIDES) * Math.PI * 2;
      const cosine = Math.cos(angle) * radii[index];
      const sine = Math.sin(angle) * radii[index];
      ring.push([point[0] + basisU.x * cosine + basisW.x * sine, point[1] + basisU.y * cosine + basisW.y * sine, point[2] + basisU.z * cosine + basisW.z * sine]);
    }
    return ring;
  });
  builder.loft(sections, tintAt, { capStart: tintAt(0, 0), capEnd: tintAt(points.length - 2, 0) });
}

function ellipseSections(stations, sides) {
  return stations.map(([y, centreZ, halfWidth, halfDepth]) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      ring.push([halfWidth * Math.cos(angle), y, centreZ + halfDepth * Math.sin(angle)]);
    }
    return ring;
  });
}

/** Harness (seat board, back protector, side straps) and the torso in a jacket. */
function buildBody() {
  const builder = createMeshBuilder();
  // Back protector and seat: a deep charcoal shell behind and under the pilot, orange piping.
  const shell = (y, front, back, halfWidth) => [[-halfWidth, y, back], [halfWidth, y, back], [halfWidth, y, front], [-halfWidth, y, front]];
  builder.loft([shell(-0.36, -0.12, 0.34, 0.2), shell(-0.28, -0.2, 0.36, 0.23), shell(-0.05, -0.08, 0.32, 0.22), shell(0.28, 0.12, 0.3, 0.19)], (segment, face) => (face === 0 && segment === 1 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  // Torso: hips to shoulders, [y, centre z, half width, half depth].
  builder.loft(ellipseSections([[-0.12, 0.06, 0.15, 0.11], [0.05, 0.05, 0.16, 0.12], [0.25, 0.06, 0.19, 0.12], [0.42, 0.07, 0.2, 0.11], [0.48, 0.07, 0.1, 0.07]], 9), (segment, face) => {
    if (segment === 2 && (face === 6 || face === 7)) return PALETTE.cream;
    return segment >= 1 ? PALETTE.orange : PALETTE.charcoal;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  // Neck.
  tube(builder, [[0, 0.47, 0.07], [0, 0.55, 0.07]], [0.055, 0.05], () => PALETTE.creamShade);
  // Flight deck on the pilot's lap: the instrument pod.
  const deck = (z, halfWidth, top) => [[-halfWidth, -0.08, z], [halfWidth, -0.08, z], [halfWidth, top, z], [-halfWidth, top, z]];
  builder.loft([deck(-0.5, 0.11, -0.02), deck(-0.38, 0.13, 0.01), deck(-0.26, 0.12, 0)], (segment, face) => (face === 2 ? PALETTE.charcoal : PALETTE.creamShade), { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

/** Helmet: orange shell, cream crown stripe, a dark visor facing forward. */
function buildHelmet() {
  const builder = createMeshBuilder();
  const rings = [[0.52, 0.06], [0.56, 0.12], [0.63, 0.14], [0.7, 0.13], [0.76, 0.09], [0.79, 0.03]];
  const sections = rings.map(([y, radius]) => {
    const ring = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), y, 0.07 + radius * 0.95 * Math.sin(angle)]);
    }
    return ring;
  });
  builder.loft(sections, (segment, face) => {
    if (segment >= 1 && segment <= 2 && face >= 5 && face <= 7) return PALETTE.charcoal;
    if (segment >= 3 && (face === 1 || face === 2)) return PALETTE.cream;
    return PALETTE.orange;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

/** A limb segment along +y from its joint (0) to length, tapering. */
function buildSegment(length, rootRadius, tipRadius, tint, endTint) {
  const builder = createMeshBuilder();
  tube(builder, [[0, 0, 0], [0, length * 0.5, 0], [0, length, 0]], [rootRadius, (rootRadius + tipRadius) / 2, tipRadius], (segment) => (segment === 1 && endTint ? endTint : tint));
  return builder.toGeometry(null);
}

/** The speed bar: a short tube across the feet. */
function buildSpeedBar() {
  const builder = createMeshBuilder();
  tube(builder, [[-0.2, 0, 0], [0, 0, 0], [0.2, 0, 0]], [0.018, 0.018, 0.018], () => PALETTE.charcoal);
  return builder.toGeometry(null);
}

/** A brake handle: a small orange toggle. */
function buildHandle() {
  const builder = createMeshBuilder();
  tube(builder, [[0, -0.05, 0], [0, 0, 0], [0, 0.05, 0]], [0.022, 0.03, 0.022], () => PALETTE.orange);
  return builder.toGeometry(null);
}

/**
 * The canopy's dynamic surface: every rib's section points are rewritten each frame (canopy frame:
 * origin at the top centre of the arc at the aerodynamic centre, x span, y away from the pilot, z aft)
 * and the cells are re-skinned from them, with flat normals.
 */
function createCanopySurface(material) {
  const triangleCount = CELLS * POINTS * 2 + 2 * (POINTS - 2);
  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);
  const ribPoints = new Float32Array(RIBS * POINTS * 3);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const normalAttribute = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -2, 0), 9);
  // Colours never change: write them once in the triangle order refresh() uses.
  let triangle = 0;
  const paint = (tint) => {
    for (let corner = 0; corner < 3; corner++) {
      colors[triangle * 9 + corner * 3] = tint.r;
      colors[triangle * 9 + corner * 3 + 1] = tint.g;
      colors[triangle * 9 + corner * 3 + 2] = tint.b;
    }
    triangle++;
  };
  for (let cell = 0; cell < CELLS; cell++) {
    for (let edge = 0; edge < POINTS; edge++) {
      paint(cellTint(cell, edge));
      paint(cellTint(cell, edge));
    }
  }
  for (let cap = 0; cap < 2; cap++) for (let fan = 0; fan < POINTS - 2; fan++) paint(PALETTE.creamShade);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'paraglider-canopy';
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  let cursor = 0;
  function writeTriangle(a, b, c) {
    const ax = ribPoints[a];
    const ay = ribPoints[a + 1];
    const az = ribPoints[a + 2];
    const bx = ribPoints[b] - ax;
    const by = ribPoints[b + 1] - ay;
    const bz = ribPoints[b + 2] - az;
    const cx = ribPoints[c] - ax;
    const cy = ribPoints[c + 1] - ay;
    const cz = ribPoints[c + 2] - az;
    let nx = by * cz - bz * cy;
    let ny = bz * cx - bx * cz;
    let nz = bx * cy - by * cx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const offset = cursor * 9;
    for (let corner = 0; corner < 3; corner++) {
      const source = corner === 0 ? a : corner === 1 ? b : c;
      positions[offset + corner * 3] = ribPoints[source];
      positions[offset + corner * 3 + 1] = ribPoints[source + 1];
      positions[offset + corner * 3 + 2] = ribPoints[source + 2];
      normals[offset + corner * 3] = nx;
      normals[offset + corner * 3 + 1] = ny;
      normals[offset + corner * 3 + 2] = nz;
    }
    cursor++;
  }
  const index = (rib, point) => (rib * POINTS + point) * 3;

  return {
    mesh,
    ribPoints,
    index,
    /** Re-skins the cells (and the two tip ribs) from ribPoints. */
    refresh() {
      cursor = 0;
      for (let cell = 0; cell < CELLS; cell++) {
        for (let edge = 0; edge < POINTS; edge++) {
          const next = (edge + 1) % POINTS;
          writeTriangle(index(cell, edge), index(cell + 1, edge), index(cell + 1, next));
          writeTriangle(index(cell, edge), index(cell + 1, next), index(cell, next));
        }
      }
      for (const rib of [0, RIBS - 1]) {
        for (let fan = 1; fan < POINTS - 1; fan++) writeTriangle(index(rib, 0), index(rib, fan), index(rib, fan + 1));
      }
      positionAttribute.needsUpdate = true;
      normalAttribute.needsUpdate = true;
    },
  };
}

/** Two-bone IK: the joint between root and target (segment lengths a, b) bending toward pole. */
function solveJoint(root, target, a, b, pole, joint, scratch) {
  const direction = scratch.direction.copy(target).sub(root);
  const reach = Math.min(Math.max(direction.length(), Math.abs(a - b) + 1e-3), a + b - 1e-3);
  if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0);
  direction.normalize();
  const cosine = clamp((a * a + reach * reach - b * b) / (2 * a * reach), -1, 1);
  const sine = Math.sqrt(1 - cosine * cosine);
  const bend = scratch.bend.copy(pole).addScaledVector(direction, -pole.dot(direction));
  if (bend.lengthSq() < 1e-8) bend.set(0, 0, -1);
  bend.normalize();
  return joint.copy(root).addScaledVector(direction, a * cosine).addScaledVector(bend, a * sine);
}

/** Points a limb segment group (geometry along +y) from `from` toward `to`. */
function aimSegment(group, from, to, scratch) {
  group.position.copy(from);
  scratch.direction.copy(to).sub(from);
  if (scratch.direction.lengthSq() < 1e-8) return;
  scratch.direction.normalize();
  group.quaternion.setFromUnitVectors(scratch.up, scratch.direction);
}

// The chase framing (read by the chase camera every frame).
const chaseRig = Object.freeze({ distance: 15, height: 4, lookAhead: 6, speedRange: Object.freeze({ CRUISE: 10.5, MAX: 14, TOP: 22 }) });

/**
 * Builds the paraglider. update(visual, dt) animates the wing from visual.craftState (brakes, speed
 * bar, big ears, collapses, inflation, the canopy's offset and pitch over the pilot) and the airspeed,
 * and the pilot from the same state (arms on the brakes, legs on the bar or standing and running,
 * the lean of a weight shift).
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const fabricMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.6, metalness: 0 });
  const telemetry = ctx.state.flight;

  const root = new THREE.Group();
  root.name = 'paraglider';

  // ---- Pilot -----------------------------------------------------------------------------------
  const pilot = new THREE.Group();
  pilot.name = 'paraglider-pilot';
  root.add(pilot);
  addSolid(pilot, buildBody(), bodyMaterial);
  const helmet = addSolid(pilot, buildHelmet(), bodyMaterial);
  helmet.userData.hideInCockpit = true;
  const upperArmGeometry = buildSegment(ARM.UPPER, 0.055, 0.045, PALETTE.orange, null);
  const forearmGeometry = buildSegment(ARM.FOREARM, 0.045, 0.038, PALETTE.orange, PALETTE.charcoal);
  const thighGeometry = buildSegment(LEG.THIGH, 0.075, 0.06, PALETTE.charcoal, null);
  const shinGeometry = buildSegment(LEG.SHIN, 0.055, 0.045, PALETTE.charcoal, PALETTE.orange);
  const handleGeometry = buildHandle();
  const limbs = [-1, 1].map((side) => {
    const upperArm = new THREE.Group();
    const forearm = new THREE.Group();
    const thigh = new THREE.Group();
    const shin = new THREE.Group();
    const handle = new THREE.Group();
    addSolid(upperArm, upperArmGeometry, bodyMaterial);
    addSolid(forearm, forearmGeometry, bodyMaterial);
    addSolid(thigh, thighGeometry, bodyMaterial);
    addSolid(shin, shinGeometry, bodyMaterial);
    addSolid(handle, handleGeometry, bodyMaterial);
    pilot.add(upperArm, forearm, thigh, shin, handle);
    return {
      side,
      upperArm,
      forearm,
      thigh,
      shin,
      handle,
      shoulder: new THREE.Vector3().fromArray(SHOULDERS[side < 0 ? 0 : 1]),
      hip: new THREE.Vector3().fromArray(HIPS[side < 0 ? 0 : 1]),
      hand: new THREE.Vector3(side * 0.24, 0.72, -0.04),
      elbow: new THREE.Vector3(),
      foot: new THREE.Vector3(side * 0.12, -0.52, -0.48),
      knee: new THREE.Vector3(),
      armPole: new THREE.Vector3(side * 0.8, -0.2, 0.6),
    };
  });
  const speedBar = new THREE.Group();
  addSolid(speedBar, buildSpeedBar(), bodyMaterial);
  pilot.add(speedBar);
  const navLights = createNavLights(pilot, {
    red: { position: [-0.3, -0.1, 0.12], glow: [-0.33, -0.1, 0.12] },
    green: { position: [0.3, -0.1, 0.12], glow: [0.33, -0.1, 0.12] },
    strobe: { position: [0, 0.81, 0.08], glow: [0, 0.86, 0.08] },
  });

  // ---- Canopy and lines ------------------------------------------------------------------------
  const canopyGroup = new THREE.Group();
  canopyGroup.name = 'paraglider-wing';
  root.add(canopyGroup);
  const surface = createCanopySurface(fabricMaterial);
  canopyGroup.add(surface.mesh);
  const linePositions = new Float32Array(SEGMENT_COUNT * 6);
  const lineGeometry = new THREE.BufferGeometry();
  const linePositionAttribute = new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage);
  lineGeometry.setAttribute('position', linePositionAttribute);
  lineGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3.5, 0), 9);
  // Thin lines read as a faint fan from outside, not a curtain.
  const lineMaterial = new THREE.LineBasicNodeMaterial({ color: 0x4a4c55, transparent: true, opacity: 0.55, depthWrite: false });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = 'paraglider-lines';
  root.add(lines);

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.fromArray(EYE);
  pilot.add(eyeAnchor);

  // Per-rib layout on the inflated arc (arc length share, chord, sweep).
  const ribLayout = [];
  for (let rib = 0; rib < RIBS; rib++) {
    const along = (rib / (RIBS - 1)) * 2 - 1;
    const chord = WING.TIP_CHORD + (WING.ROOT_CHORD - WING.TIP_CHORD) * Math.sqrt(Math.max(0, 1 - along * along));
    ribLayout.push({ along, chord, flapShare: 0.3 + 0.7 * Math.abs(along), sweep: WING.SWEEP * along * along });
  }

  // Animated pose (damped toward the targets every frame).
  const pose = { stand: 0, lean: 0, runPhase: 0, inflation: 1, flutter: 0 };
  const wingtips = [new THREE.Vector3(-4.7, 4.8, 0), new THREE.Vector3(4.7, 4.8, 0)];
  const canopyAnchor = new THREE.Vector3(0, 7.2, 0);
  const scratch = { direction: new THREE.Vector3(), bend: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  const offset = new THREE.Vector3();
  const lineUp = new THREE.Vector3();
  const worldUp = new THREE.Vector3();
  const canopyUp = new THREE.Vector3();
  const canopyForward = new THREE.Vector3();
  const canopyRight = new THREE.Vector3();
  const canopyBasis = new THREE.Matrix4();
  const pitchQuaternion = new THREE.Quaternion();
  const inverseRoot = new THREE.Quaternion();
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const point = new THREE.Vector3();
  const riserTop = new THREE.Vector3();
  const handTarget = new THREE.Vector3();
  const footTarget = new THREE.Vector3();
  const legPole = new THREE.Vector3(0, 0, -1);
  const carabiner = new THREE.Vector3();
  let segment = 0;

  function writeLine(from, to) {
    const base = segment * 6;
    linePositions[base] = from.x;
    linePositions[base + 1] = from.y;
    linePositions[base + 2] = from.z;
    linePositions[base + 3] = to.x;
    linePositions[base + 4] = to.y;
    linePositions[base + 5] = to.z;
    segment++;
  }

  /** A rib point (canopy frame) into point, then into the root frame through the canopy group. */
  function ribPointToRoot(rib, profilePoint, target) {
    const at = surface.index(rib, profilePoint);
    return target.set(surface.ribPoints[at], surface.ribPoints[at + 1], surface.ribPoints[at + 2]).applyMatrix4(canopyGroup.matrix);
  }

  /**
   * The rib sections for this frame: on the arc (flattened while deflated), each brake's trailing
   * edge down, the big ears and collapses folded under about their hinge ribs, fabric flutter.
   */
  function layoutRibs(craftState, time, airspeed) {
    const brakeLeft = clamp(Number(craftState.brakeLeft) || 0, 0, 1);
    const brakeRight = clamp(Number(craftState.brakeRight) || 0, 0, 1);
    const ears = clamp(Number(craftState.earsFold) || 0, 0, 1);
    const collapse = craftState.collapse || null;
    const collapseLeft = collapse ? clamp(Number(collapse.left) || 0, 0, 1) : 0;
    const collapseRight = collapse ? clamp(Number(collapse.right) || 0, 0, 1) : 0;
    const inflation = pose.inflation;
    const arcRadius = WING.ARC_RADIUS / Math.max(0.12, smooth01(inflation) * 0.85 + 0.15);
    const thickness = WING.THICKNESS * (0.2 + 0.8 * inflation);
    const spread = 0.62 + 0.38 * inflation;
    const flutterAmplitude = pose.flutter;
    for (let rib = 0; rib < RIBS; rib++) {
      const layout = ribLayout[rib];
      const side = layout.along < 0 ? -1 : 1;
      const arcAngle = layout.along * WING.HALF_ANGLE * spread * (WING.ARC_RADIUS / arcRadius);
      let originX = arcRadius * Math.sin(arcAngle);
      let originY = arcRadius * (Math.cos(arcAngle) - 1);
      let upX = Math.sin(arcAngle);
      let upY = Math.cos(arcAngle);
      // Crumples on the ground: an uneven heap where the wing lies.
      originY -= (1 - inflation) * 0.25 * (0.5 + 0.5 * Math.sin(rib * 1.9 + 0.6));
      // Folds: big ears (both sides) and a collapse (its side, from the tip inward), about a hinge rib.
      const sideCollapse = side < 0 ? collapseLeft : collapseRight;
      const collapseHinge = 1 - 1.7 * sideCollapse;
      const earsActive = ears > 0 && Math.abs(layout.along) > EARS_HINGE;
      const collapseActive = sideCollapse > 0.01 && Math.abs(layout.along) > collapseHinge;
      if (earsActive || collapseActive) {
        const hingeAlong = collapseActive && collapseHinge < EARS_HINGE ? collapseHinge : EARS_HINGE;
        const hingeAngle = side * hingeAlong * WING.HALF_ANGLE * spread * (WING.ARC_RADIUS / arcRadius);
        const hingeX = arcRadius * Math.sin(hingeAngle);
        const hingeY = arcRadius * (Math.cos(hingeAngle) - 1);
        const foldBase = Math.max(earsActive ? ears * EARS_ANGLE : 0, collapseActive ? smooth01(sideCollapse * 3) * COLLAPSE_ANGLE : 0);
        const fold = -side * (foldBase + (collapseActive ? 0.25 * Math.sin(time * 11 + rib) : 0.06 * Math.sin(time * 7 + rib)));
        const cosine = Math.cos(fold);
        const sine = Math.sin(fold);
        const relativeX = originX - hingeX;
        const relativeY = originY - hingeY;
        originX = hingeX + relativeX * cosine - relativeY * sine;
        originY = hingeY + relativeX * sine + relativeY * cosine;
        const turnedX = upX * cosine - upY * sine;
        upY = upX * sine + upY * cosine;
        upX = turnedX;
      }
      const brake = side < 0 ? brakeLeft : brakeRight;
      const flapAngle = brake * layout.flapShare * MAX_FLAP + flutterAmplitude * Math.sin(time * 17 + rib * 1.3);
      const chord = layout.chord;
      const leadingEdgeZ = -WING.CENTER_CHORD * chord + layout.sweep;
      for (let index = 0; index < POINTS; index++) {
        let along = PROFILE[index][0];
        let across = PROFILE[index][1] * (thickness / 0.68);
        // Brake flap: points aft of the hinge turn down about it (toward the pilot).
        if (along > FLAP_HINGE && flapAngle !== 0) {
          const length = (along - FLAP_HINGE) * chord;
          const hingeAcross = across * 0.5;
          const turnedAlong = FLAP_HINGE + (length * Math.cos(flapAngle)) / chord;
          across = hingeAcross + (across - hingeAcross) * Math.cos(flapAngle) - (length * Math.sin(flapAngle)) / chord;
          along = turnedAlong;
        }
        const at = surface.index(rib, index);
        surface.ribPoints[at] = originX + upX * across * chord;
        surface.ribPoints[at + 1] = originY + upY * across * chord;
        surface.ribPoints[at + 2] = leadingEdgeZ + along * chord;
      }
    }
  }

  /** The canopy group's place over the pilot: at the canopy offset, up along the lines (flat on the ground deflated), pitched by its incidence. */
  function placeCanopy(craftState) {
    const source = Array.isArray(craftState.canopyOffset) ? craftState.canopyOffset : null;
    if (source && Number.isFinite(source[0]) && Number.isFinite(source[1]) && Number.isFinite(source[2])) offset.set(source[0], source[1], source[2]);
    else offset.set(0, simProfile.lines.length, 0);
    canopyGroup.position.copy(offset);
    lineUp.copy(offset);
    if (lineUp.lengthSq() < 1e-6) lineUp.set(0, 1, 0);
    lineUp.normalize();
    inverseRoot.copy(root.quaternion).invert();
    worldUp.set(0, 1, 0).applyQuaternion(inverseRoot);
    canopyUp.copy(worldUp).lerp(lineUp, smooth01(pose.inflation)).normalize();
    canopyForward.set(0, 0, -1).addScaledVector(canopyUp, canopyUp.z);
    if (canopyForward.lengthSq() < 1e-6) canopyForward.set(0, 0, -1);
    canopyForward.normalize();
    canopyRight.crossVectors(canopyForward, canopyUp).normalize();
    canopyForward.crossVectors(canopyUp, canopyRight).normalize();
    canopyBasis.makeBasis(canopyRight, canopyUp, scratch.direction.copy(canopyForward).negate());
    canopyGroup.quaternion.setFromRotationMatrix(canopyBasis);
    const pitch = Number.isFinite(craftState.canopyPitch) ? craftState.canopyPitch : simProfile.wing.incidence * DEG;
    canopyGroup.quaternion.multiply(pitchQuaternion.setFromAxisAngle(X_AXIS, pitch * pose.inflation));
    canopyGroup.updateMatrix();
  }

  /** The pilot: lean, arms to the brake handles, legs on the bar or standing (running on a launch). */
  function animatePilot(craftState, visual, step) {
    const phase = craftState.phase;
    const agl = Number.isFinite(telemetry.agl) ? telemetry.agl : Infinity;
    const descending = Number.isFinite(telemetry.verticalSpeed) ? telemetry.verticalSpeed < 0.5 : true;
    const standTarget = phase !== 'flight' || visual.onGround || (agl < 10 && descending) ? 1 : 0;
    pose.stand = step > 0 ? damp(pose.stand, standTarget, 3, step) : standTarget;
    const shift = clamp(Number(craftState.weightShift) || 0, -1, 1);
    pose.lean = step > 0 ? damp(pose.lean, shift, 6, step) : shift;
    pilot.rotation.z = -pose.lean * 14 * DEG * (1 - 0.6 * pose.stand);
    const groundSpeed = Number.isFinite(visual.groundSpeed) ? visual.groundSpeed : 0;
    const running = visual.onGround && groundSpeed > 0.8;
    pose.runPhase = (pose.runPhase + (running ? step * (1.6 + groundSpeed * 0.55) : 0)) % 1;
    const bar = clamp(Number(craftState.speedBar) || 0, 0, 1);
    for (const limb of limbs) {
      const brake = clamp(Number(limb.side < 0 ? craftState.brakeLeft : craftState.brakeRight) || 0, 0, 1);
      // Hands: up by the rear risers with the brakes off, at the hips with them fully down.
      handTarget.set(limb.side * (0.24 + 0.08 * brake), 0.72 - 0.74 * brake, -0.04 + 0.08 * brake);
      limb.hand.copy(handTarget);
      solveJoint(limb.shoulder, limb.hand, ARM.UPPER, ARM.FOREARM, limb.armPole, limb.elbow, scratch);
      aimSegment(limb.upperArm, limb.shoulder, limb.elbow, scratch);
      aimSegment(limb.forearm, limb.elbow, limb.hand, scratch);
      limb.handle.position.copy(limb.hand);
      // Legs: seated on the bar (pushed out with it), or standing and striding when running.
      const swing = running ? Math.sin((pose.runPhase + (limb.side < 0 ? 0 : 0.5)) * Math.PI * 2) : 0;
      footTarget.set(limb.side * 0.12, -0.52 + 0.22 * bar, -0.48 - 0.4 * bar);
      point.set(limb.side * 0.1, -0.95 + 0.12 * Math.max(0, swing), -0.08 - 0.3 * swing);
      footTarget.lerp(point, pose.stand);
      limb.foot.copy(footTarget);
      solveJoint(limb.hip, limb.foot, LEG.THIGH, LEG.SHIN, legPole, limb.knee, scratch);
      aimSegment(limb.thigh, limb.hip, limb.knee, scratch);
      aimSegment(limb.shin, limb.knee, limb.foot, scratch);
    }
    speedBar.position.set(0, (limbs[0].foot.y + limbs[1].foot.y) / 2 + 0.02, (limbs[0].foot.z + limbs[1].foot.z) / 2 - 0.02);
    speedBar.visible = pose.stand < 0.5;
    return bar;
  }

  /** Lines: A and C rows to the risers, brake lines to the hands, the risers, the speed bar lines. */
  function drawLines(bar) {
    segment = 0;
    pilot.updateMatrix();
    for (let rib = 0; rib < RIBS; rib += LINE_RIB_STEP) {
      const side = ribLayout[rib].along < 0 ? 0 : 1;
      riserTop.fromArray(RISER_TOPS[side]).applyMatrix4(pilot.matrix);
      for (const station of LINE_STATIONS) {
        ribPointToRoot(rib, station < 0.4 ? POINTS - 1 : 5, point);
        writeLine(point, riserTop);
      }
    }
    for (const rib of BRAKE_RIBS) {
      const limb = limbs[ribLayout[rib].along < 0 ? 0 : 1];
      ribPointToRoot(rib, 4, point);
      handTarget.copy(limb.hand).applyMatrix4(pilot.matrix);
      writeLine(point, handTarget);
    }
    for (let side = 0; side < 2; side++) {
      carabiner.fromArray(CARABINERS[side]).applyMatrix4(pilot.matrix);
      riserTop.fromArray(RISER_TOPS[side]).applyMatrix4(pilot.matrix);
      writeLine(carabiner, riserTop);
      // Speed bar lines from the bar's ends up the front of the harness to the risers.
      point.set(side === 0 ? -0.2 : 0.2, 0, 0).add(speedBar.position).applyMatrix4(pilot.matrix);
      if (bar <= 0.01 && !speedBar.visible) point.copy(carabiner);
      writeLine(point, carabiner);
    }
    linePositionAttribute.needsUpdate = true;
  }

  return {
    root,
    wingtips,
    eyeAnchor,
    /** Local attachment points: the canopy centre (moves with the wing) and the harness back. */
    anchors: {
      tail: new THREE.Vector3(0, -0.3, 0.32),
      canopy: canopyAnchor,
    },

    update(visual, dt) {
      const step = Math.max(0, Math.min(dt, 0.05));
      const craftState = visual.craftState || telemetry.craftState || {};
      const time = visual.time ? visual.time.elapsed : 0;
      const airspeed = Number.isFinite(telemetry.airspeed) ? telemetry.airspeed : 0;
      const inflation = clamp(Number.isFinite(craftState.inflation) ? craftState.inflation : 1, 0, 1);
      pose.inflation = step > 0 ? damp(pose.inflation, inflation, 10, step) : inflation;
      const collapse = craftState.collapse || null;
      const collapseDepth = collapse ? Math.max(Number(collapse.left) || 0, Number(collapse.right) || 0) : 0;
      const flutterTarget = pose.inflation * (0.012 + 0.03 * clamp(airspeed / 14, 0, 1.5) + 0.08 * collapseDepth + 0.04 * clamp(Number(craftState.earsFold) || 0, 0, 1));
      pose.flutter = step > 0 ? damp(pose.flutter, flutterTarget, 4, step) : flutterTarget;
      const bar = animatePilot(craftState, visual, step);
      placeCanopy(craftState);
      layoutRibs(craftState, time, airspeed);
      surface.refresh();
      drawLines(bar);
      ribPointToRoot(0, 2, wingtips[0]);
      ribPointToRoot(RIBS - 1, 2, wingtips[1]);
      canopyAnchor.copy(canopyGroup.position);
      navLights.animate(visual.time);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// COCKPIT (first person from the helmet): the flight deck on the lap with its instruments, the pod
// fairing over the legs and the harness straps at the edges of the view; the arms, hands, brake
// handles, risers and the wing overhead are the craft mesh itself.
// ============================================================================================
function buildHarnessView(builder) {
  const shade = PALETTE.charcoal;
  const accent = PALETTE.orange;
  const away = (points) => {
    const centre = [0, 0, 0];
    for (const entry of points) {
      centre[0] += entry[0] / points.length;
      centre[1] += entry[1] / points.length;
      centre[2] += entry[2] / points.length;
    }
    return [centre[0] * 2, centre[1] * 2, centre[2] * 2];
  };
  const quad = (a, b, c, d, tint) => builder.quad(a, b, c, d, tint, away([a, b, c, d]));
  // Pod fairing below the deck, reaching forward over the legs.
  quad([-0.2, -0.72, -0.3], [0.2, -0.72, -0.3], [0.16, -0.66, -0.82], [-0.16, -0.66, -0.82], PALETTE.creamShade);
  quad([-0.2, -0.72, -0.3], [-0.16, -0.66, -0.82], [-0.2, -0.8, -0.86], [-0.24, -0.86, -0.3], accent);
  quad([0.2, -0.72, -0.3], [0.24, -0.86, -0.3], [0.2, -0.8, -0.86], [0.16, -0.66, -0.82], accent);
  // Chest strap and the shoulder straps at the bottom corners of the view.
  for (const side of [-1, 1]) {
    quad([side * 0.12, -0.42, -0.06], [side * 0.18, -0.42, -0.04], [side * 0.22, -0.08, 0.02], [side * 0.16, -0.08, 0.0], shade);
  }
  quad([-0.14, -0.36, -0.1], [0.14, -0.36, -0.1], [0.14, -0.33, -0.1], [-0.14, -0.33, -0.1], accent);
  return {};
}

// ============================================================================================
// PLACES: a launch slope near a point (situate, the copilot's "launch", the splashdown relaunch)
// ============================================================================================
const SLOPE = Object.freeze({ RING: 120, MAX_RADIUS: 6000, ANGLES: 16, PROBE: 15, MIN_GRADE: 0.2, MAX_GRADE: 0.85, RUN: Object.freeze([30, 60, 90]), RUN_DROP: 0.12, ABOVE_WATER: 25 });
/** Below this height above the ground a craft switch starts the paraglider on a slope (contract h.4). */
const SLOPE_START_BELOW_AGL = 60;
const AUTO_RELAUNCH_SECONDS = 3;
const LOCAL_LAUNCH_GRADE = 0.08;

/** The ground's grade and downhill heading (deg) at (x, z). */
function slopeAt(heights, x, z, probe = SLOPE.PROBE) {
  const gradientX = (heights.ground(x + probe, z) - heights.ground(x - probe, z)) / (2 * probe);
  const gradientZ = (heights.ground(x, z + probe) - heights.ground(x, z - probe)) / (2 * probe);
  return { grade: Math.hypot(gradientX, gradientZ), heading: headingFromVector(-gradientX, -gradientZ) };
}

/** True when the ground keeps falling away downhill from (x, z) and stays dry. */
function clearRun(heights, x, z, heading, startHeight) {
  const directionX = Math.sin(heading * DEG);
  const directionZ = -Math.cos(heading * DEG);
  for (const distance of SLOPE.RUN) {
    const sampleX = x + directionX * distance;
    const sampleZ = z + directionZ * distance;
    const ground = heights.ground(sampleX, sampleZ);
    if (startHeight - ground < SLOPE.RUN_DROP * distance) return false;
    if (heights.water(sampleX, sampleZ) > ground) return false;
  }
  return true;
}

/**
 * The nearest launch slope to (x, z): ground well above any water, graded between MIN_GRADE and
 * MAX_GRADE, falling away dry downhill for 90 m; within the nearest ring that has one, the slope
 * facing most nearly into the wind. Returns { x, y, z, heading } or null.
 */
function findLaunchSlope(heights, x, z, intoWind = null) {
  for (let radius = 0; radius <= SLOPE.MAX_RADIUS; radius += SLOPE.RING) {
    const samples = radius === 0 ? 1 : SLOPE.ANGLES;
    let best = null;
    for (let sample = 0; sample < samples; sample++) {
      const angle = (sample / samples) * Math.PI * 2;
      const sampleX = x + Math.sin(angle) * radius;
      const sampleZ = z - Math.cos(angle) * radius;
      const ground = heights.ground(sampleX, sampleZ);
      if (ground < heights.water(sampleX, sampleZ) + SLOPE.ABOVE_WATER) continue;
      const slope = slopeAt(heights, sampleX, sampleZ);
      if (slope.grade < SLOPE.MIN_GRADE || slope.grade > SLOPE.MAX_GRADE) continue;
      if (!clearRun(heights, sampleX, sampleZ, slope.heading, ground)) continue;
      const windHeading = typeof intoWind === 'function' ? intoWind(sampleX, sampleZ) : slope.heading;
      const misalignment = Math.abs(wrapDegrees(slope.heading - windHeading + 180) - 180);
      if (!best || misalignment < best.misalignment) best = { x: sampleX, y: ground, z: sampleZ, heading: slope.heading, misalignment };
    }
    if (best) return { x: best.x, y: best.y, z: best.z, heading: best.heading };
  }
  return null;
}

/** A standing start on a slope with the launch run requested (flight.startAt / situate). */
function slopePlacement(slope) {
  return { mode: 'ground', position: { x: slope.x, y: slope.y, z: slope.z }, heading: slope.heading, throttle: 0, craftState: { launchRequested: true } };
}

/** Heights from the ability api (the world and the water query). */
function abilityHeights(api) {
  const world = api.world;
  return {
    ground: (x, z) => world.groundHeight(x, z),
    water: (x, z) => (api.waterQuery ? api.waterQuery.heightAt(x, z) : world.WATER_LEVEL),
  };
}

/** Launches from where the pilot stands when it slopes, else from the nearest launch slope; returns the reply. */
function launchFromSlope(api) {
  const craftState = api.craftState;
  const position = api.player.position;
  const heights = abilityHeights(api);
  const flight = api.systems ? api.systems.flight : null;
  if (craftState.phase === 'landed' && !craftState.onWater && slopeAt(heights, position.x, position.z, 6).grade >= LOCAL_LAUNCH_GRADE) {
    craftState.launchRequested = true;
    return 'Inflating. Run!';
  }
  const wind = api.wind;
  const intoWind = wind && typeof wind.ambientAt === 'function' ? (x, z) => wind.ambientAt({ x, y: heights.ground(x, z) + 10, z }).fromDegrees : null;
  const slope = findLaunchSlope(heights, position.x, position.z, intoWind);
  if (!slope || !flight || typeof flight.startAt !== 'function') {
    api.relaunch();
    return 'No launch slope near here, so we start from the nearest peak.';
  }
  flight.startAt(slopePlacement(slope));
  const distance = Math.hypot(slope.x - position.x, slope.z - position.z);
  return distance < 200 ? 'Launching from the slope right here.' : `Launching from a slope ${Math.round(distance / 100) / 10} km away.`;
}

// ============================================================================================
// ABILITY: big ears (held; B toggles a latched pair). It also brings a pilot who landed in the water
// back to a launch slope after a short pause.
// ============================================================================================
const craftAbility = Object.freeze({
  label: 'Big ears (hold)',
  initialState: () => ({
    phase: 'flight',
    brakeLeft: 0,
    brakeRight: 0,
    speedBar: 0,
    weightShift: 0,
    bigEars: false,
    bigEarsLatched: false,
    earsFold: 0,
    collapse: { left: 0, right: 0 },
    collapses: 0,
    pendulum: 0,
    inflation: 1,
    canopyOffset: [0, simProfile.lines.length, 0],
    canopyPitch: simProfile.wing.incidence * DEG,
    stalled: false,
    climb: { active: false, gain: 0, average: 0 },
    landedSeconds: 0,
    onWater: false,
    launchRequested: false,
    splashRelaunch: false,
  }),
  run(api) {
    const craftState = api.craftState;
    if (craftState.bigEarsLatched) {
      craftState.bigEarsLatched = false;
      api.notify('Big ears out.');
    }
    return true;
  },
  update(api) {
    const craftState = api.craftState;
    craftState.bigEars = api.isHeld('craftAbility') || craftState.bigEarsLatched === true;
    if (craftState.phase === 'landed' && craftState.onWater && craftState.landedSeconds >= AUTO_RELAUNCH_SECONDS && !craftState.splashRelaunch) {
      craftState.splashRelaunch = true;
      api.notify(launchFromSlope(api));
    } else if (craftState.phase !== 'landed') {
      craftState.splashRelaunch = false;
    }
  },
});

// ============================================================================================
// COPILOT: big ears, the speed bar, a launch, the nearest thermal, and a status line.
// ============================================================================================
const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'bigEars',
      phrases: Object.freeze(['\\bbig ears (on|off|in|out)\\b', '\\b(?:pull|put) (?:in )?(?:the )?big ears\\b']),
      run(api, value) {
        const release = value === 'off' || value === 'out';
        api.setCraftState('bigEarsLatched', !release);
        return release ? 'Big ears out. Hands up, let it fly.' : 'Big ears in. Steer with your weight; a touch of speed bar keeps it flying.';
      },
    }),
    Object.freeze({
      id: 'speedBar',
      phrases: Object.freeze(['\\bspeed ?bar (?:to )?(\\d{1,3})\\b', '\\bspeed ?bar (off|full|half)\\b']),
      run(api, value) {
        const named = { off: 0, half: 50, full: 100 };
        const percent = typeof value === 'number' ? value : named[value] ?? 0;
        const share = clamp(percent / 100, 0, 1);
        const input = api.systems ? api.systems.input : null;
        if (!input || typeof input.presetThrottle !== 'function' || !input.presetThrottle(share)) return 'Your throttle lever has the speed bar; move it yourself.';
        return share <= 0 ? 'Speed bar off: back to trim.' : `Speed bar at ${Math.round(share * 100)} percent.`;
      },
    }),
    Object.freeze({
      id: 'launch',
      phrases: Object.freeze(['\\b(?:launch|take off|relaunch here|launch from (?:a|the) slope)\\b']),
      run(api) {
        if (api.craftState.phase === 'flight') return 'We are already flying.';
        return launchFromSlope(api);
      },
    }),
    Object.freeze({
      id: 'findThermal',
      phrases: Object.freeze(["\\b(?:find|nearest|where(?:'s| is)) (?:a |the |me a )?thermal\\b"]),
      run(api) {
        const wind = api.wind;
        const position = api.player.position;
        const thermal = wind && typeof wind.nearestThermal === 'function' ? wind.nearestThermal(position, 1) : null;
        if (!thermal) return 'No working thermal near us. Try a sunny slope or wait for the sun to warm the ground.';
        const bearing = Math.round(headingFromVector(thermal.x - position.x, thermal.z - position.z));
        const distance = Math.hypot(thermal.x - position.x, thermal.z - position.z);
        return `Thermal ${distance < 1000 ? `${Math.round(distance / 10) * 10} metres` : `${(distance / 1000).toFixed(1)} km`} at ${String(bearing).padStart(3, '0')}, about ${thermal.strength.toFixed(1)} metres per second at the core. Circle tight in it.`;
      },
    }),
  ]),
  status(craftState, telemetry) {
    if (craftState.phase === 'landed') return craftState.onWater ? 'In the water; heading back to a slope.' : 'On the ground. Push forward or say launch to fly again.';
    if (craftState.phase === 'launch') return 'Launching: keep running.';
    const parts = [];
    const speed = Number.isFinite(telemetry.airspeed) ? Math.round(telemetry.airspeed * 3.6) : 0;
    const climb = Number.isFinite(telemetry.vario) ? telemetry.vario : 0;
    parts.push(`${speed} km/h, ${climb >= 0 ? 'climbing' : 'sinking'} ${Math.abs(climb).toFixed(1)} metres per second`);
    const collapse = craftState.collapse || { left: 0, right: 0 };
    if (collapse.left > 0.05 || collapse.right > 0.05) parts.push(`${collapse.left >= collapse.right ? 'left' : 'right'} side collapsed`);
    if (craftState.bigEars) parts.push('big ears in');
    if (craftState.speedBar > 0.05) parts.push(`speed bar ${Math.round(craftState.speedBar * 100)} percent`);
    const brakes = Math.max(craftState.brakeLeft || 0, craftState.brakeRight || 0);
    if (brakes > 0.1) parts.push(`brakes ${Math.round((craftState.brakeLeft || 0) * 100)} and ${Math.round((craftState.brakeRight || 0) * 100)}`);
    if (craftState.climb && craftState.climb.active) parts.push(`${Math.round(craftState.climb.gain)} metres gained in this thermal`);
    return `${parts.join(', ')}.`;
  },
});

/**
 * Placement after a craft switch (contract h.4): flying at trim, or, below 60 m above the ground (or
 * landed), standing on the nearest launch slope ready to run (the nearest peak's slopes when there is
 * none nearby; flying high above the ground when nothing fits).
 */
function situate(situation, api) {
  const lowOrLanded = situation.wasOnGround || situation.agl < SLOPE_START_BELOW_AGL;
  if (!lowOrLanded) return { mode: 'air', speed: simProfile.targets.trimSpeed, throttle: 0 };
  const heights = { ground: api.groundHeight, water: (x, z) => api.waterHeight(x, z) };
  const position = situation.position;
  let slope = findLaunchSlope(heights, position.x, position.z, api.headingIntoWind);
  if (!slope) {
    const peak = api.nearestPeak(position.x, position.z);
    if (peak) slope = findLaunchSlope(heights, peak.x, peak.z, api.headingIntoWind);
  }
  if (slope) return slopePlacement(slope);
  return { mode: 'air', position: { x: position.x, y: situation.surfaceHeight + 300, z: position.z }, speed: simProfile.targets.trimSpeed, throttle: 0 };
}

const button = (index) => Object.freeze({ type: 'button', index });

export default Object.freeze({
  id: 'paraglider',
  name: 'Paraglider',
  buildMesh,
  simProfile,
  /**
   * ControlState mapping: the throttle axis is the speed bar, the toe brakes are the brakes (and the
   * rudder pedals or yaw keys a differential pair; the stick pulled back both, pushed forward the bar),
   * stick X shifts the pilot's weight, the HOTAS antenna zooms the lens.
   */
  inputProfile: Object.freeze({ throttle: 'speedBar', toeBrakes: 'paragliderBrakes', stickX: 'weightShift', antenna: 'zoom', flapNotches: 0 }),
  /**
   * Per-craft default bindings: on a standard gamepad the analog triggers are the two brakes and the
   * bumpers move the speed bar; on the TWCS the engine button pulls the big ears.
   */
  bindings: Object.freeze({
    standard: Object.freeze({
      axes: Object.freeze({
        brakeL: Object.freeze([Object.freeze({ type: 'buttonAxis', positive: 6 })]),
        brakeR: Object.freeze([Object.freeze({ type: 'buttonAxis', positive: 7 })]),
        throttle: Object.freeze([Object.freeze({ type: 'buttonRate', positive: 5, negative: 4, rate: 0.6 })]),
        yaw: Object.freeze([]),
      }),
    }),
    twcs: Object.freeze({
      actions: Object.freeze({ craftAbility: Object.freeze([button(4)]), engineToggle: Object.freeze([]) }),
    }),
  }),
  audioProfile: Object.freeze({ engine: 'paraglider', airflowSpeed: 16, interiorCutoff: 0, touchdown: 'body', callouts: false, vario: true, varioLift: 0.1, varioSink: -2.5, flutterHz: 3.2 }),
  capabilities: Object.freeze({ engine: false, chute: false, smoke: false, water: true, perch: false, space: false }),
  cameraRig: Object.freeze({
    // First person from the helmet (hidden in that view): the arms on the brakes, the deck on the lap,
    // the lines rising to the wing overhead.
    eye: EYE,
    chase: chaseRig,
    // On the right wingtip, looking down the lines at the pilot.
    wing: Object.freeze({ position: Object.freeze([4.3, 5.4, 0.9]), target: Object.freeze([0, 1.4, -0.3]) }),
    fpv: null,
    cockpit: Object.freeze({
      style: 'custom',
      near: 0.05,
      build: buildHarnessView,
      panel: Object.freeze({
        width: 0.26,
        center: Object.freeze([0, -0.4, -0.44]),
        layout: Object.freeze([Object.freeze(['vario', 'speedBar']), Object.freeze(['airspeed', 'altitude'])]),
      }),
    }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'heading', 'vario', 'speedBar', 'ld']),
  abilities: Object.freeze({ craftAbility }),
  // Starts flying at trim; the relaunch takes the pilot to the nearest high peak (launching from any
  // slope is the model's own launch run: push forward on the ground, or the copilot's "launch").
  spawn: Object.freeze({ cruise: simProfile.targets.trimSpeed, hover: false, relaunch: 'peak', canStartOnGround: false }),
  // The legs take a firm landing; the sink is measured along the ground normal, so a touchdown into a
  // rising slope adds some forward speed to it. A water landing floats (the harness and the wing).
  limits: Object.freeze({ vne: 22, gLimit: 5, crashSinkRate: 6.5, bodyStrikeSpeed: 7, floats: true, waterLanding: 'floats', ceiling: 7000 }),
  // Probes for structure collision: the pilot, the canopy along its arc and the line curtain between.
  collision: Object.freeze({
    probes: Object.freeze([
      Object.freeze({ id: 'pilot', position: Object.freeze([0, 0, 0]), radius: 0.45 }),
      Object.freeze({ id: 'head', position: Object.freeze([0, 0.66, 0.06]), radius: 0.2 }),
      Object.freeze({ id: 'feet', position: Object.freeze([0, -0.8, -0.15]), radius: 0.2, gear: true }),
      Object.freeze({ id: 'lines1', position: Object.freeze([0, 2.4, 0]), radius: 0.45 }),
      Object.freeze({ id: 'lines2', position: Object.freeze([0, 4.2, 0]), radius: 0.5 }),
      Object.freeze({ id: 'linesLeft', position: Object.freeze([-2.2, 3.6, 0]), radius: 0.45 }),
      Object.freeze({ id: 'linesRight', position: Object.freeze([2.2, 3.6, 0]), radius: 0.45 }),
      Object.freeze({ id: 'canopy', position: Object.freeze([0, 7.2, 0]), radius: 0.8 }),
      Object.freeze({ id: 'canopyLeft', position: Object.freeze([-2.7, 6.5, 0.1]), radius: 0.65 }),
      Object.freeze({ id: 'canopyRight', position: Object.freeze([2.7, 6.5, 0.1]), radius: 0.65 }),
      Object.freeze({ id: 'tipLeft', position: Object.freeze([-4.6, 4.9, 0.4]), radius: 0.45 }),
      Object.freeze({ id: 'tipRight', position: Object.freeze([4.6, 4.9, 0.4]), radius: 0.45 }),
    ]),
  }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'paragliderBestClimb', label: 'Paraglider best thermal climb (20 s average)', unit: 'm/s', op: 'max' }),
      Object.freeze({ key: 'paragliderBestGain', label: 'Paraglider biggest height gain in one thermal', unit: 'metres', op: 'max' }),
      Object.freeze({ key: 'paragliderSlopeLaunches', label: 'Paraglider slope launches', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'paragliderCollapses', label: 'Paraglider collapses flown out', unit: 'count', op: 'add' }),
    ]),
  }),
  // Gentle scenery suits a paraglider: landforms and wildlife over the loud spectacles.
  directorProfile: Object.freeze({ favor: Object.freeze({ categories: Object.freeze({ geo: 1.4, wildlife: 1.3, flightplay: 1.2 }) }) }),
  // Birds share thermals with paragliders: they hardly scatter.
  faunaThreat: 0.7,
});

export { findLaunchSlope, slopePlacement };
