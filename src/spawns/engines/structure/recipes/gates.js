// Recipe 'gates': a timed course through the site's canyon (the carve stamp). A start gate spans the
// canyon mouth at its entry and a finish gate its exit, each marked by cairns with pennants on both
// rims. Flying through start then finish (in order, without a soft crash between when `clean`)
// completes the course: the engine emits 'structure:course' with the elapsed time and, when the
// preset names a `journal` statistic (bestCanyonRun), a typed 'journalStat' for clean runs (op min),
// which the journal keeps as the best run. Without a carve stamp (a debug spawn) the course runs `length` metres along
// the spawn heading.
//
// Two options for a canyon run: `corridor` makes the course a corridor (climbing more than `ceiling`
// above the canyon rim nearest the craft spoils a clean run, so a run is flown inside the canyon), and
// `river` lays a water ribbon down the canyon floor along the carve's path.
import { PALETTE } from '../palette.js';
import { addCairn, findStamp, frameFromHeading } from '../common.js';

export const GATES_DEFAULTS = Object.freeze({
  stamp: 0,
  course: null,
  ceiling: 25,
  margin: 6,
  markers: true,
  clean: true,
  length: 600,
  markerHeight: 4.5,
  journal: null,
  corridor: false,
  river: false,
  riverWidth: 0.55,
});

/** Paint of a river ribbon (linear rgb, alpha = opacity) and the ribbon's sample step along the path (m). */
const RIVER_PAINT = Object.freeze([0.36, 0.55, 0.62, 0.82]);
const RIVER_STEP = 18;
/** The river sits this far over the canyon floor, and fades out over this share of the path at each end. */
const RIVER_LIFT = 0.45;
const RIVER_END_FADE = 0.06;

/**
 * A water ribbon down the canyon floor: the carve's polyline sampled every RIVER_STEP metres, each
 * cross-section `widthShare` of the floor's width, laid on the stamped ground. Its v coordinate runs
 * downstream (the carve's floor only falls from the first point to the last), so the water material's
 * streaks flow down the canyon.
 */
function buildRiver(context, path, widthShare) {
  const { water, anchor } = context;
  const lengths = [0];
  for (let index = 1; index < path.length; index++) lengths.push(lengths[index - 1] + Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z));
  const total = lengths[lengths.length - 1];
  const samples = Math.max(2, Math.ceil(total / RIVER_STEP) + 1);
  const section = (distance) => {
    let segment = 0;
    while (segment < path.length - 2 && lengths[segment + 1] < distance) segment++;
    const span = lengths[segment + 1] - lengths[segment] || 1;
    const share = Math.min(1, Math.max(0, (distance - lengths[segment]) / span));
    const from = path[segment];
    const to = path[segment + 1];
    const dirX = (to.x - from.x) / span;
    const dirZ = (to.z - from.z) / span;
    const x = from.x + (to.x - from.x) * share - anchor.x;
    const z = from.z + (to.z - from.z) * share - anchor.z;
    const halfWidth = (from.halfWidth + (to.halfWidth - from.halfWidth) * share) * widthShare;
    return { x, z, rightX: -dirZ * halfWidth, rightZ: dirX * halfWidth };
  };
  let previous = null;
  for (let sample = 0; sample < samples; sample++) {
    const distance = (sample / (samples - 1)) * total;
    const point = section(distance);
    const share = distance / total;
    const fade = Math.min(1, share / RIVER_END_FADE, (1 - share) / RIVER_END_FADE);
    const paint = [RIVER_PAINT[0], RIVER_PAINT[1], RIVER_PAINT[2], RIVER_PAINT[3] * fade];
    const leftX = point.x - point.rightX;
    const leftZ = point.z - point.rightZ;
    const rightX = point.x + point.rightX;
    const rightZ = point.z + point.rightZ;
    const current = {
      left: [leftX, context.ground(leftX, leftZ) + RIVER_LIFT, leftZ],
      right: [rightX, context.ground(rightX, rightZ) + RIVER_LIFT, rightZ],
      v: distance / 30,
      paint,
    };
    if (previous) {
      water.vertexQuad(
        { p: previous.left, uv: [0, previous.v], paint: previous.paint },
        { p: current.left, uv: [0, current.v], paint: current.paint },
        { p: current.right, uv: [1, current.v], paint: current.paint },
        { p: previous.right, uv: [1, previous.v], paint: previous.paint },
      );
    }
    previous = current;
  }
}

