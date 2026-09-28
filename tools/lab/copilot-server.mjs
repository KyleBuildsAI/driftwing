// Copilot server origin lab: starts tools/copilot-server.mjs on a free loopback port (rules only:
// ANTHROPIC_API_KEY is cleared, so nothing is ever sent to Claude) and checks which browser
// origins may call it. Only GET /health and OPTIONS preflights are sent.
//
// Tests:
//   default    the game's origins (127.0.0.1:5199, localhost) are allowed and echoed back; a public
//              site and Origin "null" (sandboxed iframes, data: documents, file:// pages) get 403
//   fileOptIn  with ALLOW_FILE_ORIGIN=1, Origin "null" is allowed; public sites are still refused
//
// Usage: node tools/lab/copilot-server.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'copilot-server.mjs');
const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass, detail });
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Starts the server and resolves once it prints its listening line. */
async function startServer(extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ANTHROPIC_API_KEY: '', COPILOT_WARMUP: '0', ALLOW_FILE_ORIGIN: '', ...extraEnv };
  const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error(`server did not start: ${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk;
      if (VERBOSE) process.stdout.write(`  server: ${chunk}`);
      if (output.includes('listening on')) {
        clearTimeout(timer);
        resolveStart();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new Error(`server exited with ${code}: ${output}`));
    });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

function stopServer(child) {
  return new Promise((resolveStop) => {
    child.once('exit', () => resolveStop());
    child.kill();
  });
}

async function health(base, origin) {
  const headers = origin === undefined ? {} : { Origin: origin };
  const response = await fetch(`${base}/health`, { headers });
  await response.arrayBuffer();
  return { status: response.status, allowOrigin: response.headers.get('access-control-allow-origin') };
}

async function preflight(base, origin) {
  const response = await fetch(`${base}/copilot`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  await response.arrayBuffer();
  return { status: response.status, allowOrigin: response.headers.get('access-control-allow-origin') };
}

async function testDefault() {
  const { child, base } = await startServer({});
  try {
    const game = await health(base, 'http://127.0.0.1:5199');
    check('default', 'game origin allowed', game.status === 200 && game.allowOrigin === 'http://127.0.0.1:5199', `${game.status} ${game.allowOrigin}`);
    const local = await preflight(base, 'http://localhost:5199');
    check('default', 'localhost preflight allowed', local.status === 204 && local.allowOrigin === 'http://localhost:5199', `${local.status} ${local.allowOrigin}`);
    const site = await preflight(base, 'https://attacker.example');
    check('default', 'public site refused', site.status === 403 && site.allowOrigin === null, `${site.status}`);
    const sandboxed = await preflight(base, 'null');
    check('default', 'Origin null preflight refused', sandboxed.status === 403 && sandboxed.allowOrigin === null, `${sandboxed.status} ${sandboxed.allowOrigin}`);
    const sandboxedGet = await health(base, 'null');
    check('default', 'Origin null request refused', sandboxedGet.status === 403, `${sandboxedGet.status}`);
    const noOrigin = await health(base, undefined);
    check('default', 'non-browser client (no Origin) allowed', noOrigin.status === 200, `${noOrigin.status}`);
  } finally {
    await stopServer(child);
  }
}

async function testFileOptIn() {
  const { child, base } = await startServer({ ALLOW_FILE_ORIGIN: '1' });
  try {
    const file = await preflight(base, 'null');
    check('fileOptIn', 'Origin null allowed when opted in', file.status === 204 && file.allowOrigin === 'null', `${file.status} ${file.allowOrigin}`);
    const site = await preflight(base, 'https://attacker.example');
    check('fileOptIn', 'public site still refused', site.status === 403, `${site.status}`);
  } finally {
    await stopServer(child);
  }
}

for (const test of [testDefault, testFileOptIn]) {
  try {
    await test();
  } catch (error) {
    check(test.name, 'ran without throwing', false, error.stack ?? String(error));
  }
}

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test} / ${result.name}${result.detail ? ` (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; ${failed.length} FAILED` : ''}\n`);
process.exit(failed.length ? 1 : 0);
