// Recipe 'shipwreck': an old wooden sailing ship broken in two on a coral reef (preset 43). Its bow and
// stern halves lie in the reef's sand hollow (the `reef` stamp's pocket), listing hard over and half
// buried, the ribs bare at the break; the mainmast still stands at a slant with its top breaking the
// surface, the foremast is a stump and the mizzen lies fallen across the sand among cannon and
// barrels. The parts below the sea shade toward the water's depth colour (out.underwater), so the
// wreck reads through the clear shallows. Colliders: a hull for each half, capsules for the masts.
//
// Free-standing (no reef stamp) the wreck lies on whatever ground is under the anchor.
import { paint, shade } from '../meshBuilder.js';
import { PALETTE } from '../palette.js';
import { findStamp, pick } from '../common.js';
import { roll } from '../../engineKit.js';
import { builderFrame, localCapsule, localHull } from '../colliders.js';

export const SHIPWRECK_DEFAULTS = Object.freeze({
  length: [34, 46],
  beam: [9, 12],
  list: [18, 32],
  buried: [1.2, 2.2],
  gap: [6, 10],
  mastRise: [2.5, 4.5],
});

const WOOD = Object.freeze({
  hull: Object.freeze([paint(0x5a4634), paint(0x4d3c2e), paint(0x66503b)]),
  weed: paint(0x4f5e3a),
  rib: paint(0x6e5841),
  deck: paint(0x7a654c),
  copper: paint(0x5e8f7c),
  iron: paint(0x2f3133),
});
/** Stations along a half of the hull (share of the ship's length from the bow) and their half-beam shares. */
const STATIONS = Object.freeze([[0, 0.05], [0.08, 0.45], [0.2, 0.82], [0.35, 1], [0.5, 1], [0.65, 0.97], [0.8, 0.86], [0.92, 0.7], [1, 0.62]]);

