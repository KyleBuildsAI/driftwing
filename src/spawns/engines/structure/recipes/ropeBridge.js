// Recipe 'ropeBridge': a timber-plank rope bridge slung between the two anchors of the site's gorge
// stamp (stamps.js resolves them at the rim, on levelled pads). Hand ropes and deck ropes hang in
// catenary-like curves, the planks and ropes sway with the wind (the sway vertex weight is 0 at the
// anchors and 1 mid-span), and a pass-under gate spans the gorge below the deck: flying under the
// bridge fires the gate (the preset may attach an achievement, such as 'Thread the Needle').
// Without a gorge stamp (a debug spawn) the bridge spans `span` metres across the spawn heading,
// between the ground at both ends.
import { PALETTE } from '../palette.js';
import { findStamp, frameFromHeading, pick } from '../common.js';
import { localBox, localBoxAxes, localCapsule } from '../colliders.js';

export const ROPE_BRIDGE_DEFAULTS = Object.freeze({
  stamp: 0,
  span: 140,
  deckWidth: 2.4,
  sag: 0.07,
  plankSpacing: 1.05,
  missingPlanks: 0.05,
  postHeight: 4.6,
  handRail: 1.15,
  swayAmplitude: 0.45,
  gate: Object.freeze({ id: 'under', kind: 'under', achievement: null, clearance: 2 }),
});

