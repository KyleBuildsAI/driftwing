// start-driftwing.bat check: runs the .bat's Node version check under cmd.exe (Windows only) with a
// fake `node` on PATH for each case (no output, garbage, old, current), without installing or
// starting anything: the check block is extracted into a temporary script where `start` becomes an
// echo and `pause` a rem, so no browser opens and nothing waits for a key.
//
// Usage: node tools/bat-check.mjs [path/to/start-driftwing.bat]
// Prints one line per case and exits non-zero if any case fails.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write('bat-check: skipped (cmd.exe is Windows only)\n');
  process.exit(0);
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRLF = '\r\n';
const bat = process.argv[2] ? resolve(process.argv[2]) : join(PROJECT_ROOT, 'start-driftwing.bat');
const workDir = mkdtempSync(join(tmpdir(), 'driftwing-bat-'));

/** The .bat's Node check as a standalone script that reports the major version when it passes. */
function buildCheckScript(text) {
  const start = text.indexOf('rem ---- Node.js is required');
  const end = text.indexOf('rem ---- First run');
  if (start < 0 || end < 0) throw new Error(`${bat} has no Node.js check block`);
  const block = text.slice(start, end)
    .replace(/^(\s*)start "" /gm, '$1echo OPEN ')
    .replace(/^(\s*)pause\s*$/gm, '$1rem pause');
  return ['@echo off', 'setlocal', block, 'echo CHECK PASSED major=%NODE_MAJOR%', 'exit /b 0', ''].join(CRLF);
}

const CASES = [
  { name: 'empty output', out: '', expect: 'could not read your Node.js version' },
  { name: 'garbage', out: 'hello there', expect: 'could not read your Node.js version' },
  { name: 'ampersand junk', out: 'x & y', expect: 'could not read your Node.js version' },
  { name: 'old v18.19.0', out: 'v18.19.0', expect: 'needs Node.js 20 or newer (found version 18)' },
  { name: 'single digit v9.0.0', out: 'v9.0.0', expect: 'needs Node.js 20 or newer (found version 9)' },
  { name: 'LTS v22.11.0', out: 'v22.11.0', expect: 'CHECK PASSED major=22', passes: true },
];

/** Runs the check with a fake node printing `out`; returns { code, output }. */
function runCase(testCase, index, script) {
  const bin = join(workDir, `bin-${index}`);
  mkdirSync(bin, { recursive: true });
  const echo = testCase.out ? `echo ${testCase.out.replace(/&/g, '^&')}${CRLF}` : '';
  writeFileSync(join(bin, 'node.cmd'), `@echo off${CRLF}${echo}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = `${bin};${join(process.env.SystemRoot, 'System32')}`;
  try {
    const output = execFileSync(process.env.ComSpec, ['/d', '/c', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output };
  } catch (error) {
    if (error.status === null) throw error;
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

let failed = 0;
try {
  const script = join(workDir, 'check.cmd');
  writeFileSync(script, buildCheckScript(readFileSync(bat, 'utf8')));
  CASES.forEach((testCase, index) => {
    const { code, output } = runCase(testCase, index, script);
    const ok = output.includes(testCase.expect) && (testCase.passes ? code === 0 : code === 1 && output.includes('OPEN'));
    if (!ok) failed++;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}: exit ${code}; ${output.trim().replace(/\s+/g, ' ')}\n`);
  });
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`could not remove ${workDir}: ${error.message}\n`);
  }
}
process.stdout.write(failed ? `\n${failed} case(s) FAILED\n` : '\nPASS: every case\n');
process.exit(failed ? 1 : 0);
