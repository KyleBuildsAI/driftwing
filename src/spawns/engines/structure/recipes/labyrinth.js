// Recipe 'labyrinth' (preset 59, the labyrinth): a hedge maze on a levelled square of pale gravel (the
// site's flatten stamp). A perfect maze, carved by a seeded depth-first search over a square grid of
// cells, so the same site always grows the same maze, with an entrance and an exit on opposite sides
// and a clearing at its heart around a fountain and an obelisk. The hedges are instanced blocks (the
// engine's block pool), merged into straight runs, tall enough that from the ground or low over it you
// see only green walls: the pattern reads from above. Every hedge run is solid (foliage), the obelisk
// a perch; flying low through the clearing at the heart is a gate ("Heart of the Maze").
// Without a flatten stamp (a debug spawn) the maze is `size` metres across, its hedges on the ground.
import { PALETTE } from '../palette.js';
import { findStamp, frameFromHeading, pick } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { rollInteger } from '../../engineKit.js';
import { localBox, localCylinder } from '../colliders.js';
import { createSiteFrame } from '../heritage.js';

export const LABYRINTH_DEFAULTS = Object.freeze({
  stamp: 0,
  cells: [17, 21],
  hedge: 3.4,
  thickness: 1.5,
  size: 140,
  achievement: null,
});

const HEDGE = Object.freeze([paint(0x2f5a2a), paint(0x355f2c), paint(0x2b5226), paint(0x3a6630)]);
const MARBLE = Object.freeze([paint(0xe8e4da), paint(0xdcd7cb)]);
const FOUNTAIN_WATER = paint(0x5b93a6, 0.05);
/** The clearing at the heart: this many cells either side of the middle cell. */
const HEART = 1;

