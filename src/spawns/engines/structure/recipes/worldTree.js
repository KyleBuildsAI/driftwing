// Recipe 'worldTree': a colossal tree taller than the mountains (preset 66). A buttressed trunk rises
// in a gentle S-curve to `height` metres, tapering from `trunkRadius`; great limbs branch off in
// tiers from `branchStart` of the height upward, each bending up in three segments with a side bough,
// and carry the crown: clumps of foliage around the limb tips and over the top, leaving open lanes
// between the limbs. Each lane is a fly-through gate (structure:gate; the first pass earns the
// preset's achievement). Buttress roots spread over the ground around the foot.
//
// Colliders (contract b.8: "world tree = cylinder trunk plus capsule branches"): the trunk as capsules
// between its rings (as wide as the widest ring), every limb segment, bough and root as a capsule, the
// foliage clumps as slightly smaller spheres (surface 'foliage'). Perch points sit on top of every
// limb's first bend and on the crown's top clump. The body is one solid geometry (bark, roots and
// foliage, the foliage swaying a little at its tips with the structure's sway). The voice groans now
// and then (out.voiceTrigger 'creak').
import { PALETTE, paint, shade } from '../palette.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localCapsule, localSphere } from '../colliders.js';

export const WORLD_TREE_DEFAULTS = Object.freeze({
  height: [1100, 1350],
  trunkRadius: [70, 90],
  limbs: [9, 12],
  branchStart: 0.42,
  crown: [520, 680],
  roots: [7, 9],
  clumps: [5, 7],
  lanes: true,
});

const BARK = Object.freeze([paint(0x6a5644), paint(0x5c4a3a), paint(0x74604c), paint(0x544436)]);
const FOLIAGE = Object.freeze([paint(0x4d7a3c), paint(0x5a8a42), paint(0x426d36), paint(0x6a9448), paint(0x3c6232)]);
/** Ring spacing (m) up the trunk and its lathe sides. */
const TRUNK_STEP = 55;
const TRUNK_SIDES = 14;
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** A tube through rings [{ x, y, z, r }] around the vertical axis (a trunk or a root's flare). */
function addTube(builder, rings, sides, phase, paintFor) {
  const points = rings.map((ring) => {
    const list = [];
    for (let side = 0; side < sides; side++) {
      const angle = phase + (side / sides) * TWO_PI;
      list.push([ring.x + Math.sin(angle) * ring.r, ring.y, ring.z - Math.cos(angle) * ring.r]);
    }
    return list;
  });
  for (let ring = 0; ring < points.length - 1; ring++) {
    const lower = points[ring];
    const upper = points[ring + 1];
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      builder.setPaint(paintFor(ring, side));
      builder.quad(lower[side], upper[side], upper[next], lower[next]);
    }
  }
  const top = points[points.length - 1];
  const last = rings[rings.length - 1];
  builder.setPaint(paintFor(points.length - 1, 0));
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    builder.triangle(last.x, last.y, last.z, top[next][0], top[next][1], top[next][2], top[side][0], top[side][1], top[side][2]);
  }
}

/** A foliage clump: a jagged low-poly ball of radius r at (x, y, z), its top swaying a little. */
function addClump(builder, x, y, z, r, rng) {
  const leaf = FOLIAGE[Math.floor(rng() * FOLIAGE.length)];
  const rings = [[r * 0.3, -r * 0.62], [r * 0.82, -r * 0.32], [r, r * 0.06], [r * 0.78, r * 0.44], [r * 0.32, r * 0.74]];
  builder.setPaint(shade(leaf, 0.82 + rng() * 0.3));
  builder.setSway(0.18);
  builder.lathe(x, y, z, rings, 8, { closeBottom: true, closeTop: true, phase: rng() * TWO_PI, radiusAt: (ring, side, radius) => radius * (0.84 + rng() * 0.3) });
  builder.setSway(0);
}

/** A limb segment: a beam from a to b (local [x, y, z]), width tapering is the caller's. */
function addLimb(builder, a, b, width, rng) {
  builder.setPaint(BARK[Math.floor(rng() * BARK.length)]);
  builder.beam(a[0], a[1], a[2], b[0], b[1], b[2], width, width);
}

