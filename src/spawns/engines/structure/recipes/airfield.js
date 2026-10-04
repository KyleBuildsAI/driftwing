// Recipe 'airfield': an abandoned strip on the site's flatten stamp. Worn tarmac in patchwork
// shades with weeds in the cracks, faded markings (threshold piano keys, runway numbers, touchdown
// bars, centreline dashes and edge lines, worn away in places), quonset hangar ruins with missing
// roof panels, a derelict hut, broken edge lights and fence posts, and a windsock that shows the
// real WindField wind (the engine animates it). The runway is a landing zone: the engine grades
// touchdowns on it. airfieldGroundStart() offers its thresholds as ground-start spots.
// Without a flatten stamp (a debug spawn) the strip is laid along the spawn heading and draped over
// the ground.
import { PALETTE, paint } from '../palette.js';
import { findStamp, frameFromHeading, headingOf, pick } from '../common.js';
import { mixPaint } from '../meshBuilder.js';
import { localBox, localCylinder, localHull } from '../colliders.js';

export const AIRFIELD_DEFAULTS = Object.freeze({
  stamp: 0,
  length: 1200,
  width: 45,
  fade: 0.5,
  weeds: 0.25,
  hangars: Object.freeze({ count: 2, ruin: 0.55, length: 18, width: 24, height: 8.5, spacing: 34 }),
  windsock: true,
  hut: true,
  edgeLights: true,
  fence: true,
  groundStart: true,
  landing: true,
});

/** Seven-segment layout per digit: which of a, b, c, d, e, f, g are lit. */
const DIGIT_SEGMENTS = Object.freeze([
  'abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg',
]);
const DRAPE_LIFT = 0.12;
const MARK_LIFT = 0.16;

/** The runway frame from the site's flatten stamp, or null. */
function runwayFromStamp(site, stampIndex) {
  const flatten = findStamp(site, 'flatten', stampIndex);
  if (!flatten) return null;
  return {
    x: flatten.x, z: flatten.z, y: flatten.y, dirX: flatten.dirX, dirZ: flatten.dirZ,
    length: flatten.length, width: flatten.width, margin: flatten.margin, thresholds: flatten.thresholds,
  };
}

/**
 * Ground-start spots a discovered airfield offers (the engine's groundStart hook): one just inside
 * each threshold, facing down the runway. Pure: reads only the site's resolved flatten stamp.
 * Returns null without a stamp.
 */
export function airfieldGroundStart(site, params = {}) {
  if (params.groundStart === false) return null;
  const runway = runwayFromStamp(site, Number.isInteger(params.stamp) ? params.stamp : 0);
  if (!runway) return null;
  const inset = Math.min(60, runway.length * 0.06);
  const spots = [];
  for (const end of [0, 1]) {
    const sign = end === 0 ? 1 : -1;
    const threshold = runway.thresholds[end];
    spots.push({
      x: threshold.x + runway.dirX * inset * sign,
      z: threshold.z + runway.dirZ * inset * sign,
      y: runway.y,
      heading: headingOf(runway.dirX * sign, runway.dirZ * sign),
      runwayLength: runway.length - inset,
    });
  }
  return spots;
}

