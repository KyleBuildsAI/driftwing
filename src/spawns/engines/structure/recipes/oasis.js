// Recipe 'oasis' (preset 58, the desert oasis caravan): a ring of date palms round a spring-fed pool in
// the dunes (the site's basin stamp, filled by the preset's pool), their crowns swaying in the wind;
// reeds and grass at the water's edge, a stone well with its frame and bucket, black goat-hair tents
// with rugs before them, a palm-frond shade shelter and a fire pit whose lamps light at dusk (torches
// a dragon's breath also lights). The camel caravan that walks in and out across the dunes is the
// preset's fauna column. Palm trunks, the well, the tents and the shelter are solid; every palm crown
// is a perch.
// Without a basin stamp (a debug spawn) the palms ring a dry hollow `radius` metres across.
import { PALETTE } from '../palette.js';
import { findStamp, pick } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox, localCapsule, localCylinder, localHull } from '../colliders.js';
import { HERITAGE, addTorchPost } from '../heritage.js';
import { basinReach } from '../../../../world/stamps.js';

export const OASIS_DEFAULTS = Object.freeze({
  stamp: 0,
  palms: [20, 30],
  tents: [2, 4],
  radius: 60,
});

const TRUNK = Object.freeze([paint(0x8a7152), paint(0x7d6648), paint(0x947a59)]);
const FROND = Object.freeze([paint(0x4f7a33), paint(0x5c8a3a), paint(0x46702e), paint(0x6a8f3e)]);
const DATES = paint(0xb5651d);
const SAND_STONE = Object.freeze([paint(0xc8ad84), paint(0xb99d75), paint(0xd2b890)]);
const TENT = Object.freeze([paint(0x2a2420), paint(0x332b25)]);
const TENT_STRIPE = paint(0xc9b48a);
const RUGS = Object.freeze([paint(0x9c2f2a), paint(0x7c3a64), paint(0x2f5e8c), paint(0xb8742a)]);
const REED = Object.freeze([paint(0x7f9a4a), paint(0x91a85a), paint(0x6b8a42)]);

