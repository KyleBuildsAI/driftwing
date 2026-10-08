// Extra ground surfaces: landable ground that is not terrain (the tops of floating islands, and from
// Phase 3 every landable collider's up-facing faces: decks, roofs, lintels, platforms; see
// src/world/colliders.js). The terrain's height function stays the single source of truth for the
// world; these surfaces sit on top of it for whoever asks with a height to look down from.
//
//   add({ id, minX, maxX, minZ, maxZ, top, heightAt(x, z) })   registers a surface; heightAt returns
//        the surface height (m) at (x, z), or NaN where the surface is not (outside its outline).
//        The box bounds it (m, world XZ); top is its highest point (m).
//   remove(id)                                                removes it (true when it was there)
//   setBounds(id, minX, maxX, minZ, maxZ, top)                moves a surface's box (a moving
//        landable collider); allocation-free unless it enters new cells
//   surfaceBelow(x, z, ceiling)                               the highest surface height at (x, z)
//        that is at or below `ceiling`, or -Infinity where none is
//   surfaceIdBelow(x, z, ceiling)                             the id of that surface, or null
//   count, list()
//
// The flight controller asks with the craft's own height plus a small reach as the ceiling: a craft
// on or just above an island top stands on it, a craft flying beneath the island passes under.
// Surfaces are filed in a 2D hash of CELL_SIZE cells, so a query reads only the surfaces over its
// point however many structures carry landable tops. Every query allocates nothing.

import { createCellGrid } from './cellGrid.js';

const CELL_SIZE = 256;
/** A surface spanning more cells than this is checked by every query instead of being filed. */
const MAX_FILED_CELLS = 4096;

export function createGroundSurfaces() {
  const byId = new Map();
  const cells = createCellGrid();
  /** Surfaces too large to file: every query checks them. */
  const wide = [];
  const lookup = { height: -Infinity, entry: null };

  function file(entry) {
    entry.cellMinX = Math.floor(entry.minX / CELL_SIZE);
    entry.cellMinZ = Math.floor(entry.minZ / CELL_SIZE);
    entry.cellMaxX = Math.floor(entry.maxX / CELL_SIZE);
    entry.cellMaxZ = Math.floor(entry.maxZ / CELL_SIZE);
    if ((entry.cellMaxX - entry.cellMinX + 1) * (entry.cellMaxZ - entry.cellMinZ + 1) > MAX_FILED_CELLS) {
      entry.filed = 2;
      wide.push(entry);
      return;
    }
    entry.filed = 1;
    for (let cellX = entry.cellMinX; cellX <= entry.cellMaxX; cellX++) {
      for (let cellZ = entry.cellMinZ; cellZ <= entry.cellMaxZ; cellZ++) cells.add(cellX, cellZ, entry);
    }
  }

  function unfile(entry) {
    if (entry.filed === 2) {
      cells.removeFrom(wide, entry);
    } else if (entry.filed === 1) {
      for (let cellX = entry.cellMinX; cellX <= entry.cellMaxX; cellX++) {
        for (let cellZ = entry.cellMinZ; cellZ <= entry.cellMaxZ; cellZ++) cells.remove(cellX, cellZ, entry);
      }
    }
    entry.filed = 0;
  }

  function visit(entry, x, z, ceiling) {
    if (x < entry.minX || x > entry.maxX || z < entry.minZ || z > entry.maxZ) return;
    const height = entry.heightAt(x, z);
    // Ties go to the lower id, so the answer never depends on the order surfaces were added.
    if (height === height && height <= ceiling && (height > lookup.height || (height === lookup.height && entry.id < lookup.entry.id))) {
      lookup.height = height;
      lookup.entry = entry;
    }
  }

  /** Fills lookup with the highest surface at (x, z) at or below ceiling. */
  function find(x, z, ceiling) {
    lookup.height = -Infinity;
    lookup.entry = null;
    const cell = cells.get(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE));
    if (cell !== undefined) for (let index = 0; index < cell.count; index++) visit(cell.items[index], x, z, ceiling);
    for (let index = 0; index < wide.length; index++) visit(wide[index], x, z, ceiling);
  }

  return {
    add(surface) {
      if (!surface || typeof surface.heightAt !== 'function') throw new TypeError('[DRIFTWING] a ground surface needs heightAt(x, z)');
      const id = String(surface.id ?? '');
      if (!id) throw new TypeError('[DRIFTWING] a ground surface needs an id');
      if (byId.has(id)) throw new Error(`[DRIFTWING] ground surface "${id}" already exists`);
      for (const field of ['minX', 'maxX', 'minZ', 'maxZ', 'top']) {
        if (!Number.isFinite(surface[field])) throw new TypeError(`[DRIFTWING] ground surface "${id}" needs a finite ${field}`);
      }
      const entry = {
        id, minX: surface.minX, maxX: surface.maxX, minZ: surface.minZ, maxZ: surface.maxZ, top: surface.top, heightAt: surface.heightAt,
        cellMinX: 0, cellMinZ: 0, cellMaxX: 0, cellMaxZ: 0, filed: 0,
      };
      byId.set(id, entry);
      file(entry);
      return id;
    },
    remove(id) {
      const entry = byId.get(String(id));
      if (!entry) return false;
      byId.delete(entry.id);
      unfile(entry);
      return true;
    },
    /** Moves a surface's bounds (m); refiles it only when its cells change. False when unknown. */
    setBounds(id, minX, maxX, minZ, maxZ, top) {
      const entry = byId.get(id);
      if (!entry) return false;
      entry.minX = minX;
      entry.maxX = maxX;
      entry.minZ = minZ;
      entry.maxZ = maxZ;
      entry.top = top;
      if (entry.filed === 1 && Math.floor(minX / CELL_SIZE) === entry.cellMinX && Math.floor(minZ / CELL_SIZE) === entry.cellMinZ
        && Math.floor(maxX / CELL_SIZE) === entry.cellMaxX && Math.floor(maxZ / CELL_SIZE) === entry.cellMaxZ) return true;
      unfile(entry);
      file(entry);
      return true;
    },
    /** The highest surface at (x, z) no higher than ceiling (m), or -Infinity. */
    surfaceBelow(x, z, ceiling) {
      find(x, z, ceiling);
      return lookup.height;
    },
    /** The id of the surface surfaceBelow would answer with, or null. */
    surfaceIdBelow(x, z, ceiling) {
      find(x, z, ceiling);
      return lookup.entry ? lookup.entry.id : null;
    },
    get count() {
      return byId.size;
    },
    list() {
      return [...byId.values()].map((entry) => ({ id: entry.id, minX: entry.minX, maxX: entry.maxX, minZ: entry.minZ, maxZ: entry.maxZ, top: entry.top }));
    },
  };
}
