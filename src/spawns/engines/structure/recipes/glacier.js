// Recipe 'glacier': a tidewater glacier where snow meets the sea (preset 41). An ice tongue flows down
// the site's heading (a preset aligns its sites downhill, to the sea) to an ice cliff standing in the
// water: snow-white on top, crevassed, dirty with moraine along its edges, its front banded from white
// to deep blue. Slabs along the front are movers (structure/movers.js): one at a time they crack,
// topple into the sea with a splash and a ring wave spreading across the water, float away as bergs,
// melt and slide back out of the face. A field of icebergs drifts in the water before the front, each
// a mover with its own collider hull, keeping to water deep enough for it. The tongue's top is a
// landable heightfield (a perch at its highest point); the front cliff is a row of solid boxes.
//
// Free-standing (a debug spawn away from the sea) the front stands where the heading meets water within
// `reach`, else halfway down the tongue, and bergs only drift where the sea is deep enough.
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBoxAxes, localHeightfield } from '../colliders.js';
import { createNavigationGrid } from '../movers.js';

export const GLACIER_DEFAULTS = Object.freeze({
  length: [1400, 1900],
  width: [380, 540],
  frontHeight: [34, 48],
  thickness: [28, 44],
  slope: 0.04,
  reach: 2600,
  slabs: [3, 5],
  slabDepth: [12, 18],
  bergs: [6, 9],
  bergSize: [10, 30],
  bergSpread: 900,
  bergSpeed: [0.35, 1],
  interval: [40, 80],
  first: [8, 18],
  wave: Object.freeze({ height: 2.6, width: 16, speed: 9, travel: 900 }),
});

const ICE = Object.freeze({
  snow: Object.freeze([paint(0xf4f8fb), paint(0xeaf2f8), paint(0xfafcfd)]),
  crevasse: paint(0x8fc3e3),
  moraine: Object.freeze([paint(0x6c6e72), paint(0x5a5c60)]),
  faceTop: paint(0xe6f2f9),
  faceMid: paint(0xa9d3ec),
  faceDeep: paint(0x5ea7d5),
  bergTop: paint(0xf2f7fb),
  bergSide: paint(0xb4daf0),
  bergBelow: paint(0x4f97c4),
});
/** The tongue's grid: segments along its length and across its width. */
const ALONG_SEGMENTS = 28;
const ACROSS_SEGMENTS = 12;
/** The heightfield's cell size (m) over the tongue. */
const FIELD_CELL = 12;
/** The navigable grid's cell (m) over the berg field. */
const NAVIGATION_CELL = 40;

