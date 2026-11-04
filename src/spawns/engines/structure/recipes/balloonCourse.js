// Recipe 'balloonCourse': a balloon festival's weave course. Dozens of tethered hot-air balloons of
// the v1 family (src/world/balloonFamily.js: the envelope profile, palettes and gore patterns the
// balloon fair landmarks and the flyable balloon share) stand at different heights over the field.
// Every gate of the preset's `challenge` block (in the site frame as it stands) is flanked by two of
// them, envelope to envelope across the opening, with the role's pennant on each crown; the rest
// float around the course, clear of the opening line between gates. Each balloon is moored by a
// tether to a stake, bobs gently with the wind (the sway, each balloon its own amount) and is solid:
// two hulls for the envelope and a box for the basket, as the landmark balloons, and a rope capsule
// for the tether.
import { BALLOON_PALETTES, BALLOON_PATTERNS, BALLOON_PROFILE, balloonPatternIndex } from '../../../../world/balloonFamily.js';
import { PALETTE } from '../palette.js';
import { paint, shade } from '../meshBuilder.js';
import { localBox, localCapsule, localHull } from '../colliders.js';
import { addRolePennant, courseFromBlock, localGate } from '../courseKit.js';
import { pick } from '../common.js';

export const BALLOON_COURSE_DEFAULTS = Object.freeze({
  count: 30,
  height: [19, 24],
  tethers: true,
  spread: 260,
  gap: 3,
});

const SEGMENTS = 16;
/** The landmarks' balloon: the basket hangs this far below the mouth, the burner this far, for a 22 m envelope. */
const REFERENCE_HEIGHT = 22;
const BASKET_DROP = 7.6;
const BURNER_DROP = 5.6;
/**
 * A decor balloon (and its tether, hanging under it) keeps this far (m), measured over the ground,
 * from every gate and from the straight line between two gates.
 */
const OPENING_CLEARANCE = 32;
const PLACEMENT_TRIES = 24;
const PALETTE_PAINTS = BALLOON_PALETTES.map((palette) => palette.map((hex) => paint(hex)));
const SKIRT = paint(0x2c2f38);
const MOUTH = Object.freeze([0.12, 0.05, 0.02, 4]);
const WICKER = paint(0x8b5a2b);
const WICKER_RIM = paint(0x4f3219);
const ROPE = paint(0x3b2a1c);
const BURNER = paint(0x3a3a40);
const STAKE = paint(0x5b4330);

/** Distance over the ground (m) from (x, z) to the segment a-b ({ x, z } points). */
function groundSegmentDistance(x, z, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz || 1;
  const t = Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / lengthSq));
  return Math.hypot(x - a.x - abx * t, z - a.z - abz * t);
}

/**
 * One balloon: its mouth at (x, mouthY, z) (local), the envelope `height` metres tall, moored by a
 * tether to the ground at groundY. sway: the balloon's own share of the structure's sway.
 */