export function buildRopeBridge(context, read) {
  const { rng, body, detail, out } = context;
  const deckWidth = read.number('deckWidth', ROPE_BRIDGE_DEFAULTS.deckWidth, 1, 8);
  const sagShare = read.number('sag', ROPE_BRIDGE_DEFAULTS.sag, 0, 0.2);
  const plankSpacing = read.number('plankSpacing', ROPE_BRIDGE_DEFAULTS.plankSpacing, 0.4, 4);
  const missingPlanks = read.number('missingPlanks', ROPE_BRIDGE_DEFAULTS.missingPlanks, 0, 0.5);
  const postHeight = read.number('postHeight', ROPE_BRIDGE_DEFAULTS.postHeight, 1.5, 12);
  const handRail = read.number('handRail', ROPE_BRIDGE_DEFAULTS.handRail, 0.5, 3);
  const swayAmplitude = read.number('swayAmplitude', ROPE_BRIDGE_DEFAULTS.swayAmplitude, 0, 5);
  const gorge = findStamp(context.site, 'gorge', read.integer('stamp', ROPE_BRIDGE_DEFAULTS.stamp, 0, 16));

  // Anchors (local), the gorge floor and the gorge's along axis (the bridge spans across it).
  let ax;
  let az;
  let bx;
  let bz;
  let floorY;
  let alongX;
  let alongZ;
  if (gorge) {
    ax = gorge.anchors[0].x - context.anchor.x;
    az = gorge.anchors[0].z - context.anchor.z;
    bx = gorge.anchors[1].x - context.anchor.x;
    bz = gorge.anchors[1].z - context.anchor.z;
    floorY = gorge.floorY - context.anchor.y;
    alongX = gorge.dirX;
    alongZ = gorge.dirZ;
  } else {
    const halfSpan = read.number('span', ROPE_BRIDGE_DEFAULTS.span, 20, 600) * 0.5;
    const frame = frameFromHeading(context.heading);
    ax = -frame.rightX * halfSpan;
    az = -frame.rightZ * halfSpan;
    bx = frame.rightX * halfSpan;
    bz = frame.rightZ * halfSpan;
    floorY = Infinity;
    for (let sample = 1; sample < 16; sample++) floorY = Math.min(floorY, context.ground(ax + (bx - ax) * (sample / 16), az + (bz - az) * (sample / 16)));
    alongX = frame.forwardX;
    alongZ = frame.forwardZ;
  }
  const anchorSpanX = bx - ax;
  const anchorSpanZ = bz - az;
  const anchorSpan = Math.sqrt(anchorSpanX * anchorSpanX + anchorSpanZ * anchorSpanZ);
  const unitX = anchorSpanX / anchorSpan;
  const unitZ = anchorSpanZ / anchorSpan;
  // The deck hangs between the two lips: walk in from each anchor until the ground falls away
  // below the anchor's own level, then step back onto firm ground.
  const lipDistance = (fromX, fromZ, direction) => {
    const level = context.ground(fromX, fromZ);
    for (let metre = 0; metre < anchorSpan * 0.5; metre++) {
      const x = fromX + unitX * direction * metre;
      const z = fromZ + unitZ * direction * metre;
      if (context.ground(x, z) < level - 1.5) return Math.max(0, metre - 2);
    }
    return 0;
  };
  const lipA = gorge ? lipDistance(ax, az, 1) : 0;
  const lipB = gorge ? lipDistance(bx, bz, -1) : 0;
  const startX = ax + unitX * lipA;
  const startZ = az + unitZ * lipA;
  const endX = bx - unitX * lipB;
  const endZ = bz - unitZ * lipB;
  const span = Math.max(8, anchorSpan - lipA - lipB);
  const ay = context.ground(startX, startZ);
  const by = context.ground(endX, endZ);
  floorY = Math.min(floorY, ay - 4, by - 4);
  const sag = span * sagShare;
  // On a gorge the deck starts at the lips; a free-standing bridge (no gorge stamp) rides on tall
  // trestle posts high enough to clear the ground under its sag.
  let deckA = ay + 0.9;
  let deckB = by + 0.9;
  if (!gorge) {
    let highest = -Infinity;
    for (let sample = 0; sample <= 24; sample++) highest = Math.max(highest, context.ground(startX + unitX * span * (sample / 24), startZ + unitZ * span * (sample / 24)));
    deckA = Math.max(deckA, highest + sag + 4);
    deckB = deckA;
  }
  // Side axis (horizontal, across the deck) = the gorge's along axis.
  const sideX = -unitZ;
  const sideZ = unitX;
  const deckAt = (share) => deckA + (deckB - deckA) * share - sag * 4 * share * (1 - share);
  const pointAt = (share) => [startX + unitX * span * share, startZ + unitZ * span * share];
  const swayAt = (share) => Math.sin(Math.PI * share);
  const spanYaw = Math.atan2(unitZ, unitX);

  // Posts and timber landings at both lips, and a plank path back to each anchor pad.
  const halfDeck = deckWidth * 0.5;
  for (const end of [0, 1]) {
    const [px, pz] = pointAt(end);
    const baseY = end === 0 ? ay : by;
    const deckY = end === 0 ? deckA : deckB;
    const outward = end === 0 ? -1 : 1;
    body.setSway(0).setPaint(pick(PALETTE.timber, rng)).box(px + unitX * outward * 2.4, deckY - 0.55, pz + unitZ * outward * 2.4, 5.4, 1.1, deckWidth + 1.8, spanYaw);
    out.colliders.push(localBox('landing', px + unitX * outward * 2.4, deckY - 0.55, pz + unitZ * outward * 2.4, 5.4, 1.1, deckWidth + 1.8, spanYaw, { surface: 'wood' }));
    const pathLength = end === 0 ? lipA : lipB;
    for (let metre = 5; metre < pathLength; metre += 1.6) {
      const x = px + unitX * outward * metre;
      const z = pz + unitZ * outward * metre;
      detail.setPaint(pick(PALETTE.timber, rng)).box(x, context.ground(x, z) + 0.08, z, 1.1, 0.16, deckWidth * 0.8, spanYaw + (rng() - 0.5) * 0.1);
    }
    for (const side of [-1, 1]) {
      const postX = px + sideX * side * (halfDeck + 0.35);
      const postZ = pz + sideZ * side * (halfDeck + 0.35);
      body.setPaint(PALETTE.timberDark).beam(postX, baseY - 1.5, postZ, postX, deckY + postHeight, postZ, 0.42, 0.42);
      out.colliders.push(localCapsule('post', postX, baseY - 1.5, postZ, postX, deckY + postHeight, postZ, 0.3, { surface: 'wood' }));
      // Guy rope from the post top back to a stake behind it.
      const stakeX = postX + unitX * outward * (postHeight * 1.3) + sideX * side * 1.2;
      const stakeZ = postZ + unitZ * outward * (postHeight * 1.3) + sideZ * side * 1.2;
      const stakeY = context.ground(stakeX, stakeZ);
      detail.setPaint(PALETTE.rope).beam(postX, deckY + postHeight - 0.2, postZ, stakeX, stakeY + 0.3, stakeZ, 0.09, 0.09);
      out.colliders.push(localCapsule('guy', postX, deckY + postHeight - 0.2, postZ, stakeX, stakeY + 0.3, stakeZ, 0.08, { surface: 'rope' }));
      detail.setPaint(PALETTE.timberDark).beam(stakeX, stakeY - 0.4, stakeZ, stakeX, stakeY + 0.6, stakeZ, 0.2, 0.2);
    }
    // Lintel across the post tops.
    body.setPaint(PALETTE.timberDark).beam(px - sideX * (halfDeck + 0.6), deckY + postHeight - 0.3, pz - sideZ * (halfDeck + 0.6), px + sideX * (halfDeck + 0.6), deckY + postHeight - 0.3, pz + sideZ * (halfDeck + 0.6), 0.3, 0.3);
    out.colliders.push(localCapsule('lintel', px - sideX * (halfDeck + 0.6), deckY + postHeight - 0.3, pz - sideZ * (halfDeck + 0.6), px + sideX * (halfDeck + 0.6), deckY + postHeight - 0.3, pz + sideZ * (halfDeck + 0.6), 0.22, { surface: 'wood' }));
  }

  // Ropes: two deck ropes under the plank ends and two hand ropes, in segments.
  const segments = Math.max(12, Math.round(span / 4));
  for (let segment = 0; segment < segments; segment++) {
    const s0 = segment / segments;
    const s1 = (segment + 1) / segments;
    const [x0, z0] = pointAt(s0);
    const [x1, z1] = pointAt(s1);
    const d0 = deckAt(s0);
    const d1 = deckAt(s1);
    const handLift = (share) => handRail + (postHeight - handRail) * Math.pow(Math.abs(1 - 2 * share), 1.6);
    for (const side of [-1, 1]) {
      const offsetX = sideX * side * (halfDeck + 0.12);
      const offsetZ = sideZ * side * (halfDeck + 0.12);
      body.setPaint(PALETTE.rope).setSway(swayAt(s0));
      body.beam(x0 + offsetX, d0 - 0.12, z0 + offsetZ, x1 + offsetX, d1 - 0.12, z1 + offsetZ, 0.14, 0.14);
      body.beam(x0 + offsetX, d0 + handLift(s0), z0 + offsetZ, x1 + offsetX, d1 + handLift(s1), z1 + offsetZ, 0.11, 0.11);
      // The hand rope's collider grows by how far the rope sways at this point of the span.
      const swayReach = swayAmplitude * swayAt((s0 + s1) * 0.5);
      out.colliders.push(localCapsule('rope', x0 + offsetX, d0 + handLift(s0), z0 + offsetZ, x1 + offsetX, d1 + handLift(s1), z1 + offsetZ, 0.06 + swayReach, { surface: 'rope' }));
      // Suspender every other segment, from the hand rope to the deck edge.
      if (segment % 2 === 0 && segment > 0) {
        detail.setPaint(PALETTE.rope).setSway(swayAt(s0));
        detail.beam(x0 + offsetX, d0, z0 + offsetZ, x0 + offsetX, d0 + handLift(s0), z0 + offsetZ, 0.05, 0.05);
      }
    }
  }

  // The deck's colliders: one thin box per rope segment, covering the planks, the deck ropes under
  // their ends and the sideways sway at that point of the span.
  for (let segment = 0; segment < segments; segment++) {
    const s0 = segment / segments;
    const s1 = (segment + 1) / segments;
    const [x0, z0] = pointAt(s0);
    const [x1, z1] = pointAt(s1);
    const dx = x1 - x0;
    const dy = deckAt(s1) - deckAt(s0);
    const dz = z1 - z0;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const along = [dx / length, dy / length, dz / length];
    const side = [sideX, 0, sideZ];
    // up = side x along keeps (along, up, side) right-handed.
    const up = [side[1] * along[2] - side[2] * along[1], side[2] * along[0] - side[0] * along[2], side[0] * along[1] - side[1] * along[0]];
    const middle = [(x0 + x1) * 0.5, (deckAt(s0) + deckAt(s1)) * 0.5 - 0.06, (z0 + z1) * 0.5];
    out.colliders.push(localBoxAxes('deck', middle, along, up, side, length * 0.5 + 0.05, 0.2, halfDeck + 0.26 + swayAmplitude * swayAt((s0 + s1) * 0.5), { surface: 'wood' }));
  }

  // Planks.
  const plankCount = Math.floor(span / plankSpacing);
  const plankYaw = spanYaw;
  for (let plank = 0; plank <= plankCount; plank++) {
    const share = plank / plankCount;
    if (share > 0.04 && share < 0.96 && rng() < missingPlanks) continue;
    const [x, z] = pointAt(share);
    body.setSway(swayAt(share)).setPaint(pick(PALETTE.timber, rng));
    body.box(x, deckAt(share), z, plankSpacing * 0.72, 0.1, deckWidth * (0.94 + rng() * 0.1), plankYaw + (rng() - 0.5) * 0.06);
  }
  body.setSway(0);
  detail.setSway(0);

  // The pass-under gate: a vertical plane through the bridge line, spanning the gorge under the deck.
  const gateParams = read.object('gate', ROPE_BRIDGE_DEFAULTS.gate);
  if (gateParams) {
    const gateRead = read.nested('gate');
    const clearance = gateRead.number('clearance', ROPE_BRIDGE_DEFAULTS.gate.clearance, 0, 20);
    const [midX, midZ] = pointAt(0.5);
    context.addGate({
      id: typeof gateParams.id === 'string' ? gateParams.id : ROPE_BRIDGE_DEFAULTS.gate.id,
      kind: 'under',
      x: midX,
      z: midZ,
      normalX: alongX,
      normalZ: alongZ,
      halfWidth: span * 0.5,
      minY: floorY - 5,
      maxY: deckAt(0.5) - clearance,
      achievement: gateParams.achievement ?? null,
    }, 'gate');
  }
  out.sway = { dirX: sideX, dirZ: sideZ, amplitude: swayAmplitude, frequency: 0.55 };
  out.radius = Math.max(out.radius, anchorSpan * 0.5 + 10);
  const [middleX, middleZ] = pointAt(0.5);
  out.audioPoint = [middleX, deckAt(0.5), middleZ];
}
