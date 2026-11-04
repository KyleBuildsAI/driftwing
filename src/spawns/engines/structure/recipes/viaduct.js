// Recipe 'viaduct' (preset 56, the steam train on a stone viaduct): a curving line of semicircular
// stone arches on tall tapering piers carries a railway across the site's gorge (the gorge stamp),
// from a tunnel portal cut into the hillside on one anchor pad to another on the far pad. A steam train
// (a locomotive, its tender and a few coaches: the engine's movers, posed by this recipe's animate
// hook on a PathFollower) comes out of one tunnel whistling, crosses at speed with steam pouring from
// its chimney (dynamic puffs on the mist pool) and disappears into the other tunnel, where it waits
// and comes back. The train is a pure function of flight time, so two clients see the same train.
// Every pier, arch, the deck, the portals and the train are solid; the openings under the arches are
// gates (fly under the arches), and the deck is landable. The voice (the `train` recipe) rides on the
// locomotive: its chuff follows the train's speed and the whistle sounds as it leaves a tunnel.
// Without a gorge stamp (a debug spawn) the viaduct spans `length` metres across the heading, its deck
// 30 m over the ground.
import { PALETTE } from '../palette.js';
import { addBoulder, addPine, findStamp, frameFromHeading, pick } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox } from '../colliders.js';
import { HERITAGE, addArchRing, outwardQuad } from '../heritage.js';
import { createPath, createPathFollower } from '../../../../world/pathFollower.js';

export const VIADUCT_DEFAULTS = Object.freeze({
  stamp: 0,
  span: [20, 26],
  deckWidth: 6.4,
  coaches: [2, 4],
  speed: [11, 15],
  wait: [35, 60],
  length: 260,
  achievement: null,
  start: null,
});

/** The rail bed sits this far (m) above the gorge's rim (the anchor pads). */
const BED_RISE = 0.6;
const DECK_DEPTH = 1.4;
const RING = 1.1;
const SPANDREL_MIN = 0.8;
const PARAPET = 0.95;
/** The tunnel: its opening (m), the headwall and how deep the dark tube runs into the hill. */
const BORE_WIDTH = 5.6;
const BORE_SPRING = 4.4;
const HEADWALL_WIDTH = 15;
const HEADWALL_HEIGHT = 10.5;
const TUBE_DEPTH = 26;
/** A car vanishes once it is this far (m) past its own half length inside a portal. */
const HIDE_DEPTH = 3;
/** The path runs on this far (m) beyond the longest train inside each tunnel, where the train turns. */
const TUNNEL_SLACK = 40;
const LOCO_LENGTH = 11;
const TENDER_LENGTH = 6.4;
const COACH_LENGTH = 14;
const COUPLING = 0.6;
/** Steam: puff slots, the interval between puffs at speed (s), their life (s). */
const PUFFS = 18;
const PUFF_INTERVAL = 0.18;
const PUFF_LIFE = 3.2;
/** The chimney's top in the locomotive's frame (m): up and forward of its centre. */
const CHIMNEY_UP = 4.05;
const CHIMNEY_FORWARD = 4.5;
const STONE = Object.freeze([paint(0x9a8f80), paint(0x8b8173), paint(0xa49a8a), paint(0x837a6c)]);
const STONE_DARK = paint(0x6c6459);
const BALLAST = paint(0x5d5852);
const STEEL = paint(0x4a4c50);
const RAIL = paint(0x8a8c90);
const SLEEPER = paint(0x4b3a2c);
const BORE_DARK = paint(0x161412);
const SIGNAL_RED = paint(0xff3a24, 3);

