// Recipe 'fireball' (preset 60, the fireball impact): a bolide that crosses the sky and strikes the
// ground at the spawn's anchor. Three movers, posed by this recipe's animate hook on the event's own
// clock: the bolide (a white-hot head with a long orange tail, growing brighter as it comes down a
// straight line from `altitude` metres up at `angle` degrees, from a seeded bearing), the impact flash
// (a blinding sphere that swells and dies in two seconds) and the scar (a glowing, scorched ground
// decal draped on the terrain, its embers cooling over `cool` seconds through the instance glow). The
// ground's height never changes. The voice (the `fireball` recipe) rides on the head with a roar
// rising as it nears, then the sonic boom and the impact arrive after the time sound takes to reach
// the player (343 m/s), and the scar crackles as it cools. The preset's emitters (smoke and embers,
// with their light) start at the impact through their startDelay, which the preset sets to
// delay + fall.
import { paint } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';

export const FIREBALL_DEFAULTS = Object.freeze({
  delay: 4,
  fall: 7,
  altitude: [11000, 14000],
  angle: [24, 38],
  head: 38,
  scar: [34, 48],
  flash: 160,
  cool: 120,
});

const DEG = Math.PI / 180;
const SPEED_OF_SOUND = 343;
/** The flash swells over FLASH_RISE seconds and is gone FLASH_LIFE seconds after the impact. */
const FLASH_RISE = 0.18;
const FLASH_LIFE = 2.2;
/** The scar spreads to its full size over this many seconds after the impact. */
const SCAR_SPREAD = 0.6;
/** The embers never cool below this share of their glow within the event. */
const GLOW_FLOOR = 0.1;
/** The boom is dropped (not played late) when the player only comes back in range this long after it was due. */
const BOOM_GRACE = 2;
const SCAR_RINGS = 7;
const SCAR_SIDES = 28;
const HEAD = paint(0xfff6dc, 7);
const HALO = paint(0xffd27a, 4.5);
const TAIL = Object.freeze([paint(0xffb04a, 4), paint(0xff7a2a, 3), paint(0xe0461c, 2), paint(0x9c2a10, 1.2)]);
const FLASH = paint(0xfff2d4, 6);
const CHAR = paint(0x17120f);
const SCORCH = paint(0x3d2e22);
const ASH = paint(0x5e5346);
const EMBER = paint(0xff5a1a, 3.2);
const EMBER_DEEP = paint(0xc8360e, 2);

export function buildFireball(context, read) {
  const { rng, out } = context;
  const delay = read.number('delay', FIREBALL_DEFAULTS.delay, 0, 120);
  const fall = read.number('fall', FIREBALL_DEFAULTS.fall, 1, 60);
  const altitude = roll(read.range('altitude', FIREBALL_DEFAULTS.altitude, 1000, 40000), rng);
  const angle = roll(read.range('angle', FIREBALL_DEFAULTS.angle, 5, 80), rng) * DEG;
  const head = read.number('head', FIREBALL_DEFAULTS.head, 2, 400);
  const scarRadius = roll(read.range('scar', FIREBALL_DEFAULTS.scar, 5, 300), rng);
  const flashSize = read.number('flash', FIREBALL_DEFAULTS.flash, 10, 2000);
  const cool = read.number('cool', FIREBALL_DEFAULTS.cool, 5, 1200);
  const groundY = context.ground(0, 0);
  // Where it comes from: a seeded bearing, `altitude` up at `angle` above the horizon.
  const bearing = rng() * Math.PI * 2;
  const reach = altitude / Math.tan(angle);
  const startX = Math.sin(bearing) * reach;
  const startY = groundY + altitude;
  const startZ = -Math.cos(bearing) * reach;
  const length = Math.hypot(startX, altitude, startZ);
  // The direction of flight (toward the impact) as a pose: compass yaw and a nose-down pitch.
  const flightYaw = Math.atan2(-startX, startZ);
  const flightPitch = -angle;

  const bolide = context.addMover({ name: 'bolide', kind: 'glow' });
  buildBolide(bolide.builder, head);
  const flash = context.addMover({ name: 'flash', kind: 'glow' });
  flash.builder.setPaint(FLASH).lathe(0, -1, 0, [[0.35, 0], [0.85, 0.3], [1, 1], [0.85, 1.7], [0.35, 2]], 12, { closeBottom: true, closeTop: true });
  const scar = context.addMover({ name: 'scar', kind: 'decal' });
  buildScar(scar.builder, context, scarRadius, rng);

  out.animate = animateFireball;
  out.animateState = {
    /** [start x, y, z (local), impact y, flight yaw, flight pitch, path length]. */
    path: new Float64Array([startX, startY, startZ, groundY, flightYaw, flightPitch, length]),
    /**
     * [event start (s), delay, fall, flash size, cool (s), mover bolide, flash, scar, impacted (0/1),
     * boom due (s, event time), boom played (0/1)].
     */
    timeline: new Float64Array([Number.isFinite(context.params.startTime) ? context.params.startTime : -1, delay, fall, flashSize, cool, bolide.index, flash.index, scar.index, 0, 0, 0]),
  };
  out.audioPoint = [0, groundY + 5, 0];
  out.windProbe = [0, groundY + 20, 0];
  out.radius = Math.max(out.radius, scarRadius * 1.5);
}

