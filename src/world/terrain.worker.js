// Terrain worker: builds chunk meshes and vegetation scatter off the main thread. Loaded with
// Vite's ?worker&inline import, so it also works inside the single-file build.
import { createWorldGen } from './worldgen.js';
import { createChunkBuilder } from './chunkBuilder.js';

let builder = null;
function drain(steps) {
  let progress = steps.next();
  while (!progress.done) progress = steps.next();
}
function floatBuffer(candidate, floats) {
  return candidate instanceof ArrayBuffer && candidate.byteLength === floats * 4 ? candidate : new ArrayBuffer(floats * 4);
}
self.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      builder = createChunkBuilder(createWorldGen(message.seed, message.options), message.config);
      self.postMessage({ type: 'ready' });
    } else if (message.type === 'mesh') {
      const started = performance.now();
      const floats = builder.vertexCount(message.lod) * 3;
      message.position = floatBuffer(message.position, floats);
      message.normal = floatBuffer(message.normal, floats);
      message.color = floatBuffer(message.color, floats);
      const output = {
        positions: new Float32Array(message.position),
        normals: new Float32Array(message.normal),
        colors: new Float32Array(message.color),
        minY: 0,
        maxY: 0,
        vertexCount: 0,
      };
      drain(builder.buildMesh(message, output));
      message.minY = output.minY;
      message.maxY = output.maxY;
      message.buildMs = performance.now() - started;
      self.postMessage(message, [message.position, message.normal, message.color]);
    } else if (message.type === 'scatter') {
      const started = performance.now();
      message.data = floatBuffer(message.data, message.floats);
      drain(builder.buildScatter(message, new Float32Array(message.data)));
      message.buildMs = performance.now() - started;
      self.postMessage(message, [message.data]);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : ''),
    });
  }
};
