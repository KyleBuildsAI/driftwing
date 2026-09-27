// Chrome / Edge discovery shared by the headless tools (smoke-test.mjs, run-harness.mjs).
import { existsSync } from 'node:fs';

export const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** The explicit browser path, or the first installed candidate; throws when none is found. */
export function findBrowser(explicitPath = null) {
  const executablePath = explicitPath ?? BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return executablePath;
}