function addBalloon(context, x, mouthY, z, height, groundY, sway, tethers, index) {
  const { body, detail, rng, out } = context;
  const colours = pick(PALETTE_PAINTS, rng);
  const pattern = pick(BALLOON_PATTERNS, rng);
  const scale = height / REFERENCE_HEIGHT;
  const phase = rng() * Math.PI * 2;
  const rings = BALLOON_PROFILE.map(([radius, share]) => {
    const points = [];
    for (let side = 0; side < SEGMENTS; side++) {
      const angle = phase + (side / SEGMENTS) * Math.PI * 2;
      points.push([x + Math.sin(angle) * radius * height, mouthY + share * height, z - Math.cos(angle) * radius * height]);
    }
    return points;
  });
  body.setSway(sway);
  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let side = 0; side < SEGMENTS; side++) {
      const next = (side + 1) % SEGMENTS;
      const face = ring === 0 ? SKIRT : shade(colours[balloonPatternIndex(pattern, ring - 1, side)], 0.97 + 0.06 * rng());
      body.setPaint(face).quad(lower[side], upper[side], upper[next], lower[next]);
    }
  }
  // The mouth, glowing faintly from the pilot light inside.
  const mouth = rings[1];
  for (let side = 0; side < SEGMENTS; side++) {
    const next = (side + 1) % SEGMENTS;
    body.setPaint(MOUTH).triangle(x, mouthY, z, mouth[side][0], mouth[side][1], mouth[side][2], mouth[next][0], mouth[next][1], mouth[next][2]);
  }
  const basketTop = mouthY - BASKET_DROP * scale;
  const burnerY = mouthY - BURNER_DROP * scale;
  body.setPaint(WICKER).box(x, basketTop - 0.65, z, 1.6, 1.3, 1.6);
  body.setPaint(WICKER_RIM).box(x, basketTop - 0.02, z, 1.76, 0.2, 1.76);
  detail.setSway(sway).setPaint(BURNER).box(x, burnerY, z, 0.72, 0.56, 0.72);
  const mouthRadius = BALLOON_PROFILE[1][0] * height;
  for (let corner = 0; corner < 4; corner++) {
    const cornerX = corner & 1 ? 0.78 : -0.78;
    const cornerZ = corner & 2 ? 0.78 : -0.78;
    const angle = Math.atan2(cornerZ, cornerX);
    detail.setPaint(ROPE).beam(x + cornerX, basketTop, z + cornerZ, x + Math.cos(angle) * mouthRadius, mouthY, z + Math.sin(angle) * mouthRadius, 0.1, 0.1);
    detail.setPaint(BURNER).beam(x + cornerX, basketTop, z + cornerZ, x + cornerX * 0.4, burnerY, z + cornerZ * 0.4, 0.08, 0.08);
  }
  detail.setSway(0);
  body.setSway(0);
  // The colliders: the envelope as two hulls on circumscribed octagons (the lower one reaches down to
  // the basket rim, holding the rigging and the burner), the basket as a box, the tether as a rope.
  const octagon = 1.04 / Math.cos(Math.PI / 8);
  const ringHull = (first, last) => {
    const points = [];
    for (let ring = first; ring <= last; ring++) {
      const [radius, share] = BALLOON_PROFILE[ring];
      if (radius === 0) {
        points.push([x, mouthY + share * height + 0.5, z]);
        continue;
      }
      for (let side = 0; side < 8; side++) {
        const angle = (side / 8) * Math.PI * 2;
        points.push([x + Math.cos(angle) * radius * height * octagon, mouthY + share * height, z + Math.sin(angle) * radius * height * octagon]);
      }
    }
    return points;
  };
  const lower = ringHull(0, 6);
  for (let corner = 0; corner < 4; corner++) lower.push([x + (corner & 1 ? 0.9 : -0.9), basketTop, z + (corner & 2 ? 0.9 : -0.9)]);
  const crownY = mouthY + height;
  out.colliders.push(localHull(`envelope${index}`, lower, { surface: 'cloth' }));
  out.colliders.push(localHull(`crown${index}`, ringHull(6, BALLOON_PROFILE.length - 1), { surface: 'cloth', perch: { x, y: crownY, z } }));
  out.colliders.push(localBox(`basket${index}`, x, basketTop - 0.65, z, 1.8, 1.5, 1.8, 0, { surface: 'wood' }));
  if (tethers) {
    // Moored a little upwind of the basket, the rope slack in a straight line to the stake.
    const stakeX = x - context.windX * 6;
    const stakeZ = z - context.windZ * 6;
    const basketBottom = basketTop - 1.3;
    body.setSway(0).setPaint(STAKE).box(stakeX, groundY + 0.4, stakeZ, 0.5, 1.2, 0.5);
    body.setPaint(ROPE).triangle(stakeX - 0.08, groundY + 0.6, stakeZ, stakeX + 0.08, groundY + 0.6, stakeZ, x, basketBottom, z, 0, 0, sway);
    body.triangle(stakeX + 0.08, groundY + 0.6, stakeZ, stakeX - 0.08, groundY + 0.6, stakeZ, x, basketBottom, z, 0, 0, sway);
    body.triangle(stakeX, groundY + 0.6, stakeZ - 0.08, stakeX, groundY + 0.6, stakeZ + 0.08, x, basketBottom, z, 0, 0, sway);
    body.triangle(stakeX, groundY + 0.6, stakeZ + 0.08, stakeX, groundY + 0.6, stakeZ - 0.08, x, basketBottom, z, 0, 0, sway);
    out.colliders.push(localCapsule(`tether${index}`, stakeX, groundY, stakeZ, x, basketBottom, z, 0.2, { surface: 'rope' }));
  }
  return crownY;
}

