// Recipe 'fallsWall': a long cliff (the site's cliffStep stamp) hung with many thin waterfalls, the
// challenge of threading the gaps between them. `falls` ribbons pour off the lip `spacing` metres
// apart, centred on the site, each fed by a short stream over the cliff top and arcing out on a
// ballistic path into mist at the foot, with boulders scattered below (sphere colliders). Each fall
// drags a column of sinking air down its own arc (out.falls: the engine's WindField source follows
// the arcs exactly, `sink` m/s on the arc fading over `curtain` metres), so the gaps stay clear. The course is the preset's `challenge` block as it
// stands (the gates in the site frame, heights above the ground under them): authored in the gaps,
// alternately crossing in behind the falls and out again. Without a cliffStep stamp (a debug spawn)
// the recipe raises its own basalt cliff across the heading, as the waterfall recipe does.
import { PALETTE } from '../palette.js';
import { addBoulder, findStamp } from '../common.js';
import { localSphere } from '../colliders.js';
import { courseFromBlock } from '../courseKit.js';
import { freeFrame, ribbon, stampFrame } from './waterfall.js';
import { rollInteger } from '../../engineKit.js';

export const FALLS_WALL_DEFAULTS = Object.freeze({
  stamp: 0,
  falls: 10,
  spacing: 75,
  fallWidth: [11, 15],
  launch: 15,
  sink: 9,
  curtain: 18,
  streams: true,
  mist: true,
  boulders: [14, 22],
});

const GRAVITY = 9.81;
/** Rows of each fall from the lip to the foot, and of each feeding stream. */
const FALL_ROWS = 20;
const STREAM_ROWS = 6;
/** How far upstream (m) each feeding stream starts, and how far over the ground it lies (m). */
const STREAM_LENGTH = 46;
const WATER_LIFT = 0.6;
const FALL_PAINT = Object.freeze([0.86, 0.93, 0.98]);
const STREAM_PAINT = Object.freeze([0.4, 0.58, 0.66]);

/** The lip's wander (m along the downstream axis) at `across`, from the stamp's table; 0 without one. */
function lipWander(stamp, across) {
  if (!stamp || !stamp.lipTable) return 0;
  const table = stamp.lipTable;
  const position = across + stamp.lipOffset;
  const last = table.length - 1;
  if (position <= 0) return table[0];
  if (position >= last) return table[last];
  const index = Math.floor(position);
  return table[index] + (table[index + 1] - table[index]) * (position - index);
}