export function buildAirfield(context, read) {
  const { rng, body, detail, decal, out } = context;
  const stampIndex = read.integer('stamp', AIRFIELD_DEFAULTS.stamp, 0, 16);
  const fade = read.number('fade', AIRFIELD_DEFAULTS.fade, 0, 1);
  const weeds = read.number('weeds', AIRFIELD_DEFAULTS.weeds, 0, 1);
  const runway = runwayFromStamp(context.site, stampIndex);
  let cx = 0;
  let cz = 0;
  let dirX;
  let dirZ;
  let length;
  let width;
  let margin;
  let flatY = null;
  if (runway) {
    cx = runway.x - context.anchor.x;
    cz = runway.z - context.anchor.z;
    dirX = runway.dirX;
    dirZ = runway.dirZ;
    length = runway.length;
    width = runway.width;
    margin = runway.margin;
    flatY = runway.y - context.anchor.y;
  } else {
    const frame = frameFromHeading(context.heading);
    dirX = frame.forwardX;
    dirZ = frame.forwardZ;
    length = read.number('length', AIRFIELD_DEFAULTS.length, 200, 4000);
    width = read.number('width', AIRFIELD_DEFAULTS.width, 12, 120);
    margin = 36;
  }
  const rightX = -dirZ;
  const rightZ = dirX;
  const halfLength = length * 0.5;
  const halfWidth = width * 0.5;
  /** Local point and draped height at (along, across) in the runway frame. */
  const at = (along, across) => [cx + dirX * along + rightX * across, cz + dirZ * along + rightZ * across];
  const groundAt = (along, across) => {
    const [x, z] = at(along, across);
    return flatY !== null ? flatY : context.ground(x, z);
  };
  const vertex = (along, across, lift) => {
    const [x, z] = at(along, across);
    return [x, groundAt(along, across) + lift, z];
  };
  const markQuad = (builder, along0, along1, across0, across1, lift) => {
    // Counter-clockwise seen from above: (along0, across0) -> (along0, across1) -> (along1, across1).
    builder.quad(vertex(along0, across0, lift), vertex(along0, across1, lift), vertex(along1, across1, lift), vertex(along1, across0, lift));
  };

  // ---- Surface: patchwork tarmac, weeds in the cracks, gravel shoulders -------------------------
  const cell = 20;
  const cells = Math.ceil(length / cell);
  const lanes = [-halfWidth - 5, -halfWidth, -halfWidth / 3, halfWidth / 3, halfWidth, halfWidth + 5];
  for (let index = 0; index < cells; index++) {
    const along0 = -halfLength + index * cell;
    const along1 = Math.min(halfLength, along0 + cell);
    for (let lane = 0; lane < lanes.length - 1; lane++) {
      const shoulder = lane === 0 || lane === lanes.length - 2;
      let surface = shoulder ? PALETTE.gravel : pick(PALETTE.tarmac, rng);
      if (!shoulder && rng() < weeds * 0.5) surface = mixPaint(surface, PALETTE.tarmacWeed, 0.35 + rng() * 0.4);
      decal.setPaint(surface);
      markQuad(decal, along0, along1, lanes[lane], lanes[lane + 1], DRAPE_LIFT);
    }
  }
  // Weed tufts pushing through (near detail).
  const tufts = Math.round(weeds * length * 0.12);
  for (let tuft = 0; tuft < tufts; tuft++) {
    const along = (rng() - 0.5) * length;
    const across = (rng() - 0.5) * width;
    const [x, z] = at(along, across);
    const y = groundAt(along, across) + DRAPE_LIFT;
    const size = 0.5 + rng() * 1.2;
    detail.setPaint(pick(PALETTE.grass, rng)).lathe(x, y - 0.05, z, [[size, 0], [0, size * 0.7]], 5, { phase: rng() * 6 });
  }

  // ---- Markings, faded and worn --------------------------------------------------------------
  const markPaint = () => mixPaint(PALETTE.marking, PALETTE.tarmac[0], Math.min(0.92, fade * (0.55 + 0.45 * rng())));
  const worn = () => rng() < fade * 0.35;
  const mark = (along0, along1, across0, across1) => {
    if (worn()) return;
    decal.setPaint(markPaint());
    // A worn mark may be broken in two with a gap.
    if (rng() < fade * 0.4 && along1 - along0 > 4) {
      const cut = along0 + (along1 - along0) * (0.3 + rng() * 0.4);
      const gap = (along1 - along0) * 0.15;
      markQuad(decal, along0, cut - gap * 0.5, across0, across1, MARK_LIFT);
      markQuad(decal, cut + gap * 0.5, along1, across0, across1, MARK_LIFT);
      return;
    }
    markQuad(decal, along0, along1, across0, across1, MARK_LIFT);
  };
  const headingA = headingOf(dirX, dirZ);
  const numbers = [runwayNumber(headingA), runwayNumber(headingA + 180)];
  for (const end of [0, 1]) {
    // `sign` turns the runway frame around for the far threshold, so its marks read from its approach.
    const sign = end === 0 ? 1 : -1;
    const fromThreshold = (along) => sign * (-halfLength + along);
    const stripes = Math.max(2, Math.floor((halfWidth - 3) / 3.6));
    for (let stripe = 0; stripe < stripes; stripe++) {
      for (const side of [-1, 1]) {
        const inner = 3 + stripe * 3.6;
        const a0 = fromThreshold(6);
        const a1 = fromThreshold(36);
        mark(Math.min(a0, a1), Math.max(a0, a1), side < 0 ? -inner - 1.8 : inner, side < 0 ? -inner : inner + 1.8);
      }
    }
    // Runway number: two seven-segment digits upright for the pilot on this approach.
    const number = numbers[end];
    const digits = number < 10 ? [0, number] : [Math.floor(number / 10), number % 10];
    const digitHeight = Math.min(18, width * 0.4);
    const digitWidth = digitHeight * 0.5;
    const numberStart = 44;
    for (let digit = 0; digit < 2; digit++) {
      const centreAcross = sign * (digit === 0 ? -digitWidth * 0.8 : digitWidth * 0.8);
      addDigit(digits[digit], numberStart, centreAcross, digitWidth, digitHeight, sign, fromThreshold, mark);
    }
    // Touchdown zone bars at 150 m.
    for (const side of [-1, 1]) {
      for (let bar = 0; bar < 3; bar++) {
        const inner = 4 + bar * 3;
        const a0 = fromThreshold(150);
        const a1 = fromThreshold(172);
        mark(Math.min(a0, a1), Math.max(a0, a1), side < 0 ? -inner - 1.8 : inner, side < 0 ? -inner : inner + 1.8);
      }
    }
  }
  for (let along = -halfLength + 80; along < halfLength - 110; along += 50) mark(along, along + 30, -0.5, 0.5);
  for (let along = -halfLength; along < halfLength; along += 20) {
    mark(along, along + 20, -halfWidth + 0.8, -halfWidth + 1.6);
    mark(along, along + 20, halfWidth - 1.6, halfWidth - 0.8);
  }

  // ---- Hangar ruins ------------------------------------------------------------------------
  const hangarParams = read.object('hangars', AIRFIELD_DEFAULTS.hangars);
  const hangarsRead = read.nested('hangars');
  const hangarCount = hangarParams ? hangarsRead.integer('count', AIRFIELD_DEFAULTS.hangars.count, 0, 6) : 0;
  const ruin = hangarsRead.number('ruin', AIRFIELD_DEFAULTS.hangars.ruin, 0, 1);
  const hangarLength = hangarsRead.number('length', AIRFIELD_DEFAULTS.hangars.length, 6, 60);
  const hangarWidth = hangarsRead.number('width', AIRFIELD_DEFAULTS.hangars.width, 6, 60);
  const hangarHeight = hangarsRead.number('height', AIRFIELD_DEFAULTS.hangars.height, 3, 25);
  const hangarSpacing = hangarsRead.number('spacing', AIRFIELD_DEFAULTS.hangars.spacing, hangarWidth + 2, 200);
  // Hangars stand on the flat apron beside the runway (the flatten stamp's margin), doors facing it.
  const apronAcross = halfWidth + Math.min(8, margin * 0.25);
  const firstAlong = -halfLength + Math.min(length * 0.2, 220);
  for (let hangar = 0; hangar < hangarCount; hangar++) {
    const along = firstAlong + hangar * hangarSpacing;
    addHangar(context, at, groundAt, along, apronAcross, hangarLength, hangarWidth, hangarHeight, ruin, dirX, dirZ);
    // Apron in front of the door.
    decal.setPaint(pick(PALETTE.tarmac, rng));
    markQuad(decal, along - hangarWidth * 0.55, along + hangarWidth * 0.55, halfWidth + 5, apronAcross, DRAPE_LIFT);
  }
  if (read.boolean('hut', AIRFIELD_DEFAULTS.hut)) {
    const along = firstAlong + hangarCount * hangarSpacing + 6;
    const [x, z] = at(along, apronAcross + 6);
    const y = groundAt(along, apronAcross + 6);
    const yaw = Math.atan2(rightZ, rightX);
    body.setPaint(PALETTE.concrete).box(x, y + 1.3, z, 6, 3.6, 5, yaw);
    out.colliders.push(localBox('hut', x, y + 1.6, z, 6.6, 4.2, 5.6, yaw, { surface: 'stone', landable: true }));
    out.colliders.push(localBox('tower', x, y + 4.8, z, 4, 2.4, 4, yaw, { surface: 'stone', landable: true }));
    body.setPaint(PALETTE.concreteDark).box(x, y + 3.3, z, 6.6, 0.4, 5.6, yaw);
    // Lookout cab with dark, glassless windows.
    body.setPaint(PALETTE.concrete).box(x, y + 4.6, z, 3.4, 2.2, 3.4, yaw);
    detail.setPaint(PALETTE.window).box(x, y + 4.8, z, 3.5, 1.1, 3.5, yaw);
    body.setPaint(PALETTE.rust[1]).box(x, y + 5.85, z, 4, 0.3, 4, yaw);
  }

  // ---- Windsock ------------------------------------------------------------------------------
  if (read.boolean('windsock', AIRFIELD_DEFAULTS.windsock)) {
    const along = -halfLength + Math.min(90, length * 0.1);
    const across = -(halfWidth + 16);
    const [x, z] = at(along, across);
    const y = groundAt(along, across);
    const poleHeight = 7.5;
    body.setPaint(PALETTE.concrete).prism(x, y - 0.6, z, 6, 0.9, 0.8, 0.9);
    body.setPaint(PALETTE.metalDark).prism(x, y, z, 6, 0.12, 0.09, poleHeight);
    out.colliders.push(localCylinder('windsockPole', x, y - 0.6, z, 0.2, poleHeight + 0.6, { surface: 'metal' }));
    detail.setPaint(PALETTE.metalDark).beam(x, y + poleHeight - 0.1, z, x + 0.5, y + poleHeight - 0.1, z, 0.08, 0.08);
    out.socks.push({ x, y: y + poleHeight - 0.1, z, length: 4.2, radius: 0.5 });
    out.windProbe = [x, y + poleHeight, z];
  }

  // ---- Edge lights, fence ---------------------------------------------------------------------
  if (read.boolean('edgeLights', AIRFIELD_DEFAULTS.edgeLights)) {
    for (let along = -halfLength + 30; along < halfLength; along += 60) {
      for (const side of [-1, 1]) {
        if (rng() < 0.25) continue;
        const [x, z] = at(along, side * (halfWidth + 2));
        const y = groundAt(along, side * (halfWidth + 2));
        const lean = rng() < 0.3 ? (rng() - 0.5) * 1.2 : 0;
        detail.setPaint(PALETTE.metalDark).beam(x, y, z, x + lean * 0.3, y + 0.8, z + lean * 0.3, 0.12, 0.12);
        detail.setPaint(rng() < 0.5 ? paint(0x8a8466) : paint(0x5c6b72)).box(x + lean * 0.3, y + 0.9, z + lean * 0.3, 0.3, 0.25, 0.3);
      }
    }
  }
  if (read.boolean('fence', AIRFIELD_DEFAULTS.fence)) {
    const fenceAcross = -(halfWidth + Math.max(20, margin * 0.8));
    for (let along = -halfLength * 0.8; along < halfLength * 0.8; along += 12) {
      if (rng() < 0.2) continue;
      const [x, z] = at(along, fenceAcross);
      const y = context.ground(x, z);
      const lean = (rng() - 0.5) * 0.6;
      detail.setPaint(PALETTE.timberDark).beam(x, y - 0.4, z, x + lean * dirX, y + 1.4, z + lean * dirZ, 0.14, 0.14);
    }
  }

  out.zones.push({
    id: 'runway', x: cx, z: cz, dirX, dirZ, halfLength, halfWidth, y: flatY !== null ? flatY : groundAt(0, 0), numbers,
    graded: read.boolean('landing', AIRFIELD_DEFAULTS.landing),
  });
  out.radius = Math.max(out.radius, halfLength + 40);
  out.audioPoint = [cx, groundAt(0, 0) + 5, cz];
  if (!out.windProbe) out.windProbe = [cx, groundAt(0, 0) + 10, cz];
}

