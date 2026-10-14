// Props the Phase 3 heritage recipes share (the monastery, the castle, the observatory, the viaduct,
// the dam, the oasis and the labyrinth): the site frame laid along a stamp or a heading, whitewashed
// halls, hipped roofs, battlements, arch rings, prayer-flag strings and torch posts, in the v1
// low-poly style. Builders take local coordinates (metres from the spawn anchor); every helper resets
// the builder's transform when it is done.
import { paint, shade } from './meshBuilder.js';
import { PALETTE } from './palette.js';
import { pick } from './common.js';

/** Colours the heritage recipes share (linear RGBA; alpha is the emissive gain). */
export const HERITAGE = Object.freeze({
  whitewash: Object.freeze([paint(0xf1ece0), paint(0xebe4d4), paint(0xf4efe6)]),
  kemar: paint(0x8c2f24),
  gold: paint(0xc9a23a),
  goldBright: paint(0xe2bd52, 0.15),
  windowFrame: paint(0x6b2a20),
  windowDark: paint(0x241d1a),
  slate: paint(0x4f5358),
  limestone: Object.freeze([paint(0xb9b09e), paint(0xa79e8c), paint(0xc4bba8)]),
  ruinStone: Object.freeze([paint(0x8f877a), paint(0x7f786d), paint(0x9b9384), paint(0x6f695f)]),
  mortar: paint(0x5e5850),
  ivy: Object.freeze([paint(0x3f5a2e), paint(0x4a6834)]),
  /** Prayer flags: the five colours in their order (blue, white, red, green, yellow). */
  flags: Object.freeze([paint(0x2f6fb8), paint(0xf2efe6), paint(0xc23a2c), paint(0x3c8a4a), paint(0xe8c23a)]),
  rope: paint(0x6e5a40),
  lampGlow: paint(0xffc46a, 2.2),
  redLamp: paint(0xff3a2a, 3),
});

/**
 * The site frame: an origin (local x, z) and a forward axis (unit dirX, dirZ); `along` runs forward
 * and `across` to its right. x(a, c) and z(a, c) give the local point; yaw is the forward axis as a
 * compass heading in radians (meshBuilder.box and localBox take it, local -z then points forward).
 */
export function createSiteFrame(originX, originZ, dirX, dirZ) {
  return Object.freeze({
    originX,
    originZ,
    dirX,
    dirZ,
    rightX: -dirZ,
    rightZ: dirX,
    yaw: Math.atan2(dirX, -dirZ),
    x: (along, across) => originX + dirX * along - dirZ * across,
    z: (along, across) => originZ + dirZ * along + dirX * across,
  });
}

/**
 * A quad (four local points, in order around it) emitted so that its face points away from `inside`
 * (a point within the solid it bounds): the winding is chosen for the builder's flat normals, so a
 * recipe can list a solid's faces in any order.
 */
export function outwardQuad(builder, a, b, c, d, inside) {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const facing = nx * (a[0] - inside[0]) + ny * (a[1] - inside[1]) + nz * (a[2] - inside[2]);
  if (facing >= 0) builder.quad(a, b, c, d);
  else builder.quad(a, d, c, b);
}

/**
 * A whitewashed hall in the Himalayan style at local (x, y, z), turned to compass yaw (radians): walls
 * leaning a little inward, a dark red kemar band under the parapet, rows of trapezoid windows in red
 * frames on the front (-z) and side faces, a flat roof with a parapet. width (x), depth (z), height (m).
 */
