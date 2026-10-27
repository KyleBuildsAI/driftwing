// Recipe 'dragonRace': the dragon racer's course (preset 70). A basalt crag rises from the site's
// peak, a wild dragon perched on its top; below it the preset's `challenge` course (gate frames and the
// challenge registration, exactly as the 'challengeGates' recipe builds them) winds down and away.
// When a run starts, the dragon launches from the crag and races the route: out.rival hands the engine
// its racing line (from its perch through every gate centre, lifted clear of the ground between
// gates, and on past the finish) and its two paces. Flying anything else, the dragon leads at
// `paceTime` (the gold line); flying the dragon yourself, it becomes your rival: it roars, races at
// `rivalTime`, shows as the challenge's rival (the gap on the timer), and beating it to the finish
// earns the preset's achievement. The engine draws and flies it (structure/rival.js).
//
// Colliders: the crag's stacked rock drums as hulls (its top a perch, where the dragon sits); the gate
// frames stay visual only, as in 'challengeGates'.
import { PALETTE, paint, shade } from '../palette.js';
import { addBoulder } from '../common.js';
import { roll } from '../../engineKit.js';
import { localHull, ringPoints } from '../colliders.js';
import { CHALLENGE_GATES_DEFAULTS, buildChallengeGates } from './challengeGates.js';

export const DRAGON_RACE_DEFAULTS = Object.freeze({
  ...CHALLENGE_GATES_DEFAULTS,
  cragHeight: [80, 105],
  cragRadius: 26,
  paceTime: 70,
  rivalTime: 84,
  dragonScale: 9,
  rivalName: 'the wild dragon',
  achievement: null,
});

const BASALT = Object.freeze([paint(0x3f3a37), paint(0x4a4440), paint(0x37322f)]);
/** The crag's drums: [share of the height at the top of the drum, radius share at its base, at its top]. */
const DRUMS = Object.freeze([
  Object.freeze([0.3, 1.25, 0.95]),
  Object.freeze([0.62, 0.95, 0.72]),
  Object.freeze([0.86, 0.72, 0.5]),
  Object.freeze([1, 0.5, 0.36]),
]);
const DRUM_SIDES = 7;
/** The racing line clears the ground between gates by at least this (m). */
const ROUTE_CLEARANCE = 30;
/** It runs on this far past the finish gate (m), so it crosses the line at full pace. */
const RUN_OUT = 160;

/** The crag: stacked, slightly leaning rock drums from below the ground to `height`; returns its top (local). */
function buildCrag(context, height, radius) {
  const { body, detail, rng, out } = context;
  const base = context.ground(0, 0) - 8;
  let bottom = base;
  let offsetX = 0;
  let offsetZ = 0;
  for (let index = 0; index < DRUMS.length; index++) {
    const [topShare, lower, upper] = DRUMS[index];
    const top = context.ground(0, 0) + height * topShare;
    const nextX = offsetX + (rng() - 0.5) * radius * 0.25;
    const nextZ = offsetZ + (rng() - 0.5) * radius * 0.25;
    const phase = rng() * Math.PI * 2;
    body.setPaint(shade(BASALT[index % BASALT.length], 0.85 + rng() * 0.25));
    body.lathe(offsetX, bottom, offsetZ, [[radius * lower, 0], [radius * (lower + upper) * 0.52, (top - bottom) * 0.5], [radius * upper, top - bottom]], DRUM_SIDES, {
      closeBottom: true, closeTop: index === DRUMS.length - 1, phase,
      radiusAt: (ring, side, value) => value * (0.86 + 0.28 * ((side * 5 + ring * 3 + index) % 7) / 6),
    });
    const isTop = index === DRUMS.length - 1;
    const points = [
      ...ringPoints(offsetX, bottom, offsetZ, radius * lower * 1.14, DRUM_SIDES, phase),
      ...ringPoints(offsetX, top, offsetZ, radius * upper * 1.14, DRUM_SIDES, phase),
    ];
    out.colliders.push(localHull('crag', points, isTop ? { surface: 'stone', perch: { x: offsetX, y: top + 1, z: offsetZ } } : { surface: 'stone' }));
    bottom = top - 2;
    if (!isTop) {
      offsetX = nextX;
      offsetZ = nextZ;
    }
  }
  // Scree round the foot.
  for (let index = 0; index < 14; index++) {
    const angle = rng() * Math.PI * 2;
    const reach = radius * (1.3 + rng() * 1.6);
    const x = Math.sin(angle) * reach;
    const z = -Math.cos(angle) * reach;
    addBoulder(detail, x, context.ground(x, z), z, 1.5 + rng() * 3.5, rng, PALETTE.rockDeep);
  }
  return [offsetX, bottom + 2, offsetZ];
}

/** The racing line (local xyz triples): the perch, every gate centre with lifted midpoints, the run-out. */
function racingLine(context, perch, definition) {
  const { anchor } = context;
  const centres = definition.gates.map((gate) => [gate.center.x - anchor.x, gate.center.y - anchor.y, gate.center.z - anchor.z]);
  const points = [perch[0], perch[1] + 2, perch[2]];
  let previous = [perch[0], perch[1], perch[2]];
  for (const centre of centres) {
    const midX = (previous[0] + centre[0]) / 2;
    const midZ = (previous[2] + centre[2]) / 2;
    const midY = Math.max((previous[1] + centre[1]) / 2, context.ground(midX, midZ) + ROUTE_CLEARANCE);
    points.push(midX, midY, midZ, centre[0], centre[1], centre[2]);
    previous = centre;
  }
  const finish = definition.gates[definition.gates.length - 1];
  const length = Math.hypot(finish.normal.x, finish.normal.y, finish.normal.z) || 1;
  const runX = previous[0] + (finish.normal.x / length) * RUN_OUT;
  const runZ = previous[2] + (finish.normal.z / length) * RUN_OUT;
  points.push(runX, Math.max(previous[1], context.ground(runX, runZ) + ROUTE_CLEARANCE), runZ);
  return points;
}

export function buildDragonRace(context, read) {
  const { rng, out } = context;
  const height = roll(read.range('cragHeight', DRAGON_RACE_DEFAULTS.cragHeight, 20, 400), rng);
  const radius = read.number('cragRadius', DRAGON_RACE_DEFAULTS.cragRadius, 5, 120);
  const paceTime = read.number('paceTime', DRAGON_RACE_DEFAULTS.paceTime, 5, 1200);
  const rivalTime = read.number('rivalTime', DRAGON_RACE_DEFAULTS.rivalTime, 5, 1200);
  // Not `scale`: that is the site's own activation scale.
  const scale = read.number('dragonScale', DRAGON_RACE_DEFAULTS.dragonScale, 1, 40);
  const name = read.string('rivalName', DRAGON_RACE_DEFAULTS.rivalName);
  const achievement = read.object('achievement', null);
  if (achievement !== null && (typeof achievement.id !== 'string' || !achievement.id || typeof achievement.title !== 'string' || !achievement.title)) {
    read.fail('achievement', 'must be null or { id, title } with non-empty strings');
  }
  buildChallengeGates(context, read);
  const perch = buildCrag(context, height, radius);
  out.rival = {
    points: racingLine(context, perch, out.challenge),
    name,
    scale,
    paceTime,
    rivalTime,
    achievement,
  };
  out.audioPoint = [perch[0], perch[1] + 4, perch[2]];
}
