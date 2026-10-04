// Garbage-free uniform uploads for three.js r184's WebGPURenderer (both backends).
//
// three's UniformsGroup records every uniform whose value changed as an update range: a new
// { start, count } object pushed onto an array and an entry in a Map, both cleared once the group is
// uploaded. Every render object's group changes every frame (its matrices follow the moving camera),
// so this bookkeeping allocates thousands of short-lived objects per frame, and V8 moves them
// straight to the old generation. Measured in V2 (glider over seed HARNESS-1, WebGPU): 17 MB/s
// promoted to the old generation, a major garbage collection every 3-4 s, and their pauses (and
// incremental marking tasks) were the flight test's frames over 50 ms.
//
// The patch gives every group one persistent range covering its whole buffer instead: a group whose
// values changed uploads whole (an object's group is a few hundred bytes), and nothing is allocated
// per frame. Promotion falls to about 1 MB/s. The ranges reach the GPU through the backends'
// updateBinding() exactly as before (writeBuffer on WebGPU, bufferSubData on WebGL2).
//
// UniformsGroup is not exported by 'three/webgpu', so its prototype is taken from the first uniform
// group the renderer binds. three is pinned to exactly 0.184.0; installUniformUploadPatch() throws
// when the renderer internals it relies on are missing, so a three.js upgrade cannot drop the fix
// silently.

/** The prototype that owns addUniformUpdateRange (three's UniformsGroup), or null. */
function findUniformsGroupPrototype(bindGroups) {
  for (const bindGroup of bindGroups) {
    for (const binding of bindGroup.bindings) {
      if (binding.isUniformsGroup !== true) continue;
      let prototype = Object.getPrototypeOf(binding);
      while (prototype && !Object.prototype.hasOwnProperty.call(prototype, 'addUniformUpdateRange')) {
        prototype = Object.getPrototypeOf(prototype);
      }
      if (prototype) return prototype;
    }
  }
  return null;
}

/** Replaces the per-uniform ranges with one whole-buffer range per group that is never cleared. */
function patchUniformsGroup(prototype) {
  if (!Object.prototype.hasOwnProperty.call(prototype, 'clearUpdateRanges')) {
    throw new Error('three.js UniformsGroup has no clearUpdateRanges(); the uniform upload patch does not fit this version');
  }
  prototype.addUniformUpdateRange = function addWholeBufferRange() {
    const ranges = this.updateRanges;
    if (ranges.length === 0) ranges.push({ start: 0, count: this.buffer.length });
  };
  prototype.clearUpdateRanges = function keepWholeBufferRange() {};
}

/**
 * Installs the patch on the renderer (after renderer.init()): the first bind groups that contain a
 * uniform group hand over its prototype, which is patched once for every group. Returns a status
 * object whose `installed` turns true once the prototype is patched (the first rendered frame).
 */
export function installUniformUploadPatch(renderer) {
  const bindings = renderer._bindings;
  if (!bindings || typeof bindings.getForRender !== 'function') {
    throw new Error('three.js renderer has no _bindings.getForRender(); the uniform upload patch does not fit this version');
  }
  const status = { installed: false };
  const originalGetForRender = bindings.getForRender;
  bindings.getForRender = function getForRenderAndPatch(renderObject) {
    const bindGroups = originalGetForRender.call(this, renderObject);
    const prototype = findUniformsGroupPrototype(bindGroups);
    if (prototype) {
      patchUniformsGroup(prototype);
      status.installed = true;
      // Back to the prototype's own method: the patch is on the class, not on this instance.
      delete bindings.getForRender;
    }
    return bindGroups;
  };
  return status;
}