export function buildShipwreck(context, read) {
  const { rng, body, detail, out } = context;
  const length = roll(read.range('length', SHIPWRECK_DEFAULTS.length, 10, 120), rng);
  const beam = roll(read.range('beam', SHIPWRECK_DEFAULTS.beam, 3, 30), rng);
  const list = roll(read.range('list', SHIPWRECK_DEFAULTS.list, 0, 60), rng) * (rng() < 0.5 ? -1 : 1) * (Math.PI / 180);
  const buried = roll(read.range('buried', SHIPWRECK_DEFAULTS.buried, 0, 6), rng);
  const gap = roll(read.range('gap', SHIPWRECK_DEFAULTS.gap, 0, 40), rng);
  const mastRise = roll(read.range('mastRise', SHIPWRECK_DEFAULTS.mastRise, 0.5, 20), rng);
  const reef = findStamp(context.site, 'reef', read.integer('stamp', 0, 0, 16));
  const anchor = context.anchor;
  const centreX = reef ? reef.x - anchor.x : 0;
  const centreZ = reef ? reef.z - anchor.z : 0;
  const floor = (reef ? reef.pocketY - anchor.y : context.ground(0, 0)) - buried;
  const sea = context.waterLevel;
  const heading = context.heading * (Math.PI / 180) + (rng() - 0.5) * 1.2;
  const depth = beam * 0.62;
  const halfLength = length / 2;

  // The two halves: the bow forward of the break, the stern aft of it, each twisted a little apart.
  const breakShare = 0.42 + rng() * 0.12;
  const halves = [
    { from: 0, to: breakShare, offset: -gap * 0.5, yaw: heading + (rng() - 0.5) * 0.25, roll: list },
    { from: breakShare, to: 1, offset: gap * 0.5, yaw: heading + (rng() - 0.5) * 0.25, roll: list * (0.8 + rng() * 0.4) },
  ];
  const forwardX = Math.sin(heading);
  const forwardZ = -Math.cos(heading);
  for (const half of halves) {
    const x = centreX - forwardX * half.offset;
    const z = centreZ - forwardZ * half.offset;
    const place = builderFrame(x, floor, z, half.yaw, 0, half.roll);
    body.setTransform(x, floor, z, half.yaw, 0, half.roll);
    const hullPoints = addHullHalf(body, rng, { length, halfLength, beam, depth, from: half.from, to: half.to, broken: half.from > 0 ? 'front' : 'back' });
    detail.setTransform(x, floor, z, half.yaw, 0, half.roll);
    addRibs(detail, { length, halfLength, beam, depth, at: half.from > 0 ? half.from : half.to, side: half.from > 0 ? 1 : -1 });
    out.colliders.push(localHull(half.from > 0 ? 'stern' : 'bow', hullPoints.map(place), { surface: 'wood' }));
  }
  body.resetTransform();
  detail.resetTransform();

  // The mainmast: standing from the stern half's deck at the list, its top breaking the surface.
  const stern = halves[1];
  const mastLocal = [0, depth, -halfLength + length * 0.6];
  const sternX = centreX - forwardX * stern.offset;
  const sternZ = centreZ - forwardZ * stern.offset;
  const mastFoot = builderFrame(sternX, floor, sternZ, stern.yaw, 0, stern.roll)(mastLocal);
  const tilt = stern.roll;
  const sideX = Math.cos(stern.yaw);
  const sideZ = Math.sin(stern.yaw);
  // The mast leans with the list (toward the hull's low side).
  const mastLength = Math.max(6, (sea + mastRise - mastFoot[1]) / Math.max(0.3, Math.cos(tilt)));
  const mastTop = [mastFoot[0] - sideX * Math.sin(tilt) * mastLength, mastFoot[1] + Math.cos(tilt) * mastLength, mastFoot[2] - sideZ * Math.sin(tilt) * mastLength];
  body.setPaint(WOOD.rib).beam(mastFoot[0], mastFoot[1], mastFoot[2], mastTop[0], mastTop[1], mastTop[2], 0.9, 0.9);
  // A yard across it under the water, and its broken top.
  const yardAt = 0.62;
  const yardX = mastFoot[0] + (mastTop[0] - mastFoot[0]) * yardAt;
  const yardY = mastFoot[1] + (mastTop[1] - mastFoot[1]) * yardAt;
  const yardZ = mastFoot[2] + (mastTop[2] - mastFoot[2]) * yardAt;
  body.setPaint(WOOD.hull[1]).beam(yardX - forwardX * beam * 0.9, yardY, yardZ - forwardZ * beam * 0.9, yardX + forwardX * beam * 0.7, yardY - 1.2, yardZ + forwardZ * beam * 0.7, 0.5, 0.5);
  out.colliders.push(localCapsule('mainmast', mastFoot[0], mastFoot[1], mastFoot[2], mastTop[0], mastTop[1], mastTop[2], 0.8, { surface: 'wood' }));

  // The foremast stump on the bow half, and the mizzen fallen across the sand.
  const bow = halves[0];
  const bowX = centreX - forwardX * bow.offset;
  const bowZ = centreZ - forwardZ * bow.offset;
  const stumpFoot = builderFrame(bowX, floor, bowZ, bow.yaw, 0, bow.roll)([0, depth, -halfLength + length * 0.22]);
  body.setPaint(WOOD.rib).beam(stumpFoot[0], stumpFoot[1], stumpFoot[2], stumpFoot[0] - sideX * 1.2, stumpFoot[1] + 4.5, stumpFoot[2] - sideZ * 1.2, 0.85, 0.85);
  const fallenAngle = heading + Math.PI * 0.5 + (rng() - 0.5) * 0.8;
  const fallenX = centreX + Math.sin(fallenAngle) * beam * 0.9;
  const fallenZ = centreZ - Math.cos(fallenAngle) * beam * 0.9;
  const fallenLength = length * 0.5;
  const fallenEndX = fallenX + Math.sin(fallenAngle) * fallenLength;
  const fallenEndZ = fallenZ - Math.cos(fallenAngle) * fallenLength;
  const fallenY = floor + buried + 0.4;
  const fallenEndY = (reef ? Math.max(floor + buried, reef.crestY - anchor.y - 0.6) : context.ground(fallenEndX, fallenEndZ)) + 0.4;
  body.setPaint(WOOD.rib).beam(fallenX, fallenY, fallenZ, fallenEndX, fallenEndY, fallenEndZ, 0.7, 0.7);
  out.colliders.push(localCapsule('mizzen', fallenX, fallenY, fallenZ, fallenEndX, fallenEndY, fallenEndZ, 0.6, { surface: 'wood' }));

  // Cannon, barrels and loose planks scattered on the sand.
  for (let prop = 0; prop < 14; prop++) {
    const angle = rng() * Math.PI * 2;
    const reach = beam * (0.8 + rng() * 2.2);
    const x = centreX + Math.sin(angle) * reach;
    const z = centreZ - Math.cos(angle) * reach;
    const y = floor + buried;
    if (prop % 3 === 0) {
      const yaw = rng() * Math.PI;
      detail.setPaint(WOOD.iron).beam(x, y + 0.3, z, x + Math.sin(yaw) * 2.6, y + 0.35, z - Math.cos(yaw) * 2.6, 0.45, 0.45);
    } else if (prop % 3 === 1) {
      detail.setPaint(pick(WOOD.hull, rng)).prism(x, y - 0.2, z, 7, 0.45, 0.4, 1.1, rng() * 6);
    } else {
      const yaw = rng() * Math.PI;
      detail.setPaint(WOOD.deck).box(x, y + 0.1, z, 0.35, 0.12, 3 + rng() * 3, yaw);
    }
  }
  out.underwater = true;
  out.audioPoint = [mastTop[0], sea + 1, mastTop[2]];
  out.radius = Math.max(out.radius, length);
}

