// EAGLE / DRAGON meshes (src/craft/eagle.js): two skins of the one flapping craft, built from code in
// the v1 style (flat-shaded, vertex-coloured lofts in the v1 palette) on the same frame, so they share
// the physics, the probes and the contacts. Local frame: beak / snout -z, back +y, origin at the
// centre of mass; the feet stand FEET metres below it.
//
//   eagle   a bald eagle: charcoal body and wings, cream head and tail, orange beak and feet. The arm
//           and hand wings are pivot groups (the wingbeat at the shoulder, the hand lagging at the
//           wrist, five splayed primaries at the tip); the tail tilts with pitch, twists with yaw and
//           fans for the landing; the legs trail under the tail in flight and swing down for a perch;
//           on a perch the wings fold and the head looks around; a screech lifts the head.
//   dragon  a small wyvern: orange scales with a cream belly, charcoal horns, spines, claws and wing
//           bones, membranes re-skinned every frame between the arm, the three finger bones and the
//           flank (orange inside, charcoal at the trailing scallops), a five-segment tail ending in a
//           spade that sways with the wingbeat, a jaw that opens to breathe fire, glowing eyes.
//           The fire breath (craftState.fireIntensity, the ability) is a flame jet of two additive
//           cones with a flowing flicker, and a real light borrowed from the spawn light pool
//           (ctx.systems.spawns.manager.lights) while it burns; dispose returns it.
//
// Both animate from visual.craftState (read only): flapPhase / flapAmplitude (the wingbeat),
// wingTuck (the fold), landing (0..1 through the auto-landing), perched, perchedSeconds,
// screechCount / roarCount, fireIntensity; and from the surfaces (wing twist, body pitch, tail yaw).
// update() allocates nothing.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp, damp } from '../core/util.js';
import { PALETTE, createMeshBuilder, getCraftMaterials, addSolid, disposeCraftMesh, smooth01 } from './kit.js';

const { uniform, color, float, uv, sin, mix, smoothstep, saturate } = TSL;

/** The feet stand this far below the centre of mass (the model's perch.feet). */
export const FEET = 0.25;
/** First-person eye per skin (body axes from the centre of mass): the eagle's head, the dragon's brow. */
export const EYES = Object.freeze({
  eagle: Object.freeze([0, 0.085, -0.36]),
  dragon: Object.freeze([0, 0.13, -0.43]),
});
/** The dragon's mouth (the flame's origin) and the flame's droop below the body axis (rad). */
export const DRAGON_MOUTH = Object.freeze([0, 0.055, -0.64]);
export const FIRE_DROOP = 6 * DEG;
/** The flame's drawn length (m) at full intensity, and its half-angle. */
export const FIRE_LENGTH = 11;
export const FIRE_ANGLE = 13 * DEG;

const UNDER = new THREE.Color().copy(PALETTE.charcoal).lerp(PALETTE.cream, 0.22);
const MEMBRANE_DARK = new THREE.Color().copy(PALETTE.orange).lerp(PALETTE.charcoal, 0.55);
const TUBE_SIDES = 6;

// ============================================================================================
// SHARED BUILDING BLOCKS
// ============================================================================================
/** Elliptical rings along z: stations [z, centreY, halfWidth, halfHeight] (offset by origin). */
function ringSections(stations, sides, origin = [0, 0, 0]) {
  return stations.map(([z, centreY, halfWidth, halfHeight]) => {
    const ring = [];
    for (let index = 0; index < sides; index++) {
      const angle = (index / sides) * Math.PI * 2;
      ring.push([origin[0] + halfWidth * Math.cos(angle), origin[1] + centreY + halfHeight * Math.sin(angle), origin[2] + z]);
    }
    return ring;
  });
}

/** A closed tube along a polyline of points with radii (TUBE_SIDES sides). */
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
      ring.push([point[0] + basisU.x * cosine + basisW.x * sine, point[1] + basisU.y * cosine + basisW.y * sine, point[2] + basisU.z * cosine + basisW.z * sine]);
    }
    return ring;
  });
  builder.loft(sections, tintAt, { capStart: tintAt(0, 0), capEnd: tintAt(points.length - 2, 0) });
}

/** A cone from base (radius) to a point tip, as a tube that ends almost at zero. */
function spike(builder, base, tip, radius, tint) {
  tube(builder, [base, tip], [radius, radius * 0.08], () => tint);
}

/**
 * A thin wing (or tail) panel along x: stations [x, leadZ, trailZ, thickness, y]; side -1 mirrors it
 * to the left. Faces: 0 top, 1 trailing edge, 2 bottom, 3 leading edge.
 */
