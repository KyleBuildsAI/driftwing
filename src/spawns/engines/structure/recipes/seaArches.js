// Recipe 'seaArches': rock arches standing in the sea among sea stacks (preset 45). The `seaStacks`
// stamp raises the stacks and each arch's two legs out of the water as terrain columns; this recipe
// lays the rock lintel across every pair of legs: a massive, wave-bitten span whose underside curves up
// into an arch high enough to fly through, with rubble on the shelf below. Every opening is a
// fly-through gate (an optional achievement); the lintels are solid (a box collider per segment
// following the arch) with a perch on top; the stacks themselves are terrain, solid as ground.
//
// Free-standing (no seaStacks stamp) the recipe raises one arch of its own across the heading, its
// legs rock prisms from the ground.
import { addBoulder, findStamp, pick } from '../common.js';
import { PALETTE } from '../palette.js';
import { paint, shade } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';
import { localBoxAxes, localCylinder } from '../colliders.js';

export const SEA_ARCHES_DEFAULTS = Object.freeze({
  thickness: [9, 13],
  rise: [6, 10],
  segments: 12,
  span: [44, 60],
  height: [30, 40],
  gate: Object.freeze({ id: 'arch', achievement: null }),
});

const ROCK = Object.freeze({
  face: Object.freeze([paint(0x6e655c), paint(0x7d7368), paint(0x5f5850)]),
  top: Object.freeze([paint(0x7f8a5a), paint(0x6f7a4e)]),
  under: paint(0x4a4440),
  guano: paint(0xd9d4c8),
});

