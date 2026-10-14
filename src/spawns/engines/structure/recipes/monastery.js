// Recipe 'monastery' (preset 53, the cliffside monastery): a whitewashed Himalayan monastery on the
// lip of the site's cliff step (the cliffStep stamp). The main hall, a gilded chorten, a bell pavilion
// and a tall prayer pole stand on the plateau; smaller halls cling to the cliff face below, each on a
// masonry buttress, reached by timber stairs down the face. Strings of prayer flags in the five
// colours run from the pole and the roofs to posts along the edge and down to the lower halls; they
// swing out and ripple in the real WindField wind (the engine's cloth). Butter lamps and braziers are
// torches the dragon's breath can light; the lamps light themselves at dusk. The halls, the chorten,
// the pavilion, the pole and the stairs are solid, the roofs landable perches.
// Without a cliffStep stamp (a debug spawn) the recipe raises its own basalt cliff `drop` metres high.
import { PALETTE } from '../palette.js';
import { addPine, findStamp, frameFromHeading, pick } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox, localCapsule, localCylinder, localHull } from '../colliders.js';
import { HERITAGE, addFlagString, addHipRoof, addTorchPost, addWhiteHall, createSiteFrame, outwardQuad } from '../heritage.js';

export const MONASTERY_DEFAULTS = Object.freeze({
  stamp: 0,
  halls: [2, 3],
  strings: [10, 14],
  flags: [16, 26],
  chorten: true,
  bell: true,
  pines: [4, 8],
  drop: 90,
  width: 260,
});

const BASALT = paint(0x3e3a37);
const BRONZE = paint(0x8a6a3a);
/** Metres between the lower halls' floors down the face, and the clearance kept above the cliff foot. */
const TIER_STEP = 13;
const FOOT_CLEARANCE = 14;
/** The search window (m along the site frame) for the cliff face at a height. */
const FACE_SEARCH = 32;

