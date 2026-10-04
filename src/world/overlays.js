// Region overlays: deterministic, region-scoped overrides of the ground's look (contract section d).
//
// A site preset may declare `overlays`; placement (placement.js) resolves them per site, after its
// waters and from the same per-site seed stream, into world-space records kept with the site. An
// overlay NEVER changes height: it only overrides, inside its shape, the vertex colour palette, the
// vegetation species set, the surface material (ice) and an animated tint sweep, plus static
// stripes (lavender and tulip rows). Worlds without overlay sites are bit-identical to Phase 2.
//
// Spec fields (pure data in the preset):
//   shape       { kind: 'disc', radius, falloff, offset? } | { kind: 'ellipse', radius, aspect (0.15..1,
//               minor / major), angle (deg, added to the site rotation), falloff, offset? } |
//               { kind: 'stamp', stamp (index), grow (m beyond its footprint), falloff }. Sizes may
//               be [min, max] ranges (rolled per site); the falloff lies inside the radius
//   palette     null or a name from OVERLAY_PALETTES
//   vegetation  null or { species: [names from VEGETATION_SPECIES], density (0..1), mode: 'replace' | 'add' }
//   material    null | 'ice' (glossy icy ground)
//   tintSweep   null or { colors: [hex, hex], periodSeconds, direction: 'downwind' | <deg compass>,
//               width (m, the colour wave's length) }
//   stripes     null or { width (m), angle: 'ridge' | <deg compass>, colors: [hex, ...], species: [names] }
//               ('ridge' follows the site's rotation, which an align 'ridge' preset lays along it)
//   priority    overlapping overlays: the higher priority wins, then the lower site id
//
// Pure: imports stamps.js and vegetationSpecies.js only, no DOM, so the terrain worker runs it too.
import { stampFootprintDistance } from './stamps.js';
import { SPECIES_NAMES, speciesByName } from './vegetationSpecies.js';

export const OVERLAY_SHAPES = Object.freeze(['disc', 'ellipse', 'stamp']);
export const OVERLAY_MATERIALS = Object.freeze(['ice']);
/** Material ids in the chunk `overlay` attribute (z): 0 none, 1 ice. */
export const OVERLAY_MATERIAL_ID = Object.freeze({ none: 0, ice: 1 });
export const OVERLAY_VEGETATION_MODES = Object.freeze(['replace', 'add']);
/** Tint sweeps share this many colour slots in the terrain shader (see sweepSlot). */
export const OVERLAY_SWEEP_SLOTS = 8;
/** The largest sweep weight baked (x = slot + weight keeps the slot in the integer part). */
export const OVERLAY_SWEEP_WEIGHT_MAX = 0.998;

const SPEC_FIELDS = Object.freeze(['shape', 'palette', 'vegetation', 'material', 'tintSweep', 'stripes', 'priority']);
const BIOME_KEYS = Object.freeze(['snow', 'pine', 'dunes', 'archipelago', 'meadows']);
const DEG = Math.PI / 180;

/**
 * Named ground palettes (sRGB hex): six colours [ground dark, ground, ground light, accent 1,
 * accent 2, accent 3], with optional per-biome lists that replace them in that biome. Worldgen picks
 * among the three ground shades with the same patch field as the biome palettes and scatters the
 * accents over single faces.
 */
