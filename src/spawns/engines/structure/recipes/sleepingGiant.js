// Recipe 'sleepingGiant': the stone giant asleep on its back (preset 68). The figure itself is the
// site's `giant` terrain stamp (src/world/stamps.js giantFigure: head and face, chest, folded hands,
// hips, one knee raised, feet), so it is real ground: the far field draws it, the terrain shades it and
// it reads from altitude. The recipe adds what the terrain cannot carry: a ring of standing stones on
// the chest (the summit, a perch), lichen-crusted scree boulders along the flanks, and the colliders of
// both.
//
// Without a giant stamp (a debug spawn) the recipe raises the figure itself, laid along the heading
// with its base at the anchor: a basalt body sampled from the same giantFigure on a CELL grid, mossy
// on its lowest flanks, and a landable heightfield collider of the same top (its highest point a
// perch), so a force-spawned giant looks, collides and lands as the stamped one does. Either way the
// nose stands at GIANT_NOSE in front of and above the anchor, where the preset's breath emitter rises.
import { PALETTE, paint, shade } from '../palette.js';
import { addBoulder, addCairn, findStamp, frameFromHeading } from '../common.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox, localCylinder, localHeightfield, localSphere } from '../colliders.js';
import { GIANT_HALF_WIDTH, GIANT_NOSE, giantFigure, giantRaise } from '../../../../world/stamps.js';

export const SLEEPING_GIANT_DEFAULTS = Object.freeze({
  stamp: 0,
  length: 3200,
  height: 420,
  skirt: 0.26,
  stones: [7, 9],
  boulders: [36, 52],
});

/** Grid spacing (m) of the free-standing figure's body and of its heightfield collider. */
const CELL = 24;
/** The free-standing body's vertices off the figure sink this far under the ground (no seam). */
const SINK = 2;
/** The standing stones ring the chest summit at this radius (m) and stand this tall (m). */
const STONE_RING = 46;
const STONE_HEIGHT = Object.freeze([7, 11]);
/** The chest summit in figure units (the highest dome). */
const CHEST = Object.freeze({ along: 0.19, across: 0 });
/** Scree lies where the figure's top is between these shares of its height (the lower flanks). */
const SCREE_BAND = Object.freeze([0.03, 0.24]);
const BASALT = Object.freeze([paint(0x4a4541), paint(0x55504a), paint(0x423e3a), paint(0x5c5650)]);
const MOSS = Object.freeze([paint(0x5d6a42), paint(0x67744a), paint(0x53603c)]);
const LICHEN = paint(0x9a9a78);

/**
 * The figure's frame and size: from the giant stamp (its own direction and resolved sizes, centred on
 * the stamp) or, free-standing, the heading and the params with the base at the anchor's level.
 */
function giantFrame(context, read, stamp) {
  if (stamp) {
    return {
      x: stamp.x - context.anchor.x,
      z: stamp.z - context.anchor.z,
      forwardX: stamp.dirX,
      forwardZ: stamp.dirZ,
      rightX: -stamp.dirZ,
      rightZ: stamp.dirX,
      length: stamp.length,
      height: stamp.height,
      skirt: stamp.skirt,
      baseY: stamp.baseY - context.anchor.y,
      stamped: true,
    };
  }
  const heading = frameFromHeading(context.heading);
  const height = read.number('height', SLEEPING_GIANT_DEFAULTS.height, 50, 1500);
  return {
    x: 0,
    z: 0,
    forwardX: heading.forwardX,
    forwardZ: heading.forwardZ,
    rightX: heading.rightX,
    rightZ: heading.rightZ,
    length: read.number('length', SLEEPING_GIANT_DEFAULTS.length, 400, 8000),
    height,
    skirt: read.number('skirt', SLEEPING_GIANT_DEFAULTS.skirt, 0, 1) * height,
    baseY: 0,
    stamped: false,
  };
}

/** Local (x, z) of figure coordinates (u along toward the head, v across to the right, in lengths). */
function figurePoint(frame, u, v, out) {
  out[0] = frame.x + (frame.forwardX * u + frame.rightX * v) * frame.length;
  out[1] = frame.z + (frame.forwardZ * u + frame.rightZ * v) * frame.length;
  return out;
}

/** The figure's share (0..1 of its height; 0 off the figure) at local (x, z). */
function figureShare(frame, x, z) {
  const dx = x - frame.x;
  const dz = z - frame.z;
  const u = (dx * frame.forwardX + dz * frame.forwardZ) / frame.length;
  const v = (dx * frame.rightX + dz * frame.rightZ) / frame.length;
  if (u < -0.5 || u > 0.5 || v < -GIANT_HALF_WIDTH || v > GIANT_HALF_WIDTH) return 0;
  return Math.max(0, giantFigure(u, v));
}

