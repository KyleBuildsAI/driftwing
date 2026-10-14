// Recipe 'archChain': a line of v1-style natural stone arches (the five-arch chain, preset 81). Each
// arch is lofted the way the v1 landmark arch is (src/world/landmarks.js): two buried legs and a
// half-ellipse crown, a lumpy twelve-point cross-section that thins toward the crown and bulges a
// little along the span, wide dipping strata bands with a moss (or sand, or snow) cap on the upward
// faces, massive boulders merged into the feet and loose rubble around them. The arches stand across
// the line, so the line is flown through their openings.
//
// With the preset's `challenge` block each arch is built around one of its gates: centred on the
// gate, turned to its heading, and sized so the opening holds the gate's rectangle (or circle) with
// `margin` metres to spare whatever the seeded proportions, so the course and the stone always
// agree. Without one, `count` arches stand `spacing` metres apart along the heading, centred on the
// anchor.
//
// Colliders follow the v1 arch's (contract b.8): per segment between two frames a cross-section from
// the ring as built; steep segments (the legs) are oriented boxes, the rest of the span rows of
// capsule ribs across its depth, every piece keeping its inner face at the ring's innermost point so
// the opening stays clear. Boulders are spheres. Each crown is a perch.
import { addBoulder, frameFromHeading } from '../common.js';
import { mixPaint, paint, shade } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';
import { localBoxAxes, localCapsule, localSphere } from '../colliders.js';

export const ARCH_CHAIN_DEFAULTS = Object.freeze({
  count: 5,
  spacing: 260,
  span: [76, 88],
  height: [54, 64],
  legThickness: [11, 15],
  topThickness: [8, 10],
  depth: [15, 21],
  style: 'auto',
  margin: 6,
});

/** The v1 arch styles per biome (landmarks.js ARCH_STYLES): strata bands, the cap and where it starts. */
const STYLES = Object.freeze({
  dunes: Object.freeze({ bands: [0xb4553a, 0xbf5e3c, 0xc96a44, 0xd27d4f, 0xdc9460, 0xcb7048, 0xb85a3b, 0xa9492f], cap: 0xe8c48c, capFrom: 0.5, capAmount: 0.75 }),
  snow: Object.freeze({ bands: [0x7e838c, 0x8e929a, 0x737882, 0x9ea2a8, 0x868a90], cap: 0xf1f5fa, capFrom: -1, capAmount: 0.95 }),
  pine: Object.freeze({ bands: [0x7a7f78, 0x8b8f86, 0x6f746e, 0x979a90, 0x80857c], cap: 0x5f7d43, capFrom: 0.2, capAmount: 0.85 }),
  archipelago: Object.freeze({ bands: [0xd0a660, 0xc2934a, 0xdeb877, 0xb48344, 0xd6ad6c], cap: 0x5f9150, capFrom: 0.3, capAmount: 0.85 }),
  meadows: Object.freeze({ bands: [0xd6ad66, 0xc69850, 0xe2bf80, 0xba8a4a, 0xdab372], cap: 0x86ad55, capFrom: 0.3, capAmount: 0.85 }),
});
const STYLE_NAMES = Object.freeze(['auto', ...Object.keys(STYLES)]);
const RING_POINTS = 12;
const SPAN_STEPS = 24;
const TWO_PI = Math.PI * 2;
/** The ring's lumps reach this share past the frame's half thickness (buildRings' jitter), and its bulge this far (m). */
const LUMP_SHARE = 1.35;
const BULGE = 2.2;
/** The crown's sideways skew, as a share of the half span (v1: 0.08; kept smaller so the gate fits). */
const SKEW_SHARE = 0.05;
/** The legs reach this far (m) below the lowest ground under each foot. */
const LEG_BURY = 6;