export function buildFallsWall(context, read) {
  const { rng, body, out } = context;
  const stamp = findStamp(context.site, 'cliffStep', read.integer('stamp', FALLS_WALL_DEFAULTS.stamp, 0, 16));
  const count = read.integer('falls', FALLS_WALL_DEFAULTS.falls, 2, 24);
  const spacing = read.number('spacing', FALLS_WALL_DEFAULTS.spacing, 20, 400);
  const fallWidth = read.range('fallWidth', FALLS_WALL_DEFAULTS.fallWidth, 2, 80);
  const launch = read.number('launch', FALLS_WALL_DEFAULTS.launch, 0, 40);
  const sink = read.number('sink', FALLS_WALL_DEFAULTS.sink, 0, 40);
  const curtain = read.number('curtain', FALLS_WALL_DEFAULTS.curtain, 2, 200);
  const streams = read.boolean('streams', FALLS_WALL_DEFAULTS.streams);
  const mist = read.boolean('mist', FALLS_WALL_DEFAULTS.mist);
  const boulderRange = read.range('boulders', FALLS_WALL_DEFAULTS.boulders, 0, 80);
  const frame = stamp ? stampFrame(context, stamp) : freeFrame(context, read);
  const lipY = frame.topY + (frame.freeStanding ? WATER_LIFT : -0.8);
  const drop = Math.max(10, lipY - frame.poolY);
  const fallSeconds = Math.sqrt((2 * drop) / GRAVITY);
  const at = (along, across, y) => [frame.lipX + frame.dirX * along + frame.acrossX * across, y, frame.lipZ + frame.dirZ * along + frame.acrossZ * across];
  const feet = [];
  const airs = [];

  for (let fall = 0; fall < count; fall++) {
    const across = (fall - (count - 1) / 2) * spacing;
    const half = (fallWidth[0] + (fallWidth[1] - fallWidth[0]) * rng()) * 0.5;
    const lipAlong = -frame.halfFace + lipWander(stamp, across);
    const speed = launch * (0.95 + rng() * 0.1);
    const alpha = 0.82 + rng() * 0.18;
    const points = [];
    for (let row = 0; row <= FALL_ROWS; row++) {
      const share = row / FALL_ROWS;
      const time = share * fallSeconds;
      const outward = lipAlong + 1 + speed * time;
      const fallen = 0.5 * GRAVITY * time * time;
      const spread = half * (1 + share * 0.16);
      points.push({ left: at(outward, across - spread, lipY - fallen), right: at(outward, across + spread, lipY - fallen), v: fallen / 30, alpha: alpha * Math.pow(1 - share * 0.75, 1.1) });
    }
    ribbon(context.water, points, FALL_PAINT);
    // A thinner veil behind the fall gives it body.
    ribbon(context.water, points.map((point) => ({
      left: [point.left[0] - frame.dirX * 2, point.left[1], point.left[2] - frame.dirZ * 2],
      right: [point.right[0] - frame.dirX * 2, point.right[1], point.right[2] - frame.dirZ * 2],
      v: point.v + 0.41,
      alpha: point.alpha * 0.5,
    })), FALL_PAINT);
    if (streams) {
      // The stream that feeds the fall, draped over the cliff top and widening to the lip.
      const stream = [];
      for (let row = 0; row <= STREAM_ROWS; row++) {
        const share = row / STREAM_ROWS;
        const along = lipAlong - STREAM_LENGTH * (1 - share);
        const width = half * (0.45 + 0.55 * share);
        const leftX = frame.lipX + frame.dirX * along + frame.acrossX * (across - width);
        const leftZ = frame.lipZ + frame.dirZ * along + frame.acrossZ * (across - width);
        const rightX = frame.lipX + frame.dirX * along + frame.acrossX * (across + width);
        const rightZ = frame.lipZ + frame.dirZ * along + frame.acrossZ * (across + width);
        const level = Math.max(context.ground(leftX, leftZ), context.ground(rightX, rightZ), lipY - 0.2) + WATER_LIFT * (1 - share);
        stream.push({ left: [leftX, level, leftZ], right: [rightX, level, rightZ], v: (along - lipAlong) / 30, alpha: 0.8 * Math.min(1, share * 4) });
      }
      ribbon(context.water, stream, STREAM_PAINT);
    }
    feet.push({ along: lipAlong + 1 + speed * fallSeconds, across, half });
    const [lipX, , lipZ] = at(lipAlong + 1, across, lipY);
    airs.push({ x: lipX, z: lipZ, speed });
  }

  // Mist where each fall meets the ground, rising a little up its foot.
  if (mist) {
    for (const foot of feet) {
      for (let puff = 0; puff < 4; puff++) {
        const [x, , z] = at(foot.along + (rng() - 0.4) * 10, foot.across + (rng() * 2 - 1) * foot.half * 1.4, 0);
        out.puffs.push({ x, y: frame.poolY + 4 + rng() * rng() * drop * 0.3, z, radius: 10 + rng() * 12, brightness: 0.85 + rng() * 0.15 });
      }
    }
  }

  // Boulders below the cliff, between and beyond the falls' feet.
  const boulders = rollInteger(boulderRange, rng);
  const wallHalf = ((count - 1) / 2) * spacing + spacing * 0.5;
  for (let index = 0; index < boulders; index++) {
    const across = (rng() * 2 - 1) * wallHalf;
    const along = frame.halfFace + 14 + rng() * 60;
    const [x, , z] = at(along, across, 0);
    const radius = 2.5 + rng() * 3.5;
    const ground = context.ground(x, z);
    addBoulder(body, x, ground, z, radius, rng, PALETTE.rockDeep);
    out.colliders.push(localSphere(`boulder${index}`, x, ground + radius * 0.35, z, radius * 0.95, { surface: 'stone' }));
  }

  // The sinking air in every fall, from the lip down its arc (the engine's 'structure-falls' source).
  if (sink > 0) {
    out.falls = { radius: curtain, sink, spill: sink * 0.5, spillReach: 40, turbulence: 0.55, gust: 3.5, gravity: GRAVITY, drop, lipY, dirX: frame.dirX, dirZ: frame.dirZ, list: airs };
  }
  courseFromBlock(context, read);
  const middle = feet[count >> 1];
  out.audioPoint = at(middle.along, middle.across, frame.poolY + 12);
  out.radius = Math.max(out.radius, wallHalf + 120, frame.length * 0.5);
}
