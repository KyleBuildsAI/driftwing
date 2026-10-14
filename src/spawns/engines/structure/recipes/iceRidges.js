// Recipe 'iceRidges': pressure ridges on a frozen lake (preset 91). Where the ice sheets of a frozen
// lake shove into each other they buckle up into long, jagged walls of tilted ice slabs. The recipe
// reads the site's ice body (params.site.waters[water]: its level and the basin that clips it) and
// lays `ridges` ridges across the ice: each a gently wandering line of slabs tilted this way and that
// about the ridge line, ice-white to deep blue, set only where the body has ice (inside its outline,
// over ground below its level). Every stretch of a ridge is a solid capsule collider (craft strike
// them, never pass through); the flat ice between them is the water query's solid ice, so craft land
// and skid on it. The cracks running away from the ridges are the ice material's own (waterMaterial.js).
// Without a site (a debug spawn on dry land) the ridges lie on the ground around the anchor.
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localCapsule } from '../colliders.js';
import { waterOutlineContains } from '../../../../world/waters.js';

export const ICE_RIDGES_DEFAULTS = Object.freeze({
  water: 0,
  ridges: [3, 5],
  length: [160, 340],
  height: [1.2, 3.4],
  slab: [2.4, 5.5],
  wander: 18,
  colors: Object.freeze([0xe6f2f8, 0xc4dceb, 0x9fc4da]),
  spread: 220,
  approach: 1500,
});

/** Slabs stand this far apart along a ridge, as a share of their size (they overlap into a wall). */
const SLAB_SPACING = 0.62;
/** A ridge's collider capsules cover at most this many metres each. */
const COLLIDER_STRETCH = 26;
/** Ice must lie at least this far (m) above the basin floor where a slab stands (no slab on the shore). */
const ICE_MARGIN = 0.4;
/** A ridge tries this many seeded starting points before it gives up on a lake too small for it. */
const START_TRIES = 24;

