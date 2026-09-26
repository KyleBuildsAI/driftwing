// Headless smoke test: loads the game in Chrome/Edge, records every console
// message, page error and failed request, runs optional scripted steps, and
// takes screenshots. Exits non-zero on any console error or warning.
//
// Usage:
//   node tools/smoke-test.mjs [--file index.html] [--query "seed=42&renderer=webgl"]
//     [--seconds 8] [--out <dir>] [--steps '<json array>' | --steps-file steps.json]
//     [--width 1280] [--height 720] [--headful] [--browser <path>] [--file-protocol]
//
// --file-protocol opens the page from file:// (as a double-click would) instead
// of serving it from the local static server.
//
// Steps (JSON array, run in order after the game reports ready):
//   { "wait": 1000 }                         sleep ms
//   { "press": "KeyP" }                      key down + up
//   { "down": "KeyW" } / { "up": "KeyW" }    hold / release a key
//   { "click": [x, y] }                      mouse click at viewport coords
//   { "move": [x, y] }                       mouse move
//   { "eval": "window.DRIFTWING.state.player.speed" }  evaluate, result is logged
//   { "shot": "name" }                       screenshot to <out>/<name>.png
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStaticServer } from './serve.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function parseArgs(argv) {
  const options = {
    file: 'index.html',
    query: '',
    seconds: 8,
    out: join(tmpdir(), 'driftwing-smoke'),
    steps: [],
    width: 1280,
    height: 720,
    headful: false,
    browser: null,
    fileProtocol: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--file': options.file = next(); break;
      case '--query': options.query = next().replace(/^\?/, ''); break;
      case '--seconds': options.seconds = Number(next()); break;
      case '--out': options.out = next(); break;
      case '--steps': options.steps = JSON.parse(next()); break;
      case '--steps-file': options.steps = JSON.parse(readFileSync(next(), 'utf8')); break;
      case '--width': options.width = Number(next()); break;
      case '--height': options.height = Number(next()); break;
      case '--headful': options.headful = true; break;
      case '--browser': options.browser = next(); break;
      case '--file-protocol': options.fileProtocol = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function runSteps(page, steps, options, report) {
  for (const step of steps) {
    if ('wait' in step) await sleep(step.wait);
    else if ('press' in step) await page.keyboard.press(step.press);
    else if ('down' in step) await page.keyboard.down(step.down);
    else if ('up' in step) await page.keyboard.up(step.up);
    else if ('click' in step) await page.mouse.click(step.click[0], step.click[1]);
    else if ('move' in step) await page.mouse.move(step.move[0], step.move[1], { steps: 4 });
    else if ('eval' in step) {
      const value = await page.evaluate(step.eval).catch((error) => `EVAL ERROR: ${error.message}`);
      report.evals.push({ expression: step.eval, value });
    } else if ('shot' in step) {
      const path = join(options.out, `${step.shot}.png`);
      await page.screenshot({ path });
      report.screenshots.push(path);
    } else throw new Error(`Unknown step ${JSON.stringify(step)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  mkdirSync(options.out, { recursive: true });
  const executablePath = options.browser ?? BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');

  const filePath = resolve(PROJECT_ROOT, options.file);
  const query = options.query ? `?${options.query}` : '';
  let server = null;
  let url;
  if (options.fileProtocol) {
    url = `${pathToFileURL(filePath).href}${query}`;
  } else {
    const started = await startStaticServer({ port: 0, root: dirname(filePath), quiet: true });
    server = started.server;
    url = `http://localhost:${started.port}/${filePath.split(/[\\/]/).pop()}${query}`;
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: !options.headful,
    userDataDir: join(tmpdir(), `driftwing-profile-${process.pid}`),
    args: [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${options.width},${options.height}`,
    ],
    defaultViewport: { width: options.width, height: options.height },
  });

  const report = {
    url,
    browser: executablePath,
    ready: false,
    backend: null,
    errors: [],
    warnings: [],
    info: [],
    evals: [],
    screenshots: [],
    stats: null,
    framesAdvanced: null,
    screenshotsDiffer: null,
  };

  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      const location = message.location();
      const where = location?.url ? ` (${location.url.split('/').pop()}:${location.lineNumber ?? '?'})` : '';
      const entry = `${message.text()}${where}`;
      const type = message.type();
      if (type === 'error' || type === 'assert') report.errors.push(entry);
      else if (type === 'warn' || type === 'warning') report.warnings.push(entry);
      else report.info.push(`[${type}] ${entry}`);
    });
    page.on('pageerror', (error) => report.errors.push(`pageerror: ${error.message}\n${error.stack ?? ''}`));
    page.on('requestfailed', (request) => {
      report.errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) report.errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
      report.ready = await page.evaluate(() => Boolean(window.DRIFTWING && window.DRIFTWING.ready)).catch(() => false);
      if (report.ready) break;
      await sleep(250);
    }
    report.backend = await page.evaluate(() => window.DRIFTWING?.backend ?? null).catch(() => null);

    const frameBefore = await page.evaluate(() => window.DRIFTWING?.frame ?? null).catch(() => null);
    await sleep(Math.max(1000, options.seconds * 1000 - 2500));
    const firstShot = await page.screenshot({ path: join(options.out, 'smoke-a.png') });
    report.screenshots.push(join(options.out, 'smoke-a.png'));
    await sleep(2500);
    const secondShot = await page.screenshot({ path: join(options.out, 'smoke-b.png') });
    report.screenshots.push(join(options.out, 'smoke-b.png'));
    report.screenshotsDiffer = !firstShot.equals(secondShot);
    report.screenshotBytes = [firstShot.length, secondShot.length];

    await runSteps(page, options.steps, options, report);

    const frameAfter = await page.evaluate(() => window.DRIFTWING?.frame ?? null).catch(() => null);
    report.framesAdvanced = frameBefore !== null && frameAfter !== null ? frameAfter - frameBefore : null;
    report.stats = await page
      .evaluate(() => (window.DRIFTWING?.getStats ? window.DRIFTWING.getStats() : null))
      .catch((error) => `getStats failed: ${error.message}`);
  } finally {
    await browser.close().catch((error) => process.stderr.write(`browser close failed: ${error.message}\n`));
    server?.close();
  }

  const passed = report.ready && report.errors.length === 0 && report.warnings.length === 0 && report.screenshotsDiffer;
  report.passed = passed;
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`smoke-test failed to run: ${error.stack ?? error}\n`);
  process.exit(2);
});