export function buildOasis(context, read) {
  const { rng, body, detail, decal, out } = context;
  const palmCount = rollInteger(read.range('palms', OASIS_DEFAULTS.palms, 4, 60), rng);
  const tentCount = rollInteger(read.range('tents', OASIS_DEFAULTS.tents, 0, 8), rng);
  const stamp = findStamp(context.site, 'basin', read.number('stamp', 0, 0, 16));
  const centreX = stamp ? stamp.x - context.anchor.x : 0;
  const centreZ = stamp ? stamp.z - context.anchor.z : 0;
  const radius = stamp ? stamp.radius : read.number('radius', OASIS_DEFAULTS.radius, 15, 400) / 2;
  const rimWidth = stamp ? stamp.rim : 18;
  // The shoreline's scale in a direction (the basin's lobes), and a point `reach` radii out there.
  const lobe = (sine, cosine) => {
    if (!stamp) return 1;
    const reach = basinReach(stamp, stamp.x + sine * radius, stamp.z - cosine * radius);
    return reach > 0 ? radius / reach : 1;
  };
  const ring = (angle, share) => {
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const distance = radius * share * lobe(sine, cosine);
    return [centreX + sine * distance, centreZ - cosine * distance];
  };
  const groundAt = (x, z) => context.ground(x, z);
  const water = stamp && Array.isArray(context.site.waters) ? context.site.waters.find((entry) => entry.basin === stamp) ?? null : null;
  const level = water ? water.level - context.anchor.y : -Infinity;
  const dry = (x, z) => groundAt(x, z) > level + 0.4;

  // ---- Date palms round the pool: leaning out over the water a little, crowns swaying ----
  for (let index = 0; index < palmCount; index++) {
    const angle = (index / palmCount) * Math.PI * 2 + (rng() - 0.5) * 0.35;
    const share = 1.02 + rng() * (0.25 + rimWidth / radius);
    const [x, z] = ring(angle, share);
    if (!dry(x, z)) continue;
    const height = 9 + rng() * 9;
    const leanX = -Math.sin(angle) * (0.06 + rng() * 0.1) + (rng() - 0.5) * 0.06;
    const leanZ = Math.cos(angle) * (0.06 + rng() * 0.1) + (rng() - 0.5) * 0.06;
    const top = addPalm(body, x, groundAt(x, z), z, height, leanX, leanZ, rng);
    out.colliders.push(localCapsule(`palm${index}`, x, groundAt(x, z), z, top[0], top[1] - 0.6, top[2], 0.45, { surface: 'wood', perch: { x: top[0], y: top[1] + 0.4, z: top[2] } }));
  }
  // A few young palms and shrubs further out.
  for (let index = 0; index < Math.round(palmCount * 0.4); index++) {
    const [x, z] = ring(rng() * Math.PI * 2, 1.5 + rng() * 0.9);
    if (!dry(x, z)) continue;
    addPalm(detail, x, groundAt(x, z), z, 2.5 + rng() * 3, (rng() - 0.5) * 0.1, (rng() - 0.5) * 0.1, rng);
  }

  // ---- Reeds and grass along the water's edge ----
  const tufts = Math.round(radius * 2.2);
  for (let index = 0; index < tufts; index++) {
    const [x, z] = ring(rng() * Math.PI * 2, 0.97 + rng() * 0.1);
    if (!dry(x, z)) continue;
    const y = groundAt(x, z);
    detail.setPaint(pick(REED, rng));
    for (let blade = 0; blade < 4; blade++) {
      const angle = rng() * Math.PI * 2;
      const tall = 0.8 + rng() * 1.4;
      const tipX = x + Math.sin(angle) * 0.35;
      const tipZ = z - Math.cos(angle) * 0.35;
      detail.setSway(0).triangle(x - 0.08, y, z, x + 0.08, y, z, tipX, y + tall, tipZ, 0, 0, 0.35);
      detail.triangle(x + 0.08, y, z, x - 0.08, y, z, tipX, y + tall, tipZ, 0, 0, 0.35);
    }
  }
  detail.setSway(0);

  // ---- The well, the tents, the shelter and the fire pit, on the dry side of the pool ----
  const campAngle = rng() * Math.PI * 2;
  const campAt = (offset, share) => ring(campAngle + offset, share);
  const [wellX, wellZ] = campAt(0, 1.22 + rimWidth / radius * 0.4);
  const wellY = groundAt(wellX, wellZ);
  body.setPaint(pick(SAND_STONE, rng)).lathe(wellX, wellY - 0.3, wellZ, [[1.5, 0], [1.6, 0.5], [1.5, 1.1], [1.2, 1.15], [1.15, 0.6]], 10, {});
  body.setPaint(HERITAGE.windowDark).lathe(wellX, wellY + 0.6, wellZ, [[1.16, 0], [0, 0.01]], 10, { closeBottom: true });
  detail.setPaint(PALETTE.timberDark);
  detail.beam(wellX - 1.3, wellY + 1, wellZ, wellX - 1.1, wellY + 3, wellZ, 0.14, 0.14);
  detail.beam(wellX + 1.3, wellY + 1, wellZ, wellX + 1.1, wellY + 3, wellZ, 0.14, 0.14);
  detail.beam(wellX - 1.3, wellY + 3, wellZ, wellX + 1.3, wellY + 3, wellZ, 0.16, 0.16);
  detail.setPaint(PALETTE.rope).beam(wellX, wellY + 3, wellZ, wellX, wellY + 1.9, wellZ, 0.03, 0.03);
  detail.setPaint(PALETTE.timber[0]).lathe(wellX, wellY + 1.5, wellZ, [[0.22, 0], [0.26, 0.4]], 7, { closeBottom: true });
  out.colliders.push(localCylinder('well', wellX, wellY - 0.3, wellZ, 1.65, 3.5, { surface: 'stone' }));

  for (let index = 0; index < tentCount; index++) {
    const offset = 0.22 + index * 0.24 + (rng() - 0.5) * 0.06;
    const [x, z] = campAt(offset * (index % 2 === 0 ? 1 : -1), 1.32 + rimWidth / radius * 0.5 + rng() * 0.15);
    const yaw = campAngle + offset + Math.PI / 2;
    const width = 6 + rng() * 3;
    const depth = 4 + rng() * 1.5;
    const height = 2 + rng() * 0.6;
    const points = addTent(body, detail, x, groundAt(x, z), z, yaw, width, depth, height, rng);
    out.colliders.push(localHull(`tent${index}`, points, { surface: 'cloth' }));
    // A rug before the tent's open front.
    const frontX = x + Math.sin(yaw) * (depth / 2 + 1.6);
    const frontZ = z - Math.cos(yaw) * (depth / 2 + 1.6);
    decal.setPaint(pick(RUGS, rng)).box(frontX, groundAt(frontX, frontZ) + 0.04, frontZ, width * 0.6, 0.06, 2.4, yaw);
  }
  // The shade shelter: four poles and a flat roof of palm fronds.
  const [shadeX, shadeZ] = campAt(-0.12, 1.5 + rimWidth / radius * 0.5);
  const shadeY = groundAt(shadeX, shadeZ);
  detail.setPaint(PALETTE.timberDark);
  for (const [dx, dz] of [[-2.4, -1.8], [2.4, -1.8], [-2.4, 1.8], [2.4, 1.8]]) detail.prism(shadeX + dx, shadeY - 0.2, shadeZ + dz, 5, 0.1, 0.08, 2.9);
  body.setPaint(shade(FROND[0], 0.8)).box(shadeX, shadeY + 2.75, shadeZ, 5.6, 0.3, 4.4);
  out.colliders.push(localBox('shelter', shadeX, shadeY + 1.45, shadeZ, 5.6, 2.9, 4.4, 0, { surface: 'wood', landable: true }));
  // The fire pit, ringed with stones, and two lamp posts by the tents that light at dusk.
  const [fireX, fireZ] = campAt(0.1, 1.42 + rimWidth / radius * 0.5);
  const fireY = groundAt(fireX, fireZ);
  for (let stone = 0; stone < 8; stone++) {
    const angle = (stone / 8) * Math.PI * 2;
    body.setPaint(pick(PALETTE.stone, rng)).box(fireX + Math.sin(angle) * 0.9, fireY + 0.12, fireZ - Math.cos(angle) * 0.9, 0.45, 0.3, 0.4, angle);
  }
  out.torches.push({ x: fireX, y: fireY + 0.05, z: fireZ, size: 1.3, autoLight: true });
  for (const offset of [0.3, -0.3]) {
    const [x, z] = campAt(offset, 1.27 + rimWidth / radius * 0.4);
    const flameY = addTorchPost(detail, x, groundAt(x, z), z, 2.2);
    out.torches.push({ x, y: flameY, z, size: 0.55, autoLight: true });
  }

  out.audioPoint = [centreX, groundAt(centreX, centreZ) + 4, centreZ];
  out.windProbe = [centreX, groundAt(centreX, centreZ) + 15, centreZ];
  out.radius = Math.max(out.radius, radius * 2.6);
}

