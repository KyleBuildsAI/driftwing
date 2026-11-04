// The path of a lava flow down a site's carve stamp, and on to the sea (preset 36, lava rivers to the
// sea; preset 37's fissure uses the channel part alone). The structure recipe 'lavaChannels' drapes
// the lava ribbon along this path, and the emitter's `seaEntry` param puts the steam where it meets
// the water, so both trace it with the same function and the same inputs and always agree.
//
// The path follows the carve's resolved centre line (stamp.path, from its uphill entry to its downhill
// exit) split into steps of at most `step` metres. With toSea it then runs on from the exit down the
// real (stamped) ground: each step goes to the lowest of seven headings within 75 degrees of the
// current one, so the flow keeps its direction but finds the fall line. Over a flat or a low rise it
// pushes straight on (lava piles up and overtops it) for up to STALL_STEPS steps, each climbing at
// most STALL_RISE metres. Held up longer, it looks for the sea within SEA_SNIFF metres around (a beach
// or a low bar between the flow and the water) and runs straight down to it. It stops where the
// ground drops below the sea (the sea entry: the path runs on a little way into the water, where the
// lava fans out), where it finds no sea (it ends in a lobe), or after `reach` metres.
//
// Pure: no imports and no DOM. Runs at create only (it allocates its result).

const DEG = Math.PI / 180;
/** The headings tried on each step beyond the carve, in degrees from the current heading. */
const TURNS = Object.freeze([-75, -50, -25, 0, 25, 50, 75]);
/** Steps in a row a flow may push on over ground that does not fall, and the most each may climb (m). */
const STALL_STEPS = 6;
const STALL_RISE = 1.5;
/** How far (m) past the shoreline the lava runs on into the sea. */
const SEA_RUN = 30;
/** A held-up flow looks this far (m) for the sea, on SNIFF_RAYS rays within 135 degrees of its heading. */
const SEA_SNIFF = 280;
const SNIFF_RAYS = 19;

/**
 * The nearest sea point within SEA_SNIFF of (x, z) within 135 degrees of the heading (a flow spreads
 * sideways, never back up its own channel): { x, z, distance } or null.
 */
function sniffSea(groundAt, waterLevel, x, z, headingX, headingZ, step) {
  for (let distance = step; distance <= SEA_SNIFF; distance += step) {
    for (let ray = 0; ray < SNIFF_RAYS; ray++) {
      const turn = (-135 + (270 * ray) / (SNIFF_RAYS - 1)) * DEG;
      const dirX = headingX * Math.cos(turn) - headingZ * Math.sin(turn);
      const dirZ = headingX * Math.sin(turn) + headingZ * Math.cos(turn);
      const seaX = x + dirX * distance;
      const seaZ = z + dirZ * distance;
      if (groundAt(seaX, seaZ) < waterLevel) return { x: seaX, z: seaZ, distance };
    }
  }
  return null;
}

/**
 * traceLavaPath(stamp, groundAt, waterLevel, options) -> { points, entry, end }.
 * stamp: a resolved carve stamp (its `path`: { x, z, halfWidth } from entry to exit). groundAt(x, z):
 * the world ground height (stamped, below the sea where the seabed is). options: toSea (default
 * true), step (m, default 20), reach (m beyond the carve, default 2500), spread (the lava's half width
 * grows to this many times the carve's on its way to the sea, default 1.6).
 * points: [{ x, z, halfWidth, carved }] in world metres, uphill first (carved: still in the channel);
 * entry: { x, z } where the flow meets the sea, or null; end: the path's last point.
 */
