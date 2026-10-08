// Floating render origin (Phase 3 contract section a).
//
// The simulation lives in float64 WORLD coordinates and never reads the render origin: flight
// models, state.player, the WindField, placement, colliders, the director, every Object3D.position
// and camera.position keep meaning world. The GPU sees the RENDER frame, world - offset, so the
// craft and the camera always stay within a few kilometres of 0 and float32 keeps its precision on
// long flights and at altitude.
//
// The origin is applied in one place: scene.position = -offset. The camera is a child of the scene,
// so camera.matrixWorld and every object's matrixWorld come out in the render frame, computed in
// float64 on the CPU, and a rebase moves everything at once, exactly, in the same frame (no pop).
// What still needs care elsewhere (contract a.5 - a.7):
//   shaders     positionWorld and cameraPosition are render frame: a shader that compares them with
//               an absolute world value adds uniforms.renderOrigin first (worldPositionNode below);
//               relative math and patterns whose period divides ORIGIN_QUANTUM need nothing
//   CPU         matrixWorld, getWorldPosition() and the view matrix are render frame: convert with
//               toRender / toWorld, or read camera.position (world)
//   buffers     a float32 buffer of positions is stored relative to an anchor near the camera
//
// The origin moves on a 4096 m lattice on all three axes. Every periodic pattern in the game has a
// power-of-two period dividing it (terrain WRAP_PERIOD, the water wave tile, CHUNK_SIZE), so
// mod(positionWorld.xz, P) is unchanged by a rebase. After a rebase the focus is at most half the
// cube diagonal (3547 m) from the origin, inside the 5000 m threshold, so rebases never thrash.

/** m: a rebase happens when the focus is farther than this (3D) from the render origin. */
export const ORIGIN_REBASE_DISTANCE = 5000;
/** m: the render origin sits on this lattice on all three axes. */
export const ORIGIN_QUANTUM = 4096;

/** The lattice point nearest to value (one axis). */
export function quantizeOrigin(value) {
  return Math.round(value / ORIGIN_QUANTUM) * ORIGIN_QUANTUM;
}

/**
 * TSL helper: the WORLD position of the current fragment or vertex, positionWorld + renderOrigin.
 * Shaders that compare a position with an absolute world value (a water level, a world-space noise,
 * a world anchor) use this instead of positionWorld. TSL is the 'three/tsl' namespace and uniforms
 * the game's shared uniforms (uniforms.renderOrigin).
 */
export function worldPositionNode(TSL, uniforms) {
  return TSL.positionWorld.add(uniforms.renderOrigin);
}

/**
 * TSL helper: the camera's WORLD position (cameraPosition + renderOrigin), for shaders that compare
 * the eye height with absolute world heights (a fog layer base, a cloud deck).
 */
export function worldCameraPositionNode(TSL, uniforms) {
  return TSL.cameraPosition.add(uniforms.renderOrigin);
}

/**
 * Creates the render origin. scene is the game scene (its position becomes -offset), uniforms the
 * shared uniforms (uniforms.renderOrigin is written on a rebase; may be null in node labs), bus the
 * typed event bus ('originRebased' after every rebase; may be null). Returns the origin (contract a.2).
 */
