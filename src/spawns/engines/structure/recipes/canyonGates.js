// Recipe 'canyonGates': a challenge course down the site's wide canyon (the carve stamp), through
// natural rock gates. Every gate of the preset's `challenge` block is placed on the canyon's floor
// path at its `along` distance (metres along the stamp's axis from the canyon's middle; `across`
// offsets it from the path, `height` lifts it above the floor) and turned to face down the canyon;
// each is framed by two weathered rock pillars rising from the floor, and a share of them (`arches`)
// are natural arches, a rock span bridging the pillars over the opening. Rubble boulders lie along the
// walls, clear of the flight line. The pillars, spans and boulders are colliders (hulls, boxes,
// spheres; the span tops are perches). Without a carve stamp (a debug spawn) the course runs straight
// along the heading over the open ground, with the same rock gates.
import { PALETTE } from '../palette.js';
import { addBoulder, findStamp, pick } from '../common.js';
import { localBoxAxes, localHull, localSphere, ringPoints } from '../colliders.js';
import { addRolePennant, courseFromBlock } from '../courseKit.js';
import { rollInteger } from '../../engineKit.js';

export const CANYON_GATES_DEFAULTS = Object.freeze({
  stamp: 0,
  arches: 0.5,
  pillarRadius: [5, 8],
  span: [7, 11],
  rubble: [16, 26],
  length: 2400,
});

/** Sides of a pillar's lathe, its jag (share of the radius) and its taper toward the top. */
const PILLAR_SIDES = 7;
const PILLAR_JAG = 0.22;
const PILLAR_TAPER = 0.62;
/** Pillars reach this far (m) above the gate opening's top (or the span's top, with an arch). */
const PILLAR_CROWN = 6;
/** Gaps (m) between a pillar and the opening, and between a boulder and the flight line. */
const PILLAR_CLEARANCE = 1.5;
const RUBBLE_CLEARANCE = 10;

/**
 * The canyon's floor path in the local frame, sampled by share 0..1 from the entry: a position, the
 * unit tangent and the floor half width there. Without a stamp, a straight line along the heading.
 */
function createPath(context, carve, length) {
  if (carve) {
    const points = carve.path.map((point) => ({ x: point.x - context.anchor.x, z: point.z - context.anchor.z, halfWidth: point.halfWidth }));
    return {
      length: carve.length,
      at(share) {
        const scaled = Math.min(points.length - 1.000001, Math.max(0, share * (points.length - 1)));
        const index = Math.floor(scaled);
        const t = scaled - index;
        const from = points[index];
        const to = points[index + 1];
        const before = points[Math.max(0, index - 1)];
        const after = points[Math.min(points.length - 1, index + 2)];
        // The tangent blends the neighbouring segments, so a gate on a bend faces along the bend.
        const tx = (to.x - from.x) * 2 + (from.x - before.x) * (1 - t) + (after.x - to.x) * t;
        const tz = (to.z - from.z) * 2 + (from.z - before.z) * (1 - t) + (after.z - to.z) * t;
        const norm = Math.hypot(tx, tz) || 1;
        return { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t, tx: tx / norm, tz: tz / norm, halfWidth: from.halfWidth + (to.halfWidth - from.halfWidth) * t };
      },
    };
  }
  const radians = context.heading * (Math.PI / 180);
  const tx = Math.sin(radians);
  const tz = -Math.cos(radians);
  return {
    length,
    at(share) {
      const along = (share - 0.5) * length;
      return { x: tx * along, z: tz * along, tx, tz, halfWidth: 70 };
    },
  };
}

/** A weathered rock pillar from (x, baseY, z) up to topY, its collider hull added to out. */
function addPillar(context, x, baseY, z, topY, radius, rng, part) {
  const { body, out } = context;
  const height = topY - baseY;
  const jags = Array.from({ length: PILLAR_SIDES * 4 }, () => 1 - PILLAR_JAG * 0.5 + PILLAR_JAG * rng());
  const rings = [[radius * 1.1, 0], [radius, height * 0.3], [radius * 0.86, height * 0.62], [radius * PILLAR_TAPER, height]];
  body.setPaint(pick(PALETTE.rock, rng)).lathe(x, baseY - 3, z, rings.map(([r, y]) => [r, y + 3]), PILLAR_SIDES, {
    closeTop: true,
    phase: rng() * 6,
    radiusAt: (ring, side, value) => value * jags[ring * PILLAR_SIDES + side],
  });
  // The hull holds the jagged lathe: its widest ring and its top, circumscribed and jag-padded.
  const reach = 1 + PILLAR_JAG * 0.5;
  out.colliders.push(localHull(part, [
    ...ringPoints(x, baseY - 3, z, radius * 1.1 * reach, PILLAR_SIDES),
    ...ringPoints(x, topY, z, radius * PILLAR_TAPER * reach, PILLAR_SIDES),
  ], { surface: 'stone', perch: { x, y: topY, z } }));
}

