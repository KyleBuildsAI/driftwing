// Recipe 'ghostGalleon': a three-masted galleon of spectral light (preset 69), sailing a slow loop over
// the cloud tops at night. Everything is drawn in the engine's `ghost` kind (a fresnel rim, a drifting
// shimmer, additive, strongest at night): a lofted hull with a raised sheer, a stern castle and a
// forecastle, the masts with their yards, tattered square sails bellied by a wind that is not there,
// the bowsprit and the shrouds and stays. Its lanterns (on the stern, the bow, the mast tops and the
// rails) burn a cold green; a flame (the dragon's breath) lights them warm, one by one.
//
// The ship sails out.motion: a closed loop `loopRadius` metres round the spawn, at `altitude` metres
// above the sea (the top of the cloud band) or `clearance` above the ground under it, whichever is
// higher, at `speed`, rocking in a slow swell. The hull, the castles and the masts are solid (capsules,
// carried with the ship and its velocity every frame); the sails are ghost cloth that a craft passes
// through. The voice tolls the ship's bell now and then (out.voiceTrigger 'bell').
// Local frame: the bow points along -z (the PathFollower's heading turns it), y up from the deck's
// lowest point amidships.
import { paint } from '../palette.js';
import { roll } from '../../engineKit.js';
import { localCapsule } from '../colliders.js';

export const GHOST_GALLEON_DEFAULTS = Object.freeze({
  length: 62,
  loopRadius: [1500, 2100],
  altitude: 700,
  clearance: 160,
  speed: [11, 15],
  lanterns: true,
  color: 0x7fe8c8,
});

/** Hull stations from the stern (+z) to the bow (-z): [share of the length (+0.5 stern), half beam (share of the beam), deck lift (m), depth (share)]. */
const STATIONS = Object.freeze([
  Object.freeze([0.5, 0.78, 5.5, 0.7]),
  Object.freeze([0.38, 0.95, 3.6, 0.95]),
  Object.freeze([0.18, 1, 1.2, 1]),
  Object.freeze([0, 1, 0, 1]),
  Object.freeze([-0.2, 0.96, 0.4, 0.98]),
  Object.freeze([-0.36, 0.78, 1.6, 0.88]),
  Object.freeze([-0.46, 0.42, 3.2, 0.7]),
  Object.freeze([-0.5, 0.06, 4.4, 0.5]),
]);
/** A hull cross-section from the deck edge to the keel: [share of the half beam, share of the depth below the deck]. */
const SECTION = Object.freeze([
  Object.freeze([1, 0]),
  Object.freeze([1.06, 0.32]),
  Object.freeze([0.78, 0.74]),
  Object.freeze([0, 1]),
]);
/** Masts: [share along (+ toward the stern), height (share of the length), yards (share of the height)]. */
const MASTS = Object.freeze([
  Object.freeze([-0.27, 0.6, Object.freeze([0.42, 0.7, 0.93])]),
  Object.freeze([0, 0.7, Object.freeze([0.36, 0.64, 0.9])]),
  Object.freeze([0.26, 0.5, Object.freeze([0.5, 0.86])]),
]);
const BEAM_SHARE = 0.23;
const DEPTH_SHARE = 0.16;
/** Sail grid (columns across, rows down) and how far the cloth bellies forward (share of its width). */
const SAIL_COLUMNS = 5;
const SAIL_ROWS = 4;
const SAIL_BELLY = 0.14;
const LOOP_POINTS = 12;
const TWO_PI = Math.PI * 2;

/** The hull's outline point at station `index`, section point `point`, side -1 (port) or +1 (starboard). */
function hullPoint(length, station, point, side) {
  const [along, halfShare, lift, depthShare] = station;
  const halfBeam = length * BEAM_SHARE * 0.5 * halfShare;
  const depth = length * DEPTH_SHARE * depthShare;
  const [out, down] = SECTION[point];
  return [side * halfBeam * out, lift - depth * down, along * length];
}

