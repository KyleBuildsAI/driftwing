// Recipe 'spires': a cluster of glowing crystal spires. Each spire is a tapered hexagonal prism with a
// pointed tip, leaning outward from the cluster, its glow rising toward the tip (vertex emissive
// gain) and pulsing slowly in its own phase (the crystal material reads the phase from the sway
// attribute). Shards sprout around the bases among boulders. Every pair of neighbouring spires is a
// fly-through gate: passing between them rings the crystal voice's chimes. The hum's pitch rises as
// the player approaches (the engine drives the voice's intensity with the approach). The crystals go
// to the glow geometry (the crystal material); the boulders to the solid body.
import { paint } from '../palette.js';
import { addBoulder } from '../common.js';
import { shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { builderFrame, localHull, localSphere, ringPoints } from '../colliders.js';

export const SPIRES_DEFAULTS = Object.freeze({
  count: [5, 9],
  height: [45, 110],
  radius: [4, 8],
  spread: 90,
  tilt: 12,
  colors: Object.freeze([0x8fe3ff, 0xb89cff, 0x9ff0d0]),
  shards: [8, 14],
  chimes: true,
  maxGap: 75,
  approach: 1500,
});

export function buildSpires(context, read) {
  const { rng, body, glow, out } = context;
  const count = rollInteger(read.range('count', SPIRES_DEFAULTS.count, 1, 24), rng);
  const heightRange = read.range('height', SPIRES_DEFAULTS.height, 5, 400);
  const radiusRange = read.range('radius', SPIRES_DEFAULTS.radius, 0.5, 40);
  const spread = read.number('spread', SPIRES_DEFAULTS.spread, 5, 1000);
  const tiltDegrees = read.number('tilt', SPIRES_DEFAULTS.tilt, 0, 45);
  const colors = read.array('colors', SPIRES_DEFAULTS.colors);
  if (colors.length === 0 || !colors.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff)) read.fail('colors', 'must be a non-empty array of 0xRRGGBB colours');
  const shardRange = read.range('shards', SPIRES_DEFAULTS.shards, 0, 80);
  const chimes = read.boolean('chimes', SPIRES_DEFAULTS.chimes);
  const maxGap = read.number('maxGap', SPIRES_DEFAULTS.maxGap, 5, 500);
  out.approach = read.number('approach', SPIRES_DEFAULTS.approach, 50, 20000);

  const spires = [];
  for (let index = 0; index < count; index++) {
    const radius = roll(radiusRange, rng);
    const height = index === 0 ? heightRange[1] * (0.9 + rng() * 0.1) : roll(heightRange, rng);
    let x = 0;
    let z = 0;
    if (index > 0) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const angle = rng() * Math.PI * 2;
        const distance = spread * (0.25 + 0.75 * Math.sqrt(rng()));
        x = Math.sin(angle) * distance;
        z = -Math.cos(angle) * distance;
        if (spires.every((other) => Math.hypot(other.x - x, other.z - z) > (other.radius + radius) * 3.2)) break;
      }
    }
    spires.push({ x, z, radius, height, ground: context.ground(x, z), colour: colors[index % colors.length] });
  }

  let heightSum = 0;
  for (const spire of spires) {
    const outwardYaw = spire.x === 0 && spire.z === 0 ? rng() * Math.PI * 2 : Math.atan2(spire.x, -spire.z);
    const tilt = (spire === spires[0] ? 0.3 : 1) * tiltDegrees * (0.4 + 0.6 * rng()) * (Math.PI / 180);
    const phase = rng();
    addCrystal(glow, spire.x, spire.ground, spire.z, outwardYaw, tilt, spire.radius, spire.height, paint(spire.colour), phase);
    out.colliders.push(crystalCollider(spire.x, spire.ground, spire.z, outwardYaw, tilt, spire.radius, spire.height, true));
    heightSum += spire.height;
    // Shards and boulders around the base (resting on the ground).
    const shards = rollInteger(shardRange, rng) / spires.length;
    for (let shard = 0; shard < Math.max(1, Math.round(shards)); shard++) {
      const angle = rng() * Math.PI * 2;
      const reach = spire.radius * (1.4 + rng() * 2.2);
      const sx = spire.x + Math.sin(angle) * reach;
      const sz = spire.z - Math.cos(angle) * reach;
      const size = spire.radius * (0.2 + rng() * 0.25);
      const shardTilt = (15 + rng() * 30) * (Math.PI / 180);
      const shardHeight = size * (3 + rng() * 4);
      const shardGround = context.ground(sx, sz);
      addCrystal(glow, sx, shardGround, sz, angle, shardTilt, size, shardHeight, paint(colors[Math.floor(rng() * colors.length)]), rng());
      out.colliders.push(crystalCollider(sx, shardGround, sz, angle, shardTilt, size, shardHeight, false));
    }
    for (let boulder = 0; boulder < 2; boulder++) {
      const angle = rng() * Math.PI * 2;
      const reach = spire.radius * (1.2 + rng());
      const bx = spire.x + Math.sin(angle) * reach;
      const bz = spire.z - Math.cos(angle) * reach;
      const boulderGround = context.ground(bx, bz);
      const boulderRadius = spire.radius * (0.35 + rng() * 0.3);
      addBoulder(body, bx, boulderGround, bz, boulderRadius, rng);
      out.colliders.push(localSphere('boulder', bx, boulderGround + boulderRadius * 0.3, bz, boulderRadius * 1.05, { surface: 'stone' }));
    }
  }
  glow.resetTransform();

  // Chime gates between neighbouring spires.
  if (chimes) {
    for (let first = 0; first < spires.length; first++) {
      for (let second = first + 1; second < spires.length; second++) {
        const a = spires[first];
        const b = spires[second];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const gap = Math.hypot(dx, dz);
        if (gap > maxGap) continue;
        const halfWidth = gap * 0.5 - (a.radius + b.radius) * 0.6 - 1;
        if (halfWidth < 2) continue;
        const floor = Math.min(a.ground, b.ground);
        context.addGate({
          id: `chime:${first}:${second}`,
          kind: 'through',
          x: (a.x + b.x) * 0.5,
          z: (a.z + b.z) * 0.5,
          normalX: -dz / gap,
          normalZ: dx / gap,
          halfWidth,
          minY: floor - 2,
          maxY: floor + Math.min(a.height, b.height) * 0.85,
          action: 'chime',
          achievement: null,
        });
      }
    }
  }
  const centreGround = spires[0].ground;
  out.audioPoint = [0, centreGround + (heightSum / spires.length) * 0.5, 0];
  out.radius = Math.max(out.radius, spread + heightRange[1] * 0.4);
}