export function buildGlacier(context, read) {
  const { rng, body, detail, out } = context;
  const lengthRange = read.range('length', GLACIER_DEFAULTS.length, 300, 6000);
  const widthRange = read.range('width', GLACIER_DEFAULTS.width, 80, 2000);
  const frontRange = read.range('frontHeight', GLACIER_DEFAULTS.frontHeight, 5, 150);
  const thicknessRange = read.range('thickness', GLACIER_DEFAULTS.thickness, 5, 200);
  const slope = read.number('slope', GLACIER_DEFAULTS.slope, 0, 0.3);
  const reach = read.number('reach', GLACIER_DEFAULTS.reach, 200, 10000);
  const slabCount = rollInteger(read.range('slabs', GLACIER_DEFAULTS.slabs, 0, 8), rng);
  const slabDepth = roll(read.range('slabDepth', GLACIER_DEFAULTS.slabDepth, 4, 60), rng);
  const bergCount = rollInteger(read.range('bergs', GLACIER_DEFAULTS.bergs, 0, 16), rng);
  const bergSize = read.range('bergSize', GLACIER_DEFAULTS.bergSize, 3, 120);
  const bergSpread = read.number('bergSpread', GLACIER_DEFAULTS.bergSpread, 100, 5000);
  const bergSpeed = read.range('bergSpeed', GLACIER_DEFAULTS.bergSpeed, 0, 5);
  const interval = read.range('interval', GLACIER_DEFAULTS.interval, 5, 3600);
  const first = read.range('first', GLACIER_DEFAULTS.first, 0, 3600);
  const waveRead = read.nested('wave');
  const wave = {
    height: waveRead.number('height', GLACIER_DEFAULTS.wave.height, 0, 20),
    width: waveRead.number('width', GLACIER_DEFAULTS.wave.width, 2, 200),
    speed: waveRead.number('speed', GLACIER_DEFAULTS.wave.speed, 1, 40),
    travel: waveRead.number('travel', GLACIER_DEFAULTS.wave.travel, 50, 5000),
  };
  const length = roll(lengthRange, rng);
  const width = roll(widthRange, rng);
  const frontHeight = roll(frontRange, rng);
  const thickness = roll(thicknessRange, rng);
  const sea = context.waterLevel;
  const anchor = context.anchor;
  const heading = context.heading * (Math.PI / 180);
  const forwardX = Math.sin(heading);
  const forwardZ = -Math.cos(heading);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const rawGround = (x, z) => context.worldGround(anchor.x + x, anchor.z + z) - anchor.y;

  // The front: where the heading first meets water deeper than 1.5 m (else halfway down the tongue).
  let front = length * 0.5;
  for (let along = -200; along <= reach; along += 20) {
    if (rawGround(forwardX * along, forwardZ * along) < sea - 1.5) {
      front = along;
      break;
    }
  }
  const start = front - length;
  const frontTop = sea + frontHeight;
  const halfWidthAt = (along) => (width / 2) * (0.6 + 0.4 * Math.min(1, Math.max(0, (along - start) / length)));
  const toLocal = (along, across) => [forwardX * along + rightX * across, forwardZ * along + rightZ * across];

  // The tongue's top on its grid (one ground sample per vertex): the higher of the ice surface rising
  // inland from the front and the ground under it plus the ice thickness, crevassed in bands, sinking to
  // its moraines at the edges.
  const columns = ACROSS_SEGMENTS + 1;
  const rows = ALONG_SEGMENTS + 1;
  const tops = new Float64Array(rows * columns);
  const grounds = new Float64Array(rows * columns);
  const bodyFront = front - (slabCount > 0 ? slabDepth : 0);
  const alongOf = (row) => start + ((bodyFront - start) * row) / ALONG_SEGMENTS;
  for (let row = 0; row < rows; row++) {
    const along = alongOf(row);
    const halfWidth = halfWidthAt(along);
    for (let column = 0; column < columns; column++) {
      const share = (column / ACROSS_SEGMENTS) * 2 - 1;
      const across = share * halfWidth;
      const [x, z] = toLocal(along, across);
      const ground = Math.max(rawGround(x, z), sea);
      const surface = frontTop + (bodyFront - along) * slope;
      const crevasse = Math.max(0, Math.sin(along * 0.09 + share * 2.1 + rng() * 0.6)) * 2.2 * (1 - Math.abs(share));
      const edge = Math.abs(share) > 0.82 ? (Math.abs(share) - 0.82) / 0.18 : 0;
      const top = Math.max(surface, ground + thickness) - crevasse;
      grounds[row * columns + column] = ground;
      tops[row * columns + column] = top + (ground + 2 - top) * edge * edge;
    }
  }
  const vertex = (row, column) => {
    const along = alongOf(row);
    const across = ((column / ACROSS_SEGMENTS) * 2 - 1) * halfWidthAt(along);
    const [x, z] = toLocal(along, across);
    return [x, tops[row * columns + column], z];
  };

  // The top, with crevasse shading and moraine stripes, then the side skirts down into the ground.
  for (let row = 0; row < ALONG_SEGMENTS; row++) {
    for (let column = 0; column < ACROSS_SEGMENTS; column++) {
      const share = Math.abs(((column + 0.5) / ACROSS_SEGMENTS) * 2 - 1);
      let colour = ICE.snow[(row + column) % 3];
      if (share > 0.8) colour = ICE.moraine[(row + column) % 2];
      else if (share > 0.62 && (row % 5 === 2)) colour = ICE.moraine[0];
      else if ((row * 7 + column * 3) % 11 === 0) colour = ICE.crevasse;
      // Counter-clockwise from above: along runs forward, across to the right.
      body.setPaint(colour).quad(vertex(row, column + 1), vertex(row + 1, column + 1), vertex(row + 1, column), vertex(row, column));
    }
  }
  for (let row = 0; row < ALONG_SEGMENTS; row++) {
    for (const column of [0, ACROSS_SEGMENTS]) {
      const a = vertex(row, column);
      const b = vertex(row + 1, column);
      const groundA = grounds[row * columns + column] - 6;
      const groundB = grounds[(row + 1) * columns + column] - 6;
      body.setPaint(ICE.moraine[1]);
      // Facing out of the tongue: left at column 0, right at the last column.
      if (column === 0) body.quad(b, [b[0], groundB, b[2]], [a[0], groundA, a[2]], a);
      else body.quad(a, [a[0], groundA, a[2]], [b[0], groundB, b[2]], b);
    }
  }
  // The body's front face (behind the slabs): banded from white at the top to deep blue at the water,
  // jagged, reaching under the sea.
  const faceBottom = sea - 18;
  // Each column edge juts in or out a little (shared by the two columns either side, so no seams open).
  const jags = Array.from({ length: ACROSS_SEGMENTS + 1 }, () => (rng() - 0.5) * 4);
  for (let column = 0; column < ACROSS_SEGMENTS; column++) {
    const a = vertex(ALONG_SEGMENTS, column);
    const b = vertex(ALONG_SEGMENTS, column + 1);
    const midA = [a[0] + forwardX * jags[column], sea + (a[1] - sea) * 0.45, a[2] + forwardZ * jags[column]];
    const midB = [b[0] + forwardX * jags[column + 1], sea + (b[1] - sea) * 0.45, b[2] + forwardZ * jags[column + 1]];
    // Facing out to sea (b lies to the right of a).
    body.setPaint(ICE.faceTop).quad(b, midB, midA, a);
    body.setPaint(ICE.faceMid).quad(midB, [midB[0], sea, midB[2]], [midA[0], sea, midA[2]], midA);
    body.setPaint(ICE.faceDeep).quad([midB[0], sea, midB[2]], [midB[0], faceBottom, midB[2]], [midA[0], faceBottom, midA[2]], [midA[0], sea, midA[2]]);
  }
  // The front cliff's colliders: one box per pair of columns, from under the sea to its top.
  for (let column = 0; column < ACROSS_SEGMENTS; column += 2) {
    const a = vertex(ALONG_SEGMENTS, column);
    const b = vertex(ALONG_SEGMENTS, Math.min(ACROSS_SEGMENTS, column + 2));
    const top = Math.max(a[1], b[1]);
    const half = Math.hypot(b[0] - a[0], b[2] - a[2]) / 2;
    const centre = [(a[0] + b[0]) / 2 - forwardX * 15, (top + faceBottom) / 2, (a[2] + b[2]) / 2 - forwardZ * 15];
    out.colliders.push(localBoxAxes('ice-front', centre, [rightX, 0, rightZ], [0, 1, 0], [-forwardX, 0, -forwardZ], half + 1, (top - faceBottom) / 2, 15, { surface: 'ice' }));
  }
  addTongueTop(context, { start, bodyFront, halfWidthAt, toLocal, tops, columns, forwardX, forwardZ, rightX, rightZ, sea });

  // The calving slabs along the front: movers resting flush with the face.
  if (slabCount > 0) {
    const frontHalf = halfWidthAt(front) * 0.8;
    const slabWidth = ((frontHalf * 2) / slabCount) * 0.88;
    for (let slab = 0; slab < slabCount; slab++) {
      const across = -frontHalf + ((slab + 0.5) * frontHalf * 2) / slabCount;
      const [x, z] = toLocal(front - slabDepth * 0.5, across);
      const bottom = sea - 6;
      const height = frontTop + (rng() - 0.5) * 6 - bottom;
      const builder = context.newBuilder();
      buildSlab(builder, slabWidth, slabDepth, height, rng);
      context.addMover({
        builder, x, y: bottom, z, yaw: heading, motion: 'calve',
        hull: slabHull(slabWidth, slabDepth, height),
        calve: { depth: slabDepth, height, recess: slabDepth + 2 },
      });
    }
    context.setCalving({ interval, first: roll(first, rng), wave });
  }

  // The iceberg field before the front, in water deep enough for them (the navigable grid).
  const fieldAlong = front + bergSpread * 0.55;
  const [fieldX, fieldZ] = toLocal(fieldAlong, 0);
  if (bergCount > 0) {
    const half = bergSpread + 200;
    const cells = Math.ceil((half * 2) / NAVIGATION_CELL);
    const grid = createNavigationGrid(anchor.x + fieldX - half, anchor.z + fieldZ - half, NAVIGATION_CELL, cells, cells,
      (x, z) => context.worldGround(x, z) < anchor.y + sea - 5);
    context.setNavigation(grid);
    let placed = 0;
    for (let attempt = 0; attempt < bergCount * 12 && placed < bergCount; attempt++) {
      const along = front + 60 + rng() * bergSpread;
      const across = (rng() * 2 - 1) * bergSpread * 0.7;
      const [x, z] = toLocal(along, across);
      if (rawGround(x, z) >= sea - 5) continue;
      const size = roll(bergSize, rng);
      const tabular = rng() < 0.55;
      const builder = context.newBuilder();
      const hull = buildBerg(builder, size, tabular, rng);
      context.addMover({
        builder, x, y: sea, z, yaw: rng() * Math.PI * 2, motion: 'drift', hull,
        drift: {
          speed: roll(bergSpeed, rng), heading: rng() * Math.PI * 2, leash: bergSpread * 0.65, draft: 0, bob: 0.25 + size * 0.01,
          tilt: 0.02 + 0.6 / size, spin: (rng() - 0.5) * 0.02, homeX: fieldX, homeZ: fieldZ,
        },
      });
      placed++;
    }
  }
  // A few small ice blocks floating against the front (the detail mesh, near only).
  for (let block = 0; block < 10; block++) {
    const [x, z] = toLocal(front + 8 + rng() * 60, (rng() * 2 - 1) * halfWidthAt(front));
    if (rawGround(x, z) >= sea - 1) continue;
    const size = 1.5 + rng() * 3;
    detail.setPaint(ICE.bergSide).lathe(x, sea - size * 0.6, z, [[size * 0.8, 0], [size, size * 0.6], [size * 0.6, size * 1.1]], 5, { closeTop: true, phase: rng() * 6 });
  }

  const [audioX, audioZ] = toLocal(front, 0);
  out.audioPoint = [audioX, sea + frontHeight * 0.5, audioZ];
  out.radius = Math.max(out.radius, length * 0.6 + bergSpread);
}