function wingPanel(builder, stations, side, topTint, underTint) {
  const sections = stations.map(([x, lead, trail, thickness, y = 0]) => [
    [side * x, y + thickness * 0.5, lead],
    [side * x, y + thickness * 0.2, trail],
    [side * x, y - thickness * 0.2, trail],
    [side * x, y - thickness * 0.5, lead],
  ]);
  builder.loft(sections, (segment, face) => (face === 2 ? underTint : topTint), { capStart: topTint, capEnd: topTint });
}

/** A tail fan along z: stations [z, halfWidth, thickness]. */
function tailFan(builder, stations, tint) {
  const sections = stations.map(([z, halfWidth, thickness]) => [
    [-halfWidth, thickness * 0.5, z],
    [halfWidth, thickness * 0.5, z],
    [halfWidth, -thickness * 0.5, z],
    [-halfWidth, -thickness * 0.5, z],
  ]);
  builder.loft(sections, () => tint, { capStart: tint, capEnd: tint });
}

function solid(parent, build, material, options = {}) {
  const builder = createMeshBuilder();
  build(builder);
  const mesh = addSolid(parent, builder.toGeometry(null), material);
  if (options.hideInCockpit) mesh.userData.hideInCockpit = true;
  return mesh;
}

function pivotGroup(parent, position, name) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(position[0], position[1], position[2]);
  parent.add(group);
  return group;
}

/**
 * A creature leg in its hip frame (down -y): a thigh, a shank and the foot 0.2 m below the hip
 * (front toes forward, a hind toe back), talons at the tips.
 */
function buildLeg(builder, thighTint, shankTint, clawTint, thighRadius) {
  tube(builder, [[0, 0, 0], [0, -0.05, 0.012], [0, -0.085, 0.01]], [thighRadius, thighRadius * 0.95, thighRadius * 0.7], () => thighTint);
  tube(builder, [[0, -0.085, 0.01], [0, -0.17, 0], [0, -0.19, -0.005]], [0.013, 0.011, 0.012], () => shankTint);
  for (const angle of [-26, 0, 26]) {
    const radians = angle * DEG;
    const tip = [Math.sin(radians) * 0.06, -0.198, -0.005 - Math.cos(radians) * 0.06];
    tube(builder, [[0, -0.19, -0.005], [tip[0] * 0.75, -0.196, -0.005 + (tip[2] + 0.005) * 0.75]], [0.008, 0.007], () => shankTint);
    spike(builder, [tip[0] * 0.75, -0.196, -0.005 + (tip[2] + 0.005) * 0.75], tip, 0.006, clawTint);
  }
  tube(builder, [[0, -0.19, -0.005], [0, -0.196, 0.03]], [0.008, 0.007], () => shankTint);
  spike(builder, [0, -0.196, 0.03], [0, -0.2, 0.045], 0.006, clawTint);
}

/** Smoothed pose shared by both skins (damped toward the craft state every frame). */
function createPose() {
  return { fold: 0, flare: 0, legs: 0, perch: 0, spread: 0, jaw: 0, screech: 0, lastScreech: -1, look: 0 };
}

/** The common animation targets from the visual and the craft state. */
function animatePose(pose, visual, craftState, step) {
  const tuck = clamp(Number(craftState.wingTuck) || 0, 0, 1);
  const landing = clamp(Number(craftState.landing) || 0, 0, 1);
  const perched = craftState.perched === true;
  const onGround = visual.onGround === true;
  const perchTarget = perched ? 1 : smooth01((landing - 0.82) / 0.18);
  const foldTarget = Math.max(tuck, perchTarget);
  const flareTarget = perched ? 0 : Math.sin(Math.PI * Math.min(landing * 1.1, 1));
  const legsTarget = perched || onGround ? 1 : smooth01((landing - 0.25) / 0.4);
  pose.fold = step > 0 ? damp(pose.fold, foldTarget, perched ? 3 : 6, step) : foldTarget;
  pose.flare = step > 0 ? damp(pose.flare, flareTarget, 8, step) : flareTarget;
  pose.legs = step > 0 ? damp(pose.legs, legsTarget, 6, step) : legsTarget;
  pose.perch = step > 0 ? damp(pose.perch, perchTarget, 4, step) : perchTarget;
  pose.spread = step > 0 ? damp(pose.spread, Math.max(pose.flare, perched ? 0 : Math.max(0, Number(visual.elevator) || 0) * 0.6), 6, step) : pose.flare;
  // A new screech or roar: the head lifts (and the jaw opens) for a moment.
  const screeches = (Number(craftState.screechCount) || 0) + (Number(craftState.roarCount) || 0);
  if (pose.lastScreech < 0) pose.lastScreech = screeches;
  if (screeches !== pose.lastScreech) {
    pose.lastScreech = screeches;
    pose.screech = 1;
  }
  pose.screech = Math.max(0, pose.screech - step / 1.1);
  // Perched: the head looks around slowly.
  const seconds = Number(craftState.perchedSeconds) || 0;
  const lookTarget = perched && seconds > 1.2 ? Math.sin(seconds * 0.55) * 0.75 + Math.sin(seconds * 1.37) * 0.2 : 0;
  pose.look = step > 0 ? damp(pose.look, lookTarget, 2.5, step) : lookTarget;
}

