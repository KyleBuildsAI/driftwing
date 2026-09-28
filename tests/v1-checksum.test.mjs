// V1 freeze check: public/v1/index.html must stay byte-for-byte the index.html of tag v1-final.
// Fails when its SHA-256 differs from tests/v1.sha256 or its bytes differ from
// `git show v1-final:index.html`.
//
// Usage: npm run test:v1   (node --test tests/v1-checksum.test.mjs)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ROOT, V1_GIT_OBJECT, V1_PATH, readExpectedV1Hash, sha256 } from '../tools/v1-checksum.mjs';

/** V1 is about 0.9 MB; git show's output is read whole. */
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

test('public/v1/index.html matches tests/v1.sha256', () => {
  assert.ok(existsSync(V1_PATH), `${V1_PATH} is missing`);
  const actual = sha256(readFileSync(V1_PATH));
  assert.equal(actual, readExpectedV1Hash(), 'V1 changed: public/v1/index.html is frozen and must never be edited');
});

test('public/v1/index.html is byte-for-byte git show v1-final:index.html', (context) => {
  if (!existsSync(resolve(PROJECT_ROOT, '.git'))) {
    context.skip('not a git checkout, so the v1-final tag cannot be read (the SHA-256 check still ran)');
    return;
  }
  const original = execFileSync('git', ['show', V1_GIT_OBJECT], { cwd: PROJECT_ROOT, maxBuffer: GIT_OUTPUT_LIMIT });
  const frozen = readFileSync(V1_PATH);
  assert.equal(frozen.length, original.length, `size differs from ${V1_GIT_OBJECT}`);
  assert.ok(frozen.equals(original), `bytes differ from ${V1_GIT_OBJECT}`);
});