export function buildBalloonCourse(context, read) {
  const { rng, out, anchor } = context;
  const count = read.integer('count', BALLOON_COURSE_DEFAULTS.count, 2, 64);
  const heightRange = read.range('height', BALLOON_COURSE_DEFAULTS.height, 8, 40);
  const tethers = read.boolean('tethers', BALLOON_COURSE_DEFAULTS.tethers);
  const spread = read.number('spread', BALLOON_COURSE_DEFAULTS.spread, 20, 3000);
  const gap = read.number('gap', BALLOON_COURSE_DEFAULTS.gap, 0, 50);
  const definition = courseFromBlock(context, read);
  const gates = definition.gates.map((gate) => localGate(gate, anchor));
  const maxRadius = BALLOON_PROFILE.reduce((widest, [radius]) => Math.max(widest, radius), 0);
  let placed = 0;
  // Two balloons flank every gate, their envelopes' widest rings `gap` metres outside the opening.
  gates.forEach((gate) => {
    for (const side of [-1, 1]) {
      if (placed >= count) return;
      const height = heightRange[0] + (heightRange[1] - heightRange[0]) * rng();
      const reach = gate.halfWidth + maxRadius * height * 1.04 + gap;
      const x = gate.x + gate.right[0] * reach * side;
      const z = gate.z + gate.right[2] * reach * side;
      // The envelope's widest ring at the gate's centre height.
      const mouthY = gate.y + gate.right[1] * reach * side - 0.6 * height;
      const crownY = addBalloon(context, x, mouthY, z, height, context.ground(x, z), 0.7 + rng() * 0.6, tethers, placed);
      addRolePennant(context.detail, x, crownY, z, 4, gate.role, gate.normal[0], gate.normal[2]);
      placed++;
    }
  });
  // The rest float around the course, clear of the gates and of the line between them.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const gate of gates) {
    minX = Math.min(minX, gate.x);
    maxX = Math.max(maxX, gate.x);
    minZ = Math.min(minZ, gate.z);
    maxZ = Math.max(maxZ, gate.z);
  }
  for (let decor = placed; decor < count; decor++) {
    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      const height = heightRange[0] + (heightRange[1] - heightRange[0]) * rng();
      const x = minX - spread * 0.5 + (maxX - minX + spread) * rng();
      const z = minZ - spread * 0.5 + (maxZ - minZ + spread) * rng();
      const groundY = context.ground(x, z);
      const mouthY = groundY + 14 + rng() * 150;
      const clear = maxRadius * height + OPENING_CLEARANCE;
      let blocked = false;
      for (let index = 0; index < gates.length && !blocked; index++) {
        const gate = gates[index];
        if (Math.hypot(x - gate.x, z - gate.z) < clear + gate.halfWidth) blocked = true;
        else if (index > 0 && groundSegmentDistance(x, z, gates[index - 1], gate) < clear) blocked = true;
      }
      if (blocked) continue;
      addBalloon(context, x, mouthY, z, height, groundY, 0.7 + rng() * 0.6, tethers, decor);
      placed++;
      break;
    }
  }
  out.audioPoint = [(minX + maxX) * 0.5, context.ground((minX + maxX) * 0.5, (minZ + maxZ) * 0.5) + 40, (minZ + maxZ) * 0.5];
  out.radius = Math.max(out.radius, Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + spread);
  out.sway = { dirX: context.windX, dirZ: context.windZ, amplitude: 0.45, frequency: 0.11 };
}