function smooth01(value) {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * One arch's proportions from the seeded rolls, sized around a gate when one is given: the opening's
 * inner half-ellipse must hold the gate's half width plus the margin at the gate's top.
 */
function archShape(rng, sizes, gate, margin) {
  const legThickness = [roll(sizes.legThickness, rng), roll(sizes.legThickness, rng)];
  const topThickness = roll(sizes.topThickness, rng);
  const depth = roll(sizes.depth, rng);
  const thickest = Math.max(legThickness[0], legThickness[1]);
  let height = roll(sizes.height, rng);
  let halfSpan = roll(sizes.span, rng) / 2;
  if (gate) {
    const gateTop = gate.height + gate.halfHeight;
    height = Math.max(height, gateTop + margin + topThickness * 0.5 * LUMP_SHARE + BULGE);
    const innerHeight = height - topThickness * 0.5 * LUMP_SHARE - BULGE;
    const share = Math.max(0.05, 1 - (gateTop / innerHeight) ** 2);
    const innerHalf = (gate.halfWidth + margin) / Math.sqrt(share);
    halfSpan = Math.max(halfSpan, (innerHalf + thickest * 0.5 * LUMP_SHARE + BULGE) / (1 - SKEW_SHARE));
  }
  return {
    legThickness,
    topThickness,
    depth,
    height,
    halfSpan,
    topDepth: depth * (0.6 + 0.15 * rng()),
    lean: (rng() - 0.5) * 0.08,
    skew: (rng() - 0.5) * 2 * SKEW_SHARE * halfSpan,
    wobble: (rng() - 0.5) * 5,
    bottoms: [0, 0],
  };
}

/** A leg frame (side -1 left, 1 right) at `fraction` of the way down to its buried bottom. */
function legFrame(shape, sideIndex, fraction) {
  const side = sideIndex === 0 ? -1 : 1;
  const y = shape.bottoms[sideIndex] * fraction;
  return {
    u: side * (shape.halfSpan + 2.5 * fraction), y, w: shape.lean * y, nu: side, ny: 0,
    thickness: shape.legThickness[sideIndex] * (1 + 0.45 * fraction),
    depth: shape.depth * (1 + 0.35 * fraction),
  };
}

/** One frame of the half-ellipse, thinning from the legs toward the crown (landmarks.js archSpanFrame). */
function spanFrame(shape, step, rng) {
  const { height, halfSpan, legThickness, topThickness, depth, topDepth, lean, skew, wobble } = shape;
  const stepJitter = step > 0 && step < SPAN_STEPS ? (rng() - 0.5) * 0.45 : 0;
  const angle = ((step + stepJitter) / SPAN_STEPS) * Math.PI;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  const normalU = -height * cosAngle;
  const normalY = halfSpan * sinAngle;
  const normalLength = Math.hypot(normalU, normalY);
  const legBlend = lerp(legThickness[0], legThickness[1], step / SPAN_STEPS);
  const y = height * sinAngle;
  return {
    u: -halfSpan * cosAngle + skew * sinAngle,
    y,
    w: lean * y + wobble * Math.sin(2 * angle) * 0.5,
    nu: normalU / normalLength,
    ny: normalY / normalLength,
    thickness: topThickness + (legBlend - topThickness) * Math.pow(1 - sinAngle, 0.9),
    depth: topDepth + (depth - topDepth) * Math.pow(1 - sinAngle, 0.8),
  };
}

/** Lumpy cross-sections around the frames (arch-plane points [u, y, w]): a coarse eased field plus jitter. */
function buildRings(frames, rng) {
  const stride = RING_POINTS + 2;
  const rows = Math.ceil(frames.length / 3) + 2;
  const field = Array.from({ length: rows * stride }, () => rng() * 2 - 1);
  const fieldAt = (frameIndex, pointIndex) => {
    const row = Math.floor(frameIndex / 3);
    const blend = smooth01((frameIndex % 3) / 3);
    return lerp(field[row * stride + pointIndex], field[(row + 1) * stride + pointIndex], blend);
  };
  return frames.map((frame, frameIndex) => {
    const bulge = BULGE * fieldAt(frameIndex, RING_POINTS);
    const girth = 1 + 0.2 * fieldAt(frameIndex, RING_POINTS + 1);
    frame.thickness *= girth;
    frame.depth *= 2 - girth;
    frame.u += frame.nu * bulge;
    frame.y += frame.ny * bulge;
    const ring = [];
    for (let point = 0; point < RING_POINTS; point++) {
      const angle = (point / RING_POINTS) * TWO_PI;
      const jitter = 1 + 0.24 * fieldAt(frameIndex, point) + 0.08 * (rng() * 2 - 1);
      const radial = Math.cos(angle) * frame.thickness * 0.5 * jitter;
      const lateral = Math.sin(angle) * frame.depth * 0.5 * jitter;
      ring.push([frame.u + frame.nu * radial, frame.y + frame.ny * radial, frame.w + lateral]);
    }
    return ring;
  });
}

/** The strata paint of a face (arch-plane centroid and normal y), v1's createArchPaint. */
function createStrataPaint(style, height, rng) {
  const bands = style.bands.map((hex) => paint(hex));
  const cap = paint(style.cap);
  const bandHeight = style.capFrom < 0 ? 11 + 6 * rng() : 6.5 + 5 * rng();
  const bandPhase = rng() * 20;
  const bandDip = (rng() - 0.5) * 0.16;
  const capFromY = style.capFrom < 0 ? -Infinity : height * style.capFrom;
  const capThreshold = style.capFrom < 0 ? 0.3 : 0.45;
  return (u, y, w, normalY) => {
    const wave = 1.8 * Math.sin(u * 0.04 + w * 0.03 + bandPhase);
    const band = Math.floor((y + bandPhase + wave + u * bandDip) / bandHeight);
    const base = bands[((band % bands.length) + bands.length) % bands.length];
    let factor = 0.95 + 0.09 * rng();
    if (normalY > capThreshold && y > capFromY) {
      const amount = style.capAmount * smooth01((normalY - capThreshold) / 0.3);
      return shade(mixPaint(base, cap, amount), lerp(factor, 1, amount));
    }
    if (normalY < -0.45) factor *= 0.74;
    if (y < 3) factor *= 0.9;
    return shade(base, factor);
  };
}

/**
 * The loft between consecutive rings as flat triangles, each wound to face away from its frame's
 * centre line and painted by its strata band. place(point) maps an arch-plane point into the local frame.
 */
function loftRings(builder, rings, frames, strata, place) {
  for (let index = 0; index < rings.length - 1; index++) {
    const ringA = rings[index];
    const ringB = rings[index + 1];
    const centre = [(frames[index].u + frames[index + 1].u) * 0.5, (frames[index].y + frames[index + 1].y) * 0.5, (frames[index].w + frames[index + 1].w) * 0.5];
    for (let point = 0; point < RING_POINTS; point++) {
      const next = (point + 1) % RING_POINTS;
      outwardTriangle(builder, ringA[point], ringA[next], ringB[next], centre, strata, place);
      outwardTriangle(builder, ringA[point], ringB[next], ringB[point], centre, strata, place);
    }
  }
}

function outwardTriangle(builder, a, b, c, centre, strata, place) {
  const abu = b[0] - a[0];
  const aby = b[1] - a[1];
  const abw = b[2] - a[2];
  const acu = c[0] - a[0];
  const acy = c[1] - a[1];
  const acw = c[2] - a[2];
  let nu = aby * acw - abw * acy;
  let ny = abw * acu - abu * acw;
  let nw = abu * acy - aby * acu;
  const cu = (a[0] + b[0] + c[0]) / 3;
  const cy = (a[1] + b[1] + c[1]) / 3;
  const cw = (a[2] + b[2] + c[2]) / 3;
  const outward = nu * (cu - centre[0]) + ny * (cy - centre[1]) + nw * (cw - centre[2]) >= 0;
  const length = Math.hypot(nu, ny, nw) || 1;
  nu /= length;
  ny /= length;
  nw /= length;
  builder.setPaint(strata(cu, cy, cw, outward ? ny : -ny));
  // The arch plane is (u right, y up, w forward), a left-handed basis in the local frame, so a
  // triangle that faces outward in the plane is wound the other way round in the local frame.
  const pa = place(a);
  const pb = place(b);
  const pc = place(c);
  if (outward) builder.triangle(pa[0], pa[1], pa[2], pc[0], pc[1], pc[2], pb[0], pb[1], pb[2]);
  else builder.triangle(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2]);
}

