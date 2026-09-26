// Minimal zero-dependency static file server for local play and testing.
// Usage: node tools/serve.mjs [port] [rootDir]
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
    try {
      const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = normalize(join(rootDir, relativePath));
      if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(filePath).catch(() => null);
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
      response.writeHead(500).end(String(error));
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      if (!quiet) process.stdout.write(`DRIFTWING serving ${rootDir} at http://localhost:${actualPort}/\n`);
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
