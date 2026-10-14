// Recipe 'portalRing': a standing ring of dark stone blocks inlaid with glowing runes, raised on two
// leaning pillars over a stone slab, holding a swirling membrane of light (preset 67). The ring stands
// across the site heading (it faces along it); flying through the membrane, either way, crosses the
// ring's 'portal' gate: the engine sends 'structure:portal' and the portal system
// (src/gameplay/portals.js) takes the player through to the next world. Crystal shards hover around
// the ring and a keystone crowns it.
//
// Colliders: every ring block, both pillars and the keystone are capsules, the slab a box; the
// membrane is open (it is the gate). The keystone's top is a perch.
import { PALETTE, paint, shade } from '../palette.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox, localCapsule } from '../colliders.js';

export const PORTAL_RING_DEFAULTS = Object.freeze({
  radius: [38, 46],
  thickness: 5.5,
  lift: 9,
  stones: 28,
  shards: [5, 8],
  runeColor: 0x7fe8ff,
  membraneColor: 0x9d84ff,
});

const STONE = Object.freeze([paint(0x4a4650), paint(0x3f3c46), paint(0x55505c)]);
const MEMBRANE_SEGMENTS = 40;
const MEMBRANE_RINGS = 6;
const TWO_PI = Math.PI * 2;

export function buildPortalRing(context, read) {
  const { rng, body, glow, portal, out } = context;
  const radius = roll(read.range('radius', PORTAL_RING_DEFAULTS.radius, 8, 200), rng);
  const thickness = read.number('thickness', PORTAL_RING_DEFAULTS.thickness, 1, 30);
  const lift = read.number('lift', PORTAL_RING_DEFAULTS.lift, 0, 200);
  const stones = read.integer('stones', PORTAL_RING_DEFAULTS.stones, 8, 64);
  const shardCount = rollInteger(read.range('shards', PORTAL_RING_DEFAULTS.shards, 0, 24), rng);
  const rune = paint(read.color('runeColor', PORTAL_RING_DEFAULTS.runeColor), 1.25);
  const membraneColour = paint(read.color('membraneColor', PORTAL_RING_DEFAULTS.membraneColor), 0.9);

  // The ring's frame: it faces along the heading, so its plane holds the heading's right axis and up.
  const heading = context.heading * (Math.PI / 180);
  const forward = [Math.sin(heading), 0, -Math.cos(heading)];
  const right = [Math.cos(heading), 0, Math.sin(heading)];
  const base = context.ground(0, 0);
  const centre = [0, base + lift + radius + thickness, 0];
  const at = (angle, reach, depth = 0) => [
    centre[0] + right[0] * Math.cos(angle) * reach + forward[0] * depth,
    centre[1] + Math.sin(angle) * reach,
    centre[2] + right[2] * Math.cos(angle) * reach + forward[2] * depth,
  ];

  // ---- Ring blocks with rune inlays on both faces -----------------------------------------------
  const halfDepth = thickness * 0.6;
  const halfRadial = thickness * 0.5;
  for (let stone = 0; stone < stones; stone++) {
    const middle = ((stone + 0.5) / stones) * TWO_PI;
    const half = (Math.PI / stones) * 0.94;
    const tangent = [-right[0] * Math.sin(middle), Math.cos(middle), -right[2] * Math.sin(middle)];
    const radial = [right[0] * Math.cos(middle), Math.sin(middle), right[2] * Math.cos(middle)];
    const centreStone = at(middle, radius);
    const halfLength = Math.sin(half) * radius;
    const paintStone = shade(STONE[stone % STONE.length], 0.85 + rng() * 0.3);
    body.setPaint(paintStone).orientedBox(
      centreStone[0], centreStone[1], centreStone[2],
      tangent[0] * halfLength, tangent[1] * halfLength, tangent[2] * halfLength,
      radial[0] * halfRadial, radial[1] * halfRadial, radial[2] * halfRadial,
      forward[0] * halfDepth, forward[1] * halfDepth, forward[2] * halfDepth,
    );
    if (stone % 2 === 0) {
      for (const side of [-1, 1]) {
        const face = at(middle, radius, side * (halfDepth + 0.05));
        glow.setPaint(rune).orientedBox(
          face[0], face[1], face[2],
          tangent[0] * halfLength * 0.55, tangent[1] * halfLength * 0.55, tangent[2] * halfLength * 0.55,
          radial[0] * halfRadial * 0.35, radial[1] * halfRadial * 0.35, radial[2] * halfRadial * 0.35,
          forward[0] * 0.15, forward[1] * 0.15, forward[2] * 0.15,
        );
      }
    }
    const from = at(middle - half, radius);
    const to = at(middle + half, radius);
    out.colliders.push(localCapsule('ring', from[0], from[1], from[2], to[0], to[1], to[2], thickness * 0.62, { surface: 'stone' }));
  }

  // ---- Keystone with a crystal ---------------------------------------------------------------------
  const crown = at(Math.PI / 2, radius + thickness * 0.9);
  body.setPaint(STONE[2]).box(crown[0], crown[1], crown[2], thickness * 2.2, thickness * 1.6, thickness * 1.8, heading);
  glow.setPaint(rune).lathe(crown[0], crown[1] + thickness * 0.8, crown[2], [[0, 0], [thickness * 0.55, thickness * 0.9], [0, thickness * 2.4]], 5, { phase: rng() * TWO_PI });
  out.colliders.push(localCapsule('keystone', crown[0] - right[0] * thickness, crown[1], crown[2] - right[2] * thickness, crown[0] + right[0] * thickness, crown[1], crown[2] + right[2] * thickness, thickness * 0.9, {
    surface: 'stone', perch: { x: crown[0], y: crown[1] + thickness * 0.9 + 1, z: crown[2] },
  }));

  // ---- Pillars and the slab ---------------------------------------------------------------------
  const slabTop = base + 1.2;
  body.setPaint(PALETTE.stone[1]).box(0, base - 2, 0, radius * 1.4, 6.4, thickness * 3.2, heading);
  out.colliders.push(localBox('slab', 0, base - 2, 0, radius * 1.4, 6.4, thickness * 3.2, heading, { surface: 'stone' }));
  for (const side of [-1, 1]) {
    const top = at(Math.PI * 1.5 + side * 0.62, radius);
    const foot = [right[0] * side * radius * 0.62, slabTop - 1, right[2] * side * radius * 0.62];
    body.setPaint(STONE[1]).beam(foot[0], foot[1], foot[2], top[0], top[1], top[2], thickness * 1.3, thickness * 1.3);
    out.colliders.push(localCapsule('pillar', foot[0], foot[1], foot[2], top[0], top[1], top[2], thickness * 0.8, { surface: 'stone' }));
  }

  // ---- The membrane: a polar disc in the ring's plane (uv.x the angle share, uv.y the radius share) ----
  const membraneRadius = radius - thickness * 0.45;
  portal.setPaint(membraneColour);
  for (let ring = 0; ring < MEMBRANE_RINGS; ring++) {
    const inner = ring / MEMBRANE_RINGS;
    const outer = (ring + 1) / MEMBRANE_RINGS;
    for (let segment = 0; segment < MEMBRANE_SEGMENTS; segment++) {
      const a0 = (segment / MEMBRANE_SEGMENTS) * TWO_PI;
      const a1 = ((segment + 1) / MEMBRANE_SEGMENTS) * TWO_PI;
      const p00 = at(a0, membraneRadius * inner);
      const p01 = at(a1, membraneRadius * inner);
      const p10 = at(a0, membraneRadius * outer);
      const p11 = at(a1, membraneRadius * outer);
      const u0 = segment / MEMBRANE_SEGMENTS;
      const u1 = (segment + 1) / MEMBRANE_SEGMENTS;
      portal.triangle(p00[0], p00[1], p00[2], p10[0], p10[1], p10[2], p11[0], p11[1], p11[2], 0, 0, 0, [u0, inner], [u0, outer], [u1, outer]);
      if (ring > 0) portal.triangle(p00[0], p00[1], p00[2], p11[0], p11[1], p11[2], p01[0], p01[1], p01[2], 0, 0, 0, [u0, inner], [u1, outer], [u1, inner]);
    }
  }

  // ---- Hovering shards -------------------------------------------------------------------------
  for (let shard = 0; shard < shardCount; shard++) {
    const angle = rng() * TWO_PI;
    const reach = radius * (1.25 + rng() * 0.45);
    const point = at(angle, reach, (rng() - 0.5) * radius * 0.6);
    const size = thickness * (0.35 + rng() * 0.35);
    glow.setPaint(shade(rune, 0.7 + rng() * 0.4)).lathe(point[0], point[1], point[2], [[0, -size * 1.8], [size, 0], [0, size * 1.8]], 5, { phase: rng() * TWO_PI });
  }

  context.addGate({
    id: 'portal',
    kind: 'through',
    x: centre[0],
    z: centre[2],
    normalX: forward[0],
    normalZ: forward[2],
    halfWidth: membraneRadius * 0.72,
    minY: centre[1] - membraneRadius * 0.72,
    maxY: centre[1] + membraneRadius * 0.72,
    action: 'portal',
    achievement: null,
  });
  out.audioPoint = centre.slice();
  out.approach = Math.max(600, radius * 25);
  out.radius = Math.max(out.radius, radius * 2 + 30);
}