export function buildViaduct(context, read) {
  const { rng, body, detail, out } = context;
  const spanTarget = roll(read.range('span', VIADUCT_DEFAULTS.span, 10, 60), rng);
  const deckWidth = read.number('deckWidth', VIADUCT_DEFAULTS.deckWidth, 3, 14);
  const coaches = rollInteger(read.range('coaches', VIADUCT_DEFAULTS.coaches, 0, 6), rng);
  const speed = roll(read.range('speed', VIADUCT_DEFAULTS.speed, 2, 40), rng);
  const waitSeconds = roll(read.range('wait', VIADUCT_DEFAULTS.wait, 0, 600), rng);
  const achievement = read.object('achievement', VIADUCT_DEFAULTS.achievement);
  // null: the train is a pure function of flight time (from a seeded place); a share puts it there at
  // the activation (a debug or test spawn that wants it on the viaduct now).
  const start = read.has('start') ? read.number('start', 0, 0, 1) : null;
  const stamp = findStamp(context.site, 'gorge', read.number('stamp', 0, 0, 16));

  // ---- The line: anchor pad A to anchor pad B (the gorge's anchors, or across the heading) ----
  let ax;
  let az;
  let bx;
  let bz;
  let bedY;
  if (stamp) {
    ax = stamp.anchors[0].x - context.anchor.x;
    az = stamp.anchors[0].z - context.anchor.z;
    bx = stamp.anchors[1].x - context.anchor.x;
    bz = stamp.anchors[1].z - context.anchor.z;
    bedY = stamp.rimY - context.anchor.y + BED_RISE;
  } else {
    const length = read.number('length', VIADUCT_DEFAULTS.length, 60, 1200);
    const heading = frameFromHeading(context.heading);
    ax = -heading.rightX * length / 2;
    az = -heading.rightZ * length / 2;
    bx = heading.rightX * length / 2;
    bz = heading.rightZ * length / 2;
    bedY = Math.max(context.ground(ax, az), context.ground(bx, bz), context.ground(0, 0) + 30) + BED_RISE;
  }
  const lineLength = Math.hypot(bx - ax, bz - az);
  const lineX = (bx - ax) / lineLength;
  const lineZ = (bz - az) / lineLength;
  // Across the line (the arches' depth axis): the builder frame's local +z for a yaw of atan2(lineZ, lineX).
  const crossX = -lineZ;
  const crossZ = lineX;
  const archYaw = Math.atan2(lineZ, lineX);
  const lineYaw = Math.atan2(lineX, -lineZ);
  const pointX = (along, across = 0) => ax + lineX * along + crossX * across;
  const pointZ = (along, across = 0) => az + lineZ * along + crossZ * across;
  const groundAt = (along, across = 0) => context.ground(pointX(along, across), pointZ(along, across));
  const deckBottom = bedY - DECK_DEPTH;

  // The lips: walk in from each pad until the ground falls away below the deck.
  const lip = (from, step) => {
    for (let along = from; Math.abs(along - from) < lineLength * 0.5; along += step) {
      if (groundAt(along) < deckBottom - 2) return along - step;
    }
    return from + step * lineLength * 0.2;
  };
  let lipA = lip(0, 1);
  let lipB = lip(lineLength, -1);
  if (lipB - lipA < 30) {
    lipA = lineLength * 0.2;
    lipB = lineLength * 0.8;
  }

  // ---- Arches and piers ----
  const gap = lipB - lipA;
  const spans = Math.max(2, Math.round(gap / spanTarget));
  const spacing = gap / spans;
  const pierTop = Math.min(Math.max(spacing * 0.16, 2.4), 4.2);
  const radius = (spacing - pierTop) / 2;
  const springY = deckBottom - RING - SPANDREL_MIN - radius;
  const halfDeck = deckWidth / 2;
  const colliderStone = { surface: 'stone' };
  body.setTransform(ax, 0, az, archYaw);
  for (let pier = 0; pier <= spans; pier++) {
    const along = lipA + pier * spacing;
    const lowest = Math.min(groundAt(along - pierTop, -halfDeck), groundAt(along + pierTop, halfDeck), groundAt(along, 0));
    if (pier === 0 || pier === spans) {
      // An abutment: a masonry block from the lip back toward the pad.
      const outward = pier === 0 ? -1 : 1;
      const inner = along - outward * pierTop / 2;
      const outer = along + outward * 12;
      const footY = Math.min(lowest, groundAt(outer)) - 2;
      taperedBlock(body, (inner + outer) / 2, footY, deckBottom, Math.abs(outer - inner) / 2 + 0.6, Math.abs(outer - inner) / 2, halfDeck + 0.9, halfDeck + 0.3, pick(STONE, rng));
      const centre = (inner + outer) / 2;
      out.colliders.push(localBox(`abutment${pier === 0 ? 0 : 1}`, pointX(centre), (footY + deckBottom) / 2, pointZ(centre), deckWidth + 1.8, deckBottom - footY, Math.abs(outer - inner) + 1.2, lineYaw, colliderStone));
      continue;
    }
    if (lowest >= springY) continue;
    const footY = lowest - 2;
    const height = springY - footY;
    // The pier batters out toward its foot: 1 in 30 each side, and a plinth course.
    const batter = height / 30;
    taperedBlock(body, along, footY, springY + 0.02, pierTop / 2 + batter, pierTop / 2, halfDeck + 0.5 + batter, halfDeck + 0.5, pick(STONE, rng));
    body.setPaint(STONE_DARK).box(along, springY - 0.4, 0, pierTop + 0.5, 0.5, deckWidth + 1.5);
    const middle = footY + height * 0.5;
    out.colliders.push(localBox(`pierLow${pier}`, pointX(along), (footY + middle) / 2, pointZ(along), deckWidth + 1 + batter * 2, middle - footY, pierTop + batter * 2, lineYaw, colliderStone));
    out.colliders.push(localBox(`pierHigh${pier}`, pointX(along), (middle + deckBottom) / 2, pointZ(along), deckWidth + 1 + batter, deckBottom - middle, pierTop + batter, lineYaw, colliderStone));
  }
  for (let span = 0; span < spans; span++) {
    const centre = lipA + (span + 0.5) * spacing;
    body.resetTransform();
    body.setTransform(pointX(centre), 0, pointZ(centre), archYaw);
    addArchRing(body, 0, springY, 0, radius, RING, deckWidth, 12, STONE, rng);
    // The spandrels: both faces from the ring's back to the deck, in vertical slices.
    // They run on over each pier's top to its centre line, where the next span's spandrels take over.
    const slices = 12;
    const reach = radius + pierTop / 2;
    for (let slice = 0; slice < slices; slice++) {
      const x0 = -reach + (slice / slices) * reach * 2;
      const x1 = -reach + ((slice + 1) / slices) * reach * 2;
      const back = (x) => springY + Math.sqrt(Math.max(0, (radius + RING) ** 2 - x * x));
      body.setPaint(pick(STONE, rng));
      for (const side of [-1, 1]) {
        const z = side * halfDeck;
        outwardQuad(body, [x0, back(x0), z], [x1, back(x1), z], [x1, deckBottom, z], [x0, deckBottom, z], [(x0 + x1) / 2, (back(x0) + deckBottom) / 2, 0]);
      }
    }
    // Colliders: the crown and two haunch steps each side, never below the arch's own soffit.
    const crownBottom = springY + radius;
    out.colliders.push(localBox(`crown${span}`, pointX(centre), (crownBottom + deckBottom) / 2, pointZ(centre), deckWidth, deckBottom - crownBottom, radius * 1.1, lineYaw, colliderStone));
    for (const [step, inner, outer] of [[0, 0.55, 0.85], [1, 0.85, 1]]) {
      const bottom = springY + radius * Math.sqrt(1 - inner * inner);
      for (const side of [-1, 1]) {
        const at = centre + side * radius * (inner + outer) / 2;
        out.colliders.push(localBox(`haunch${span}${side < 0 ? 'a' : 'b'}${step}`, pointX(at), (bottom + deckBottom) / 2, pointZ(at), deckWidth, deckBottom - bottom, radius * (outer - inner) + 0.6, lineYaw, colliderStone));
      }
    }
    // The opening under the arch is a gate: flying under the arches.
    const floorY = groundAt(centre);
    if (springY + radius - floorY > 6) {
      context.addGate({
        id: `arch${span}`,
        kind: 'under',
        x: pointX(centre),
        z: pointZ(centre),
        normalX: crossX,
        normalZ: crossZ,
        halfWidth: radius * 0.92,
        minY: floorY - 5,
        maxY: springY + radius * 0.92,
        achievement: achievement ?? null,
      }, 'achievement');
    }
  }
  body.resetTransform();

  // ---- The deck: slab, string course, parapets, ballast, sleepers and rails ----
  const deckFrom = lipA - 14;
  const deckTo = lipB + 14;
  const deckMid = (deckFrom + deckTo) / 2;
  const deckLength = deckTo - deckFrom;
  body.setPaint(pick(STONE, rng)).box(pointX(deckMid), deckBottom + DECK_DEPTH / 2, pointZ(deckMid), deckWidth, DECK_DEPTH, deckLength, lineYaw);
  body.setPaint(STONE_DARK).box(pointX(deckMid), deckBottom + 0.15, pointZ(deckMid), deckWidth + 0.6, 0.3, deckLength, lineYaw);
  for (const side of [-1, 1]) {
    body.setPaint(shade(STONE[0], 0.92)).box(pointX(deckMid, side * (halfDeck - 0.25)), bedY + PARAPET / 2, pointZ(deckMid, side * (halfDeck - 0.25)), 0.5, PARAPET, deckLength, lineYaw);
  }
  out.colliders.push(localBox('deck', pointX(deckMid), (deckBottom + bedY + PARAPET) / 2, pointZ(deckMid), deckWidth, bedY + PARAPET - deckBottom, deckLength, lineYaw, { surface: 'stone', landable: true }));
  const trackFrom = -TUBE_DEPTH;
  const trackTo = lineLength + TUBE_DEPTH;
  const trackMid = (trackFrom + trackTo) / 2;
  const trackLength = trackTo - trackFrom;
  detail.setPaint(BALLAST).box(pointX(trackMid), bedY - 0.12, pointZ(trackMid), 3.3, 0.3, trackLength, lineYaw);
  for (let along = trackFrom + 0.5; along < trackTo; along += 1.1) {
    detail.setPaint(SLEEPER).box(pointX(along), bedY + 0.06, pointZ(along), 2.6, 0.14, 0.26, lineYaw);
  }
  for (const side of [-0.72, 0.72]) {
    detail.setPaint(RAIL).box(pointX(trackMid, side), bedY + 0.2, pointZ(trackMid, side), 0.08, 0.15, trackLength, lineYaw);
  }

  // ---- The tunnel portals on the two pads, cut into a wooded hillock ----
  for (const end of [0, 1]) {
    const at = end === 0 ? 0 : lineLength;
    const outward = end === 0 ? -1 : 1;
    const groundY = bedY - BED_RISE;
    buildPortal(context, at, outward, groundY, { pointX, pointZ, archYaw, lineYaw, rng });
    out.colliders.push(...portalColliders(end, at, outward, groundY, pointX, pointZ, lineYaw));
  }

  // ---- The train: movers on a PathFollower, ping-ponging between the tunnels ----
  const cars = [{ name: 'locomotive', length: LOCO_LENGTH, width: 2.7, height: 4.1, build: buildLocomotive }];
  cars.push({ name: 'tender', length: TENDER_LENGTH, width: 2.6, height: 3.1, build: buildTender });
  const livery = pick([paint(0x6e1f22), paint(0x1f3d5c), paint(0x2c4a2e)], rng);
  for (let index = 0; index < coaches; index++) cars.push({ name: `coach${index}`, length: COACH_LENGTH, width: 2.8, height: 3.9, build: (builder) => buildCoach(builder, livery) });
  const offsets = new Float64Array(cars.length);
  const halves = new Float64Array(cars.length);
  const indices = new Float64Array(cars.length);
  let behind = 0;
  cars.forEach((car, index) => {
    if (index > 0) behind += cars[index - 1].length / 2 + COUPLING + car.length / 2;
    offsets[index] = behind;
    halves[index] = car.length / 2;
    const mover = context.addMover({
      name: car.name,
      kind: 'body',
      collider: { center: [0, car.height / 2, 0], halfExtents: [car.width / 2, car.height / 2, car.length / 2], tags: { surface: 'metal' } },
    });
    car.build(mover.builder);
    indices[index] = mover.index;
  });
  const trainLength = behind + cars[0].length / 2 + cars[cars.length - 1].length / 2;
  const slack = trainLength + TUNNEL_SLACK;
  const railY = bedY + 0.27;
  const path = createPath({
    points: [pointX(-slack), railY, pointZ(-slack), pointX(lineLength + slack), railY, pointZ(lineLength + slack)],
    smoothing: 'linear',
  });
  const follower = createPathFollower({
    path,
    speed,
    mode: 'pingpong',
    startTime: start === null || !Number.isFinite(context.params.startTime) ? 0 : context.params.startTime,
    startDistance: (start === null ? rng() : start) * path.length,
    waits: [{ distance: 0, seconds: waitSeconds }, { distance: path.length, seconds: waitSeconds }],
  });
  out.steam = PUFFS;
  out.animate = animateTrain;
  out.animateState = {
    follower,
    pose: { x: 0.5, y: 0.5, z: 0.5, tx: 0.5, ty: 0.5, tz: 0.5, heading: 0.5, distance: 0.5, speed: 0.5, done: false },
    /** [flight time, car offset] for carAtFrom. */
    query: new Float64Array(2),
    offsets,
    halves,
    indices,
    /** [portal A distance, portal B distance, top speed, puff clock, loco shown (0/1), next puff slot]. */
    config: new Float64Array([slack, slack + lineLength, speed, 0, -1, 0]),
    /** Per puff: local x, y, z, age (s; >= PUFF_LIFE is free). */
    puffs: new Float64Array(PUFFS * 4).fill(PUFF_LIFE),
  };
  out.audioPoint = [pointX(lineLength / 2), bedY + 3, pointZ(lineLength / 2)];
  out.windProbe = [pointX(lineLength / 2), bedY + 10, pointZ(lineLength / 2)];
  out.radius = Math.max(out.radius, lineLength / 2 + TUBE_DEPTH + 20);
}

