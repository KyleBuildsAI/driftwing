// Recipe 'waterfall': a river that spills over the site's cliff step (the cliffStep stamp) as a wide
// curtain of falling water into the plunge pool, and runs on downstream. The curtain is split into
// strands of seeded widths that arc out from the lip on a ballistic path and fade into mist where
// they meet the pool; mist puffs gather at the foot, boulders split the strands at the lip and litter
// the pool's edge. The river upstream widens from the stamp's channel to the curtain at the lip.
// Without a cliffStep stamp (a debug spawn) the recipe raises its own basalt cliff `drop` metres high
// across the heading and pours the same curtain over it.
//
// With `reverse` the water runs the other way (the reverse waterfall): the strands rise out of the
// pool, climb the cliff face, leave the lip and gather `column` metres out into a twisting column
// that climbs `rise` metres into the sky and fades into a cloud of mist; the river downstream flows
// toward the pool. The streaks scroll up the strands. The cliff frame and the ribbon helper are
// exported for the other cliff recipes (fallsWall).
import { PALETTE } from '../palette.js';
import { addBoulder, findStamp, frameFromHeading } from '../common.js';
import { paint } from '../meshBuilder.js';
import { rollInteger } from '../../engineKit.js';

export const WATERFALL_DEFAULTS = Object.freeze({
  stamp: 0,
  spill: 0.32,
  strands: [6, 9],
  launch: 4.5,
  river: true,
  riverWidth: 0.85,
  mist: true,
  boulders: [10, 16],
  drop: 120,
  width: 240,
  reverse: false,
  rise: 420,
  column: 46,
  columnRadius: 16,
});

const GRAVITY = 9.81;
/** Curtain rows from the lip to the pool, and how far above the pool surface the curtain stops (m). */
const CURTAIN_ROWS = 18;
/** The river and the curtain sit this far over the ground and the channel floor (m). */
const WATER_LIFT = 0.6;
const RIVER_STEP = 24;
const CURTAIN_PAINT = Object.freeze([0.86, 0.93, 0.98]);
const RIVER_PAINT = Object.freeze([0.4, 0.58, 0.66]);
const BASALT = paint(0x3e3a37);

/** The cliff frame: lip centre, downstream axis, top and pool levels, all in the site frame. */
export function stampFrame(context, stamp) {
  const across = { x: -stamp.dirZ, z: stamp.dirX };
  return {
    lipX: stamp.lipX - context.anchor.x,
    lipZ: stamp.lipZ - context.anchor.z,
    dirX: stamp.dirX,
    dirZ: stamp.dirZ,
    acrossX: across.x,
    acrossZ: across.z,
    topY: stamp.topY - context.anchor.y,
    poolY: stamp.bottomY - context.anchor.y - stamp.poolDepth * 0.6,
    halfFace: stamp.face / 2,
    width: stamp.width,
    channel: stamp.channelWidth,
    length: stamp.length,
    poolAlong: stamp.poolAlong,
    pool: stamp.pool,
    stamp,
  };
}

/** A free-standing cliff: a basalt wall across the heading, the river on its top, the pool at its foot. */
export function freeFrame(context, read) {
  const frame = frameFromHeading(context.heading);
  const drop = read.number('drop', WATERFALL_DEFAULTS.drop, 20, 400);
  const width = read.number('width', WATERFALL_DEFAULTS.width, 40, 1200);
  const groundY = context.ground(0, 0);
  const depth = 60;
  // The wall: its downstream face at the lip (along 0), reaching depth metres upstream.
  context.body.setPaint(BASALT).orientedBox(
    -frame.forwardX * depth * 0.5, groundY + drop * 0.5 - 2, -frame.forwardZ * depth * 0.5,
    frame.rightX * width * 0.5, 0, frame.rightZ * width * 0.5,
    0, drop * 0.5 + 2, 0,
    -frame.forwardX * depth * 0.5, 0, -frame.forwardZ * depth * 0.5,
  );
  return {
    lipX: 0,
    lipZ: 0,
    dirX: frame.forwardX,
    dirZ: frame.forwardZ,
    acrossX: frame.rightX,
    acrossZ: frame.rightZ,
    topY: groundY + drop,
    poolY: groundY + 0.4,
    halfFace: 0,
    width,
    channel: Math.max(10, width * 0.12),
    length: depth * 2,
    poolAlong: 30,
    pool: 40,
    freeStanding: true,
  };
}