export const OVERLAY_PALETTES = Object.freeze({
  cherryBlossom: Object.freeze({ base: Object.freeze([0x7da454, 0x93b360, 0xd9a3b5, 0xf2b8c9, 0xf7d2dc, 0x8a6b55]) }),
  autumnForest: Object.freeze({ base: Object.freeze([0x8a5a2b, 0xa4682a, 0xb98a3a, 0xc0392b, 0xe67e22, 0x6b4a2e]) }),
  lavenderFields: Object.freeze({ base: Object.freeze([0x6f7f4a, 0x7d8c50, 0x8b7a5a, 0x9b7fd0, 0xb79be0, 0x7a6248]) }),
  tulipFields: Object.freeze({ base: Object.freeze([0x6f9a45, 0x82aa4e, 0x7a6a48, 0xd8443a, 0xf2c94c, 0xf08ab0]) }),
  redwoodForest: Object.freeze({ base: Object.freeze([0x3f5230, 0x4c6236, 0x6b4a32, 0x7a5236, 0x5a6b3a, 0x8a5a3c]) }),
  bambooGrove: Object.freeze({ base: Object.freeze([0x6f8f3e, 0x86a848, 0x9cba5a, 0xa8c46a, 0x5f7a36, 0x7a6a44]) }),
  saguaroDesert: Object.freeze({ base: Object.freeze([0xd6a874, 0xc79560, 0xe0bf8e, 0x9c7b4e, 0xb88456, 0xa8583a]) }),
  mangrove: Object.freeze({ base: Object.freeze([0x4f5a3a, 0x5d6b40, 0x6f7a4a, 0x3f4a34, 0x7a6f52, 0x55603e]) }),
  frozen: Object.freeze({
    base: Object.freeze([0xc9d9e8, 0xdfe9f2, 0xeef4fa, 0xb5cde0, 0xa9cde0, 0xf7fafd]),
    dunes: Object.freeze([0xd8dde2, 0xe6eaee, 0xf2f4f6, 0xc8d2dc, 0xb9c9d8, 0xf8f9fa]),
  }),
  saltFlat: Object.freeze({ base: Object.freeze([0xe8e2d4, 0xf1ece0, 0xf7f4ec, 0xdcd5c4, 0xe2dccb, 0xcfc6b2]) }),
});

function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function isSize(value) {
  if (isNumber(value)) return value >= 0;
  return Array.isArray(value) && value.length === 2 && value.every((entry) => isNumber(entry) && entry >= 0) && value[0] <= value[1];
}
function maxOf(value) { return Array.isArray(value) ? value[1] : value; }
function roll(value, random) { return Array.isArray(value) ? value[0] + (value[1] - value[0]) * random() : value; }
function isHex(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffff; }
function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }
function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function srgbToLinear(channel) {
  return channel < 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}
