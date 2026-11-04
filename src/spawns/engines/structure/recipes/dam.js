// Recipe 'dam' (preset 57, the dam with an open spillway): a concrete gravity dam across a valley,
// holding back a reservoir (the site's basin stamp, filled by the preset's lake). The basin's berm
// lifts the down-valley side of its rim; the dam stands just outside that rim on a straight line
// tangent to it, its crest road running out to the valley sides, its downstream face falling steeply
// to the valley floor. In the middle the crest drops to an open spillway: the lake pours over its lip
// and down a chute between training walls into a stilling basin, white water and mist at its foot (the
// preset adds the spray and the rainbow), and a river runs on down the valley. Two intake towers stand
// in the lake with catwalks to the crest, a valve house sits on the crest, and lamps line it at night.
// The wall, the bridge over the spillway, the towers and the basin walls are solid; the crest is
// landable, the towers and the valve house are perches.
// Without a basin stamp (a debug spawn) the dam stands across the heading, `height` metres tall.
import { PALETTE } from '../palette.js';
import { findStamp, frameFromHeading } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';
import { localBox, localCylinder, localHull } from '../colliders.js';
import { createSiteFrame, outwardQuad } from '../heritage.js';
import { basinReach } from '../../../../world/stamps.js';

export const DAM_DEFAULTS = Object.freeze({
  stamp: 0,
  spillway: [26, 34],
  freeboard: 2.5,
  towers: true,
  height: 36,
  length: 220,
});

/** The crest road's least width (m), and the downstream face's fall per metre out (a 0.75 : 1 batter). */
const CREST_MIN = 7;
const FACE_FALL = 1 / 0.75;
/** Across samples along the crest (m), and the farthest the crest runs out each side. */
const COLUMN_STEP = 6;
const MAX_HALF_LENGTH = 320;
/**
 * The lip sits this far (m) under the lake, so the lake spills; on a basin it never sits below the rim
 * crest beside it (the berm the dam stands on), so the lip stays clear of the ground and the lake
 * brims a few decimetres under it.
 */
const LIP_DEPTH = 0.35;
const LIP_OVER_BERM = 0.15;
const WATER_LIFT = 0.45;
const BASIN_LENGTH = 34;
const RIVER_LENGTH = 220;
const CONCRETE = paint(0xbdb7ab);
const CONCRETE_LIGHT = paint(0xcac4b8);
const CONCRETE_DARK = paint(0x9c968b);
const ROAD = paint(0x5f5c58);
const LAMP = paint(0xffd9a0, 2.6);
const CHUTE_PAINT = Object.freeze([0.88, 0.94, 0.98]);
const RIVER_PAINT = Object.freeze([0.36, 0.55, 0.6]);

