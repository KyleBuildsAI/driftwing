import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Fixed origin on purpose: saved settings, bindings and HOTAS calibration live in IndexedDB, which
// is scoped to the origin INCLUDING the port. A drifting port would silently "lose" them.
const ORIGIN = { host: '127.0.0.1', port: 5199, strictPort: true };

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    server: ORIGIN,
    preview: ORIGIN,
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single' : 'dist',
      emptyOutDir: true,
      // three.webgpu.js alone is ~2 MB; the game is one app chunk by design.
      chunkSizeWarningLimit: 4096,
    },
    plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  };
});
