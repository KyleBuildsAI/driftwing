// Launcher shell check: drives the shell (/) of a running server in headless Chrome and verifies
// the two-game structure end to end.
//
//   1. First launch opens V2, writes ?v=2 into the shell URL, runs one iframe and focuses the game.
//   2. The pill appears from the top-left hot strip, hides after about 3 s, and never covers the
//      running game's visible HUD (checked against every visible element of the game's UI).
//   3. Switching V2 -> V1 -> V2 with the pill, then V2 -> V1 with V2's own F8 (versionToggle, the
//      postMessage bridge) and back: each switch passes through about:blank, ends with exactly one
//      iframe, the new game ready and focused, and remembers the version (lastVersion, ?v=).
//   4. Persistence: a new tab on / opens the remembered version; /?v=1 overrides and is remembered.
//   5. Forwarding: /?v=2&renderer=webgl#seed=SHELLHASH reaches V2 (the seed from the hash, the
//      WebGL2 backend); a later hash change reloads V2 with the new seed.
//   6. Messages: a switch request from a page on another origin inside the shell's iframe, a
//      same-origin request of the wrong shape, and one posted by the shell window itself are all
//      ignored; the exact request from V2 switches.
//   7. The console of the shell and V2 stays free of errors and warnings; V1's messages are
//      recorded separately (V1 is judged only against its original behaviour).
//
// Usage:
//   node tools/shell-check.mjs --url http://127.0.0.1:<port>/ [--backend webgpu|webgl]
//     [--cycles N] [--out <dir>] [--width 1280] [--height 720] [--headful] [--browser <path>]
//
// --url is the shell of an already-running server: the Vite dev server (npm run dev -- --port
// <port> --strictPort) or tools/serve.mjs on dist-single/. --backend webgl forwards
// renderer=webgl to both games. --cycles repeats the pill switch V2 -> V1 -> V2 (default 1).
// Writes report.json and screenshots to --out; exits 0 when every check passed, 1 otherwise,
// 2 when the run itself failed.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from './browser.mjs';
import { startStaticServer } from './serve.mjs';

const READY_TIMEOUT_MS = 120000;
const POLL_MS = 250;
/** The pill hides after 3 s without activity; checked a little later. */
const PILL_HIDE_WAIT_MS = 3800;
/** How long an ignored message gets to (wrongly) start a switch. */
const IGNORED_MESSAGE_WAIT_MS = 1500;
/** The foreign test page: posts a well-formed switch request to the shell from another origin. */
const FOREIGN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Foreign page</title></head>
<body><p>Foreign origin</p>
<script>
  window.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, '*');
  document.title = 'posted';