export function buildSeaArches(context, read) {
  const { rng, body, detail, out } = context;
  const thicknessRange = read.range('thickness', SEA_ARCHES_DEFAULTS.thickness, 3, 40);
  const riseRange = read.range('rise', SEA_ARCHES_DEFAULTS.rise, 0, 40);
  const segments = read.integer('segments', SEA_ARCHES_DEFAULTS.segments, 4, 32);
  const gateRead = read.nested('gate');
  const gateId = gateRead.string('id', SEA_ARCHES_DEFAULTS.gate.id);
  const gateParams = read.object('gate', null);
  const achievement = gateParams && gateParams.achievement ? gateParams.achievement : null;
  const anchor = context.anchor;
  const sea = context.waterLevel;
  const stamp = findStamp(context.site, 'seaStacks', read.integer('stamp', 0, 0, 16));
  let arches;
  if (stamp && stamp.arches.length > 0) {
    arches = stamp.arches.map((arch) => ({
      x: arch.x - anchor.x, z: arch.z - anchor.z, spanX: arch.spanX, spanZ: arch.spanZ, span: arch.span, legRadius: arch.legRadius,
      topY: arch.topY - anchor.y, legs: null,
    }));
  } else {
    // Free-standing: one arch across the heading, legs raised here.
    const heading = context.heading * (Math.PI / 180) + Math.PI / 2;
    const span = roll(read.range('span', SEA_ARCHES_DEFAULTS.span, 10, 200), rng);
    const legRadius = 9 + rng() * 4;
    const top = Math.max(context.ground(0, 0), sea) + roll(read.range('height', SEA_ARCHES_DEFAULTS.height, 10, 200), rng);
    const spanX = Math.sin(heading);
    const spanZ = -Math.cos(heading);
    arches = [{ x: 0, z: 0, spanX, spanZ, span, legRadius, topY: top, legs: 'build' }];
  }
  let audioY = sea;
  arches.forEach((arch, index) => {
    const thickness = roll(thicknessRange, rng);
    const rise = roll(riseRange, rng);
    const depth = arch.legRadius * 1.7;
    const normalX = -arch.spanZ;
    const normalZ = arch.spanX;
    const half = arch.span / 2 + arch.legRadius * 0.7;
    if (arch.legs === 'build') {
      for (const side of [-1, 1]) {
        const legX = arch.x + arch.spanX * side * arch.span / 2;
        const legZ = arch.z + arch.spanZ * side * arch.span / 2;
        const ground = context.ground(legX, legZ) - 6;
        body.setPaint(pick(ROCK.face, rng)).lathe(legX, ground, legZ, [
          [arch.legRadius * 1.15, 0], [arch.legRadius, (arch.topY - ground) * 0.5], [arch.legRadius * 0.9, arch.topY - ground - 4],
        ], 7, { closeTop: true, phase: rng() * 6, radiusAt: (ring, sideIndex, radius) => radius * (0.85 + 0.3 * ((ring * 5 + sideIndex * 3) % 7) / 6) });
        out.colliders.push(localCylinder('leg', legX, ground, legZ, arch.legRadius * 1.1, arch.topY - ground - 4, { surface: 'stone' }));
      }
    }
    // The lintel: segments along the span; each a slab whose bottom follows the arch.
    const bottomAt = (u) => {
      const share = u / (arch.span / 2);
      const curve = Math.abs(share) < 1 ? 1 - share * share : 0;
      return arch.topY - thickness - rise * curve;
    };
    const topAt = (u) => arch.topY + 1.5 * Math.cos((u / half) * Math.PI * 0.5) + (rng() - 0.5) * 0.8;
    const tops = [];
    const bottoms = [];
    const jag = [];
    for (let segment = 0; segment <= segments; segment++) {
      const u = -half + (2 * half * segment) / segments;
      tops.push(topAt(u));
      // Over the legs the lintel reaches down onto them.
      bottoms.push(Math.abs(u) > arch.span / 2 - arch.legRadius * 0.4 ? arch.topY - thickness - 6 : bottomAt(u));
      jag.push(0.85 + rng() * 0.3);
    }
    const point = (u, y, side, scale) => [
      arch.x + arch.spanX * u + normalX * side * depth * 0.5 * scale,
      y,
      arch.z + arch.spanZ * u + normalZ * side * depth * 0.5 * scale,
    ];
    for (let segment = 0; segment < segments; segment++) {
      const u0 = -half + (2 * half * segment) / segments;
      const u1 = -half + (2 * half * (segment + 1)) / segments;
      const front0Top = point(u0, tops[segment], 1, jag[segment]);
      const front1Top = point(u1, tops[segment + 1], 1, jag[segment + 1]);
      const front0Bottom = point(u0, bottoms[segment], 1, jag[segment] * 0.9);
      const front1Bottom = point(u1, bottoms[segment + 1], 1, jag[segment + 1] * 0.9);
      const back0Top = point(u0, tops[segment], -1, jag[segment]);
      const back1Top = point(u1, tops[segment + 1], -1, jag[segment + 1]);
      const back0Bottom = point(u0, bottoms[segment], -1, jag[segment] * 0.9);
      const back1Bottom = point(u1, bottoms[segment + 1], -1, jag[segment + 1] * 0.9);
      const face = pick(ROCK.face, rng);
      // Front (+normal), back (-normal), top and the arch's underside, counter-clockwise from outside.
      body.setPaint(face).quad(front0Bottom, front1Bottom, front1Top, front0Top);
      body.setPaint(shade(face, 0.9)).quad(back1Bottom, back0Bottom, back0Top, back1Top);
      body.setPaint(segment % 4 === 1 ? ROCK.guano : pick(ROCK.top, rng)).quad(front0Top, front1Top, back1Top, back0Top);
      body.setPaint(ROCK.under).quad(back0Bottom, back1Bottom, front1Bottom, front0Bottom);
      if (segment === 0) body.setPaint(face).quad(back0Bottom, front0Bottom, front0Top, back0Top);
      if (segment === segments - 1) body.setPaint(face).quad(front1Bottom, back1Bottom, back1Top, front1Top);
      // A box collider per segment: from its bottom to its top, the lintel's depth across.
      const uMid = (u0 + u1) / 2;
      const top = Math.max(tops[segment], tops[segment + 1]);
      const bottom = Math.min(bottoms[segment], bottoms[segment + 1]);
      const centre = [arch.x + arch.spanX * uMid, (top + bottom) / 2, arch.z + arch.spanZ * uMid];
      const tags = segment === Math.floor(segments / 2) ? { surface: 'stone', perch: { x: centre[0], y: top, z: centre[2] } } : { surface: 'stone' };
      out.colliders.push(localBoxAxes('lintel', centre, [arch.spanX, 0, arch.spanZ], [0, 1, 0], [normalX, 0, normalZ], (u1 - u0) / 2 + 0.5, (top - bottom) / 2, depth * 0.5, tags));
    }
    // Rubble fallen onto the shelf under the arch.
    for (let boulder = 0; boulder < 6; boulder++) {
      const u = (rng() - 0.5) * arch.span;
      const across = (rng() - 0.5) * depth * 2.4;
      const bx = arch.x + arch.spanX * u + normalX * across;
      const bz = arch.z + arch.spanZ * u + normalZ * across;
      addBoulder(detail, bx, Math.max(context.ground(bx, bz), sea - 0.6), bz, 1.5 + rng() * 2.5, rng, pick(PALETTE.rock, rng));
    }
    // The opening: a fly-through gate across the arch.
    context.addGate({
      id: arches.length > 1 ? `${gateId}${index}` : gateId,
      kind: 'through',
      x: arch.x,
      z: arch.z,
      normalX,
      normalZ,
      halfWidth: Math.max(2, arch.span / 2 - arch.legRadius * 0.9),
      minY: sea - 2,
      maxY: arch.topY - thickness - rise * 0.8,
      action: null,
      achievement,
    });
    audioY = Math.max(audioY, arch.topY * 0.5);
    out.radius = Math.max(out.radius, Math.hypot(arch.x, arch.z) + half);
  });
  const first = arches[0];
  out.audioPoint = [first.x, Math.max(sea + 2, audioY * 0.3), first.z];
  if (stamp) out.radius = Math.max(out.radius, Math.max(...stamp.stacks.map((stack) => Math.hypot(stack.x - anchor.x, stack.z - anchor.z) + stack.radius * 2), 0));
}