export function addWhiteHall(body, x, y, z, yaw, { width, depth, height, random, windows = true, base = 0 }) {
  const wall = pick(HERITAGE.whitewash, random);
  const inset = height * 0.035;
  body.setTransform(x, y, z, yaw);
  // The walls: a frustum of four faces from the ground (or `base` below it, a foundation) to the band.
  const bandBase = height * 0.84;
  const halfX = width / 2;
  const halfZ = depth / 2;
  const topX = halfX - inset;
  const topZ = halfZ - inset;
  const bottom = -base;
  body.setPaint(wall);
  // Each face counter-clockwise from outside (meshBuilder's flat normals face out).
  body.quad([-halfX, bottom, -halfZ], [-topX, bandBase, -topZ], [topX, bandBase, -topZ], [halfX, bottom, -halfZ]);
  body.quad([halfX, bottom, halfZ], [topX, bandBase, topZ], [-topX, bandBase, topZ], [-halfX, bottom, halfZ]);
  body.quad([halfX, bottom, -halfZ], [topX, bandBase, -topZ], [topX, bandBase, topZ], [halfX, bottom, halfZ]);
  body.quad([-halfX, bottom, halfZ], [-topX, bandBase, topZ], [-topX, bandBase, -topZ], [-halfX, bottom, -halfZ]);
  // The kemar band, the parapet cap and the roof.
  body.setPaint(HERITAGE.kemar).box(0, (bandBase + height) / 2, 0, topX * 2 + 0.3, height - bandBase, topZ * 2 + 0.3);
  body.setPaint(shade(wall, 0.9)).box(0, height + 0.25, 0, topX * 2 + 0.6, 0.5, topZ * 2 + 0.6);
  body.setPaint(shade(PALETTE.concreteDark, 0.85)).box(0, height + 0.05, 0, topX * 2 - 0.8, 0.2, topZ * 2 - 0.8);
  if (windows) {
    const rows = Math.max(1, Math.floor((bandBase - 2) / 3.2));
    for (let row = 0; row < rows; row++) {
      const level = 2 + row * 3.2;
      const front = Math.max(1, Math.floor(width / 4.5));
      for (let column = 0; column < front; column++) {
        const offset = -halfX + (column + 0.5) * (width / front);
        addWindow(body, offset, level, -halfZ - 0.06, 0, 1.3, 1.6);
      }
      const side = Math.max(1, Math.floor(depth / 5));
      for (let column = 0; column < side; column++) {
        const offset = -halfZ + (column + 0.5) * (depth / side);
        addWindow(body, halfX + 0.06, level, offset, Math.PI / 2, 1.1, 1.5);
        addWindow(body, -halfX - 0.06, level, offset, -Math.PI / 2, 1.1, 1.5);
      }
    }
  }
  body.resetTransform();
}

/** A trapezoid window (narrower at the top) in a red frame, facing compass yaw (in the builder's frame). */
function addWindow(body, x, y, z, yaw, width, height) {
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const corner = (across, up, out) => [x + rightX * across + forwardX * out, y + up, z + rightZ * across + forwardZ * out];
  const half = width / 2;
  body.setPaint(HERITAGE.windowFrame);
  body.quad(corner(-half - 0.2, -0.2, 0), corner(-half * 0.8 - 0.2, height + 0.2, 0), corner(half * 0.8 + 0.2, height + 0.2, 0), corner(half + 0.2, -0.2, 0));
  body.setPaint(HERITAGE.windowDark);
  body.quad(corner(-half, 0, 0.03), corner(-half * 0.8, height, 0.03), corner(half * 0.8, height, 0.03), corner(half, 0, 0.03));
}

/**
 * A hipped roof over a rectangle at local (x, y, z), turned to compass yaw: eaves overhanging by
 * `overhang`, rising `height` to a ridge along the longer side, eave corners turned up a little (the
 * temple roofs). halfX, halfZ: half the covered rectangle.
 */