/** A water ribbon quad strip: points [{ left, right, v, alpha }] in order downstream. */
export function ribbon(water, points, colour) {
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const paintFrom = [colour[0], colour[1], colour[2], from.alpha];
    const paintTo = [colour[0], colour[1], colour[2], to.alpha];
    water.vertexQuad(
      { p: from.left, uv: [0, from.v], paint: paintFrom },
      { p: to.left, uv: [0, to.v], paint: paintTo },
      { p: to.right, uv: [1, to.v], paint: paintTo },
      { p: from.right, uv: [1, from.v], paint: paintFrom },
    );
  }
}

/**
 * The river along the downstream axis from `fromAlong` to `toAlong` (site frame, metres from the lip),
 * its half width easing from `fromHalf` to `toHalf`, draped on the ground; `level` (or null) holds it
 * at a fixed height instead (the pool's outflow). flow -1 runs its streaks upstream (the reverse
 * waterfall's river, flowing into the pool).
 */
function buildRiver(context, frame, fromAlong, toAlong, fromHalf, toHalf, level, fadeStart, fadeEnd, flow = 1) {
  const length = Math.abs(toAlong - fromAlong);
  const steps = Math.max(2, Math.ceil(length / RIVER_STEP));
  const points = [];
  for (let step = 0; step <= steps; step++) {
    const share = step / steps;
    const along = fromAlong + (toAlong - fromAlong) * share;
    const half = fromHalf + (toHalf - fromHalf) * share;
    const centreX = frame.lipX + frame.dirX * along;
    const centreZ = frame.lipZ + frame.dirZ * along;
    const side = (sign) => {
      const x = centreX + frame.acrossX * half * sign;
      const z = centreZ + frame.acrossZ * half * sign;
      const centreGround = context.ground(centreX, centreZ);
      const y = level ?? Math.max(context.ground(x, z) * 0.35 + centreGround * 0.65, centreGround) + WATER_LIFT;
      return [x, y, z];
    };
    const alpha = 0.85 * Math.min(1, fadeStart ? share / 0.12 : 1, fadeEnd ? (1 - share) / 0.12 : 1);
    points.push({ left: side(-1), right: side(1), v: (flow * (along - fromAlong)) / 30, alpha });
  }
  ribbon(context.water, points, RIVER_PAINT);
}

