// Dev-only GPU geometry tracker for the engine memory checks (tools/steps/engine-*.json). The
// renderer's geometry count (renderer.info.memory.geometries) is global: while a check runs, the
// world may draw something for the first time (a pooled terrain chunk mesh in the shadow pass, a
// landmark the landmark system builds as the craft moves), which adds a geometry no spawn owns. The
// tracker records every geometry three.js initialises on the GPU between start() and stop() that is
// still alive (not disposed) at stop(), with the scene object that owns it, and whether a spawn engine
// put that owner in the scene: every object added to the scene while one of the engines given to
// attribute() runs (create, update, setLOD, dispose) is a spawn's. splitFresh then proves the count
// moved by exactly the world's new geometries and that no spawn left one behind.
//
// It wraps the renderer's internal geometry manager (renderer._geometries.initGeometry in three.js
// r184, which increments info.memory.geometries), so it exists only in the dev test kits. Returns null
// when that internal is missing, and the caller falls back to the plain count.

const ENGINE_METHODS = Object.freeze(['create', 'update', 'setLOD', 'dispose']);

/** The scene-level object that owns object (the terrain group, a spawn pool, a landmark, ...). */
function ownerNode(object, scene) {
  let node = object;
  while (node.parent && node.parent !== scene) node = node.parent;
  return node;
}

/**
 * Splits the geometries a tracker reported into the world's first draws and what a spawn left
 * behind: an entry is a spawn's when an attributed engine added its owner to the scene, or when the
 * owner's name starts with one of spawnOwners (an engine's pooled meshes made in init, for example
 * 'structure-'). Returns { world, leftBehind }: the number of world geometries and the spawn entries.
 */
export function splitFresh(fresh, spawnOwners) {
  const leftBehind = fresh.filter((entry) => entry.spawnOwned || spawnOwners.some((prefix) => entry.owner.startsWith(prefix)));
  return { world: fresh.length - leftBehind.length, leftBehind };
}

export function createGeometryTracker(renderer, scene) {
  const manager = renderer._geometries;
  if (!manager || typeof manager.initGeometry !== 'function') return null;
  const original = manager.initGeometry;
  const originalAdd = scene.add;
  const ownAdd = Object.hasOwn(scene, 'add');
  const live = new Map();
  /** Scene-level objects an attributed engine added (kept while the tracker lives). */
  const spawnAdded = new WeakSet();
  const wrapped = [];
  let insideEngine = 0;
  let tracking = false;
  manager.initGeometry = function initGeometry(renderObject) {
    const before = renderer.info.memory.geometries;
    const result = original.call(this, renderObject);
    if (tracking && renderer.info.memory.geometries > before) {
      const geometry = renderObject.geometry;
      const owner = ownerNode(renderObject.object, scene);
      live.set(geometry.uuid, {
        uuid: geometry.uuid,
        object: renderObject.object.name || renderObject.object.type,
        owner: owner.name || owner.type,
        spawnOwned: spawnAdded.has(owner),
        type: geometry.type,
      });
      geometry.addEventListener('dispose', () => live.delete(geometry.uuid));
    }
    return result;
  };
  scene.add = function add(...objects) {
    if (insideEngine > 0) for (const object of objects) spawnAdded.add(object);
    return originalAdd.apply(this, objects);
  };
  return {
    /**
     * Marks every object the given engines add to the scene from now on as a spawn's (their create,
     * update, setLOD and dispose are wrapped until restore()).
     */
    attribute(engines) {
      for (const engine of engines) {
        if (!engine) continue;
        for (const method of ENGINE_METHODS) {
          const own = engine[method];
          if (typeof own !== 'function') continue;
          engine[method] = function attributed(...args) {
            insideEngine++;
            try {
              return own.apply(this, args);
            } finally {
              insideEngine--;
            }
          };
          wrapped.push({ engine, method, own });
        }
      }
    },
    /** Starts recording (forgets anything recorded before). */
    start() {
      live.clear();
      tracking = true;
    },
    /** Stops recording; returns the geometries initialised since start() and still alive. */
    stop() {
      tracking = false;
      return [...live.values()];
    },
    /** Puts the renderer's, the scene's and the engines' own methods back. */
    restore() {
      tracking = false;
      manager.initGeometry = original;
      if (ownAdd) scene.add = originalAdd;
      else delete scene.add;
      for (const { engine, method, own } of wrapped) engine[method] = own;
      wrapped.length = 0;
    },
  };
}