/** The painted runway number for a landing heading (degrees): 1..36. */
function runwayNumber(heading) {
  const number = Math.round((((heading % 360) + 360) % 360) / 10) % 36;
  return number === 0 ? 36 : number;
}

/**
 * One seven-segment digit painted on the runway: its bottom edge `start` metres past the threshold,
 * centred `centreAcross` across the frame, upright for a pilot approaching on this end's heading.
 */
function addDigit(digit, start, centreAcross, digitWidth, digitHeight, sign, fromThreshold, mark) {
  const stroke = Math.max(0.9, digitWidth * 0.18);
  const half = digitWidth * 0.5;
  const middle = start + digitHeight * 0.5;
  const top = start + digitHeight;
  // Segments as [alongFrom, alongTo, acrossFrom, acrossTo] in the pilot's frame (across + = right).
  const segments = {
    a: [top - stroke, top, -half, half],
    b: [middle, top, half - stroke, half],
    c: [start, middle, half - stroke, half],
    d: [start, start + stroke, -half, half],
    e: [start, middle, -half, -half + stroke],
    f: [middle, top, -half, -half + stroke],
    g: [middle - stroke * 0.5, middle + stroke * 0.5, -half, half],
  };
  for (const key of DIGIT_SEGMENTS[digit]) {
    const [along0, along1, across0, across1] = segments[key];
    const a0 = fromThreshold(along0);
    const a1 = fromThreshold(along1);
    // The far end's frame is turned around: its right is the runway frame's left.
    const c0 = centreAcross + sign * across0;
    const c1 = centreAcross + sign * across1;
    mark(Math.min(a0, a1), Math.max(a0, a1), Math.min(c0, c1), Math.max(c0, c1));
  }
}

