// Recipe 'islands': floating rock islands. Each is a lobed grassy top (a gentle dome) over a jagged
// inverted-cone rock body in strata, with trees kept off a clear meadow (the landing ground), a few
// boulders, roots hanging from the rim, and waterfalls that pour off the edge in fading ribbons into
// soft mist. Island tops are landable: the engine registers each top as an extra ground surface with
// exactly the height function the mesh is built from (islandTopHeight over islandOutline).
// Over the site's islandBase stamps (sea-stack islets) the first islands float above the islets;
// the rest spread around the site.
import { PALETTE } from '../palette.js';
import { addBoulder, addPine, addRoundTree, pick, stampsOfType } from '../common.js';
import { mixPaint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';

export const ISLANDS_DEFAULTS = Object.freeze({
  count: [3, 4],
  radius: [70, 150],
  altitude: [220, 420],
  spread: 520,
  thickness: [0.9, 1.3],
  dome: 3.5,
  treeDensity: 0.55,
  meadow: 0.3,
  waterfalls: [1, 2],
  fall: 0.75,
  roots: 14,
  mist: true,
  landable: true,
});

/** Top ring fractions of the outline radius (the last is the rim bevel). */
const TOP_RINGS = Object.freeze([0, 0.3, 0.55, 0.75, 0.88, 0.96, 1]);
const TOP_SIDES = 32;
const RIM_BEVEL = 1.2;
const DOME_EDGE = 0.96;

/** The island's outline radius (m) at a compass angle (radians): three lobes over the base radius. */
export function islandOutline(angle, radius, phaseA, phaseB, phaseC) {
  return radius * (1 + 0.1 * Math.sin(3 * angle + phaseA) + 0.06 * Math.sin(5 * angle + phaseB) + 0.03 * Math.sin(9 * angle + phaseC));
}

/** Height above the island's top level at a radial share f (0 centre, 1 rim) of its outline. */
export function islandTopHeight(share, dome) {
  if (share <= DOME_EDGE) return dome * (1 - share * share);
  const edge = dome * (1 - DOME_EDGE * DOME_EDGE);
  return edge + (-RIM_BEVEL - edge) * ((share - DOME_EDGE) / (1 - DOME_EDGE));
}

export function buildIslands(context, read) {
  const { rng, out } = context;
  const count = rollInteger(read.range('count', ISLANDS_DEFAULTS.count, 1, 8), rng);
  const radiusRange = read.range('radius', ISLANDS_DEFAULTS.radius, 15, 400);
  const altitudeRange = read.range('altitude', ISLANDS_DEFAULTS.altitude, 30, 3000);
  const spread = read.number('spread', ISLANDS_DEFAULTS.spread, 0, 5000);
  const thicknessRange = read.range('thickness', ISLANDS_DEFAULTS.thickness, 0.3, 3);
  const dome = read.number('dome', ISLANDS_DEFAULTS.dome, 0, 20);
  const treeDensity = read.number('treeDensity', ISLANDS_DEFAULTS.treeDensity, 0, 2);
  const meadow = read.number('meadow', ISLANDS_DEFAULTS.meadow, 0, 0.9);
  const waterfallRange = read.range('waterfalls', ISLANDS_DEFAULTS.waterfalls, 0, 4);
  const fallShare = read.number('fall', ISLANDS_DEFAULTS.fall, 0.1, 1);
  const roots = read.integer('roots', ISLANDS_DEFAULTS.roots, 0, 60);
  const mist = read.boolean('mist', ISLANDS_DEFAULTS.mist);
  const landable = read.boolean('landable', ISLANDS_DEFAULTS.landable);
  const islets = stampsOfType(context.site, 'islandBase');

  // Centres: over the islets first, then around the site, keeping the islands apart.
  const islands = [];
  for (let index = 0; index < count; index++) {
    const radius = index === 0 ? radiusRange[1] - (radiusRange[1] - radiusRange[0]) * rng() * 0.3 : roll(radiusRange, rng);
    let x = 0;
    let z = 0;
    let baseY;
    if (index < islets.length) {
      x = islets[index].x - context.anchor.x;
      z = islets[index].z - context.anchor.z;
      baseY = islets[index].topY - context.anchor.y;
    } else {
      for (let attempt = 0; attempt < 24; attempt++) {
        const angle = index * 2.39996 + rng() * 1.2;
        const distance = index === 0 ? 0 : spread * (0.45 + 0.55 * rng());
        x = Math.sin(angle) * distance;
        z = -Math.cos(angle) * distance;
        const clear = islands.every((other) => Math.hypot(other.x - x, other.z - z) > (other.radius + radius) * 1.25);
        if (clear) break;
      }
      baseY = Math.max(context.ground(x, z), context.waterLevel);
    }
    const topY = baseY + roll(altitudeRange, rng);
    islands.push({
      x, z, radius, topY,
      depth: radius * roll(thicknessRange, rng),
      phaseA: rng() * 6.283, phaseB: rng() * 6.283, phaseC: rng() * 6.283,
      meadowAngle: rng() * 6.283,
    });
  }

  let extent = 0;
  for (let index = 0; index < islands.length; index++) {
    const island = islands[index];
    const falls = index === 0 ? Math.max(Math.min(1, waterfallRange[1]), rollInteger(waterfallRange, rng)) : rollInteger(waterfallRange, rng);
    buildIsland(context, island, { dome, treeDensity, meadow, falls, fallShare, roots, mist });
    if (landable) {
      out.surfaces.push({
        x: island.x, z: island.z, topY: island.topY, radius: island.radius, dome,
        phaseA: island.phaseA, phaseB: island.phaseB, phaseC: island.phaseC,
      });
    }
    extent = Math.max(extent, Math.hypot(island.x, island.z) + island.radius * 1.2);
  }
  out.radius = Math.max(out.radius, extent);
  if (!out.audioPoint) out.audioPoint = [islands[0].x, islands[0].topY - islands[0].depth * 0.5, islands[0].z];
}

function inMeadow(angle, island, meadow) {
  const difference = Math.abs(((angle - island.meadowAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return difference < meadow * Math.PI;
}

function buildIsland(context, island, options) {
  const { rng, body, detail, water, out } = context;
  const { x, z, radius, topY, depth } = island;
  const outline = (angle) => islandOutline(angle, radius, island.phaseA, island.phaseB, island.phaseC);
  const topPoint = (share, side) => {
    const angle = (side / TOP_SIDES) * Math.PI * 2;
    const reach = outline(angle) * share;
    return [x + Math.sin(angle) * reach, topY + islandTopHeight(share, options.dome), z - Math.cos(angle) * reach];
  };

  // Grassy top: a fan in the middle and rings out to the rim bevel, facing up.
  for (let ring = 0; ring < TOP_RINGS.length - 1; ring++) {
    for (let side = 0; side < TOP_SIDES; side++) {
      const next = (side + 1) % TOP_SIDES;
      const rim = ring === TOP_RINGS.length - 2;
      const grass = rim ? pick(PALETTE.rock, rng) : mixPaint(pick(PALETTE.grass, rng), PALETTE.grassDry, rng() * 0.25);
      body.setPaint(grass);
      const inner = TOP_RINGS[ring];
      const outer = TOP_RINGS[ring + 1];
      if (ring === 0) {
        const centre = topPoint(0, 0);
        const b = topPoint(outer, next);
        const c = topPoint(outer, side);
        body.triangle(centre[0], centre[1], centre[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      } else {
        body.quad(topPoint(inner, side), topPoint(inner, next), topPoint(outer, next), topPoint(outer, side));
      }
    }
  }

  // Rock body: jagged rings from the rim down to a hanging tip, in strata.
  const underRings = [[1, -RIM_BEVEL], [0.97, -0.12], [0.84, -0.3], [0.64, -0.52], [0.4, -0.74], [0.16, -0.93]];
  const jag = (ring, side) => (ring === 0 ? 1 : 0.86 + 0.28 * hash(side * 13 + ring * 71 + Math.floor(island.phaseA * 1000)));
  const ringPoint = (ring, side) => {
    const [share, drop] = underRings[ring];
    const angle = (side / TOP_SIDES) * Math.PI * 2;
    const reach = outline(angle) * share * jag(ring, side);
    const y = ring === 0 ? topY + drop : topY + drop * depth;
    return [x + Math.sin(angle) * reach, y, z - Math.cos(angle) * reach];
  };
  for (let ring = 0; ring < underRings.length - 1; ring++) {
    const strata = ring % 2 === 0 ? PALETTE.rock[ring % PALETTE.rock.length] : PALETTE.rock[(ring + 2) % PALETTE.rock.length];
    const deep = mixPaint(strata, PALETTE.rockDeep, ring / underRings.length);
    for (let side = 0; side < TOP_SIDES; side++) {
      const next = (side + 1) % TOP_SIDES;
      body.setPaint(rng() < 0.15 ? shade(deep, 0.85) : deep);
      // Rings run from the rim downward: upper (ring) -> lower (ring + 1), facing out and down.
      body.quad(ringPoint(ring, side), ringPoint(ring, next), ringPoint(ring + 1, next), ringPoint(ring + 1, side));
    }
  }
  const tipY = topY - depth;
  const last = underRings.length - 1;
  for (let side = 0; side < TOP_SIDES; side++) {
    const next = (side + 1) % TOP_SIDES;
    const a = ringPoint(last, side);
    const b = ringPoint(last, next);
    body.setPaint(PALETTE.rockDeep).triangle(a[0], a[1], a[2], b[0], b[1], b[2], x, tipY, z);
  }

  // Trees off the meadow, boulders near the rim, roots under the rim.
  const trees = Math.min(48, Math.round(options.treeDensity * Math.PI * radius * radius / 380));
  const treeScale = Math.pow(radius / 100, 0.3);
  for (let tree = 0; tree < trees; tree++) {
    const angle = rng() * Math.PI * 2;
    if (inMeadow(angle, island, options.meadow)) continue;
    const share = Math.sqrt(rng()) * 0.84;
    const reach = outline(angle) * share;
    const px = x + Math.sin(angle) * reach;
    const pz = z - Math.cos(angle) * reach;
    const py = topY + islandTopHeight(share, options.dome);
    const height = (6 + rng() * 7) * treeScale;
    if (rng() < 0.6) addPine(body, px, py, pz, height, rng);
    else addRoundTree(body, px, py, pz, height * 0.85, rng);
  }
  for (let boulder = 0; boulder < 3; boulder++) {
    const angle = rng() * Math.PI * 2;
    const reach = outline(angle) * (0.7 + rng() * 0.2);
    addBoulder(detail, x + Math.sin(angle) * reach, topY + islandTopHeight(0.8, options.dome), z - Math.cos(angle) * reach, 1.5 + rng() * 2.5, rng);
  }
  for (let root = 0; root < options.roots; root++) {
    const side = Math.floor(rng() * TOP_SIDES);
    const start = ringPoint(1, side);
    const length = 5 + rng() * 16;
    detail.setSway(0.2).setPaint(PALETTE.trunk).beam(start[0], start[1] + 1, start[2], start[0] + (rng() - 0.5) * 3, start[1] - length, start[2] + (rng() - 0.5) * 3, 0.35, 0.35);
    detail.setSway(0);
  }

  // Waterfalls: a stream across the top to a lip on the rim, then a widening ribbon that falls
  // outward and fades into mist.
  for (let fall = 0; fall < options.falls; fall++) {
    let angle = rng() * Math.PI * 2;
    for (let attempt = 0; attempt < 8 && inMeadow(angle, island, options.meadow); attempt++) angle = rng() * Math.PI * 2;
    const outX = Math.sin(angle);
    const outZ = -Math.cos(angle);
    const sideX = -outZ;
    const sideZ = outX;
    const rimReach = outline(angle);
    const width = 6 + radius * 0.06 + rng() * 4;
    // Stream on the top.
    const streamPaint = [0.42, 0.62, 0.74, 0.85];
    for (let step = 0; step < 6; step++) {
      const s0 = 0.4 + (step / 6) * 0.58;
      const s1 = 0.4 + ((step + 1) / 6) * 0.58;
      const w0 = width * (0.35 + s0 * 0.4);
      const w1 = width * (0.35 + s1 * 0.4);
      const p0 = [x + outX * rimReach * s0, topY + islandTopHeight(s0, options.dome) + 0.12, z + outZ * rimReach * s0];
      const p1 = [x + outX * rimReach * s1, topY + islandTopHeight(Math.min(s1, 0.97), options.dome) + 0.12, z + outZ * rimReach * s1];
      water.vertexQuad(
        { p: [p0[0] - sideX * w0 * 0.5, p0[1], p0[2] - sideZ * w0 * 0.5], uv: [0, -s0 * 2], paint: streamPaint },
        { p: [p0[0] + sideX * w0 * 0.5, p0[1], p0[2] + sideZ * w0 * 0.5], uv: [1, -s0 * 2], paint: streamPaint },
        { p: [p1[0] + sideX * w1 * 0.5, p1[1], p1[2] + sideZ * w1 * 0.5], uv: [1, -s1 * 2], paint: streamPaint },
        { p: [p1[0] - sideX * w1 * 0.5, p1[1], p1[2] - sideZ * w1 * 0.5], uv: [0, -s1 * 2], paint: streamPaint },
      );
    }
    const lipX = x + outX * rimReach;
    const lipZ = z + outZ * rimReach;
    const lipY = topY - RIM_BEVEL + 0.2;
    // The fall fades into mist well above whatever lies below the lip (sea or land).
    const fallLength = Math.min((topY - context.ground(lipX + outX * 20, lipZ + outZ * 20)) * options.fallShare, 420);
    const segments = 16;
    const ribbonPoint = (t, side) => {
      const drop = fallLength * t;
      const outward = 1.2 + 10 * Math.sqrt(t) + 6 * t;
      const spread = width * (1 + 0.9 * t) * 0.5 * side;
      return [lipX + outX * outward + sideX * spread, lipY - drop, lipZ + outZ * outward + sideZ * spread];
    };
    for (let segment = 0; segment < segments; segment++) {
      const t0 = segment / segments;
      const t1 = (segment + 1) / segments;
      // Colour alpha is the ribbon's opacity: full at the lip, gone where it turns to mist.
      const paint0 = [0.8, 0.9, 0.96, Math.pow(1 - t0, 1.3)];
      const paint1 = [0.8, 0.9, 0.96, Math.pow(1 - t1, 1.3)];
      const v0 = (fallLength * t0) / 30;
      const v1 = (fallLength * t1) / 30;
      water.vertexQuad(
        { p: ribbonPoint(t0, -1), uv: [0, v0], paint: paint0 },
        { p: ribbonPoint(t1, -1), uv: [0, v1], paint: paint1 },
        { p: ribbonPoint(t1, 1), uv: [1, v1], paint: paint1 },
        { p: ribbonPoint(t0, 1), uv: [1, v0], paint: paint0 },
      );
    }
    if (options.mist) {
      const puffs = 6;
      for (let puff = 0; puff < puffs; puff++) {
        const t = 0.45 + (puff / puffs) * 0.55;
        const centre = ribbonPoint(t, (rng() - 0.5) * 1.6);
        out.puffs.push({ x: centre[0] + (rng() - 0.5) * width, y: centre[1], z: centre[2] + (rng() - 0.5) * width, radius: width * (0.9 + t * 2.4) + rng() * 6, brightness: 0.85 + rng() * 0.15 });
      }
      out.puffs.push({ x: lipX + outX * 3, y: lipY - 4, z: lipZ + outZ * 3, radius: width * 0.8, brightness: 1 });
    }
    if (!out.audioPoint) out.audioPoint = ribbonPoint(0.3, 0);
  }
  if (options.mist) {
    // A haze of cloud clinging under the island.
    for (let puff = 0; puff < 3; puff++) {
      const angle = rng() * Math.PI * 2;
      const reach = radius * (0.2 + rng() * 0.4);
      out.puffs.push({ x: x + Math.sin(angle) * reach, y: topY - depth * (0.55 + rng() * 0.35), z: z - Math.cos(angle) * reach, radius: radius * (0.35 + rng() * 0.2), brightness: 0.9 });
    }
  }
}

/** A deterministic hash in [0, 1) of an integer (vertex jag). */
function hash(value) {
  let h = Math.imul(value | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
