// Recipe 'hoodoos': a field of badland hoodoos (preset 87). Each hoodoo is a tall pillar of soft
// banded rock lathed in drums: a flared foot, a waist that bulges and necks in again toward the top,
// every drum painted in its own stratum of the badland clays (the bands run level across the whole
// field, as real strata do), and a darker, harder capstone balanced on the neck. The pillars gather
// in a few seeded clusters with lanes between them, so the field reads as a slalom from the air, and
// fallen blocks lie among them. The whole field is one merged body geometry (one draw call however
// many pillars).
//
// Colliders: every shaft is a capsule as wide as its widest drum (jitter included) from below the
// ground to the neck, every capstone a cylinder whose top is a perch; fallen blocks are spheres.
import { addBoulder } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localCapsule, localCylinder, localSphere } from '../colliders.js';

export const HOODOOS_DEFAULTS = Object.freeze({
  count: [44, 64],
  spread: 380,
  height: [12, 36],
  radius: [2.2, 4.2],
  clusters: [3, 5],
  capChance: 0.85,
  boulders: [10, 18],
  colors: Object.freeze([0xb8683f, 0xcf8a5a, 0xe4c49a, 0xa4543a, 0xd99b6a, 0xc77a4c]),
  capColor: 0x5b4636,
});

const SIDES = 7;
/** The lathe's jitter reaches this share past a ring's radius (radiusAt below); the shaft collider covers it. */
const RADIUS_JITTER = 0.12;
/** The level strata of the field (m): every drum takes the band of its middle height above the field's lowest foot. */
const STRATUM = 2.6;

/** The shaft profile at height share t (0 foot .. 1 neck), as a share of the base radius. */
function shaftProfile(t, waist) {
  const flare = 1.28 - 0.28 * Math.min(1, t / 0.18);
  const bulge = 1 + waist * Math.sin(Math.PI * Math.min(1, t / 0.8));
  const neck = 1 - 0.38 * Math.max(0, (t - 0.72) / 0.28);
  return flare * bulge * neck;
}

