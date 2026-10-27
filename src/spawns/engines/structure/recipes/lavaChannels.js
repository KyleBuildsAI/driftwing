// Recipe 'lavaChannels': molten lava running down the site's carve stamps (the lava channels of preset
// 36, the crack of preset 37's fissure). Each carve stamp gets a lava ribbon on its channel floor
// (the lava material: dark crust plates drifting downstream over glowing cracks, hottest mid-flow),
// traced by lavaPath.js; with toSea the flow runs on from the channel's exit down the real ground,
// fanning out, until it meets the sea, where it spreads a little way over the water and cools (the
// emitter's `seaEntry` puts the steam explosions at that same point). Cooled basalt blocks lie along
// the levees and slabs of crust stand at the sea entry; the larger blocks are solid colliders.
// Without a carve stamp (a debug spawn) a stand-in channel starts at the anchor along the heading.
import { paint, shade } from '../meshBuilder.js';
import { addBoulder } from '../common.js';
import { localSphere } from '../colliders.js';
import { lavaSourceStamps, traceLavaPath } from '../../lavaPath.js';

export const LAVA_CHANNELS_DEFAULTS = Object.freeze({
  toSea: true,
  reach: 2500,
  width: 0.8,
  spread: 1.6,
  crust: 0x2b2522,
  blocks: 12,
  blockSize: [1.5, 4],
});

/** The ribbon sits this far (m) over the channel floor (and the sea, where it runs onto it). */
const LAVA_LIFT = 0.35;
/** Blocks at least this radius (m) are solid colliders; smaller ones the craft brushes past. */
const SOLID_BLOCK = 2.2;
const BASALT = Object.freeze([paint(0x3b3633), paint(0x332e2b), paint(0x463f3a)]);

