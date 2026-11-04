// Recipe 'caveMouth': the mouth of a cave high on a mountain face (preset 48, the bats at dusk). It
// finds the steepest high face near the anchor with cliffFace.js, the same search the fauna engine's
// bat stream makes from the same activation (so the bats pour out of this mouth), and builds a hood of
// broken rock around a dark opening facing out from the face, a short black throat behind it and a
// rubble apron spilling down the slope below. The hood is solid (a collider hull). With requireFace and
// no face in reach the part ends at once (the bats find none either, so the activation is declined).
import { findCliffFace } from '../../cliffFace.js';
import { addBoulder, pick } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';
import { builderFrame, localHull } from '../colliders.js';

export const CAVE_MOUTH_DEFAULTS = Object.freeze({
  search: 1500,
  width: [11, 16],
  height: [7, 10],
  depth: [10, 15],
  requireFace: true,
});

const STONE = Object.freeze({
  rock: Object.freeze([paint(0x6b6259), paint(0x5d554d), paint(0x786e63)]),
  dark: paint(0x0b0908),
  throat: paint(0x15110f),
  moss: paint(0x4e5a37),
});
/** Blocks around the opening's half ellipse. */
const HOOD_BLOCKS = 9;

export function buildCaveMouth(context, read) {
  const { rng, body, detail, out } = context;
  const search = read.number('search', CAVE_MOUTH_DEFAULTS.search, 100, 6000);
  const width = roll(read.range('width', CAVE_MOUTH_DEFAULTS.width, 3, 60), rng);
  const height = roll(read.range('height', CAVE_MOUTH_DEFAULTS.height, 2, 40), rng);
  const depth = roll(read.range('depth', CAVE_MOUTH_DEFAULTS.depth, 2, 80), rng);
  const requireFace = read.boolean('requireFace', CAVE_MOUTH_DEFAULTS.requireFace);
  const anchor = context.anchor;
  const face = findCliffFace(context.worldGround, anchor.x, anchor.z, search, context.waterLevel + anchor.y);
  if (!face && requireFace) {
    out.ended = true;
    return;
  }
  const x = face ? face.x - anchor.x : 0;
  const y = face ? face.y - anchor.y : context.ground(0, 0);
  const z = face ? face.z - anchor.z : 0;
  const yaw = face ? Math.atan2(face.faceX, -face.faceZ) : context.heading * (Math.PI / 180);
  const place = builderFrame(x, y, z, yaw);
  // In the mouth's frame: -z out of the face, +z into the hill, y up from the face's foot.
  body.setTransform(x, y, z, yaw);
  detail.setTransform(x, y, z, yaw);
  const halfWidth = width / 2;
  const blockDepth = 4.5;
  // The dark opening and the throat behind it.
  const opening = [];
  for (let step = 0; step <= HOOD_BLOCKS; step++) {
    const angle = (step / HOOD_BLOCKS) * Math.PI;
    opening.push([-Math.cos(angle) * halfWidth, Math.sin(angle) * height, 0]);
  }
  for (let step = 0; step < HOOD_BLOCKS; step++) {
    const a = opening[step];
    const b = opening[step + 1];
    body.setPaint(STONE.dark).triangle(0, 0, 1.2, a[0], a[1], 1.2, b[0], b[1], 1.2);
    // The throat's walls, receding into the dark.
    body.setPaint(STONE.throat).quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0] * 0.7, b[1] * 0.7, depth], [a[0] * 0.7, a[1] * 0.7, depth]);
  }
  body.setPaint(STONE.throat).quad([-halfWidth, 0, 0], [-halfWidth * 0.7, 0, depth], [halfWidth * 0.7, 0, depth], [halfWidth, 0, 0]);
  // The hood: broken rock blocks around the opening, jutting out of the face.
  const hullPoints = [];
  for (let step = 0; step < HOOD_BLOCKS; step++) {
    const angle = ((step + 0.5) / HOOD_BLOCKS) * Math.PI;
    const ring = 1.25 + rng() * 0.2;
    const cx = -Math.cos(angle) * halfWidth * ring;
    const cy = Math.sin(angle) * height * ring + 0.6;
    const size = 3 + rng() * 2.5;
    body.setPaint(pick(STONE.rock, rng)).box(cx, cy, -blockDepth * 0.4, size * 1.3, size, blockDepth + rng() * 2, (rng() - 0.5) * 0.5);
    hullPoints.push([cx, cy + size * 0.5, -blockDepth], [cx, cy + size * 0.5, blockDepth]);
  }
  // A lintel slab over the top and a mossy brow above it.
  body.setPaint(shade(STONE.rock[1], 0.9)).box(0, height * 1.35 + 1.5, -blockDepth * 0.2, width * 1.5, 3.2, blockDepth * 1.6, (rng() - 0.5) * 0.2);
  body.setPaint(STONE.moss).box(0, height * 1.35 + 3.4, blockDepth * 0.3, width * 1.2, 1.2, blockDepth * 1.8, (rng() - 0.5) * 0.3);
  hullPoints.push([-width * 0.8, -1, -blockDepth], [width * 0.8, -1, -blockDepth], [-width * 0.8, -1, blockDepth], [width * 0.8, -1, blockDepth]);
  hullPoints.push([0, height * 1.35 + 4, -blockDepth], [0, height * 1.35 + 4, blockDepth * 1.2]);
  out.colliders.push(localHull('hood', hullPoints.map(place), { surface: 'stone' }));
  // The rubble apron down the slope below the mouth.
  body.resetTransform();
  for (let boulder = 0; boulder < 12; boulder++) {
    const along = -2 - rng() * 22;
    const across = (rng() - 0.5) * width * 1.6;
    const [bx, , bz] = place([across, 0, along]);
    addBoulder(detail, bx, context.ground(bx, bz), bz, 0.8 + rng() * 2, rng, pick(STONE.rock, rng));
  }
  detail.resetTransform();
  const mouth = place([0, height * 0.5, -1]);
  out.audioPoint = mouth;
  out.radius = Math.max(out.radius, Math.hypot(x, z) + width * 2);
}