/**
 * A rectangular block tapering from (halfAlongBottom, halfAcrossBottom) at y0 to the top halves at y1,
 * centred at `along` in the builder's current frame (local x along the line, z across it).
 */
function taperedBlock(builder, along, y0, y1, halfAlongBottom, halfAlongTop, halfAcrossBottom, halfAcrossTop, stone) {
  const inside = [along, (y0 + y1) / 2, 0];
  const corner = (sx, sz, top) => [along + sx * (top ? halfAlongTop : halfAlongBottom), top ? y1 : y0, sz * (top ? halfAcrossTop : halfAcrossBottom)];
  builder.setPaint(stone);
  outwardQuad(builder, corner(-1, -1, false), corner(1, -1, false), corner(1, -1, true), corner(-1, -1, true), inside);
  outwardQuad(builder, corner(1, 1, false), corner(-1, 1, false), corner(-1, 1, true), corner(1, 1, true), inside);
  outwardQuad(builder, corner(-1, 1, false), corner(-1, -1, false), corner(-1, -1, true), corner(-1, 1, true), inside);
  outwardQuad(builder, corner(1, -1, false), corner(1, 1, false), corner(1, 1, true), corner(1, -1, true), inside);
  outwardQuad(builder, corner(-1, -1, true), corner(1, -1, true), corner(1, 1, true), corner(-1, 1, true), inside);
}

