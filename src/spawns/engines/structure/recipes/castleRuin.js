// Recipe 'castleRuin' (preset 54, the sea-cliff castle ruin): a ruined stone castle on the lip of a sea
// cliff (the cliffStep stamp, the drop toward the sea). A ring of curtain walls with battlements,
// broken through in places, joins round towers at its corners, some fallen to stumps; a gatehouse with
// an arched passage faces inland; a roofless hall stands in the bailey. On the cliff edge rises the
// keep, a tall round tower with a crenellated top and banners, the tower to fly around. Every wall,
// tower and pier is solid; the keep's top is a landable perch. Braziers on the gatehouse, the keep and
// in the bailey are torches only a dragon's breath lights.
// Without a cliffStep stamp (a debug spawn) the recipe raises its own basalt cliff `drop` metres high.
import { addBoulder, pick } from '../common.js';
import { shade } from '../meshBuilder.js';
import { roll, rollInteger } from '../../engineKit.js';
import { localBox, localCylinder } from '../colliders.js';
import { HERITAGE, addArchRing, addBanner, addBattlements, addTorchPost, cliffSiteFrame } from '../heritage.js';

export const CASTLE_RUIN_DEFAULTS = Object.freeze({
  stamp: 0,
  towers: [5, 7],
  radius: [30, 40],
  wallHeight: [9, 12],
  keepHeight: [34, 42],
  ruin: 0.35,
  banners: true,
  drop: 60,
  width: 300,
});

const WALL_THICKNESS = 2.6;