/**
 * A date palm from its foot (x, y, z): a ringed trunk of `height` metres curving with the lean
 * (leanX, leanZ: the top's offset per metre of height), a crown of drooping fronds that sway (more
 * toward their tips) and a few hanging date clusters. Returns the crown's centre [x, y, z].
 */
function addPalm(builder, x, y, z, height, leanX, leanZ, random) {
  const segments = 6;
  const width = 0.24 + height * 0.012;
  let fromX = x;
  let fromZ = z;
  let fromY = y - 0.3;
  for (let segment = 1; segment <= segments; segment++) {
    const share = segment / segments;
    // The lean grows toward the top (a curve, not a straight tilt).
    const toX = x + leanX * height * share * share;
    const toZ = z + leanZ * height * share * share;
    const toY = y + height * share;
    builder.setSway(share * 0.08).setPaint(pick(TRUNK, random)).beam(fromX, fromY, fromZ, toX, toY, toZ, width * (1.1 - share * 0.25), width * (1.1 - share * 0.25));
    fromX = toX;
    fromY = toY;
    fromZ = toZ;
  }
  const fronds = 9 + Math.floor(random() * 4);
  const length = 2.6 + height * 0.18;
  for (let frond = 0; frond < fronds; frond++) {
    const angle = (frond / fronds) * Math.PI * 2 + random() * 0.4;
    const dirX = Math.sin(angle);
    const dirZ = -Math.cos(angle);
    const rise = 0.25 + random() * 0.5;
    builder.setPaint(pick(FROND, random));
    // Three sections: up and out, then drooping; each a leaf blade with the midrib along it.
    let baseX = fromX;
    let baseY = fromY;
    let baseZ = fromZ;
    for (let section = 0; section < 3; section++) {
      const reach = length / 3;
      const drop = section === 0 ? rise : -(section * 0.55 + random() * 0.3);
      const tipX = baseX + dirX * reach;
      const tipZ = baseZ + dirZ * reach;
      const tipY = baseY + drop * reach * 0.6;
      const half = 0.45 * (1 - section * 0.25);
      const sideX = -dirZ * half;
      const sideZ = dirX * half;
      const swayBase = 0.2 + section * 0.25;
      const swayTip = swayBase + 0.25;
      builder.triangle(baseX, baseY, baseZ, tipX + sideX, tipY - 0.08, tipZ + sideZ, tipX, tipY, tipZ, swayBase, swayTip, swayTip);
      builder.triangle(baseX, baseY, baseZ, tipX, tipY, tipZ, tipX - sideX, tipY - 0.08, tipZ - sideZ, swayBase, swayTip, swayTip);
      builder.triangle(baseX, baseY, baseZ, tipX, tipY, tipZ, tipX + sideX, tipY - 0.08, tipZ + sideZ, swayBase, swayTip, swayTip);
      builder.triangle(baseX, baseY, baseZ, tipX - sideX, tipY - 0.08, tipZ - sideZ, tipX, tipY, tipZ, swayBase, swayTip, swayTip);
      baseX = tipX;
      baseY = tipY;
      baseZ = tipZ;
    }
  }
  if (height > 6) {
    for (let cluster = 0; cluster < 3; cluster++) {
      const angle = random() * Math.PI * 2;
      builder.setSway(0.1).setPaint(DATES).lathe(fromX + Math.sin(angle) * 0.45, fromY - 1.1, fromZ - Math.cos(angle) * 0.45, [[0.05, 0], [0.32, 0.4], [0.2, 0.9]], 5, { closeBottom: true, closeTop: true });
    }
  }
  builder.setSway(0);
  return [fromX, fromY, fromZ];
}

