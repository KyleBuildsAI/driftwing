// Recipe 'kiteSlalom': kites flying from a hilltop, their strings the poles of a slalom. The block's
// gates are placed over the hill: each `height` above the highest ground under its legs of the course
// (placeOverHill), so the line from gate to gate clears the summit. Every checkpoint of the preset's
// `challenge` block that sits off the course line (a nonzero `across`) gets a kite whose string rises
// from a stake `offset` metres beyond the gate's inner edge, toward the course line, so the gates
// weave from one side of the strings to the other; `extra` more kites fly
// off to the sides. Strings lean `lean` degrees downwind (the prevailing wind at create) up to the
// kite, a diamond with spars and a bow-tie tail, with streamers along the line, all swaying with the
// wind. Each string is a thin SENSOR collider tagged `kiteString`: touching one counts a miss on the
// challenge (its `sensors.kiteString` penalty) and never crashes the craft.
import { paint } from '../meshBuilder.js';
import { localCapsule } from '../colliders.js';
import { courseFromBlock, localGate } from '../courseKit.js';
import { pick } from '../common.js';

export const KITE_SLALOM_DEFAULTS = Object.freeze({
  lineHeight: [110, 165],
  lean: 22,
  offset: 7,
  extra: 4,
  streamers: true,
  kiteSize: [2.6, 3.6],
  sensorRadius: 0.35,
});

const DEG = Math.PI / 180;
/** Ground samples (m apart) along a gate's legs of the course, and how far (m) its own line is sampled. */
const LEG_SAMPLE_STEP = 10;
const GATE_LINE_REACH = 40;
const KITE_COLOURS = Object.freeze([0xe2452f, 0xf2b632, 0x2f7fd8, 0x35a05a, 0xd64d9a, 0xf07a2a].map((hex) => paint(hex)));
const STRING = paint(0xf4efe2);
const SPAR = paint(0x4e3b2a);
const STAKE = paint(0x6b4f35);
/** Streamer heights along a string (m above the stake) and their size (m). */
const STREAMER_HEIGHTS = Object.freeze([18, 40, 68]);
const STREAMER_LENGTH = 2.2;
const TAIL_BOWS = 6;

/**
 * One kite on its string from the stake at (x, groundY, z) (local): returns the string's ends for its
 * sensor. lean is radians from the vertical toward the downwind unit vector (dirX, dirZ).
 */
