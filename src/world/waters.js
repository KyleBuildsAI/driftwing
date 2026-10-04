// Local water bodies: the `waters` a site preset declares next to its stamps, resolved per site into
// world-space records (contract section c.1).
//
// A water body is a flat surface at its own level, clipped to the basin of the stamp that holds it:
// the surface exists at (x, z) only inside that basin's outline (waterOutlineContains) AND where the
// ground there lies below the level, so a lake never spills over its rim. Placement (placement.js)
// resolves the waters of every site right after its stamps, from the same per-site seed stream, so
// the main thread, the terrain worker, the map tiles and the far field all see the same bodies.
//
// Spec fields (pure data in the preset):
//   kind      'lake' | 'pool' | 'thin' (a film over a flat: salt flat, rice terrace flats)
//   stamp     index of the stamp whose basin clips the water (required)
//   level     { mode: 'basin', fill } (fraction 0..1 of the basin's depth) | { mode: 'absolute',
//             height } (m above sea level, kept inside the basin) | { mode: 'aboveGround', height }
//             (m above the basin floor: thin films)
//   material  'water' | 'ice'
//   tint      optional body colour (sRGB hex)
//   waves     swell scale relative to the ocean (0..1), glint and foam (0..2), mirror (0..1: the
//             salt-flat sky mirror)
// Host stamps: basin and crater (one body), terraces (one body per shelf, ids '<siteId>:w<i>s<k>'),
// flatten (thin films on the strip).
//
// Pure: imports only stamps.js, no DOM, so the terrain worker runs exactly this code.
import { basinReach, terraceShelfAt } from './stamps.js';

export const WATER_KINDS = Object.freeze(['lake', 'pool', 'thin']);
export const WATER_LEVEL_MODES = Object.freeze(['basin', 'absolute', 'aboveGround']);
export const WATER_MATERIALS = Object.freeze(['water', 'ice']);
/** The stamp types that can hold a water body. */
export const WATER_HOST_TYPES = Object.freeze(['basin', 'crater', 'terraces', 'flatten']);
/** Water material ids (the terrain worker's water flag and the renderer's material switch). */
export const WATER_MATERIAL_ID = Object.freeze({ water: 1, ice: 2 });

const SPEC_FIELDS = Object.freeze(['kind', 'stamp', 'level', 'material', 'tint', 'waves', 'glint', 'foam', 'mirror']);
const DEFAULTS = Object.freeze({ material: 'water', tint: null, waves: 0.25, glint: 1, foam: 1, mirror: 0 });
/** A level never comes closer than this to its basin's brim (m), so the rim always shows. */
const BRIM_MARGIN = 0.4;

function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

/**
 * Checks one water spec against the preset's stamp specs; throws an Error naming the preset, the
 * water and the field. where: a label such as 'preset "craterLake" waters[0]'.
 */
export function validateWaterSpec(spec, stampSpecs, where) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${where}: a water body must be an object`);
  for (const key of Object.keys(spec)) {
    if (!SPEC_FIELDS.includes(key)) throw new Error(`${where}.${key}: unknown field (known: ${SPEC_FIELDS.join(', ')})`);
  }
  if (!WATER_KINDS.includes(spec.kind)) throw new Error(`${where}.kind: "${spec.kind}" is not one of ${WATER_KINDS.join(', ')}`);
  if (!Number.isInteger(spec.stamp) || spec.stamp < 0 || spec.stamp >= stampSpecs.length) {
    throw new Error(`${where}.stamp: must be the index of one of the preset's ${stampSpecs.length} stamps`);
  }
  const host = stampSpecs[spec.stamp].type;
  if (!WATER_HOST_TYPES.includes(host)) throw new Error(`${where}.stamp: a ${host} stamp cannot hold water (hosts: ${WATER_HOST_TYPES.join(', ')})`);
  const level = spec.level;
  if (level === null || typeof level !== 'object') throw new Error(`${where}.level: must be { mode, fill | height }`);
  if (!WATER_LEVEL_MODES.includes(level.mode)) throw new Error(`${where}.level.mode: "${level.mode}" is not one of ${WATER_LEVEL_MODES.join(', ')}`);
  if (level.mode === 'basin') {
    if (!isNumber(level.fill) || level.fill <= 0 || level.fill > 1) throw new Error(`${where}.level.fill: must be a number in (0, 1]`);
    if (host === 'flatten') throw new Error(`${where}.level.mode: a flatten strip has no basin depth (use 'aboveGround')`);
  } else if (!isNumber(level.height)) {
    throw new Error(`${where}.level.height: must be a number of metres`);
  }
  if (level.mode === 'aboveGround' && level.height <= 0) throw new Error(`${where}.level.height: must be above 0 for 'aboveGround'`);
  if (spec.material !== undefined && !WATER_MATERIALS.includes(spec.material)) throw new Error(`${where}.material: "${spec.material}" is not one of ${WATER_MATERIALS.join(', ')}`);
  if (spec.tint !== undefined && spec.tint !== null && !(Number.isInteger(spec.tint) && spec.tint >= 0 && spec.tint <= 0xffffff)) {
    throw new Error(`${where}.tint: must be null or an sRGB hex colour`);
  }
  for (const [field, max] of [['waves', 1], ['glint', 2], ['foam', 2], ['mirror', 1]]) {
    if (spec[field] !== undefined && !(isNumber(spec[field]) && spec[field] >= 0 && spec[field] <= max)) throw new Error(`${where}.${field}: must be a number in [0, ${max}]`);
  }
}