/** The figure's own top at local (x, z) (local y, before it meets the ground), or NaN off the figure. */
function figureTop(frame, x, z) {
  const figure = figureShare(frame, x, z);
  return figure > 0 ? frame.baseY - frame.skirt + figure * (frame.height + frame.skirt) : NaN;
}

/** The surface at local (x, z): the (stamped) ground, or the ground with the free-standing figure over it. */
function surfaceAt(context, frame, x, z) {
  const ground = context.ground(x, z);
  if (frame.stamped) return ground;
  return giantRaise(figureShare(frame, x, z), frame.baseY, frame.skirt, frame.height, ground);
}

/** The free-standing figure's body: a grid over its footprint, faces only where it stands above the ground. */
function buildFigureBody(context, frame) {
  const { body, rng } = context;
  const columns = Math.ceil(frame.length / CELL);
  const rows = Math.ceil((frame.length * GIANT_HALF_WIDTH * 2) / CELL);
  const point = [0, 0];
  const vertices = new Float64Array((columns + 1) * (rows + 1) * 3);
  const above = new Uint8Array((columns + 1) * (rows + 1));
  const shares = new Float32Array((columns + 1) * (rows + 1));
  for (let row = 0; row <= rows; row++) {
    const v = -GIANT_HALF_WIDTH + (row / rows) * GIANT_HALF_WIDTH * 2;
    for (let column = 0; column <= columns; column++) {
      const u = -0.5 + column / columns;
      figurePoint(frame, u, v, point);
      const ground = context.ground(point[0], point[1]);
      const share = figureShare(frame, point[0], point[1]);
      const top = giantRaise(share, frame.baseY, frame.skirt, frame.height, ground);
      const index = row * (columns + 1) + column;
      const standing = top > ground;
      above[index] = standing ? 1 : 0;
      shares[index] = standing ? share : 0;
      vertices[index * 3] = point[0];
      vertices[index * 3 + 1] = standing ? top : ground - SINK;
      vertices[index * 3 + 2] = point[1];
    }
  }
  const corner = (index) => [vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + 1;
      const c = a + columns + 2;
      const d = a + columns + 1;
      if (!(above[a] || above[b] || above[c] || above[d])) continue;
      const share = Math.max(shares[a], shares[b], shares[c], shares[d]);
      const tone = 0.86 + rng() * 0.24;
      const stone = BASALT[Math.floor(rng() * BASALT.length)];
      const moss = MOSS[Math.floor(rng() * MOSS.length)];
      body.setPaint(shade(share < 0.18 ? moss : share > 0.7 && rng() < 0.12 ? LICHEN : stone, tone));
      // Wound so the faces look up (the builder's quads face the camera from above when ordered so).
      body.quad(corner(a), corner(d), corner(c), corner(b));
    }
  }
}

/**
 * The free-standing figure's collider: a landable heightfield on a world-axis grid over its rotated
 * footprint (holes where the figure does not stand above the ground), publishing the exact top.
 */
function figureCollider(context, frame) {
  const halfAlong = frame.length / 2;
  const halfAcross = frame.length * GIANT_HALF_WIDTH;
  const reachX = Math.abs(frame.forwardX) * halfAlong + Math.abs(frame.rightX) * halfAcross;
  const reachZ = Math.abs(frame.forwardZ) * halfAlong + Math.abs(frame.rightZ) * halfAcross;
  const columns = Math.ceil((reachX * 2) / CELL) + 1;
  const rows = Math.ceil((reachZ * 2) / CELL) + 1;
  const x0 = frame.x - ((columns - 1) * CELL) / 2;
  const z0 = frame.z - ((rows - 1) * CELL) / 2;
  const heights = new Float32Array(columns * rows);
  let lowest = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = x0 + column * CELL;
      const z = z0 + row * CELL;
      const ground = context.ground(x, z);
      const top = giantRaise(figureShare(frame, x, z), frame.baseY, frame.skirt, frame.height, ground);
      heights[row * columns + column] = top > ground ? top : NaN;
      if (ground < lowest) lowest = ground;
    }
  }
  // The exact top is the figure's own (pure arithmetic, no terrain lookup, so landing queries allocate
  // nothing): the same as the body wherever it stands clear of the ground, and under the ground (where
  // the terrain's higher surface wins) at its outline.
  const exactTop = (x, z) => figureTop(frame, x, z);
  return localHeightfield('figure', x0, z0, CELL, columns, rows, heights, lowest - SINK * 4, exactTop, { landable: true, perch: true, surface: 'stone' });
}