/**
 * A tunnel portal at `at` along the line, its bore running `outward` (-1 toward A's side, +1 beyond
 * B): a stone headwall with an arched opening and a dark bore, a grassy cover over the tube, boulders
 * and pines, and a signal with a red lamp beside the track.
 */
function buildPortal(context, at, outward, groundY, frame) {
  const { body, detail, rng } = context;
  const { pointX, pointZ, archYaw, lineYaw } = frame;
  const halfBore = BORE_WIDTH / 2;
  const wallFace = at + outward * 1.2;
  // The headwall: piers either side of the bore, the lintel band above the arch.
  const side = (HEADWALL_WIDTH - BORE_WIDTH) / 2;
  for (const sign of [-1, 1]) {
    const across = sign * (halfBore + side / 2);
    body.setPaint(pick(STONE, rng)).box(pointX(wallFace, across), groundY + HEADWALL_HEIGHT / 2 - 0.5, pointZ(wallFace, across), side, HEADWALL_HEIGHT + 1, 2.4, lineYaw);
  }
  const archTop = BORE_SPRING + halfBore;
  body.setPaint(pick(STONE, rng)).box(pointX(wallFace), groundY + (archTop + HEADWALL_HEIGHT) / 2 + 0.3, pointZ(wallFace), BORE_WIDTH, HEADWALL_HEIGHT - archTop - 0.6, 2.4, lineYaw);
  body.setPaint(STONE_DARK).box(pointX(wallFace), groundY + HEADWALL_HEIGHT + 0.2, pointZ(wallFace), HEADWALL_WIDTH + 0.6, 0.5, 2.8, lineYaw);
  // The arch ring over the bore, in the headwall's plane (local x across the line).
  body.setTransform(pointX(wallFace - outward * 1.25), groundY, pointZ(wallFace - outward * 1.25), archYaw + Math.PI / 2);
  addArchRing(body, 0, BORE_SPRING, 0, halfBore, 0.9, 0.5, 9, STONE, rng);
  body.resetTransform();
  // The spandrels between the ring's back and the lintel band, clear of the opening.
  const spandrelBottom = BORE_SPRING + halfBore * 0.89;
  const spandrelTop = archTop + 0.65;
  for (const sign of [-1, 1]) {
    body.setPaint(pick(STONE, rng)).box(pointX(wallFace, sign * halfBore * 0.79), groundY + (spandrelBottom + spandrelTop) / 2, pointZ(wallFace, sign * halfBore * 0.79), halfBore * 0.43, spandrelTop - spandrelBottom, 2.4, lineYaw);
  }
  // The bore: dark walls, roof and back wall.
  const tubeMid = at + outward * (TUBE_DEPTH / 2 + 1.2);
  for (const sign of [-1, 1]) {
    body.setPaint(BORE_DARK).box(pointX(tubeMid, sign * (halfBore + 0.5)), groundY + archTop / 2, pointZ(tubeMid, sign * (halfBore + 0.5)), 1, archTop, TUBE_DEPTH, lineYaw);
  }
  body.setPaint(BORE_DARK).box(pointX(tubeMid), groundY + archTop + 0.5, pointZ(tubeMid), BORE_WIDTH + 2, 1, TUBE_DEPTH, lineYaw);
  body.setPaint(BORE_DARK).box(pointX(at + outward * (TUBE_DEPTH + 1.2)), groundY + archTop / 2, pointZ(at + outward * (TUBE_DEPTH + 1.2)), BORE_WIDTH, archTop, 0.6, lineYaw);
  // The cover: a grassy mound over the tube with boulders and a few pines.
  const coverMid = at + outward * (TUBE_DEPTH / 2 + 3);
  body.setPaint(pick(PALETTE.grass, rng)).box(pointX(coverMid), groundY + HEADWALL_HEIGHT - 1.4, pointZ(coverMid), HEADWALL_WIDTH + 6, 2.2, TUBE_DEPTH + 4, lineYaw);
  // Rock flanks fill the cover from the tube's walls out to its edges.
  const flankInner = halfBore + 1;
  const flankOuter = HEADWALL_WIDTH / 2 + 3;
  for (const sign of [-1, 1]) {
    const across = sign * (flankInner + flankOuter) / 2;
    body.setPaint(pick(PALETTE.rock, rng)).box(pointX(coverMid, across), groundY + (HEADWALL_HEIGHT - 2.4) / 2, pointZ(coverMid, across), flankOuter - flankInner, HEADWALL_HEIGHT - 2.4, TUBE_DEPTH + 4, lineYaw);
  }
  for (let index = 0; index < 6; index++) {
    const along = at + outward * (4 + rng() * (TUBE_DEPTH - 2));
    const across = (rng() - 0.5) * (HEADWALL_WIDTH + 8);
    addBoulder(body, pointX(along, across), groundY + HEADWALL_HEIGHT - 0.4, pointZ(along, across), 1 + rng() * 1.6, rng);
  }
  for (let index = 0; index < 4; index++) {
    const along = at + outward * (8 + rng() * (TUBE_DEPTH - 6));
    const across = (rng() - 0.5) * HEADWALL_WIDTH;
    addPine(detail, pointX(along, across), groundY + HEADWALL_HEIGHT - 0.3, pointZ(along, across), 7 + rng() * 6, rng);
  }
  // A signal beside the track on the gorge side of the portal, its lamp red.
  const signalAlong = at - outward * 9;
  const signalAcross = BORE_WIDTH / 2 + 1.2;
  detail.setPaint(STEEL).prism(pointX(signalAlong, signalAcross), groundY, pointZ(signalAlong, signalAcross), 5, 0.12, 0.09, 5.6);
  detail.setPaint(HERITAGE.windowDark).box(pointX(signalAlong, signalAcross), groundY + 5.3, pointZ(signalAlong, signalAcross), 0.5, 0.9, 0.3, lineYaw);
  body.setPaint(SIGNAL_RED).box(pointX(signalAlong - outward * 0.17, signalAcross), groundY + 5.45, pointZ(signalAlong - outward * 0.17, signalAcross), 0.24, 0.24, 0.05, lineYaw);
}