/**
 * The arch's colliders from the rings as built (landmarks.js addArchColliders), in the local frame:
 * oriented boxes for the steep segments, rows of capsule ribs elsewhere; the crown rib carries the perch.
 */
function archColliders(out, frames, rings, frame, place) {
  const sections = frames.map((section, index) => {
    let radialMin = Infinity;
    let radialMax = -Infinity;
    let lateralMin = Infinity;
    let lateralMax = -Infinity;
    for (const point of rings[index]) {
      const radial = (point[0] - section.u) * section.nu + (point[1] - section.y) * section.ny;
      const lateral = point[2] - section.w;
      radialMin = Math.min(radialMin, radial);
      radialMax = Math.max(radialMax, radial);
      lateralMin = Math.min(lateralMin, lateral);
      lateralMax = Math.max(lateralMax, lateral);
    }
    return { radialMin, radialMax, lateralMin, lateralMax };
  });
  // The crown: the highest ring point of the arch.
  let crown = rings[0][0];
  for (const ring of rings) for (const point of ring) if (point[1] > crown[1]) crown = point;
  const crownLocal = place([crown[0], crown[1] + 0.5, crown[2]]);
  let crownRib = -1;
  let crownDistance = Infinity;
  const tags = { surface: 'stone' };
  // Arch-plane directions in the local frame.
  const toLocal = (du, dy, dw) => [frame.rightX * du + frame.forwardX * dw, dy, frame.rightZ * du + frame.forwardZ * dw];
  for (let index = 0; index < frames.length - 1; index++) {
    const first = frames[index];
    const second = frames[index + 1];
    const sectionA = sections[index];
    const sectionB = sections[index + 1];
    const radius = Math.max(sectionA.radialMax - sectionA.radialMin, sectionB.radialMax - sectionB.radialMin) * 0.5;
    const axisA = sectionA.radialMin + radius;
    const axisB = sectionB.radialMin + radius;
    const width = Math.max(sectionA.lateralMax - sectionA.lateralMin, sectionB.lateralMax - sectionB.lateralMin);
    const lateralA = first.w + (sectionA.lateralMin + sectionA.lateralMax) * 0.5;
    const lateralB = second.w + (sectionB.lateralMin + sectionB.lateralMax) * 0.5;
    const au = first.u + first.nu * axisA;
    const ay = first.y + first.ny * axisA;
    const bu = second.u + second.nu * axisB;
    const by = second.y + second.ny * axisB;
    const du = bu - au;
    const dy = by - ay;
    if (Math.abs(dy) > 2 * Math.abs(du)) {
      const length = Math.hypot(du, dy);
      const along = toLocal(du / length, dy / length, 0);
      const radial = toLocal(-dy / length, du / length, 0);
      const across = [along[1] * radial[2] - along[2] * radial[1], along[2] * radial[0] - along[0] * radial[2], along[0] * radial[1] - along[1] * radial[0]];
      const center = place([(au + bu) * 0.5, (ay + by) * 0.5, (lateralA + lateralB) * 0.5]);
      out.colliders.push(localBoxAxes('leg', center, along, radial, across, length * 0.5 + radius * 0.5, radius, width * 0.5, tags));
      continue;
    }
    const rows = Math.max(1, Math.ceil(width / (2 * radius)));
    const spread = Math.max(0, width * 0.5 - radius);
    for (let row = 0; row < rows; row++) {
      const offset = rows === 1 ? 0 : -spread + (2 * spread * row) / (rows - 1);
      const a = place([au, ay, lateralA + offset]);
      const b = place([bu, by, lateralB + offset]);
      out.colliders.push(localCapsule('rib', a[0], a[1], a[2], b[0], b[1], b[2], radius, tags));
      const midX = (a[0] + b[0]) * 0.5 - crownLocal[0];
      const midY = (a[1] + b[1]) * 0.5 - crownLocal[1];
      const midZ = (a[2] + b[2]) * 0.5 - crownLocal[2];
      const distance = midX * midX + midY * midY + midZ * midZ;
      if (distance < crownDistance) {
        crownDistance = distance;
        crownRib = out.colliders.length - 1;
      }
    }
  }
  if (crownRib >= 0) {
    const rib = out.colliders[crownRib];
    rib.tags = { surface: 'stone', perch: { x: crownLocal[0], y: crownLocal[1], z: crownLocal[2] } };
  }
  return crownLocal;
}

