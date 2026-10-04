// Helpers every structure recipe shares: the site frame, stamp lookup, and small props (trees,
// boulders, cairns, pennants) built in the v1 low-poly style.
import { PALETTE } from './palette.js';

const DEG = Math.PI / 180;

/** Unit forward (compass heading, degrees) and right vectors in the XZ plane. */
export function frameFromHeading(headingDegrees) {
  const angle = headingDegrees * DEG;
  const forwardX = Math.sin(angle);
  const forwardZ = -Math.cos(angle);
  return { forwardX, forwardZ, rightX: -forwardZ, rightZ: forwardX, angle };
}

/** Compass heading (degrees, 0..360) of the XZ direction (x, z). */
export function headingOf(x, z) {
  const heading = Math.atan2(x, -z) / DEG;
  return heading < 0 ? heading + 360 : heading;
}

/** The index-th stamp of a type on the site (0 = first), or null. */
export function findStamp(site, type, index = 0) {
  if (!site || !Array.isArray(site.stamps)) return null;
  let seen = 0;
  for (const stamp of site.stamps) {
    if (stamp.type !== type) continue;
    if (seen === index) return stamp;
    seen++;
  }
  return null;
}

/** Every stamp of a type on the site. */
export function stampsOfType(site, type) {
  if (!site || !Array.isArray(site.stamps)) return [];
  return site.stamps.filter((stamp) => stamp.type === type);
}

/** Picks an element of a list with the seeded random generator. */
export function pick(list, random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/**
 * A conifer at local (x, y, z): a trunk and two or three stacked cones, height metres tall. Sways a
 * little at the top (weight 0.25) with the structure's sway.
 */
export function addPine(builder, x, y, z, height, random) {
  const trunkHeight = height * 0.22;
  builder.setSway(0).setPaint(PALETTE.trunk).prism(x, y - 0.5, z, 5, height * 0.045, height * 0.035, trunkHeight + 0.5, random() * 6);
  const tiers = height > 9 ? 3 : 2;
  const leaf = pick(PALETTE.pine, random);
  builder.setPaint(leaf);
  for (let tier = 0; tier < tiers; tier++) {
    const share = tier / tiers;
    const base = y + trunkHeight + share * (height - trunkHeight) * 0.78;
    const radius = height * (0.3 - share * 0.09);
    const coneHeight = (height - trunkHeight) * (0.62 - share * 0.1);
    builder.setSway(0.08 + share * 0.2).lathe(x, base, z, [[radius, 0], [0, coneHeight]], 7, { closeBottom: true, phase: random() * 6 });
  }
  builder.setSway(0);
}

/** A round broadleaf tree: a trunk and a faceted crown. */
export function addRoundTree(builder, x, y, z, height, random) {
  const trunkHeight = height * 0.4;
  builder.setSway(0).setPaint(PALETTE.trunk).prism(x, y - 0.5, z, 5, height * 0.05, height * 0.035, trunkHeight + 0.6, random() * 6);
  const crown = height * 0.34;
  builder.setPaint(pick(PALETTE.leaf, random)).setSway(0.18).lathe(x, y + trunkHeight - crown * 0.2, z, [
    [crown * 0.55, 0], [crown * 1.05, crown * 0.55], [crown * 0.95, crown * 1.25], [crown * 0.45, crown * 1.8], [0, crown * 2],
  ], 7, { closeBottom: true, phase: random() * 6, radiusAt: (ring, side, radius) => radius * (0.9 + 0.2 * ((ring * 7 + side * 3) % 5) / 4) });
  builder.setSway(0);
}

/** A faceted boulder (five or six sides), radius r, sitting at y. */
export function addBoulder(builder, x, y, z, radius, random, paintValue = pick(PALETTE.rock, random)) {
  const sides = random() < 0.5 ? 5 : 6;
  builder.setPaint(paintValue).lathe(x, y - radius * 0.3, z, [
    [radius * 0.7, 0], [radius, radius * 0.45], [radius * 0.75, radius * 1.0], [radius * 0.25, radius * 1.25],
  ], sides, { closeBottom: true, closeTop: true, phase: random() * 6, radiusAt: (ring, side, value) => value * (0.82 + 0.36 * random()) });
}

/** A stacked-stone cairn with a pennant pole, as course and gate markers. */
export function addCairn(builder, x, y, z, height, random, flag = PALETTE.flagRed) {
  let level = y - 0.3;
  const stones = Math.max(3, Math.round(height / 0.7));
  for (let stone = 0; stone < stones; stone++) {
    const radius = (1 - stone / (stones + 1)) * height * 0.32 + 0.25;
    const thickness = height / stones;
    builder.setPaint(pick(PALETTE.stone, random)).lathe(x + (random() - 0.5) * 0.3, level, z + (random() - 0.5) * 0.3, [[radius, 0], [radius * 1.08, thickness * 0.5], [radius * 0.8, thickness]], 6, { closeBottom: true, closeTop: true, phase: random() * 6 });
    level += thickness * 0.92;
  }
  const poleTop = level + height * 1.4;
  builder.setPaint(PALETTE.timberDark).beam(x, level - 0.2, z, x, poleTop, z, 0.14, 0.14);
  // A pennant that swings with the sway (weight grows toward its tip).
  builder.setPaint(flag);
  builder.triangle(x, poleTop, z, x, poleTop - height * 0.45, z, x + height * 0.7, poleTop - height * 0.2, z, 0, 0, 0.6);
  builder.triangle(x, poleTop, z, x + height * 0.7, poleTop - height * 0.2, z, x, poleTop - height * 0.45, z, 0, 0.6, 0);
}