/** smoothstep(edge0, edge1, value) for the column's blends. */
function smoothShare(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Rows of a rising strand on the cliff face, and above the lip in the column. */
const FACE_ROWS = 10;
const COLUMN_ROWS = 26;

/**
 * The reverse waterfall (params.reverse): strands rise from the pool up the face, leave the lip and
 * twist into a column `column` metres out that climbs `rise` metres before it fades into mist. Their v
 * coordinate grows upward, so the water material's streaks climb them.
 */
function buildReverseFalls(context, read, frame, curtainHalf, strands, launch, river, riverWidth, mist, boulderRange) {
  const { rng, out } = context;
  const rise = read.number('rise', WATERFALL_DEFAULTS.rise, 50, 2000);
  const column = read.number('column', WATERFALL_DEFAULTS.column, 10, 400);
  const columnRadius = read.number('columnRadius', WATERFALL_DEFAULTS.columnRadius, 2, 200);
  const lipAlong = -frame.halfFace;
  const lipY = frame.topY + (frame.freeStanding ? WATER_LIFT : -0.8);
  const drop = Math.max(10, lipY - frame.poolY);
  const faceRun = frame.halfFace * 2;
  const shares = [];
  let total = 0;
  for (let strand = 0; strand < strands; strand++) {
    const share = 0.6 + rng();
    shares.push(share);
    total += share;
  }
  const columnAlong = lipAlong + column;
  let cursor = -curtainHalf;
  for (let strand = 0; strand < strands; strand++) {
    const span = (shares[strand] / total) * curtainHalf * 2;
    const gap = strand === strands - 1 ? 0 : span * (0.05 + rng() * 0.08);
    const centreAcross = cursor + (span - gap) * 0.5;
    const halfWidth = (span - gap) * 0.5;
    cursor += span;
    const twist = rng() * Math.PI * 2;
    const turns = (1.6 + rng() * 0.8) * Math.PI * (rng() < 0.5 ? -1 : 1);
    const strandAlpha = 0.8 + rng() * 0.2;
    const point = (along, across) => [frame.lipX + frame.dirX * along + frame.acrossX * across, frame.lipZ + frame.dirZ * along + frame.acrossZ * across];
    const points = [];
    const veil = [];
    // Up the face: hugging it 1.5 m out, from the pool to the lip.
    for (let row = 0; row <= FACE_ROWS; row++) {
      const share = row / FACE_ROWS;
      const height = share * drop;
      const along = lipAlong + faceRun * (1 - share) + 1.5 + (1 - share) * launch * 0.4;
      const y = frame.poolY + height;
      const alpha = strandAlpha * Math.min(1, 0.25 + share * 3);
      const [lx, lz] = point(along, centreAcross - halfWidth);
      const [rx, rz] = point(along, centreAcross + halfWidth);
      points.push({ left: [lx, y, lz], right: [rx, y, rz], v: height / 30, alpha });
      const [vlx, vlz] = point(along - 1.6, centreAcross - halfWidth * 0.9);
      const [vrx, vrz] = point(along - 1.6, centreAcross + halfWidth * 0.9);
      veil.push({ left: [vlx, y, vlz], right: [vrx, y, vrz], v: height / 30 + 0.37, alpha: alpha * 0.5 });
    }
    // Above the lip: leaning out, gathering into the column and twisting round its axis as it climbs.
    for (let row = 1; row <= COLUMN_ROWS; row++) {
      const share = row / COLUMN_ROWS;
      const gather = smoothShare(0, 0.42, share);
      const angle = twist + turns * share;
      const radius = columnRadius * (1.25 - 0.55 * share);
      const faceAlong = lipAlong + 1.5 + share * 14;
      const along = faceAlong + (columnAlong + Math.cos(angle) * radius - faceAlong) * gather;
      const across = centreAcross + (Math.sin(angle) * radius - centreAcross) * gather;
      // The ribbon's width turns from across the cliff to the column's tangent.
      const widthAlong = -Math.sin(angle) * gather;
      const widthAcross = (1 - gather) + Math.cos(angle) * gather;
      const norm = Math.hypot(widthAlong, widthAcross) || 1;
      const half = halfWidth * (1 - 0.5 * gather);
      const offsetAlong = (widthAlong / norm) * half;
      const offsetAcross = (widthAcross / norm) * half;
      const height = drop + share * rise;
      const y = frame.poolY + height;
      const alpha = strandAlpha * (1 - smoothShare(0.62, 1, share));
      const [lx, lz] = point(along - offsetAlong, across - offsetAcross);
      const [rx, rz] = point(along + offsetAlong, across + offsetAcross);
      points.push({ left: [lx, y, lz], right: [rx, y, rz], v: height / 30, alpha });
    }
    ribbon(context.water, points, CURTAIN_PAINT);
    ribbon(context.water, veil, CURTAIN_PAINT);
  }

  // The river runs toward the pool (streaks upstream); the cliff top stays dry.
  if (river && !frame.freeStanding) {
    const outflowStart = frame.poolAlong + frame.pool * 0.7;
    buildRiver(context, frame, outflowStart, frame.length * 0.5, frame.channel * riverWidth * 1.1, frame.channel * riverWidth, null, true, true, -1);
  }

  const boulders = rollInteger(boulderRange, rng);
  for (let index = 0; index < boulders; index++) {
    const across = (rng() * 2 - 1) * (curtainHalf + frame.pool);
    const along = frame.poolAlong + (rng() * 2 - 1) * frame.pool * 1.2;
    if (Math.abs(across) < frame.pool * 0.6 && Math.abs(along - frame.poolAlong) < frame.pool * 0.6) continue;
    const x = frame.lipX + frame.dirX * along + frame.acrossX * across;
    const z = frame.lipZ + frame.dirZ * along + frame.acrossZ * across;
    addBoulder(context.body, x, context.ground(x, z), z, 2.5 + rng() * 6, rng, PALETTE.rockDeep);
  }

  if (mist) {
    // Spray where the strands leave the pool, and the cloud where the column fades.
    const footAlong = lipAlong + faceRun + 3;
    const footPuffs = 8 + Math.round(curtainHalf / 14);
    for (let puff = 0; puff < footPuffs; puff++) {
      const across = (rng() * 2 - 1) * curtainHalf * 1.05;
      out.puffs.push({
        x: frame.lipX + frame.dirX * (footAlong + rng() * 12) + frame.acrossX * across,
        y: frame.poolY + 3 + rng() * 10,
        z: frame.lipZ + frame.dirZ * (footAlong + rng() * 12) + frame.acrossZ * across,
        radius: 12 + rng() * 16,
        brightness: 0.85 + rng() * 0.15,
      });
    }
    const cloudPuffs = 16;
    for (let puff = 0; puff < cloudPuffs; puff++) {
      const angle = rng() * Math.PI * 2;
      const reach = columnRadius * (0.5 + rng() * 2.2);
      out.puffs.push({
        x: frame.lipX + frame.dirX * (columnAlong + Math.cos(angle) * reach) + frame.acrossX * Math.sin(angle) * reach,
        y: lipY + rise * (0.72 + rng() * 0.32),
        z: frame.lipZ + frame.dirZ * (columnAlong + Math.cos(angle) * reach) + frame.acrossZ * Math.sin(angle) * reach,
        radius: 26 + rng() * 30,
        brightness: 0.9 + rng() * 0.1,
      });
    }
  }
  out.audioPoint = [frame.lipX + frame.dirX * (lipAlong + faceRun), frame.poolY + 10, frame.lipZ + frame.dirZ * (lipAlong + faceRun)];
  out.radius = Math.max(out.radius, frame.length * 0.5 + curtainHalf, Math.hypot(frame.lipX, frame.lipZ) + frame.width * 0.5, column + columnRadius * 3);
}

export function buildWaterfall(context, read) {
  const { rng, out } = context;
  const stamp = findStamp(context.site, 'cliffStep', read.integer('stamp', WATERFALL_DEFAULTS.stamp, 0, 16));
  const spill = read.number('spill', WATERFALL_DEFAULTS.spill, 0.05, 0.95);
  const strandRange = read.range('strands', WATERFALL_DEFAULTS.strands, 1, 24);
  const launch = read.number('launch', WATERFALL_DEFAULTS.launch, 0, 30);
  const river = read.boolean('river', WATERFALL_DEFAULTS.river);
  const riverWidth = read.number('riverWidth', WATERFALL_DEFAULTS.riverWidth, 0.2, 1);
  const mist = read.boolean('mist', WATERFALL_DEFAULTS.mist);
  const boulderRange = read.range('boulders', WATERFALL_DEFAULTS.boulders, 0, 60);
  const reverse = read.boolean('reverse', WATERFALL_DEFAULTS.reverse);
  const frame = stamp ? stampFrame(context, stamp) : freeFrame(context, read);

  const curtainHalf = Math.max(frame.channel * 1.1, frame.width * spill * 0.5);
  if (reverse) {
    buildReverseFalls(context, read, frame, curtainHalf, rollInteger(strandRange, rng), launch, river, riverWidth, mist, boulderRange);
    return;
  }
  // The water's surface at the lip, and the drop to the pool.
  const lipAlong = -frame.halfFace;
  const lipY = frame.topY + (frame.freeStanding ? WATER_LIFT : -0.8);
  const drop = Math.max(10, lipY - frame.poolY);
  const fallSeconds = Math.sqrt((2 * drop) / GRAVITY);

  // The curtain: seeded strands across the lip with narrow gaps, each a ballistic ribbon.
  const strands = rollInteger(strandRange, rng);
  const shares = [];
  let total = 0;
  for (let strand = 0; strand < strands; strand++) {
    const share = 0.6 + rng();
    shares.push(share);
    total += share;
  }
  let cursor = -curtainHalf;
  for (let strand = 0; strand < strands; strand++) {
    const span = (shares[strand] / total) * curtainHalf * 2;
    const gap = strand === strands - 1 ? 0 : span * (0.04 + rng() * 0.08);
    const left = cursor;
    const right = cursor + span - gap;
    cursor += span;
    const speed = launch * (0.8 + rng() * 0.4);
    const strandAlpha = 0.82 + rng() * 0.18;
    const points = [];
    for (let row = 0; row <= CURTAIN_ROWS; row++) {
      const share = row / CURTAIN_ROWS;
      const time = share * fallSeconds;
      const outward = lipAlong + 1 + speed * time;
      const fall = 0.5 * GRAVITY * time * time;
      // Strands spread a little and thicken into spray as they fall.
      const spread = 1 + share * 0.12;
      const centre = (left + right) * 0.5;
      const half = ((right - left) * 0.5) * spread;
      const at = (offset) => [
        frame.lipX + frame.dirX * outward + frame.acrossX * (centre + offset),
        lipY - fall,
        frame.lipZ + frame.dirZ * outward + frame.acrossZ * (centre + offset),
      ];
      points.push({ left: at(-half), right: at(half), v: fall / 30, alpha: strandAlpha * Math.pow(1 - share * 0.78, 1.15) });
    }
    ribbon(context.water, points, CURTAIN_PAINT);
    // A second, thinner veil just behind each strand gives the curtain body.
    const veil = points.map((point) => ({
      left: [point.left[0] - frame.dirX * 2.5, point.left[1], point.left[2] - frame.dirZ * 2.5],
      right: [point.right[0] - frame.dirX * 2.5, point.right[1], point.right[2] - frame.dirZ * 2.5],
      v: point.v + 0.37,
      alpha: point.alpha * 0.55,
    }));
    ribbon(context.water, veil, CURTAIN_PAINT);
  }

  // The river: upstream it widens from the channel to the curtain; downstream it leaves the pool.
  if (river) {
    const upstreamStart = -frame.length * 0.5;
    buildRiver(context, frame, upstreamStart, lipAlong, frame.channel * riverWidth, curtainHalf, null, true, false);
    if (!frame.freeStanding) {
      const outflowStart = frame.poolAlong + frame.pool * 0.7;
      buildRiver(context, frame, outflowStart, frame.length * 0.5, frame.channel * riverWidth * 1.1, frame.channel * riverWidth, null, true, true);
    }
  }

  // Boulders: a few at the lip between strands, more around the pool.
  const boulders = rollInteger(boulderRange, rng);
  for (let index = 0; index < boulders; index++) {
    const atLip = index < Math.ceil(boulders * 0.3);
    const across = atLip ? (rng() * 2 - 1) * curtainHalf * 1.25 : (rng() * 2 - 1) * (curtainHalf + frame.pool);
    const along = atLip ? lipAlong - 2 - rng() * 6 : frame.poolAlong + (rng() * 2 - 1) * frame.pool * 1.2;
    if (!atLip && Math.abs(across) < frame.pool * 0.6 && Math.abs(along - frame.poolAlong) < frame.pool * 0.6) continue;
    const x = frame.lipX + frame.dirX * along + frame.acrossX * across;
    const z = frame.lipZ + frame.dirZ * along + frame.acrossZ * across;
    addBoulder(context.body, x, context.ground(x, z), z, 2.5 + rng() * (atLip ? 3 : 6), rng, PALETTE.rockDeep);
  }

  // Mist: puffs where the curtain meets the pool, rising up its foot.
  const footAlong = lipAlong + 1 + launch * fallSeconds;
  if (mist) {
    const puffCount = 10 + Math.round(curtainHalf / 12);
    for (let puff = 0; puff < puffCount; puff++) {
      const across = (rng() * 2 - 1) * curtainHalf * 1.1;
      const along = footAlong + (rng() - 0.3) * 20;
      const rise = rng() * rng() * drop * 0.45;
      out.puffs.push({
        x: frame.lipX + frame.dirX * along + frame.acrossX * across,
        y: frame.poolY + 4 + rise,
        z: frame.lipZ + frame.dirZ * along + frame.acrossZ * across,
        radius: 14 + rng() * 22 + rise * 0.15,
        brightness: 0.85 + rng() * 0.15,
      });
    }
  }
  out.audioPoint = [frame.lipX + frame.dirX * footAlong, frame.poolY + 10, frame.lipZ + frame.dirZ * footAlong];
  out.radius = Math.max(out.radius, frame.length * 0.5 + curtainHalf, Math.hypot(frame.lipX, frame.lipZ) + frame.width * 0.5);
}