/** Wingbeat angle (rad) at the shoulder: the stroke from the craft state, plus the flare. */
function strokeAngle(craftState, pose) {
  const amplitude = clamp(Number(craftState.flapAmplitude) || 0, 0, 1);
  const phase = Number(craftState.flapPhase) || 0;
  return amplitude * 38 * DEG * Math.sin(phase * Math.PI * 2) * (1 - pose.fold) + pose.flare * 22 * DEG;
}

// ============================================================================================
// EAGLE
// ============================================================================================
const EAGLE = Object.freeze({
  shoulder: Object.freeze([0.07, 0.045, -0.07]),
  arm: 0.47,
  hand: 0.36,
  neck: Object.freeze([0, 0.06, -0.22]),
  tail: Object.freeze([0, 0.03, 0.22]),
  hip: Object.freeze([0.05, -0.05, 0.02]),
});

function buildEagleBody() {
  const builder = createMeshBuilder();
  const stations = [[-0.25, 0.055, 0.045, 0.05], [-0.16, 0.04, 0.075, 0.075], [-0.06, 0.02, 0.1, 0.09], [0.05, 0.01, 0.1, 0.085], [0.15, 0.015, 0.075, 0.06], [0.24, 0.03, 0.04, 0.03]];
  builder.loft(ringSections(stations, 9), (segment) => (segment === 0 ? PALETTE.cream : PALETTE.charcoal), { capStart: PALETTE.cream, capEnd: PALETTE.charcoal });
  return builder.toGeometry(null);
}