/** The lofted hull: both sides from the deck edge to the keel, the deck, the transom. */
function buildHull(ghost, length, hullPaint, deckPaint) {
  ghost.setPaint(hullPaint);
  for (let station = 0; station < STATIONS.length - 1; station++) {
    for (let point = 0; point < SECTION.length - 1; point++) {
      for (const side of [-1, 1]) {
        const a = hullPoint(length, STATIONS[station], point, side);
        const b = hullPoint(length, STATIONS[station + 1], point, side);
        const c = hullPoint(length, STATIONS[station + 1], point + 1, side);
        const d = hullPoint(length, STATIONS[station], point + 1, side);
        ghost.quad(a, b, c, d);
      }
    }
  }
  ghost.setPaint(deckPaint);
  for (let station = 0; station < STATIONS.length - 1; station++) {
    ghost.quad(hullPoint(length, STATIONS[station], 0, -1), hullPoint(length, STATIONS[station], 0, 1), hullPoint(length, STATIONS[station + 1], 0, 1), hullPoint(length, STATIONS[station + 1], 0, -1));
  }
  // The transom: the stern's section closed flat.
  ghost.setPaint(hullPaint);
  for (let point = 0; point < SECTION.length - 1; point++) {
    ghost.quad(hullPoint(length, STATIONS[0], point, -1), hullPoint(length, STATIONS[0], point + 1, -1), hullPoint(length, STATIONS[0], point + 1, 1), hullPoint(length, STATIONS[0], point, 1));
  }
}

/** A square sail between two yards: a ragged, holed grid bellied forward (-z), at mast `z`. */
function buildSail(ghost, rng, sailPaint, z, top, bottom, halfWidth) {
  const height = top - bottom;
  // Ragged foot: each column ends a little short; the odd panel is torn out.
  const foot = [];
  for (let column = 0; column <= SAIL_COLUMNS; column++) foot.push(rng() * 0.22);
  const vertex = (column, row) => {
    const across = column / SAIL_COLUMNS;
    const down = Math.min(row / SAIL_ROWS, 1 - foot[column]);
    const belly = Math.sin(across * Math.PI) * Math.sin(Math.min(1, down * 1.15) * Math.PI) * halfWidth * 2 * SAIL_BELLY;
    return [-halfWidth + across * halfWidth * 2, top - down * height, z - 0.8 - belly];
  };
  ghost.setPaint(sailPaint);
  for (let row = 0; row < SAIL_ROWS; row++) {
    for (let column = 0; column < SAIL_COLUMNS; column++) {
      if (row > 0 && rng() < 0.09) continue;
      ghost.quad(vertex(column, row), vertex(column + 1, row), vertex(column + 1, row + 1), vertex(column, row + 1));
    }
  }
}

/** A closed loop of LOOP_POINTS points (local xyz) round the anchor, above the cloud band and the ground. */
function sailingLoop(context, read) {
  const { rng } = context;
  const radius = roll(read.range('loopRadius', GHOST_GALLEON_DEFAULTS.loopRadius, 200, 8000), rng);
  const altitude = read.number('altitude', GHOST_GALLEON_DEFAULTS.altitude, 50, 6000);
  const clearance = read.number('clearance', GHOST_GALLEON_DEFAULTS.clearance, 20, 2000);
  const phase = rng() * TWO_PI;
  const sea = altitude - context.anchor.y;
  const flat = [];
  for (let index = 0; index < LOOP_POINTS; index++) {
    const angle = (index / LOOP_POINTS) * TWO_PI;
    const reach = radius * (1 + 0.16 * Math.sin(angle * 3 + phase));
    flat.push([Math.sin(angle) * reach, -Math.cos(angle) * reach]);
  }
  const points = [];
  for (let index = 0; index < LOOP_POINTS; index++) {
    const [x, z] = flat[index];
    const [nextX, nextZ] = flat[(index + 1) % LOOP_POINTS];
    const [previousX, previousZ] = flat[(index + LOOP_POINTS - 1) % LOOP_POINTS];
    // The ground here and halfway to both neighbours, so the curve between points stays clear too.
    const ground = Math.max(
      context.ground(x, z),
      context.ground((x + nextX) / 2, (z + nextZ) / 2),
      context.ground((x + previousX) / 2, (z + previousZ) / 2),
    );
    points.push(x, Math.max(sea, ground + clearance), z);
  }
  return { points, radius };
}