export function addHipRoof(builder, x, y, z, yaw, halfX, halfZ, height, overhang, roofPaint, flare = 0.4) {
  builder.setTransform(x, y, z, yaw).setPaint(roofPaint);
  const ex = halfX + overhang;
  const ez = halfZ + overhang;
  const ridge = Math.max(0, Math.abs(halfX - halfZ));
  const alongX = halfX >= halfZ;
  const r0 = alongX ? [-ridge, height, 0] : [0, height, -ridge];
  const r1 = alongX ? [ridge, height, 0] : [0, height, ridge];
  const c00 = [-ex, flare, -ez];
  const c10 = [ex, flare, -ez];
  const c11 = [ex, flare, ez];
  const c01 = [-ex, flare, ez];
  if (alongX) {
    builder.quad(c00, r0, r1, c10);
    builder.quad(c11, r1, r0, c01);
    builder.triangle(...c01, ...r0, ...c00);
    builder.triangle(...c10, ...r1, ...c11);
  } else {
    builder.quad(c10, r0, r1, c11);
    builder.quad(c01, r1, r0, c00);
    builder.triangle(...c00, ...r0, ...c10);
    builder.triangle(...c11, ...r1, ...c01);
  }
  // The soffit closes the roof from below.
  builder.setPaint(shade(roofPaint, 0.55)).quad(c00, c10, c11, c01);
  builder.resetTransform();
}

/**
 * Merlons along a wall top from local (ax, az) to (bx, bz) at height topY: blocks `merlon` long and
 * `rise` high with `gap` crenels between them, `thickness` deep. skip(share) may leave some out (a
 * ruined stretch).
 */
export function addBattlements(body, ax, az, bx, bz, topY, { thickness, merlon = 1.6, gap = 1.1, rise = 1.4, wallPaint, skip = null }) {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (length < merlon) return;
  const yaw = Math.atan2(dz, dx);
  const count = Math.floor((length + gap) / (merlon + gap));
  const used = count * merlon + (count - 1) * gap;
  const start = (length - used) / 2 + merlon / 2;
  body.setPaint(wallPaint);
  for (let index = 0; index < count; index++) {
    const along = start + index * (merlon + gap);
    const share = along / length;
    if (skip && skip(share)) continue;
    // meshBuilder.box turns local x clockwise by yaw: x along the wall is a yaw of atan2(dz, dx).
    body.box(ax + dx * share, topY + rise / 2, az + dz * share, merlon, rise, thickness, yaw);
  }
}

/**
 * A semicircular arch ring in the builder's frame: voussoir blocks on a circle of `radius` about
 * (cx, cy) in the local x-y plane, from springing to springing, `thickness` deep radially and `depth`
 * along local z. Paints alternate between the stone paints.
 */
export function addArchRing(builder, cx, cy, cz, radius, thickness, depth, segments, stones, random) {
  for (let index = 0; index < segments; index++) {
    const from = Math.PI - (index / segments) * Math.PI;
    const to = Math.PI - ((index + 1) / segments) * Math.PI;
    const inner = radius;
    const outer = radius + thickness;
    const p = (angle, r, z) => [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, cz + z];
    const a0 = p(from, inner, -depth / 2);
    const a1 = p(to, inner, -depth / 2);
    const b0 = p(from, outer, -depth / 2);
    const b1 = p(to, outer, -depth / 2);
    const a0b = p(from, inner, depth / 2);
    const a1b = p(to, inner, depth / 2);
    const b0b = p(from, outer, depth / 2);
    const b1b = p(to, outer, depth / 2);
    builder.setPaint(pick(stones, random));
    builder.quad(a0, b0, b1, a1); // front (-z)
    builder.quad(b1b, b0b, a0b, a1b); // back (+z)
    builder.quad(a0, a1, a1b, a0b); // intrados (underside)
    builder.quad(b0, b0b, b1b, b1); // extrados
  }
}

/**
 * A string of prayer flags from local point `from` to `to` ([x, y, z]), sagging `sag` metres at the
 * middle: the rope on the detail builder and `count` flags on the cloth builder, hanging below the rope
 * (their hang, the cloth's sway value, from 0 at the rope to the flag's height at its free edge), in
 * the five colours in order.
 */
