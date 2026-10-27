// Recipe 'caveTunnel': a standalone rock mountain on the site's flattened ground (the flatten stamp)
// with a winding tunnel bored through it, portal to portal along the heading. The mountain is one
// closed rock mesh: around the bore's centre line every cross-section reaches out to a jagged
// mountain envelope (flat on the ground, a ridged summit, tapering to cliff faces at the two
// portals) and in to the bore's round wall. Lanterns glow along the bore. The same triangles are the
// collider: a three-mesh-bvh mesh collider (contract b.6, the one preset that needs one), solid
// outside and inside the bore alike, with a perch on the summit. The preset's `challenge` gates are
// placed in the bore: `along` is metres along the heading from the mountain's middle, `across` and
// `height` offset a gate from the bore's centre line, and each gate faces along the bore (pitched
// with its climb). Without a flatten stamp (a debug spawn) the mountain stands on the open ground.
import { PALETTE } from '../palette.js';
import { findStamp, pick } from '../common.js';
import { mixPaint, paint, shade } from '../meshBuilder.js';
import { localMesh } from '../colliders.js';
import { addRolePennant, courseFromBlock } from '../courseKit.js';

export const CAVE_TUNNEL_DEFAULTS = Object.freeze({
  stamp: 0,
  length: 640,
  bore: 22,
  width: 170,
  height: 230,
  meander: 55,
  climb: 16,
  lanterns: true,
  segments: 56,
});

/** Vertices round the mountain's outer section and round the bore. */
const OUTER_SIDES = 28;
const BORE_SIDES = 18;
/** The bore's floor clearance over the ground (m) and the mountain's foot below it (m). */
const FLOOR_GAP = 4;
const FOOT_DEPTH = 6;
/** The rock kept between the bore and the mountain's surface, at least (m). */
const MIN_ROCK = 12;
/** Bisection steps per outer vertex (the ray from the bore's centre to the envelope). */
const ENVELOPE_STEPS = 30;
/** Lanterns along the bore: one every LANTERN_SPACING metres, alternating sides. */
const LANTERN_SPACING = 34;
const LANTERN_PAINT = paint(0xffb15a, 3.2);
const MOSS = paint(0x6f8a4a);
const BORE_ROCK = paint(0x4a4440);

/** The bore's centre line: a frame at share u (0..1) from the entry portal. */
function createBore(length, base, bore, meander, climb, phase) {
  const centre = (u) => ({
    x: meander * Math.sin(Math.PI * 1.5 * u + phase) - meander * Math.sin(phase),
    y: base + FLOOR_GAP + bore + climb * Math.sin(Math.PI * u),
    z: (u - 0.5) * length,
  });
  return {
    /** Position, tangent (unit), right (horizontal) and up of the bore frame at u, in the recipe's axis frame. */
    frame(u) {
      const point = centre(u);
      const ahead = centre(Math.min(1, u + 0.002));
      const behind = centre(Math.max(0, u - 0.002));
      let tx = ahead.x - behind.x;
      let ty = ahead.y - behind.y;
      let tz = ahead.z - behind.z;
      const norm = Math.hypot(tx, ty, tz);
      tx /= norm;
      ty /= norm;
      tz /= norm;
      // In the axis frame (x across to the right, z forward): right is horizontal, a quarter turn
      // clockwise from the tangent seen from above; up = tangent x right (tilted back on a climb).
      let rx = tz;
      let rz = -tx;
      const rightNorm = Math.hypot(rx, rz);
      rx /= rightNorm;
      rz /= rightNorm;
      const ux = ty * rz;
      const uy = tz * rx - tx * rz;
      const uz = -ty * rx;
      return { x: point.x, y: point.y, z: point.z, tx, ty, tz, rx, rz, ux, uy, uz };
    },
  };
}

