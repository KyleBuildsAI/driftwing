// Pixel comparison of two PNG screenshots (the smoke test's shots): decodes both with node:zlib
// (8-bit greyscale, RGB, grey + alpha or RGBA, not interlaced, as Chrome writes them) and prints the
// number of differing pixels, the largest channel difference and the mean absolute difference.
//
// Usage: node tools/png-diff.mjs <a.png> <b.png> [--report]
// Exits 0 when the images are pixel-identical, 1 when they differ (0 with --report, which only
// prints the numbers), and 2 when a file cannot be compared.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Decodes a PNG file into { width, height, channels, pixels (Uint8Array, unfiltered rows) }. */
export function decodePng(path) {
  const file = readFileSync(path);
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${path} is not a PNG file`);
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error(`${path} has no IHDR chunk`);
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) {
    throw new Error(`${path}: only 8-bit, non-interlaced greyscale or RGB(A) PNGs are supported (depth ${header.bitDepth}, colour type ${header.colorType}, interlace ${header.interlace})`);
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const pixels = new Uint8Array(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column++) {
      const value = raw[source + column];
      const left = column >= channels ? pixels[target + column - channels] : 0;
      const up = row > 0 ? pixels[target - stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? pixels[target - stride + column - channels] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else throw new Error(`${path}: unknown PNG row filter ${filter}`);
      pixels[target + column] = decoded & 255;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

/** Compares two decoded images (RGB channels only). */
export function comparePixels(first, second) {
  if (first.width !== second.width || first.height !== second.height) throw new Error(`sizes differ: ${first.width}x${first.height} vs ${second.width}x${second.height}`);
  let differing = 0;
  let largest = 0;
  let total = 0;
  const count = first.width * first.height;
  for (let pixel = 0; pixel < count; pixel++) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 3; channel++) {
      const a = first.pixels[pixel * first.channels + Math.min(channel, first.channels - 1)];
      const b = second.pixels[pixel * second.channels + Math.min(channel, second.channels - 1)];
      const difference = Math.abs(a - b);
      if (difference > 0) pixelDiffers = true;
      if (difference > largest) largest = difference;
      total += difference;
    }
    if (pixelDiffers) differing++;
  }
  return { pixels: count, differing, differingShare: differing / count, largest, meanAbsolute: total / (count * 3) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const files = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const reportOnly = process.argv.includes('--report');
  if (files.length !== 2) {
    process.stderr.write('usage: node tools/png-diff.mjs <a.png> <b.png> [--report]\n');
    process.exit(2);
  }
  try {
    const result = comparePixels(decodePng(files[0]), decodePng(files[1]));
    const identical = result.differing === 0;
    process.stdout.write(`${JSON.stringify({ identical, ...result, differingShare: Number(result.differingShare.toFixed(6)), meanAbsolute: Number(result.meanAbsolute.toFixed(4)) })}\n`);
    process.exitCode = identical || reportOnly ? 0 : 1;
  } catch (error) {
    process.stderr.write(`png-diff: ${error.message}\n`);
    process.exitCode = 2;
  }
}