export function buildCastleRuin(context, read) {
  const { rng, body, detail, cloth, out } = context;
  const towerCount = rollInteger(read.range('towers', CASTLE_RUIN_DEFAULTS.towers, 4, 9), rng);
  const radius = roll(read.range('radius', CASTLE_RUIN_DEFAULTS.radius, 15, 80), rng);
  const wallHeight = roll(read.range('wallHeight', CASTLE_RUIN_DEFAULTS.wallHeight, 4, 20), rng);
  const keepHeight = roll(read.range('keepHeight', CASTLE_RUIN_DEFAULTS.keepHeight, 15, 80), rng);
  const ruin = read.number('ruin', CASTLE_RUIN_DEFAULTS.ruin, 0, 0.9);
  const withBanners = read.boolean('banners', CASTLE_RUIN_DEFAULTS.banners);
  const site = cliffSiteFrame(context, read.number('stamp', 0, 0, 16), read.number('drop', CASTLE_RUIN_DEFAULTS.drop, 20, 300), read.number('width', CASTLE_RUIN_DEFAULTS.width, 80, 800));
  const { frame, heightAt } = site;
  const stones = HERITAGE.ruinStone;
  const point = (along, across) => [frame.x(along, across), frame.z(along, across)];
  const torch = (x, y, z, size) => out.torches.push({ x, y, z, size, autoLight: false });

  // The bailey's ring: towers on a jittered polygon set back from the lip; the first corner (on the
  // cliff side, along 0) is the keep's place.
  const centreAlong = -(radius + 6);
  const corners = [];
  for (let index = 0; index < towerCount; index++) {
    const angle = (index / towerCount) * Math.PI * 2;
    const reach = radius * (0.85 + rng() * 0.3);
    const along = centreAlong + Math.cos(angle) * reach;
    const across = Math.sin(angle) * reach * 1.15;
    const [x, z] = point(along, across);
    corners.push({ along, across, x, z, ground: heightAt(along, across) });
  }
  // The keep stands well back from the lip (which wanders a few metres), so its foot is on rock.
  const keepRadius = roll([6, 7.2], rng);
  {
    const along = -(keepRadius + 9);
    const [x, z] = point(along, corners[0].across);
    corners[0] = { along, across: corners[0].across, x, z, ground: heightAt(along, corners[0].across) };
  }
  const gateEdge = Math.round(towerCount / 2);

  // ---- Curtain walls: seeded breaches, ragged tops beside them, battlements on the sound stretches ----
  for (let index = 0; index < towerCount; index++) {
    const from = corners[index];
    const to = corners[(index + 1) % towerCount];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(dz, dx);
    const isGate = index === gateEdge;
    const breach = !isGate && index !== 0 && rng() < ruin;
    // Pieces of the wall as [start share, end share, top]: a gate leaves a 6 m passage, a breach a gap.
    const pieces = [];
    if (isGate) {
      const half = Math.min(0.4, 3.2 / length);
      pieces.push([0.06, 0.5 - half, wallHeight], [0.5 + half, 0.94, wallHeight]);
    } else if (breach) {
      const middle = 0.3 + rng() * 0.4;
      const gap = Math.min(0.35, (5 + rng() * 9) / length);
      pieces.push([0.06, middle - gap / 2, wallHeight * (0.55 + rng() * 0.3)], [middle + gap / 2, 0.94, wallHeight * (0.5 + rng() * 0.35)]);
    } else {
      pieces.push([0.06, 0.94, wallHeight * (rng() < ruin * 0.5 ? 0.75 : 1)]);
    }
    for (const [start, end, top] of pieces) {
      if (end - start < 0.03) continue;
      const share = (start + end) / 2;
      const x = from.x + dx * share;
      const z = from.z + dz * share;
      const ground = Math.min(heightAt(from.along + (to.along - from.along) * start, from.across + (to.across - from.across) * start), heightAt(from.along + (to.along - from.along) * end, from.across + (to.across - from.across) * end));
      const span = (end - start) * length;
      const base = ground - 1.5;
      body.setPaint(pick(stones, rng)).box(x, base + (top + 1.5) / 2, z, span, top + 1.5, WALL_THICKNESS, yaw);
      out.colliders.push(localBox('wall', x, base + (top + 1.5) / 2, z, span, top + 1.5, WALL_THICKNESS, yaw, { surface: 'stone' }));
      const ax = from.x + dx * start;
      const az = from.z + dz * start;
      const bx = from.x + dx * end;
      const bz = from.z + dz * end;
      if (top >= wallHeight * 0.99) {
        addBattlements(body, ax, az, bx, bz, ground + top, { thickness: WALL_THICKNESS * 0.45, wallPaint: shade(pick(stones, rng), 0.95), skip: () => rng() < ruin * 0.3 });
      } else {
        // A ragged top: stones of uneven height along the broken stretch.
        const blocks = Math.max(2, Math.floor(span / 2.2));
        for (let block = 0; block < blocks; block++) {
          const along = (block + 0.5) / blocks;
          const height = rng() * 2.4;
          body.setPaint(pick(stones, rng)).box(ax + (bx - ax) * along, ground + top + height / 2, az + (bz - az) * along, span / blocks * 0.9, height, WALL_THICKNESS * 0.9, yaw);
        }
      }
    }
    if (breach) {
      // The fallen stone in the breach.
      for (let stone = 0; stone < 6; stone++) {
        const share = 0.35 + rng() * 0.3;
        const x = from.x + dx * share + (rng() - 0.5) * 6;
        const z = from.z + dz * share + (rng() - 0.5) * 6;
        addBoulder(detail, x, context.ground(x, z), z, 0.6 + rng() * 1.1, rng, pick(stones, rng));
      }
    }
  }

  // ---- Corner towers (the first is the keep's place), some fallen to stumps ----
  for (let index = 1; index < towerCount; index++) {
    const corner = corners[index];
    const fallen = index !== gateEdge && index !== gateEdge + 1 && rng() < ruin * 0.8;
    const towerRadius = roll([3.8, 5], rng);
    const height = fallen ? wallHeight * (0.5 + rng() * 0.4) : wallHeight + roll([4, 7], rng);
    addRoundTower(body, corner.x, corner.ground - 2, corner.z, towerRadius, height + 2, !fallen, rng, stones);
    out.colliders.push(localCylinder('tower', corner.x, corner.ground - 2, corner.z, towerRadius * 1.04, height + 2 + (fallen ? 1.2 : 1.6), { surface: 'stone', perch: fallen ? false : { x: corner.x, y: corner.ground + height + 1.6, z: corner.z } }));
  }

  // ---- The gatehouse: twin towers flank the gate passage under an arch ----
  {
    const from = corners[gateEdge];
    const to = corners[(gateEdge + 1) % towerCount];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const ux = dx / length;
    const uz = dz / length;
    const midX = (from.x + to.x) / 2;
    const midZ = (from.z + to.z) / 2;
    const ground = context.ground(midX, midZ);
    const yaw = Math.atan2(dz, dx);
    for (const sign of [-1, 1]) {
      const x = midX + ux * sign * 6.2;
      const z = midZ + uz * sign * 6.2;
      addRoundTower(body, x, ground - 2, z, 3.2, wallHeight + 6, true, rng, stones);
      out.colliders.push(localCylinder('gateTower', x, ground - 2, z, 3.4, wallHeight + 9.6, { surface: 'stone', perch: { x, y: ground + wallHeight + 5.6, z } }));
      // A brazier bracket on each gate tower's face, beside the passage.
      torch(x + uz * 3.6, addTorchPost(detail, x + uz * 3.6, ground + 3.4, z - ux * 3.6, 0), z - ux * 3.6, 1);
    }
    // The arch over the passage (its ring in the wall's plane: local x along the wall), the wall above.
    body.setTransform(midX, ground + 4.2, midZ, yaw);
    addArchRing(body, 0, 0, 0, 2.9, 1.1, WALL_THICKNESS + 0.4, 8, stones, rng);
    body.resetTransform();
    body.setPaint(pick(stones, rng)).box(midX, ground + 4.2 + 2.9 + (wallHeight - 7.1) / 2 + 0.6, midZ, 7.4, wallHeight - 5.9, WALL_THICKNESS, yaw);
    // Solid from the arch's crown up: the passage below it stays open.
    const lintelBottom = ground + 7.1;
    const lintelTop = ground + wallHeight + 1.2;
    out.colliders.push(localBox('gateLintel', midX, (lintelBottom + lintelTop) / 2, midZ, 7.4, Math.max(1, lintelTop - lintelBottom), WALL_THICKNESS, yaw, { surface: 'stone' }));
    addBattlements(body, midX - ux * 3.6, midZ - uz * 3.6, midX + ux * 3.6, midZ + uz * 3.6, ground + wallHeight + 1.2, { thickness: WALL_THICKNESS * 0.45, wallPaint: pick(stones, rng) });
  }

  // ---- The keep on the cliff edge ----
  const keep = corners[0];
  const keepX = keep.x;
  const keepZ = keep.z;
  const keepGround = Math.min(keep.ground, heightAt(keep.along - keepRadius, keep.across), heightAt(keep.along + keepRadius, keep.across));
  addRoundTower(body, keepX, keepGround - 4, keepZ, keepRadius, keepHeight + 4, true, rng, stones, true);
  const keepTop = keepGround + keepHeight;
  out.colliders.push(localCylinder('keep', keepX, keepGround - 4, keepZ, keepRadius * 1.05, keepHeight + 4, { surface: 'stone', landable: true, perch: { x: keepX, y: keepTop + 0.4, z: keepZ } }));
  out.colliders.push(localCylinder('keepParapet', keepX, keepTop, keepZ, keepRadius * 1.16, 2.2, { surface: 'stone' }));
  for (const angle of [0.6, 3.7]) {
    const x = keepX + Math.sin(angle) * (keepRadius - 1.4);
    const z = keepZ - Math.cos(angle) * (keepRadius - 1.4);
    torch(x, addTorchPost(detail, x, keepTop, z, 0.9), z, 1.4);
  }
  if (withBanners) {
    // Two banners on outriggers either side of the keep, their crossbars across the prevailing wind.
    const across = Math.atan2(context.windX, -context.windZ);
    for (const [sign, colour, stripe] of [[1, HERITAGE.flags[2], HERITAGE.flags[4]], [-1, HERITAGE.flags[0], HERITAGE.flags[1]]]) {
      const x = keepX + Math.cos(across) * sign * (keepRadius + 1.4);
      const z = keepZ + Math.sin(across) * sign * (keepRadius + 1.4);
      addBanner(cloth, detail, x, keepTop - 0.6, z, across, { width: 2.2, length: 7.5, colour, stripe });
    }
  }

  // ---- The roofless hall in the bailey ----
  {
    const along = centreAlong + radius * 0.15;
    const across = radius * 0.2;
    const [hx, hz] = point(along, across);
    const ground = context.ground(hx, hz);
    const halfWidth = roll([6, 8], rng);
    const halfLength = roll([10, 13], rng);
    const height = roll([6, 9], rng);
    for (const [da, dc, sizeAcross, sizeAlong] of [[-halfLength, 0, halfWidth * 2, 1.4], [halfLength, 0, halfWidth * 2, 1.4], [0, -halfWidth, 1.4, halfLength * 2], [0, halfWidth, 1.4, halfLength * 2]]) {
      const [x, z] = point(along + da, across + dc);
      const wallTop = height * (0.6 + rng() * 0.4);
      body.setPaint(pick(stones, rng)).box(x, ground - 1 + (wallTop + 1) / 2, z, sizeAcross, wallTop + 1, sizeAlong, frame.yaw);
      out.colliders.push(localBox('hallWall', x, ground - 1 + (wallTop + 1) / 2, z, sizeAcross, wallTop + 1, sizeAlong, frame.yaw, { surface: 'stone' }));
    }
    for (const sign of [-1, 1]) {
      const [bx, bz] = point(along + sign * (halfLength + 4), across);
      torch(bx, addTorchPost(detail, bx, context.ground(bx, bz), bz, 1), bz, 1.2);
    }
  }

  out.audioPoint = [frame.x(18, 0), site.bottomY + 4, frame.z(18, 0)];
  out.windProbe = [keepX, keepTop, keepZ];
  out.radius = Math.max(out.radius, radius * 2 + 20);
}