export function createRenderOrigin({ THREE, scene, uniforms = null, bus = null }) {
  const offset = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const delta = new THREE.Vector3();
  // Listener list in registration order; removal swaps nothing (order is part of the contract).
  const listeners = [];
  // One payload, rewritten per rebase: a listener copies what it keeps.
  const payload = {
    offset: { x: 0, y: 0, z: 0 },
    previous: { x: 0, y: 0, z: 0 },
    delta: { x: 0, y: 0, z: 0 },
    version: 0,
  };
  const stats = { offset: { x: 0, y: 0, z: 0 }, version: 0, rebases: 0, lastRebaseFrame: -1 };
  let version = 0;
  let rebases = 0;
  let lastRebaseFrame = -1;
  let frame = 0;
  const limitSquared = ORIGIN_REBASE_DISTANCE * ORIGIN_REBASE_DISTANCE;

  function writeTriple(target, source) {
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
  }

  /** Moves the origin to the lattice point (x, y, z) (already quantized). Returns true on a change. */
  function applyRebase(x, y, z) {
    if (x === offset.x && y === offset.y && z === offset.z) return false;
    previous.copy(offset);
    offset.set(x, y, z);
    delta.subVectors(offset, previous);
    version++;
    rebases++;
    lastRebaseFrame = frame;
    if (scene) {
      scene.position.set(-x, -y, -z);
      scene.updateMatrixWorld();
    }
    if (uniforms && uniforms.renderOrigin) uniforms.renderOrigin.value.copy(offset);
    for (let index = 0; index < listeners.length; index++) {
      try {
        listeners[index](delta, origin);
      } catch (error) {
        console.error('[DRIFTWING] a render origin listener failed', error);
      }
    }
    if (bus) {
      writeTriple(payload.offset, offset);
      writeTriple(payload.previous, previous);
      writeTriple(payload.delta, delta);
      payload.version = version;
      bus.emitTyped('originRebased', payload);
    }
    return true;
  }

  const origin = {
    /** WORLD position of the render origin (read only); every component is a multiple of ORIGIN_QUANTUM. */
    offset,
    /** +1 per rebase. */
    get version() {
      return version;
    },
    /**
     * Once per frame, first in the frame (the loop), with the focus in WORLD coordinates
     * (state.player.position). Rebases when the focus is farther than ORIGIN_REBASE_DISTANCE from the
     * origin. Returns true on a rebase. Allocation-free.
     */
    update(focus) {
      frame++;
      const dx = focus.x - offset.x;
      const dy = focus.y - offset.y;
      const dz = focus.z - offset.z;
      if (!(dx * dx + dy * dy + dz * dz > limitSquared)) return false;
      if (!Number.isFinite(focus.x) || !Number.isFinite(focus.y) || !Number.isFinite(focus.z)) return false;
      return applyRebase(quantizeOrigin(focus.x), quantizeOrigin(focus.y), quantizeOrigin(focus.z));
    },
    /**
     * Rebases now to the lattice point nearest worldPoint, even inside the threshold (tests, the dev
     * hook, teleports that want the new frame at once). Returns true when the origin moved.
     */
    rebaseTo(worldPoint) {
      if (!Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y) || !Number.isFinite(worldPoint.z)) {
        throw new Error(`[DRIFTWING] render origin rebaseTo needs a finite point, got ${worldPoint.x}, ${worldPoint.y}, ${worldPoint.z}`);
      }
      return applyRebase(quantizeOrigin(worldPoint.x), quantizeOrigin(worldPoint.y), quantizeOrigin(worldPoint.z));
    },
    /** out = world - offset (render frame). Allocation-free; out may be world. */
    toRender(world, out) {
      out.x = world.x - offset.x;
      out.y = world.y - offset.y;
      out.z = world.z - offset.z;
      return out;
    },
    /** out = render + offset (world frame). Allocation-free; out may be render. */
    toWorld(render, out) {
      out.x = render.x + offset.x;
      out.y = render.y + offset.y;
      out.z = render.z + offset.z;
      return out;
    },
    /**
     * listener(delta, origin) runs synchronously inside every rebase, after the scene and the uniform
     * moved and before 'originRebased', for render-frame caches. delta (world, m) is the origin's
     * move: a cached render-frame position p becomes p - delta. Listeners must not allocate. Returns
     * the unsubscribe function.
     */
    onRebase(listener) {
      if (typeof listener !== 'function') throw new Error('[DRIFTWING] render origin onRebase needs a function');
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    /** Number of registered listeners (dispose checks). */
    get listenerCount() {
      return listeners.length;
    },
    /** { offset, version, rebases, lastRebaseFrame } (one object, rewritten per call). */
    getStats() {
      writeTriple(stats.offset, offset);
      stats.version = version;
      stats.rebases = rebases;
      stats.lastRebaseFrame = lastRebaseFrame;
      return stats;
    },
  };
  return origin;
}
