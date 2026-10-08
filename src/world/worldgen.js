// The deterministic world generator. Imported by the main thread AND the terrain worker, so the
// height function used for collision, spawning and landmarks is exactly the one that builds the mesh.
import { PRESETS } from '../spawns/presets/index.js';
import { SITE_CELL, createPlacement } from './placement.js';
import { STAMP_HEIGHT, STAMP_PAINTS, accumulateStampPaintByKind } from './stamps.js';
import { waterOutlineContains } from './waters.js';
import { OVERLAY_SWEEP_WEIGHT_MAX, overlayWeight, stripeAt, sweepPhase } from './overlays.js';
import { VEGETATION_IDS, speciesById } from './vegetationSpecies.js';

/**
 * The salt of the world's prevailing wind direction: the same as src/env/WindField.js
 * (prevailingWindDirection), so overlays whose tint sweep runs 'downwind' follow the real wind
 * (tools/lab/water.mjs checks the two agree).
 */
export const PREVAILING_WIND_SALT = 911;

// ============================================================================
// WORLD GENERATION: pure and deterministic from the seed.
// The terrain Web Worker imports this module (and through it placement.js, stamps.js and the
// pure-data preset list), so everything here stays free of DOM and three.js.
// Units are metres. Axes: +x east, -z north, +y up.
//
// options: { chunkSize, lod0Resolution, waterLevel, landmarkCell, presets? }. presets overrides the
// preset list (src/spawns/presets/index.js); only the dev test harnesses pass it (fixture presets),
// and main.js hands the same options to the terrain worker, so both threads agree.
// ============================================================================
export function createWorldGen(seedString, options) {
  const CHUNK_SIZE = options.chunkSize;
  const GRID_STEP = options.chunkSize / options.lod0Resolution;
  const WATER_LEVEL = options.waterLevel;
  const LANDMARK_CELL = options.landmarkCell;

  const BIOMES = [
    { index: 0, key: 'snow', name: 'Snow Peaks', temperature: 0.12, moisture: 0.55 },
    { index: 1, key: 'pine', name: 'Pine Valleys', temperature: 0.36, moisture: 0.78 },
    { index: 2, key: 'dunes', name: 'Dune Sea', temperature: 0.86, moisture: 0.14 },
    { index: 3, key: 'archipelago', name: 'Archipelago', temperature: 0.72, moisture: 0.86 },
    { index: 4, key: 'meadows', name: 'Flower Meadows', temperature: 0.56, moisture: 0.42 },
  ];
  const BIOME_SIGMA_SQ2 = 2 * 0.13 * 0.13;

  // Six-colour palette per biome (sRGB hex); converted to linear below.
  const PALETTES_SRGB = [
    [0x4a4e5c, 0x6b6f7d, 0x8d8b92, 0xc9d6e8, 0xf2f5fa, 0xa9cde0], // snow: rock dark, rock, scree, snow shade, snow, ice
    [0x3f5a36, 0x5b7a3f, 0x7f9a4e, 0x6b5a3e, 0x7a7466, 0xe8edf2], // pine: grass dark, grass, moss, needle floor, rock, snow cap
    [0xe9c98f, 0xd9a866, 0xc08850, 0xa8583a, 0x8c8a4e, 0xefe2c4], // dunes: sand light, sand warm, lee shadow, mesa red, scrub, salt flat
    [0x2e6f7a, 0x7fc6b8, 0xf0dcae, 0x3f7a45, 0x6fa04a, 0x857a6a], // archipelago: seabed, reef sand, beach, jungle, palm light, cliff
    [0x8fb45a, 0xa7b85e, 0x9a7b52, 0xe58fa6, 0xf2c94c, 0xa58fd8], // meadows: grass, warm grass, soil, pink, gold, lavender
  ];
  // Four shades per stamp paint (sRGB hex), in STAMP_PAINTS order; converted to linear below.
  const PAINT_PALETTES_SRGB = [
    [0x5d5955, 0x77716a, 0x928b82, 0x3f3b39], // ash: dark ash, ash, pale ash, cinder
    [0x2c2a2d, 0x38353a, 0x4a3f3b, 0x242224], // basalt: basalt, grey basalt, oxidised flow, fresh flow
    [0x28302f, 0x34403d, 0x3d4d3a, 0x1f2626], // wetRock: wet rock, slick rock, moss, soaked black rock
    [0x47484a, 0x55565a, 0x6b6a64, 0x3a3b3d], // tarmac: tarmac, grey tarmac, worn and faded, patch repair
    [0x55665f, 0x6f7568, 0x405a5c, 0x8a8a7a], // riverbed: wet stones, gravel, wet dark stones, dry pebbles
    [0xeee8da, 0xf6f2e8, 0xdcd4c2, 0xe4dccb], // salt: crust, bright crust, grey crust, polygon ridges
    [0xe2c48e, 0xd4b07a, 0xc89f6c, 0xecd6a8], // sand: sand, warm sand, damp sand, pale sand
    [0xeee2c8, 0xe6d3ae, 0xd8c094, 0xf6eedc], // travertine: cream, warm stone, ochre stain, white rim
    [0x5a4c3c, 0x4a3e32, 0x6b5a46, 0x3c3229], // mud: lake mud, dark mud, dry mud, wet black mud
    [0xd6e6f2, 0xbcd6ea, 0xe8f2fa, 0xa8c8e0], // ice: rime, blue ice, snow dusted, clear blue ice
  ];
  // Ids 0-5 are the Phase 1 types; 6-12 the Phase 3 species, which grow only inside overlays.
  const VEGETATION = VEGETATION_IDS;
  const LANDMARK_TYPES = ['arch', 'monoliths', 'lighthouse', 'balloons'];
  const DUNE_WIND_ANGLE = 0.55;
  const DUNE_COS = Math.cos(DUNE_WIND_ANGLE);
  const DUNE_SIN = Math.sin(DUNE_WIND_ANGLE);

  function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }
  function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }
  function srgbToLinear(channel) {
    return channel < 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
  }
  function hexToLinear(hex, out, offset) {
    out[offset] = srgbToLinear(((hex >> 16) & 255) / 255);
    out[offset + 1] = srgbToLinear(((hex >> 8) & 255) / 255);
    out[offset + 2] = srgbToLinear((hex & 255) / 255);
  }
  function hashString(text) {
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return mix32(hash >>> 0);
  }
  function mix32(value) {
    let h = value | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function mulberry32(state) {
    let a = state | 0;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const seedHash = hashString(String(seedString).toUpperCase());
  const random = mulberry32(seedHash);

  /** Deterministic hash of an integer lattice point to [0, 1). */
  function hash2(ix, iz, salt) {
    let h = mix32((seedHash ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0);
    h = mix32((h ^ (ix | 0)) >>> 0);
    h = mix32((h + Math.imul(iz | 0, 0x27d4eb2d)) >>> 0);
    return h / 4294967296;
  }

  // ---- Seeded 2D simplex noise (Gustavson), output roughly [-1, 1] -----------
  const perm = new Uint8Array(512);
  const permMod8 = new Uint8Array(512);
  {
    const table = new Uint8Array(256);
    for (let index = 0; index < 256; index++) table[index] = index;
    for (let index = 255; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      const held = table[index];
      table[index] = table[swapIndex];
      table[swapIndex] = held;
    }
    for (let index = 0; index < 512; index++) {
      perm[index] = table[index & 255];
      permMod8[index] = perm[index] & 7;
    }
  }
  const GRAD_X = new Float64Array([1, -1, 1, -1, 1, -1, 0, 0]);
  const GRAD_Z = new Float64Array([1, 1, -1, -1, 0, 0, 1, -1]);
  const SKEW = 0.5 * (Math.sqrt(3) - 1);
  const UNSKEW = (3 - Math.sqrt(3)) / 6;

  function simplex2(xin, zin) {
    const skew = (xin + zin) * SKEW;
    const i = Math.floor(xin + skew);
    const j = Math.floor(zin + skew);
    const unskew = (i + j) * UNSKEW;
    const x0 = xin - (i - unskew);
    const z0 = zin - (j - unskew);
    const i1 = x0 > z0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + UNSKEW;
    const z1 = z0 - j1 + UNSKEW;
    const x2 = x0 - 1 + 2 * UNSKEW;
    const z2 = z0 - 1 + 2 * UNSKEW;
    const ii = i & 255;
    const jj = j & 255;
    let total = 0;
    let t0 = 0.5 - x0 * x0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod8[ii + perm[jj]];
      t0 *= t0;
      total += t0 * t0 * (GRAD_X[g] * x0 + GRAD_Z[g] * z0);
    }
    let t1 = 0.5 - x1 * x1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod8[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      total += t1 * t1 * (GRAD_X[g] * x1 + GRAD_Z[g] * z1);
    }
    let t2 = 0.5 - x2 * x2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod8[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      total += t2 * t2 * (GRAD_X[g] * x2 + GRAD_Z[g] * z2);
    }
    return 70 * total;
  }

  const OFFSETS = new Float64Array(96);
  for (let index = 0; index < OFFSETS.length; index++) OFFSETS[index] = (random() - 0.5) * 20000;

  function noise(x, z, frequency, channel) {
    return simplex2(x * frequency + OFFSETS[channel * 2], z * frequency + OFFSETS[channel * 2 + 1]);
  }
  function fbm(x, z, frequency, octaves, channel) {
    let amplitude = 1;
    let sum = 0;
    let norm = 0;
    let freq = frequency;
    const offsetX = OFFSETS[channel * 2];
    const offsetZ = OFFSETS[channel * 2 + 1];
    for (let octave = 0; octave < octaves; octave++) {
      sum += amplitude * simplex2(x * freq + offsetX + octave * 17.31, z * freq + offsetZ - octave * 11.7);
      norm += amplitude;
      amplitude *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }
  function ridged(x, z, frequency, octaves, channel) {
    let amplitude = 1;
    let sum = 0;
    let norm = 0;
    let freq = frequency;
    let weight = 1;
    const offsetX = OFFSETS[channel * 2];
    const offsetZ = OFFSETS[channel * 2 + 1];
    for (let octave = 0; octave < octaves; octave++) {
      let value = 1 - Math.abs(simplex2(x * freq + offsetX + octave * 31.7, z * freq + offsetZ + octave * 7.3));
      value *= value;
      value *= weight;
      weight = clamp01(value * 1.8);
      sum += value * amplitude;
      norm += amplitude;
      amplitude *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  }

  // ---- Climate and biome weights ------------------------------------------------
  function climate(x, z, out) {
    const warpX = x + 700 * noise(x, z, 1 / 4200, 0);
    const warpZ = z + 700 * noise(x, z, 1 / 4200, 1);
    const temperature = 0.72 * noise(warpX, warpZ, 1 / 9000, 2) + 0.28 * noise(warpX, warpZ, 1 / 2600, 3);
    const moisture = 0.72 * noise(warpX, warpZ, 1 / 7600, 4) + 0.28 * noise(warpX, warpZ, 1 / 2200, 5);
    out.temperature = clamp01(0.5 + 0.85 * temperature);
    out.moisture = clamp01(0.5 + 0.85 * moisture);
    return out;
  }
  function biomeWeights(temperature, moisture, out) {
    let total = 0;
    for (let index = 0; index < 5; index++) {
      const dt = temperature - BIOMES[index].temperature;
      const dm = moisture - BIOMES[index].moisture;
      const weight = Math.exp(-(dt * dt + dm * dm) / BIOME_SIGMA_SQ2);
      out[index] = weight;
      total += weight;
    }
    if (!(total > 1e-30)) {
      for (let index = 0; index < 5; index++) out[index] = index === 4 ? 1 : 0;
      return out;
    }
    for (let index = 0; index < 5; index++) out[index] /= total;
    return out;
  }

  // ---- Per-biome height functions (metres) --------------------------------------
  function heightSnow(x, z) {
    const ridges = ridged(x, z, 1 / 1900, 5, 6);
    return 170 + 120 * fbm(x, z, 1 / 3000, 2, 7) + 760 * Math.pow(ridges, 1.6) + 18 * fbm(x, z, 1 / 220, 2, 8);
  }
  function heightPine(x, z) {
    const ridges = ridged(x, z, 1 / 1500, 4, 9);
    return 35 + 90 * fbm(x, z, 1 / 2600, 3, 10) + 300 * Math.pow(ridges, 1.8) + 12 * fbm(x, z, 1 / 180, 2, 11);
  }
  function heightDunes(x, z) {
    const base = 28 + 30 * fbm(x, z, 1 / 2400, 3, 12);
    const along = x * DUNE_COS + z * DUNE_SIN;
    const across = -x * DUNE_SIN + z * DUNE_COS;
    const warped = along + 60 * noise(across, along, 1 / 900, 13);
    const phase = warped / 170 - Math.floor(warped / 170);
    const profile = phase < 0.72 ? phase / 0.72 : (1 - phase) / 0.28;
    const duneShape = profile * profile * (3 - 2 * profile);
    const amplitude = 16 * (0.55 + 0.45 * noise(x, z, 1 / 900, 14));
    const mesa = smoothstep(0.32, 0.4, fbm(x, z, 1 / 1700, 3, 15)) * 85;
    return base + duneShape * amplitude + mesa;
  }
  function heightArchipelago(x, z) {
    const island = smoothstep(0.12, 0.48, fbm(x, z, 1 / 1300, 5, 16));
    const detail = fbm(x, z, 1 / 260, 3, 17);
    return -42 + 22 * fbm(x, z, 1 / 3000, 2, 18) + island * (70 + 30 * detail) + (1 - island) * 4 * detail;
  }
  function heightMeadows(x, z) {
    return 26 + 48 * fbm(x, z, 1 / 1100, 4, 19) + 18 * fbm(x, z, 1 / 360, 2, 20) + 30 * Math.max(0, fbm(x, z, 1 / 2400, 2, 21));
  }
  const BIOME_HEIGHT = [heightSnow, heightPine, heightDunes, heightArchipelago, heightMeadows];

  const scratchClimate = { temperature: 0, moisture: 0 };
  const scratchWeights = new Float64Array(5);

  function baseHeight(x, z, climateOut, weightsOut) {
    climate(x, z, climateOut);
    biomeWeights(climateOut.temperature, climateOut.moisture, weightsOut);
    let height = 0;
    let weightSum = 0;
    for (let index = 0; index < 5; index++) {
      const weight = weightsOut[index];
      if (weight < 0.003) continue;
      height += weight * BIOME_HEIGHT[index](x, z);
      weightSum += weight;
    }
    return height / weightSum;
  }

  // ---- Landmark sites: one candidate per LANDMARK_CELL square -------------------
  const siteCache = new Map();
  let lastSiteKey = NaN;
  let lastSite = null;

  function landmarkSiteForCell(cellX, cellZ) {
    const key = (cellX + 32768) * 65536 + (cellZ + 32768);
    if (key === lastSiteKey) return lastSite;
    let site = siteCache.get(key);
    if (site === undefined) {
      site = buildSite(cellX, cellZ);
      if (siteCache.size > 4096) siteCache.clear();
      siteCache.set(key, site);
    }
    lastSiteKey = key;
    lastSite = site;
    return site;
  }

  function buildSite(cellX, cellZ) {
    if (hash2(cellX, cellZ, 101) < 0.12) return null;
    const x = (cellX + 0.2 + 0.6 * hash2(cellX, cellZ, 102)) * LANDMARK_CELL;
    const z = (cellZ + 0.2 + 0.6 * hash2(cellX, cellZ, 103)) * LANDMARK_CELL;
    const siteClimate = { temperature: 0, moisture: 0 };
    const siteWeights = new Float64Array(5);
    const groundHeight = baseHeight(x, z, siteClimate, siteWeights);
    let biome = 0;
    for (let index = 1; index < 5; index++) if (siteWeights[index] > siteWeights[biome]) biome = index;
    const roll = hash2(cellX, cellZ, 104);
    let type;
    if (groundHeight < -8) type = 'lighthouse';
    else if (groundHeight < 2) type = 'balloons';
    else if (biome === 2) type = roll < 0.6 ? 'arch' : roll < 0.82 ? 'monoliths' : 'balloons';
    else if (biome === 0) type = roll < 0.55 ? 'arch' : roll < 0.85 ? 'monoliths' : 'balloons';
    else if (biome === 1) type = roll < 0.35 ? 'arch' : roll < 0.7 ? 'monoliths' : 'balloons';
    else if (biome === 3) type = roll < 0.45 ? 'arch' : roll < 0.7 ? 'monoliths' : 'balloons';
    else type = roll < 0.25 ? 'arch' : roll < 0.6 ? 'monoliths' : 'balloons';
    const shapingRadius = type === 'lighthouse' ? 120 : type === 'monoliths' ? 95 : 0;
    const plateauHeight = type === 'monoliths' ? Math.max(groundHeight, 6) : type === 'lighthouse' ? 14 : groundHeight;
    return {
      id: `${cellX}:${cellZ}`,
      cellX,
      cellZ,
      type,
      x,
      z,
      biome,
      biomeKey: BIOMES[biome].key,
      groundHeight,
      plateauHeight,
      shapingRadius,
      rotation: hash2(cellX, cellZ, 105) * Math.PI * 2,
      variant: hash2(cellX, cellZ, 106),
    };
  }

  function shapeForSite(site, x, z, height) {
    if (!site || site.shapingRadius === 0) return height;
    const dx = x - site.x;
    const dz = z - site.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance >= site.shapingRadius) return height;
    if (site.type === 'lighthouse') {
      const t = 1 - smoothstep(0, site.shapingRadius, distance);
      const islandHeight = -8 + (site.plateauHeight + 8) * Math.min(1, Math.pow(t, 0.7) * 1.25);
      return Math.max(height, islandHeight);
    }
    const blend = 1 - smoothstep(site.shapingRadius * 0.42, site.shapingRadius, distance);
    return height + (site.plateauHeight - height) * blend;
  }

  /**
   * The Phase 1 height (biomes plus the landmark shaping) without any site stamps. Placement filters
   * and stamp reference heights read it, so stamps never feed back into their own placement.
   */
  function unstampedHeightAt(x, z) {
    const height = baseHeight(x, z, scratchClimate, scratchWeights);
    const site = landmarkSiteForCell(Math.floor(x / LANDMARK_CELL), Math.floor(z / LANDMARK_CELL));
    return shapeForSite(site, x, z, height);
  }

  // ---- Sites and terrain stamps (placement.js, stamps.js) -----------------------------------
  const placementClimate = { temperature: 0, moisture: 0 };
  const placementWeights = new Float64Array(5);
  // The world's prevailing downwind direction (radians; windDirection = (cos, sin) in x, z), from the
  // seed alone, exactly as the WindField computes it.
  const PREVAILING_WIND_ANGLE = hash2(0, 0, PREVAILING_WIND_SALT) * Math.PI * 2;
  const placement = createPlacement({
    seed: seedHash,
    world: {
      heightAt: unstampedHeightAt,
      waterLevel: WATER_LEVEL,
      prevailingWindAngle: PREVAILING_WIND_ANGLE,
      landmarkSitesNear,
      biomeIndexAt(x, z) {
        climate(x, z, placementClimate);
        return dominantBiome(biomeWeights(placementClimate.temperature, placementClimate.moisture, placementWeights));
      },
    },
    presets: Array.isArray(options.presets) ? options.presets : PRESETS,
  });
  const hasStamps = placement.hasStamps;
  // A direct-mapped cache in front of placement's per-cell stamp lists (the spatial hash): a toroidal
  // 64 x 64 window of cells (128 km), so no two cells within 128 km ever share a slot. heightAt runs
  // millions of times, mostly in runs inside one cell (chunk rows), so the last cell is kept too.
  const STAMP_WINDOW = 64;
  const stampSlotKeys = new Float64Array(STAMP_WINDOW * STAMP_WINDOW).fill(NaN);
  const stampSlotLists = new Array(STAMP_WINDOW * STAMP_WINDOW).fill(null);
  // Each cached cell keeps its stamps' bounds and kinds in typed arrays: the loops below then read
  // one record shape, and each stamp object is only touched by its own type's function.
  const EMPTY_STAMP_CELL = Object.freeze({ count: 0, stamps: Object.freeze([]), bounds: new Float64Array(0), kinds: new Uint8Array(0) });
  let lastStampKey = NaN;
  let lastStamps = EMPTY_STAMP_CELL;

  function stampCell(stamps) {
    if (stamps.length === 0) return EMPTY_STAMP_CELL;
    const bounds = new Float64Array(stamps.length * 4);
    const kinds = new Uint8Array(stamps.length);
    stamps.forEach((stamp, index) => {
      bounds[index * 4] = stamp.minX;
      bounds[index * 4 + 1] = stamp.maxX;
      bounds[index * 4 + 2] = stamp.minZ;
      bounds[index * 4 + 3] = stamp.maxZ;
      kinds[index] = stamp.kind;
    });
    return Object.freeze({ count: stamps.length, stamps, bounds, kinds });
  }

  /** The spatial hash lookup: the stamps overlapping the SITE_CELL cell holding (x, z), as a cell record. */
  function stampsAt(x, z) {
    const cellX = Math.floor(x / SITE_CELL);
    const cellZ = Math.floor(z / SITE_CELL);
    const key = cellX * 65536 + cellZ;
    if (key === lastStampKey) return lastStamps;
    const slot = ((cellX & (STAMP_WINDOW - 1)) << 6) | (cellZ & (STAMP_WINDOW - 1));
    if (stampSlotKeys[slot] !== key) {
      stampSlotLists[slot] = stampCell(placement.stampsInCell(cellX, cellZ));
      stampSlotKeys[slot] = key;
    }
    lastStampKey = key;
    lastStamps = stampSlotLists[slot];
    return lastStamps;
  }

  /**
   * The Phase 1 height, then every site stamp whose bounds hold the point, in their global order.
   * Stamp functions are called through a table by kind, so each sees one stamp shape and none of
   * them is inlined here (keeping the Phase 1 part of the sample as fast as it was).
   */
  function stampedHeightAt(x, z) {
    const height = unstampedHeightAt(x, z);
    const cell = stampsAt(x, z);
    const count = cell.count;
    if (count === 0) return height;
    const bounds = cell.bounds;
    let stamped = height;
    for (let index = 0; index < count; index++) {
      const base = index * 4;
      if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
      stamped = STAMP_HEIGHT[cell.kinds[index]](cell.stamps[index], x, z, stamped);
    }
    return stamped;
  }

  /**
   * Analytic terrain height at any world point (metres above sea level). Without stamped site presets
   * it IS the Phase 1 function (unstampedHeightAt); otherwise stampedHeightAt.
   */
  const heightAt = hasStamps ? stampedHeightAt : unstampedHeightAt;

  const paintScratch = { paintIndex: -1, weight: 0 };
  const influence = { paint: null, weight: 0 };

  /** Fills paintScratch with the strongest stamp paint at (x, z) (weight 0 = none). */
  function paintAt(x, z) {
    paintScratch.paintIndex = -1;
    paintScratch.weight = 0;
    if (!hasStamps) return paintScratch;
    const cell = stampsAt(x, z);
    const bounds = cell.bounds;
    for (let index = 0; index < cell.count; index++) {
      const base = index * 4;
      if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
      accumulateStampPaintByKind(cell.kinds[index], cell.stamps[index], x, z, paintScratch);
    }
    return paintScratch;
  }

  /**
   * Stamp paint at (x, z) for the colour pass: { paint: 'ash' | 'basalt' | 'wetRock' | 'tarmac' |
   * 'riverbed' | null, weight: 0..1 }. Returns one shared object (read it before the next call).
   */
  function stampInfluence(x, z) {
    paintAt(x, z);
    influence.paint = paintScratch.paintIndex >= 0 ? STAMP_PAINTS[paintScratch.paintIndex] : null;
    influence.weight = paintScratch.weight;
    return influence;
  }

  // ---- Local water bodies and region overlays (waters.js, overlays.js) ------------------------
  const hasWaters = placement.hasWaters;
  const hasOverlays = placement.hasOverlays;
  const EMPTY_RECORDS = Object.freeze([]);
  // Direct-mapped caches in front of placement's per-cell water and overlay lists, laid out like the
  // stamps' window above (64 x 64 cells, the last cell kept too).
  const waterSlotKeys = new Float64Array(STAMP_WINDOW * STAMP_WINDOW).fill(NaN);
  const waterSlotLists = new Array(STAMP_WINDOW * STAMP_WINDOW).fill(null);
  const overlaySlotKeys = new Float64Array(STAMP_WINDOW * STAMP_WINDOW).fill(NaN);
  const overlaySlotLists = new Array(STAMP_WINDOW * STAMP_WINDOW).fill(null);
  const lastRecordKeys = new Float64Array([NaN, NaN]);
  let lastWaters = EMPTY_RECORDS;
  let lastOverlays = EMPTY_RECORDS;

  /** The water bodies whose bounds overlap the SITE_CELL cell holding (x, z) (sorted by id). */
  function watersAt(x, z) {
    if (!hasWaters) return EMPTY_RECORDS;
    const cellX = Math.floor(x / SITE_CELL);
    const cellZ = Math.floor(z / SITE_CELL);
    const key = cellX * 65536 + cellZ;
    if (key === lastRecordKeys[0]) return lastWaters;
    const slot = ((cellX & (STAMP_WINDOW - 1)) << 6) | (cellZ & (STAMP_WINDOW - 1));
    if (waterSlotKeys[slot] !== key) {
      waterSlotLists[slot] = placement.watersInCell(cellX, cellZ);
      waterSlotKeys[slot] = key;
    }
    lastRecordKeys[0] = key;
    lastWaters = waterSlotLists[slot];
    return lastWaters;
  }

  /** The overlays whose bounds overlap the SITE_CELL cell holding (x, z) (sorted by id). */
  function overlaysAt(x, z) {
    if (!hasOverlays) return EMPTY_RECORDS;
    const cellX = Math.floor(x / SITE_CELL);
    const cellZ = Math.floor(z / SITE_CELL);
    const key = cellX * 65536 + cellZ;
    if (key === lastRecordKeys[1]) return lastOverlays;
    const slot = ((cellX & (STAMP_WINDOW - 1)) << 6) | (cellZ & (STAMP_WINDOW - 1));
    if (overlaySlotKeys[slot] !== key) {
      overlaySlotLists[slot] = placement.overlaysInCell(cellX, cellZ);
      overlaySlotKeys[slot] = key;
    }
    lastRecordKeys[1] = key;
    lastOverlays = overlaySlotLists[slot];
    return lastOverlays;
  }

  /**
   * The local water body covering (x, z), or null: the highest body whose outline holds the point and
   * whose ground there (groundHeight, the collision surface) lies below its level. Its static level
   * is record.level (m above sea level). The ocean is not a body: the water query adds it. The
   * terrain worker, the map tiles and the far field colour lakes from this.
   */
  function waterBodyAt(x, z) {
    if (!hasWaters) return null;
    const list = watersAt(x, z);
    let best = null;
    let ground = NaN;
    for (let index = 0; index < list.length; index++) {
      const record = list[index];
      if (best !== null && record.level <= best.level) continue;
      if (!waterOutlineContains(record, x, z)) continue;
      if (ground !== ground) ground = groundHeight(x, z);
      if (ground < record.level) best = record;
    }
    return best;
  }

  /** Every water body whose bounds come within radius of (x, z), each once, nearest centre first. */
  function waterBodiesNear(x, z, radius, visit) {
    if (!hasWaters) return;
    const found = collectRecords(x, z, radius, placement.watersInCell);
    for (let index = 0; index < found.length; index++) visit(found[index]);
  }

  /** Every overlay whose bounds come within radius of (x, z), each once, nearest centre first. */
  function overlaysNear(x, z, radius, visit) {
    if (!hasOverlays) return;
    const found = collectRecords(x, z, radius, placement.overlaysInCell);
    for (let index = 0; index < found.length; index++) visit(found[index]);
  }

  function collectRecords(x, z, radius, inCell) {
    const minCellX = Math.floor((x - radius) / SITE_CELL);
    const maxCellX = Math.floor((x + radius) / SITE_CELL);
    const minCellZ = Math.floor((z - radius) / SITE_CELL);
    const maxCellZ = Math.floor((z + radius) / SITE_CELL);
    const seen = new Set();
    const found = [];
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (const record of inCell(cellX, cellZ)) {
          if (seen.has(record)) continue;
          seen.add(record);
          const bounds = record.bounds;
          const nearestX = x < bounds.minX ? bounds.minX : x > bounds.maxX ? bounds.maxX : x;
          const nearestZ = z < bounds.minZ ? bounds.minZ : z > bounds.maxZ ? bounds.maxZ : z;
          if (Math.hypot(nearestX - x, nearestZ - z) <= radius) found.push(record);
        }
      }
    }
    found.sort((first, second) => Math.hypot(first.x - x, first.z - z) - Math.hypot(second.x - x, second.z - z) || (first.id < second.id ? -1 : 1));
    return found;
  }

  /** A reusable overlay sample for overlayAt. */
  function createOverlaySample() {
    return { weight: 0, overlay: null, palette: null, material: 0, sweepPhase: 0, stripe: 0, stripeOffset: 0, stripeSpecies: -1, speciesSet: null };
  }
  const stripeScratch = { index: 0, offset: 0 };

  /**
   * The region overlay at (x, z), written into out (createOverlaySample's shape): weight (0..1, with
   * its edge falloff; 0 = none), overlay (the winning record: the highest priority, then the lowest
   * id), palette (its per-biome linear colours or null), material (0 none, 1 ice), sweepPhase (m along
   * its tint sweep), stripe (the row index) and stripeOffset (m from that row's centre line),
   * stripeSpecies (that row's species id, -1 without stripes) and speciesSet (its vegetation species
   * ids or null). Overlays never change height.
   */
  function overlayAt(x, z, out) {
    out.weight = 0;
    out.overlay = null;
    out.palette = null;
    out.material = 0;
    out.sweepPhase = 0;
    out.stripe = 0;
    out.stripeOffset = 0;
    out.stripeSpecies = -1;
    out.speciesSet = null;
    if (!hasOverlays) return out;
    const list = overlaysAt(x, z);
    let best = null;
    let bestWeight = 0;
    for (let index = 0; index < list.length; index++) {
      const record = list[index];
      if (best !== null && record.priority <= best.priority) continue;
      const weight = overlayWeight(record, x, z);
      if (weight <= 0) continue;
      best = record;
      bestWeight = weight;
    }
    if (best === null) return out;
    out.weight = bestWeight;
    out.overlay = best;
    out.palette = best.palette;
    out.material = best.materialId;
    if (best.tintSweep !== null) out.sweepPhase = sweepPhase(best, x, z);
    if (best.stripes !== null) {
      stripeAt(best, x, z, stripeScratch);
      out.stripe = stripeScratch.index;
      out.stripeOffset = stripeScratch.offset;
      const species = best.stripes.species;
      out.stripeSpecies = species[((stripeScratch.index % species.length) + species.length) % species.length];
    }
    if (best.vegetation !== null) out.speciesSet = best.vegetation.species;
    return out;
  }

  /**
   * Height of the rendered LOD0 mesh at (x, z): heightAt sampled on the global
   * GRID_STEP lattice and interpolated across the same two triangles the mesh
   * uses. Quad (i, j) is split along the diagonal from (i+1, j) to (i, j+1):
   *   triangle A = [v(i,j), v(i,j+1), v(i+1,j)]      (fx + fz <= 1)
   *   triangle B = [v(i+1,j), v(i,j+1), v(i+1,j+1)]  (fx + fz >  1)
   */
  function groundHeight(x, z) {
    const gx = x / GRID_STEP;
    const gz = z / GRID_STEP;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h10 = heightAt((i + 1) * GRID_STEP, j * GRID_STEP);
    const h01 = heightAt(i * GRID_STEP, (j + 1) * GRID_STEP);
    if (fx + fz <= 1) {
      const h00 = heightAt(i * GRID_STEP, j * GRID_STEP);
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    const h11 = heightAt((i + 1) * GRID_STEP, (j + 1) * GRID_STEP);
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  function dominantBiome(weights) {
    let best = 0;
    for (let index = 1; index < 5; index++) if (weights[index] > weights[best]) best = index;
    return best;
  }

  /** Biome information for a world point. */
  function biomeAt(x, z) {
    const info = climate(x, z, { temperature: 0, moisture: 0 });
    const weights = biomeWeights(info.temperature, info.moisture, new Float64Array(5));
    const index = dominantBiome(weights);
    return {
      index,
      key: BIOMES[index].key,
      name: BIOMES[index].name,
      weights: Array.from(weights),
      temperature: info.temperature,
      moisture: info.moisture,
    };
  }

  // ---- Surface colour ----------------------------------------------------------
  const PALETTES = PALETTES_SRGB.map((palette) => {
    const linear = new Float32Array(18);
    palette.forEach((hex, index) => hexToLinear(hex, linear, index * 3));
    return linear;
  });

  const PAINT_PALETTES = PAINT_PALETTES_SRGB.map((palette) => {
    const linear = new Float32Array(12);
    palette.forEach((hex, index) => hexToLinear(hex, linear, index * 3));
    return linear;
  });

  function forestNoise(x, z) { return fbm(x, z, 1 / 650, 3, 22); }
  function flowerFieldNoise(x, z) { return fbm(x, z, 1 / 420, 2, 23); }

  // Palette choice per biome. `patch` is a smooth noise field (roughly -1..1, patches of
  // ~50 m with slightly dithered edges) that picks between neighbouring palette
  // entries; `faceHash` is only used for rare single-face accents.
  function paletteIndex(biome, x, z, height, slope, normalX, normalZ, faceHash, patch, snowLine) {
    const nearShore = height < WATER_LEVEL + 2.2;
    switch (biome) {
      case 0:
        if (nearShore) return 2;
        if (slope > 0.62) return patch < 0 ? 0 : 1;
        if (height > snowLine) return slope > 0.42 ? 3 : faceHash < 0.05 ? 5 : 4;
        if (height > snowLine - 60) return patch < 0.1 ? 2 : 3;
        return patch < 0 ? 1 : 2;
      case 1:
        if (nearShore) return 3;
        if (slope > 0.6) return 4;
        if (height > snowLine) return 5;
        if (forestNoise(x, z) > 0.05) return patch < 0.15 ? 0 : 3;
        return patch < -0.25 ? 0 : patch < 0.3 ? 1 : 2;
      case 2: {
        if (slope > 0.5) return 3;
        if (height > 70 && slope < 0.2) return patch < 0 ? 4 : 3;
        if (height < 22) return 5;
        if (faceHash > 0.985) return 4;
        const leeFacing = normalX * DUNE_COS + normalZ * DUNE_SIN;
        if (leeFacing < -0.12) return 2;
        return patch < 0.1 ? 0 : 1;
      }
      case 3:
        if (height < WATER_LEVEL - 12) return 0;
        if (height < WATER_LEVEL - 0.3) return 1;
        if (height < WATER_LEVEL + 2.4) return 2;
        if (slope > 0.55) return 5;
        return patch < 0.05 ? 3 : 4;
      default: {
        if (nearShore || slope > 0.5) return 2;
        // Flower drifts: smooth noise fields pick both where flowers grow and which
        // colour dominates, so patches have organic edges instead of grid cells.
        if (flowerFieldNoise(x, z) > 0.3 && faceHash > 0.5) {
          const hue = noise(x, z, 1 / 160, 47);
          return hue < -0.22 ? 3 : hue < 0.22 ? 4 : 5;
        }
        if (faceHash > 0.985) return 3 + (Math.floor(faceHash * 1000) % 3);
        return patch < 0.05 ? 0 : 1;
      }
    }
  }

  /** Shade (0-3) of a stamp paint for one face; the same patch field as the biome palettes. */
  function paintShade(paintIndex, slope, faceHash, patch) {
    switch (paintIndex) {
      case 0:
        if (slope > 0.5) return 3;
        return patch < -0.2 ? 0 : patch > 0.35 ? 2 : 1;
      case 1:
        if (faceHash > 0.9) return 2;
        if (slope > 0.55) return 3;
        return patch < 0 ? 0 : 1;
      case 2:
        if (slope > 0.6) return patch < 0 ? 3 : 0;
        return patch < 0.1 ? 2 : 1;
      case 3:
        if (faceHash > 0.93) return 3;
        if (patch > 0.25) return 2;
        return patch < -0.1 ? 0 : 1;
      case 4:
        if (patch < -0.25) return 2;
        if (faceHash > 0.8) return 3;
        return patch < 0.15 ? 0 : 1;
      case 5:
        // Salt: bright crust with grey patches and the odd polygon ridge.
        if (faceHash > 0.9) return 3;
        return patch < -0.3 ? 2 : patch < 0.2 ? 0 : 1;
      case 6:
        if (slope > 0.4) return 2;
        return patch < -0.2 ? 1 : patch > 0.35 ? 3 : 0;
      case 7:
        // Travertine: white rims on the steps, ochre stains on the risers.
        if (slope > 0.35) return patch < 0 ? 2 : 1;
        return faceHash > 0.85 ? 3 : patch < 0.1 ? 0 : 3;
      case 8:
        if (slope > 0.3) return 2;
        return patch < -0.15 ? 3 : patch < 0.25 ? 0 : 1;
      default:
        // Ice: rime, blue ice and snow-dusted patches; clear blue on single faces.
        if (faceHash > 0.94) return 3;
        return patch < -0.2 ? 1 : patch < 0.3 ? 0 : 2;
    }
  }

  const colorClimate = { temperature: 0, moisture: 0 };
  const colorWeights = new Float64Array(5);
  const colorOverlay = createOverlaySample();
  const attributeOverlay = createOverlaySample();

  /**
   * A region overlay's colour over the biome colour, with dithered edges like the stamp paint: rows
   * of stripe colours on gentle ground, else the overlay palette (three ground shades from the patch
   * field, accents on single faces). Steep faces keep the biome's own rock colours.
   */
  function applyOverlayColor(x, z, biome, slope, faceHash, patch, out, offset) {
    overlayAt(x, z, colorOverlay);
    if (colorOverlay.weight <= 0) return;
    const record = colorOverlay.overlay;
    const share = smoothstep(0.35, 0.65, colorOverlay.weight + (faceHash - 0.5) * 0.3);
    if (share <= 0) return;
    const jitter = 0.95 + 0.1 * faceHash;
    let source;
    let base;
    if (record.stripes !== null && slope < 0.45) {
      const colors = record.stripes.colors;
      const count = colors.length;
      source = colors[((colorOverlay.stripe % count) + count) % count];
      base = 0;
    } else if (record.palette !== null && slope < 0.55) {
      source = record.palette[biome];
      base = (faceHash > 0.93 ? 3 + (Math.floor(faceHash * 1000) % 3) : patch < -0.2 ? 0 : patch < 0.3 ? 1 : 2) * 3;
    } else {
      return;
    }
    out[offset] += (source[base] * jitter - out[offset]) * share;
    out[offset + 1] += (source[base + 1] * jitter - out[offset + 1]) * share;
    out[offset + 2] += (source[base + 2] * jitter - out[offset + 2]) * share;
  }

  /**
   * The chunk `overlay` attribute of one face (vec4, into out at offset): x = the tint sweep's colour
   * slot plus its weight (0 .. OVERLAY_SWEEP_WEIGHT_MAX, so floor(x) is the slot), y = the sweep phase
   * (m along its direction), z = the material id (0 none, 1 ice; dithered at the edge like the
   * colour), w = the stripe id (row index + 1, wrapped to 1..1024; 0 without stripes). All zero
   * outside every overlay, so a world without overlays bakes zeros and renders as in Phase 2.
   */
  function faceOverlay(x, z, faceHash, out, offset) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    if (!hasOverlays) return;
    overlayAt(x, z, attributeOverlay);
    if (attributeOverlay.weight <= 0) return;
    const record = attributeOverlay.overlay;
    if (record.tintSweep !== null) {
      out[offset] = record.tintSweep.slot + Math.min(attributeOverlay.weight, OVERLAY_SWEEP_WEIGHT_MAX);
      out[offset + 1] = attributeOverlay.sweepPhase;
    }
    if (record.materialId > 0 && smoothstep(0.35, 0.65, attributeOverlay.weight + (faceHash - 0.5) * 0.3) >= 0.5) out[offset + 2] = record.materialId;
    if (record.stripes !== null) out[offset + 3] = (((attributeOverlay.stripe % 1024) + 1024) % 1024) + 1;
  }

  /**
   * Flat face colour (linear RGB) for a triangle whose centroid is (x, height, z).
   * slope = 1 - normalY (0 flat .. 1 vertical); normalX/normalZ = face normal.
   * faceHash = stable per-face random in [0, 1) (use hash2 of the face's lattice cell).
   * Each face takes its colour from ONE biome, chosen by a smooth noise field against
   * the biome weights, so blend zones become organic patches of pure palette colours
   * instead of weight-averaged grey.
   */
  function faceColor(x, z, height, slope, normalX, normalZ, faceHash, out, offset) {
    climate(x, z, colorClimate);
    biomeWeights(colorClimate.temperature, colorClimate.moisture, colorWeights);
    const snowLine = 140 + 640 * colorClimate.temperature;
    const blendPick = clamp01(0.5 + 0.62 * (0.75 * noise(x, z, 1 / 70, 46) + 0.25 * noise(x, z, 1 / 21, 45))) * 0.88 + faceHash * 0.12;
    let biome = 4;
    let accumulated = 0;
    for (let index = 0; index < 5; index++) {
      accumulated += colorWeights[index];
      if (blendPick <= accumulated) {
        biome = index;
        break;
      }
    }
    const patch = noise(x, z, 1 / 48, 44) + (faceHash - 0.5) * 0.35;
    const index = paletteIndex(biome, x, z, height, slope, normalX, normalZ, faceHash, patch, snowLine) * 3;
    const palette = PALETTES[biome];
    const jitter = 0.95 + 0.1 * faceHash;
    out[offset] = palette[index] * jitter;
    out[offset + 1] = palette[index + 1] * jitter;
    out[offset + 2] = palette[index + 2] * jitter;
    if (hasOverlays) applyOverlayColor(x, z, biome, slope, faceHash, patch, out, offset);
    if (!hasStamps) return;
    // Stamp paint (ash, basalt, wet rock, tarmac, riverbed) over the biome colour, with dithered edges
    // like the biome blend zones, so a painted area reads as patches of pure paint shades.
    paintAt(x, z);
    if (paintScratch.weight <= 0) return;
    const share = smoothstep(0.35, 0.65, paintScratch.weight + (faceHash - 0.5) * 0.3);
    if (share <= 0) return;
    const paint = PAINT_PALETTES[paintScratch.paintIndex];
    const shade = paintShade(paintScratch.paintIndex, slope, faceHash, patch) * 3;
    const paintJitter = 0.94 + 0.12 * faceHash;
    out[offset] += (paint[shade] * paintJitter - out[offset]) * share;
    out[offset + 1] += (paint[shade + 1] * paintJitter - out[offset + 1]) * share;
    out[offset + 2] += (paint[shade + 2] * paintJitter - out[offset + 2]) * share;
  }

  // ---- Vegetation scatter ------------------------------------------------------
  const SCATTER_CELL = 11;
  const SCATTER_STRIDE = 7;
  const SCATTER_CELLS_PER_SIDE = Math.floor(CHUNK_SIZE / SCATTER_CELL);
  const scatterClimate = { temperature: 0, moisture: 0 };
  const scatterWeights = new Float64Array(5);
  const scatterOverlay = createOverlaySample();
  /** The last scatterCell result: [localX, y, localZ, scale, rotationY, type, variant] (doubles). */
  const cellInstance = new Float64Array(SCATTER_STRIDE);
  const MANGROVE = speciesById(VEGETATION.MANGROVE);

  /**
   * The species an overlay plants in one scatter cell instead of (mode 'replace', and every row of
   * stripes) or besides (mode 'add') the biome's own pick, or -1. Steep ground keeps the biome's pick;
   * below WATER_LEVEL + 0.9 only mangroves may grow (down to their waterline).
   */
  function overlaySpecies(overlay, baseType, ix, iz, slope, height) {
    if (slope > 0.6) return baseType;
    let density;
    let replace;
    let choice;
    if (overlay.stripes !== null) {
      // Rows: one plant per cell along the middle half of each stripe; the gaps between stay bare.
      if (Math.abs(scatterOverlay.stripeOffset) > overlay.stripes.width * 0.25) return -1;
      density = 0.96;
      replace = true;
      choice = scatterOverlay.stripeSpecies;
    } else {
      const set = overlay.vegetation.species;
      density = overlay.vegetation.density;
      replace = overlay.vegetation.mode === 'replace';
      choice = set[Math.floor(hash2(ix, iz, 211) * set.length)];
    }
    const shore = height < WATER_LEVEL + 0.9;
    if (!replace && baseType >= 0 && !shore) return baseType;
    if (hash2(ix, iz, 210) >= density) return replace || shore ? -1 : baseType;
    if (shore && choice !== VEGETATION.MANGROVE) return -1;
    // Mangroves are a shore plant: up to a few metres above the sea, no higher.
    if (choice === VEGETATION.MANGROVE && height > WATER_LEVEL + 4) return -1;
    return choice;
  }

  /**
   * The vegetation of scatter cell (cellI, cellJ) of chunk (chunkX, chunkZ) at density (0..1),
   * written into cellInstance; returns false when the cell grows nothing. scatterChunk and
   * vegetationNear both read the world's scatter through it. Without overlays (or outside them) it
   * is the Phase 1 scatter exactly; inside an overlay with vegetation or stripes, the overlay picks
   * the species (overlaySpecies), and a plant whose species has a trunk collider ignores the density
   * gate, so the colliders never depend on the quality setting.
   */
  function scatterCell(chunkX, chunkZ, cellI, cellJ, density) {
    const ix = chunkX * SCATTER_CELLS_PER_SIDE + cellI;
    const iz = chunkZ * SCATTER_CELLS_PER_SIDE + cellJ;
    const culled = hash2(ix, iz, 201) > density;
    if (culled && !hasOverlays) return false;
    const localX = (cellI + 0.15 + 0.7 * hash2(ix, iz, 202)) * SCATTER_CELL;
    const localZ = (cellJ + 0.15 + 0.7 * hash2(ix, iz, 203)) * SCATTER_CELL;
    let x = chunkX * CHUNK_SIZE + localX;
    let z = chunkZ * CHUNK_SIZE + localZ;
    // Keep landmark grounds clear (stone circles, lighthouse islands, arch legs).
    const clearSite = landmarkSiteForCell(Math.floor(x / LANDMARK_CELL), Math.floor(z / LANDMARK_CELL));
    if (clearSite && clearSite.type !== 'balloons') {
      const clearRadius = clearSite.type === 'monoliths' ? 70 : clearSite.type === 'lighthouse' ? 40 : 70 + 25 * clearSite.variant;
      const clearX = x - clearSite.x;
      const clearZ = z - clearSite.z;
      if (clearX * clearX + clearZ * clearZ < clearRadius * clearRadius) return false;
    }
    let overlay = null;
    if (hasOverlays) {
      overlayAt(x, z, scatterOverlay);
      const planting = scatterOverlay.weight > 0 && (scatterOverlay.overlay.vegetation !== null || scatterOverlay.overlay.stripes !== null);
      if (planting && scatterOverlay.weight > hash2(ix, iz, 209)) overlay = scatterOverlay.overlay;
      else if (culled) return false;
    }
    const height = heightAt(x, z);
    if (height < WATER_LEVEL + 0.9) {
      const mangroveShore = overlay !== null && height >= WATER_LEVEL + MANGROVE.waterline
        && (overlay.vegetation !== null && overlay.vegetation.species.includes(VEGETATION.MANGROVE));
      if (!mangroveShore) return false;
    }
    // Nothing grows on painted stamp ground: ash, lava, wet rock, the runway or a riverbed.
    if (hasStamps && paintAt(x, z).weight > 0.35) return false;
    // ...nor in a lake or a pool.
    if (hasWaters && waterBodyAt(x, z) !== null) return false;
    const slope = Math.min(1, Math.hypot(heightAt(x + 2, z) - height, heightAt(x, z + 2) - height) / 2);
    climate(x, z, scatterClimate);
    biomeWeights(scatterClimate.temperature, scatterClimate.moisture, scatterWeights);
    let roll = hash2(ix, iz, 204);
    let biome = 4;
    for (let index = 0; index < 5; index++) {
      roll -= scatterWeights[index];
      if (roll <= 0) { biome = index; break; }
    }
    const snowLine = 140 + 640 * scatterClimate.temperature;
    const pick = hash2(ix, iz, 205);
    const forest = forestNoise(x, z);
    let type = -1;
    if (slope > 0.75) {
      if (pick < 0.05) type = VEGETATION.ROCK;
    } else if (biome === 0) {
      if (height > snowLine - 40) { if (pick < 0.06) type = VEGETATION.ROCK; }
      else if (forest > -0.1 && pick < 0.55) type = VEGETATION.PINE;
      else if (pick < 0.08) type = VEGETATION.ROCK;
    } else if (biome === 1) {
      if (height > snowLine) { if (pick < 0.05) type = VEGETATION.ROCK; }
      else if (slope > 0.6) { if (pick < 0.12) type = VEGETATION.ROCK; }
      else if (forest > -0.15) { if (pick < 0.85) type = VEGETATION.PINE; }
      else if (pick < 0.12) type = VEGETATION.BROADLEAF;
      else if (pick < 0.17) type = VEGETATION.ROCK;
    } else if (biome === 2) {
      if (slope > 0.45) { if (pick < 0.08) type = VEGETATION.ROCK; }
      else if (pick < 0.07) type = VEGETATION.CACTUS;
      else if (pick < 0.09) type = VEGETATION.ROCK;
    } else if (biome === 3) {
      if (height < WATER_LEVEL + 7) { if (pick < 0.32) type = VEGETATION.PALM; }
      else if (slope > 0.55) { if (pick < 0.1) type = VEGETATION.ROCK; }
      else if (pick < 0.6) type = pick < 0.18 ? VEGETATION.PALM : VEGETATION.BROADLEAF;
    } else {
      if (forest > 0.35 && pick < 0.6) type = VEGETATION.BROADLEAF;
      else if (flowerFieldNoise(x, z) > 0.1 && pick < 0.3) type = VEGETATION.FLOWERS;
      else if (pick < 0.05) type = VEGETATION.FLOWERS;
      else if (pick < 0.075) type = VEGETATION.BROADLEAF;
      else if (pick < 0.09) type = VEGETATION.ROCK;
    }
    if (overlay !== null) type = overlaySpecies(overlay, type, ix, iz, slope, height);
    if (type < 0) return false;
    const species = speciesById(type);
    if (culled && (species === null || species.trunk === null)) return false;
    const sizeRoll = hash2(ix, iz, 206);
    let scale;
    let rotation = hash2(ix, iz, 207) * Math.PI * 2;
    if (species !== null) {
      scale = (species.height[0] + (species.height[1] - species.height[0]) * sizeRoll) / species.referenceHeight;
      if (species.rows) {
        // Rows: onto the stripe's centre line, turned along it (a little jitter, either way round).
        x -= scatterOverlay.stripeOffset * overlay.stripes.acrossX;
        z -= scatterOverlay.stripeOffset * overlay.stripes.acrossZ;
        rotation = Math.PI / 2 - overlay.stripes.heading + (hash2(ix, iz, 212) - 0.5) * 0.08 + (sizeRoll < 0.5 ? 0 : Math.PI);
      }
    } else {
      scale = type === VEGETATION.PINE ? 0.75 + 0.7 * sizeRoll
        : type === VEGETATION.ROCK ? 0.5 + 1.4 * sizeRoll * sizeRoll
        : type === VEGETATION.FLOWERS ? 0.7 + 0.6 * sizeRoll
        : 0.7 + 0.6 * sizeRoll;
    }
    cellInstance[0] = x - chunkX * CHUNK_SIZE;
    cellInstance[1] = groundHeight(x, z);
    cellInstance[2] = z - chunkZ * CHUNK_SIZE;
    cellInstance[3] = scale;
    cellInstance[4] = rotation;
    cellInstance[5] = type;
    cellInstance[6] = hash2(ix, iz, 208);
    return true;
  }

  /**
   * Deterministic vegetation for chunk (chunkX, chunkZ). Returns a Float32Array
   * with SCATTER_STRIDE floats per instance:
   *   [localX, y, localZ, scale, rotationY, type, variant]
   * localX/localZ are relative to the chunk origin (chunkX*CHUNK_SIZE, chunkZ*CHUNK_SIZE);
   * y is world height of the LOD0 ground (groundHeight). density in [0, 1].
   */
  function scatterChunk(chunkX, chunkZ, density) {
    const values = [];
    for (let cellI = 0; cellI < SCATTER_CELLS_PER_SIDE; cellI++) {
      for (let cellJ = 0; cellJ < SCATTER_CELLS_PER_SIDE; cellJ++) {
        if (!scatterCell(chunkX, chunkZ, cellI, cellJ, density)) continue;
        values.push(cellInstance[0], cellInstance[1], cellInstance[2], cellInstance[3], cellInstance[4], cellInstance[5], cellInstance[6]);
      }
    }
    return new Float32Array(values);
  }

  const nearInstance = { type: 0, x: 0, y: 0, z: 0, scale: 0, rotation: 0, variant: 0 };

  /**
   * The scatter instances (at full density) within radius of (x, z), without building a chunk: the
   * trunk colliders, perches and petal emitters read them. visit(instance) gets one shared object
   * { type, x, y (the LOD0 ground under it), z, scale, rotation, variant } per instance (read it
   * before returning); instances come chunk by chunk, cell by cell, deterministically.
   */
  function vegetationNear(x, z, radius, visit) {
    const minChunkX = Math.floor((x - radius) / CHUNK_SIZE);
    const maxChunkX = Math.floor((x + radius) / CHUNK_SIZE);
    const minChunkZ = Math.floor((z - radius) / CHUNK_SIZE);
    const maxChunkZ = Math.floor((z + radius) / CHUNK_SIZE);
    // Rows move up to a quarter stripe off their cell: look one cell further.
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
        const originX = chunkX * CHUNK_SIZE;
        const originZ = chunkZ * CHUNK_SIZE;
        const firstI = Math.max(0, Math.floor((x - radius - originX) / SCATTER_CELL) - 1);
        const lastI = Math.min(SCATTER_CELLS_PER_SIDE - 1, Math.floor((x + radius - originX) / SCATTER_CELL) + 1);
        const firstJ = Math.max(0, Math.floor((z - radius - originZ) / SCATTER_CELL) - 1);
        const lastJ = Math.min(SCATTER_CELLS_PER_SIDE - 1, Math.floor((z + radius - originZ) / SCATTER_CELL) + 1);
        for (let cellI = firstI; cellI <= lastI; cellI++) {
          for (let cellJ = firstJ; cellJ <= lastJ; cellJ++) {
            if (!scatterCell(chunkX, chunkZ, cellI, cellJ, 1)) continue;
            const instanceX = originX + cellInstance[0];
            const instanceZ = originZ + cellInstance[2];
            const dx = instanceX - x;
            const dz = instanceZ - z;
            if (dx * dx + dz * dz > radius * radius) continue;
            nearInstance.type = cellInstance[5];
            nearInstance.x = instanceX;
            nearInstance.y = cellInstance[1];
            nearInstance.z = instanceZ;
            nearInstance.scale = cellInstance[3];
            nearInstance.rotation = cellInstance[4];
            nearInstance.variant = cellInstance[6];
            visit(nearInstance);
          }
        }
      }
    }
  }

  // ---- Landmark queries ---------------------------------------------------------
  /** All landmark sites whose cell overlaps the circle (x, z, radius). */
  function landmarkSitesNear(x, z, radius) {
    const minCellX = Math.floor((x - radius) / LANDMARK_CELL);
    const maxCellX = Math.floor((x + radius) / LANDMARK_CELL);
    const minCellZ = Math.floor((z - radius) / LANDMARK_CELL);
    const maxCellZ = Math.floor((z + radius) / LANDMARK_CELL);
    const sites = [];
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const site = landmarkSiteForCell(cellX, cellZ);
        if (site && Math.hypot(site.x - x, site.z - z) <= radius) sites.push(site);
      }
    }
    return sites;
  }

  // ---- Search helpers (copilot "find ...") ------------------------------------------
  /**
   * Nearest point to (x, z) matching target, searching outward in rings.
   * target: 'snow' | 'pine' | 'dunes' | 'archipelago' | 'meadows' | 'ocean' | 'mountains'
   * Returns { x, z, distance } or null if nothing within maxRadius.
   */
  function findNearest(x, z, target, maxRadius) {
    const limit = maxRadius || 24000;
    const probeClimate = { temperature: 0, moisture: 0 };
    const probeWeights = new Float64Array(5);
    const biomeTarget = target === 'mountains' ? 0 : target === 'ocean' ? 3 : BIOMES.findIndex((biome) => biome.key === target);
    if (biomeTarget < 0) return null;
    for (let radius = 250; radius <= limit; radius += 300) {
      const samples = Math.max(12, Math.ceil((2 * Math.PI * radius) / 300));
      const phase = hash2(Math.floor(radius), 0, 301) * Math.PI * 2;
      for (let sample = 0; sample < samples; sample++) {
        const angle = phase + (sample / samples) * Math.PI * 2;
        const px = x + Math.sin(angle) * radius;
        const pz = z - Math.cos(angle) * radius;
        climate(px, pz, probeClimate);
        biomeWeights(probeClimate.temperature, probeClimate.moisture, probeWeights);
        if (probeWeights[biomeTarget] < 0.6) continue;
        if (target === 'ocean' && heightAt(px, pz) > WATER_LEVEL - 6) continue;
        if (target === 'mountains' && heightAt(px, pz) < 320) continue;
        return { x: px, z: pz, distance: radius };
      }
    }
    return null;
  }

  return {
    seed: String(seedString).toUpperCase(),
    seedHash,
    BIOMES,
    PALETTES_SRGB,
    VEGETATION,
    LANDMARK_TYPES,
    SCATTER_STRIDE,
    GRID_STEP,
    WATER_LEVEL,
    CHUNK_SIZE,
    LANDMARK_CELL,
    SITE_CELL,
    hash2,
    noise,
    fbm,
    climate,
    biomeWeights,
    heightAt,
    unstampedHeightAt,
    groundHeight,
    biomeAt,
    faceColor,
    placement,
    hasStamps,
    sitesInCell: placement.sitesInCell,
    sitesNear: placement.sitesNear,
    stampsInCell: placement.stampsInCell,
    stampsOverlap: placement.stampsOverlap,
    stampInfluence,
    hasWaters,
    hasOverlays,
    prevailingWindAngle: PREVAILING_WIND_ANGLE,
    watersInCell: placement.watersInCell,
    overlaysInCell: placement.overlaysInCell,
    watersAt,
    waterBodyAt,
    waterBodiesNear,
    overlaysNear,
    overlayAt,
    createOverlaySample,
    faceOverlay,
    forestNoise,
    scatterChunk,
    vegetationNear,
    landmarkSiteForCell,
    landmarkSitesNear,
    findNearest,
  };
}
