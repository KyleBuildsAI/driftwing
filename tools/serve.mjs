// Minimal zero-dependency static file server for local play and testing.
// Usage: node tools/serve.mjs [port] [rootDir]
//
// A directory URL (/, /v1/, /v2/) serves that directory's index.html, and a directory requested
// without its trailing slash (/v2) is redirected to it, so relative URLs inside the page resolve.
// `npm run serve:single` serves dist-single/: the launcher shell at /, V1 at /v1/, V2 at /v2/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function startStaticServer({ port = 8080, root = process.cwd(), quiet = false } = {}) {
  const rootDir = resolve(root);
  const server = createServer(async (request, response) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch (error) {
      response.writeHead(400).end('Bad request');
      return;
    }
    try {
      const requestedPath = urlPath.replace(/^\/+/, '');
      const relativePath = requestedPath === '' || requestedPath.endsWith('/') ? `${requestedPath}index.html` : requestedPath;
      const filePath = normalize(join(rootDir, relativePath));
      // Only the game's own files: no dotfiles (.git, .env) and no node_modules.
      const isPrivate = relativePath.split(/[\\/]+/).some((segment) => segment.startsWith('.') || segment === 'node_modules');
      if ((!filePath.startsWith(rootDir + sep) && filePath !== rootDir) || isPrivate) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (info && info.isDirectory()) {
        const { pathname, search } = new URL(request.url, 'http://localhost');
        response.writeHead(302, { Location: `${pathname}/${search}` }).end();
        return;
      }
      if (!info || !info.isFile()) {
        if (urlPath === '/favicon.ico') {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      process.stderr.write(`serve: ${request.url} failed: ${error.message}\n`);
      response.writeHead(500).end('Internal error');
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      if (!quiet) process.stdout.write(`DRIFTWING serving ${rootDir} at http://127.0.0.1:${actualPort}/\n`);
      resolvePromise({ server, port: actualPort });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
  const root = process.argv[3] ?? resolve(fileURLToPath(import.meta.url), '..', '..');
  startStaticServer({ port, root }).catch((error) => {
    process.stderr.write(`Failed to start server: ${error.message}\n`);
    process.exit(1);
  });
}
