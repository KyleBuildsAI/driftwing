// Vegetation colliders and perches (contract section d.4): the trunks of the species that have one
// (the redwoods; the world tree's preset adds its own) as procedural cylinders for the collider
// service, and the tree tops an eagle can perch on.
//
// Both read worldgen's scatter at full density (world.vegetationNear), so they are deterministic,
// independent of the quality setting (a trunk species ignores the density gate, so every collider
// stands under a drawn tree) and never need a chunk to be built. Results are cached per CELL metres
// square; the caches only save work.
//
// Built against the collider service of contract b.2 (ctx.colliders: addProvider, addPerchProvider).
// Pure: no three.js, no DOM.
import { BASE_VEGETATION, speciesById } from './vegetationSpecies.js';

/** Cache cell (m) of the provider's per-cell results. */
const CELL = 128;
const CACHE_LIMIT = 2048;
/** The Phase 1 pine's geometry tip (m above its base at scale 1, terrain.js) and its planting sink. */
const PINE_TOP = 12.1;
const PINE_SINK = 0.25;
/** One perch per PERCH_CELL square from the Phase 1 pines: the tallest one in it. */
const PERCH_CELL = 64;

/** The pine's vertical scale from its scatter scale and variant (chunkBuilder computeScale). */
function pineScaleY(scale, variant) {
  const detail = variant * 7.31 - Math.floor(variant * 7.31);
  return scale * (0.9 + 0.25 * detail);
}

/**
 * Creates the vegetation provider for a world. Returns { provider, perchProvider, collidersInCell,
 * perchesInCell } where provider ({ id, query }) and perchProvider ({ id, near }) follow contract
 * b.2; the cell functions return the cached frozen lists (for tests).
 */