function addKite(context, x, groundY, z, height, lean, size, streamers) {
  const { body, detail, rng } = context;
  const dirX = context.windX;
  const dirZ = context.windZ;
  const reach = Math.tan(lean) * height;
  const kiteX = x + dirX * reach;
  const kiteY = groundY + height;
  const kiteZ = z + dirZ * reach;
  // The stake and its reel.
  body.setSway(0).setPaint(STAKE).box(x, groundY + 0.5, z, 0.35, 1.4, 0.35);
  detail.setSway(0).setPaint(SPAR).box(x, groundY + 0.9, z + 0.4, 0.6, 0.6, 0.3);
  // The string: two crossed thin triangles, swaying more toward the kite.
  const width = 0.09;
  body.setPaint(STRING);
  body.triangle(x - width, groundY + 1, z, x + width, groundY + 1, z, kiteX, kiteY, kiteZ, 0, 0, 1);
  body.triangle(x + width, groundY + 1, z, x - width, groundY + 1, z, kiteX, kiteY, kiteZ, 0, 0, 1);
  body.triangle(x, groundY + 1, z - width, x, groundY + 1, z + width, kiteX, kiteY, kiteZ, 0, 0, 1);
  body.triangle(x, groundY + 1, z + width, x, groundY + 1, z - width, kiteX, kiteY, kiteZ, 0, 0, 1);
  const colour = pick(KITE_COLOURS, rng);
  const second = pick(KITE_COLOURS, rng);
  if (streamers) {
    for (const along of STREAMER_HEIGHTS) {
      if (along > height - 10) continue;
      const share = along / height;
      const px = x + (kiteX - x) * share;
      const py = groundY + 1 + (kiteY - groundY - 1) * share;
      const pz = z + (kiteZ - z) * share;
      detail.setSway(share).setPaint(share > 0.4 ? colour : second);
      detail.triangle(px, py, pz, px + dirX * STREAMER_LENGTH, py - 0.5, pz + dirZ * STREAMER_LENGTH, px, py - 0.7, pz, share, share + 0.1, share);
      detail.triangle(px, py, pz, px, py - 0.7, pz, px + dirX * STREAMER_LENGTH, py - 0.5, pz + dirZ * STREAMER_LENGTH, share, share, share + 0.1);
    }
  }
  // The kite: a diamond facing back along the string (its face tilted up), cross spars, a bow-tie tail.
  const backX = -dirX * Math.cos(lean);
  const backZ = -dirZ * Math.cos(lean);
  const sideX = -dirZ;
  const sideZ = dirX;
  const upY = Math.cos(lean);
  const upX = dirX * Math.sin(lean);
  const upZ = dirZ * Math.sin(lean);
  const top = [kiteX + upX * size * 0.62, kiteY + upY * size * 0.62, kiteZ + upZ * size * 0.62];
  const bottom = [kiteX - upX * size, kiteY - upY * size, kiteZ - upZ * size];
  const left = [kiteX - sideX * size * 0.5, kiteY, kiteZ - sideZ * size * 0.5];
  const right = [kiteX + sideX * size * 0.5, kiteY, kiteZ + sideZ * size * 0.5];
  const bulge = [kiteX - backX * 0.3, kiteY, kiteZ - backZ * 0.3];
  body.setSway(1);
  for (const [a, b, paintValue] of [[top, right, colour], [right, bottom, second], [bottom, left, colour], [left, top, second]]) {
    body.setPaint(paintValue);
    body.triangle(bulge[0], bulge[1], bulge[2], a[0], a[1], a[2], b[0], b[1], b[2]);
    body.triangle(bulge[0], bulge[1], bulge[2], b[0], b[1], b[2], a[0], a[1], a[2]);
  }
  detail.setSway(1).setPaint(SPAR).beam(top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], 0.06, 0.06);
  detail.beam(left[0], left[1], left[2], right[0], right[1], right[2], 0.06, 0.06);
  for (let bow = 1; bow <= TAIL_BOWS; bow++) {
    const drop = bow * size * 0.55;
    const cx = bottom[0] + dirX * drop * 0.6;
    const cy = bottom[1] - drop;
    const cz = bottom[2] + dirZ * drop * 0.6;
    const half = size * 0.16;
    detail.setPaint(bow % 2 === 0 ? colour : second);
    detail.triangle(cx, cy, cz, cx - sideX * half, cy + half * 0.6, cz - sideZ * half, cx - sideX * half, cy - half * 0.6, cz - sideZ * half);
    detail.triangle(cx, cy, cz, cx - sideX * half, cy - half * 0.6, cz - sideZ * half, cx - sideX * half, cy + half * 0.6, cz - sideZ * half);
    detail.triangle(cx, cy, cz, cx + sideX * half, cy - half * 0.6, cz + sideZ * half, cx + sideX * half, cy + half * 0.6, cz + sideZ * half);
    detail.triangle(cx, cy, cz, cx + sideX * half, cy + half * 0.6, cz + sideZ * half, cx + sideX * half, cy - half * 0.6, cz + sideZ * half);
  }
  body.setSway(0);
  detail.setSway(0);
  return { from: [x, groundY - 1, z], to: [kiteX, kiteY, kiteZ] };
}

/**
 * Places the course over the hill: every gate stands its block `height` above the HIGHEST ground under
 * its legs of the course (the straight lines to the gates before and after it) and under its own line
 * GATE_LINE_REACH metres either side, so on a hilltop the course line between two gates clears the
 * ground between them by that height too (a straight line between two points above a convex summit
 * would cut into it). Positions in the local frame; headings as the block gives them.
 */