/** A ring of standing stones around the chest summit, a cairn at its centre; the tallest stone is a perch. */
function buildStones(context, frame, count) {
  const { body, rng, out } = context;
  const centre = figurePoint(frame, CHEST.along, CHEST.across, [0, 0]);
  const centreY = surfaceAt(context, frame, centre[0], centre[1]);
  addCairn(body, centre[0], centreY, centre[1], 3.2, rng, PALETTE.flagWhite);
  out.colliders.push(localCylinder('cairn', centre[0], centreY - 0.3, centre[1], 1.4, 3.2, { surface: 'stone' }));
  let tallest = -1;
  let tallestHeight = 0;
  const stones = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2 + (rng() - 0.5) * 0.25;
    const x = centre[0] + Math.sin(angle) * STONE_RING;
    const z = centre[1] - Math.cos(angle) * STONE_RING;
    const y = surfaceAt(context, frame, x, z);
    const height = roll(STONE_HEIGHT, rng);
    const width = 3 + rng() * 1.6;
    const depth = 1.6 + rng() * 0.8;
    // Faces the centre: the stone's broad side tangent to the ring.
    const yaw = angle + Math.PI / 2;
    body.setPaint(shade(PALETTE.stone[index % PALETTE.stone.length], 0.82 + rng() * 0.2)).box(x, y + height / 2 - 1, z, width, height + 2, depth, yaw);
    stones.push({ x, y, z, width, height, depth, yaw });
    if (height > tallestHeight) {
      tallestHeight = height;
      tallest = index;
    }
  }
  stones.forEach((stone, index) => {
    const tags = index === tallest
      ? { surface: 'stone', perch: { x: stone.x, y: stone.y + stone.height + 1, z: stone.z } }
      : { surface: 'stone' };
    out.colliders.push(localBox('stone', stone.x, stone.y + stone.height / 2 - 1, stone.z, stone.width, stone.height + 2, stone.depth, stone.yaw, tags));
  });
}

/** Scree boulders on the lower flanks: seeded spots whose figure share lies in SCREE_BAND. */
function buildScree(context, frame, count) {
  const { detail, body, rng, out } = context;
  const point = [0, 0];
  let placed = 0;
  for (let attempt = 0; attempt < count * 12 && placed < count; attempt++) {
    const u = -0.48 + rng() * 0.96;
    const v = (rng() < 0.5 ? -1 : 1) * (0.04 + rng() * (GIANT_HALF_WIDTH - 0.04));
    const figure = giantFigure(u, v);
    if (figure < SCREE_BAND[0] || figure > SCREE_BAND[1]) continue;
    figurePoint(frame, u, v, point);
    const y = surfaceAt(context, frame, point[0], point[1]);
    const radius = 3 + rng() * 7;
    // The big ones are body (seen from afar), the small ones detail (near only).
    addBoulder(radius > 6 ? body : detail, point[0], y, point[1], radius, rng, rng() < 0.3 ? LICHEN : BASALT[Math.floor(rng() * BASALT.length)]);
    if (radius > 4) out.colliders.push(localSphere('scree', point[0], y + radius * 0.35, point[1], radius * 0.85, { surface: 'stone' }));
    placed++;
  }
}

export function buildSleepingGiant(context, read) {
  const { rng, out } = context;
  const stamp = findStamp(context.site, 'giant', read.integer('stamp', SLEEPING_GIANT_DEFAULTS.stamp, 0, 16));
  const frame = giantFrame(context, read, stamp);
  const stoneCount = rollInteger(read.range('stones', SLEEPING_GIANT_DEFAULTS.stones, 3, 16), rng);
  const boulderCount = rollInteger(read.range('boulders', SLEEPING_GIANT_DEFAULTS.boulders, 0, 200), rng);
  if (!frame.stamped) {
    buildFigureBody(context, frame);
    out.colliders.push(figureCollider(context, frame));
  }
  buildStones(context, frame, stoneCount);
  buildScree(context, frame, boulderCount);
  // The voice (when this part owns it) sits at the nose, where the breath rises.
  const nose = figurePoint(frame, GIANT_NOSE.along, 0, [0, 0]);
  out.audioPoint = [nose[0], frame.baseY - frame.skirt + GIANT_NOSE.figure * (frame.height + frame.skirt), nose[1]];
  out.radius = frame.length * 0.55;
}
