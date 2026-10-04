// V1 freeze helpers shared by the checksum test (tests/v1-checksum.test.mjs) and the single-file
// build (tools/build-single.mjs): where the frozen V1 lives and the SHA-256 it must keep.
//
// V1 is index.html from the git tag v1-final, byte-for-byte, served untouched from public/v1/.
// tests/v1.sha256 holds its hash in sha256sum format ("<hex>  public/v1/index.html").
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The frozen V1 page (Vite serves public/ without processing it). */
export const V1_PATH = resolve(PROJECT_ROOT, 'public', 'v1', 'index.html');
export const V1_CHECKSUM_PATH = resolve(PROJECT_ROOT, 'tests', 'v1.sha256');
/** The git object V1 was frozen from. */
export const V1_GIT_OBJECT = 'v1-final:index.html';

/** Lower-case hex SHA-256 of a byte buffer. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of a file on disk. */
export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** The expected V1 hash from tests/v1.sha256; throws when the file is missing or malformed. */
export function readExpectedV1Hash() {
  const text = readFileSync(V1_CHECKSUM_PATH, 'utf8');
  const match = /^([0-9a-f]{64})\b/.exec(text.trim());
  if (!match) throw new Error(`${V1_CHECKSUM_PATH} does not start with a SHA-256 hex digest`);
  return match[1];
}