/**
 * The tongue's top as a landable heightfield: sampled on a world-aligned grid over the tongue from
 * the same triangulated surface the mesh is built from (holes outside it), its highest point a perch.
 */
function addTongueTop(context, tongue) {
  const { start, bodyFront, halfWidthAt, toLocal, tops, columns, forwardX, forwardZ, rightX, rightZ, sea } = tongue;
  const topAt = (x, z) => {
    const along = x * forwardX + z * forwardZ;
    const across = x * rightX + z * rightZ;
    if (along < start || along > bodyFront) return NaN;
    const halfWidth = halfWidthAt(along);
    const share = across / halfWidth;
    if (share < -0.82 || share > 0.82) return NaN;
    const rowPosition = ((along - start) / (bodyFront - start)) * ALONG_SEGMENTS;
    const columnPosition = ((share + 1) / 2) * ACROSS_SEGMENTS;
    const row = Math.min(ALONG_SEGMENTS - 1, Math.floor(rowPosition));
    const column = Math.min(ACROSS_SEGMENTS - 1, Math.floor(columnPosition));
    const u = rowPosition - row;
    const v = columnPosition - column;
    const h00 = tops[row * columns + column];
    const h01 = tops[row * columns + column + 1];
    const h10 = tops[(row + 1) * columns + column];
    const h11 = tops[(row + 1) * columns + column + 1];
    // The quad's two triangles as the mesh splits them (along its (row, column + 1)-(row + 1, column) diagonal).
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };
  const corners = [[start, -1], [start, 1], [bodyFront, -1], [bodyFront, 1]].map(([along, share]) => toLocal(along, share * halfWidthAt(along)));
  const minX = Math.min(...corners.map((corner) => corner[0])) - FIELD_CELL;
  const maxX = Math.max(...corners.map((corner) => corner[0])) + FIELD_CELL;
  const minZ = Math.min(...corners.map((corner) => corner[1])) - FIELD_CELL;
  const maxZ = Math.max(...corners.map((corner) => corner[1])) + FIELD_CELL;
  const cols = Math.ceil((maxX - minX) / FIELD_CELL) + 1;
  const rows = Math.ceil((maxZ - minZ) / FIELD_CELL) + 1;
  const heights = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < cols; column++) heights[row * cols + column] = topAt(minX + column * FIELD_CELL, minZ + row * FIELD_CELL);
  }
  context.out.colliders.push(localHeightfield('glacier-top', minX, minZ, FIELD_CELL, cols, rows, heights, sea - 18, topAt, { landable: true, perch: true, surface: 'ice' }));
}