export function buildGhostGalleon(context, read) {
  const { rng, ghost, out } = context;
  const length = read.number('length', GHOST_GALLEON_DEFAULTS.length, 20, 160);
  const colour = read.color('color', GHOST_GALLEON_DEFAULTS.color);
  const hullPaint = paint(colour, 0.95);
  const deckPaint = paint(colour, 0.6);
  const sailPaint = paint(0xc8fff2, 0.55);
  const rigPaint = paint(colour, 0.8);
  const beam = length * BEAM_SHARE;
  const depth = length * DEPTH_SHARE;

  buildHull(ghost, length, hullPaint, deckPaint);
  // Stern castle and forecastle: raised decks over the hull's ends.
  ghost.setPaint(hullPaint);
  ghost.box(0, STATIONS[1][2] + 3.2, length * 0.42, beam * 0.78, 6.4, length * 0.16);
  ghost.box(0, STATIONS[5][2] + 1.8, -length * 0.4, beam * 0.6, 3.6, length * 0.1);
  // Bowsprit.
  const bowY = STATIONS[STATIONS.length - 1][2];
  ghost.setPaint(rigPaint).beam(0, bowY, -length * 0.5, 0, bowY + length * 0.12, -length * 0.72, 0.7, 0.7);

  // Masts, yards and sails; shrouds to the rails and stays fore and aft.
  const tops = [];
  for (const [along, heightShare, yards] of MASTS) {
    const z = along * length;
    const height = heightShare * length;
    ghost.setPaint(rigPaint).beam(0, -depth * 0.5, z, 0, height, z, 1.1, 1.1);
    tops.push([0, height, z]);
    const yardY = yards.map((share) => share * height);
    for (let index = 0; index < yardY.length; index++) {
      const halfWidth = beam * (1.05 - index * 0.2);
      ghost.setPaint(rigPaint).beam(-halfWidth, yardY[index], z - 0.6, halfWidth, yardY[index], z - 0.6, 0.55, 0.55);
      if (index > 0) buildSail(ghost, rng, sailPaint, z, yardY[index], yardY[index - 1] + 1.2, halfWidth * 0.94);
    }
    for (const side of [-1, 1]) {
      ghost.setPaint(rigPaint).beam(0, height * 0.9, z, side * beam * 0.52, 0.6, z + 3, 0.18, 0.18);
      ghost.beam(0, height * 0.9, z, side * beam * 0.52, 0.6, z - 3, 0.18, 0.18);
    }
    out.colliders.push(localCapsule('mast', 0, 0, z, 0, height, z, 1.2, { surface: 'wood' }));
  }
  ghost.setPaint(rigPaint).beam(tops[0][0], tops[0][1], tops[0][2], 0, bowY + length * 0.12, -length * 0.72, 0.2, 0.2);
  ghost.beam(tops[0][0], tops[0][1], tops[0][2], tops[1][0], tops[1][1] * 0.95, tops[1][2], 0.2, 0.2);
  ghost.beam(tops[1][0], tops[1][1], tops[1][2], tops[2][0], tops[2][1] * 0.97, tops[2][2], 0.2, 0.2);

  // The solid ship: the hull as a capsule along the keel line, the castles, the masts (above).
  out.colliders.push(localCapsule('hull', 0, -depth * 0.35, length * 0.36, 0, -depth * 0.35, -length * 0.4, beam * 0.5, { surface: 'wood' }));
  out.colliders.push(localCapsule('castle', -beam * 0.2, STATIONS[1][2] + 2.6, length * 0.42, beam * 0.2, STATIONS[1][2] + 2.6, length * 0.42, beam * 0.36, { surface: 'wood' }));
  out.colliders.push(localCapsule('bowsprit', 0, bowY, -length * 0.5, 0, bowY + length * 0.12, -length * 0.72, 0.9, { surface: 'wood' }));

  if (read.boolean('lanterns', GHOST_GALLEON_DEFAULTS.lanterns)) {
    const lantern = (x, y, z, size) => out.lanterns.push({ x, y, z, size, color: 0x9fffd8, litColor: 0xffc46a, ignitable: true });
    const castleTop = STATIONS[1][2] + 6.4;
    lantern(-beam * 0.32, castleTop + 1.6, length * 0.5, 1.2);
    lantern(beam * 0.32, castleTop + 1.6, length * 0.5, 1.2);
    lantern(0, castleTop + 2.4, length * 0.46, 1.5);
    lantern(0, bowY + 1.4, -length * 0.5, 1);
    for (const top of tops) lantern(top[0], top[1] + 1.2, top[2], 0.9);
    for (const share of [-0.15, 0.12]) for (const side of [-1, 1]) lantern(side * beam * 0.5, 1.8, share * length, 0.8);
  }

  const loop = sailingLoop(context, read);
  out.motion = {
    points: loop.points,
    closed: true,
    speed: roll(read.range('speed', GHOST_GALLEON_DEFAULTS.speed, 2, 60), rng),
    startDistance: rng() * loop.radius * TWO_PI,
    bob: 2.4,
    bobPeriod: 11,
    roll: 4,
    rollPeriod: 13,
    pitch: 2,
  };
  out.voiceTrigger = { name: 'bell', interval: [14, 28], strength: 1 };
  out.audioPoint = [0, 6, 0];
  out.radius = length * 0.8;
}
