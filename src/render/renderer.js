// Renderer boot: WebGPU first, WebGL2 fallback. The WebGL2 backend is never blocked (Phase 4's
// WebXR runs on it), and ?renderer=webgl forces it.
import * as THREE from 'three/webgpu';

/**
 * True when a WebGPU device can actually be created. The probe creates (and releases) a real
 * device: an adapter alone does not prove WebGPU works, since device creation can still fail (for
 * example when the GPU is out of memory).
 */
async function probeWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    device.destroy();
    return true;
  } catch (error) {
    return false;
  }
}

/** A configured WebGPURenderer (forced onto WebGL2 unless useWebGPU) with the game's canvas setup. */
function buildRenderer(useWebGPU) {
  // Reversed depth only on WebGPU: on WebGL2 it needs EXT_clip_control (warns otherwise).
  const created = new THREE.WebGPURenderer({ antialias: true, forceWebGL: !useWebGPU, reversedDepthBuffer: useWebGPU });
  created.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  created.setSize(window.innerWidth, window.innerHeight);
  created.toneMapping = THREE.ACESFilmicToneMapping;
  created.toneMappingExposure = 1.0;
  created.shadowMap.enabled = true;
  created.domElement.id = 'view';
  created.domElement.setAttribute('tabindex', '0');
  created.domElement.setAttribute('aria-label', 'DRIFTWING flight view');
  created.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  return created;
}

/**
 * Creates and initialises the renderer, its canvas prepended to the page body. params: the page's
 * URLSearchParams (renderer=webgl skips WebGPU). Returns { renderer, backend: 'WebGPU' | 'WebGL2' }.
 */
export async function createRenderer(params) {
  const webgpuAvailable = params.get('renderer') !== 'webgl' && (await probeWebGPU());
  let renderer = buildRenderer(webgpuAvailable);
  document.body.prepend(renderer.domElement);
  await renderer.init();
  if (webgpuAvailable && !renderer.backend.isWebGPUBackend) {
    // three.js fell back to WebGL2 on its own after a late WebGPU failure; rebuild the renderer
    // for WebGL2 so no WebGPU-only option (reversed depth) is left on.
    renderer.domElement.remove();
    renderer.dispose();
    renderer = buildRenderer(false);
    document.body.prepend(renderer.domElement);
    await renderer.init();
  }
  const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  return { renderer, backend };
}