/**
 * A calving slab in its own frame: origin at its base centre, its face toward local -z; jagged at the
 * top, banded white to blue down its face.
 */
function buildSlab(builder, width, depth, height, rng) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const topFront = height - rng() * 4;
  const topBack = height + rng() * 2;
  const band = height * 0.55;
  const p = (x, y, z) => [x, y, z];
  const corners = {
    bl: p(-halfWidth, 0, -halfDepth), br: p(halfWidth, 0, -halfDepth),
    blb: p(-halfWidth, 0, halfDepth), brb: p(halfWidth, 0, halfDepth),
    tl: p(-halfWidth * 0.96, topFront, -halfDepth * 0.9), tr: p(halfWidth * 0.94, topFront + rng() * 3, -halfDepth * 0.9),
    tlb: p(-halfWidth, topBack, halfDepth), trb: p(halfWidth, topBack, halfDepth),
  };
  const midL = p(-halfWidth, band, -halfDepth * 1.02);
  const midR = p(halfWidth, band, -halfDepth * 1.02);
  // The face (toward -z), in two bands; every quad counter-clockwise seen from outside.
  builder.setPaint(ICE.faceTop).quad(corners.tl, corners.tr, midR, midL);
  builder.setPaint(ICE.faceDeep).quad(midL, midR, corners.br, corners.bl);
  // Top, sides, back and bottom.
  builder.setPaint(ICE.snow[0]).quad(corners.tl, corners.tlb, corners.trb, corners.tr);
  builder.setPaint(ICE.faceMid).quad(corners.tl, corners.bl, corners.blb, corners.tlb);
  builder.setPaint(ICE.faceMid).quad(corners.tr, corners.trb, corners.brb, corners.br);
  builder.setPaint(shade(ICE.faceMid, 0.85)).quad(corners.tlb, corners.blb, corners.brb, corners.trb);
  builder.setPaint(ICE.faceDeep).quad(corners.bl, corners.br, corners.brb, corners.blb);
}