/** The portal's colliders: the headwall either side of the bore and over it, the tube walls and its cover. */
function portalColliders(end, at, outward, groundY, pointX, pointZ, lineYaw) {
  const halfBore = BORE_WIDTH / 2;
  const side = (HEADWALL_WIDTH - BORE_WIDTH) / 2;
  const wallFace = at + outward * 1.2;
  const archTop = BORE_SPRING + halfBore;
  const stone = { surface: 'stone' };
  const list = [];
  for (const sign of [-1, 1]) {
    const across = sign * (halfBore + side / 2);
    list.push(localBox(`portal${end}${sign < 0 ? 'l' : 'r'}`, pointX(wallFace, across), groundY + HEADWALL_HEIGHT / 2, pointZ(wallFace, across), side, HEADWALL_HEIGHT, 2.4, lineYaw, stone));
  }
  list.push(localBox(`portal${end}top`, pointX(wallFace), groundY + (BORE_SPRING + HEADWALL_HEIGHT) / 2 + halfBore / 2, pointZ(wallFace), BORE_WIDTH, HEADWALL_HEIGHT - BORE_SPRING - halfBore, 2.4, lineYaw, {
    surface: 'stone', perch: { x: pointX(wallFace), y: groundY + HEADWALL_HEIGHT + 0.5, z: pointZ(wallFace) },
  }));
  const coverMid = at + outward * (TUBE_DEPTH / 2 + 3);
  list.push(localBox(`cover${end}`, pointX(coverMid), groundY + (archTop + HEADWALL_HEIGHT - 0.3) / 2, pointZ(coverMid), HEADWALL_WIDTH + 6, HEADWALL_HEIGHT - 0.3 - archTop, TUBE_DEPTH + 4, lineYaw, { surface: 'stone', landable: true }));
  const flankInner = halfBore + 1;
  const flankOuter = HEADWALL_WIDTH / 2 + 3;
  for (const sign of [-1, 1]) {
    const across = sign * (flankInner + flankOuter) / 2;
    list.push(localBox(`flank${end}${sign < 0 ? 'l' : 'r'}`, pointX(coverMid, across), groundY + (HEADWALL_HEIGHT - 0.3) / 2, pointZ(coverMid, across), flankOuter - flankInner, HEADWALL_HEIGHT - 0.3, TUBE_DEPTH + 4, lineYaw, stone));
  }
  return list;
}