</script>
</body></html>
`;

function parseArgs(argv) {
  const options = { url: null, backend: 'webgpu', cycles: 1, out: join(tmpdir(), 'driftwing-shell-check'), width: 1280, height: 720, headful: false, browser: null };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '--url': options.url = next(); break;
      case '--backend': options.backend = next(); break;
      case '--cycles': options.cycles = Number(next()); break;
      case '--out': options.out = next(); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!options.url) throw new Error('--url is required (the shell of a running server)');
  if (options.backend !== 'webgpu' && options.backend !== 'webgl') throw new Error('--backend must be webgpu or webgl');
  if (!(Number.isInteger(options.cycles) && options.cycles >= 1)) throw new Error('--cycles must be a whole number of at least 1');
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const shellOrigin = new URL(options.url).origin;
  const backendQuery = options.backend === 'webgl' ? 'renderer=webgl' : '';
  const expectedBackend = options.backend === 'webgl' ? 'WebGL2' : 'WebGPU';
  const shellUrl = (query = '', hash = '') => {
    const params = new URLSearchParams(query);
    if (backendQuery) params.set('renderer', 'webgl');
    const search = params.toString();
    return `${shellOrigin}/${search ? `?${search}` : ''}${hash}`;
  };

  const foreignRoot = join(tmpdir(), `driftwing-foreign-${process.pid}`);
  mkdirSync(foreignRoot, { recursive: true });
  writeFileSync(join(foreignRoot, 'index.html'), FOREIGN_PAGE);
  const foreign = await startStaticServer({ port: 0, root: foreignRoot, quiet: true });
  const foreignUrl = `http://127.0.0.1:${foreign.port}/`;

  const profileDir = join(tmpdir(), `driftwing-shell-profile-${process.pid}`);
  const browser = await puppeteer.launch({
    executablePath: findBrowser(options.browser),
    headless: !options.headful,
    userDataDir: profileDir,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', `--window-size=${options.width},${options.height}`],
    defaultViewport: { width: options.width, height: options.height },
  });

  const report = { url: options.url, backend: options.backend, checks: [], console: { shell: [], v1: [], v2: [], other: [] }, frameNavigations: [], screenshots: [], passed: false };
  const check = (name, pass, detail = '') => {
    report.checks.push({ name, pass: Boolean(pass), detail });
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}\n`);
  };

  /**
   * Records console output by where it came from: the shell's own page and module, else whatever
   * the iframe shows at that moment (V1, V2 or the foreign page), so a game's library messages
   * (V1's CDN three.js, V2's modules) count for that game.
   */
  function watch(page) {
    let frameContext = 'shell';
    const isShellSource = (source) => {
      if (!source) return true;
      const url = new URL(source, shellOrigin);
      if (url.origin !== shellOrigin) return false;
      return url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/src/shell/') || url.pathname.startsWith('/assets/shell-');
    };
    page.on('console', (message) => {
      const source = message.location()?.url ?? '';
      const entry = { type: message.type(), text: message.text(), source };
      report.console[isShellSource(source) ? 'shell' : frameContext].push(entry);
    });
    page.on('pageerror', (error) => report.console.shell.push({ type: 'pageerror', text: `${error.message}\n${error.stack ?? ''}`, source: '' }));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) return;
      const url = frame.url();
      report.frameNavigations.push(url);
      if (url === 'about:blank') frameContext = 'shell';
      else if (url.startsWith(`${shellOrigin}/v1/`)) frameContext = 'v1';
      else if (url.startsWith(`${shellOrigin}/v2/`)) frameContext = 'v2';
      else frameContext = 'other';
    });
  }

  const shellState = (page) => page.evaluate(() => {
    const shell = window.DRIFTWING_SHELL;
    const frame = document.getElementById('dw-shell-frame');
    let frameUrl = null;
    let gameFocused = false;
    if (frame.contentDocument) {
      frameUrl = frame.contentWindow.location.href;
      gameFocused = document.activeElement === frame && frame.contentDocument.hasFocus();
    }
    let lastVersion = null;
    try {
      lastVersion = window.localStorage.getItem('driftwing.shell.lastVersion');
    } catch (error) {
      lastVersion = `unreadable: ${error.message}`;
    }
    return {
      version: shell.version,
      busy: shell.busy,
      switches: shell.switches,
      pillVisible: shell.pillVisible,
      ready: Boolean(shell.game?.ready),
      backend: shell.game?.backend ?? null,
      seed: shell.game?.seed ?? null,
      iframes: document.querySelectorAll('iframe').length,
      shellUrl: window.location.href,
      frameUrl,
      gameFocused,
      lastVersion,
      embeddedClass: frame.contentDocument?.documentElement.classList.contains('dw-embedded') ?? null,
    };
  });

  async function waitForGame(page, version) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let state = null;
    while (Date.now() < deadline) {
      state = await shellState(page).catch((error) => ({ error: error.message }));
      if (state.version === version && !state.busy && state.ready) return state;
      await sleep(POLL_MS);
    }
    return state;
  }

  /**
   * Visible elements of the game's UI under the pill: each element's box clipped by its
   * overflow-clipping ancestors (the compass tape runs far past its window), hidden and fully
   * transparent ones skipped, containers bigger than a quarter of the screen excluded.
   */
  const pillOverlaps = (page) => page.evaluate(() => {
    const pill = document.getElementById('dw-shell-pill').getBoundingClientRect();
    const gameDocument = document.getElementById('dw-shell-frame').contentDocument;
    const gameWindow = gameDocument.defaultView;
    const screenArea = window.innerWidth * window.innerHeight;
    const clippedBox = (element) => {
      const rect = element.getBoundingClientRect();
      let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let parent = element.parentElement; parent && box; parent = parent.parentElement) {
        if (gameWindow.getComputedStyle(parent).overflow === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        box = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
        if (box.right <= box.left || box.bottom <= box.top) box = null;
      }
      return box;
    };
    const hits = [];
    for (const element of gameDocument.querySelectorAll('#ui-root *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.width * rect.height > screenArea / 4) continue;
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = clippedBox(element);
      if (!box || box.right <= pill.left || box.left >= pill.right || box.bottom <= pill.top || box.top >= pill.bottom) continue;
      hits.push(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${[...element.classList].join('.')}`);
    }
    return { pill: { left: Math.round(pill.left), top: Math.round(pill.top), width: Math.round(pill.width) }, hits };
  });

  async function shot(page, name) {
    const path = join(options.out, `${name}.png`);
    await page.screenshot({ path });
    report.screenshots.push(path);
  }

  async function pillRoundTrip(page, label) {
    await page.mouse.move(options.width / 2, options.height / 2);
    await page.mouse.move(3, 3, { steps: 6 });
    await sleep(400);
    const shown = await shellState(page);
    check(`${label}: pill appears from the top-left hot strip`, shown.pillVisible);
    const overlap = await pillOverlaps(page);
    check(`${label}: pill clear of the game's visible HUD`, overlap.hits.length === 0, overlap);
    await shot(page, `${label}-pill-visible`);
    await page.mouse.move(options.width / 2, options.height / 2, { steps: 6 });
    await sleep(PILL_HIDE_WAIT_MS);
    const hidden = await shellState(page);
    check(`${label}: pill hides after about 3 s`, !hidden.pillVisible);
    await shot(page, `${label}-pill-hidden`);
  }

  async function clickPill(page, version) {
    await page.mouse.move(3, 3, { steps: 4 });
    await sleep(350);
    await page.click(`#dw-shell-pill button[data-version="${version}"]`);
  }

  /** Checks the state after a switch to version, and that the frame passed through about:blank. */
  async function expectSwitched(page, version, label, navigationsBefore) {
    const state = await waitForGame(page, version);
    const path = state.frameUrl ? new URL(state.frameUrl).pathname : null;
    const navigations = report.frameNavigations.slice(navigationsBefore);
    const blankIndex = navigations.indexOf('about:blank');
    const gameIndex = navigations.findIndex((url, index) => index > blankIndex && url.startsWith(`${shellOrigin}/${version}/`));
    check(`${label}: ${version} ready`, state.ready && state.version === version && path === `/${version}/`, { version: state.version, frameUrl: state.frameUrl });
    check(`${label}: exactly one iframe`, state.iframes === 1, state.iframes);
    check(`${label}: old game unloaded through about:blank first`, blankIndex >= 0 && gameIndex > blankIndex, navigations);
    check(`${label}: focus is inside the game`, state.gameFocused);
    check(`${label}: remembered (lastVersion and ?v=)`, state.lastVersion === version && new URL(state.shellUrl).searchParams.get('v') === version.slice(1), { lastVersion: state.lastVersion, shellUrl: state.shellUrl });
    check(`${label}: backend ${expectedBackend}`, state.backend === expectedBackend, state.backend);
    return state;
  }

  try {
    // ---- 1-3: first launch, pill, switches -----------------------------------------------------
    const page = await browser.newPage();
    watch(page);
    await page.goto(shellUrl(), { waitUntil: 'load', timeout: 60000 });
    const first = await waitForGame(page, 'v2');
    check('first launch opens V2', first.version === 'v2' && first.ready && new URL(first.frameUrl).pathname === '/v2/', first);
    check('first launch writes ?v=2 and remembers v2', new URL(first.shellUrl).searchParams.get('v') === '2' && first.lastVersion === 'v2', first.shellUrl);
    check('first launch: one iframe', first.iframes === 1, first.iframes);
    check('first launch: V2 knows it is embedded', first.embeddedClass === true);
    check('first launch: focus is inside the game', first.gameFocused);
    check(`first launch: backend ${expectedBackend}`, first.backend === expectedBackend, first.backend);
    await pillRoundTrip(page, 'v2');

    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      let before = report.frameNavigations.length;
      await clickPill(page, 'v1');
      await expectSwitched(page, 'v1', `cycle ${cycle} pill V2 -> V1`, before);
      if (cycle === 1) await pillRoundTrip(page, 'v1');
      before = report.frameNavigations.length;
      await clickPill(page, 'v2');
      await expectSwitched(page, 'v2', `cycle ${cycle} pill V1 -> V2`, before);
    }
    const switchesBefore = (await shellState(page)).switches;
    let before = report.frameNavigations.length;
    await page.keyboard.press('F8');
    await expectSwitched(page, 'v1', 'F8 in V2 (versionToggle) -> V1', before);
    before = report.frameNavigations.length;
    await clickPill(page, 'v2');
    const afterF8 = await expectSwitched(page, 'v2', 'pill V1 -> V2 after F8', before);
    check('switch counter counted every switch', afterF8.switches === switchesBefore + 2, afterF8.switches);

    // ---- 6: messages -------------------------------------------------------------------------------
    await page.evaluate(() => {
      const frame = document.getElementById('dw-shell-frame');
      frame.contentWindow.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1', extra: true }, window.location.origin);
      frame.contentWindow.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v3' }, window.location.origin);
      frame.contentWindow.parent.postMessage('switch-version', window.location.origin);
      window.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, window.location.origin);
    });
    await sleep(IGNORED_MESSAGE_WAIT_MS);
    const afterBad = await shellState(page);
    check('wrong-shape and non-iframe messages ignored', afterBad.version === 'v2' && !afterBad.busy && afterBad.switches === afterF8.switches, afterBad);
    before = report.frameNavigations.length;
    await page.evaluate(() => {
      const frame = document.getElementById('dw-shell-frame');
      frame.contentWindow.eval("window.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, window.location.origin)");
    });
    await expectSwitched(page, 'v1', 'exact request from the game iframe', before);

    // A page from another origin inside the shell's iframe posts a well-formed request: ignored.
    const foreignSwitches = (await shellState(page)).switches;
    await page.evaluate((url) => new Promise((resolve) => {
      const frame = document.getElementById('dw-shell-frame');
      frame.addEventListener('load', resolve, { once: true });
      frame.src = url;
    }), foreignUrl);
    const posted = page.frames().find((frame) => frame.url().startsWith(foreignUrl));
    const foreignTitle = posted ? await posted.title() : null;
    await sleep(IGNORED_MESSAGE_WAIT_MS);
    const afterForeign = await shellState(page);
    check('foreign-origin request ignored', foreignTitle === 'posted' && afterForeign.version === 'v1' && !afterForeign.busy && afterForeign.switches === foreignSwitches && afterForeign.frameUrl === null, { foreignTitle, afterForeign });
    await page.close();

    // ---- 4: persistence ----------------------------------------------------------------------------
    const second = await browser.newPage();
    watch(second);
    await second.goto(shellUrl(), { waitUntil: 'load', timeout: 60000 });
    const remembered = await waitForGame(second, 'v1');
    check('new tab on / opens the remembered version (v1)', remembered.version === 'v1' && remembered.ready, remembered.version);
    await second.goto(shellUrl('v=2'), { waitUntil: 'load', timeout: 60000 });
    const forced = await waitForGame(second, 'v2');
    check('/?v=2 overrides and is remembered', forced.version === 'v2' && forced.lastVersion === 'v2', forced);
    await second.goto(shellUrl('v=1'), { waitUntil: 'load', timeout: 60000 });
    const forcedV1 = await waitForGame(second, 'v1');
    check('/?v=1 overrides and is remembered', forcedV1.version === 'v1' && forcedV1.lastVersion === 'v1', forcedV1);
    await shot(second, 'v1-direct');
    await second.close();

    // ---- 5: forwarding -----------------------------------------------------------------------------
    const third = await browser.newPage();
    watch(third);
    await third.goto(shellUrl('v=2&renderer=webgl', '#seed=SHELLHASH'), { waitUntil: 'load', timeout: 60000 });
    const hashed = await waitForGame(third, 'v2');
    const hashedFrame = new URL(hashed.frameUrl);
    check('hash and extra query reach V2', hashed.seed === 'SHELLHASH' && hashed.backend === 'WebGL2' && hashedFrame.hash === '#seed=SHELLHASH' && hashedFrame.searchParams.get('renderer') === 'webgl', { seed: hashed.seed, backend: hashed.backend, frameUrl: hashed.frameUrl });
    before = report.frameNavigations.length;
    await third.evaluate(() => { window.location.hash = '#seed=SECONDHASH'; });
    await sleep(1000);
    const rehashed = await waitForGame(third, 'v2');
    check('a hash change reloads V2 with the new seed', rehashed.seed === 'SECONDHASH' && report.frameNavigations.length > before, rehashed.seed);
    await third.close();
  } finally {
    await browser.close().catch((error) => process.stderr.write(`browser close failed: ${error.message}\n`));
    foreign.server.close();
    for (const directory of [profileDir, foreignRoot]) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        process.stderr.write(`could not remove temporary directory ${directory}: ${error.message}\n`);
      }
    }
  }

  // ---- 7: console ----------------------------------------------------------------------------------
  const noisy = (entries) => entries.filter((entry) => ['error', 'assert', 'warn', 'warning', 'pageerror'].includes(entry.type));
  check('shell console: no errors or warnings', noisy(report.console.shell).length === 0, noisy(report.console.shell));
  check('V2 console: no errors or warnings', noisy(report.console.v2).length === 0, noisy(report.console.v2));
  check('foreign page console: no errors or warnings', noisy(report.console.other).length === 0, noisy(report.console.other));
  report.v1ConsoleNoise = noisy(report.console.v1);
  process.stdout.write(`V1 console (recorded, judged only against V1's original behaviour): ${report.console.v1.length} messages, ${report.v1ConsoleNoise.length} errors or warnings\n`);

  report.passed = report.checks.every((entry) => entry.pass);
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((entry) => !entry.pass).length;
  process.stdout.write(`\n${report.checks.length - failed}/${report.checks.length} shell checks passed${failed ? `; ${failed} FAILED` : ''}\n`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`shell-check failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