/**
 * A quonset hangar ruin: a corrugated half-barrel whose axis runs away from the runway, its open end
 * facing it, with missing roof panels (ruin), exposed ribs, a back wall and fallen doors.
 */
function addHangar(context, at, groundAt, along, apronAcross, hangarLength, hangarWidth, hangarHeight, ruin, dirX, dirZ) {
  const { rng, body, detail } = context;
  const radius = hangarWidth * 0.5;
  const lift = hangarHeight / radius;
  const panels = 12;
  const bays = Math.max(3, Math.round(hangarLength / 3));
  const baseY = groundAt(along, apronAcross + hangarLength * 0.5);
  const point = (bay, panel, inset = 0) => {
    const theta = (panel / panels) * Math.PI;
    const across = apronAcross + (bay / bays) * hangarLength;
    const alongOffset = Math.cos(theta) * (radius - inset);
    const [x, z] = at(along + alongOffset, across);
    return [x, baseY + Math.sin(theta) * (radius - inset) * lift, z];
  };
  // Floor slab, sunk so a gentle slope never shows under it.
  // Its collider: the hull of the half-barrel's end arches (ruined panels and all: a hangar is solid),
  // landable where its roof is flat enough (contract b.8).
  const arch = [];
  for (const bay of [0, bays]) for (let panel = 0; panel <= panels; panel++) arch.push(point(bay, panel));
  context.out.colliders.push(localHull('hangar', arch, { surface: 'metal', landable: true }));
  const [slabX, slabZ] = at(along, apronAcross + hangarLength * 0.5);
  const slabYaw = Math.atan2(dirZ, dirX);
  body.setPaint(PALETTE.concreteDark).box(slabX, baseY - 1.2, slabZ, hangarWidth + 1, 2.6, hangarLength + 1, slabYaw);
  for (let bay = 0; bay < bays; bay++) {
    for (let panel = 0; panel < panels; panel++) {
      // Ruin opens holes mostly in the upper roof, never on the end bays' lowest panels.
      const upper = panel > 2 && panel < panels - 3;
      if (upper && rng() < ruin * 0.5) continue;
      const outer = rng() < 0.35 + ruin * 0.3 ? pick(PALETTE.rust, rng) : pick(PALETTE.corrugated, rng);
      const a = point(bay, panel);
      const b = point(bay, panel + 1);
      const c = point(bay + 1, panel + 1);
      const d = point(bay + 1, panel);
      body.setPaint(outer).quad(a, b, c, d);
      body.setPaint(PALETTE.hangarShadow).quad(a, d, c, b);
    }
  }
  // Ribs at every bay line.
  for (let bay = 0; bay <= bays; bay++) {
    for (let panel = 0; panel < panels; panel++) {
      const a = point(bay, panel, 0.15);
      const b = point(bay, panel + 1, 0.15);
      detail.setPaint(PALETTE.metalDark).beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.22, 0.22);
    }
  }
  // Back wall: a half disc, both faces, with a broken patch when ruined.
  const [backX, backZ] = at(along, apronAcross + hangarLength);
  for (let panel = 0; panel < panels; panel++) {
    if (ruin > 0.5 && panel === Math.floor(panels * 0.4)) continue;
    const a = point(bays, panel);
    const b = point(bays, panel + 1);
    body.setPaint(pick(PALETTE.corrugated, rng)).triangle(backX, baseY, backZ, a[0], a[1], a[2], b[0], b[1], b[2]);
    body.setPaint(PALETTE.hangarShadow).triangle(backX, baseY, backZ, b[0], b[1], b[2], a[0], a[1], a[2]);
  }
  // Doors: one still hanging at the side of the opening, one fallen flat on the apron when ruined.
  const doorHeight = hangarHeight * 0.7;
  const [doorX, doorZ] = at(along - radius * 0.72, apronAcross - 0.3);
  body.setPaint(pick(PALETTE.corrugated, rng)).box(doorX, baseY + doorHeight * 0.5, doorZ, radius * 0.55, doorHeight, 0.25, slabYaw);
  if (ruin > 0.35) {
    const [fallenX, fallenZ] = at(along + radius * 0.3, apronAcross - doorHeight * 0.55);
    detail.setPaint(pick(PALETTE.rust, rng)).box(fallenX, baseY + 0.2, fallenZ, radius * 0.55, 0.3, doorHeight, slabYaw + (rng() - 0.5) * 0.3);
  }
  // Oil drums and crates by the door.
  for (let item = 0; item < 3; item++) {
    const [x, z] = at(along + (rng() - 0.5) * radius * 1.6, apronAcross + 1.5 + rng() * hangarLength * 0.6);
    if (rng() < 0.5) detail.setPaint(pick(PALETTE.rust, rng)).prism(x, baseY, z, 7, 0.45, 0.45, 1.1);
    else detail.setPaint(pick(PALETTE.timber, rng)).box(x, baseY + 0.5, z, 1.2, 1, 1.2, rng() * 3);
  }
}
