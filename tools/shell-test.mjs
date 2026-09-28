// Launcher shell test: the two-game structure under load, in headless Chrome.
//
// For each target (the Vite dev server and the built dist-single/, each started here on a free
// port that is never the player's 5199), with a fresh browser profile:
//   a. Switching: opens /#seed=<hash seed> (V2 by default), then makes ROUND_TRIPS round trips
//      V2 -> V1 -> V2 (V2 -> V1 alternately by the pill and by V2's own F8, versionToggle through
//      the postMessage bridge; V1 -> V2 by the pill, V1's only way). After every switch: exactly
//      one iframe, exactly one live game document in the page (frames and, after a forced GC,
//      Chrome's document counter), the old game unloaded through about:blank first.
//   b. Memory: after the first load of each game and after its last load (the ROUND_TRIPS-th),
//      each read SETTLE_SECONDS after the game reports ready: the JS heap (CDP
//      Performance.getMetrics JSHeapUsedSize after HeapProfiler.collectGarbage), the documents,
//      nodes and listeners (CDP Memory.getDOMCounters), and the GPU process (Chrome's
//      --type=gpu-process child of the launched browser: working set and private bytes from the
//      OS, and on Windows the GPU memory it holds, from the GPU Process Memory counters). The last
//      reading of each game is compared with its first; the tolerances are MEMORY_TOLERANCE.
//   c. Focus: after every switch document.activeElement is the iframe and the iframe's document
//      has focus.
//   d. Hash forwarding: /#seed=<hash seed> reaches V2's seed (window.DRIFTWING.seed).
//   e. Foreign origins: the exact switch request is honoured from V2's own iframe (the control),
//      and ignored when a page on another port posts it, both from inside the shell's iframe and
//      as the top-level page that embeds the shell.
//   f. Console: the shell, V2 and the foreign pages stay free of errors and warnings; V1's console
//      is recorded separately (V1 is judged only against its original behaviour,
//      docs/v1-known-issues.md).
// Prints a PASS / FAIL table and writes report.json (every check, every switch, the memory
// readings) to --out.
//
// Usage:
//   node tools/shell-test.mjs [--target dev,dist] [--url http://127.0.0.1:<port>/]
//     [--backend webgpu|webgl] [--round-trips 20] [--settle-seconds 10] [--out <dir>]
//     [--width 1280] [--height 720] [--headful] [--browser <path>]
//
// --target: dev starts the Vite dev server, dist serves dist-single/ with tools/serve.mjs (build
// it first: npm run build:single). --url tests an already-running shell instead of --target.
// --backend webgl forwards renderer=webgl to both games. Exit code: 0 when every check passed,
// 1 when one failed, 2 when the run itself could not complete.
import puppeteer from 'puppeteer-core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { findBrowser } from './browser.mjs';
import { findFreePort } from './ports.mjs';
import { startStaticServer } from './serve.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = Object.freeze(['dev', 'dist']);
const HASH_SEED = 'ABC';
const READY_TIMEOUT_MS = 120000;
const POLL_MS = 250;
/** How long an ignored message gets to (wrongly) start a switch. */
const IGNORED_MESSAGE_WAIT_MS = 2000;
const CLOSE_TIMEOUT_MS = 30000;
const EXPECTED_BACKEND = Object.freeze({ webgpu: 'WebGPU', webgl: 'WebGL2' });
/** The iframe permissions the shell grants the games; a foreign page embedding the shell passes them on. */
const GAME_PERMISSIONS = 'gamepad; microphone; camera; fullscreen; autoplay; xr-spatial-tracking; encrypted-media; clipboard-write';
/**
 * How far the last reading of a game may rise above its first load, per metric: a relative share
 * of the first reading, or an absolute allowance, whichever is larger. Measured at 1280x720 on
 * both backends (the report lists each game's footprint over a blank tab next to each allowance):
 * one running game adds 13-26 MB of JS heap, 1 document, about 1,700 (V1) or 2,200 (V2) nodes and
 * 90-160 listeners to the page, and 55-160 MB to each GPU-process figure; between two loads of the
 * same game the GPU figures move by up to about 60 MB up and 110 MB down.
 *   - JS heap: 10 % or 8 MB, below one game's heap, so one retained game fails it. The terrain
 *     streams on worker threads (their heaps are not in this reading) and the world around the
 *     craft is never exactly the same SETTLE_SECONDS after load, so a MB either way is normal.
 *   - Documents: none more. After a full GC only the shell and the running game remain; one
 *     unloaded game kept alive adds a document. This is the exact test for a retained game.
 *   - Nodes: 10 % or 400. The games build their HUD and panels from the same markup every load;
 *     toasts and hint strips up at the moment of the reading vary it; a retained game adds 1,600+.
 *   - JS event listeners: 10 % or 60, for the same reason (a retained game adds 90+).
 *   - GPU process working set, private bytes, and (Windows GPU Process Memory counters) dedicated
 *     and shared GPU memory: 15 % or 100 MB. Chrome's GPU process keeps shader and pipeline caches
 *     and pooled staging memory across page loads by design (they speed up the next load and are
 *     trimmed under memory pressure), and the driver pools allocations, so one load can sit about
 *     60 MB above another. A single retained WebGL2 game can hide in that noise (the document and
 *     heap checks catch it); what this allowance catches is GPU memory that grows with every load:
 *     5 MB or more per load over ROUND_TRIPS loads, and any retained WebGPU device (its swap chain,
 *     render targets and terrain buffers).
 */