export function traceLavaPath(stamp, groundAt, waterLevel, options = {}) {
  const { toSea = true, step = 20, reach = 2500, spread = 1.6 } = options;
  if (!stamp || !Array.isArray(stamp.path) || stamp.path.length < 2) throw new Error('[DRIFTWING] traceLavaPath: needs a resolved carve stamp (its path)');
  const points = [];
  const path = stamp.path;
  for (let index = 0; index < path.length; index++) {
    const point = path[index];
    if (index > 0) {
      const previous = path[index - 1];
      const length = Math.hypot(point.x - previous.x, point.z - previous.z);
      const pieces = Math.max(1, Math.ceil(length / step));
      for (let piece = 1; piece < pieces; piece++) {
        const share = piece / pieces;
        points.push({
          x: previous.x + (point.x - previous.x) * share,
          z: previous.z + (point.z - previous.z) * share,
          halfWidth: previous.halfWidth + (point.halfWidth - previous.halfWidth) * share,
          carved: true,
        });
      }
    }
    points.push({ x: point.x, z: point.z, halfWidth: point.halfWidth, carved: true });
  }
  let entry = null;
  const exit = points[points.length - 1];
  if (groundAt(exit.x, exit.z) < waterLevel) entry = { x: exit.x, z: exit.z };
  if (toSea && entry === null) {
    const before = points[points.length - 2];
    let headingX = exit.x - before.x;
    let headingZ = exit.z - before.z;
    const length = Math.hypot(headingX, headingZ) || 1;
    headingX /= length;
    headingZ /= length;
    let x = exit.x;
    let z = exit.z;
    let ground = groundAt(x, z);
    const baseHalf = exit.halfWidth;
    const steps = Math.max(1, Math.floor(reach / step));
    let stalled = 0;
    for (let walked = 1; walked <= steps; walked++) {
      let bestX = 0;
      let bestZ = 0;
      let bestGround = Infinity;
      let bestDirX = headingX;
      let bestDirZ = headingZ;
      for (const turn of TURNS) {
        const cosine = Math.cos(turn * DEG);
        const sine = Math.sin(turn * DEG);
        // A compass turn (clockwise from above) of the heading (x east, z south).
        const dirX = headingX * cosine - headingZ * sine;
        const dirZ = headingX * sine + headingZ * cosine;
        const nextX = x + dirX * step;
        const nextZ = z + dirZ * step;
        const nextGround = groundAt(nextX, nextZ);
        if (nextGround < bestGround) {
          bestGround = nextGround;
          bestX = nextX;
          bestZ = nextZ;
          bestDirX = dirX;
          bestDirZ = dirZ;
        }
      }
      if (bestGround >= ground) {
        // Nothing falls: push straight on, over a flat or a low rise, for a few steps.
        const aheadX = x + headingX * step;
        const aheadZ = z + headingZ * step;
        const aheadGround = groundAt(aheadX, aheadZ);
        stalled++;
        if (stalled > STALL_STEPS || aheadGround - ground > STALL_RISE) {
          // Held up: the sea close ahead takes the flow straight down to it, else it ends here.
          const sea = sniffSea(groundAt, waterLevel, x, z, headingX, headingZ, step);
          if (sea === null) break;
          const runs = Math.ceil(sea.distance / step);
          const halfWidth = points[points.length - 1].halfWidth;
          for (let run = 1; run <= runs; run++) {
            const share = run / runs;
            points.push({ x: x + (sea.x - x) * share, z: z + (sea.z - z) * share, halfWidth, carved: false });
          }
          headingX = (sea.x - x) / sea.distance;
          headingZ = (sea.z - z) / sea.distance;
          entry = { x: sea.x, z: sea.z };
          points.push({ x: sea.x + headingX * SEA_RUN, z: sea.z + headingZ * SEA_RUN, halfWidth: halfWidth * 1.3, carved: false });
          break;
        }
        bestX = aheadX;
        bestZ = aheadZ;
        bestGround = aheadGround;
        bestDirX = headingX;
        bestDirZ = headingZ;
      } else {
        stalled = 0;
      }
      // The flow eases toward the fall line rather than snapping to it.
      headingX = headingX * 0.4 + bestDirX * 0.6;
      headingZ = headingZ * 0.4 + bestDirZ * 0.6;
      const norm = Math.hypot(headingX, headingZ) || 1;
      headingX /= norm;
      headingZ /= norm;
      x = bestX;
      z = bestZ;
      ground = bestGround;
      const share = Math.min(1, (walked * step) / Math.max(step, reach * 0.4));
      points.push({ x, z, halfWidth: baseHalf * (1 + (spread - 1) * share), carved: false });
      if (ground < waterLevel) {
        entry = { x, z };
        const runX = x + headingX * SEA_RUN;
        const runZ = z + headingZ * SEA_RUN;
        points.push({ x: runX, z: runZ, halfWidth: baseHalf * spread * 1.3, carved: false });
        break;
      }
    }
  }
  return { points, entry, end: points[points.length - 1] };
}

/** A stand-in channel (m) for a spawn with no carve stamp: a short straight start along the heading. */
const FALLBACK_LENGTH = 160;
const FALLBACK_HALF_WIDTH = 9;

/**
 * The carve stamps a lava flow runs down: every carve stamp of the site, in the site's order, or, for
 * a spawn without one (a debug spawn away from its site), one stand-in channel starting at (x, z) and
 * running FALLBACK_LENGTH metres along the compass heading (degrees). Each is a value traceLavaPath
 * takes.
 */
export function lavaSourceStamps(site, x, z, headingDegrees) {
  const carves = site && Array.isArray(site.stamps) ? site.stamps.filter((stamp) => stamp.type === 'carve' && Array.isArray(stamp.path)) : [];
  if (carves.length > 0) return carves;
  const angle = headingDegrees * DEG;
  const forwardX = Math.sin(angle);
  const forwardZ = -Math.cos(angle);
  return [{
    type: 'carve',
    path: [
      { x, z, halfWidth: FALLBACK_HALF_WIDTH },
      { x: x + forwardX * FALLBACK_LENGTH, z: z + forwardZ * FALLBACK_LENGTH, halfWidth: FALLBACK_HALF_WIDTH },
    ],
  }];
}