function placeOverHill(context) {
  const block = context.challenge;
  const radians = context.heading * DEG;
  const forwardX = Math.sin(radians);
  const forwardZ = -Math.cos(radians);
  const at = (gate) => ({ x: forwardX * gate.along - forwardZ * (gate.across ?? 0), z: forwardZ * gate.along + forwardX * (gate.across ?? 0) });
  const points = block.gates.map(at);
  const highest = (from, to) => {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / LEG_SAMPLE_STEP));
    let top = -Infinity;
    for (let step = 0; step <= steps; step++) {
      const share = step / steps;
      top = Math.max(top, context.ground(from.x + (to.x - from.x) * share, from.z + (to.z - from.z) * share));
    }
    return top;
  };
  return (gate, index) => {
    const point = points[index];
    const heading = context.heading + (gate.heading ?? 0);
    const lineX = Math.sin(heading * DEG) * GATE_LINE_REACH;
    const lineZ = -Math.cos(heading * DEG) * GATE_LINE_REACH;
    let top = highest({ x: point.x - lineX, z: point.z - lineZ }, { x: point.x + lineX, z: point.z + lineZ });
    if (index > 0) top = Math.max(top, highest(points[index - 1], point));
    if (index < points.length - 1) top = Math.max(top, highest(point, points[index + 1]));
    return { x: point.x, y: top + gate.height, z: point.z, heading, pitch: gate.pitch ?? 0 };
  };
}

export function buildKiteSlalom(context, read) {
  const { rng, out, anchor } = context;
  const lineHeight = read.range('lineHeight', KITE_SLALOM_DEFAULTS.lineHeight, 30, 600);
  const lean = read.number('lean', KITE_SLALOM_DEFAULTS.lean, 0, 70) * DEG;
  const offset = read.number('offset', KITE_SLALOM_DEFAULTS.offset, 1, 100);
  const extra = read.integer('extra', KITE_SLALOM_DEFAULTS.extra, 0, 24);
  const streamers = read.boolean('streamers', KITE_SLALOM_DEFAULTS.streamers);
  const kiteSize = read.range('kiteSize', KITE_SLALOM_DEFAULTS.kiteSize, 0.5, 12);
  const sensorRadius = read.number('sensorRadius', KITE_SLALOM_DEFAULTS.sensorRadius, 0.05, 3);
  if (!context.challenge) read.fail('recipe', 'kiteSlalom needs the preset\'s challenge block (see src/gameplay/challenges.js validateChallengeBlock)');
  const definition = courseFromBlock(context, read, placeOverHill(context));
  const block = context.challenge;
  const strings = [];
  const roll = (range) => range[0] + (range[1] - range[0]) * rng();
  definition.gates.forEach((gate, index) => {
    const across = block.gates[index].across ?? 0;
    if (gate.role !== 'checkpoint' || across === 0) return;
    const local = localGate(gate, anchor);
    // The stake: beyond the gate's inner edge, toward the course line (the gate's right axis is
    // horizontal for an upright gate).
    const toward = across > 0 ? -1 : 1;
    const reach = local.halfWidth + offset;
    const x = local.x + local.right[0] * reach * toward;
    const z = local.z + local.right[2] * reach * toward;
    strings.push(addKite(context, x, context.ground(x, z), z, roll(lineHeight), lean, roll(kiteSize), streamers));
  });
  // More kites off to the sides of the course, beyond every gate.
  let farthest = 0;
  for (const gate of definition.gates) farthest = Math.max(farthest, Math.hypot(gate.center.x - anchor.x, gate.center.z - anchor.z));
  const radians = context.heading * DEG;
  const forwardX = Math.sin(radians);
  const forwardZ = -Math.cos(radians);
  for (let index = 0; index < extra; index++) {
    const along = (rng() * 2 - 1) * farthest * 0.8;
    const side = (index % 2 === 0 ? 1 : -1) * (110 + rng() * 70);
    const x = forwardX * along - forwardZ * side;
    const z = forwardZ * along + forwardX * side;
    strings.push(addKite(context, x, context.ground(x, z), z, roll(lineHeight), lean, roll(kiteSize), streamers));
  }
  strings.forEach((line, index) => {
    out.colliders.push(localCapsule(`string${index}`, line.from[0], line.from[1], line.from[2], line.to[0], line.to[1], line.to[2], sensorRadius, { surface: 'rope', sensor: true, miss: 'kiteString' }));
  });
  out.sway = { dirX: context.windX, dirZ: context.windZ, amplitude: 1.2, frequency: 0.35 };
  out.audioPoint = [0, context.ground(0, 0) + 20, 0];
  out.radius = Math.max(out.radius, farthest + 200);
}