const MEMORY_TOLERANCE = Object.freeze({
  jsHeapMB: { share: 0.1, absolute: 8 },
  documents: { share: 0, absolute: 0 },
  nodes: { share: 0.1, absolute: 400 },
  jsEventListeners: { share: 0.1, absolute: 60 },
  gpuWorkingSetMB: { share: 0.15, absolute: 100 },
  gpuPrivateMB: { share: 0.15, absolute: 100 },
  gpuDedicatedMB: { share: 0.15, absolute: 100 },
  gpuSharedMB: { share: 0.15, absolute: 100 },
});
/** Foreign test page 1: shown inside the shell's iframe, it posts a well-formed switch request to the shell. */
const FOREIGN_CHILD_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Foreign page</title><link rel="icon" href="data:,"></head>
<body><p>Foreign origin, inside the shell</p>
<script>
  window.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v2' }, '*');
  document.title = 'posted';
</script>
</body></html>
`;

function foreignEmbedPage(shellUrl) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Foreign embedder</title><link rel="icon" href="data:,">
<style>html, body { margin: 0; height: 100%; } iframe { border: 0; width: 100%; height: 100%; display: block; }</style></head>
<body><iframe id="shell" title="DRIFTWING" src="${shellUrl}" allow="${GAME_PERMISSIONS}"></iframe></body></html>
`;
}

function parseArgs(argv) {
  const options = {
    targets: TARGETS.slice(),
    url: null,
    backend: 'webgpu',
    roundTrips: 20,
    settleSeconds: 10,
    out: join(tmpdir(), 'driftwing-shell-test'),
    width: 1280,
    height: 720,
    headful: false,
    browser: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '--target': options.targets = next().split(',').map((entry) => entry.trim()).filter(Boolean); break;
      case '--url': options.url = next(); break;
      case '--backend': options.backend = next(); break;
      case '--round-trips': options.roundTrips = Number(next()); break;
      case '--settle-seconds': options.settleSeconds = Number(next()); break;
      case '--out': options.out = next(); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (options.url) options.targets = ['url'];
  else if (options.targets.length === 0 || options.targets.some((target) => !TARGETS.includes(target))) throw new Error(`--target must list ${TARGETS.join(' and/or ')}`);
  if (!EXPECTED_BACKEND[options.backend]) throw new Error('--backend must be webgpu or webgl');
  if (!(Number.isInteger(options.roundTrips) && options.roundTrips >= 1)) throw new Error('--round-trips must be a whole number of at least 1');
  if (!(options.settleSeconds >= 0)) throw new Error('--settle-seconds must be 0 or more');
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });
const toMB = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / 1048576) * 10) / 10 : null);