/**
 * The fireball's animate hook (one function for every fireball; its instance's numbers in
 * state.custom): before `delay` nothing; then the bolide down its line over `fall` seconds, the voice
 * on its head and rising; at the impact the flash, the scar and the boom scheduled for when the sound
 * reaches the player; then the embers cooling through the glow. Allocation-free.
 */
function animateFireball(state, env) {
  const custom = state.custom;
  const path = custom.path;
  const timeline = custom.timeline;
  const clock = env.clock;
  if (timeline[0] < 0) timeline[0] = clock[0];
  const time = clock[0] - timeline[0];
  const delay = timeline[1];
  const fall = timeline[2];
  const impactAt = delay + fall;
  const poses = state.poses;
  const bolide = timeline[5] * 8;
  const flash = timeline[6] * 8;
  const scar = timeline[7] * 8;
  if (time < delay) {
    poses[bolide + 7] = 0;
    poses[flash + 7] = 0;
    poses[scar + 7] = 0;
    state.level[0] = 0;
    state.glow[0] = 1;
    return;
  }
  if (time < impactAt) {
    const share = (time - delay) / fall;
    poses[bolide] = path[0] * (1 - share);
    poses[bolide + 1] = path[1] + (path[3] - path[1]) * share;
    poses[bolide + 2] = path[2] * (1 - share);
    poses[bolide + 3] = path[4];
    poses[bolide + 4] = path[5];
    poses[bolide + 6] = 0.6 + 0.6 * share;
    poses[bolide + 7] = 1;
    poses[flash + 7] = 0;
    poses[scar + 7] = 0;
    state.voice[0] = poses[bolide];
    state.voice[1] = poses[bolide + 1];
    state.voice[2] = poses[bolide + 2];
    state.voice[3] = 1;
    state.level[0] = 0.15 + 0.85 * share;
    state.glow[0] = 1;
    return;
  }
  // The impact and after.
  if (timeline[8] === 0) impact(timeline, env, impactAt);
  const since = time - impactAt;
  poses[bolide + 7] = 0;
  const flashScale = since < FLASH_RISE ? timeline[3] * (since / FLASH_RISE) : since < FLASH_LIFE ? timeline[3] * (1 - (since - FLASH_RISE) / (FLASH_LIFE - FLASH_RISE)) : 0;
  poses[flash] = 0;
  poses[flash + 1] = path[3];
  poses[flash + 2] = 0;
  poses[flash + 6] = flashScale > 0.01 ? flashScale : 0;
  poses[flash + 7] = flashScale > 0.01 ? 1 : 0;
  poses[scar] = 0;
  poses[scar + 1] = 0;
  poses[scar + 2] = 0;
  poses[scar + 6] = since < SCAR_SPREAD ? 0.55 + 0.45 * (since / SCAR_SPREAD) : 1;
  poses[scar + 7] = 1;
  const glow = GLOW_FLOOR + (1 - GLOW_FLOOR) * Math.exp(-since * 3 / timeline[4]);
  state.glow[0] = glow;
  state.voice[0] = 0;
  state.voice[1] = path[3] + 5;
  state.voice[2] = 0;
  state.voice[3] = 1;
  state.level[0] = 0.2 + 0.7 * glow;
  if (timeline[10] === 0 && time >= timeline[9]) boom(timeline, env, time);
}

/** Event work, once: the impact; the boom is due when its sound reaches the player. */
function impact(timeline, env, impactAt) {
  timeline[8] = 1;
  const dx = env.player.x - env.anchor.x;
  const dy = env.player.y - env.anchor.y;
  const dz = env.player.z - env.anchor.z;
  timeline[9] = impactAt + Math.sqrt(dx * dx + dy * dy + dz * dz) / SPEED_OF_SOUND;
}