export function buildHoodoos(context, read) {
  const { rng, body, out } = context;
  const count = rollInteger(read.range('count', HOODOOS_DEFAULTS.count, 1, 160), rng);
  const spread = read.number('spread', HOODOOS_DEFAULTS.spread, 20, 3000);
  const heightRange = read.range('height', HOODOOS_DEFAULTS.height, 3, 120);
  const radiusRange = read.range('radius', HOODOOS_DEFAULTS.radius, 0.5, 20);
  const clusterCount = rollInteger(read.range('clusters', HOODOOS_DEFAULTS.clusters, 1, 12), rng);
  const capChance = read.number('capChance', HOODOOS_DEFAULTS.capChance, 0, 1);
  const boulderCount = rollInteger(read.range('boulders', HOODOOS_DEFAULTS.boulders, 0, 120), rng);
  const colors = read.array('colors', HOODOOS_DEFAULTS.colors);
  if (colors.length === 0 || !colors.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff)) read.fail('colors', 'must be a non-empty array of 0xRRGGBB colours');
  const bands = colors.map((hex) => paint(hex));
  const capPaint = paint(read.color('capColor', HOODOOS_DEFAULTS.capColor));

  // Cluster centres inside the field, then pillars around them, kept apart (rejection sampling).
  const centres = [];
  for (let index = 0; index < clusterCount; index++) {
    const angle = rng() * Math.PI * 2;
    const distance = spread * 0.7 * Math.sqrt(rng());
    centres.push({ x: Math.sin(angle) * distance, z: -Math.cos(angle) * distance, reach: spread * (0.18 + 0.14 * rng()) });
  }
  const pillars = [];
  for (let index = 0; index < count; index++) {
    const radius = roll(radiusRange, rng);
    for (let attempt = 0; attempt < 24; attempt++) {
      const centre = centres[Math.floor(rng() * centres.length)];
      const angle = rng() * Math.PI * 2;
      const distance = centre.reach * Math.sqrt(rng());
      const x = centre.x + Math.sin(angle) * distance;
      const z = centre.z - Math.cos(angle) * distance;
      if (Math.hypot(x, z) > spread) continue;
      if (pillars.some((other) => Math.hypot(other.x - x, other.z - z) < (other.radius + radius) * 1.9 + 5)) continue;
      pillars.push({ x, z, radius });
      break;
    }
  }
  if (pillars.length === 0) pillars.push({ x: 0, z: 0, radius: radiusRange[0] });

  // Each foot sits on the lowest ground under it; the strata are counted from the lowest foot.
  for (const pillar of pillars) {
    let lowest = Infinity;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) lowest = Math.min(lowest, context.ground(pillar.x + dx * pillar.radius, pillar.z + dz * pillar.radius));
    pillar.foot = lowest;
  }
  const floor = Math.min(...pillars.map((pillar) => pillar.foot));
  const bandAt = (y) => bands[((Math.floor((y - floor) / STRATUM) % bands.length) + bands.length) % bands.length];

  let tallest = 0;
  for (const pillar of pillars) {
    const height = roll(heightRange, rng);
    const waist = 0.05 + 0.12 * rng();
    const drums = Math.max(3, Math.round(height / 5));
    const base = pillar.foot - 1.2;
    const neckY = pillar.foot + height;
    const phase = rng() * Math.PI * 2;
    // One lathe per drum, each painted by its stratum (slightly shaded per pillar).
    const tone = 0.9 + 0.18 * rng();
    let widest = 0;
    for (let drum = 0; drum < drums; drum++) {
      const t0 = drum / drums;
      const t1 = (drum + 1) / drums;
      const y0 = drum === 0 ? base : pillar.foot + height * t0;
      const y1 = pillar.foot + height * t1;
      const r0 = pillar.radius * shaftProfile(t0, waist);
      const r1 = pillar.radius * shaftProfile(t1, waist);
      widest = Math.max(widest, r0, r1);
      body.setPaint(shade(bandAt((y0 + y1) * 0.5), tone)).lathe(pillar.x, y0, pillar.z, [[r0, 0], [r1, y1 - y0]], SIDES, {
        phase,
        closeBottom: drum === 0,
        radiusAt: (ring, side, value) => value * (1 - RADIUS_JITTER * 0.5 + RADIUS_JITTER * (((drum * 3 + ring * 5 + side * 7) % 11) / 10)),
      });
    }
    const neckRadius = pillar.radius * shaftProfile(1, waist);
    const shaftRadius = widest * (1 + RADIUS_JITTER * 0.5);
    // The shaft collider ends a radius under the neck, so its round end reaches the neck.
    out.colliders.push(localCapsule('shaft', pillar.x, base, pillar.z, pillar.x, Math.max(base, neckY - shaftRadius), pillar.z, shaftRadius, { surface: 'stone' }));
    let top = neckY;
    if (rng() < capChance) {
      const capRadius = neckRadius * (1.7 + 0.7 * rng());
      const capHeight = capRadius * (0.45 + 0.2 * rng());
      body.setPaint(capPaint).lathe(pillar.x, neckY - 0.2, pillar.z, [[capRadius * 0.8, 0], [capRadius, capHeight * 0.35], [capRadius * 0.9, capHeight * 0.8], [capRadius * 0.4, capHeight]], SIDES, {
        phase: phase + 0.4,
        closeBottom: true,
        closeTop: true,
      });
      top = neckY - 0.2 + capHeight;
      out.colliders.push(localCylinder('cap', pillar.x, neckY - 0.2, pillar.z, capRadius * 1.04, capHeight, { surface: 'stone', perch: { x: pillar.x, y: top + 0.3, z: pillar.z } }));
    } else {
      // An uncapped pillar wears to a rounded point; its tip is the perch.
      body.setPaint(shade(bandAt(neckY), tone)).lathe(pillar.x, neckY, pillar.z, [[neckRadius, 0], [neckRadius * 0.55, neckRadius * 0.9], [0, neckRadius * 1.5]], SIDES, { phase });
      top = neckY + neckRadius * 1.5;
      out.colliders.push(localSphere('tip', pillar.x, neckY + neckRadius * 0.4, pillar.z, neckRadius * 1.1, { surface: 'stone', perch: { x: pillar.x, y: top + 0.3, z: pillar.z } }));
    }
    tallest = Math.max(tallest, top - pillar.foot);
  }

  // Fallen blocks among the pillars.
  for (let index = 0; index < boulderCount; index++) {
    const angle = rng() * Math.PI * 2;
    const distance = spread * Math.sqrt(rng());
    const x = Math.sin(angle) * distance;
    const z = -Math.cos(angle) * distance;
    if (pillars.some((pillar) => Math.hypot(pillar.x - x, pillar.z - z) < pillar.radius * 2.2)) continue;
    const radius = 0.8 + 2.4 * rng() ** 1.6;
    const ground = context.ground(x, z);
    addBoulder(body, x, ground, z, radius, rng, rng() < 0.5 ? capPaint : shade(bandAt(ground), 0.95));
    out.colliders.push(localSphere('boulder', x, ground + radius * 0.3, z, radius * 1.02, { surface: 'stone' }));
  }

  const centreGround = context.ground(0, 0);
  out.audioPoint = [0, centreGround + tallest * 0.5, 0];
  out.windProbe = [0, centreGround + 20, 0];
  out.radius = Math.max(out.radius, spread + 20);
}
