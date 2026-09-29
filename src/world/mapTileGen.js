// Map tiles: low-resolution rasters of the world from the SHARED height and biome functions
// (worldgen.js, stamps included), for the world map now and the far-field planet tiles of Phase 3.
// Pure and DOM-free: the map-tile worker (mapTiles.worker.js) runs it, and the labs import it in node.
//
// generate({ x, z, size, resolution, fields }) samples a square tile whose north-west corner (minimum x
// and z) is (x, z), size metres on a side, at resolution x resolution points (cell centres, row-major,
// rows running south: index = row * resolution + column). It returns the requested fields:
//   height  Float32Array   terrain height (m), the shared heightAt, stamps included
//   color   Uint8ClampedArray RGBA, sRGB: the terrain's own face colours (faceColor) under a shaded relief
//           lit from the north-west, and water tinted by depth
//   biome   Uint8Array     dominant biome index (world.BIOMES order) from the shared climate
// Neighbouring tiles line up: every sample is a pure function of its world position (the relief reads a
// one-sample border beyond the tile), so a tile set has no seams.
import { PRESETS } from '../spawns/presets/index.js';

export const MAP_TILE_FIELDS = Object.freeze(['height', 'color', 'biome']);
/** Bumped when the tile look changes, so cached tiles from an older look are not reused. */
export const MAP_TILE_VERSION = 1;
export const MAP_TILE_MAX_RESOLUTION = 512;

// Water by depth (sRGB 0..255): shallows, open water, deep water.
const WATER_SHALLOW = Object.freeze([88, 168, 172]);
const WATER_OPEN = Object.freeze([46, 116, 146]);
const WATER_DEEP = Object.freeze([26, 70, 104]);
// Relief light: from the north-west (-x, -z), 45 degrees up.
const LIGHT_X = -0.5;
const LIGHT_Y = Math.SQRT1_2;
const LIGHT_Z = -0.5;
const SRGB_TABLE_SIZE = 2048;
const SRGB_TABLE_MAX = 1.5;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** FNV-1a of a string, as 8 hex digits. */
function hashText(text) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A tag that changes whenever tiles of the same place would differ: the seed, the tile version and the
 * placement data of the presets (their sites and stamps shape the terrain).
 */
export function mapTileCacheTag(seed, presets = PRESETS) {
  const placement = presets.map((preset) => [preset.id, preset.kind, preset.placement ?? null, preset.stamps ?? null]);
  return `${String(seed).toUpperCase()}|v${MAP_TILE_VERSION}|${hashText(JSON.stringify(placement))}`;
}

/** Validates a tile request; returns a clean { x, z, size, resolution, fields } or throws. */
export function normalizeTileRequest(request) {
  const x = Number(request?.x);
  const z = Number(request?.z);
  const size = Number(request?.size);
  const resolution = Number(request?.resolution);
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('map tile: x and z must be finite');
  if (!(size > 0) || !Number.isFinite(size)) throw new Error('map tile: size must be a positive number of metres');
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > MAP_TILE_MAX_RESOLUTION) throw new Error(`map tile: resolution must be an integer from 2 to ${MAP_TILE_MAX_RESOLUTION}`);
  const fields = Array.isArray(request.fields) && request.fields.length > 0 ? request.fields : MAP_TILE_FIELDS;
  for (const field of fields) {
    if (!MAP_TILE_FIELDS.includes(field)) throw new Error(`map tile: unknown field "${field}"`);
  }
  return { x, z, size, resolution, fields: MAP_TILE_FIELDS.filter((field) => fields.includes(field)) };
}

/**
 * Creates a tile generator over a world from createWorldGen (the same module the terrain uses).
 * Returns { generate(request) }.
 */
