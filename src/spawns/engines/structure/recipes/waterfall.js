// Recipe 'waterfall': a river that spills over the site's cliff step (the cliffStep stamp) as a wide
// curtain of falling water into the plunge pool, and runs on downstream. The curtain is split into
// strands of seeded widths that arc out from the lip on a ballistic path and fade into mist where
// they meet the pool; mist puffs gather at the foot, boulders split the strands at the lip and litter
// the pool's edge. The river upstream widens from the stamp's channel to the curtain at the lip.
// Without a cliffStep stamp (a debug spawn) the recipe raises its own basalt cliff `drop` metres high
// across the heading and pours the same curtain over it.
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
function stampFrame(context, stamp) {
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
  };
}

/** A free-standing cliff: a basalt wall across the heading, the river on its top, the pool at its foot. */
function freeFrame(context, read) {
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
function ribbon(water, points, colour) {
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
 * at a fixed height instead (the pool's outflow).
 */
function buildRiver(context, frame, fromAlong, toAlong, fromHalf, toHalf, level, fadeStart, fadeEnd) {
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
    points.push({ left: side(-1), right: side(1), v: (along - fromAlong) / 30, alpha });
  }
  ribbon(context.water, points, RIVER_PAINT);
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
  const frame = stamp ? stampFrame(context, stamp) : freeFrame(context, read);

  const curtainHalf = Math.max(frame.channel * 1.1, frame.width * spill * 0.5);
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