/**
 * The train's animate hook (one function for every viaduct; its instance's numbers in state.custom):
 * each car's pose from the PathFollower at the flight time, hidden deep in a tunnel; the voice on the
 * locomotive, its level the train's speed; the whistle as the locomotive comes out of a tunnel; steam
 * puffs from the chimney while it runs in the open. Allocation-free.
 */
function animateTrain(state, env) {
  const custom = state.custom;
  const config = custom.config;
  const query = custom.query;
  const pose = custom.pose;
  const clock = env.clock;
  const dt = clock[1];
  const poses = state.poses;
  const portalA = config[0];
  const portalB = config[1];
  query[0] = clock[0];
  for (let index = 0; index < custom.offsets.length; index++) {
    query[1] = custom.offsets[index];
    custom.follower.carAtFrom(query, 0, pose);
    const half = custom.halves[index];
    const shown = pose.distance > portalA - half - HIDE_DEPTH && pose.distance < portalB + half + HIDE_DEPTH ? 1 : 0;
    const base = custom.indices[index] * 8;
    // The path is laid in the instance's local frame, as the poses are.
    poses[base] = pose.x;
    poses[base + 1] = pose.y;
    poses[base + 2] = pose.z;
    poses[base + 3] = pose.heading * (Math.PI / 180);
    poses[base + 7] = shown;
    if (index === 0) {
      state.voice[0] = poses[base];
      state.voice[1] = poses[base + 1] + 3;
      state.voice[2] = poses[base + 2];
      state.voice[3] = 1;
      const share = config[2] > 0 ? pose.speed / config[2] : 0;
      state.level[0] = shown === 1 ? 0.25 + 0.75 * share : 0.06 * share;
      // The whistle as the locomotive leaves a tunnel (not on the first frame).
      if (config[4] === 0 && shown === 1) whistle(env);
      config[4] = shown;
      if (shown === 1 && pose.speed > 0 && dt > 0) {
        config[3] -= dt;
        if (config[3] <= 0) {
          config[3] += PUFF_INTERVAL;
          if (config[3] < 0) config[3] = PUFF_INTERVAL;
          const slot = config[5];
          config[5] = (slot + 1) % PUFFS;
          const puff = slot * 4;
          const yaw = poses[base + 3];
          custom.puffs[puff] = poses[base] + Math.sin(yaw) * CHIMNEY_FORWARD;
          custom.puffs[puff + 1] = poses[base + 1] + CHIMNEY_UP;
          custom.puffs[puff + 2] = poses[base + 2] - Math.cos(yaw) * CHIMNEY_FORWARD;
          custom.puffs[puff + 3] = 0;
        }
      }
    }
  }
  // The steam: rising, drifting with the wind the structure shows, swelling and gone after its life.
  const steam = state.steam;
  const puffs = custom.puffs;
  const wind = env.wind;
  for (let slot = 0; slot < PUFFS; slot++) {
    const puff = slot * 4;
    if (puffs[puff + 3] < PUFF_LIFE) {
      const age = puffs[puff + 3];
      puffs[puff] += wind[0] * 0.8 * dt;
      puffs[puff + 1] += (3.2 - age * 0.7) * dt;
      puffs[puff + 2] += wind[1] * 0.8 * dt;
      puffs[puff + 3] = age + dt;
    }
    const base = slot * 4;
    steam[base] = puffs[puff];
    steam[base + 1] = puffs[puff + 1];
    steam[base + 2] = puffs[puff + 2];
    steam[base + 3] = puffs[puff + 3] < PUFF_LIFE ? 0.9 + puffs[puff + 3] * 2.2 : 0;
  }
}

