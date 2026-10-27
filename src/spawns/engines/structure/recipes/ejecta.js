// Recipe 'ejecta': the blocks a meteorite impact threw out, strewn over the rim and the outer flank of
// the site's crater stamp (preset 38, meteor crater lake). Blocks are densest on the rim crest and
// thin out down the flank, the biggest near the crest; a few lie tumbled on the inner wall above the
// lake. Blocks of at least SOLID_BLOCK radius are solid colliders, and the largest few on the crest
// are perches. Without a crater stamp (a debug spawn) the ring is laid `radius` metres around the
// anchor on the natural ground.
import { PALETTE, paint } from '../palette.js';
import { addBoulder, findStamp, pick } from '../common.js';
import { localSphere } from '../colliders.js';
import { roll } from '../../engineKit.js';

export const EJECTA_DEFAULTS = Object.freeze({
  stamp: 0,
  count: [90, 130],
  size: [1.5, 7],
  inner: 0.12,
  radius: 400,
  perches: 4,
});

/** Blocks at least this radius (m) are solid colliders. */
const SOLID_BLOCK = 2.5;
/** Impact breccia: rust-stained sandstone and grey limestone blocks. */
const BRECCIA = Object.freeze([paint(0x9a7f66), paint(0x8a7462), paint(0xa38c74), paint(0x7d756c), paint(0x948d84)]);

export function buildEjecta(context, read) {
  const { rng, body, detail, out, anchor } = context;
  const stampIndex = read.integer('stamp', EJECTA_DEFAULTS.stamp, 0, 16);
  const countRange = read.range('count', EJECTA_DEFAULTS.count, 0, 400);
  const sizeRange = read.range('size', EJECTA_DEFAULTS.size, 0.3, 20);
  const innerShare = read.number('inner', EJECTA_DEFAULTS.inner, 0, 0.5);
  const perchCount = read.integer('perches', EJECTA_DEFAULTS.perches, 0, 12);
  const crater = findStamp(context.site, 'crater', stampIndex);
  // The crater in the site frame: the rim crest radius and the outer flank's width.
  const centreX = crater ? crater.x - anchor.x : 0;
  const centreZ = crater ? crater.z - anchor.z : 0;
  const rimRadius = crater ? crater.radius : read.number('radius', EJECTA_DEFAULTS.radius, 50, 3000);
  const flank = crater ? crater.rimWidth : rimRadius * 0.55;
  const count = Math.round(roll(countRange, rng));
  const crest = [];
  let solid = 0;
  for (let block = 0; block < count; block++) {
    const angle = rng() * Math.PI * 2;
    const inside = rng() < innerShare;
    // Out on the flank the blocks thin out (a square-root fall); a few lie inside on the upper wall.
    const reach = inside ? rimRadius * (0.78 + 0.18 * rng()) : rimRadius + flank * 0.85 * rng() * rng();
    const x = centreX + Math.sin(angle) * reach;
    const z = centreZ - Math.cos(angle) * reach;
    const nearCrest = 1 - Math.min(1, Math.abs(reach - rimRadius) / (flank * 0.6));
    const radius = sizeRange[0] + (sizeRange[1] - sizeRange[0]) * rng() * (0.35 + 0.65 * nearCrest);
    const y = context.ground(x, z);
    const builder = radius < 1.2 ? detail : body;
    addBoulder(builder, x, y, z, radius, rng, pick(BRECCIA, rng));
    if (radius >= SOLID_BLOCK) {
      const collider = localSphere('block', x, y + radius * 0.3, z, radius * 1.05, { surface: 'stone', perch: false });
      out.colliders.push(collider);
      solid++;
      if (!inside && nearCrest > 0.6) crest.push({ collider, x, y: y + radius * 1.22, z, radius });
    }
  }
  // The biggest crest blocks are perches (the eagle lands on them).
  crest.sort((first, second) => second.radius - first.radius);
  for (let index = 0; index < Math.min(perchCount, crest.length); index++) {
    const block = crest[index];
    block.collider.tags.perch = { x: block.x, y: block.y, z: block.z };
  }
  out.facts.perches = Math.min(perchCount, crest.length);
  // A scatter of small fragments on the rim crest (detail, near only).
  for (let fragment = 0; fragment < count; fragment++) {
    const angle = rng() * Math.PI * 2;
    const reach = rimRadius + (rng() - 0.3) * flank * 0.3;
    const x = centreX + Math.sin(angle) * reach;
    const z = centreZ - Math.cos(angle) * reach;
    addBoulder(detail, x, context.ground(x, z), z, 0.4 + rng() * 0.6, rng, pick(PALETTE.rock, rng));
  }
  out.facts.blocks = count;
  out.facts.solidBlocks = solid;
  out.audioPoint = [centreX, context.ground(centreX + rimRadius, centreZ) + 20, centreZ];
  out.radius = Math.max(out.radius, Math.hypot(centreX, centreZ) + rimRadius + flank);
}
