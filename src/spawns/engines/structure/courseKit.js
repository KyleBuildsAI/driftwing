// Shared by the challenge recipes that build their own scenery around a preset's `challenge` block
// (canyonGates, caveTunnel, fallsWall, balloonCourse, kiteSlalom): the course definition from the
// block (src/gameplay/challenges.js buildSiteCourse, id `${presetId}:${siteId}`), with each gate
// optionally re-placed on the recipe's own path (the canyon's floor, the tunnel's bore) and turned to
// face along it; and the role pennants that mark the gates (white start, red checkpoints, chequered
// finish), as the challengeGates frames show them.
//
// Pure apart from the context it is handed: the definition is plain data the engine registers with
// ctx.game.systems.challenges at create (out.challenge) and unregisters at dispose.
import { buildSiteCourse } from '../../../gameplay/challenges.js';
import { PALETTE } from './palette.js';

const DEG = Math.PI / 180;
/** Pennant size (m): its length streaming out from the staff and its height. */
const PENNANT_LENGTH = 3.4;
const PENNANT_HEIGHT = 1.9;

/**
 * The world course of the preset's challenge block at this spawn. place(gate, index) may return
 * { x, y, z, heading, pitch? } (x, y, z in the spawn's LOCAL frame, metres from the anchor; heading a
 * compass bearing in degrees, pitch nose-up degrees) to move a gate onto the recipe's own geometry, or
 * null to keep the block's placement (along, across, height above the ground, heading relative to the
 * spawn). Fails through read when the preset has no challenge block. Sets out.challenge and grows
 * out.radius to hold every gate; returns the definition.
 */
export function courseFromBlock(context, read, place = null) {
  const block = context.challenge;
  if (!block) read.fail('recipe', `${context.recipe} needs the preset's challenge block (see src/gameplay/challenges.js validateChallengeBlock)`);
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
  if (place) {
    block.gates.forEach((gate, index) => {
      const placed = place(gate, index);
      if (!placed) return;
      const heading = placed.heading * DEG;
      const pitch = (placed.pitch ?? 0) * DEG;
      const target = definition.gates[index];
      target.center = { x: anchor.x + placed.x, y: anchor.y + placed.y, z: anchor.z + placed.z };
      target.normal = { x: Math.sin(heading) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(heading) * Math.cos(pitch) };
      target.up = { x: -Math.sin(heading) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(heading) * Math.sin(pitch) };
    });
  }
  out.challenge = definition;
  let reach = out.radius;
  for (const gate of definition.gates) {
    reach = Math.max(reach, Math.hypot(gate.center.x - anchor.x, gate.center.z - anchor.z) + (gate.radius ?? gate.halfWidth ?? 0) + 10);
  }
  out.radius = reach;
  return definition;
}

/** A gate of a definition in the spawn's local frame: centre, normal and right axes as plain arrays. */
export function localGate(gate, anchor) {
  const n = gate.normal;
  const u = gate.up;
  return {
    role: gate.role,
    shape: gate.shape,
    x: gate.center.x - anchor.x,
    y: gate.center.y - anchor.y,
    z: gate.center.z - anchor.z,
    normal: [n.x, n.y, n.z],
    up: [u.x, u.y, u.z],
    // right = up x normal (the gate frame of challenges.js validateCourseDefinition).
    right: [u.y * n.z - u.z * n.y, u.z * n.x - u.x * n.z, u.x * n.y - u.y * n.x],
    halfWidth: gate.shape === 'rect' ? gate.halfWidth : gate.radius,
    halfHeight: gate.shape === 'rect' ? gate.halfHeight : gate.radius,
  };
}

/**
 * A staff from (x, y, z) (local) `height` metres up with the role's pennant streaming toward
 * (dirX, dirZ): white for the start, red for checkpoints, chequered for the finish. Sways a little at
 * its tip with the structure's sway.
 */
export function addRolePennant(builder, x, y, z, height, role, dirX, dirZ) {
  const top = y + height;
  builder.setSway(0).setPaint(PALETTE.timberDark).beam(x, y, z, x, top, z, 0.22, 0.22);
  const length = Math.hypot(dirX, dirZ) || 1;
  const fx = (dirX / length) * PENNANT_LENGTH;
  const fz = (dirZ / length) * PENNANT_LENGTH;
  if (role !== 'finish') {
    builder.setPaint(role === 'start' ? PALETTE.flagWhite : PALETTE.flagRed);
    builder.triangle(x, top, z, x + fx, top - PENNANT_HEIGHT * 0.5, z + fz, x, top - PENNANT_HEIGHT, z, 0, 0.5, 0);
    builder.triangle(x, top, z, x, top - PENNANT_HEIGHT, z, x + fx, top - PENNANT_HEIGHT * 0.5, z + fz, 0, 0, 0.5);
    builder.setSway(0);
    return;
  }
  const half = PENNANT_HEIGHT * 0.5;
  const stepX = (fx / PENNANT_LENGTH) * half;
  const stepZ = (fz / PENNANT_LENGTH) * half;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      const a = [x + stepX * column, top - half * row, z + stepZ * column];
      const b = [a[0] + stepX, a[1], a[2] + stepZ];
      const c = [b[0], b[1] - half, b[2]];
      const d = [a[0], a[1] - half, a[2]];
      builder.setPaint((row + column) % 2 === 0 ? PALETTE.flagWhite : PALETTE.metalDark);
      builder.quad(a, b, c, d);
      builder.quad(a, d, c, b);
    }
  }
  builder.setSway(0);
}
