// Recipe 'challengeGates': a challenge course (src/gameplay/challenges.js) from the preset's
// `challenge` block. The block's gates are in the spawn's frame (metres along the heading, across to
// the right, height above the ground); the recipe resolves them into a world course definition
// (buildSiteCourse: id `${presetId}:${siteId}`, or `${presetId}:${seed}` for an event) and hands it to
// the engine in `out.challenge`, which registers it with the challenge system at create and
// unregisters it at dispose. With `frames` the gates get timber (or stone) frames: rectangle gates two
// posts and a lintel with pennants, circle gates a hoop on a post; the start's pennants are white,
// checkpoints red, the finish chequered. The frames are visual only (no colliders): a preset that
// wants solid frames adds its own collider box set (contract b.8).
import { PALETTE } from '../palette.js';
import { buildSiteCourse } from '../../../../gameplay/challenges.js';

export const CHALLENGE_GATES_DEFAULTS = Object.freeze({
  frames: true,
  style: 'timber',
  post: 1.2,
});

/** Segments of a circle gate's hoop. */
const HOOP_SEGMENTS = 24;
/** Pennant size (m) and how far above the frame it flies. */
const PENNANT_LENGTH = 3.2;
const PENNANT_HEIGHT = 1.8;

/** A point `along` the gate frame: centre + right * a + up * b (world), returned in the local frame. */
function framePoint(gate, anchor, a, b) {
  return [
    gate.center.x + gate.right.x * a + gate.up.x * b - anchor.x,
    gate.center.y + gate.right.y * a + gate.up.y * b - anchor.y,
    gate.center.z + gate.right.z * a + gate.up.z * b - anchor.z,
  ];
}

/** A small flag on a staff top at local p, streaming along the gate's right axis. */
function addPennant(builder, gate, p, paintValue, chequered) {
  const direction = [gate.right.x, gate.right.y, gate.right.z];
  const tip = [p[0] + direction[0] * PENNANT_LENGTH, p[1] - PENNANT_HEIGHT * 0.5, p[2] + direction[2] * PENNANT_LENGTH];
  const low = [p[0], p[1] - PENNANT_HEIGHT, p[2]];
  if (!chequered) {
    builder.setPaint(paintValue).triangle(p[0], p[1], p[2], tip[0], tip[1], tip[2], low[0], low[1], low[2]);
    builder.triangle(p[0], p[1], p[2], low[0], low[1], low[2], tip[0], tip[1], tip[2]);
    return;
  }
  // The finish: a chequered square flag (four quads, both faces).
  const half = PENNANT_HEIGHT * 0.5;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      const a = [p[0] + direction[0] * half * column, p[1] - half * row, p[2] + direction[2] * half * column];
      const b = [a[0] + direction[0] * half, a[1], a[2] + direction[2] * half];
      const c = [b[0], b[1] - half, b[2]];
      const d = [a[0], a[1] - half, a[2]];
      builder.setPaint((row + column) % 2 === 0 ? PALETTE.flagWhite : PALETTE.metalDark);
      builder.quad(a, b, c, d);
      builder.quad(a, d, c, b);
    }
  }
}

function pennantFor(role) {
  if (role === 'start') return { paint: PALETTE.flagWhite, chequered: false };
  if (role === 'finish') return { paint: PALETTE.flagWhite, chequered: true };
  return { paint: PALETTE.flagRed, chequered: false };
}

/** Two posts from the ground, a lintel over the opening and a pennant on each post. */
function addRectFrame(context, gate, materials, post) {
  const { body, anchor } = context;
  const reachA = gate.halfWidth + post * 0.5;
  const top = gate.halfHeight + post * 0.5;
  const bottom = -gate.halfHeight - post * 0.5;
  const pennant = pennantFor(gate.role);
  for (const side of [-1, 1]) {
    const upper = framePoint(gate, anchor, side * reachA, top);
    const lower = framePoint(gate, anchor, side * reachA, bottom);
    const ground = context.ground(lower[0], lower[2]);
    body.setPaint(materials.post).beam(lower[0], Math.min(lower[1], ground - 0.5), lower[2], upper[0], upper[1], upper[2], post, post);
    const staff = [upper[0], upper[1] + 3, upper[2]];
    body.setPaint(materials.trim).beam(upper[0], upper[1], upper[2], staff[0], staff[1], staff[2], post * 0.25, post * 0.25);
    addPennant(body, gate, staff, pennant.paint, pennant.chequered);
  }
  const left = framePoint(gate, anchor, -reachA, top);
  const right = framePoint(gate, anchor, reachA, top);
  body.setPaint(materials.lintel).beam(left[0], left[1], left[2], right[0], right[1], right[2], post * 0.9, post * 0.9);
}