/**
 * A black goat-hair tent at (x, y, z), its open front toward compass yaw: a low ridge on three poles,
 * the cloth sloping to the guy lines at the sides and back, a pale woven stripe. Returns its hull's
 * points for the collider.
 */
function addTent(body, detail, x, y, z, yaw, width, depth, height, random) {
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const point = (across, along, up) => [x + rightX * across + forwardX * along, y + up, z + rightZ * across + forwardZ * along];
  const halfW = width / 2;
  const halfD = depth / 2;
  const ridgeL = point(-halfW * 0.9, 0, height);
  const ridgeR = point(halfW * 0.9, 0, height);
  const backL = point(-halfW, -halfD, 0.35);
  const backR = point(halfW, -halfD, 0.35);
  const frontL = point(-halfW, halfD * 0.8, height * 0.75);
  const frontR = point(halfW, halfD * 0.8, height * 0.75);
  const sideLB = point(-halfW - 0.4, -halfD * 0.2, 0.3);
  const sideRB = point(halfW + 0.4, -halfD * 0.2, 0.3);
  const cloth = pick(TENT, random);
  body.setPaint(cloth);
  // The back slope (both faces, so the cloth reads from inside the open front too).
  body.quad(backL, backR, ridgeR, ridgeL);
  body.quad(ridgeL, ridgeR, backR, backL);
  // The front awning, raised on its poles.
  body.quad(ridgeL, ridgeR, frontR, frontL);
  body.quad(frontL, frontR, ridgeR, ridgeL);
  // The side walls down to the sand.
  body.quad(ridgeL, frontL, sideLB, backL);
  body.quad(backL, sideLB, frontL, ridgeL);
  body.quad(ridgeR, backR, sideRB, frontR);
  body.quad(frontR, sideRB, backR, ridgeR);
  // The woven stripe along the ridge.
  const stripeL = point(-halfW * 0.9, -0.35, height - 0.12);
  const stripeR = point(halfW * 0.9, -0.35, height - 0.12);
  body.setPaint(TENT_STRIPE).quad(stripeL, stripeR, ridgeR, ridgeL);
  body.quad(ridgeL, ridgeR, stripeR, stripeL);
  // Poles under the ridge and the awning, and guy lines.
  detail.setPaint(PALETTE.timberDark);
  for (const across of [-halfW * 0.7, 0, halfW * 0.7]) {
    const foot = point(across, 0, 0);
    detail.beam(foot[0], y - 0.1, foot[2], foot[0], y + height, foot[2], 0.08, 0.08);
  }
  for (const across of [-halfW, halfW]) {
    const foot = point(across, halfD * 0.8, 0);
    detail.beam(foot[0], y - 0.1, foot[2], foot[0], y + height * 0.75, foot[2], 0.07, 0.07);
  }
  detail.setPaint(PALETTE.rope);
  for (const across of [-halfW * 0.7, halfW * 0.7]) {
    const from = point(across, -halfD, 0.35);
    const to = point(across * 1.15, -halfD - 1.6, 0);
    detail.beam(from[0], from[1], from[2], to[0], to[1], to[2], 0.03, 0.03);
  }
  return [ridgeL, ridgeR, backL, backR, frontL, frontR, sideLB, sideRB, point(-halfW, halfD * 0.8, 0), point(halfW, halfD * 0.8, 0)];
}
