import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Fixed origin on purpose: saved settings, bindings and HOTAS calibration live in IndexedDB, which
// is scoped to the origin INCLUDING the port. A drifting port would silently "lose" them.
const ORIGIN = { host: '127.0.0.1', port: 5199, strictPort: true };

/**
 * The pages: the launcher shell at / and V2 at /v2/. V1 is not an entry: it is the frozen
 * public/v1/index.html, which Vite serves and copies untouched.
 */
export const PAGES = Object.freeze({
  shell: resolve(ROOT, 'index.html'),
  v2: resolve(ROOT, 'v2/index.html'),
});

/**
 * One three.js core: the bare specifier 'three' (imported by three-mesh-bvh and by three's own
 * addons such as BufferGeometryUtils) resolves to 'three/webgpu', the build the game itself imports.
 * Only the exact specifier is aliased: 'three/webgpu', 'three/tsl' and 'three/addons/...' are left
 * alone. Applies to the dev server, its dependency optimizer, both builds and the workers.
 */
const THREE_ALIAS = Object.freeze([{ find: /^three$/, replacement: 'three/webgpu' }]);

/** Game directories whose bare URL (/v1, /v2) redirects to the directory URL (/v1/, /v2/). */
const GAME_DIRECTORIES = Object.freeze(['v1', 'v2']);

/**
 * Serves /v1/ as /v1/index.html in the dev and preview servers. Vite maps a directory URL to its
 * index.html only for pages under the project root, not for files in public/, and its SPA
 * fallback would otherwise answer /v1/ with the shell itself. Also redirects /v1 and /v2 to their
 * directory URLs so relative URLs inside the games resolve.
 */
function gameDirectories() {
  function route(request, response, next) {
    const url = new URL(request.url, 'http://localhost');
    const directory = GAME_DIRECTORIES.find((name) => url.pathname === `/${name}`);
    if (directory) {
      response.statusCode = 302;
      response.setHeader('Location', `/${directory}/${url.search}`);
      response.end();
      return;
    }
    if (url.pathname === '/v1/') request.url = `/v1/index.html${url.search}`;
    next();
  }
  return {
    name: 'driftwing-game-directories',
    configureServer(server) {
      server.middlewares.use(route);
    },
    configurePreviewServer(server) {
      server.middlewares.use(route);
    },
  };
}

// Modes:
//   (default)  dev server, and `vite build` of both pages into dist/ (public/v1 copied as is).
//   single     one self-contained page per build, used by tools/build-single.mjs, which runs one
//              build per page (vite-plugin-singlefile inlines a single entry) and passes the entry
//              in build.rollupOptions.input.
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    appType: 'mpa',
    resolve: { alias: THREE_ALIAS },
    server: ORIGIN,
    preview: ORIGIN,
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single' : 'dist',
      emptyOutDir: true,
      // three.webgpu.js alone is ~2 MB; the game is one app chunk by design.
      chunkSizeWarningLimit: 4096,
      rollupOptions: single ? {} : { input: PAGES },
    },
    plugins: single ? [gameDirectories(), viteSingleFile({ removeViteModuleLoader: true })] : [gameDirectories()],
  };
});
