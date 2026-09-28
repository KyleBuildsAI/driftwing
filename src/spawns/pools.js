// Pooling helpers for spawn engines (the engine ctx's `pools`). Engines never allocate in update():
// they take scratch math objects from rings, instance slots from allocators and reusable objects from
// object pools, all sized up front.
//
//   createScratch(THREE, size)       rings of Vector3 / Quaternion / Matrix4 / Color for temporaries
//   createSlotAllocator(capacity)    free-list of integer slots (instanced meshes, particle blocks)
//   createObjectPool(factory, ...)   reusable objects with acquire() / release()
//   createInstancedPool(THREE, ...)  an InstancedMesh with slot allocation, hidden free slots and
//                                    dirty-range uploads; dispose() frees its GPU buffers

/**
 * Rings of scratch objects. vec3(), quat(), mat4() and color() hand out the next object of their
 * ring: a value is only valid until the ring wraps (size calls later), so use it within one call and
 * never keep it.
 */
export function createScratch(THREE, size = 32) {
  function ring(factory) {
    const items = Array.from({ length: size }, factory);
    let cursor = 0;
    return () => {
      const item = items[cursor];
      cursor = (cursor + 1) % size;
      return item;
    };
  }
  return Object.freeze({
    vec3: ring(() => new THREE.Vector3()),
    quat: ring(() => new THREE.Quaternion()),
    mat4: ring(() => new THREE.Matrix4()),
    color: ring(() => new THREE.Color()),
    size,
  });
}

/**
 * A free list of integer slots 0..capacity-1. alloc() returns a free slot in O(1) (ascending at
 * first, then the most recently freed), or -1 when full; free(slot) returns it. highWater is one past the highest slot ever
 * handed out, so an instanced mesh can draw only [0, highWater).
 */
export function createSlotAllocator(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('createSlotAllocator needs a positive integer capacity');
  const freeList = new Int32Array(capacity);
  const inUse = new Uint8Array(capacity);
  let freeCount = capacity;
  let highWater = 0;
  // Slots are handed out in ascending order at first: the free list is a stack with slot 0 on top.
  for (let index = 0; index < capacity; index++) freeList[index] = capacity - 1 - index;
  return {
    alloc() {
      if (freeCount === 0) return -1;
      const slot = freeList[--freeCount];
      inUse[slot] = 1;
      if (slot + 1 > highWater) highWater = slot + 1;
      return slot;
    },
    free(slot) {
      if (!(slot >= 0 && slot < capacity) || inUse[slot] === 0) return false;
      inUse[slot] = 0;
      freeList[freeCount++] = slot;
      if (freeCount === capacity) highWater = 0;
      else while (highWater > 0 && inUse[highWater - 1] === 0) highWater--;
      return true;
    },
    isUsed(slot) {
      return slot >= 0 && slot < capacity && inUse[slot] === 1;
    },
    get used() { return capacity - freeCount; },
    get available() { return freeCount; },
    get highWater() { return highWater; },
    capacity,
  };
}

/**
 * Reusable objects: acquire() takes one from the pool (or makes one with factory() when empty, up to
 * limit, then returns null), release(object) runs reset(object) and puts it back. prefill objects are
 * built up front so steady-state use never allocates.
 */
export function createObjectPool(factory, { reset = null, prefill = 0, limit = Infinity } = {}) {
  const available = [];
  let created = 0;
  let outstanding = 0;
  for (let index = 0; index < prefill; index++) {
    available.push(factory());
    created++;
  }
  return {
    acquire() {
      let object = available.pop();
      if (object === undefined) {
        if (created >= limit) return null;
        object = factory();
        created++;
      }
      outstanding++;
      return object;
    },
    release(object) {
      if (object === null || object === undefined) return;
      if (reset) reset(object);
      outstanding--;
      available.push(object);
    },
    get created() { return created; },
    get outstanding() { return outstanding; },
    get available() { return available.length; },
  };
}

/**
 * An InstancedMesh of `capacity` instances with slot allocation. alloc() returns a slot (or -1),
 * setMatrix(slot, matrix) / setColor(slot, color) write it, free(slot) hides it (zero scale). Call
 * flush() after writing (any number of times per frame): it marks the instance buffers for upload
 * when something changed and draws only up to the highest used slot. It uploads whole buffers rather
 * than update ranges, because three.js allocates an object per update range. The mesh is built on construction and added to parent (if given).
 * dispose(options) removes it and frees its instance buffers, and the geometry and material too
 * unless options.keepGeometry / options.keepMaterial (shared resources) say otherwise.
 */
export function createInstancedPool(THREE, { geometry, material, capacity, name = 'instanced-pool', parent = null, colors = false }) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const white = new THREE.Color(1, 1, 1);
  for (let index = 0; index < capacity; index++) {
    mesh.setMatrixAt(index, hidden);
    if (colors) mesh.setColorAt(index, white);
  }
  if (colors) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  if (parent) parent.add(mesh);
  const slots = createSlotAllocator(capacity);
  let matricesDirty = false;
  let colorsDirty = false;
  let disposed = false;

  return {
    mesh,
    slots,
    alloc() {
      return slots.alloc();
    },
    free(slot) {
      if (!slots.free(slot)) return false;
      mesh.setMatrixAt(slot, hidden);
      matricesDirty = true;
      return true;
    },
    setMatrix(slot, matrix) {
      mesh.setMatrixAt(slot, matrix);
      matricesDirty = true;
    },
    setColor(slot, color) {
      if (!colors) return;
      mesh.setColorAt(slot, color);
      colorsDirty = true;
    },
    /** Marks changed instance buffers for upload and trims the draw count to the highest used slot. */
    flush() {
      mesh.count = slots.highWater;
      mesh.visible = slots.highWater > 0;
      if (matricesDirty) mesh.instanceMatrix.needsUpdate = true;
      if (colorsDirty && colors) mesh.instanceColor.needsUpdate = true;
      matricesDirty = false;
      colorsDirty = false;
    },
    get used() { return slots.used; },
    capacity,
    dispose({ keepGeometry = false, keepMaterial = false } = {}) {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      // InstancedMesh.dispose() dispatches 'dispose', which frees the instance attribute buffers.
      mesh.dispose();
      if (!keepGeometry) geometry.dispose();
      if (!keepMaterial) material.dispose();
    },
  };
}