/** Boulders merged into the feet and loose rubble around them, each with a sphere collider. */
function addRubble(context, shape, strata, frame, centre, rng) {
  const { body, out } = context;
  const place = (u, w) => [centre[0] + frame.rightX * u + frame.forwardX * w, centre[2] + frame.rightZ * u + frame.forwardZ * w];
  const rock = (u, w, radius, bury) => {
    const [x, z] = place(u, w);
    const ground = context.ground(x, z);
    const y = ground + radius * (0.35 - bury);
    addBoulder(body, x, y, z, radius, rng, strata(u, y - centre[1], w, 0));
    out.colliders.push(localSphere('boulder', x, y + radius * 0.3, z, radius * 1.02, { surface: 'stone' }));
  };
  for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
    const side = sideIndex === 0 ? -1 : 1;
    const footU = side * (shape.halfSpan + 2);
    for (let index = 0; index < 3; index++) {
      const radius = shape.legThickness[sideIndex] * (0.38 + 0.18 * rng());
      rock(footU + side * radius * (0.35 + 0.4 * rng()), (index - 1) * shape.depth * 0.45, radius, 0.35);
    }
    const loose = 3 + Math.floor(rng() * 3);
    for (let index = 0; index < loose; index++) {
      const angle = rng() * TWO_PI;
      const reach = shape.legThickness[sideIndex] * (0.9 + 0.8 * rng());
      // Loose rubble stays outside the opening (beyond the foot, away from the span).
      const u = footU + side * Math.abs(Math.cos(angle)) * reach;
      rock(u, Math.sin(angle) * reach * 1.1, 1.6 + 2.8 * rng() ** 1.5, 0.2);
    }
  }
}