/** A hoop of beams in the gate plane on a post down to the ground, a pennant on top. */
function addCircleFrame(context, gate, materials, post) {
  const { body, anchor } = context;
  const radius = gate.radius + post * 0.5;
  let previous = framePoint(gate, anchor, radius, 0);
  body.setPaint(materials.lintel);
  for (let segment = 1; segment <= HOOP_SEGMENTS; segment++) {
    const angle = (segment / HOOP_SEGMENTS) * Math.PI * 2;
    const point = framePoint(gate, anchor, Math.cos(angle) * radius, Math.sin(angle) * radius);
    body.beam(previous[0], previous[1], previous[2], point[0], point[1], point[2], post * 0.8, post * 0.8);
    previous = point;
  }
  const foot = framePoint(gate, anchor, 0, -radius);
  const ground = context.ground(foot[0], foot[2]);
  if (foot[1] > ground + 0.5) body.setPaint(materials.post).beam(foot[0], ground - 0.5, foot[2], foot[0], foot[1], foot[2], post, post);
  const crown = framePoint(gate, anchor, 0, radius);
  const staff = [crown[0], crown[1] + 3, crown[2]];
  body.setPaint(materials.trim).beam(crown[0], crown[1], crown[2], staff[0], staff[1], staff[2], post * 0.25, post * 0.25);
  const pennant = pennantFor(gate.role);
  addPennant(body, gate, staff, pennant.paint, pennant.chequered);
}

/** The frame of a definition gate: its right axis (up x normal) for the builders. */
function withRight(gate) {
  const { normal: n, up: u } = gate;
  return { ...gate, right: { x: u.y * n.z - u.z * n.y, y: u.z * n.x - u.x * n.z, z: u.x * n.y - u.y * n.x } };
}

export function buildChallengeGates(context, read) {
  const block = context.challenge;
  if (!block) read.fail('recipe', "challengeGates needs the preset's challenge block (see src/gameplay/challenges.js validateChallengeBlock)");
  const frames = read.boolean('frames', block.frames !== false);
  const style = read.choice('style', CHALLENGE_GATES_DEFAULTS.style, ['timber', 'stone']);
  const post = read.number('post', CHALLENGE_GATES_DEFAULTS.post, 0.3, 6);
  const { anchor, out } = context;
  const siteId = context.site ? context.site.id : `${context.presetId}:${context.params.seed}`;
  const definition = buildSiteCourse(block, {
    presetId: context.presetId,
    siteId,
    presetName: context.presetName,
    anchor,
    heading: context.heading,
    ground: (x, z) => context.ground(x - anchor.x, z - anchor.z) + anchor.y,
  });
  out.challenge = definition;
  let reach = 20;
  for (const gate of definition.gates) {
    reach = Math.max(reach, Math.hypot(gate.center.x - anchor.x, gate.center.z - anchor.z) + (gate.radius ?? gate.halfWidth ?? 0) + 10);
  }
  out.radius = Math.max(out.radius, reach);
  if (!frames) return;
  const materials = style === 'stone'
    ? { post: PALETTE.stone[0], lintel: PALETTE.stone[2], trim: PALETTE.timberDark }
    : { post: PALETTE.timber[0], lintel: PALETTE.timber[2], trim: PALETTE.timberDark };
  for (const gate of definition.gates) {
    const framed = withRight(gate);
    if (gate.shape === 'rect') addRectFrame(context, framed, materials, post);
    else addCircleFrame(context, framed, materials, post);
  }
}