/** The slab's collider hull (its eight corners, in the mover frame). */
function slabHull(width, depth, height) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const points = [];
  for (const x of [-halfWidth, halfWidth]) for (const y of [0, height]) for (const z of [-halfDepth, halfDepth]) points.push([x, y, z]);
  return points;
}

/**
 * An iceberg in its own frame (origin at the waterline): a lathe of irregular rings, tabular (a flat
 * top) or a pinnacle, reaching well below the water. Returns its collider hull (ring points).
 */
function buildBerg(builder, size, tabular, rng) {
  const sides = 7;
  const above = tabular ? size * (0.35 + rng() * 0.15) : size * (0.6 + rng() * 0.4);
  const below = above * 2.2;
  const rings = tabular
    ? [[size * 0.65, -below], [size, -below * 0.35], [size, 0], [size * 0.96, above * 0.75], [size * 0.86, above]]
    : [[size * 0.55, -below], [size * 0.95, -below * 0.3], [size, 0], [size * 0.62, above * 0.55], [size * 0.18, above]];
  const jitter = Array.from({ length: rings.length * sides }, () => 0.8 + rng() * 0.4);
  const radiusAt = (ring, side, radius) => radius * jitter[ring * sides + side];
  const phase = rng() * 6;
  // Below the water (blue), the waterline band, then the white top.
  builder.setPaint(ICE.bergBelow).lathe(0, 0, 0, rings.slice(0, 3), sides, { radiusAt, closeBottom: true, phase });
  builder.setPaint(ICE.bergSide).lathe(0, 0, 0, rings.slice(2, 4), sides, {
    radiusAt: (ring, side, radius) => radiusAt(ring + 2, side, radius), phase,
  });
  builder.setPaint(ICE.bergTop).lathe(0, 0, 0, rings.slice(3), sides, {
    radiusAt: (ring, side, radius) => radiusAt(ring + 3, side, radius), closeTop: true, phase,
  });
  const hull = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const [radius, y] = rings[ring];
    for (let side = 0; side < sides; side++) {
      const angle = phase + (side / sides) * Math.PI * 2;
      const r = radiusAt(ring, side, radius);
      hull.push([Math.sin(angle) * r, y, -Math.cos(angle) * r]);
    }
  }
  return hull;
}