export function buildMonastery(context, read) {
  const { rng, body, detail, cloth, out } = context;
  const hallCount = rollInteger(read.range('halls', MONASTERY_DEFAULTS.halls, 0, 5), rng);
  const stringCount = rollInteger(read.range('strings', MONASTERY_DEFAULTS.strings, 0, 40), rng);
  const flagRange = read.range('flags', MONASTERY_DEFAULTS.flags, 4, 60);
  const withChorten = read.boolean('chorten', MONASTERY_DEFAULTS.chorten);
  const withBell = read.boolean('bell', MONASTERY_DEFAULTS.bell);
  const pineCount = rollInteger(read.range('pines', MONASTERY_DEFAULTS.pines, 0, 30), rng);
  const site = buildFrame(context, read);
  const { frame, heightAt } = site;
  const yaw = frame.yaw;
  const topY = heightAt(-26, 0);

  /** The local point of a site-frame position at a height, as [x, y, z]. */
  const point = (along, across, y) => [frame.x(along, across), y, frame.z(along, across)];
  /** Where (m along) the face drops below `height` at `across`, or null. */
  const faceAt = (across, height) => {
    for (let along = -FACE_SEARCH; along <= FACE_SEARCH; along += 0.5) if (heightAt(along, across) < height) return along;
    return null;
  };
  /** Floor of a footprint: the highest and lowest ground at its corners and centre. */
  const footprint = (along, across, halfAlong, halfAcross) => {
    let high = -Infinity;
    let low = Infinity;
    for (const [da, dc] of [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const ground = heightAt(along + da * halfAlong, across + dc * halfAcross);
      if (ground > high) high = ground;
      if (ground < low) low = ground;
    }
    return { high, low };
  };
  const torch = (x, y, z, size, autoLight) => out.torches.push({ x, y, z, size, autoLight });

  // ---- The main hall, with a gilded lantern hall on its roof ----
  const hallWidth = roll([24, 30], rng);
  const hallDepth = roll([14, 17], rng);
  const hallHeight = roll([10, 12.5], rng);
  const hallAlong = -(hallDepth / 2 + 7);
  const hallGround = footprint(hallAlong, 0, hallDepth / 2, hallWidth / 2);
  const hallBase = hallGround.high - hallGround.low + 0.6;
  const [hallX, , hallZ] = point(hallAlong, 0, 0);
  addWhiteHall(body, hallX, hallGround.high, hallZ, yaw, { width: hallWidth, depth: hallDepth, height: hallHeight, random: rng, base: hallBase });
  const roofY = hallGround.high + hallHeight + 0.5;
  out.colliders.push(localBox('hall', hallX, hallGround.high + (hallHeight - hallBase) / 2 + 0.25, hallZ, hallWidth + 0.6, hallHeight + hallBase + 0.5, hallDepth + 0.6, yaw, {
    surface: 'stone', landable: true, perch: { x: hallX, y: roofY, z: hallZ },
  }));
  const lanternWidth = hallWidth * 0.42;
  const lanternDepth = hallDepth * 0.5;
  addWhiteHall(body, hallX, roofY, hallZ, yaw, { width: lanternWidth, depth: lanternDepth, height: 4.2, random: rng, windows: true });
  addHipRoof(body, hallX, roofY + 4.7, hallZ, yaw, lanternWidth / 2, lanternDepth / 2, 2.6, 1.2, HERITAGE.gold);
  out.colliders.push(localBox('lantern', hallX, roofY + 3.5, hallZ, lanternWidth + 2.4, 7, lanternDepth + 2.4, yaw, { surface: 'stone', perch: { x: hallX, y: roofY + 7.4, z: hallZ } }));
  // Gilded finials on the main roof's corners.
  for (const [da, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const [fx, , fz] = point(hallAlong + da * (hallDepth / 2 - 0.6), dc * (hallWidth / 2 - 0.6), 0);
    detail.setPaint(HERITAGE.gold).lathe(fx, roofY, fz, [[0.25, 0], [0.45, 0.6], [0.3, 1.4], [0, 1.9]], 6, { closeBottom: true });
  }
  detail.setPaint(HERITAGE.goldBright).lathe(hallX, roofY + 7.3, hallZ, [[0.35, 0], [0.5, 0.5], [0.2, 1.4], [0, 2]], 6, { closeBottom: true });

  // The terrace between the hall and the lip, with butter lamps and two braziers at the edge.
  for (const side of [-1, 1]) {
    const [lx, , lz] = point(-5.5, side * 8, 0);
    torch(lx, addTorchPost(detail, lx, heightAt(-5.5, side * 8), lz, 1.3), lz, 0.9, true);
    const [bx, , bz] = point(-3.2, side * 19, 0);
    torch(bx, addTorchPost(detail, bx, heightAt(-3.2, side * 19), bz, 0.7), bz, 1.3, false);
  }

  // ---- The chorten ----
  if (withChorten) {
    const chortenAlong = -30 - hallDepth * 0.3;
    const chortenAcross = hallWidth / 2 + 12;
    const [cx, , cz] = point(chortenAlong, chortenAcross, 0);
    const ground = footprint(chortenAlong, chortenAcross, 4, 4);
    const base = ground.high;
    const stone = pick(HERITAGE.whitewash, rng);
    let level = ground.low - 0.4;
    for (const [size, rise] of [[8, base - ground.low + 1.6], [6.6, 1.2], [5.4, 1.1]]) {
      body.setPaint(shade(stone, 0.96)).box(cx, level + rise / 2, cz, size, rise, size, yaw);
      level += rise;
    }
    body.setPaint(stone).lathe(cx, level, cz, [[2.2, 0], [2.7, 0.9], [2.6, 2.4], [1.9, 3.6], [0.9, 4.2], [0, 4.3]], 10, { closeBottom: true });
    const harmika = level + 4.1;
    body.setPaint(HERITAGE.kemar).box(cx, harmika + 0.6, cz, 1.4, 1.2, 1.4, yaw);
    body.setPaint(HERITAGE.gold).lathe(cx, harmika + 1.2, cz, [[0.75, 0], [0.55, 2.6], [0.3, 4.4], [0, 5.2]], 8, { closeBottom: true });
    detail.setPaint(HERITAGE.goldBright).lathe(cx, harmika + 6.3, cz, [[0.3, 0], [0.42, 0.35], [0, 0.9]], 6, { closeBottom: true });
    const tip = harmika + 7.2;
    out.colliders.push(localBox('chortenBase', cx, (ground.low + level) / 2, cz, 8, level - ground.low + 0.4, 8, yaw, { surface: 'stone' }));
    out.colliders.push(localCylinder('chortenDome', cx, level, cz, 2.75, 4.3, { surface: 'stone' }));
    out.colliders.push(localCapsule('chortenSpire', cx, harmika, cz, cx, tip - 0.4, cz, 0.7, { surface: 'metal', perch: { x: cx, y: tip, z: cz } }));
    for (const side of [-1, 1]) {
      const [tx, , tz] = point(chortenAlong - 5.5, chortenAcross + side * 3, 0);
      torch(tx, addTorchPost(detail, tx, heightAt(chortenAlong - 5.5, chortenAcross + side * 3), tz, 1.1), tz, 0.8, true);
    }
  }

  // ---- The bell pavilion ----
  let audio = point(-12, -hallWidth / 2 - 10, topY + 4);
  if (withBell) {
    const bellAlong = -12;
    const bellAcross = -(hallWidth / 2 + 10);
    const [px, , pz] = point(bellAlong, bellAcross, 0);
    const ground = footprint(bellAlong, bellAcross, 2.4, 2.4);
    const floor = ground.high;
    body.setPaint(pick(HERITAGE.limestone, rng)).box(px, (ground.low + floor) / 2 + 0.2, pz, 6, floor - ground.low + 0.8, 6, yaw);
    for (const [da, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const [postX, , postZ] = point(bellAlong + da * 2.2, bellAcross + dc * 2.2, 0);
      body.setPaint(HERITAGE.kemar).prism(postX, floor + 0.6, postZ, 6, 0.22, 0.2, 4.4);
    }
    addHipRoof(body, px, floor + 5, pz, yaw, 2.6, 2.6, 2.2, 1.1, HERITAGE.gold, 0.5);
    body.setPaint(BRONZE).lathe(px, floor + 2.4, pz, [[0.95, 0], [0.8, 0.4], [0.6, 1.4], [0.4, 1.8], [0, 1.95]], 10, { closeBottom: true });
    detail.setPaint(PALETTE.timberDark).beam(px, floor + 4.3, pz, px, floor + 5.1, pz, 0.12, 0.12);
    out.colliders.push(localBox('pavilion', px, floor + 3.6, pz, 6.6, 7.2, 6.6, yaw, { surface: 'wood', perch: { x: px, y: floor + 7.2, z: pz } }));
    const [brazierX, , brazierZ] = point(bellAlong - 4.5, bellAcross + 4.5, 0);
    torch(brazierX, addTorchPost(detail, brazierX, heightAt(bellAlong - 4.5, bellAcross + 4.5), brazierZ, 0.8), brazierZ, 1.2, false);
    audio = [px, floor + 3, pz];
  }

  // ---- The prayer pole ----
  const poleAlong = -38 - hallDepth * 0.2;
  const poleAcross = -(hallWidth / 2 + 4);
  const [poleX, , poleZ] = point(poleAlong, poleAcross, 0);
  const poleGround = heightAt(poleAlong, poleAcross);
  const poleHeight = roll([15, 19], rng);
  const poleTop = [poleX, poleGround + poleHeight, poleZ];
  body.setPaint(PALETTE.timber[0]).prism(poleX, poleGround - 0.5, poleZ, 6, 0.28, 0.16, poleHeight + 0.5);
  detail.setPaint(HERITAGE.gold).lathe(poleX, poleTop[1], poleZ, [[0.3, 0], [0.18, 0.7], [0, 1.1]], 6, { closeBottom: true });
  out.colliders.push(localCapsule('pole', poleX, poleGround, poleZ, poleX, poleTop[1], poleZ, 0.45, { surface: 'wood', perch: { x: poleX, y: poleTop[1] + 1, z: poleZ } }));

  // ---- The halls clinging to the face, their buttresses and the stairs down to them ----
  const anchors = [];
  for (let tier = 0; tier < hallCount; tier++) {
    const floor = topY - 14 - tier * TIER_STEP;
    if (floor < site.bottomY + FOOT_CLEARANCE) break;
    const across = (tier % 2 === 0 ? 1 : -1) * (12 + tier * 9 + rng() * 6);
    const face = faceAt(across, floor + 2);
    if (face === null) continue;
    const width = roll([13, 18], rng);
    const depth = roll([8, 10], rng);
    const height = roll([7, 8.5], rng);
    // Three metres of the hall are set into the rock; the rest stands out over the drop.
    const along = face + depth / 2 - 3;
    const [hx, , hz] = point(along, across, 0);
    addWhiteHall(body, hx, floor, hz, yaw, { width, depth, height, random: rng });
    addButtress(body, frame, along, across, floor, width, depth, rng);
    out.colliders.push(localBox('lowerHall', hx, floor + height / 2 + 0.25, hz, width + 0.6, height + 0.5, depth + 0.6, yaw, {
      surface: 'stone', landable: true, perch: { x: hx, y: floor + height + 0.6, z: hz },
    }));
    out.colliders.push(localHull('buttress', [
      point(face - 3, across - width / 2, floor), point(face - 3, across + width / 2, floor),
      point(face + depth - 3, across - width / 2, floor), point(face + depth - 3, across + width / 2, floor),
      point(face - 3, across - width / 2, floor - 15), point(face - 3, across + width / 2, floor - 15),
      point(face + 0.5, across - width / 2, floor - 15), point(face + 0.5, across + width / 2, floor - 15),
    ], { surface: 'stone' }));
    // A wall lamp either side of the door in the front face.
    for (const side of [-1, 1]) {
      const [lx, , lz] = point(face + depth - 2.6, across + side * 2.4, 0);
      torch(lx, floor + 2.6, lz, 0.6, true);
    }
    // The stair from the plateau edge down to the hall's roof: a timber flight with a rail.
    const from = point(-6, across - side(across) * (width / 2 + 2), topY + 0.3);
    from[1] = heightAt(-6, across - side(across) * (width / 2 + 2)) + 0.3;
    const to = point(along, across - side(across) * (width / 2 - 1), floor + height + 0.5);
    addStair(detail, body, from, to);
    out.colliders.push(localCapsule('stair', from[0], from[1], from[2], to[0], to[1], to[2], 0.9, { surface: 'wood' }));
    anchors.push({ roof: [hx, floor + height + 0.6, hz], across, width, depth, along });
  }

  // ---- Prayer flags ----
  const edgePosts = [];
  for (let index = 0; index < 6; index++) {
    const across = -48 + index * 19 + (rng() - 0.5) * 6;
    const along = -3.5;
    const ground = heightAt(along, across);
    const [ex, , ez] = point(along, across, 0);
    detail.setPaint(PALETTE.timberDark).prism(ex, ground - 0.3, ez, 5, 0.1, 0.08, 4.3);
    edgePosts.push([ex, ground + 4, ez]);
  }
  const hallCorners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([da, dc]) => point(hallAlong + da * hallDepth / 2, dc * hallWidth / 2, roofY + 0.8));
  const nearestPost = (across) => edgePosts[Math.min(edgePosts.length - 1, Math.max(0, Math.round((across + 48) / 19)))];
  // The strings down to the lower halls always fly; the rest are drawn in a seeded order.
  const required = anchors.map((hall) => [nearestPost(hall.across), hall.roof]);
  const optional = [
    ...edgePosts.map((post) => [poleTop, post]),
    ...hallCorners.map((corner) => [poleTop, corner]),
    ...edgePosts.slice(0, -1).map((post, index) => [post, edgePosts[index + 1]]),
    ...hallCorners.slice(2).map((corner, index) => [corner, edgePosts[index * 3 + 1]]),
  ];
  for (let index = optional.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [optional[index], optional[other]] = [optional[other], optional[index]];
  }
  const pairs = [...required, ...optional.slice(0, Math.max(0, stringCount - required.length))];
  for (const [from, to] of pairs) {
    const span = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    addFlagString(cloth, detail, from, to, {
      count: Math.max(4, Math.round(Math.min(roll(flagRange, rng), span / 0.7))),
      sag: span * (0.04 + rng() * 0.03),
    });
  }
  // The pole's own tall banner.
  const bannerTop = poleTop[1] - 1.2;
  const bannerFrom = [poleX + frame.rightX * 1.0, bannerTop, poleZ + frame.rightZ * 1.0];
  addFlagString(cloth, detail, [poleX, bannerTop, poleZ], bannerFrom, { count: 1, sag: 0, flagWidth: 0.9, flagHeight: poleHeight * 0.55, ropeWidth: 0.04 });

  // ---- A few pines on the plateau behind the buildings ----
  for (let index = 0; index < pineCount; index++) {
    const along = -60 - rng() * 70;
    const across = (rng() - 0.5) * 130;
    const [tx, , tz] = point(along, across, 0);
    const ground = heightAt(along, across);
    const height = roll([8, 15], rng);
    addPine(body, tx, ground, tz, height, rng);
    out.colliders.push(localCapsule('pine', tx, ground, tz, tx, ground + height * 0.85, tz, height * 0.05 + 0.25, { surface: 'foliage' }));
  }

  out.audioPoint = audio;
  out.windProbe = [hallX, roofY, hallZ];
  out.radius = Math.max(out.radius, 110);
}

/** -1 or 1: the side of the site's centre line a stretch across lies on. */
function side(across) {
  return across >= 0 ? 1 : -1;
}

/**
 * The cliff frame: the site frame on the cliffStep stamp's lip (heights from the terrain), or a basalt
 * cliff of its own across the heading for a debug spawn (heights from that wall).
 */
function buildFrame(context, read) {
  const stamp = findStamp(context.site, 'cliffStep', read.number('stamp', 0, 0, 16));
  if (stamp) {
    const frame = createSiteFrame(stamp.lipX - context.anchor.x, stamp.lipZ - context.anchor.z, stamp.dirX, stamp.dirZ);
    return {
      frame,
      bottomY: stamp.bottomY - context.anchor.y,
      heightAt: (along, across) => context.ground(frame.x(along, across), frame.z(along, across)),
    };
  }
  const heading = frameFromHeading(context.heading);
  const frame = createSiteFrame(0, 0, heading.forwardX, heading.forwardZ);
  const drop = read.number('drop', MONASTERY_DEFAULTS.drop, 40, 300);
  const width = read.number('width', MONASTERY_DEFAULTS.width, 80, 800);
  const groundY = context.ground(0, 0);
  const depth = 160;
  context.body.setPaint(BASALT).box(frame.x(-depth / 2, 0), groundY + drop / 2 - 3, frame.z(-depth / 2, 0), width, drop + 6, depth, frame.yaw);
  context.out.colliders.push(localBox('cliff', frame.x(-depth / 2, 0), groundY + drop / 2 - 3, frame.z(-depth / 2, 0), width, drop + 6, depth, frame.yaw, { surface: 'stone', landable: true }));
  const top = groundY + drop + 3;
  return {
    frame,
    bottomY: groundY,
    heightAt: (along, across) => (along <= 0 && along >= -depth && Math.abs(across) <= width / 2 ? top : context.ground(frame.x(along, across), frame.z(along, across))),
  };
}

/**
 * The masonry buttress under a hall clinging to the face: its top the hall's footprint, its front
 * sloping back into the rock 15 m down.
 */
function addButtress(body, frame, along, across, floor, width, depth, random) {
  const front = along - depth / 2;
  const back = along + depth / 2;
  const half = width / 2;
  const p = (a, c, y) => [frame.x(a, across + c), y, frame.z(a, across + c)];
  // Downstream (out from the rock) is +along; the front face leans back toward the rock as it falls.
  const topFront = p(back, -half, floor);
  const topFrontR = p(back, half, floor);
  const footFront = p(front + 3.5, -half * 0.85, floor - 15);
  const footFrontR = p(front + 3.5, half * 0.85, floor - 15);
  const topBack = p(front, -half, floor);
  const topBackR = p(front, half, floor);
  const footBack = p(front, -half * 0.85, floor - 15);
  const footBackR = p(front, half * 0.85, floor - 15);
  const inside = p((front + back) / 2 - 1, 0, floor - 5);
  body.setPaint(shade(pick(HERITAGE.whitewash, random), 0.82));
  outwardQuad(body, topFront, footFront, footFrontR, topFrontR, inside);
  outwardQuad(body, topFrontR, footFrontR, footBackR, topBackR, inside);
  outwardQuad(body, topBack, footBack, footFront, topFront, inside);
  body.setPaint(HERITAGE.kemar);
  outwardQuad(body, footFront, footBack, footBackR, footFrontR, inside);
}

/** A timber stair from `from` to `to` (local points): stringers, treads and a rail on posts. */
function addStair(detail, body, from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const horizontal = Math.sqrt(dx * dx + dz * dz) || 1;
  const sideX = (-dz / horizontal) * 0.8;
  const sideZ = (dx / horizontal) * 0.8;
  body.setPaint(PALETTE.timber[1]);
  for (const sign of [-1, 1]) {
    body.beam(from[0] + sideX * sign, from[1], from[2] + sideZ * sign, to[0] + sideX * sign, to[1], to[2] + sideZ * sign, 0.25, 0.4);
  }
  const steps = Math.max(4, Math.round(length / 0.9));
  detail.setPaint(PALETTE.timber[2]);
  for (let step = 1; step < steps; step++) {
    const share = step / steps;
    const x = from[0] + dx * share;
    const y = from[1] + dy * share;
    const z = from[2] + dz * share;
    detail.beam(x - sideX, y + 0.15, z - sideZ, x + sideX, y + 0.15, z + sideZ, 0.3, 0.08);
    if (step % 3 === 0) detail.beam(x + sideX, y, z + sideZ, x + sideX, y + 1.1, z + sideZ, 0.08, 0.08);
  }
  detail.setPaint(PALETTE.timberDark).beam(from[0] + sideX, from[1] + 1.1, from[2] + sideZ, to[0] + sideX, to[1] + 1.1, to[2] + sideZ, 0.07, 0.07);
}