/** The basin floor and brim (m) a level is measured against, for one host stamp (and shelf). */
function basinRange(stamp, shelf) {
  if (stamp.type === 'terraces') return { floor: stamp.shelves[shelf].floorY, brim: stamp.shelves[shelf].crestY };
  if (stamp.type === 'flatten') return { floor: stamp.y, brim: stamp.y + 2 };
  return { floor: stamp.floorY, brim: stamp.rimY };
}

function resolveLevel(level, range) {
  let value;
  if (level.mode === 'basin') value = range.floor + (range.brim - range.floor) * level.fill;
  else if (level.mode === 'absolute') value = level.height;
  else value = range.floor + level.height;
  const highest = range.brim - BRIM_MARGIN;
  return value > highest ? highest : value < range.floor + 0.05 ? range.floor + 0.05 : value;
}

/** Axis-aligned bounds of a water body's outline (its clip region). */
function outlineBounds(stamp, shelf) {
  if (stamp.type === 'basin') {
    const extent = stamp.radius * 1.16 + 1;
    return { minX: stamp.x - extent, maxX: stamp.x + extent, minZ: stamp.z - extent, maxZ: stamp.z + extent };
  }
  if (stamp.type === 'crater') {
    const extent = stamp.radius + 1;
    return { minX: stamp.x - extent, maxX: stamp.x + extent, minZ: stamp.z - extent, maxZ: stamp.z + extent };
  }
  let halfAlong;
  let halfAcross;
  let centreX = stamp.x;
  let centreZ = stamp.z;
  if (stamp.type === 'terraces') {
    // The shelf's pool span: its first 80 % along (the floor and the lip), the full width.
    halfAlong = stamp.stepLength * 0.4;
    halfAcross = stamp.width / 2;
    const along = -stamp.length / 2 + stamp.stepLength * (shelf + 0.4);
    centreX = stamp.x + stamp.dirX * along;
    centreZ = stamp.z + stamp.dirZ * along;
  } else {
    halfAlong = stamp.length / 2 + stamp.margin;
    halfAcross = stamp.width / 2 + stamp.margin;
  }
  const extentX = Math.abs(stamp.dirX) * halfAlong + Math.abs(stamp.dirZ) * halfAcross + 1;
  const extentZ = Math.abs(stamp.dirZ) * halfAlong + Math.abs(stamp.dirX) * halfAcross + 1;
  return { minX: centreX - extentX, maxX: centreX + extentX, minZ: centreZ - extentZ, maxZ: centreZ + extentZ };
}

/**
 * Resolves a site's water specs (frozen records, in spec order; a terraces host expands into one
 * record per shelf). site: the site record (id); stamps: its resolved stamps; seedFor(index) gives
 * the uint32 seed of water spec `index` (placement's stream after the stamps).
 */
export function resolveWaters(site, specs, stamps, seedFor) {
  const records = [];
  specs.forEach((spec, index) => {
    const stamp = stamps[spec.stamp];
    const full = { ...DEFAULTS, ...spec };
    const shelves = stamp.type === 'terraces' ? stamp.shelves.length : 1;
    for (let shelf = 0; shelf < shelves; shelf++) {
      const range = basinRange(stamp, shelf);
      const level = resolveLevel(full.level, range);
      records.push(Object.freeze({
        id: stamp.type === 'terraces' ? `${site.id}:w${index}s${shelf}` : `${site.id}:w${index}`,
        siteId: site.id,
        presetId: site.presetId,
        index,
        shelf: stamp.type === 'terraces' ? shelf : -1,
        kind: full.kind,
        material: full.material,
        materialId: WATER_MATERIAL_ID[full.material],
        level,
        floorY: range.floor,
        x: stamp.type === 'terraces' ? stamp.shelves[shelf].x : stamp.x,
        z: stamp.type === 'terraces' ? stamp.shelves[shelf].z : stamp.z,
        bounds: Object.freeze(outlineBounds(stamp, shelf)),
        basin: stamp,
        tint: full.tint,
        waves: full.waves,
        glint: full.glint,
        foam: full.foam,
        mirror: full.mirror,
        seed: seedFor(index),
      }));
    }
  });
  return Object.freeze(records);
}

/**
 * Whether (x, z) lies inside a water body's outline: its basin's shoreline (basin, crater), its
 * shelf's pool span (terraces) or the strip (flatten). The surface itself also needs the ground
 * below the level there (waterSurfaceAt in worldgen and the water query check that).
 */
export function waterOutlineContains(record, x, z) {
  const bounds = record.bounds;
  if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) return false;
  const stamp = record.basin;
  switch (stamp.kind) {
    case 6: return basinReach(stamp, x, z) < stamp.radius;
    case 7: {
      const dx = x - stamp.x;
      const dz = z - stamp.z;
      return dx * dx + dz * dz < stamp.radius * stamp.radius;
    }
    case 8: return terraceShelfAt(stamp, x, z) === record.shelf;
    default: {
      const dx = x - stamp.x;
      const dz = z - stamp.z;
      return Math.abs(dx * stamp.dirX + dz * stamp.dirZ) <= stamp.length / 2 + stamp.margin
        && Math.abs(dx * -stamp.dirZ + dz * stamp.dirX) <= stamp.width / 2 + stamp.margin;
    }
  }
}

/** One line of the site-list hash per water body: id, level and bounds to 1 cm. */
export function waterHashLine(record) {
  const b = record.bounds;
  return `${record.id}~${Math.round(record.level * 100)}[${Math.round(b.minX * 100)},${Math.round(b.maxX * 100)},${Math.round(b.minZ * 100)},${Math.round(b.maxZ * 100)}]`;
}