/**
 * The corridor of a course: every path point as (x, z, top) in the site frame, where top is the rim
 * plus the ceiling. The engine spoils a clean run that climbs above the top of the nearest point.
 */
function buildCorridor(context, path, ceiling) {
  const points = new Float64Array(path.length * 3);
  path.forEach((point, index) => {
    points[index * 3] = point.x - context.anchor.x;
    points[index * 3 + 1] = point.z - context.anchor.z;
    points[index * 3 + 2] = point.rimY - context.anchor.y + ceiling;
  });
  return points;
}

export function buildGates(context, read) {
  const { rng, body, out } = context;
  const carve = findStamp(context.site, 'carve', read.integer('stamp', GATES_DEFAULTS.stamp, 0, 16));
  const ceiling = read.number('ceiling', GATES_DEFAULTS.ceiling, 0, 500);
  const margin = read.number('margin', GATES_DEFAULTS.margin, 0, 100);
  const markers = read.boolean('markers', GATES_DEFAULTS.markers);
  const clean = read.boolean('clean', GATES_DEFAULTS.clean);
  const markerHeight = read.number('markerHeight', GATES_DEFAULTS.markerHeight, 0.5, 30);
  const course = read.string('course', context.presetId);
  const journal = read.string('journal', GATES_DEFAULTS.journal);
  const corridor = read.boolean('corridor', GATES_DEFAULTS.corridor);
  const river = read.boolean('river', GATES_DEFAULTS.river);
  const riverWidth = read.number('riverWidth', GATES_DEFAULTS.riverWidth, 0.1, 1);
  if (journal !== null && !/^[a-z][A-Za-z0-9]{0,39}$/.test(journal)) read.fail('journal', `must be a camelCase journal statistic name, got ${JSON.stringify(journal)}`);

  const ends = [];
  if (carve) {
    const path = carve.path;
    const last = path.length - 1;
    for (const [point, neighbour, sign] of [[path[0], path[1], 1], [path[last], path[last - 1], -1]]) {
      const dx = (neighbour.x - point.x) * sign;
      const dz = (neighbour.z - point.z) * sign;
      const length = Math.hypot(dx, dz) || 1;
      ends.push({
        x: point.x - context.anchor.x,
        z: point.z - context.anchor.z,
        normalX: dx / length,
        normalZ: dz / length,
        halfWidth: point.halfWidth + point.wallWidth + margin,
        minY: point.floorY - context.anchor.y - 3,
        maxY: point.rimY - context.anchor.y + ceiling,
      });
    }
  } else {
    const frame = frameFromHeading(context.heading);
    const length = read.number('length', GATES_DEFAULTS.length, 50, 20000);
    for (const along of [0, length]) {
      const x = frame.forwardX * along;
      const z = frame.forwardZ * along;
      const ground = context.ground(x, z);
      ends.push({ x, z, normalX: frame.forwardX, normalZ: frame.forwardZ, halfWidth: 40, minY: ground - 5, maxY: ground + 80 + ceiling });
    }
  }
  const ids = ['start', 'finish'];
  ends.forEach((end, index) => {
    context.addGate({ id: ids[index], kind: 'through', ...end, achievement: null, action: null });
    if (!markers) return;
    const rightX = -end.normalZ;
    const rightZ = end.normalX;
    for (const side of [-1, 1]) {
      const x = end.x + rightX * side * (end.halfWidth - margin + 3);
      const z = end.z + rightZ * side * (end.halfWidth - margin + 3);
      addCairn(body, x, context.ground(x, z), z, markerHeight * (0.9 + rng() * 0.2), rng, index === 0 ? PALETTE.flagWhite : PALETTE.flagRed);
    }
  });
  if (carve && river) buildRiver(context, carve.path, riverWidth);
  out.courses.push({ id: course, gates: ids, clean, journal, corridor: carve && corridor ? buildCorridor(context, carve.path, ceiling) : null });
  out.radius = Math.max(out.radius, Math.max(...ends.map((end) => Math.hypot(end.x, end.z) + end.halfWidth)));
}