export function buildDam(context, read) {
  const { rng, body, detail, out } = context;
  const spillHalf = roll(read.range('spillway', DAM_DEFAULTS.spillway, 8, 120), rng) / 2;
  const freeboard = read.number('freeboard', DAM_DEFAULTS.freeboard, 0.5, 10);
  const withTowers = read.boolean('towers', DAM_DEFAULTS.towers);
  const stamp = findStamp(context.site, 'basin', read.number('stamp', 0, 0, 16));

  // ---- The frame (along: down the valley; across: to its right), the crest and the lake level ----
  let frame;
  let crestY;
  let level;
  let wallAlong;
  let rimAlong = () => -Infinity;
  let bermY;
  if (stamp) {
    frame = createSiteFrame(stamp.x - context.anchor.x, stamp.z - context.anchor.z, stamp.dirX, stamp.dirZ);
    const rimY = stamp.rimY - context.anchor.y;
    const water = Array.isArray(context.site.waters) ? context.site.waters.find((body) => body.basin === stamp) ?? null : null;
    level = water ? water.level - context.anchor.y : rimY - Math.min(1, (stamp.rimY - stamp.floorY) * 0.03);
    crestY = rimY + freeboard;
    bermY = rimY;
    // Where the lobed shoreline crosses the across line c, downstream of the centre (-Infinity: it does not).
    rimAlong = (across) => {
      const reach = (along) => basinReach(stamp, context.anchor.x + frame.x(along, across), context.anchor.z + frame.z(along, across));
      if (reach(0) >= stamp.radius) return -Infinity;
      let low = 0;
      let high = stamp.radius * 1.3;
      for (let iteration = 0; iteration < 28; iteration++) {
        const middle = (low + high) / 2;
        if (reach(middle) < stamp.radius) low = middle;
        else high = middle;
      }
      return low;
    };
    wallAlong = rimAlong(0) + 1;
  } else {
    const heading = frameFromHeading(context.heading);
    frame = createSiteFrame(0, 0, heading.forwardX, heading.forwardZ);
    crestY = context.ground(0, 0) + read.number('height', DAM_DEFAULTS.height, 10, 200);
    level = crestY - freeboard - 0.6;
    bermY = -Infinity;
    wallAlong = 0;
  }
  const lipY = Math.max(level - LIP_DEPTH, bermY + LIP_OVER_BERM);
  const groundAt = (along, across) => context.ground(frame.x(along, across), frame.z(along, across));
  const at = (along, across, y) => [frame.x(along, across), y, frame.z(along, across)];

  // How far the crest runs out each side: until the valley side rises to it (or the longest crest).
  const halfLength = (sign) => {
    if (!stamp) return read.number('length', DAM_DEFAULTS.length, 40, 1200) / 2;
    for (let across = spillHalf + COLUMN_STEP; across < MAX_HALF_LENGTH; across += 2) {
      if (groundAt(wallAlong, sign * across) >= crestY - 0.5) return across + 4;
    }
    return MAX_HALF_LENGTH;
  };
  let leftEnd = halfLength(-1);
  let rightEnd = halfLength(1);
  // The whole wall stands outside the shoreline: move it out past the rim's farthest reach along it.
  if (stamp) {
    let farthest = wallAlong - 1;
    for (let across = -leftEnd; across <= rightEnd; across += 4) farthest = Math.max(farthest, rimAlong(across));
    wallAlong = farthest + 1;
    leftEnd = halfLength(-1);
    rightEnd = halfLength(1);
  }

  // ---- The columns across the wall: the top (crest or lip), the crest's width over the berm, the toe ----
  const columns = [];
  const addColumn = (across, top) => {
    // The crest covers the berm's flat top; the face starts where the berm begins to fall.
    let downstream = wallAlong + CREST_MIN;
    if (stamp) while (downstream < wallAlong + 40 && groundAt(downstream, across) > bermY - 1) downstream += 1;
    let toeAlong = downstream;
    let toeY = top;
    for (let step = 0; step <= 260; step++) {
      const along = downstream + step;
      const faceY = top - step * FACE_FALL;
      const ground = groundAt(along, across);
      toeAlong = along;
      toeY = faceY;
      if (faceY <= ground) break;
    }
    const upstreamGround = groundAt(wallAlong - 1, across);
    const bottom = Math.min(upstreamGround, level - 4) - 1.5;
    columns.push({ across, top, downstream, toeAlong, toeY: toeY - 1.5, bottom });
  };
  const crestColumns = (from, to) => {
    const steps = Math.max(1, Math.round(Math.abs(to - from) / COLUMN_STEP));
    for (let step = 0; step <= steps; step++) addColumn(from + (to - from) * (step / steps), crestY);
  };
  crestColumns(-leftEnd, -spillHalf);
  const spillSteps = Math.max(2, Math.round((spillHalf * 2) / COLUMN_STEP));
  for (let step = 0; step <= spillSteps; step++) addColumn(-spillHalf + (spillHalf * 2) * (step / spillSteps), lipY);
  crestColumns(spillHalf, rightEnd);

  // ---- The wall: crest (or lip) top, upstream face, downstream face, end caps ----
  for (let index = 0; index + 1 < columns.length; index++) {
    const a = columns[index];
    const b = columns[index + 1];
    if (Math.abs(b.across - a.across) < 1e-6) continue;
    const middle = (a.across + b.across) / 2;
    const spill = a.top === lipY && b.top === lipY;
    const insideTop = at((wallAlong + a.downstream) / 2, middle, Math.min(a.top, b.top) - 1);
    body.setPaint(spill ? CONCRETE_LIGHT : ROAD);
    outwardQuad(body, at(wallAlong, a.across, a.top), at(a.downstream, a.across, a.top), at(b.downstream, b.across, b.top), at(wallAlong, b.across, b.top), insideTop);
    body.setPaint(index % 2 === 0 ? CONCRETE : shade(CONCRETE, 0.95));
    outwardQuad(body, at(a.downstream, a.across, a.top), at(a.toeAlong, a.across, a.toeY), at(b.toeAlong, b.across, b.toeY), at(b.downstream, b.across, b.top), at(wallAlong + 1, middle, Math.min(a.top, b.top) - 3));
    body.setPaint(CONCRETE_DARK);
    outwardQuad(body, at(wallAlong, a.across, a.top), at(wallAlong, a.across, a.bottom), at(wallAlong, b.across, b.bottom), at(wallAlong, b.across, b.top), at(wallAlong + 2, middle, (a.top + a.bottom) / 2));
  }
  for (const end of [columns[0], columns[columns.length - 1]]) {
    const inside = at(wallAlong + 2, end.across, (end.top + end.bottom) / 2);
    body.setPaint(CONCRETE_DARK);
    outwardQuad(body, at(wallAlong, end.across, end.top), at(end.downstream, end.across, end.top), at(end.toeAlong, end.across, end.toeY), at(wallAlong, end.across, end.bottom), inside);
  }
  // Step faces where the crest drops to the lip, under the training walls.
  for (let index = 0; index + 1 < columns.length; index++) {
    const a = columns[index];
    const b = columns[index + 1];
    if (Math.abs(b.across - a.across) > 1e-6) continue;
    const high = a.top > b.top ? a : b;
    const low = a.top > b.top ? b : a;
    body.setPaint(CONCRETE_DARK);
    outwardQuad(body, at(wallAlong, high.across, high.top), at(high.downstream, high.across, high.top), at(low.downstream, low.across, low.top), at(wallAlong, low.across, low.top), at(wallAlong + 2, high.across - Math.sign(high.across) * 2, low.top - 1));
  }
  // The wall's colliders: hulls of the sections, a few columns at a time.
  const wallTags = { surface: 'stone', landable: true };
  let group = [];
  let groupIndex = 0;
  const flush = () => {
    if (group.length < 2) return;
    const points = [];
    for (const column of group) {
      points.push(at(wallAlong, column.across, column.top), at(column.downstream, column.across, column.top), at(column.toeAlong, column.across, column.toeY), at(wallAlong, column.across, column.bottom));
    }
    out.colliders.push(localHull(`wall${groupIndex}`, points, wallTags));
    groupIndex++;
  };
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    if (group.length > 0 && group[group.length - 1].top !== column.top) {
      flush();
      group = [];
    }
    group.push(column);
    if (group.length === 5) {
      flush();
      group = [column];
    }
  }
  flush();

  // ---- The crest: parapets and lamps (not over the spillway), the bridge over the spillway ----
  const crestRun = (from, to) => {
    for (const edge of [wallAlong + 0.3, wallAlong + CREST_MIN - 0.3]) {
      detail.setPaint(CONCRETE_LIGHT).beam(...at(edge, from, crestY + 0.55), ...at(edge, to, crestY + 0.55), 0.4, 1.1);
    }
  };
  crestRun(-leftEnd, -spillHalf - 1);
  crestRun(spillHalf + 1, rightEnd);
  for (let across = -leftEnd + 10; across < rightEnd - 6; across += 28) {
    if (Math.abs(across) < spillHalf + 3) continue;
    const [x, , z] = at(wallAlong + CREST_MIN - 0.6, across, 0);
    detail.setPaint(PALETTE.metalDark).prism(x, crestY, z, 5, 0.09, 0.07, 5.2);
    body.setPaint(LAMP).box(x, crestY + 5.3, z, 0.45, 0.3, 0.45);
  }
  const bridgeMid = at(wallAlong + CREST_MIN / 2, 0, crestY - 0.45);
  body.setPaint(CONCRETE).box(bridgeMid[0], bridgeMid[1], bridgeMid[2], CREST_MIN, 0.9, spillHalf * 2 + 2, frame.yaw + Math.PI / 2);
  for (const edge of [wallAlong + 0.3, wallAlong + CREST_MIN - 0.3]) {
    detail.setPaint(PALETTE.metalDark).beam(...at(edge, -spillHalf - 1, crestY + 0.5), ...at(edge, spillHalf + 1, crestY + 0.5), 0.12, 1);
  }
  out.colliders.push(localBox('bridge', bridgeMid[0], crestY - 0.2, bridgeMid[2], CREST_MIN, 1.4, spillHalf * 2 + 2, frame.yaw + Math.PI / 2, wallTags));
  // The bridge's piers stand on the lip, splitting the spillway into bays.
  const bays = Math.max(2, Math.round(spillHalf / 6));
  for (let pier = 1; pier < bays; pier++) {
    const across = -spillHalf + (spillHalf * 2) * (pier / bays);
    const [x, , z] = at(wallAlong + CREST_MIN / 2, across, 0);
    body.setPaint(CONCRETE).box(x, (lipY + crestY) / 2 - 0.6, z, CREST_MIN, crestY - lipY - 0.6, 1.4, frame.yaw + Math.PI / 2);
    out.colliders.push(localBox(`bay${pier}`, x, (lipY + crestY) / 2 - 0.6, z, CREST_MIN, crestY - lipY - 0.6, 1.4, frame.yaw + Math.PI / 2, { surface: 'stone' }));
  }

  // ---- The chute: training walls down the face, the stilling basin, the water ----
  const spillColumn = columns.find((column) => column.top === lipY && Math.abs(column.across) < COLUMN_STEP) ?? columns[Math.floor(columns.length / 2)];
  const chuteTop = spillColumn.downstream;
  const toeAlong = spillColumn.toeAlong;
  const toeY = spillColumn.toeY + 1.5;
  // Each training wall's section (along, y) is a convex hexagon: the crest, down the face above the
  // chute to the toe, and back under the chute's floor.
  const wallSection = [
    [wallAlong, crestY], [chuteTop, crestY], [toeAlong + 2, toeY + 2.8], [toeAlong + 2, toeY - 1], [chuteTop, lipY - 2], [wallAlong, lipY - 2],
  ];
  for (const sign of [-1, 1]) {
    const across = sign * (spillHalf + 0.6);
    const near = wallSection.map(([along, y]) => at(along, across - 0.6, y));
    const far = wallSection.map(([along, y]) => at(along, across + 0.6, y));
    const inside = at((wallAlong + toeAlong) / 2, across, (lipY + toeY) / 2);
    body.setPaint(CONCRETE_LIGHT);
    for (const side of [near, far]) {
      outwardQuad(body, side[0], side[1], side[4], side[5], inside);
      outwardQuad(body, side[1], side[2], side[3], side[4], inside);
    }
    for (let edge = 0; edge < wallSection.length; edge++) {
      const next = (edge + 1) % wallSection.length;
      outwardQuad(body, near[edge], near[next], far[next], far[edge], inside);
    }
    out.colliders.push(localHull(`trainingWall${sign < 0 ? 0 : 1}`, [...near, ...far], { surface: 'stone' }));
  }
  // The stilling basin: an apron, side walls and an end sill.
  const basinMid = toeAlong + BASIN_LENGTH / 2;
  const basinWidth = spillHalf * 2 + 4;
  const apron = at(basinMid, 0, toeY - 1.2);
  body.setPaint(CONCRETE_DARK).box(apron[0], apron[1], apron[2], basinWidth, 1.4, BASIN_LENGTH, frame.yaw);
  for (const sign of [-1, 1]) {
    const wall = at(basinMid, sign * (basinWidth / 2 + 0.6), toeY + 1);
    body.setPaint(CONCRETE).box(wall[0], wall[1], wall[2], 1.2, 4.4, BASIN_LENGTH, frame.yaw);
    out.colliders.push(localBox(`basinWall${sign < 0 ? 0 : 1}`, wall[0], wall[1], wall[2], 1.2, 4.4, BASIN_LENGTH, frame.yaw, { surface: 'stone' }));
  }
  const sill = at(toeAlong + BASIN_LENGTH, 0, toeY);
  body.setPaint(CONCRETE).box(sill[0], sill[1], sill[2], basinWidth, 1.6, 1.2, frame.yaw);
  // The water: the lake's approach to the lip, the chute down the face, the basin and the river.
  const halfWater = spillHalf - 0.2;
  const chute = [];
  const point = (along, y, paintValue, alpha, half = halfWater) => chute.push({ left: at(along, -half, y), right: at(along, half, y), paint: paintValue, alpha });
  point(wallAlong - 24, Math.max(level + 0.05, groundAt(wallAlong - 24, 0) + 0.15), RIVER_PAINT, 0);
  point(wallAlong - 6, Math.max(level + 0.05, groundAt(wallAlong - 6, 0) + 0.15), RIVER_PAINT, 0.55);
  point(wallAlong, lipY + 0.3, CHUTE_PAINT, 0.8);
  point(chuteTop, lipY + 0.2, CHUTE_PAINT, 0.85);
  const faceRows = 8;
  for (let row = 1; row <= faceRows; row++) {
    const along = chuteTop + (toeAlong - chuteTop) * (row / faceRows);
    point(along, lipY - (along - chuteTop) * FACE_FALL + WATER_LIFT, CHUTE_PAINT, 0.9);
  }
  point(toeAlong + 6, toeY + 0.9, CHUTE_PAINT, 0.9);
  point(toeAlong + BASIN_LENGTH, toeY + 0.9, RIVER_PAINT, 0.85);
  const riverSteps = 9;
  for (let step = 1; step <= riverSteps; step++) {
    const along = toeAlong + BASIN_LENGTH + RIVER_LENGTH * (step / riverSteps);
    const half = halfWater * (1 - 0.45 * (step / riverSteps));
    point(along, groundAt(along, 0) + WATER_LIFT, RIVER_PAINT, step === riverSteps ? 0 : 0.8, half);
  }
  waterRibbon(context.water, chute);
  // Mist where the chute meets the basin.
  for (let puff = 0; puff < 12; puff++) {
    const across = (rng() * 2 - 1) * spillHalf;
    const along = toeAlong + rng() * BASIN_LENGTH * 0.8;
    const rise = rng() * rng() * 18;
    const [x, , z] = at(along, across, 0);
    out.puffs.push({ x, y: toeY + 3 + rise, z, radius: 8 + rng() * 12 + rise * 0.3, brightness: 0.85 + rng() * 0.15 });
  }

  // ---- The intake towers with their catwalks, and the valve house ----
  if (withTowers && stamp) {
    for (const sign of [-1, 1]) {
      const across = sign * (spillHalf + 20);
      if (across < -leftEnd + 10 || across > rightEnd - 10) continue;
      const towerAlong = wallAlong - 16;
      const [x, , z] = at(towerAlong, across, 0);
      const base = Math.min(groundAt(towerAlong, across), level - 6) - 1;
      const top = crestY + 7;
      body.setPaint(CONCRETE).lathe(x, base, z, [[3.4, 0], [3.4, top - base - 4.5], [3.8, top - base - 4.2], [3.8, top - base]], 12, { closeTop: true });
      body.setPaint(paint(0x3d4a52)).lathe(x, top, z, [[4.1, 0], [2.4, 1.6], [0, 2.2]], 12, { closeBottom: true });
      body.setPaint(LAMP).box(x, top + 2.4, z, 0.5, 0.5, 0.5);
      out.colliders.push(localCylinder(`tower${sign < 0 ? 0 : 1}`, x, base, z, 4.1, top + 2.2 - base, { surface: 'stone', perch: { x, y: top + 2.4, z } }));
      detail.setPaint(PALETTE.metalDark).beam(...at(towerAlong + 3.4, across, crestY + 0.2), ...at(wallAlong, across, crestY + 0.2), 1.6, 0.35);
      for (const side of [-0.75, 0.75]) detail.beam(...at(towerAlong + 3.4, across + side, crestY + 1.2), ...at(wallAlong, across + side, crestY + 1.2), 0.06, 0.06);
    }
  }
  const houseAcross = Math.min(rightEnd - 12, spillHalf + 46);
  const house = at(wallAlong + CREST_MIN + 3.5, houseAcross, 0);
  const houseGround = Math.min(crestY, groundAt(wallAlong + CREST_MIN + 3.5, houseAcross));
  body.setPaint(CONCRETE_LIGHT).box(house[0], (houseGround + crestY + 4.5) / 2 - 0.5, house[2], 9, crestY + 4.5 - houseGround + 1, 6, frame.yaw);
  body.setPaint(paint(0x3d4a52)).box(house[0], crestY + 4.65, house[2], 9.6, 0.4, 6.6, frame.yaw);
  for (let window = 0; window < 3; window++) {
    const pane = at(wallAlong + CREST_MIN + 0.47, houseAcross - 3 + window * 3, crestY + 2.6);
    body.setPaint(paint(0xffd9a0, 1.2)).box(pane[0], pane[1], pane[2], 1.2, 1, 0.1, frame.yaw);
  }
  out.colliders.push(localBox('valveHouse', house[0], (houseGround + crestY + 4.8) / 2, house[2], 9.6, crestY + 4.8 - houseGround, 6.6, frame.yaw, { surface: 'stone', landable: true, perch: { x: house[0], y: crestY + 5, z: house[2] } }));

  const audio = at(toeAlong + 8, 0, toeY + 6);
  out.audioPoint = audio;
  out.windProbe = at(wallAlong, 0, crestY + 10);
  out.radius = Math.max(out.radius, Math.max(leftEnd, rightEnd) + 40, toeAlong - wallAlong + BASIN_LENGTH + 60);
}

/** A water ribbon through `points` ({ left, right, paint, alpha }), its streaks flowing toward the last. */
function waterRibbon(water, points) {
  let v = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const step = Math.hypot(to.left[0] - from.left[0], to.left[1] - from.left[1], to.left[2] - from.left[2]) / 30;
    const paintFrom = [from.paint[0], from.paint[1], from.paint[2], from.alpha];
    const paintTo = [to.paint[0], to.paint[1], to.paint[2], to.alpha];
    water.vertexQuad(
      { p: from.left, uv: [0, v], paint: paintFrom },
      { p: to.left, uv: [0, v + step], paint: paintTo },
      { p: to.right, uv: [1, v + step], paint: paintTo },
      { p: from.right, uv: [1, v], paint: paintFrom },
    );
    v += step;
  }
}