/** sRGB hex to a linear [r, g, b] triple (the vertex colour space). */
export function hexToLinear(hex) {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

function checkSpecies(list, where) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where}: must be a non-empty array of species names`);
  for (const name of list) {
    if (!SPECIES_NAMES.includes(name)) throw new Error(`${where}: "${name}" is not one of ${SPECIES_NAMES.join(', ')}`);
  }
}

function checkOffset(offset, where) {
  if (offset === undefined) return;
  if (offset === null || typeof offset !== 'object' || !Number.isFinite(offset.along ?? 0) || !Number.isFinite(offset.across ?? 0)) {
    throw new Error(`${where}: must be { along, across } in metres`);
  }
}

/**
 * Checks one overlay spec against the preset's stamp specs; throws an Error naming the preset, the
 * overlay and the field. where: a label such as 'preset "cherryValley" overlays[0]'.
 */
export function validateOverlaySpec(spec, stampSpecs, where) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${where}: an overlay must be an object`);
  for (const key of Object.keys(spec)) {
    if (!SPEC_FIELDS.includes(key)) throw new Error(`${where}.${key}: unknown field (known: ${SPEC_FIELDS.join(', ')})`);
  }
  const shape = spec.shape;
  if (shape === null || typeof shape !== 'object') throw new Error(`${where}.shape: must be an object`);
  if (!OVERLAY_SHAPES.includes(shape.kind)) throw new Error(`${where}.shape.kind: "${shape.kind}" is not one of ${OVERLAY_SHAPES.join(', ')}`);
  if (!isSize(shape.falloff)) throw new Error(`${where}.shape.falloff: must be a number >= 0 or an ascending [min, max] range`);
  if (shape.kind === 'stamp') {
    if (!Number.isInteger(shape.stamp) || shape.stamp < 0 || shape.stamp >= stampSpecs.length) throw new Error(`${where}.shape.stamp: must be the index of one of the preset's ${stampSpecs.length} stamps`);
    if (shape.grow !== undefined && !isSize(shape.grow)) throw new Error(`${where}.shape.grow: must be a number >= 0 or an ascending [min, max] range`);
  } else {
    if (!isSize(shape.radius) || !(maxOf(shape.radius) > 0)) throw new Error(`${where}.shape.radius: must be a positive number or an ascending [min, max] range`);
    if (maxOf(shape.falloff) > (Array.isArray(shape.radius) ? shape.radius[0] : shape.radius)) throw new Error(`${where}.shape.falloff: must not exceed the radius (it lies inside it)`);
    checkOffset(shape.offset, `${where}.shape.offset`);
  }
  if (shape.kind === 'ellipse') {
    if (!(isNumber(shape.aspect) && shape.aspect >= 0.15 && shape.aspect <= 1)) throw new Error(`${where}.shape.aspect: must be a number in [0.15, 1]`);
    if (shape.angle !== undefined && !isNumber(shape.angle)) throw new Error(`${where}.shape.angle: must be a number of degrees`);
  }
  if (spec.palette !== undefined && spec.palette !== null && !Object.hasOwn(OVERLAY_PALETTES, spec.palette)) {
    throw new Error(`${where}.palette: "${spec.palette}" is not one of ${Object.keys(OVERLAY_PALETTES).join(', ')} (or null)`);
  }
  const vegetation = spec.vegetation;
  if (vegetation !== undefined && vegetation !== null) {
    if (typeof vegetation !== 'object') throw new Error(`${where}.vegetation: must be null or { species, density, mode }`);
    checkSpecies(vegetation.species, `${where}.vegetation.species`);
    if (!(isNumber(vegetation.density) && vegetation.density >= 0 && vegetation.density <= 1)) throw new Error(`${where}.vegetation.density: must be a number in [0, 1]`);
    if (!OVERLAY_VEGETATION_MODES.includes(vegetation.mode)) throw new Error(`${where}.vegetation.mode: must be one of ${OVERLAY_VEGETATION_MODES.join(', ')}`);
  }
  if (spec.material !== undefined && spec.material !== null && !OVERLAY_MATERIALS.includes(spec.material)) {
    throw new Error(`${where}.material: must be null or one of ${OVERLAY_MATERIALS.join(', ')}`);
  }
  const sweep = spec.tintSweep;
  if (sweep !== undefined && sweep !== null) {
    if (typeof sweep !== 'object') throw new Error(`${where}.tintSweep: must be null or an object`);
    if (!Array.isArray(sweep.colors) || sweep.colors.length !== 2 || !sweep.colors.every(isHex)) throw new Error(`${where}.tintSweep.colors: must be two sRGB hex colours`);
    if (!(isNumber(sweep.periodSeconds) && sweep.periodSeconds >= 10)) throw new Error(`${where}.tintSweep.periodSeconds: must be a number of seconds >= 10`);
    if (sweep.direction !== 'downwind' && !isNumber(sweep.direction)) throw new Error(`${where}.tintSweep.direction: must be 'downwind' or a compass heading in degrees`);
    if (!(isNumber(sweep.width) && sweep.width >= 20)) throw new Error(`${where}.tintSweep.width: must be a number of metres >= 20`);
  }
  const stripes = spec.stripes;
  if (stripes !== undefined && stripes !== null) {
    if (typeof stripes !== 'object') throw new Error(`${where}.stripes: must be null or an object`);
    if (!(isNumber(stripes.width) && stripes.width >= 4)) throw new Error(`${where}.stripes.width: must be a number of metres >= 4`);
    if (stripes.angle !== 'ridge' && !isNumber(stripes.angle)) throw new Error(`${where}.stripes.angle: must be 'ridge' or a compass heading in degrees`);
    if (!Array.isArray(stripes.colors) || stripes.colors.length < 2 || !stripes.colors.every(isHex)) throw new Error(`${where}.stripes.colors: must be two or more sRGB hex colours`);
    checkSpecies(stripes.species, `${where}.stripes.species`);
  }
  if (spec.priority !== undefined && !isNumber(spec.priority)) throw new Error(`${where}.priority: must be a number`);
}