// ---- Servers ------------------------------------------------------------------------------------------
/** Starts the target's server on a free port; returns { url, close }. */
async function startTarget(target, url) {
  if (target === 'url') return { url: new URL(url).origin, close: async () => {} };
  const port = await findFreePort();
  if (target === 'dist') {
    const root = join(PROJECT_ROOT, 'dist-single');
    if (!existsSync(join(root, 'index.html')) || !existsSync(join(root, 'v1', 'index.html')) || !existsSync(join(root, 'v2', 'index.html'))) {
      throw new Error('dist-single/ is incomplete: run npm run build:single first');
    }
    const { server } = await startStaticServer({ port, root, quiet: true });
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolveClose) => { server.close(() => resolveClose()); }) };
  }
  // A cache of its own: node_modules may be shared with another checkout's running dev server.
  const cacheDir = join(tmpdir(), `driftwing-shell-test-vite-${createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 10)}`);
  const server = await createViteServer({
    root: PROJECT_ROOT,
    configFile: join(PROJECT_ROOT, 'vite.config.js'),
    cacheDir,
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// ---- GPU process memory ----------------------------------------------------------------------------------
function runPowerShell(script) {
  return new Promise((resolveRun, rejectRun) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`));
      else resolveRun(stdout);
    });
  });
}

function runPs(args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile('ps', args, { timeout: 30000 }, (error, stdout) => {
      if (error) rejectRun(error);
      else resolveRun(stdout);
    });
  });
}

/**
 * The GPU process of the browser with process id browserPid: { pid, workingSetMB, privateMB,
 * dedicatedMB, sharedMB }. dedicatedMB / sharedMB come from the Windows GPU Process Memory
 * counters and are null elsewhere. Throws when the GPU process cannot be found.
 */
async function readGpuProcess(browserPid) {
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$gpu = Get-CimInstance Win32_Process -Filter "ParentProcessId=${browserPid}" | Where-Object { $_.CommandLine -like '*--type=gpu-process*' } | Select-Object -First 1
if (-not $gpu) { throw 'no gpu-process child of browser ${browserPid}' }
$process = Get-Process -Id $gpu.ProcessId
$dedicated = $null
$shared = $null
try {
  $samples = (Get-Counter -Counter "\\GPU Process Memory(pid_$($gpu.ProcessId)_*)\\Dedicated Usage", "\\GPU Process Memory(pid_$($gpu.ProcessId)_*)\\Shared Usage").CounterSamples
  $dedicated = ($samples | Where-Object { $_.Path -like '*dedicated usage' } | Measure-Object -Property CookedValue -Sum).Sum
  $shared = ($samples | Where-Object { $_.Path -like '*shared usage' } | Measure-Object -Property CookedValue -Sum).Sum
} catch {
  $dedicated = "counters unavailable: $($_.Exception.Message)"
}
[pscustomobject]@{ pid = $gpu.ProcessId; workingSet = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64; dedicated = $dedicated; shared = $shared } | ConvertTo-Json -Compress
`;
    const parsed = JSON.parse((await runPowerShell(script)).trim());
    return {
      pid: parsed.pid,
      workingSetMB: toMB(parsed.workingSet),
      privateMB: toMB(parsed.privateBytes),
      dedicatedMB: typeof parsed.dedicated === 'number' ? toMB(parsed.dedicated) : null,
      sharedMB: typeof parsed.shared === 'number' ? toMB(parsed.shared) : null,
      note: typeof parsed.dedicated === 'string' ? parsed.dedicated : null,
    };
  }
  const table = await runPs(['-A', '-o', 'pid=,ppid=,rss=,args=']);
  for (const line of table.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (match && Number(match[2]) === browserPid && match[4].includes('--type=gpu-process')) {
      return { pid: Number(match[1]), workingSetMB: toMB(Number(match[3]) * 1024), privateMB: null, dedicatedMB: null, sharedMB: null, note: 'resident set size from ps; GPU memory counters exist only on Windows' };
    }
  }
  throw new Error(`no gpu-process child of browser ${browserPid}`);
}

// ---- One target ---------------------------------------------------------------------------------------
async function testTarget(target, options) {
  const result = {
    target,
    backend: options.backend,
    url: null,
    checks: [],
    switches: [],
    memory: { readings: {}, comparisons: [] },
    console: { shell: [], v1: [], v2: [], foreign: [] },
    frameNavigations: [],
    problems: [],
    notes: [],
  };
  const check = (name, pass, detail = '') => {
    result.checks.push({ target, name, pass: Boolean(pass), detail });
    process.stdout.write(`[${target}] ${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}\n`);
  };
  const expectedBackend = EXPECTED_BACKEND[options.backend];
  const server = await startTarget(target, options.url);
  const origin = server.url;
  result.url = `${origin}/`;
  process.stdout.write(`[${target}] shell at ${result.url}\n`);
  const shellUrl = (query = '', hash = '') => {
    const params = new URLSearchParams(query);
    if (options.backend === 'webgl') params.set('renderer', 'webgl');
    const search = params.toString();
    return `${origin}/${search ? `?${search}` : ''}${hash}`;
  };

  const foreignPort = await findFreePort();
  const foreignRoot = join(tmpdir(), `driftwing-shell-test-foreign-${process.pid}-${target}`);
  mkdirSync(foreignRoot, { recursive: true });
  writeFileSync(join(foreignRoot, 'index.html'), FOREIGN_CHILD_PAGE);
  writeFileSync(join(foreignRoot, 'embed.html'), foreignEmbedPage(shellUrl('v=2', `#seed=${HASH_SEED}`)));
  const foreign = await startStaticServer({ port: foreignPort, root: foreignRoot, quiet: true });
  const foreignOrigin = `http://127.0.0.1:${foreignPort}`;

  const profileDir = join(tmpdir(), `driftwing-shell-test-profile-${process.pid}-${target}`);
  const browser = await puppeteer.launch({
    executablePath: findBrowser(options.browser),
    headless: !options.headful,
    userDataDir: profileDir,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--enable-precise-memory-info', `--window-size=${options.width},${options.height}`],
    defaultViewport: { width: options.width, height: options.height },
  });
  const browserPid = browser.process()?.pid ?? null;

  /**
   * Books console output by where it came from: the shell's own page and module, else whatever
   * the shell's iframe shows at that moment, so a game's library messages count for that game.
   */
  function watch(page) {
    let frameContext = 'shell';
    const isShellSource = (source) => {
      if (!source) return true;
      const url = new URL(source, origin);
      if (url.origin !== origin) return false;
      return url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/src/shell/');
    };
    page.on('console', (message) => {
      const source = message.location()?.url ?? '';
      const bucket = source.startsWith(foreignOrigin) ? 'foreign' : isShellSource(source) ? 'shell' : frameContext;
      result.console[bucket].push({ type: message.type(), text: message.text(), source });
    });
    page.on('pageerror', (error) => result.console[frameContext].push({ type: 'pageerror', text: `${error.message}\n${error.stack ?? ''}`, source: '' }));
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? '';
      // A switch cuts off the old game's requests on purpose.
      if (failure === 'net::ERR_ABORTED') return;
      result.console[frameContext].push({ type: 'requestfailed', text: `${request.url()} ${failure}`, source: request.url() });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) return;
      const url = frame.url();
      result.frameNavigations.push(url);
      if (url === 'about:blank') frameContext = 'shell';
      else if (url.startsWith(`${origin}/v1/`)) frameContext = 'v1';
      else if (url.startsWith(`${origin}/v2/`)) frameContext = 'v2';
      else if (url.startsWith(foreignOrigin)) frameContext = 'foreign';
    });
  }

  const shellState = (frame) => frame.evaluate(() => {
    const shell = window.DRIFTWING_SHELL;
    const iframe = document.getElementById('dw-shell-frame');
    const sameOrigin = Boolean(iframe.contentDocument);
    return {
      version: shell.version,
      busy: shell.busy,
      switches: shell.switches,
      ready: Boolean(shell.game?.ready),
      backend: shell.game?.backend ?? null,
      seed: shell.game?.seed ?? null,
      iframes: document.querySelectorAll('iframe').length,
      frameUrl: sameOrigin ? iframe.contentWindow.location.href : null,
      iframeIsActive: document.activeElement === iframe,
      iframeDocumentHasFocus: sameOrigin ? iframe.contentDocument.hasFocus() : false,
    };
  });

  async function waitForGame(frame, version) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let state = null;
    while (Date.now() < deadline) {
      state = await shellState(frame).catch((error) => ({ error: error.message }));
      if (state.version === version && !state.busy && state.ready) return state;
      await sleep(POLL_MS);
    }
    return state;
  }

  /** Reads every memory metric after a full GC (twice: finalizers can free more on the second pass). */
  async function readMemory(cdp) {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const metric = (name) => metrics.find((entry) => entry.name === name)?.value ?? null;
    const counters = await cdp.send('Memory.getDOMCounters');
    let gpu = null;
    try {
      gpu = browserPid ? await readGpuProcess(browserPid) : null;
    } catch (error) {
      result.problems.push(`GPU process memory unreadable: ${error.message}`);
    }
    return {
      jsHeapMB: toMB(metric('JSHeapUsedSize')),
      documents: counters.documents,
      nodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
      gpuWorkingSetMB: gpu?.workingSetMB ?? null,
      gpuPrivateMB: gpu?.privateMB ?? null,
      gpuDedicatedMB: gpu?.dedicatedMB ?? null,
      gpuSharedMB: gpu?.sharedMB ?? null,
      gpuPid: gpu?.pid ?? null,
      gpuNote: gpu?.note ?? null,
    };
  }

  /** Counts the game documents the page holds: frames showing /v1/ or /v2/. */
  const liveGameFrames = (page) => page.frames().filter((frame) => /^\/v[12]\//.test(new URL(frame.url(), origin).pathname) && frame.url().startsWith(origin));

  async function measure(page, cdp, label) {
    await sleep(options.settleSeconds * 1000);
    const reading = await readMemory(cdp);
    result.memory.readings[label] = reading;
    process.stdout.write(`[${target}] memory ${label}: heap ${reading.jsHeapMB} MB, documents ${reading.documents}, nodes ${reading.nodes}, listeners ${reading.jsEventListeners}, GPU process working set ${reading.gpuWorkingSetMB} MB, private ${reading.gpuPrivateMB} MB, GPU dedicated ${reading.gpuDedicatedMB} MB, shared ${reading.gpuSharedMB} MB\n`);
    return reading;
  }

  async function clickPill(page, version) {
    await page.mouse.move(options.width / 2, options.height / 2);
    await page.mouse.move(3, 3, { steps: 4 });
    await sleep(350);
    await page.click(`#dw-shell-pill button[data-version="${version}"]`);
  }

  /** Every switch: one iframe, one live game document, through about:blank, focused, backend. */
  async function verifySwitch(page, cdp, version, label, navigationsBefore, firstDocuments) {
    const started = Date.now();
    const state = await waitForGame(page.mainFrame(), version);
    const readyMs = Date.now() - started;
    const gameFrames = liveGameFrames(page);
    const childFrames = page.mainFrame().childFrames();
    const navigations = result.frameNavigations.slice(navigationsBefore);
    const blankIndex = navigations.indexOf('about:blank');
    const gameIndex = navigations.findIndex((url, index) => index > blankIndex && url.startsWith(`${origin}/${version}/`));
    await cdp.send('HeapProfiler.collectGarbage');
    const { documents } = await cdp.send('Memory.getDOMCounters');
    const entry = {
      label,
      version,
      ready: Boolean(state.ready) && state.version === version,
      readyMs,
      iframes: state.iframes,
      childFrames: childFrames.map((frame) => frame.url()),
      liveGameDocuments: gameFrames.length,
      liveGameUrl: gameFrames[0]?.url() ?? null,
      throughBlank: blankIndex >= 0 && gameIndex > blankIndex,
      documents,
      focus: state.iframeIsActive && state.iframeDocumentHasFocus,
      iframeIsActive: state.iframeIsActive,
      iframeDocumentHasFocus: state.iframeDocumentHasFocus,
      backend: state.backend,
    };
    const expectedDocuments = firstDocuments[version];
    entry.oneGame = entry.ready && entry.iframes === 1 && childFrames.length === 1 && entry.liveGameDocuments === 1
      && new URL(entry.liveGameUrl).pathname === `/${version}/` && entry.throughBlank
      && (expectedDocuments === undefined || documents <= expectedDocuments);
    entry.backendOk = state.backend === expectedBackend;
    if (expectedDocuments === undefined) firstDocuments[version] = documents;
    result.switches.push(entry);
    process.stdout.write(`[${target}] ${label}: ${version} ready in ${(readyMs / 1000).toFixed(1)} s, iframes ${entry.iframes}, live game documents ${entry.liveGameDocuments}, documents ${documents}, through about:blank ${entry.throughBlank}, focus ${entry.focus}, ${state.backend}\n`);
    return entry;
  }

  try {
    // ---- d + first loads ------------------------------------------------------------------------------
    const page = await browser.newPage();
    watch(page);
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    // The browser with no game (a blank tab): what one game adds on top of it is its footprint.
    const idle = await readMemory(cdp);
    result.memory.readings['no game'] = idle;
    process.stdout.write(`[${target}] memory no game (blank tab): heap ${idle.jsHeapMB} MB, documents ${idle.documents}, nodes ${idle.nodes}, GPU process working set ${idle.gpuWorkingSetMB} MB, private ${idle.gpuPrivateMB} MB, GPU dedicated ${idle.gpuDedicatedMB} MB, shared ${idle.gpuSharedMB} MB\n`);
    await page.goto(shellUrl('', `#seed=${HASH_SEED}`), { waitUntil: 'load', timeout: 60000 });
    const firstDocuments = {};
    const first = await verifySwitch(page, cdp, 'v2', 'first load', 0, firstDocuments);
    const firstState = await shellState(page.mainFrame());
    check(`d. /#seed=${HASH_SEED} reaches V2's seed`, firstState.seed === HASH_SEED && new URL(firstState.frameUrl).hash === `#seed=${HASH_SEED}`, { seed: firstState.seed, frameUrl: firstState.frameUrl });
    check('first load: V2 ready, one iframe, one game document', first.ready && first.iframes === 1 && first.liveGameDocuments === 1, first);
    check('first load: focus is in the game', first.focus, { iframeIsActive: first.iframeIsActive, iframeDocumentHasFocus: first.iframeDocumentHasFocus });
    check(`first load: backend ${expectedBackend}`, first.backendOk, first.backend);
    await measure(page, cdp, 'v2 first load');

    // ---- a + b + c: the round trips -----------------------------------------------------------------
    for (let trip = 1; trip <= options.roundTrips; trip++) {
      let before = result.frameNavigations.length;
      const byF8 = trip % 2 === 0;
      if (byF8) await page.keyboard.press('F8');
      else await clickPill(page, 'v1');
      await verifySwitch(page, cdp, 'v1', `trip ${trip} V2 -> V1 (${byF8 ? 'F8 in V2' : 'pill'})`, before, firstDocuments);
      if (trip === 1) await measure(page, cdp, 'v1 first load');
      if (trip === options.roundTrips) await measure(page, cdp, `v1 load ${trip}`);
      before = result.frameNavigations.length;
      await clickPill(page, 'v2');
      await verifySwitch(page, cdp, 'v2', `trip ${trip} V1 -> V2 (pill)`, before, firstDocuments);
      if (trip === options.roundTrips) await measure(page, cdp, `v2 load ${trip + 1}`);
    }
    const switched = result.switches.slice(1);
    const oneGameFailures = switched.filter((entry) => !entry.oneGame);
    check(`a. ${switched.length} switches (${options.roundTrips} round trips): one iframe holding one live game document after each, the old one through about:blank`, switched.length === options.roundTrips * 2 && oneGameFailures.length === 0, oneGameFailures.length === 0 ? `${switched.length} switches` : oneGameFailures.map((entry) => entry.label));
    const focusFailures = switched.filter((entry) => !entry.focus);
    check('c. focus lands in the game after every switch (activeElement is the iframe, its document has focus)', focusFailures.length === 0, focusFailures.length === 0 ? `${switched.length} switches` : focusFailures.map((entry) => entry.label));
    const backendFailures = switched.filter((entry) => !entry.backendOk);
    check(`every switch runs ${expectedBackend}`, backendFailures.length === 0, backendFailures.length === 0 ? '' : backendFailures.map((entry) => `${entry.label}: ${entry.backend}`));

    // ---- b: memory comparison ---------------------------------------------------------------------------
    const pairs = [['v2', 'v2 first load', `v2 load ${options.roundTrips + 1}`], ['v1', 'v1 first load', `v1 load ${options.roundTrips}`]];
    for (const [game, firstLabel, lastLabel] of pairs) {
      const firstReading = result.memory.readings[firstLabel];
      const lastReading = result.memory.readings[lastLabel];
      for (const [metric, tolerance] of Object.entries(MEMORY_TOLERANCE)) {
        const base = firstReading[metric];
        const last = lastReading[metric];
        if (!Number.isFinite(base) || !Number.isFinite(last)) {
          result.memory.comparisons.push({ game, metric, first: base, last, delta: null, allowed: null, pass: null, note: 'not measured on this platform' });
          continue;
        }
        const allowed = Math.max(base * tolerance.share, tolerance.absolute);
        const delta = Math.round((last - base) * 10) / 10;
        // What one running copy of the game holds above a blank tab: a retained game would add about this much.
        const idleValue = result.memory.readings['no game'][metric];
        const footprint = Number.isFinite(idleValue) ? Math.round((base - idleValue) * 10) / 10 : null;
        result.memory.comparisons.push({ game, metric, first: base, last, delta, allowed: Math.round(allowed * 10) / 10, footprint, pass: delta <= allowed });
      }
    }
    const measured = result.memory.comparisons.filter((entry) => entry.pass !== null);
    const memoryFailures = measured.filter((entry) => !entry.pass);
    const gpuMeasured = measured.some((entry) => entry.metric.startsWith('gpu'));
    check(`b. memory after ${options.roundTrips} round trips within tolerance of each game's first load (JS heap, documents, nodes, listeners${gpuMeasured ? ', GPU process' : ''})`, memoryFailures.length === 0 && measured.length > 0 && gpuMeasured,
      memoryFailures.length === 0 ? measured.map((entry) => `${entry.game} ${entry.metric} ${entry.first} -> ${entry.last}`).join('; ') : memoryFailures.map((entry) => `${entry.game} ${entry.metric} +${entry.delta} > ${entry.allowed}`));

    // ---- e: messages ---------------------------------------------------------------------------------------
    const controlBefore = result.frameNavigations.length;
    const controlSwitches = (await shellState(page.mainFrame())).switches;
    await page.evaluate(() => {
      const frame = document.getElementById('dw-shell-frame');
      frame.contentWindow.eval("window.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, window.location.origin)");
    });
    const control = await verifySwitch(page, cdp, 'v1', 'control: exact request from V2\'s iframe', controlBefore, firstDocuments);
    const afterControl = await shellState(page.mainFrame());
    check('e. control: the exact request from V2\'s own iframe switches', control.ready && afterControl.switches === controlSwitches + 1, { switches: afterControl.switches });

    const inFrameSwitches = afterControl.switches;
    await page.evaluate((url) => new Promise((resolveLoad) => {
      const frame = document.getElementById('dw-shell-frame');
      frame.addEventListener('load', resolveLoad, { once: true });
      frame.src = url;
    }), `${foreignOrigin}/`);
    const posted = page.frames().find((frame) => frame.url().startsWith(foreignOrigin));
    const postedTitle = posted ? await posted.title() : null;
    await sleep(IGNORED_MESSAGE_WAIT_MS);
    const afterInFrame = await shellState(page.mainFrame());
    check('e. a page on another port inside the shell\'s iframe posts the switch request: ignored', postedTitle === 'posted' && afterInFrame.version === 'v1' && !afterInFrame.busy && afterInFrame.switches === inFrameSwitches,
      { postedTitle, version: afterInFrame.version, busy: afterInFrame.busy, switches: afterInFrame.switches });
    await page.close();

    const embedder = await browser.newPage();
    watch(embedder);
    await embedder.goto(`${foreignOrigin}/embed.html`, { waitUntil: 'load', timeout: 60000 });
    let shellFrame = null;
    const deadline = Date.now() + 30000;
    while (!shellFrame && Date.now() < deadline) {
      shellFrame = embedder.frames().find((frame) => frame.url().startsWith(origin) && new URL(frame.url()).pathname === '/');
      if (!shellFrame) await sleep(POLL_MS);
    }
    const embedded = shellFrame ? await waitForGame(shellFrame, 'v2') : null;
    await embedder.evaluate(() => {
      document.getElementById('shell').contentWindow.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, '*');
    });
    await sleep(IGNORED_MESSAGE_WAIT_MS);
    const afterEmbed = shellFrame ? await shellState(shellFrame) : null;
    check('e. a page on another port that embeds the shell posts the switch request: ignored', Boolean(embedded?.ready) && afterEmbed?.version === 'v2' && !afterEmbed.busy && afterEmbed.switches === 0,
      afterEmbed ? { version: afterEmbed.version, busy: afterEmbed.busy, switches: afterEmbed.switches } : 'the embedded shell never started');
    await embedder.close();
  } catch (error) {
    result.problems.push(`run failed: ${error.stack ?? error.message}`);
    check('the test ran to the end', false, error.message);
  } finally {
    const closed = await Promise.race([
      browser.close().then(() => true, (error) => {
        result.problems.push(`browser close failed: ${error.message}`);
        return false;
      }),
      sleep(CLOSE_TIMEOUT_MS).then(() => false),
    ]);
    if (!closed && browser.process() && browser.process().exitCode === null) browser.process().kill('SIGKILL');
    await new Promise((resolveClose) => { foreign.server.close(() => resolveClose()); });
    await server.close().catch((error) => result.problems.push(`server close failed: ${error.message}`));
    await sleep(3000);
    for (const directory of [profileDir, foreignRoot]) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (error) {
        // Chrome can hold its profile files for a moment after closing; leftovers are housekeeping.
        result.notes.push(`could not remove temporary directory ${directory}: ${error.message}`);
      }
    }
  }

  // ---- f: console ------------------------------------------------------------------------------------
  const noisy = (entries) => entries.filter((entry) => ['error', 'assert', 'warn', 'warning', 'pageerror', 'requestfailed'].includes(entry.type));
  check('f. shell console: no errors or warnings', noisy(result.console.shell).length === 0, noisy(result.console.shell));
  check('f. V2 console: no errors or warnings', noisy(result.console.v2).length === 0, noisy(result.console.v2));
  check('f. foreign pages\' console: no errors or warnings', noisy(result.console.foreign).length === 0, noisy(result.console.foreign));
  result.v1ConsoleNoise = noisy(result.console.v1);
  check('f. V1 console as in docs/v1-known-issues.md (no errors or warnings under normal conditions)', result.v1ConsoleNoise.length === 0, result.v1ConsoleNoise);
  return result;
}