export function buildLavaChannels(context, read) {
  const { rng, lava, body, out, anchor } = context;
  const toSea = read.boolean('toSea', LAVA_CHANNELS_DEFAULTS.toSea);
  const reach = read.number('reach', LAVA_CHANNELS_DEFAULTS.reach, 0, 8000);
  const widthShare = read.number('width', LAVA_CHANNELS_DEFAULTS.width, 0.2, 1.5);
  const spread = read.number('spread', LAVA_CHANNELS_DEFAULTS.spread, 1, 4);
  const crust = paint(read.color('crust', LAVA_CHANNELS_DEFAULTS.crust));
  const blocksPerKm = read.number('blocks', LAVA_CHANNELS_DEFAULTS.blocks, 0, 80);
  const blockSize = read.range('blockSize', LAVA_CHANNELS_DEFAULTS.blockSize, 0.3, 12);
  const waterLevel = context.waterLevel + anchor.y;
  const groundAt = (x, z) => context.groundAt(x, z);
  const stamps = lavaSourceStamps(context.site, anchor.x, anchor.z, context.heading);
  let extent = 20;
  const entries = [];
  for (const stamp of stamps) {
    const traced = traceLavaPath(stamp, groundAt, waterLevel, { toSea, reach, spread });
    const points = traced.points;
    // Ribbon: per point, the centre's left and right edges draped on the ground (or the water).
    let along = 0;
    let previous = null;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      const next = points[Math.min(points.length - 1, index + 1)];
      const back = points[Math.max(0, index - 1)];
      let dirX = next.x - back.x;
      let dirZ = next.z - back.z;
      const length = Math.hypot(dirX, dirZ) || 1;
      dirX /= length;
      dirZ /= length;
      if (index > 0) along += Math.hypot(point.x - points[index - 1].x, point.z - points[index - 1].z);
      const half = point.halfWidth * widthShare;
      // The compass right of the flow: (-dirZ, dirX).
      const rightX = -dirZ * half;
      const rightZ = dirX * half;
      const localX = point.x - anchor.x;
      const localZ = point.z - anchor.z;
      // Heat: full in the channel; cooling a little on the open ground, and on the water at the end.
      const onWater = traced.entry !== null && index >= points.length - 1;
      const heat = point.carved ? 1 : onWater ? 0.45 : 0.85;
      const vertexPaint = [crust[0], crust[1], crust[2], heat];
      const left = [localX - rightX, context.ground(localX - rightX, localZ - rightZ) + LAVA_LIFT, localZ - rightZ];
      const right = [localX + rightX, context.ground(localX + rightX, localZ + rightZ) + LAVA_LIFT, localZ + rightZ];
      // The ribbon never dips under its own centre (the channel's floor is its lowest line).
      const centre = context.ground(localX, localZ) + LAVA_LIFT;
      left[1] = Math.max(Math.min(left[1], centre + half * 0.15), centre);
      right[1] = Math.max(Math.min(right[1], centre + half * 0.15), centre);
      const record = { left, right, along, paint: vertexPaint };
      if (previous) {
        lava.vertexQuad(
          { p: previous.right, uv: [1, previous.along], paint: previous.paint },
          { p: record.right, uv: [1, record.along], paint: record.paint },
          { p: record.left, uv: [0, record.along], paint: record.paint },
          { p: previous.left, uv: [0, previous.along], paint: previous.paint },
        );
      }
      previous = record;
      extent = Math.max(extent, Math.hypot(localX, localZ) + half);
    }
    // Cooled basalt blocks along the levees (seeded positions along the path, either side).
    const pathLength = along;
    const blocks = Math.round((blocksPerKm * pathLength) / 1000);
    out.facts.lavaLength = Math.round((out.facts.lavaLength ?? 0) + pathLength);
    for (let block = 0; block < blocks; block++) {
      const index = Math.min(points.length - 2, Math.floor(rng() * (points.length - 1)));
      const point = points[index];
      const next = points[index + 1];
      const dirLength = Math.hypot(next.x - point.x, next.z - point.z) || 1;
      const side = rng() < 0.5 ? -1 : 1;
      const offset = point.halfWidth * (1.15 + rng() * 0.9) * side;
      const x = point.x - anchor.x + (-(next.z - point.z) / dirLength) * offset;
      const z = point.z - anchor.z + ((next.x - point.x) / dirLength) * offset;
      const radius = blockSize[0] + (blockSize[1] - blockSize[0]) * rng() * rng();
      const y = context.ground(x, z);
      addBoulder(body, x, y, z, radius, rng, BASALT[block % BASALT.length]);
      if (radius >= SOLID_BLOCK) out.colliders.push(localSphere('block', x, y + radius * 0.3, z, radius * 1.05, { surface: 'stone' }));
    }
    if (traced.entry) entries.push(traced.entry);
  }
  // Slabs of fresh crust tilted up where the flow meets the sea.
  for (const entry of entries) {
    for (let slab = 0; slab < 5; slab++) {
      const angle = rng() * Math.PI * 2;
      const distance = 8 + rng() * 26;
      const x = entry.x - anchor.x + Math.sin(angle) * distance;
      const z = entry.z - anchor.z - Math.cos(angle) * distance;
      const y = context.ground(x, z);
      const size = 2 + rng() * 3;
      body.setTransform(x, y, z, rng() * Math.PI * 2, 0.35 + rng() * 0.4, 0);
      body.setPaint(shade(BASALT[slab % BASALT.length], 0.8)).box(0, size * 0.2, 0, size * 1.6, size * 0.5, size);
      body.resetTransform();
    }
  }
  out.facts.lavaFlows = stamps.length;
  out.facts.seaEntries = entries.length;
  const audio = entries.length > 0 ? entries[0] : { x: anchor.x, z: anchor.z };
  out.audioPoint = [audio.x - anchor.x, context.ground(audio.x - anchor.x, audio.z - anchor.z) + 8, audio.z - anchor.z];
  out.radius = Math.max(out.radius, extent);
}
