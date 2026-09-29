// Recipe 'gates': a timed course through the site's canyon (the carve stamp). A start gate spans the
// canyon mouth at its entry and a finish gate its exit, each marked by cairns with pennants on both
// rims. Flying through start then finish (in order, without a soft crash between when `clean`)
// completes the course: the engine emits 'structure:course' with the elapsed time, which the journal
// keeps as the best run. Without a carve stamp (a debug spawn) the course runs `length` metres along
// the spawn heading.
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
});

export function buildGates(context, read) {
  const { rng, body, out } = context;
  const carve = findStamp(context.site, 'carve', read.integer('stamp', GATES_DEFAULTS.stamp, 0, 16));
  const ceiling = read.number('ceiling', GATES_DEFAULTS.ceiling, 0, 500);
  const margin = read.number('margin', GATES_DEFAULTS.margin, 0, 100);
  const markers = read.boolean('markers', GATES_DEFAULTS.markers);
  const clean = read.boolean('clean', GATES_DEFAULTS.clean);
  const course = read.string('course', context.presetId);

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
      addCairn(body, x, context.ground(x, z), z, 1.6 + rng() * 0.6, rng, index === 0 ? PALETTE.flagWhite : PALETTE.flagRed);
    }
  });
  out.courses.push({ id: course, gates: ids, clean });
  out.radius = Math.max(out.radius, Math.max(...ends.map((end) => Math.hypot(end.x, end.z) + end.halfWidth)));
}