function printTable(results) {
  const rows = results.flatMap((entry) => entry.checks);
  const width = Math.min(118, Math.max(...rows.map((row) => row.name.length)));
  process.stdout.write(`\n${'target'.padEnd(7)} ${'result'.padEnd(6)} check\n${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(width)}\n`);
  for (const row of rows) process.stdout.write(`${row.target.padEnd(7)} ${(row.pass ? 'PASS' : 'FAIL').padEnd(6)} ${row.name}\n`);
  for (const entry of results) {
    process.stdout.write(`\nmemory, ${entry.target} (${entry.backend}): metric, first load -> last load, change (allowed; one game over a blank tab)\n`);
    for (const comparison of entry.memory.comparisons) {
      const change = comparison.delta === null ? 'n/a' : `${comparison.delta >= 0 ? '+' : ''}${comparison.delta}`;
      process.stdout.write(`  ${comparison.game}  ${comparison.metric.padEnd(17)} ${String(comparison.first).padStart(8)} -> ${String(comparison.last).padStart(8)}  ${change} (${comparison.allowed ?? comparison.note}; ${comparison.footprint ?? 'n/a'})  ${comparison.pass === null ? '' : comparison.pass ? 'PASS' : 'FAIL'}\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const results = [];
  for (const target of options.targets) results.push(await testTarget(target, options));
  const report = {
    kind: 'driftwing-shell-test',
    date: new Date().toISOString(),
    backend: options.backend,
    roundTrips: options.roundTrips,
    settleSeconds: options.settleSeconds,
    memoryTolerance: MEMORY_TOLERANCE,
    results,
    passed: results.every((entry) => entry.checks.every((row) => row.pass)),
  };
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  printTable(results);
  const total = results.reduce((sum, entry) => sum + entry.checks.length, 0);
  const failed = results.reduce((sum, entry) => sum + entry.checks.filter((row) => !row.pass).length, 0);
  for (const entry of results) {
    for (const problem of entry.problems) process.stdout.write(`[${entry.target}] problem: ${problem}\n`);
    for (const note of entry.notes) process.stdout.write(`[${entry.target}] note: ${note}\n`);
  }
  process.stdout.write(`\nshell-test: ${report.passed ? 'PASS' : 'FAIL'}, ${total - failed}/${total} checks passed; report ${join(options.out, 'report.json')}\n`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`shell-test failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