/**
 * A round tower at local (x, y, z): a slightly tapered stone drum with string courses and arrow slits,
 * and on a sound tower a corbelled parapet with merlons; a ruin's top is a ring of stones of uneven
 * height. keep: taller proportions with two string courses and wider slits.
 */
function addRoundTower(body, x, y, z, radius, height, sound, random, stones, keep = false) {
  const sides = keep ? 14 : 10;
  const top = radius * 0.94;
  body.setPaint(pick(stones, random)).lathe(x, y, z, [[radius * 1.06, 0], [radius, height * 0.12], [top, height]], sides, { closeBottom: true, closeTop: true, phase: random() * 3 });
  for (const share of keep ? [0.42, 0.78] : [0.6]) {
    const level = y + height * share;
    const ringRadius = radius + (top - radius) * share + 0.18;
    body.setPaint(shade(pick(stones, random), 0.85)).lathe(x, level, z, [[ringRadius, 0], [ringRadius, 0.45]], sides, { closeTop: true, phase: 0.1 });
  }
  const slits = keep ? 6 : 3;
  for (let index = 0; index < slits; index++) {
    const angle = (index / slits) * Math.PI * 2 + random() * 0.6;
    const level = y + height * (0.35 + 0.45 * ((index * 0.37) % 1));
    const reach = radius + (top - radius) * ((level - y) / height) + 0.05;
    const sx = x + Math.sin(angle) * reach;
    const sz = z - Math.cos(angle) * reach;
    body.setPaint(HERITAGE.windowDark).box(sx, level, sz, keep ? 0.7 : 0.45, keep ? 2.2 : 1.6, 0.4, angle);
  }
  const crown = y + height;
  if (sound) {
    body.setPaint(shade(pick(stones, random), 0.92)).lathe(x, crown - 0.6, z, [[top, 0], [top * 1.14, 0.6], [top * 1.14, 1.4]], sides, { closeTop: true, phase: 0.05 });
    const merlons = keep ? 12 : 8;
    for (let index = 0; index < merlons; index++) {
      const angle = (index / merlons) * Math.PI * 2;
      body.setPaint(pick(stones, random)).box(x + Math.sin(angle) * top * 1.08, crown + 1.4, z - Math.cos(angle) * top * 1.08, 1.2, 1.5, 0.7, angle);
    }
  } else {
    const stonesAround = 9;
    for (let index = 0; index < stonesAround; index++) {
      const angle = (index / stonesAround) * Math.PI * 2;
      const rise = random() * 2.6;
      body.setPaint(pick(stones, random)).box(x + Math.sin(angle) * top * 0.86, crown + rise / 2 - 0.2, z - Math.cos(angle) * top * 0.86, 1.8, rise + 0.4, 1.1, angle);
    }
  }
}