/**
 * One half of the hull (stations from..to of the ship's length from the bow), in the half's frame
 * (origin at its keel line's middle, -z toward the bow): planked sides from the keel to the gunwale,
 * a broken deck, weed on the planks low down. Returns its collider points (local to the half's frame).
 */
function addHullHalf(builder, rng, { length, halfLength, beam, depth, from, to, broken }) {
  const sections = [];
  for (const [share, widthShare] of STATIONS) if (share >= from - 1e-6 && share <= to + 1e-6) sections.push([share, widthShare]);
  if (sections[0][0] > from) sections.unshift([from, interpolateWidth(from)]);
  if (sections[sections.length - 1][0] < to) sections.push([to, interpolateWidth(to)]);
  const ring = (share, widthShare) => {
    const z = -halfLength + share * length;
    const half = (beam / 2) * widthShare;
    // Keel, bilge, side, gunwale, mirrored.
    return [
      [0, 0, z], [half * 0.55, depth * 0.12, z], [half * 0.92, depth * 0.45, z], [half, depth, z],
      [-half, depth, z], [-half * 0.92, depth * 0.45, z], [-half * 0.55, depth * 0.12, z],
    ];
  };
  const rings = sections.map(([share, widthShare]) => ring(share, widthShare));
  for (let section = 0; section < rings.length - 1; section++) {
    const fore = rings[section];
    const aft = rings[section + 1];
    // Starboard side (indices 0..3) and port side (4..6, back to the keel): the planking outside, and
    // the dark inside of it (seen through the open break), each counter-clockwise from its own side.
    for (let edge = 0; edge < 7; edge++) {
      if (edge === 3) continue;
      const next = edge === 6 ? 0 : edge + 1;
      const planks = edge === 0 || edge === 6 ? WOOD.weed : pick(WOOD.hull, rng);
      builder.setPaint(planks).quad(fore[edge], fore[next], aft[next], aft[edge]);
      builder.setPaint(shade(planks, 0.5)).quad(fore[edge], aft[edge], aft[next], fore[next]);
    }
    // The deck, with planks missing.
    if (rng() > 0.35) builder.setPaint(shade(WOOD.deck, 0.9 + rng() * 0.2)).quad(fore[3], fore[4], aft[4], aft[3]);
  }
  // The intact end closed (the stern's transom facing aft, or the bow's stem facing forward); the
  // broken end stays open.
  builder.setPaint(WOOD.hull[2]);
  if (broken === 'front') {
    const end = rings[rings.length - 1];
    builder.quad(end[3], end[4], end[5], end[2]).quad(end[2], end[5], end[6], end[1]);
  } else {
    const end = rings[0];
    builder.quad(end[3], end[2], end[5], end[4]).quad(end[2], end[1], end[6], end[5]);
  }
  // The collider: the outer corners of the first and last sections (keel, bilges and gunwales).
  const first = rings[0];
  const last = rings[rings.length - 1];
  const middle = rings[Math.floor(rings.length / 2)];
  return [first, middle, last].flatMap((points) => [points[0], points[1], points[3], points[4], points[6]]);
}

/** The half-beam share at a station share between the table's stations. */
function interpolateWidth(share) {
  for (let index = 0; index < STATIONS.length - 1; index++) {
    const [a, widthA] = STATIONS[index];
    const [b, widthB] = STATIONS[index + 1];
    if (share >= a && share <= b) return widthA + (widthB - widthA) * ((share - a) / (b - a));
  }
  return STATIONS[STATIONS.length - 1][1];
}

/** Bare ribs at the break: frames standing out of the open end, some broken short. */
function addRibs(builder, { length, halfLength, beam, depth, at, side }) {
  const z = -halfLength + at * length;
  for (let rib = 0; rib < 5; rib++) {
    const ribZ = z + side * rib * 1.1;
    const half = (beam / 2) * interpolateWidth(Math.min(1, Math.max(0, at + side * rib * (1.1 / length))));
    const height = depth * (rib % 2 === 0 ? 1 : 0.6);
    builder.setPaint(WOOD.rib);
    builder.beam(0, 0, ribZ, half * 0.9, depth * 0.4, ribZ, 0.35, 0.35);
    builder.beam(half * 0.9, depth * 0.4, ribZ, half, height, ribZ, 0.3, 0.3);
    builder.beam(0, 0, ribZ, -half * 0.9, depth * 0.4, ribZ, 0.35, 0.35);
    builder.beam(-half * 0.9, depth * 0.4, ribZ, -half, height, ribZ, 0.3, 0.3);
  }
  builder.setPaint(PALETTE.timberDark).beam(0, 0.3, z - side * 0.5, 0, 0.3, z + side * 6, 0.7, 0.6);
}