/** The farthest an overlay spec can reach from its site centre (m), for placement's cell lists. */
export function overlayReach(spec, stampReachOf) {
  const shape = spec.shape;
  if (shape.kind === 'stamp') return stampReachOf(shape.stamp) + maxOf(shape.grow ?? 0) + maxOf(shape.falloff);
  const offset = shape.offset ? Math.hypot(shape.offset.along ?? 0, shape.offset.across ?? 0) : 0;
  return offset + maxOf(shape.radius);
}

/** The compass heading (deg) as a unit direction { x, z } (0 north = -z, 90 east = +x). */
function compassDirection(degrees) {
  const radians = degrees * DEG;
  return { x: Math.sin(radians), z: -Math.cos(radians) };
}

/**
 * The sweep colour slot of an overlay (0 .. OVERLAY_SWEEP_SLOTS - 1): a hash of its id, so both
 * threads bake the same slot and the terrain system fills that slot's colours from the overlay.
 */
export function sweepSlot(id) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  return hash % OVERLAY_SWEEP_SLOTS;
}

function resolvePalette(name) {
  if (!name) return null;
  const source = OVERLAY_PALETTES[name];
  // Per biome: six linear colours (18 floats), the biome's own list or the base one.
  return Object.freeze(BIOME_KEYS.map((biome) => {
    const list = source[biome] ?? source.base;
    const linear = new Float32Array(18);
    list.forEach((hex, index) => linear.set(hexToLinear(hex), index * 3));
    return linear;
  }));
}

function speciesIds(names) {
  return Object.freeze(names.map((name) => speciesByName(name).id));
}

/**
 * Resolves a site's overlay specs into frozen world-space records (spec order). site: the site
 * record (id, x, z, rotation); stamps: its resolved stamps; random(index): a seeded () => [0, 1)
 * stream for overlay spec `index`; seedFor(index) its uint32 seed; windAngle: the world's prevailing
 * downwind direction (radians, the WindField's windDirection = (cos, sin) in x, z).
 */
export function resolveOverlays(site, specs, stamps, random, seedFor, windAngle) {
  return Object.freeze(specs.map((spec, index) => {
    const stream = random(index);
    const shape = spec.shape;
    const falloff = roll(shape.falloff, stream);
    let resolvedShape;
    let bounds;
    if (shape.kind === 'stamp') {
      const stamp = stamps[shape.stamp];
      const grow = roll(shape.grow ?? 0, stream);
      resolvedShape = { kind: 'stamp', stamp, grow, falloff, x: stamp.x, z: stamp.z };
      const reach = grow + falloff;
      bounds = { minX: stamp.minX - reach, maxX: stamp.maxX + reach, minZ: stamp.minZ - reach, maxZ: stamp.maxZ + reach };
    } else {
      const radius = roll(shape.radius, stream);
      const dirX = Math.sin(site.rotation);
      const dirZ = -Math.cos(site.rotation);
      const along = shape.offset ? shape.offset.along ?? 0 : 0;
      const across = shape.offset ? shape.offset.across ?? 0 : 0;
      const x = site.x + dirX * along - dirZ * across;
      const z = site.z + dirZ * along + dirX * across;
      const angle = site.rotation + (shape.kind === 'ellipse' ? (shape.angle ?? 0) * DEG : 0);
      resolvedShape = {
        kind: shape.kind, x, z, radius, falloff,
        aspect: shape.kind === 'ellipse' ? shape.aspect : 1,
        axisX: Math.sin(angle), axisZ: -Math.cos(angle),
      };
      bounds = { minX: x - radius - 1, maxX: x + radius + 1, minZ: z - radius - 1, maxZ: z + radius + 1 };
    }
    const id = `${site.id}:o${index}`;
    const vegetation = spec.vegetation
      ? Object.freeze({ species: speciesIds(spec.vegetation.species), density: spec.vegetation.density, mode: spec.vegetation.mode })
      : null;
    let tintSweep = null;
    if (spec.tintSweep) {
      const direction = spec.tintSweep.direction === 'downwind' ? { x: Math.cos(windAngle), z: Math.sin(windAngle) } : compassDirection(spec.tintSweep.direction);
      tintSweep = Object.freeze({
        slot: sweepSlot(id),
        colors: Object.freeze(spec.tintSweep.colors.map(hexToLinear)),
        hex: Object.freeze(spec.tintSweep.colors.slice()),
        periodSeconds: spec.tintSweep.periodSeconds,
        width: spec.tintSweep.width,
        dirX: direction.x,
        dirZ: direction.z,
      });
    }
    let stripes = null;
    if (spec.stripes) {
      // Rows run along `angle`; stripes are counted across them.
      const along = spec.stripes.angle === 'ridge' ? { x: Math.sin(site.rotation), z: -Math.cos(site.rotation) } : compassDirection(spec.stripes.angle);
      stripes = Object.freeze({
        width: spec.stripes.width,
        alongX: along.x,
        alongZ: along.z,
        acrossX: -along.z,
        acrossZ: along.x,
        heading: Math.atan2(along.x, -along.z),
        colors: Object.freeze(spec.stripes.colors.map(hexToLinear)),
        hex: Object.freeze(spec.stripes.colors.slice()),
        species: speciesIds(spec.stripes.species),
      });
    }
    return Object.freeze({
      id,
      siteId: site.id,
      presetId: site.presetId,
      index,
      x: resolvedShape.x,
      z: resolvedShape.z,
      bounds: Object.freeze(bounds),
      shape: Object.freeze(resolvedShape),
      palette: resolvePalette(spec.palette ?? null),
      paletteName: spec.palette ?? null,
      vegetation,
      material: spec.material ?? null,
      materialId: spec.material === 'ice' ? OVERLAY_MATERIAL_ID.ice : OVERLAY_MATERIAL_ID.none,
      tintSweep,
      stripes,
      priority: spec.priority ?? 0,
      seed: seedFor(index),
    });
  }));
}