export function buildCanyonGates(context, read) {
  const { rng, body, out } = context;
  const carve = findStamp(context.site, 'carve', read.integer('stamp', CANYON_GATES_DEFAULTS.stamp, 0, 16));
  const arches = read.number('arches', CANYON_GATES_DEFAULTS.arches, 0, 1);
  const pillarRadius = read.range('pillarRadius', CANYON_GATES_DEFAULTS.pillarRadius, 1, 30);
  const span = read.range('span', CANYON_GATES_DEFAULTS.span, 2, 40);
  const rubbleRange = read.range('rubble', CANYON_GATES_DEFAULTS.rubble, 0, 80);
  const length = read.number('length', CANYON_GATES_DEFAULTS.length, 200, 20000);
  const path = createPath(context, carve, length);
  const axisLength = carve ? carve.length : length;
  const definition = courseFromBlock(context, read, (gate) => {
    const share = Math.min(1, Math.max(0, gate.along / axisLength + 0.5));
    const point = path.at(share);
    const across = gate.across ?? 0;
    const x = point.x - point.tz * across;
    const z = point.z + point.tx * across;
    const heading = Math.atan2(point.tx, -point.tz) / (Math.PI / 180) + (gate.heading ?? 0);
    return { x, y: context.ground(x, z) + gate.height, z, heading, pitch: gate.pitch ?? 0 };
  });

  // The rock gates: two pillars beside each opening, an arch over a share of them.
  const anchor = context.anchor;
  definition.gates.forEach((gate, index) => {
    const centreX = gate.center.x - anchor.x;
    const centreY = gate.center.y - anchor.y;
    const centreZ = gate.center.z - anchor.z;
    const normalX = gate.normal.x;
    const normalZ = gate.normal.z;
    const rightX = -normalZ;
    const rightZ = normalX;
    const halfWidth = gate.shape === 'rect' ? gate.halfWidth : gate.radius;
    const halfHeight = gate.shape === 'rect' ? gate.halfHeight : gate.radius;
    const radius = pillarRadius[0] + (pillarRadius[1] - pillarRadius[0]) * rng();
    const arched = gate.role !== 'start' && gate.role !== 'finish' && rng() < arches;
    const thickness = span[0] + (span[1] - span[0]) * rng();
    const openingTop = centreY + halfHeight;
    const crown = arched ? openingTop + thickness + 1 : openingTop + PILLAR_CROWN;
    const offset = halfWidth + radius * (1 + PILLAR_JAG * 0.5) + PILLAR_CLEARANCE;
    for (const side of [-1, 1]) {
      const x = centreX + rightX * offset * side;
      const z = centreZ + rightZ * offset * side;
      const base = context.ground(x, z);
      addPillar(context, x, base, z, crown + (arched ? 0 : rng() * 8), radius, rng, `pillar${index}${side < 0 ? 'L' : 'R'}`);
      addRolePennant(context.detail, x, crown + (arched ? 0 : 2), z, 5, gate.role, normalX, normalZ);
    }
    if (arched) {
      // The span: a rock beam across the opening from pillar to pillar, a little higher in the middle.
      const reach = offset + radius * 0.4;
      const spanY = openingTop + 1 + thickness * 0.5;
      const depth = radius * 1.6;
      body.setPaint(pick(PALETTE.rock, rng));
      body.beam(centreX - rightX * reach, spanY, centreZ - rightZ * reach, centreX + rightX * reach, spanY + 1.5, centreZ + rightZ * reach, depth, thickness);
      body.setPaint(PALETTE.rockDeep).beam(centreX - rightX * reach * 0.6, spanY - thickness * 0.35, centreZ - rightZ * reach * 0.6, centreX + rightX * reach * 0.6, spanY - thickness * 0.3, centreZ + rightZ * reach * 0.6, depth * 0.8, thickness * 0.4);
      out.colliders.push(localBoxAxes(`span${index}`, [centreX, spanY + 0.75, centreZ], [rightX, 0, rightZ], [0, 1, 0], [-normalX, 0, -normalZ], reach, thickness * 0.5 + 1, depth * 0.5, {
        surface: 'stone', perch: { x: centreX, y: spanY + thickness * 0.5 + 0.75, z: centreZ },
      }));
    }
  });

  // Rubble along the walls, kept clear of the opening line through every gate.
  const rubble = rollInteger(rubbleRange, rng);
  for (let index = 0; index < rubble; index++) {
    const share = 0.04 + 0.92 * rng();
    const point = path.at(share);
    const side = rng() < 0.5 ? -1 : 1;
    const across = side * point.halfWidth * (0.6 + 0.35 * rng());
    if (Math.abs(across) < RUBBLE_CLEARANCE + 20) continue;
    const x = point.x - point.tz * across;
    const z = point.z + point.tx * across;
    const radius = 2.2 + rng() * 3;
    const ground = context.ground(x, z);
    addBoulder(body, x, ground, z, radius, rng, pick(PALETTE.rock, rng));
    out.colliders.push(localSphere(`rubble${index}`, x, ground + radius * 0.35, z, radius * 0.95, { surface: 'stone' }));
  }
  const middle = path.at(0.5);
  out.audioPoint = [middle.x, context.ground(middle.x, middle.z) + 30, middle.z];
  out.radius = Math.max(out.radius, axisLength * 0.5 + 200);
}