/** Builds one arch centred at local (cx, cz), facing compass `heading` (its opening flown along it). */
function buildArch(context, shape, style, cx, cz, heading, rng) {
  const frame = frameFromHeading(heading);
  const baseY = context.ground(cx, cz);
  // Bury each leg below the lowest ground under its foot.
  for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
    const side = sideIndex === 0 ? -1 : 1;
    let lowest = Infinity;
    for (const [du, dw] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
      const u = side * shape.halfSpan + du * shape.legThickness[sideIndex] * 0.5;
      const w = dw * shape.depth * 0.5;
      lowest = Math.min(lowest, context.ground(cx + frame.rightX * u + frame.forwardX * w, cz + frame.rightZ * u + frame.forwardZ * w));
    }
    shape.bottoms[sideIndex] = lowest - baseY - LEG_BURY;
  }
  const frames = [];
  for (const fraction of [1, 0.6, 0.25]) frames.push(legFrame(shape, 0, fraction));
  for (let step = 0; step <= SPAN_STEPS; step++) frames.push(spanFrame(shape, step, rng));
  for (const fraction of [0.25, 0.6, 1]) frames.push(legFrame(shape, 1, fraction));
  const rings = buildRings(frames, rng);
  const strata = createStrataPaint(style, shape.height, rng);
  const place = (point) => [
    cx + frame.rightX * point[0] + frame.forwardX * point[2],
    baseY + point[1],
    cz + frame.rightZ * point[0] + frame.forwardZ * point[2],
  ];
  loftRings(context.body, rings, frames, strata, place);
  const crown = archColliders(context.out, frames, rings, frame, place);
  addRubble(context, shape, strata, frame, [cx, baseY, cz], rng);
  return { crown, baseY };
}