export function buildLabyrinth(context, read) {
  const { rng, body, detail, out } = context;
  // An odd number of cells, so there is a middle cell for the heart.
  let cells = rollInteger(read.range('cells', LABYRINTH_DEFAULTS.cells, 7, 41), rng);
  if (cells % 2 === 0) cells += 1;
  const hedge = read.number('hedge', LABYRINTH_DEFAULTS.hedge, 1, 12);
  const thickness = read.number('thickness', LABYRINTH_DEFAULTS.thickness, 0.4, 5);
  const achievement = read.object('achievement', LABYRINTH_DEFAULTS.achievement);
  const stamp = findStamp(context.site, 'flatten', read.number('stamp', 0, 0, 16));
  let frame;
  let size;
  let floorAt;
  if (stamp) {
    frame = createSiteFrame(stamp.x - context.anchor.x, stamp.z - context.anchor.z, stamp.dirX, stamp.dirZ);
    size = Math.min(stamp.length, stamp.width);
    const floorY = stamp.y - context.anchor.y;
    floorAt = () => floorY;
  } else {
    const heading = frameFromHeading(context.heading);
    frame = createSiteFrame(0, 0, heading.forwardX, heading.forwardZ);
    size = read.number('size', LABYRINTH_DEFAULTS.size, 30, 600);
    floorAt = (along, across) => context.ground(frame.x(along, across), frame.z(along, across));
  }
  const cell = size / cells;
  const half = size / 2;
  const middle = (cells - 1) / 2;

  // ---- The maze: walls on every cell edge, then a seeded depth-first search carves the passages ----
  // horizontal[row][column]: the edge at along = row * cell - half (rows 0..cells), across cell `column`.
  // vertical[row][column]: the edge at across = column * cell - half (columns 0..cells), along cell `row`.
  const horizontal = Array.from({ length: cells + 1 }, () => new Uint8Array(cells).fill(1));
  const vertical = Array.from({ length: cells }, () => new Uint8Array(cells + 1).fill(1));
  const visited = new Uint8Array(cells * cells);
  const stack = [middle * cells + middle];
  visited[stack[0]] = 1;
  const neighbours = [];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const row = Math.floor(current / cells);
    const column = current % cells;
    neighbours.length = 0;
    if (row > 0 && !visited[current - cells]) neighbours.push(0);
    if (row < cells - 1 && !visited[current + cells]) neighbours.push(1);
    if (column > 0 && !visited[current - 1]) neighbours.push(2);
    if (column < cells - 1 && !visited[current + 1]) neighbours.push(3);
    if (neighbours.length === 0) {
      stack.pop();
      continue;
    }
    const direction = neighbours[Math.min(neighbours.length - 1, Math.floor(rng() * neighbours.length))];
    let next;
    if (direction === 0) {
      horizontal[row][column] = 0;
      next = current - cells;
    } else if (direction === 1) {
      horizontal[row + 1][column] = 0;
      next = current + cells;
    } else if (direction === 2) {
      vertical[row][column] = 0;
      next = current - 1;
    } else {
      vertical[row][column + 1] = 0;
      next = current + 1;
    }
    visited[next] = 1;
    stack.push(next);
  }
  // The heart: a clearing of (2 HEART + 1)^2 cells with no walls inside it.
  for (let row = middle - HEART; row <= middle + HEART; row++) {
    for (let column = middle - HEART; column <= middle + HEART; column++) {
      if (row > middle - HEART) horizontal[row][column] = 0;
      if (column > middle - HEART) vertical[row][column] = 0;
    }
  }
  // The entrance and the exit, on the near and far sides.
  const entranceColumn = Math.floor(rng() * cells);
  const exitColumn = Math.floor(rng() * cells);
  horizontal[0][entranceColumn] = 0;
  horizontal[cells][exitColumn] = 0;

  // ---- Hedge runs: consecutive wall edges merged into one block (and one collider) each ----
  const runs = [];
  for (let row = 0; row <= cells; row++) {
    let start = -1;
    for (let column = 0; column <= cells; column++) {
      const wall = column < cells && horizontal[row][column] === 1;
      if (wall && start < 0) start = column;
      if (!wall && start >= 0) {
        runs.push({ along: row * cell - half, across: ((start + column) / 2) * cell - half, lengthAcross: (column - start) * cell + thickness, lengthAlong: thickness });
        start = -1;
      }
    }
  }
  for (let column = 0; column <= cells; column++) {
    let start = -1;
    for (let row = 0; row <= cells; row++) {
      const wall = row < cells && vertical[row][column] === 1;
      if (wall && start < 0) start = row;
      if (!wall && start >= 0) {
        runs.push({ along: ((start + row) / 2) * cell - half, across: column * cell - half, lengthAcross: thickness, lengthAlong: (row - start) * cell + thickness });
        start = -1;
      }
    }
  }
  const hedgeTags = { surface: 'foliage' };
  runs.forEach((run, index) => {
    const x = frame.x(run.along, run.across);
    const z = frame.z(run.along, run.across);
    const base = Math.min(floorAt(run.along, run.across), floorAt(run.along + run.lengthAlong / 2, run.across + run.lengthAcross / 2), floorAt(run.along - run.lengthAlong / 2, run.across - run.lengthAcross / 2)) - 0.3;
    const height = hedge + 0.3 + rng() * 0.25;
    // A block's sizeX lies across the site frame and its sizeZ along it (the frame's compass yaw).
    out.blocks.push({ x, y: base, z, sizeX: run.lengthAcross, sizeY: height, sizeZ: run.lengthAlong, yaw: frame.yaw, paint: pick(HEDGE, rng) });
    out.colliders.push(localBox(`hedge${index}`, x, base + height / 2, z, run.lengthAcross, height, run.lengthAlong, frame.yaw, hedgeTags));
  });

  // ---- The heart: a fountain, an obelisk on a plinth, benches ----
  const heartY = floorAt(0, 0);
  const centreX = frame.x(0, 0);
  const centreZ = frame.z(0, 0);
  body.setPaint(MARBLE[0]).lathe(centreX, heartY - 0.2, centreZ, [[3.6, 0], [3.7, 0.7], [3.3, 0.75], [3.2, 0.35]], 16, {});
  body.setPaint(FOUNTAIN_WATER).lathe(centreX, heartY + 0.55, centreZ, [[3.25, 0], [0, 0.02]], 16, { closeBottom: true });
  body.setPaint(MARBLE[1]).box(centreX, heartY + 1.1, centreZ, 2, 1.6, 2, frame.yaw);
  body.setPaint(MARBLE[0]).prism(centreX, heartY + 1.9, centreZ, 4, 0.55, 0.3, 6.5, Math.PI / 4 + frame.yaw);
  body.setPaint(paint(0xc9a23a, 0.2)).lathe(centreX, heartY + 8.4, centreZ, [[0.32, 0], [0, 0.7]], 4, { closeBottom: true, phase: Math.PI / 4 + frame.yaw });
  out.colliders.push(localCylinder('fountain', centreX, heartY - 0.2, centreZ, 3.7, 0.95, { surface: 'stone' }));
  out.colliders.push(localCylinder('obelisk', centreX, heartY + 0.3, centreZ, 1.4, 8.8, { surface: 'stone', perch: { x: centreX, y: heartY + 9.2, z: centreZ } }));
  for (let bench = 0; bench < 4; bench++) {
    const angle = frame.yaw + bench * Math.PI / 2 + Math.PI / 4;
    const distance = cell * (HEART + 0.2);
    const x = centreX + Math.sin(angle) * distance;
    const z = centreZ - Math.cos(angle) * distance;
    detail.setPaint(MARBLE[1]).box(x, heartY + 0.45, z, 2.2, 0.15, 0.6, angle + Math.PI / 2);
    for (const leg of [-0.8, 0.8]) detail.box(x + Math.cos(angle + Math.PI / 2) * leg, heartY + 0.2, z + Math.sin(angle + Math.PI / 2) * leg, 0.2, 0.4, 0.5, angle + Math.PI / 2);
  }
  // Flying low through the heart is a gate.
  const heartHalf = cell * (HEART + 0.5) - thickness;
  context.addGate({
    id: 'heart',
    kind: 'through',
    x: centreX + Math.sin(frame.yaw) * cell * 0.5,
    z: centreZ - Math.cos(frame.yaw) * cell * 0.5,
    normalX: frame.dirX,
    normalZ: frame.dirZ,
    halfWidth: heartHalf,
    minY: heartY - 2,
    maxY: heartY + hedge + 6,
    achievement: achievement ?? null,
  }, 'achievement');

  // ---- The entrance and the exit: stone gate posts with urns ----
  for (const [row, column] of [[0, entranceColumn], [cells, exitColumn]]) {
    const along = row * cell - half;
    for (const side of [-1, 1]) {
      const across = (column + 0.5) * cell - half + side * (cell / 2);
      const x = frame.x(along, across);
      const z = frame.z(along, across);
      const y = floorAt(along, across);
      body.setPaint(pick(PALETTE.stone, rng)).box(x, y + (hedge + 1) / 2 - 0.2, z, thickness + 0.5, hedge + 1, thickness + 0.5, frame.yaw);
      body.setPaint(MARBLE[0]).lathe(x, y + hedge + 0.8, z, [[0.3, 0], [0.55, 0.35], [0.4, 0.8], [0.5, 0.95]], 8, { closeBottom: true, closeTop: true });
      out.colliders.push(localBox(`gatePost${row === 0 ? 0 : 1}${side < 0 ? 'l' : 'r'}`, x, y + (hedge + 1.8) / 2 - 0.2, z, thickness + 0.5, hedge + 1.8, thickness + 0.5, frame.yaw, { surface: 'stone' }));
    }
  }
  // A border of darker clipped hedge-shade on the gravel round the maze, so its square edge reads.
  const border = half + thickness * 2.5;
  for (const [along, across, lengthAlong, lengthAcross] of [[-border, 0, 1.2, border * 2], [border, 0, 1.2, border * 2], [0, -border, border * 2, 1.2], [0, border, border * 2, 1.2]]) {
    const x = frame.x(along, across);
    const z = frame.z(along, across);
    context.decal.setPaint(shade(HEDGE[0], 0.8)).box(x, floorAt(along, across) + 0.05, z, lengthAcross, 0.08, lengthAlong, frame.yaw);
  }
  out.audioPoint = [centreX, heartY + 3, centreZ];
  out.windProbe = [centreX, heartY + 12, centreZ];
  out.radius = Math.max(out.radius, half * 1.5);
}