/**
 * A crystal's collider: the hull of its widest base ring (below the ground), its upper ring and its tip,
 * in addCrystal's frame. The rings narrow upward, so the hull holds every band. A spire's tip is a perch.
 */
function crystalCollider(x, y, z, yaw, tilt, radius, height, spire) {
  const place = builderFrame(x, y, z, yaw, -tilt, 0);
  const points = [...ringPoints(0, -6, 0, radius * 1.05, 6, 0.35), ...ringPoints(0, height * 0.8, 0, radius * 0.85, 6, 0.35), [0, height, 0]].map(place);
  const tip = points[points.length - 1];
  return localHull(spire ? 'spire' : 'shard', points, { surface: 'ice', perch: spire ? { x: tip[0], y: tip[1], z: tip[2] } : false });
}

/**
 * One crystal: a tapered hexagonal prism with a pyramid tip, built along its own axis at (x, y, z),
 * leaning `tilt` radians toward compass `yaw`. The emissive gain rises toward the tip; the sway
 * attribute carries its pulse phase (0..1) for the crystal material.
 */
function addCrystal(builder, x, y, z, yaw, tilt, radius, height, colour, phase) {
  // A compass yaw with local -z forward: leaning outward is a negative tilt about local x.
  builder.setTransform(x, y, z, yaw, -tilt, 0);
  builder.setSway(phase);
  const bands = [
    [[radius * 1.05, -6], [radius, 0], shade(colour, 0.45), 0.2],
    [[radius, 0], [radius * 0.92, height * 0.45], shade(colour, 0.62), 0.45],
    [[radius * 0.92, height * 0.45], [radius * 0.85, height * 0.8], shade(colour, 0.8), 0.85],
    [[radius * 0.85, height * 0.8], [0, height], colour, 1.4],
  ];
  for (const [lower, upper, bandPaint, glow] of bands) {
    builder.setPaint([bandPaint[0], bandPaint[1], bandPaint[2], glow]).lathe(0, 0, 0, [lower, upper], 6, { phase: 0.35, closeBottom: lower[1] < -5 });
  }
  builder.setSway(0);
  builder.resetTransform();
}