/** Event work: the whistle as the train comes out into the open. */
function whistle(env) {
  env.trigger('whistle', { strength: 1, duration: 1.8 });
}

/** A wheel (radius r, a steel tyre round a coloured centre) at (x, y, z) in the car's frame, axle across. */
function addWheel(builder, x, y, z, radius, centre) {
  builder.setTransform(x, y, z, 0, 0, Math.PI / 2);
  builder.setPaint(STEEL).lathe(0, -0.07, 0, [[radius, 0], [radius, 0.14]], 12, { closeBottom: true, closeTop: true });
  builder.setPaint(centre).lathe(0, -0.09, 0, [[radius * 0.82, 0], [radius * 0.82, 0.18]], 10, { closeBottom: true, closeTop: true });
  builder.resetTransform();
}

/**
 * The locomotive in its own frame (its centre on the rails at the origin, forward -z): a black
 * boiler with a smokebox and chimney, a brass dome, a cab, red buffer beams, six coupled driving
 * wheels and a leading pair, cylinders and a headlamp.
 */
function buildLocomotive(builder) {
  const black = paint(0x1d1d20);
  const green = paint(0x23472f);
  const red = paint(0xa3261f);
  const brass = HERITAGE.gold;
  const half = LOCO_LENGTH / 2;
  builder.setPaint(black).box(0, 1.15, 0, 2.5, 0.32, LOCO_LENGTH);
  builder.setPaint(red).box(0, 1.05, -half + 0.15, 2.7, 0.55, 0.3);
  builder.setPaint(red).box(0, 1.05, half - 0.15, 2.7, 0.55, 0.3);
  for (const side of [-0.85, 0.85]) {
    builder.setPaint(STEEL).box(side, 1.05, -half - 0.25, 0.3, 0.3, 0.5);
  }
  // Boiler along -z: a lathe along +y turned to -z.
  builder.setTransform(0, 2.25, 2.2, 0, -Math.PI / 2, 0);
  builder.setPaint(green).lathe(0, 0, 0, [[0.86, 0], [0.86, 6.4]], 14, { closeTop: true });
  builder.setPaint(black).lathe(0, 6.4, 0, [[0.94, 0], [0.94, 1.1], [0.6, 1.25]], 14, { closeTop: true });
  for (const band of [1.6, 3.4, 5.2]) builder.setPaint(brass).lathe(0, band, 0, [[0.88, 0], [0.88, 0.1]], 14, { closeTop: true, closeBottom: true });
  builder.resetTransform();
  builder.setPaint(black).prism(0, 2.95, -CHIMNEY_FORWARD, 10, 0.28, 0.36, CHIMNEY_UP - 2.95);
  builder.setPaint(brass).lathe(0, 2.95, -1.2, [[0.42, 0], [0.38, 0.35], [0.2, 0.55], [0, 0.6]], 10, { closeBottom: true });
  builder.setPaint(brass).prism(0, 2.95, 0.9, 6, 0.1, 0.08, 0.55);
  // The cab.
  builder.setPaint(green).box(0, 2.45, 3.6, 2.6, 2.4, 2.8);
  builder.setPaint(black).box(0, 3.75, 3.7, 2.9, 0.2, 3.2);
  for (const side of [-1.31, 1.31]) builder.setPaint(HERITAGE.windowDark).box(side, 2.9, 3.4, 0.04, 0.8, 1.1);
  builder.setPaint(HERITAGE.windowDark).box(0, 2.95, 2.19, 1.8, 0.6, 0.04);
  // Cylinders and the headlamp.
  for (const side of [-1.1, 1.1]) builder.setPaint(black).box(side, 1.35, -3.9, 0.55, 0.6, 1.4);
  builder.setPaint(paint(0xfff1c8, 2.5)).box(0, 3.15, -half + 0.05, 0.36, 0.3, 0.12);
  // Wheels: a leading pair and three coupled drivers each side, red centres.
  for (const side of [-1.05, 1.05]) {
    addWheel(builder, side, 0.45, -4.3, 0.45, red);
    for (const z of [-2.5, -0.75, 1.0]) addWheel(builder, side, 0.78, z, 0.78, red);
    builder.setPaint(STEEL).box(side * 1.08, 0.78, -0.75, 0.08, 0.14, 3.6);
  }
}