/** The eagle's head in its neck frame: cream, a hooked orange beak, dark eyes. */
function buildEagleHead(builder) {
  const head = [[0.03, -0.005, 0.046, 0.05], [-0.04, 0.008, 0.052, 0.056], [-0.1, 0.012, 0.047, 0.05], [-0.15, 0.002, 0.034, 0.036], [-0.18, -0.004, 0.022, 0.024]];
  builder.loft(ringSections(head, 8), () => PALETTE.cream, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  const beak = [[-0.17, -0.006, 0.022, 0.022], [-0.21, -0.01, 0.016, 0.018], [-0.24, -0.016, 0.01, 0.012], [-0.255, -0.026, 0.005, 0.007]];
  builder.loft(ringSections(beak, 6), () => PALETTE.orange, { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  spike(builder, [0, -0.026, -0.255], [0, -0.05, -0.252], 0.006, PALETTE.orange);
  for (const side of [-1, 1]) spike(builder, [side * 0.043, 0.02, -0.12], [side * 0.05, 0.022, -0.128], 0.01, PALETTE.charcoal);
}

/** One eagle wing (side 1 right, -1 left): the arm in the shoulder frame, the hand in the wrist frame. */
function buildEagleArm(side) {
  const builder = createMeshBuilder();
  wingPanel(builder, [[0, -0.075, 0.24, 0.04, 0], [0.24, -0.085, 0.23, 0.032, 0.012], [EAGLE.arm, -0.075, 0.19, 0.026, 0.006]], side, PALETTE.charcoal, UNDER);
  return builder.toGeometry(null);
}

function buildEagleHand(side) {
  const builder = createMeshBuilder();
  wingPanel(builder, [[0, -0.075, 0.19, 0.026, 0], [0.2, -0.065, 0.14, 0.02, -0.004], [EAGLE.hand, -0.055, 0.07, 0.014, -0.01]], side, PALETTE.charcoal, UNDER);
  // Five splayed primaries at the tip, fanned from forward to back.
  for (let finger = 0; finger < 5; finger++) {
    const share = finger / 4;
    const angle = (-8 + share * 42) * DEG;
    const baseZ = -0.045 + share * 0.105;
    const length = 0.2 * (1 - 0.25 * Math.abs(share - 0.35));
    const tipX = EAGLE.hand + Math.cos(angle) * length;
    const tipZ = baseZ + Math.sin(angle) * length;
    wingPanel(builder, [[EAGLE.hand - 0.02, baseZ - 0.017, baseZ + 0.017, 0.01, -0.01], [tipX - 0.03, tipZ - 0.012, tipZ + 0.012, 0.006, -0.012 - 0.01 * share], [tipX, tipZ - 0.002, tipZ + 0.002, 0.003, -0.014 - 0.012 * share]], side, PALETTE.charcoal, UNDER);
  }
  return builder.toGeometry(null);
}

export function buildEagleMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const body = materials.body;
  const root = new THREE.Group();
  root.name = 'eagle';
  addSolid(root, buildEagleBody(), body);

  const neck = pivotGroup(root, EAGLE.neck, 'eagle-head');
  solid(neck, buildEagleHead, body, { hideInCockpit: true });

  const tail = pivotGroup(root, EAGLE.tail, 'eagle-tail');
  solid(tail, (builder) => tailFan(builder, [[0, 0.045, 0.022], [0.14, 0.1, 0.016], [0.3, 0.13, 0.01]], PALETTE.cream), body);

  const wings = [-1, 1].map((side) => {
    const shoulder = pivotGroup(root, [side * EAGLE.shoulder[0], EAGLE.shoulder[1], EAGLE.shoulder[2]], `eagle-shoulder-${side}`);
    addSolid(shoulder, buildEagleArm(side), body);
    const wrist = pivotGroup(shoulder, [side * EAGLE.arm, 0.006, 0], `eagle-wrist-${side}`);
    addSolid(wrist, buildEagleHand(side), body);
    return { side, shoulder, wrist, tip: new THREE.Vector3(side * (EAGLE.hand + 0.19), -0.02, 0.03) };
  });

  const legs = [-1, 1].map((side) => {
    const hip = pivotGroup(root, [side * EAGLE.hip[0], EAGLE.hip[1], EAGLE.hip[2]], `eagle-leg-${side}`);
    solid(hip, (builder) => buildLeg(builder, PALETTE.charcoal, PALETTE.orange, PALETTE.charcoal, 0.034), body);
    return hip;
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.fromArray(EYES.eagle);
  root.add(eyeAnchor);

  const pose = createPose();
  const wingtips = [new THREE.Vector3(), new THREE.Vector3()];
  const scratch = new THREE.Vector3();

  return {
    root,
    wingtips,
    eyeAnchor,
    anchors: {
      tail: new THREE.Vector3(0, 0.03, 0.5),
      beak: new THREE.Vector3(0, 0.035, -0.49),
    },

    update(visual, dt) {
      const step = Math.max(0, Math.min(dt, 0.05));
      const craftState = visual.craftState || {};
      animatePose(pose, visual, craftState, step);
      const stroke = strokeAngle(craftState, pose);
      const amplitude = clamp(Number(craftState.flapAmplitude) || 0, 0, 1);
      const phase = Number(craftState.flapPhase) || 0;
      const roll = clamp(Number(visual.aileron) || 0, -1, 1);
      const pitch = clamp(Number(visual.elevator) || 0, -1, 1);
      const yaw = clamp(Number(visual.rudder) || 0, -1, 1);
      const fold = pose.fold;
      for (const wing of wings) {
        const side = wing.side;
        // Dihedral, the stroke and a little twist from the roll input; folded: swept back and lowered.
        const dihedral = (5 * DEG - side * roll * 5 * DEG + stroke) * (1 - fold) - 12 * DEG * fold;
        wing.shoulder.rotation.set(0, side * -(8 * DEG + 27 * DEG * fold), side * dihedral);
        const lag = amplitude * 16 * DEG * Math.sin(phase * Math.PI * 2 - 0.7) * (1 - fold);
        wing.wrist.rotation.set(0, side * -(85 * DEG * fold + 6 * DEG * (1 - fold)), side * (lag - 4 * DEG * fold));
        wing.shoulder.updateMatrix();
        wing.wrist.updateMatrix();
        scratch.copy(wing.tip).applyMatrix4(wing.wrist.matrix).applyMatrix4(wing.shoulder.matrix);
        wingtips[side < 0 ? 0 : 1].copy(scratch);
      }
      // Tail: tilts with pitch, twists with yaw, fans for the landing.
      tail.rotation.set(-pitch * 14 * DEG + pose.perch * 8 * DEG, yaw * 8 * DEG, -yaw * 14 * DEG);
      tail.scale.set(1 + 0.6 * pose.spread, 1, 1 - 0.15 * pose.spread);
      // Legs: trailing under the tail in flight, down and forward for a perch.
      for (const leg of legs) leg.rotation.set(-1.3 * (1 - pose.legs) + 0.15 * pose.flare, 0, 0);
      // Head: looks around on a perch, lifts to screech.
      neck.rotation.set(-0.45 * pose.screech + 0.08 * pose.perch, pose.look, 0);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// DRAGON
// ============================================================================================
const DRAGON = Object.freeze({
  shoulder: Object.freeze([0.075, 0.07, -0.09]),
  arm: 0.42,
  fingers: Object.freeze([Object.freeze([10, 0.62]), Object.freeze([42, 0.52]), Object.freeze([76, 0.42])]),
  neck: Object.freeze([0, 0.085, -0.38]),
  tailBase: Object.freeze([0, 0.035, 0.27]),
  tailSegments: 5,
  tailSegment: 0.15,
  hip: Object.freeze([0.06, -0.04, 0.05]),
  flank: Object.freeze([0.06, 0.03, 0.22]),
});

function buildDragonBody() {
  const builder = createMeshBuilder();
  const stations = [[-0.39, 0.085, 0.034, 0.04], [-0.28, 0.065, 0.045, 0.05], [-0.15, 0.045, 0.085, 0.08], [-0.02, 0.025, 0.11, 0.095], [0.1, 0.022, 0.1, 0.085], [0.2, 0.03, 0.062, 0.056], [0.28, 0.035, 0.038, 0.034]];
  // Eight faces round: the two under the belly are cream, the rest orange.
  builder.loft(ringSections(stations, 8), (segment, face) => (face === 5 || face === 6 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  // Dorsal spines from the neck to the tail base.
  for (let index = 0; index < 7; index++) {
    const z = -0.32 + index * 0.09;
    const back = [0.13, 0.115, 0.125, 0.125, 0.11, 0.09, 0.07][index];
    spike(builder, [0, back - 0.01, z + 0.02], [0, back + 0.05, z - 0.01], 0.012, PALETTE.charcoal);
  }
  return builder.toGeometry(null);
}

/** The dragon's head in its neck frame: skull and snout, horns, nostrils (the jaw is its own part). */
function buildDragonHead(builder) {
  const head = [[0.03, -0.005, 0.038, 0.042], [-0.05, 0.006, 0.055, 0.05], [-0.12, -0.002, 0.046, 0.036], [-0.2, -0.012, 0.031, 0.024], [-0.255, -0.016, 0.019, 0.016]];
  builder.loft(ringSections(head, 8), (segment, face) => (face === 5 || face === 6 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  for (const side of [-1, 1]) {
    spike(builder, [side * 0.03, 0.04, -0.03], [side * 0.065, 0.105, 0.075], 0.014, PALETTE.charcoal);
    spike(builder, [side * 0.045, 0.02, -0.01], [side * 0.075, 0.035, 0.06], 0.009, PALETTE.charcoal);
    spike(builder, [side * 0.012, -0.002, -0.245], [side * 0.016, 0.004, -0.255], 0.005, PALETTE.charcoal);
  }
}

function buildDragonJaw(builder) {
  const jaw = [[0, -0.008, 0.03, 0.014], [-0.09, -0.01, 0.028, 0.012], [-0.17, -0.008, 0.018, 0.009], [-0.2, -0.004, 0.01, 0.006]];
  builder.loft(ringSections(jaw, 6), (segment, face) => (face >= 3 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.orange, capEnd: PALETTE.cream });
  for (const z of [-0.06, -0.11, -0.16]) {
    for (const side of [-1, 1]) spike(builder, [side * 0.018, 0.0, z], [side * 0.016, 0.014, z - 0.004], 0.004, PALETTE.cream);
  }
}

/** The arm bone in the shoulder frame, a thumb claw at the wrist. */
function buildDragonArm(side) {
  const builder = createMeshBuilder();
  tube(builder, [[0, 0, 0], [side * 0.2, 0.012, -0.02], [side * DRAGON.arm, 0, -0.03]], [0.026, 0.02, 0.016], () => PALETTE.charcoal);
  spike(builder, [side * DRAGON.arm, 0.01, -0.03], [side * (DRAGON.arm + 0.02), 0.03, -0.075], 0.008, PALETTE.cream);
  return builder.toGeometry(null);
}

/** The three finger bones in the wrist frame (each swept back by its angle). */
function buildDragonFingers(side) {
  const builder = createMeshBuilder();
  for (const [angle, length] of DRAGON.fingers) {
    const radians = angle * DEG;
    const tip = [side * Math.cos(radians) * length, -0.01, Math.sin(radians) * length];
    tube(builder, [[0, 0, 0], [tip[0] * 0.55, 0.004, tip[2] * 0.55], tip], [0.013, 0.009, 0.004], () => PALETTE.charcoal);
  }
  return builder.toGeometry(null);
}

/**
 * The wing membrane: a panel re-skinned every frame from moving points (root frame), flat-shaded with
 * per-triangle normals (computed here, without allocating). Double-sided.
 */
function createMembrane(material, triangles, tints) {
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
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
  const normalAttribute = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.6);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const pointCount = triangles.reduce((most, triangle) => Math.max(most, ...triangle), 0) + 1;
  const points = Array.from({ length: pointCount }, () => new THREE.Vector3());
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  return {
    mesh,
    points,
    refresh() {
      for (let index = 0; index < triangles.length; index++) {
        const triangle = triangles[index];
        const a = points[triangle[0]];
        const b = points[triangle[1]];
        const c = points[triangle[2]];
        edgeA.subVectors(b, a);
        edgeB.subVectors(c, a);
        normal.crossVectors(edgeA, edgeB);
        const length = normal.length();
        if (length > 1e-9) normal.divideScalar(length);
        else normal.set(0, 1, 0);
        for (let corner = 0; corner < 3; corner++) {
          const point = points[triangle[corner]];
          const base = index * 9 + corner * 3;
          positions[base] = point.x;
          positions[base + 1] = point.y;
          positions[base + 2] = point.z;
          normals[base] = normal.x;
          normals[base + 1] = normal.y;
          normals[base + 2] = normal.z;
        }
      }
      positionAttribute.needsUpdate = true;
      normalAttribute.needsUpdate = true;
    },
  };
}

/**
 * The flame jet: two additive cones from the mouth (apex) forward along -z, a flowing flicker along
 * them; drawn every frame (at zero opacity when out) so its pipeline is built with the dragon.
 */
function createFireJet() {
  const intensity = uniform(0);
  const clock = uniform(0);
  const geometry = new THREE.ConeGeometry(1, 1, 14, 6, true);
  // Apex at the origin, the open base 1 m ahead (-z): the cone's +y axis turned to -z.
  geometry.translate(0, -0.5, 0);
  geometry.rotateX(Math.PI / 2);
  function flameMaterial(coreShare, tintNear, tintFar, strength, speed) {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    // uv.y runs 1 at the apex (the mouth) to 0 at the far end; uv.x around the cone.
    const along = float(1).sub(uv().y);
    const flow = sin(along.mul(17).sub(clock.mul(speed)).add(uv().x.mul(25.13))).mul(0.5).add(0.5);
    const lick = sin(along.mul(7.3).sub(clock.mul(speed * 0.62)).add(uv().x.mul(12.57).mul(coreShare + 1))).mul(0.5).add(0.5);
    const flicker = flow.mul(0.55).add(lick.mul(0.45));
    const fade = smoothstep(float(0), float(0.08), along).mul(float(1).sub(smoothstep(float(0.55), float(1), along)));
    material.colorNode = mix(color(tintNear), color(tintFar), saturate(along.mul(1.4))).mul(strength);
    material.opacityNode = intensity.mul(fade).mul(flicker.mul(0.7).add(0.3));
    return material;
  }
  const outer = new THREE.Mesh(geometry, flameMaterial(0, 0xffb347, 0xc8341a, 1.6, 11));
  const inner = new THREE.Mesh(geometry, flameMaterial(1, 0xfff1c2, 0xff8a2a, 2.4, 15));
  for (const mesh of [outer, inner]) {
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
  }
  const group = new THREE.Group();
  group.name = 'dragon-fire';
  group.add(outer, inner);
  return {
    group,
    /** Length and opacity from the breath's intensity (0..1); time drives the flicker. */
    set(level, time) {
      intensity.value = level;
      clock.value = time;
      const length = Math.max(0.05, FIRE_LENGTH * smooth01(level * 1.4));
      const radius = Math.tan(FIRE_ANGLE) * length;
      outer.scale.set(radius, radius, length);
      inner.scale.set(radius * 0.45, radius * 0.45, length * 0.7);
    },
  };
}

export function buildDragonMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const body = materials.body;
  const membraneMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.6, metalness: 0 });
  const eyeMaterial = new THREE.MeshBasicNodeMaterial();
  eyeMaterial.colorNode = color(0xffd76a).mul(2.2);
  const root = new THREE.Group();
  root.name = 'dragon';
  addSolid(root, buildDragonBody(), body);

  const neck = pivotGroup(root, DRAGON.neck, 'dragon-head');
  solid(neck, buildDragonHead, body, { hideInCockpit: true });
  const jaw = pivotGroup(neck, [0, -0.03, -0.05], 'dragon-jaw');
  solid(jaw, buildDragonJaw, body, { hideInCockpit: true });
  const eyeGeometry = new THREE.OctahedronGeometry(0.011, 0);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye.position.set(side * 0.045, 0.022, -0.085);
    eye.userData.hideInCockpit = true;
    neck.add(eye);
  }
  const fire = createFireJet();
  fire.group.position.set(DRAGON_MOUTH[0] - DRAGON.neck[0], DRAGON_MOUTH[1] - DRAGON.neck[1], DRAGON_MOUTH[2] - DRAGON.neck[2]);
  fire.group.rotation.x = -FIRE_DROOP;
  neck.add(fire.group);

  // The tail: a chain of segments, each a pivot at the end of the one before.
  const tailSegments = [];
  let parent = pivotGroup(root, DRAGON.tailBase, 'dragon-tail-0');
  for (let index = 0; index < DRAGON.tailSegments; index++) {
    const radius = 0.034 * (1 - index / DRAGON.tailSegments) + 0.006;
    const next = 0.034 * (1 - (index + 1) / DRAGON.tailSegments) + 0.006;
    solid(parent, (builder) => {
      tube(builder, [[0, 0, 0], [0, 0, DRAGON.tailSegment]], [radius, next], () => PALETTE.orange);
      spike(builder, [0, radius * 0.8, DRAGON.tailSegment * 0.3], [0, radius + 0.03, DRAGON.tailSegment * 0.1], 0.008, PALETTE.charcoal);
      if (index === DRAGON.tailSegments - 1) {
        builder.quad([0, 0, DRAGON.tailSegment], [-0.05, 0, DRAGON.tailSegment + 0.06], [0, 0, DRAGON.tailSegment + 0.14], [0.05, 0, DRAGON.tailSegment + 0.06], PALETTE.charcoal, [0, 1, DRAGON.tailSegment + 0.06]);
        builder.quad([0, 0, DRAGON.tailSegment], [0.05, 0, DRAGON.tailSegment + 0.06], [0, 0, DRAGON.tailSegment + 0.14], [-0.05, 0, DRAGON.tailSegment + 0.06], PALETTE.charcoal, [0, -1, DRAGON.tailSegment + 0.06]);
      }
    }, body);
    tailSegments.push(parent);
    if (index < DRAGON.tailSegments - 1) parent = pivotGroup(parent, [0, 0, DRAGON.tailSegment], `dragon-tail-${index + 1}`);
  }

  const fingerTips = DRAGON.fingers.map(([angle, length]) => [Math.cos(angle * DEG) * length, -0.01, Math.sin(angle * DEG) * length]);
  // Membrane points: 0 shoulder, 1 wrist, 2-4 finger tips, 5 flank, 6-8 trailing scallops.
  const membraneTriangles = [[1, 2, 6], [1, 6, 3], [1, 3, 7], [1, 7, 4], [1, 4, 8], [1, 8, 5], [0, 1, 5]];
  const membraneTints = [MEMBRANE_DARK, MEMBRANE_DARK, PALETTE.orange, MEMBRANE_DARK, PALETTE.orange, PALETTE.orange, PALETTE.orange];
  const wings = [-1, 1].map((side) => {
    const shoulder = pivotGroup(root, [side * DRAGON.shoulder[0], DRAGON.shoulder[1], DRAGON.shoulder[2]], `dragon-shoulder-${side}`);
    addSolid(shoulder, buildDragonArm(side), body);
    const wrist = pivotGroup(shoulder, [side * DRAGON.arm, 0, -0.03], `dragon-wrist-${side}`);
    addSolid(wrist, buildDragonFingers(side), body);
    const membrane = createMembrane(membraneMaterial, membraneTriangles, membraneTints);
    root.add(membrane.mesh);
    return {
      side,
      shoulder,
      wrist,
      membrane,
      tips: fingerTips.map(([x, y, z]) => new THREE.Vector3(side * x, y, z)),
      flank: new THREE.Vector3(side * DRAGON.flank[0], DRAGON.flank[1], DRAGON.flank[2]),
      root: new THREE.Vector3(side * DRAGON.shoulder[0], DRAGON.shoulder[1], DRAGON.shoulder[2] - 0.02),
    };
  });

  const legs = [-1, 1].map((side) => {
    const hip = pivotGroup(root, [side * DRAGON.hip[0], DRAGON.hip[1], DRAGON.hip[2]], `dragon-leg-${side}`);
    solid(hip, (builder) => buildLeg(builder, PALETTE.orange, PALETTE.orange, PALETTE.charcoal, 0.04), body);
    return hip;
  });

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.fromArray(EYES.dragon);
  root.add(eyeAnchor);

  // The fire's light: borrowed from the spawn light pool while the flame burns.
  const lightPool = ctx.systems?.spawns?.manager?.lights ?? null;
  let light = null;
  const mouthLocal = new THREE.Vector3(DRAGON_MOUTH[0], DRAGON_MOUTH[1], DRAGON_MOUTH[2] - 2.5);
  const lightPosition = new THREE.Vector3();
  function revokeLight() {
    light = null;
  }
  function releaseLight() {
    if (light && lightPool) lightPool.release(light);
    light = null;
  }

  const pose = createPose();
  const wingtips = [new THREE.Vector3(), new THREE.Vector3()];
  const scratch = new THREE.Vector3();

  return {
    root,
    wingtips,
    eyeAnchor,
    anchors: {
      tail: new THREE.Vector3(0, 0.035, 1.05),
      mouth: new THREE.Vector3(DRAGON_MOUTH[0], DRAGON_MOUTH[1], DRAGON_MOUTH[2]),
    },

    update(visual, dt) {
      const step = Math.max(0, Math.min(dt, 0.05));
      const craftState = visual.craftState || {};
      const time = visual.time ? visual.time.elapsed : 0;
      animatePose(pose, visual, craftState, step);
      const stroke = strokeAngle(craftState, pose) * 1.1;
      const amplitude = clamp(Number(craftState.flapAmplitude) || 0, 0, 1);
      const phase = Number(craftState.flapPhase) || 0;
      const roll = clamp(Number(visual.aileron) || 0, -1, 1);
      const pitch = clamp(Number(visual.elevator) || 0, -1, 1);
      const yaw = clamp(Number(visual.rudder) || 0, -1, 1);
      const fold = pose.fold;
      for (const wing of wings) {
        const side = wing.side;
        const dihedral = (8 * DEG - side * roll * 5 * DEG + stroke) * (1 - fold) + 18 * DEG * fold;
        wing.shoulder.rotation.set(0, side * -(6 * DEG + 14 * DEG * fold), side * dihedral);
        const lag = amplitude * 20 * DEG * Math.sin(phase * Math.PI * 2 - 0.8) * (1 - fold);
        wing.wrist.rotation.set(0, side * -(55 * DEG * fold), side * (lag + 25 * DEG * fold));
        wing.shoulder.updateMatrix();
        wing.wrist.updateMatrix();
        const points = wing.membrane.points;
        points[0].copy(wing.root);
        points[1].set(0, 0, 0).applyMatrix4(wing.wrist.matrix).applyMatrix4(wing.shoulder.matrix);
        for (let finger = 0; finger < 3; finger++) points[2 + finger].copy(wing.tips[finger]).applyMatrix4(wing.wrist.matrix).applyMatrix4(wing.shoulder.matrix);
        points[5].copy(wing.flank);
        // Scallops: the trailing edge sags toward the wrist between the bones (less when folded).
        const sag = 0.24 - 0.12 * fold;
        for (let gap = 0; gap < 3; gap++) {
          const from = points[2 + gap];
          const to = points[3 + gap];
          points[6 + gap].lerpVectors(from, to, 0.5).lerp(points[1], sag);
        }
        wing.membrane.refresh();
        wingtips[side < 0 ? 0 : 1].copy(points[2]);
      }
      // Tail: sways with the wingbeat and the yaw, lifts with the pitch, curls up on the perch.
      for (let index = 0; index < tailSegments.length; index++) {
        const wave = Math.sin(time * 1.9 - index * 0.7) * (0.05 + 0.04 * amplitude);
        tailSegments[index].rotation.set(-pitch * 0.06 + pose.perch * 0.12 + Math.sin(phase * Math.PI * 2 - index * 0.9) * 0.05 * amplitude, wave + yaw * 0.12, 0);
      }
      for (const leg of legs) leg.rotation.set(-1.25 * (1 - pose.legs) + 0.15 * pose.flare, 0, 0);
      // Fire: the jaw opens, the flame burns, the light follows the flame.
      const level = clamp(Number(craftState.fireIntensity) || 0, 0, 1);
      pose.jaw = step > 0 ? damp(pose.jaw, Math.max(level, pose.screech), 10, step) : level;
      jaw.rotation.set(0.42 * pose.jaw, 0, 0);
      neck.rotation.set(-0.3 * pose.screech + 0.1 * pose.perch - 0.12 * level, pose.look, 0);
      fire.set(level, time);
      if (level > 0.02 && !light && lightPool) {
        light = lightPool.acquire(5, revokeLight);
        if (light) light.color.setRGB(1, 0.62, 0.28);
      } else if (level <= 0.02 && light) {
        releaseLight();
      }
      if (light) {
        lightPosition.copy(mouthLocal).applyQuaternion(root.quaternion).add(root.position);
        light.position.copy(lightPosition);
        light.intensity = 900 * level;
        light.distance = 40;
        light.decay = 2;
      }
    },

    dispose() {
      releaseLight();
      disposeCraftMesh(root, ctx);
    },
  };
}