export function createVegetationColliders(world) {
  const colliderCache = new Map();
  const perchCache = new Map();
  const EMPTY = Object.freeze([]);

  function cellKey(cellX, cellZ) {
    return (cellX + 32768) * 65536 + (cellZ + 32768);
  }

  /** Every trunk collider spec of one cache cell (instances whose base lies in it). */
  function collidersInCell(cellX, cellZ) {
    const key = cellKey(cellX, cellZ);
    let list = colliderCache.get(key);
    if (list !== undefined) return list;
    const found = [];
    const minX = cellX * CELL;
    const minZ = cellZ * CELL;
    world.vegetationNear(minX + CELL / 2, minZ + CELL / 2, CELL * 0.7072, (instance) => {
      if (instance.x < minX || instance.x >= minX + CELL || instance.z < minZ || instance.z >= minZ + CELL) return;
      const species = speciesById(instance.type);
      if (species === null || species.trunk === null) return;
      const scaleY = instance.scale;
      const base = instance.y - species.sink * scaleY;
      const height = species.trunk.height * scaleY;
      const top = base + species.referenceHeight * scaleY;
      found.push(Object.freeze({
        id: `vegetation:${species.name}:${Math.round(instance.x * 100)}:${Math.round(instance.z * 100)}`,
        owner: 'vegetation',
        type: 'cylinder',
        center: Object.freeze({ x: instance.x, y: base + height / 2, z: instance.z }),
        radius: species.trunk.radius * instance.scale,
        halfHeight: height / 2,
        tags: Object.freeze({
          landable: false,
          perch: species.perch ? Object.freeze({ x: instance.x, y: top, z: instance.z }) : false,
          sensor: false,
          miss: null,
          surface: 'wood',
        }),
        velocity: null,
      }));
    });
    list = found.length === 0 ? EMPTY : Object.freeze(found);
    if (colliderCache.size >= CACHE_LIMIT) colliderCache.clear();
    colliderCache.set(key, list);
    return list;
  }

  /** The perch points of one cache cell: perch species' tops and the tallest pine per PERCH_CELL. */
  function perchesInCell(cellX, cellZ) {
    const key = cellKey(cellX, cellZ);
    let list = perchCache.get(key);
    if (list !== undefined) return list;
    const minX = cellX * CELL;
    const minZ = cellZ * CELL;
    const found = [];
    const tallestPine = new Map();
    world.vegetationNear(minX + CELL / 2, minZ + CELL / 2, CELL * 0.7072, (instance) => {
      if (instance.x < minX || instance.x >= minX + CELL || instance.z < minZ || instance.z >= minZ + CELL) return;
      const species = speciesById(instance.type);
      if (species !== null) {
        if (!species.perch) return;
        const top = instance.y - species.sink * instance.scale + species.referenceHeight * instance.scale;
        found.push(Object.freeze({ id: `perch:${species.name}:${Math.round(instance.x * 100)}:${Math.round(instance.z * 100)}`, kind: 'tree', x: instance.x, y: top, z: instance.z }));
        return;
      }
      if (instance.type !== BASE_VEGETATION.PINE) return;
      const scaleY = pineScaleY(instance.scale, instance.variant);
      const top = instance.y - PINE_SINK * scaleY + PINE_TOP * scaleY;
      const slot = Math.floor(instance.x / PERCH_CELL) * 65536 + Math.floor(instance.z / PERCH_CELL);
      const best = tallestPine.get(slot);
      if (best === undefined || top > best.y || (top === best.y && instance.x < best.x)) tallestPine.set(slot, { x: instance.x, y: top, z: instance.z });
    });
    for (const pine of [...tallestPine.values()].sort((first, second) => first.x - second.x || first.z - second.z)) {
      found.push(Object.freeze({ id: `perch:pine:${Math.round(pine.x * 100)}:${Math.round(pine.z * 100)}`, kind: 'tree', x: pine.x, y: pine.y, z: pine.z }));
    }
    list = found.length === 0 ? EMPTY : Object.freeze(found);
    if (perchCache.size >= CACHE_LIMIT) perchCache.clear();
    perchCache.set(key, list);
    return list;
  }

  const provider = {
    id: 'vegetation',
    /** Contract b.2: emit(spec) for every trunk cylinder whose cell overlaps the box. */
    query(minX, minZ, maxX, maxZ, emit) {
      const firstX = Math.floor(minX / CELL);
      const lastX = Math.floor(maxX / CELL);
      const firstZ = Math.floor(minZ / CELL);
      const lastZ = Math.floor(maxZ / CELL);
      for (let cellZ = firstZ; cellZ <= lastZ; cellZ++) {
        for (let cellX = firstX; cellX <= lastX; cellX++) {
          const list = collidersInCell(cellX, cellZ);
          for (let index = 0; index < list.length; index++) emit(list[index]);
        }
      }
    },
  };

  const perchProvider = {
    id: 'vegetation',
    /** Contract b.2: visit(point) for every tree-top perch within radius of (x, y, z). */
    near(x, y, z, radius, visit) {
      const firstX = Math.floor((x - radius) / CELL);
      const lastX = Math.floor((x + radius) / CELL);
      const firstZ = Math.floor((z - radius) / CELL);
      const lastZ = Math.floor((z + radius) / CELL);
      for (let cellZ = firstZ; cellZ <= lastZ; cellZ++) {
        for (let cellX = firstX; cellX <= lastX; cellX++) {
          const list = perchesInCell(cellX, cellZ);
          for (let index = 0; index < list.length; index++) {
            const point = list[index];
            const dx = point.x - x;
            const dy = point.y - y;
            const dz = point.z - z;
            if (dx * dx + dy * dy + dz * dz <= radius * radius) visit(point);
          }
        }
      }
    },
  };

  return { provider, perchProvider, collidersInCell, perchesInCell };
}

/**
 * Registers the vegetation provider and perch provider with a collider service (contract b.2).
 * Returns the function that removes both.
 */
export function registerVegetationColliders(colliders, world) {
  const { provider, perchProvider } = createVegetationColliders(world);
  colliders.addProvider(provider);
  colliders.addPerchProvider(perchProvider);
  return () => {
    colliders.removeProvider(provider.id);
    if (typeof colliders.removePerchProvider === 'function') colliders.removePerchProvider(perchProvider.id);
  };
}