export function buildWorldTree(context, read) {
  const { rng, body, out } = context;
  const height = roll(read.range('height', WORLD_TREE_DEFAULTS.height, 200, 3000), rng);
  const trunkRadius = roll(read.range('trunkRadius', WORLD_TREE_DEFAULTS.trunkRadius, 5, 300), rng);
  const limbCount = rollInteger(read.range('limbs', WORLD_TREE_DEFAULTS.limbs, 3, 24), rng);
  const branchStart = read.number('branchStart', WORLD_TREE_DEFAULTS.branchStart, 0.15, 0.85);
  const crown = roll(read.range('crown', WORLD_TREE_DEFAULTS.crown, 50, 3000), rng);
  const rootCount = rollInteger(read.range('roots', WORLD_TREE_DEFAULTS.roots, 0, 24), rng);
  const clumpRange = read.range('clumps', WORLD_TREE_DEFAULTS.clumps, 1, 16);
  const lanes = read.boolean('lanes', WORLD_TREE_DEFAULTS.lanes);
  const achievement = read.object('laneAchievement', null);
  if (achievement !== null && (typeof achievement.id !== 'string' || !achievement.id || typeof achievement.title !== 'string' || !achievement.title)) {
    read.fail('laneAchievement', 'must be null or { id, title } with non-empty strings');
  }
  const base = context.ground(0, 0);

  // ---- Trunk: rings up an S-curve, flared at the foot ------------------------------------------
  const swayPhase = rng() * TWO_PI;
  const swayAmplitude = trunkRadius * 0.9;
  const trunk = [];
  const rings = Math.max(4, Math.ceil(height / TRUNK_STEP));
  for (let index = 0; index <= rings; index++) {
    const share = index / rings;
    const bend = Math.sin(share * Math.PI * 1.4 + swayPhase) * swayAmplitude * share;
    const lean = Math.cos(share * Math.PI * 1.1 + swayPhase) * swayAmplitude * 0.6 * share;
    const radius = trunkRadius * (1 - 0.68 * share) + trunkRadius * 0.55 * Math.exp(-share * 14);
    trunk.push({ x: bend, y: base - 12 + share * (height + 12), z: lean, r: radius });
  }
  const barkTone = rings > 0 ? trunk.map(() => 0.85 + rng() * 0.3) : [];
  addTube(body, trunk, TRUNK_SIDES, rng() * TWO_PI, (ring, side) => shade(BARK[(ring + side) % BARK.length], barkTone[Math.min(ring, barkTone.length - 1)]));
  for (let index = 0; index < trunk.length - 1; index++) {
    const lower = trunk[index];
    const upper = trunk[index + 1];
    out.colliders.push(localCapsule('trunk', lower.x, lower.y, lower.z, upper.x, upper.y, upper.z, Math.max(lower.r, upper.r), { surface: 'wood' }));
  }
  /** The trunk's centre at a height share (0..1), interpolated between its rings. */
  const trunkAt = (share) => {
    const position = Math.min(rings - 1e-6, Math.max(0, share * rings));
    const index = Math.floor(position);
    const t = position - index;
    const a = trunk[index];
    const b = trunk[index + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, r: a.r + (b.r - a.r) * t };
  };

  // ---- Buttress roots -------------------------------------------------------------------------
  for (let root = 0; root < rootCount; root++) {
    const angle = (root / Math.max(1, rootCount)) * TWO_PI + rng() * 0.4;
    const reach = trunkRadius * (2.2 + rng() * 1.4);
    const dirX = Math.sin(angle);
    const dirZ = -Math.cos(angle);
    const startX = dirX * trunkRadius * 0.7;
    const startZ = dirZ * trunkRadius * 0.7;
    const midX = dirX * reach * 0.55;
    const midZ = dirZ * reach * 0.55;
    const endX = dirX * reach;
    const endZ = dirZ * reach;
    const start = [startX, base + trunkRadius * 0.9, startZ];
    const middle = [midX, context.ground(midX, midZ) + trunkRadius * 0.28, midZ];
    const end = [endX, context.ground(endX, endZ) - 2, endZ];
    const width = trunkRadius * (0.42 + rng() * 0.16);
    addLimb(body, start, middle, width, rng);
    addLimb(body, middle, end, width * 0.55, rng);
    out.colliders.push(localCapsule('root', start[0], start[1], start[2], middle[0], middle[1], middle[2], width * 0.5, { surface: 'wood' }));
    out.colliders.push(localCapsule('root', middle[0], middle[1], middle[2], end[0], end[1], end[2], width * 0.3, { surface: 'wood' }));
  }

  // ---- Limbs and the crown ----------------------------------------------------------------------
  const limbAngles = [];
  const crownTop = trunk[trunk.length - 1];
  for (let limb = 0; limb < limbCount; limb++) {
    const share = branchStart + (1 - branchStart) * 0.88 * (limb / Math.max(1, limbCount - 1)) * (0.85 + rng() * 0.15);
    const angle = limb * (137.5 * DEG) + rng() * 0.3;
    limbAngles.push(angle);
    const origin = trunkAt(share);
    const dirX = Math.sin(angle);
    const dirZ = -Math.cos(angle);
    // Lower limbs reach farther; every limb bends upward segment by segment.
    const length = crown * (1.05 - 0.55 * (share - branchStart) / (1 - branchStart)) * (0.85 + rng() * 0.25);
    const width = origin.r * (0.42 + rng() * 0.12);
    let from = [origin.x + dirX * origin.r * 0.6, origin.y, origin.z + dirZ * origin.r * 0.6];
    let segmentWidth = width;
    const elevations = [12 + rng() * 8, 24 + rng() * 10, 40 + rng() * 14];
    for (let segment = 0; segment < 3; segment++) {
      const segmentLength = length * [0.42, 0.34, 0.24][segment];
      const elevation = elevations[segment] * DEG;
      const to = [
        from[0] + dirX * Math.cos(elevation) * segmentLength,
        from[1] + Math.sin(elevation) * segmentLength,
        from[2] + dirZ * Math.cos(elevation) * segmentLength,
      ];
      addLimb(body, from, to, segmentWidth, rng);
      const tags = { surface: 'wood' };
      // The top of the first bend is a broad, level perch.
      if (segment === 0) tags.perch = { x: to[0], y: to[1] + segmentWidth * 0.5 + 1, z: to[2] };
      out.colliders.push(localCapsule('limb', from[0], from[1], from[2], to[0], to[1], to[2], segmentWidth * 0.5, tags));
      // A side bough from the middle segment.
      if (segment === 1) {
        const side = rng() < 0.5 ? -1 : 1;
        const boughAngle = angle + side * (35 + rng() * 25) * DEG;
        const boughLength = segmentLength * (0.9 + rng() * 0.4);
        const bough = [
          to[0] + Math.sin(boughAngle) * boughLength * 0.85,
          to[1] + boughLength * 0.5,
          to[2] - Math.cos(boughAngle) * boughLength * 0.85,
        ];
        addLimb(body, to, bough, segmentWidth * 0.5, rng);
        out.colliders.push(localCapsule('bough', to[0], to[1], to[2], bough[0], bough[1], bough[2], segmentWidth * 0.25, { surface: 'wood' }));
        addCrownClumps(context, bough, crown * 0.11, clumpRange);
      }
      from = to;
      segmentWidth *= 0.62;
    }
    addCrownClumps(context, from, crown * 0.15, clumpRange);
  }
  // The crown's top.
  const topY = crownTop.y + crown * 0.08;
  addClump(body, crownTop.x, topY, crownTop.z, crown * 0.16, rng);
  out.colliders.push(localSphere('foliage', crownTop.x, topY, crownTop.z, crown * 0.16 * 0.8, { surface: 'foliage', perch: { x: crownTop.x, y: topY + crown * 0.16 * 0.72, z: crownTop.z } }));

  // ---- Fly-through lanes: one gate between each pair of neighbouring limbs ----------------------
  if (lanes) {
    const sorted = limbAngles.map((angle) => ((angle % TWO_PI) + TWO_PI) % TWO_PI).sort((a, b) => a - b);
    const laneShare = branchStart + (1 - branchStart) * 0.35;
    const laneCentre = trunkAt(laneShare);
    for (let index = 0; index < sorted.length; index++) {
      const a = sorted[index];
      const b = index === sorted.length - 1 ? sorted[0] + TWO_PI : sorted[index + 1];
      if (b - a < 0.45) continue;
      const middle = (a + b) * 0.5;
      const reach = crown * 0.55;
      const x = laneCentre.x + Math.sin(middle) * reach;
      const z = laneCentre.z - Math.cos(middle) * reach;
      const halfWidth = Math.max(20, Math.min(reach * Math.sin((b - a) * 0.5) - crown * 0.12, 160));
      context.addGate({
        id: `lane:${index}`,
        kind: 'through',
        x,
        z,
        normalX: Math.sin(middle),
        normalZ: -Math.cos(middle),
        halfWidth,
        minY: laneCentre.y - height * 0.1,
        maxY: laneCentre.y + height * 0.12,
        action: null,
        achievement: achievement ? { id: achievement.id, title: achievement.title } : null,
      });
    }
  }

  out.approach = Math.max(1500, crown * 4);
  // The limbs groan now and then (the canopy voice's creak).
  out.voiceTrigger = { name: 'creak', interval: [9, 22], strength: 1 };
  out.audioPoint = [crownTop.x * 0.5, base + height * 0.55, crownTop.z * 0.5];
  out.windProbe = [0, height * 0.7, 0];
  out.sway = { dirX: 1, dirZ: 0, amplitude: 1.6, frequency: 0.11 };
  out.radius = Math.max(out.radius, crown * 1.25, height * 0.6);
}

/** Foliage clumps around a limb tip (local [x, y, z]), each with its slightly smaller sphere collider. */
function addCrownClumps(context, tip, size, clumpRange) {
  const { rng, body, out } = context;
  const count = rollInteger(clumpRange, rng);
  for (let clump = 0; clump < count; clump++) {
    const angle = rng() * TWO_PI;
    const reach = size * (clump === 0 ? 0 : 0.8 + rng() * 0.6);
    const radius = size * (0.65 + rng() * 0.45);
    const x = tip[0] + Math.sin(angle) * reach;
    const y = tip[1] + size * (0.2 + rng() * 0.5) - (clump === 0 ? 0 : size * 0.3);
    const z = tip[2] - Math.cos(angle) * reach;
    addClump(body, x, y, z, radius, rng);
    out.colliders.push(localSphere('foliage', x, y, z, radius * 0.8, { surface: 'foliage' }));
  }
  body.setPaint(PALETTE.trunk);
}