/** The tender (centre on the rails, forward -z): a tank with a coal load, a frame and three axles. */
function buildTender(builder) {
  const black = paint(0x1d1d20);
  const green = paint(0x23472f);
  builder.setPaint(black).box(0, 1.05, 0, 2.4, 0.3, TENDER_LENGTH);
  builder.setPaint(green).box(0, 2.0, 0, 2.5, 1.6, TENDER_LENGTH - 0.4);
  builder.setPaint(paint(0x141416)).lathe(0, 2.75, 0.4, [[1.1, 0], [0.8, 0.45], [0.3, 0.7]], 7, { closeBottom: true, radiusAt: (ring, sideIndex, value) => value * (1 + 0.6 * Math.cos(sideIndex * 0.9)) });
  for (const side of [-1, 1]) for (const z of [-2.1, 0, 2.1]) addWheel(builder, side, 0.5, z, 0.5, black);
}

/** A coach (centre on the rails, forward -z): livery below a cream band, windows, a clerestory roof, two bogies. */
function buildCoach(builder, livery) {
  const half = COACH_LENGTH / 2;
  const cream = paint(0xe7dcc0);
  builder.setPaint(STEEL).box(0, 1.0, 0, 2.4, 0.3, COACH_LENGTH);
  builder.setPaint(livery).box(0, 1.95, 0, 2.75, 1.6, COACH_LENGTH - 0.2);
  builder.setPaint(cream).box(0, 3.05, 0, 2.75, 0.62, COACH_LENGTH - 0.2);
  builder.setPaint(shade(PALETTE.metalDark, 1.3)).box(0, 3.45, 0, 2.9, 0.2, COACH_LENGTH);
  builder.setPaint(PALETTE.metalDark).box(0, 3.65, 0, 1.6, 0.25, COACH_LENGTH - 1.2);
  for (let window = 0; window < 8; window++) {
    const z = -half + 1.3 + window * ((COACH_LENGTH - 2.6) / 7);
    for (const side of [-1.39, 1.39]) builder.setPaint(HERITAGE.windowDark).box(side, 2.75, z, 0.04, 0.75, 0.95);
  }
  for (const bogie of [-half + 2.2, half - 2.2]) {
    builder.setPaint(PALETTE.metalDark).box(0, 0.75, bogie, 2.3, 0.35, 2.6);
    for (const side of [-1, 1]) for (const z of [-0.8, 0.8]) addWheel(builder, side, 0.48, bogie + z, 0.46, PALETTE.metalDark);
  }
}