/** An overlay's weight at (x, z): 1 inside, easing to 0 over its falloff at the edge; 0 outside. */
export function overlayWeight(record, x, z) {
  const bounds = record.bounds;
  if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) return 0;
  const shape = record.shape;
  if (shape.kind === 'stamp') {
    const distance = stampFootprintDistance(shape.stamp, x, z);
    return 1 - smoothstep(shape.grow, shape.grow + shape.falloff, distance);
  }
  const dx = x - shape.x;
  const dz = z - shape.z;
  let distance;
  if (shape.kind === 'disc') distance = Math.sqrt(dx * dx + dz * dz);
  else {
    const along = dx * shape.axisX + dz * shape.axisZ;
    const across = (dx * -shape.axisZ + dz * shape.axisX) / shape.aspect;
    distance = Math.sqrt(along * along + across * across);
  }
  if (distance >= shape.radius) return 0;
  return 1 - smoothstep(shape.radius - shape.falloff, shape.radius, distance);
}

/**
 * The stripe index at (x, z) of an overlay with stripes (rows counted across the row direction from
 * the overlay's centre; may be negative), and the across offset (m) from that stripe's centre line.
 */
export function stripeAt(record, x, z, out) {
  const stripes = record.stripes;
  const across = (x - record.x) * stripes.acrossX + (z - record.z) * stripes.acrossZ;
  const index = Math.floor(across / stripes.width);
  out.index = index;
  out.offset = across - (index + 0.5) * stripes.width;
  return out;
}

/** The sweep phase (m along the sweep direction from the overlay's centre) at (x, z). */
export function sweepPhase(record, x, z) {
  const sweep = record.tintSweep;
  return (x - record.x) * sweep.dirX + (z - record.z) * sweep.dirZ;
}

/** One line of the site-list hash per overlay: id, priority and bounds to 1 cm. */
export function overlayHashLine(record) {
  const b = record.bounds;
  return `${record.id}^${record.priority}[${Math.round(b.minX * 100)},${Math.round(b.maxX * 100)},${Math.round(b.minZ * 100)},${Math.round(b.maxZ * 100)}]`;
}
