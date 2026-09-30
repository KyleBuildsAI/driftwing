// Dev-only GPU geometry tracker for the engine memory checks (tools/steps/engine-*.json). The
// renderer's geometry count (renderer.info.memory.geometries) is global: while a check runs, the
// terrain may draw a pooled chunk mesh for the first time (in the shadow pass, say), which adds a
// geometry no spawn owns. The tracker records every geometry three.js initialises on the GPU between
// start() and stop() that is still alive (not disposed) at stop(), with the scene object that owns it,
// so a check can prove the count moved by exactly the terrain's new geometries and that no spawn left
// one behind.
//
// It wraps the renderer's internal geometry manager (renderer._geometries.initGeometry in three.js
// r184, which increments info.memory.geometries), so it exists only in the dev test kits. Returns null
// when that internal is missing, and the caller falls back to the plain count.

/** The name of the scene-level object that owns object (the terrain group, a spawn pool, ...). */
function ownerName(object, scene) {
  let node = object;
  while (node.parent && node.parent !== scene) node = node.parent;
  return node.name || node.type;
}

export function createGeometryTracker(renderer, scene) {
  const manager = renderer._geometries;
  if (!manager || typeof manager.initGeometry !== 'function') return null;
  const original = manager.initGeometry;
  const live = new Map();
  let tracking = false;
  manager.initGeometry = function initGeometry(renderObject) {
    const before = renderer.info.memory.geometries;
    const result = original.call(this, renderObject);
    if (tracking && renderer.info.memory.geometries > before) {
      const geometry = renderObject.geometry;
      live.set(geometry.uuid, { object: renderObject.object.name || renderObject.object.type, owner: ownerName(renderObject.object, scene), type: geometry.type });
      geometry.addEventListener('dispose', () => live.delete(geometry.uuid));
    }
    return result;
  };
  return {
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
    /** Puts the renderer's own method back. */
    restore() {
      tracking = false;
      manager.initGeometry = original;
    },
  };
}
