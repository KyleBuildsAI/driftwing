// Extra ground surfaces: landable ground that is not terrain (the tops of floating islands, and in
// later phases decks, roofs and platforms). The terrain's height function stays the single source of
// truth for the world; these surfaces sit on top of it for whoever asks with a height to look down
// from.
//
//   add({ id, minX, maxX, minZ, maxZ, top, heightAt(x, z) })   registers a surface; heightAt returns
//        the surface height (m) at (x, z), or NaN where the surface is not (outside its outline).
//        The box bounds it (m, world XZ); top is its highest point (m).
//   remove(id)                                                removes it (true when it was there)
//   surfaceBelow(x, z, ceiling)                               the highest surface height at (x, z)
//        that is at or below `ceiling`, or -Infinity where none is
//   count, list()
//
// The flight controller asks with the craft's own height plus a small reach as the ceiling: a craft
// on or just above an island top stands on it, a craft flying beneath the island passes under. Every
// query allocates nothing (a flat array scan: a handful of surfaces at a time).

export function createGroundSurfaces() {
  const surfaces = [];
  const byId = new Map();

  return {
    add(surface) {
      if (!surface || typeof surface.heightAt !== 'function') throw new TypeError('[DRIFTWING] a ground surface needs heightAt(x, z)');
      const id = String(surface.id ?? '');
      if (!id) throw new TypeError('[DRIFTWING] a ground surface needs an id');
      if (byId.has(id)) throw new Error(`[DRIFTWING] ground surface "${id}" already exists`);
      for (const field of ['minX', 'maxX', 'minZ', 'maxZ', 'top']) {
        if (!Number.isFinite(surface[field])) throw new TypeError(`[DRIFTWING] ground surface "${id}" needs a finite ${field}`);
      }
      const entry = { id, minX: surface.minX, maxX: surface.maxX, minZ: surface.minZ, maxZ: surface.maxZ, top: surface.top, heightAt: surface.heightAt };
      surfaces.push(entry);
      byId.set(id, entry);
      return id;
    },
    remove(id) {
      const entry = byId.get(String(id));
      if (!entry) return false;
      byId.delete(entry.id);
      surfaces.splice(surfaces.indexOf(entry), 1);
      return true;
    },
    /** The highest surface at (x, z) no higher than ceiling (m), or -Infinity. */
    surfaceBelow(x, z, ceiling) {
      let best = -Infinity;
      for (let index = 0; index < surfaces.length; index++) {
        const entry = surfaces[index];
        if (x < entry.minX || x > entry.maxX || z < entry.minZ || z > entry.maxZ) continue;
        const height = entry.heightAt(x, z);
        if (height === height && height <= ceiling && height > best) best = height;
      }
      return best;
    },
    get count() {
      return surfaces.length;
    },
    list() {
      return surfaces.map((entry) => ({ id: entry.id, minX: entry.minX, maxX: entry.maxX, minZ: entry.minZ, maxZ: entry.maxZ, top: entry.top }));
    },
  };
}