export function buildIceRidges(context, read) {
  const { rng, body, out, anchor } = context;
  const waterIndex = Math.round(read.number('water', ICE_RIDGES_DEFAULTS.water, 0, 16));
  const ridgeRange = read.range('ridges', ICE_RIDGES_DEFAULTS.ridges, 1, 12);
  const lengthRange = read.range('length', ICE_RIDGES_DEFAULTS.length, 20, 2000);
  const heightRange = read.range('height', ICE_RIDGES_DEFAULTS.height, 0.3, 12);
  const slabRange = read.range('slab', ICE_RIDGES_DEFAULTS.slab, 0.5, 20);
  const wander = read.number('wander', ICE_RIDGES_DEFAULTS.wander, 0, 90);
  const spread = read.number('spread', ICE_RIDGES_DEFAULTS.spread, 10, 3000);
  const colors = read.array('colors', ICE_RIDGES_DEFAULTS.colors);
  if (colors.length === 0 || !colors.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff)) read.fail('colors', 'must be a non-empty array of 0xRRGGBB colours');
  const paints = colors.map((color) => paint(color));
  // The voice's approach reach (the ice sings louder as you close in).
  out.approach = read.number('approach', ICE_RIDGES_DEFAULTS.approach, 50, 20000);

  // The ice body (world space) and its level in the local frame; a debug spawn has none.
  const site = context.site;
  const body0 = site && Array.isArray(site.waters) ? site.waters[waterIndex] ?? null : null;
  if (site && Array.isArray(site.waters) && site.waters.length > 0 && !body0) read.fail('water', `names water body ${waterIndex}, but the site has ${site.waters.length}`);
  const level = body0 ? body0.level - anchor.y : null;
  const reach = body0 && body0.basin && Number.isFinite(body0.basin.radius) ? body0.basin.radius : spread;
  /** Whether a slab may stand at local (x, z), and the local height of its foot there. */
  const footAt = (x, z) => {
    if (!body0) return context.ground(x, z);
    if (!waterOutlineContains(body0, anchor.x + x, anchor.z + z)) return null;
    return context.ground(x, z) < level - ICE_MARGIN ? level : null;
  };

  const ridgeCount = rollInteger(ridgeRange, rng);
  let slabs = 0;
  for (let ridge = 0; ridge < ridgeCount; ridge++) {
    // A start on the ice, and a heading; the ridge walks from there, wandering a little.
    let startX = 0;
    let startZ = 0;
    let found = false;
    for (let attempt = 0; attempt < START_TRIES && !found; attempt++) {
      const angle = rng() * Math.PI * 2;
      const distance = Math.sqrt(rng()) * reach * 0.8;
      startX = Math.sin(angle) * distance;
      startZ = -Math.cos(angle) * distance;
      found = footAt(startX, startZ) !== null;
    }
    if (!found) continue;
    const heading = rng() * Math.PI * 2;
    const length = roll(lengthRange, rng);
    const ridgeHeight = roll(heightRange, rng);
    // Walk both ways from the start, so a ridge crosses the lake rather than starting at its edge.
    for (const direction of [1, -1]) {
      let x = startX;
      let z = startZ;
      let walkHeading = direction > 0 ? heading : heading + Math.PI;
      let travelled = 0;
      let stretchStart = null;
      let stretchEnd = null;
      let stretchTravel = 0;
      const closeStretch = () => {
        if (stretchStart && stretchEnd) {
          const radius = ridgeHeight * 0.55;
          out.colliders.push(localCapsule('iceRidge', stretchStart[0], stretchStart[1] + radius * 0.5, stretchStart[2], stretchEnd[0], stretchEnd[1] + radius * 0.5, stretchEnd[2], radius, { surface: 'ice' }));
        }
        stretchStart = null;
        stretchEnd = null;
        stretchTravel = 0;
      };
      while (travelled < length * 0.5) {
        const size = roll(slabRange, rng);
        const step = size * SLAB_SPACING;
        const foot = footAt(x, z);
        if (foot === null) {
          closeStretch();
        } else {
          addSlab(body, x, foot, z, walkHeading, size, ridgeHeight * (0.55 + 0.6 * rng()), paints[Math.floor(rng() * paints.length)], rng);
          slabs++;
          if (!stretchStart) stretchStart = [x, foot, z];
          stretchEnd = [x, foot, z];
          stretchTravel += step;
          if (stretchTravel >= COLLIDER_STRETCH) {
            closeStretch();
            stretchStart = [x, foot, z];
          }
        }
        walkHeading += (rng() - 0.5) * 2 * wander * (Math.PI / 180) * (step / 40);
        x += Math.sin(walkHeading) * step;
        z -= Math.cos(walkHeading) * step;
        travelled += step;
      }
      closeStretch();
    }
  }
  body.resetTransform();
  if (slabs === 0 && body0) read.fail('water', 'holds no ice for a ridge (the lake is too small or not frozen over)');
  out.audioPoint = [0, (level ?? context.ground(0, 0)) + 2, 0];
  out.radius = Math.max(out.radius, reach);
}

/**
 * One ice slab at local (x, footY, z): a thin block size metres long and height tall, stood up along
 * the ridge (heading, radians compass) and leaning over to one side or the other, sunk a little into
 * the ice; its top face is a shade lighter (rime) than its sides.
 */
function addSlab(builder, x, footY, z, heading, size, height, slabPaint, rng) {
  const lean = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.6);
  const twist = (rng() - 0.5) * 0.5;
  const thickness = 0.35 + rng() * 0.5;
  builder.setTransform(x, footY - height * 0.25, z, heading + twist, 0, lean);
  builder.setPaint(slabPaint).box(0, height * 0.5, 0, thickness, height, size);
  builder.setPaint(shade(slabPaint, 1.12)).box(0, height + 0.05, 0, thickness * 1.02, 0.1, size * 0.96);
}