export function createMapTileGenerator(world) {
  const waterLevel = world.WATER_LEVEL;
  const srgbTable = new Uint8Array(SRGB_TABLE_SIZE + 1);
  for (let index = 0; index <= SRGB_TABLE_SIZE; index++) {
    const linear = Math.min(1, (index / SRGB_TABLE_SIZE) * SRGB_TABLE_MAX);
    const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    srgbTable[index] = Math.round(clamp01(srgb) * 255);
  }
  const faceRgb = new Float32Array(3);
  const climateScratch = { temperature: 0, moisture: 0 };
  const weightScratch = new Float64Array(5);

  function toSrgb(linear) {
    const index = Math.round((linear / SRGB_TABLE_MAX) * SRGB_TABLE_SIZE);
    return srgbTable[index < 0 ? 0 : index > SRGB_TABLE_SIZE ? SRGB_TABLE_SIZE : index];
  }

  function dominantBiome(x, z) {
    world.climate(x, z, climateScratch);
    world.biomeWeights(climateScratch.temperature, climateScratch.moisture, weightScratch);
    let best = 0;
    for (let index = 1; index < 5; index++) if (weightScratch[index] > weightScratch[best]) best = index;
    return best;
  }

  function generate(request) {
    const { x, z, size, resolution, fields } = normalizeTileRequest(request);
    const step = size / resolution;
    const border = resolution + 2;
    // Heights on the tile's sample lattice plus a one-sample border for the relief.
    const lattice = new Float64Array(border * border);
    for (let row = 0; row < border; row++) {
      const sampleZ = z + (row - 0.5) * step;
      for (let column = 0; column < border; column++) {
        lattice[row * border + column] = world.heightAt(x + (column - 0.5) * step, sampleZ);
      }
    }
    const result = {};
    if (fields.includes('height')) {
      const height = new Float32Array(resolution * resolution);
      for (let row = 0; row < resolution; row++) {
        for (let column = 0; column < resolution; column++) height[row * resolution + column] = lattice[(row + 1) * border + column + 1];
      }
      result.height = height;
    }
    if (fields.includes('color')) result.color = shade(lattice, x, z, step, resolution, border);
    if (fields.includes('biome')) {
      const biome = new Uint8Array(resolution * resolution);
      for (let row = 0; row < resolution; row++) {
        const sampleZ = z + (row + 0.5) * step;
        for (let column = 0; column < resolution; column++) biome[row * resolution + column] = dominantBiome(x + (column + 0.5) * step, sampleZ);
      }
      result.biome = biome;
    }
    return result;
  }

  /** RGBA sRGB colours: face colours with a shaded relief (exaggerated on coarse tiles), water by depth. */
  function shade(lattice, x, z, step, resolution, border) {
    const color = new Uint8ClampedArray(resolution * resolution * 4);
    // Coarse tiles flatten the relief; exaggerate it so ridges still read at every zoom.
    const exaggeration = Math.min(8, 1 + step / 45);
    for (let row = 0; row < resolution; row++) {
      const sampleZ = z + (row + 0.5) * step;
      for (let column = 0; column < resolution; column++) {
        const centre = (row + 1) * border + column + 1;
        const height = lattice[centre];
        const slopeX = (lattice[centre + 1] - lattice[centre - 1]) / (2 * step);
        const slopeZ = (lattice[centre + border] - lattice[centre - border]) / (2 * step);
        const out = (row * resolution + column) * 4;
        color[out + 3] = 255;
        if (height < waterLevel) {
          const depth = waterLevel - height;
          const toOpen = smoothstep(0, 6, depth);
          const toDeep = smoothstep(8, 70, depth);
          for (let channel = 0; channel < 3; channel++) {
            const open = WATER_SHALLOW[channel] + (WATER_OPEN[channel] - WATER_SHALLOW[channel]) * toOpen;
            color[out + channel] = open + (WATER_DEEP[channel] - open) * toDeep;
          }
          continue;
        }
        // The true normal picks the terrain palette (slope bands, snow on flats); the exaggerated one lights it.
        const trueLength = Math.sqrt(slopeX * slopeX + slopeZ * slopeZ + 1);
        const normalX = -slopeX / trueLength;
        const normalZ = -slopeZ / trueLength;
        const slope = 1 - 1 / trueLength;
        world.faceColor(x + (column + 0.5) * step, sampleZ, height, slope, normalX, normalZ, 0.5, faceRgb, 0);
        const reliefX = -slopeX * exaggeration;
        const reliefZ = -slopeZ * exaggeration;
        const reliefLength = Math.sqrt(reliefX * reliefX + reliefZ * reliefZ + 1);
        const light = clamp01((reliefX * LIGHT_X + LIGHT_Y + reliefZ * LIGHT_Z) / reliefLength);
        const brightness = 0.46 + 0.86 * light;
        color[out] = toSrgb(faceRgb[0] * brightness);
        color[out + 1] = toSrgb(faceRgb[1] * brightness);
        color[out + 2] = toSrgb(faceRgb[2] * brightness);
      }
    }
    return color;
  }

  return { generate };
}
