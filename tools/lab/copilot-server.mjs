// Copilot server origin lab: starts tools/copilot-server.mjs on a free loopback port (rules only:
// ANTHROPIC_API_KEY is cleared, so nothing is ever sent to Claude) and checks which browser
// origins may call it. Only GET /health and OPTIONS preflights are sent.
//
// Tests:
//   default    the game's origins (127.0.0.1:5199, localhost) are allowed and echoed back; a public
//              site and Origin "null" (sandboxed iframes, data: documents, file:// pages) get 403
//   fileOptIn  with ALLOW_FILE_ORIGIN=1, Origin "null" is allowed; public sites are still refused
//   guide      the rules brain answers the tour-guide phrases with the new actions (nearby, goTo by
//              an id from flightState.nearby, findThermal, chaseStorm, nextDiscovery), every reply
//              passes the game's own validation (Copilot.sanitizeReply), and /health lists them.
//              These send POST /copilot with a rules-only server (no Claude key)
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

/** A flight state with the tour-guide fields the rules read. */
const GUIDE_STATE = Object.freeze({
  heading: 0,
  altitude: 700,
  nearby: [
    { id: 'ropeBridge:1:0', presetId: 'ropeBridge', name: 'Rope bridge', category: 'structure', kind: 'site', distance: 3000, bearing: 90, state: 'discovered', etaSeconds: 75, discovered: true },
    { id: 'tornado:1:2:3', presetId: 'tornado', name: 'Tornado', category: 'weather', kind: 'event', distance: 6000, bearing: 0, state: 'dormant', etaSeconds: 150, discovered: false },
  ],
  activeEvents: [
    { id: 'spawn:supercell:4', presetId: 'supercell', name: 'Supercell', category: 'weather', kind: 'event', distance: 9000, bearing: 315, state: 'active', etaSeconds: 225, discovered: false },
  ],
  weather: { state: 'building', storminess: 0.3 },
  callouts: { enabled: true, offer: null },
});

async function ask(base, transcript) {
  const response = await fetch(`${base}/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flightState: GUIDE_STATE, transcript }) });
  return { status: response.status, body: await response.json() };
}

async function testGuide() {
  const { Copilot } = await import('../../src/copilot/copilot.js');
  const { child, base } = await startServer({});
  try {
    const healthResponse = await fetch(`${base}/health`);
    const healthBody = await healthResponse.json();
    const listed = ['nearby', 'goTo', 'findThermal', 'chaseStorm', 'nextDiscovery'].every((type) => healthBody.actions.includes(type));
    check('guide', '/health lists the tour-guide actions', listed, JSON.stringify(healthBody.actions));
    for (const [transcript, expected] of [
      ["what's nearby", { type: 'nearby' }],
      ['take me to the rope bridge', { type: 'goTo', id: 'ropeBridge:1:0', autopilot: false }],
      ['fly us to the supercell', { type: 'goTo', id: 'spawn:supercell:4', autopilot: true }],
      ['find a thermal', { type: 'findThermal', autopilot: false }],
      ['chase the storm', { type: 'chaseStorm', autopilot: false }],
      ['next discovery', { type: 'nextDiscovery', autopilot: false }],
      ['switch to version one', { type: 'switchVersion', version: 'v1' }],
    ]) {
      const { status, body } = await ask(base, transcript);
      const valid = Copilot.sanitizeReply(body);
      const sorted = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([first], [second]) => first.localeCompare(second))));
      const pass = status === 200 && valid && sorted(valid.action) === sorted(expected);
      check('guide', `"${transcript}" -> ${JSON.stringify(expected)}, valid for the game`, pass, `${status} ${JSON.stringify(body)}`);
    }
    const { body: tornado } = await ask(base, 'take me to the tornado');
    check('guide', 'a dormant candidate is not a goTo target', !(tornado.action && tornado.action.type === 'goTo'), JSON.stringify(tornado));
  } finally {
    await stopServer(child);
  }
}

for (const test of [testDefault, testFileOptIn, testGuide]) {
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