export function addFlagString(cloth, detail, from, to, { count, sag, flagWidth = 0.42, flagHeight = 0.5, ropeWidth = 0.05 }) {
  const point = (share) => [
    from[0] + (to[0] - from[0]) * share,
    from[1] + (to[1] - from[1]) * share - sag * 4 * share * (1 - share),
    from[2] + (to[2] - from[2]) * share,
  ];
  const segments = 12;
  detail.setPaint(HERITAGE.rope);
  for (let index = 0; index < segments; index++) {
    const a = point(index / segments);
    const b = point((index + 1) / segments);
    detail.beam(a[0], a[1], a[2], b[0], b[1], b[2], ropeWidth, ropeWidth);
  }
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const length = Math.sqrt(dx * dx + dz * dz + (to[1] - from[1]) ** 2);
  const half = Math.min(0.48 / count, flagWidth / Math.max(length, 1) / 2);
  for (let index = 0; index < count; index++) {
    const share = (index + 0.5) / count;
    const left = point(share - half);
    const right = point(share + half);
    cloth.setPaint(HERITAGE.flags[index % HERITAGE.flags.length]);
    // Both edges hang from the rope; the cloth material swings the lower edge out downwind.
    cloth.triangle(left[0], left[1], left[2], right[0], right[1], right[2], right[0], right[1] - flagHeight, right[2], 0, 0, flagHeight);
    cloth.triangle(left[0], left[1], left[2], right[0], right[1] - flagHeight, right[2], left[0], left[1] - flagHeight, left[2], 0, flagHeight, flagHeight);
  }
}

/**
 * A banner hanging from a crossbar: the bar on the detail builder from (x, y, z), `width` wide across
 * compass yaw, the cloth `length` long beneath it with a swallow-tail, painted `colour` with a stripe.
 */
export function addBanner(cloth, detail, x, y, z, yaw, { width, length, colour, stripe }) {
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const half = width / 2;
  detail.setPaint(PALETTE.timberDark).beam(x - rightX * (half + 0.2), y, z - rightZ * (half + 0.2), x + rightX * (half + 0.2), y, z + rightZ * (half + 0.2), 0.12, 0.12);
  const left = [x - rightX * half, y - 0.05, z - rightZ * half];
  const right = [x + rightX * half, y - 0.05, z + rightZ * half];
  const rows = 4;
  for (let row = 0; row < rows; row++) {
    const top = (row / rows) * length;
    const bottom = ((row + 1) / rows) * length;
    cloth.setPaint(row === 1 ? stripe : colour);
    cloth.triangle(left[0], left[1] - top, left[2], right[0], right[1] - top, right[2], right[0], right[1] - bottom, right[2], top, top, bottom);
    cloth.triangle(left[0], left[1] - top, left[2], right[0], right[1] - bottom, right[2], left[0], left[1] - bottom, left[2], top, bottom, bottom);
  }
  // The swallow-tail.
  const tip = length * 1.18;
  cloth.setPaint(colour);
  cloth.triangle(left[0], left[1] - length, left[2], (left[0] + right[0]) / 2, left[1] - length * 1.02, (left[2] + right[2]) / 2, left[0], left[1] - tip, left[2], length, length, tip);
  cloth.triangle((left[0] + right[0]) / 2, left[1] - length * 1.02, (left[2] + right[2]) / 2, right[0], right[1] - length, right[2], right[0], right[1] - tip, right[2], length, length, tip);
}

/**
 * A torch post (or a wall bracket with `height` 0): a timber post with an iron bowl at the top. Returns
 * the flame's base height (local y) for the structure's torches list.
 */
export function addTorchPost(detail, x, y, z, height) {
  detail.setPaint(PALETTE.timberDark);
  if (height > 0) detail.prism(x, y - 0.2, z, 5, 0.09, 0.07, height + 0.2);
  const top = y + height;
  detail.setPaint(PALETTE.metalDark).lathe(x, top, z, [[0.12, 0], [0.32, 0.22], [0.36, 0.3]], 6, { closeBottom: true });
  return top + 0.24;
}