export function buildArchChain(context, read) {
  const { rng, out } = context;
  const sizes = {
    span: read.range('span', ARCH_CHAIN_DEFAULTS.span, 20, 400),
    height: read.range('height', ARCH_CHAIN_DEFAULTS.height, 10, 300),
    legThickness: read.range('legThickness', ARCH_CHAIN_DEFAULTS.legThickness, 2, 60),
    topThickness: read.range('topThickness', ARCH_CHAIN_DEFAULTS.topThickness, 1.5, 40),
    depth: read.range('depth', ARCH_CHAIN_DEFAULTS.depth, 3, 80),
  };
  const margin = read.number('margin', ARCH_CHAIN_DEFAULTS.margin, 0, 50);
  const styleName = read.choice('style', ARCH_CHAIN_DEFAULTS.style, STYLE_NAMES);
  const siteBiome = context.site && Object.hasOwn(STYLES, context.site.biome) ? context.site.biome : 'meadows';
  const style = STYLES[styleName === 'auto' ? siteBiome : styleName];
  const frame = frameFromHeading(context.heading);
  // The arches: one per challenge gate, else `count` along the heading.
  const placements = [];
  if (context.challenge) {
    for (const gate of context.challenge.gates) {
      const along = gate.along;
      const across = gate.across ?? 0;
      const round = (gate.shape ?? 'circle') === 'circle';
      placements.push({
        x: frame.forwardX * along + frame.rightX * across,
        z: frame.forwardZ * along + frame.rightZ * across,
        heading: context.heading + (gate.heading ?? 0),
        gate: { height: gate.height, halfWidth: round ? gate.radius : gate.halfWidth, halfHeight: round ? gate.radius : gate.halfHeight },
      });
    }
  } else {
    const count = read.integer('count', ARCH_CHAIN_DEFAULTS.count, 1, 12);
    const spacing = read.number('spacing', ARCH_CHAIN_DEFAULTS.spacing, 60, 2000);
    for (let index = 0; index < count; index++) {
      const along = (index - (count - 1) / 2) * spacing;
      placements.push({ x: frame.forwardX * along, z: frame.forwardZ * along, heading: context.heading, gate: null });
    }
  }
  let reach = 20;
  let crownSum = 0;
  for (const placement of placements) {
    const shape = archShape(rng, sizes, placement.gate, margin);
    const built = buildArch(context, shape, style, placement.x, placement.z, placement.heading, rng);
    reach = Math.max(reach, Math.hypot(placement.x, placement.z) + shape.halfSpan + 30);
    crownSum += built.crown[1] - built.baseY;
  }
  // The voice (wind moaning through the stone) and the wind probe at the middle of the chain.
  const middle = placements[Math.floor(placements.length / 2)];
  const middleGround = context.ground(middle.x, middle.z);
  out.audioPoint = [middle.x, middleGround + (crownSum / placements.length) * 0.5, middle.z];
  out.windProbe = [middle.x, middleGround + 30, middle.z];
  out.radius = Math.max(out.radius, reach);
}