export function buildCaveTunnel(context, read) {
  const { rng, body, detail, out } = context;
  const flatten = findStamp(context.site, 'flatten', read.integer('stamp', CAVE_TUNNEL_DEFAULTS.stamp, 0, 16));
  const length = read.number('length', CAVE_TUNNEL_DEFAULTS.length, 120, 3000);
  const boreRadius = read.number('bore', CAVE_TUNNEL_DEFAULTS.bore, 6, 80);
  const width = read.number('width', CAVE_TUNNEL_DEFAULTS.width, boreRadius + MIN_ROCK + 10, 1500);
  const height = read.number('height', CAVE_TUNNEL_DEFAULTS.height, (boreRadius + MIN_ROCK) * 2 + 20, 1500);
  const meander = read.number('meander', CAVE_TUNNEL_DEFAULTS.meander, 0, width);
  const climb = read.number('climb', CAVE_TUNNEL_DEFAULTS.climb, 0, height * 0.3);
  const lanterns = read.boolean('lanterns', CAVE_TUNNEL_DEFAULTS.lanterns);
  const segments = read.integer('segments', CAVE_TUNNEL_DEFAULTS.segments, 8, 160);
  // The axis frame: the bore runs along the stamp's axis (or the heading), through the site centre.
  const radians = flatten ? Math.atan2(flatten.dirX, -flatten.dirZ) : context.heading * (Math.PI / 180);
  const forwardX = Math.sin(radians);
  const forwardZ = -Math.cos(radians);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const base = context.ground(0, 0);
  const phase = (rng() - 0.5) * 0.8;
  const bore = createBore(length, base, boreRadius, meander, climb, phase);
  /** Axis frame (x across, y up, z along) to the local frame. */
  const toLocal = (x, y, z) => [rightX * x + forwardX * z, y, rightZ * x + forwardZ * z];
  const noisePhases = [rng() * 6.28, rng() * 6.28, rng() * 6.28];

  // The envelope at share u: half width and summit height taper toward the portals.
  const boreTop = FLOOR_GAP + boreRadius * 2 + climb;
  const envelope = (u) => {
    const taper = 0.42 + 0.58 * Math.pow(Math.sin(Math.PI * u), 0.7);
    return {
      halfWidth: Math.max(width * taper, boreRadius + meander * 0.2 + MIN_ROCK + 6),
      top: Math.max(height * taper, boreTop + MIN_ROCK + 8),
    };
  };
  // Inside test in the cross-section: c across from the bore's line, v height above the base.
  const inside = (c, v, u, shape) => {
    if (v < -FOOT_DEPTH) return false;
    const share = Math.abs(c) / shape.halfWidth;
    if (share >= 1) return false;
    const rough = 1 + 0.08 * Math.sin(c * 0.071 + u * 19 + noisePhases[0]) + 0.05 * Math.sin(c * 0.19 - u * 37 + noisePhases[1]) + 0.04 * Math.sin(u * 61 + noisePhases[2]);
    return v <= shape.top * (1 - Math.pow(share, 1.8)) * rough;
  };

  // ---- The vertices: rings of the outer surface, then rings of the bore wall --------------------------
  const rings = segments + 1;
  const positions = new Float32Array(rings * (OUTER_SIDES + BORE_SIDES) * 3);
  const outerHeight = new Float32Array(rings * OUTER_SIDES);
  const frames = [];
  for (let ring = 0; ring < rings; ring++) {
    const u = ring / segments;
    const frame = bore.frame(u);
    frames.push(frame);
    const shape = envelope(u);
    const centreV = frame.y - base;
    for (let side = 0; side < OUTER_SIDES; side++) {
      const angle = (side / OUTER_SIDES) * Math.PI * 2;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      // Bisection along the ray in the section plane (right, up) from the bore's centre.
      let low = boreRadius + MIN_ROCK;
      let high = Math.max(shape.halfWidth, shape.top) * 2.5;
      for (let step = 0; step < ENVELOPE_STEPS; step++) {
        const middle = (low + high) * 0.5;
        // Across the bore's line along the (horizontal) right axis; up along the section's up.
        const c = cosine * middle;
        const v = centreV + sine * middle * frame.uy;
        if (inside(c, v, u, shape)) low = middle;
        else high = middle;
      }
      const reach = low;
      const x = frame.x + (frame.rx * cosine + frame.ux * sine) * reach;
      const y = frame.y + frame.uy * sine * reach;
      const z = frame.z + (frame.rz * cosine + frame.uz * sine) * reach;
      const [lx, ly, lz] = toLocal(x, y, z);
      const offset = (ring * (OUTER_SIDES + BORE_SIDES) + side) * 3;
      positions[offset] = lx;
      positions[offset + 1] = ly;
      positions[offset + 2] = lz;
      outerHeight[ring * OUTER_SIDES + side] = y - base;
    }
    for (let side = 0; side < BORE_SIDES; side++) {
      const angle = (side / BORE_SIDES) * Math.PI * 2;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const x = frame.x + (frame.rx * cosine + frame.ux * sine) * boreRadius;
      const y = frame.y + frame.uy * sine * boreRadius;
      const z = frame.z + (frame.rz * cosine + frame.uz * sine) * boreRadius;
      const [lx, ly, lz] = toLocal(x, y, z);
      const offset = (ring * (OUTER_SIDES + BORE_SIDES) + OUTER_SIDES + side) * 3;
      positions[offset] = lx;
      positions[offset + 1] = ly;
      positions[offset + 2] = lz;
    }
  }

  // ---- The triangles: outer skin, bore wall and the two portal faces -----------------------------------
  const stride = OUTER_SIDES + BORE_SIDES;
  const outer = (ring, side) => ring * stride + (side % OUTER_SIDES);
  const wall = (ring, side) => ring * stride + OUTER_SIDES + (side % BORE_SIDES);
  // The outer skin first, then the bore wall, then the portals (the paint pass below relies on it).
  const triangles = [];
  for (let ring = 0; ring < segments; ring++) {
    for (let side = 0; side < OUTER_SIDES; side++) {
      triangles.push(outer(ring, side), outer(ring + 1, side), outer(ring, side + 1));
      triangles.push(outer(ring + 1, side), outer(ring + 1, side + 1), outer(ring, side + 1));
    }
  }
  for (let ring = 0; ring < segments; ring++) {
    for (let side = 0; side < BORE_SIDES; side++) {
      triangles.push(wall(ring, side), wall(ring, side + 1), wall(ring + 1, side));
      triangles.push(wall(ring + 1, side), wall(ring, side + 1), wall(ring + 1, side + 1));
    }
  }
  // Wind the skin outward from the solid: the summit's top face must point up (the outer and bore
  // strips are built with opposite turns, so one test settles both).
  const probe = OUTER_SIDES >> 2;
  const a = outer(segments >> 1, probe);
  const b = outer((segments >> 1) + 1, probe);
  const c = outer(segments >> 1, probe + 1);
  const normalY = (positions[b * 3 + 2] - positions[a * 3 + 2]) * (positions[c * 3] - positions[a * 3]) - (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2]);
  if (normalY < 0) {
    for (let index = 0; index < triangles.length; index += 3) {
      const swap = triangles[index + 1];
      triangles[index + 1] = triangles[index + 2];
      triangles[index + 2] = swap;
    }
  }
  // A portal face joins the outer ring to the bore ring: each outer vertex fans to the bore vertex at
  // the nearest angle, and each bore step closes against the outer vertex between them. Each face
  // turns outward: back along the bore at the entry, forward at the exit.
  for (const ring of [0, segments]) {
    const frame = frames[ring];
    const [outX, outY, outZ] = toLocal(frame.tx, frame.ty, frame.tz).map((value) => (ring === 0 ? -value : value));
    const addFacing = (first, second, third) => {
      const e1x = positions[second * 3] - positions[first * 3];
      const e1y = positions[second * 3 + 1] - positions[first * 3 + 1];
      const e1z = positions[second * 3 + 2] - positions[first * 3 + 2];
      const e2x = positions[third * 3] - positions[first * 3];
      const e2y = positions[third * 3 + 1] - positions[first * 3 + 1];
      const e2z = positions[third * 3 + 2] - positions[first * 3 + 2];
      const facing = (e1y * e2z - e1z * e2y) * outX + (e1z * e2x - e1x * e2z) * outY + (e1x * e2y - e1y * e2x) * outZ;
      if (facing >= 0) triangles.push(first, second, third);
      else triangles.push(first, third, second);
    };
    for (let side = 0; side < OUTER_SIDES; side++) {
      const from = Math.round((side / OUTER_SIDES) * BORE_SIDES);
      const to = Math.round(((side + 1) / OUTER_SIDES) * BORE_SIDES);
      addFacing(outer(ring, side), outer(ring, side + 1), wall(ring, to));
      if (to !== from) addFacing(outer(ring, side), wall(ring, to), wall(ring, from));
    }
  }
  const indices = Uint32Array.from(triangles);

  // ---- The rock mesh: the same triangles, flat shaded, rock outside, darker in the bore ---------------
  const outerCount = segments * OUTER_SIDES * 6;
  const boreEnd = outerCount + segments * BORE_SIDES * 6;
  const rockPaints = PALETTE.rock.map((value) => shade(value, 0.92));
  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index] * 3;
    const ib = indices[index + 1] * 3;
    const ic = indices[index + 2] * 3;
    const pa = [positions[ia], positions[ia + 1], positions[ia + 2]];
    const pb = [positions[ib], positions[ib + 1], positions[ib + 2]];
    const pc = [positions[ic], positions[ic + 1], positions[ic + 2]];
    let face;
    if (index < outerCount) {
      // Moss on the gentle upper faces, rock elsewhere, a little lighter toward the summit.
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      const nz = e1[0] * e2[1] - e1[1] * e2[0];
      const up = ny / (Math.hypot(nx, ny, nz) || 1);
      const lift = ((pa[1] + pb[1] + pc[1]) / 3 - base) / height;
      const rock = shade(pick(rockPaints, rng), 0.9 + 0.25 * Math.min(1, Math.max(0, lift)));
      face = up > 0.72 && lift > 0.25 && lift < 0.9 ? mixPaint(rock, MOSS, 0.55) : rock;
    } else if (index < boreEnd) {
      face = shade(BORE_ROCK, 0.85 + 0.25 * rng());
    } else {
      face = pick(PALETTE.rock, rng);
    }
    body.setPaint(face).triangle(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2]);
  }
  // The summit: the highest outer vertex, a perch.
  let summit = 0;
  for (let index = 1; index < outerHeight.length; index++) if (outerHeight[index] > outerHeight[summit]) summit = index;
  const summitOffset = (Math.floor(summit / OUTER_SIDES) * stride + (summit % OUTER_SIDES)) * 3;
  const perch = { x: positions[summitOffset], y: positions[summitOffset + 1], z: positions[summitOffset + 2] };
  out.colliders.push(localMesh('mountain', positions, indices, { surface: 'stone', perch: [perch] }));

  // ---- Lanterns along the bore, low on alternating walls -------------------------------------------------
  if (lanterns) {
    const count = Math.max(2, Math.floor(length / LANTERN_SPACING));
    for (let index = 1; index < count; index++) {
      const u = index / count;
      const frame = bore.frame(u);
      const angle = index % 2 === 0 ? -0.42 : Math.PI + 0.42;
      const reach = boreRadius - 0.9;
      const x = frame.x + (frame.rx * Math.cos(angle) + frame.ux * Math.sin(angle)) * reach;
      const y = frame.y + frame.uy * Math.sin(angle) * reach;
      const z = frame.z + (frame.rz * Math.cos(angle) + frame.uz * Math.sin(angle)) * reach;
      const [lx, ly, lz] = toLocal(x, y, z);
      detail.setPaint(PALETTE.metalDark).box(lx, ly - 0.7, lz, 0.5, 0.5, 0.5);
      body.setPaint(LANTERN_PAINT).box(lx, ly, lz, 0.9, 1.1, 0.9);
    }
  }

  // ---- The course: the block's gates placed in the bore -----------------------------------------------------
  const headingOf = (frame) => {
    const [dx, , dz] = toLocal(frame.tx, 0, frame.tz);
    return Math.atan2(dx, -dz) / (Math.PI / 180);
  };
  courseFromBlock(context, read, (gate) => {
    const u = Math.min(0.999, Math.max(0.001, gate.along / length + 0.5));
    const frame = bore.frame(u);
    const across = gate.across ?? 0;
    const lift = gate.height;
    const [x, y, z] = toLocal(frame.x + frame.rx * across + frame.ux * lift, frame.y + frame.uy * lift, frame.z + frame.rz * across + frame.uz * lift);
    return { x, y, z, heading: headingOf(frame) + (gate.heading ?? 0), pitch: Math.asin(frame.ty) / (Math.PI / 180) + (gate.pitch ?? 0) };
  });
  // Pennants on the ground either side of each portal: white at the entry, chequered at the exit.
  for (const [u, role] of [[0, 'start'], [1, 'finish']]) {
    const frame = frames[u === 0 ? 0 : segments];
    for (const side of [-1, 1]) {
      const shape = envelope(u);
      const reach = Math.min(shape.halfWidth * 0.55, boreRadius + 18);
      const outward = u === 0 ? -14 : 14;
      const [x, , z] = toLocal(frame.x + frame.rx * reach * side + frame.tx * outward, 0, frame.z + frame.rz * reach * side + frame.tz * outward);
      addRolePennant(detail, x, context.ground(x, z), z, 7, role, forwardX, forwardZ);
    }
  }
  const middle = frames[segments >> 1];
  const [audioX, , audioZ] = toLocal(middle.x, 0, middle.z);
  out.audioPoint = [audioX, middle.y, audioZ];
  out.radius = Math.max(out.radius, length * 0.5 + width + 40);
}