/** Event work, once: the sonic boom and the impact thud (dropped if it is long overdue). */
function boom(timeline, env, time) {
  timeline[10] = 1;
  if (time - timeline[9] > BOOM_GRACE) return;
  env.trigger('boom', { strength: 1 });
}

/**
 * The bolide in its own frame (the head at the origin, flying toward -z): a white-hot head inside an
 * orange halo, and a tail of tapering cones streaming back along +z, cooling from orange to deep red.
 */
function buildBolide(builder, head) {
  builder.setPaint(HEAD).lathe(0, -head * 0.6, 0, [[head * 0.3, 0], [head * 0.6, head * 0.3], [head * 0.6, head * 0.9], [head * 0.3, head * 1.2]], 10, { closeBottom: true, closeTop: true });
  builder.setPaint(HALO).lathe(0, -head * 0.95, 0, [[head * 0.5, 0], [head * 0.95, head * 0.5], [head * 0.95, head * 1.4], [head * 0.5, head * 1.9]], 10, { closeBottom: true, closeTop: true });
  // The tail: lathes along +y turned to +z (a tilt of +90 degrees about local x).
  builder.setTransform(0, 0, 0, 0, Math.PI / 2, 0);
  let from = head * 0.6;
  let radius = head * 0.85;
  TAIL.forEach((colour, index) => {
    const span = head * (5 + index * 5);
    builder.setPaint(colour).setSway(index / TAIL.length).lathe(0, from, 0, [[radius, 0], [radius * 0.6, span]], 8, { closeBottom: index === 0 });
    from += span;
    radius *= 0.6;
  });
  builder.setSway(0);
  builder.resetTransform();
}

/**
 * The scar in the instance's local frame, draped on the ground under the anchor: a charred crater
 * floor (glowing embers in a broken ring and in scattered spots), a scorched skirt and ejecta rays of
 * ash fading out. Vertex alpha is the emissive gain the decal material reads (the embers glow).
 */
function buildScar(builder, context, radius, random) {
  const lift = 0.18;
  const ground = (x, z) => context.ground(x, z) + lift;
  const point = (ring, side) => {
    const angle = (side / SCAR_SIDES) * Math.PI * 2;
    const ragged = ring === SCAR_RINGS ? 0.75 + 0.5 * Math.abs(Math.sin(side * 2.3 + 0.7)) : 1;
    const distance = radius * (ring / SCAR_RINGS) * ragged;
    const x = Math.sin(angle) * distance;
    const z = -Math.cos(angle) * distance;
    return [x, ground(x, z), z];
  };
  for (let ring = 0; ring < SCAR_RINGS; ring++) {
    for (let side = 0; side < SCAR_SIDES; side++) {
      const share = ring / SCAR_RINGS;
      let colour;
      if (share < 0.15) colour = random() < 0.5 ? EMBER : EMBER_DEEP;
      else if (share < 0.45) colour = random() < 0.32 ? EMBER : random() < 0.4 ? EMBER_DEEP : CHAR;
      else if (share < 0.7) colour = random() < 0.08 ? EMBER_DEEP : CHAR;
      else colour = random() < 0.5 ? SCORCH : ASH;
      builder.setPaint(colour);
      const a = point(ring, side);
      const b = point(ring + 1, side);
      const c = point(ring + 1, side + 1);
      const d = point(ring, side + 1);
      if (ring === 0) builder.triangle(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      else builder.quad(a, d, c, b);
    }
  }
  // Ejecta rays: thin wedges of ash running out from the rim.
  const rays = 9 + Math.floor(random() * 5);
  for (let ray = 0; ray < rays; ray++) {
    const angle = random() * Math.PI * 2;
    const length = radius * (1.4 + random() * 1.4);
    const width = radius * 0.08;
    const dirX = Math.sin(angle);
    const dirZ = -Math.cos(angle);
    const rootX = dirX * radius * 0.85;
    const rootZ = dirZ * radius * 0.85;
    const tipX = dirX * length;
    const tipZ = dirZ * length;
    builder.setPaint(ray % 3 === 0 ? SCORCH : ASH);
    builder.triangle(rootX - dirZ * width, ground(rootX - dirZ * width, rootZ + dirX * width), rootZ + dirX * width,
      tipX, ground(tipX, tipZ), tipZ,
      rootX + dirZ * width, ground(rootX + dirZ * width, rootZ - dirX * width), rootZ - dirX * width);
  }
}
