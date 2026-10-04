// Terrain stamps: deterministic height edits that sites make to the shared height function.
//
// A site preset lists stamp SPECS (sizes as numbers or [min, max] ranges, in metres). Placement
// (placement.js) resolves each spec once per site into a RESOLVED stamp: plain world-space geometry
// (centre, rotation, sizes, reference heights, bounds, paint). worldgen.heightAt then applies the
// resolved stamps after the Phase 1 landmark shaping, so the terrain meshes of every LOD ring, the
// skirts and the collision height (groundHeight) all see the same edited surface.
//
// Every stamp has a smooth falloff and changes nothing outside its bounds (an axis-aligned box that
// placement's spatial hash uses), so the edit blends into the terrain around it. A resolved stamp whose
// `fits` is false cannot shape the ground it landed on (a canyon path crossing a ridge far higher
// than its rim), and placement drops that site.
//
// Pure: no imports and no DOM, so the terrain worker runs exactly this code too.
// Axes: +x east, -z north. A stamp's `rotation` is a compass heading in radians (0 = north,
// clockwise), its forward axis is (dirX, dirZ) = (sin r, -cos r) and its right axis is (-dirZ, dirX).
//
// Spec fields per type (every size may be a [min, max] range; placement rolls it per site):
//   common      offset { along, across } (m, in the site frame), rotation (radians, added to the
//               site's), paint (see STAMP_PAINTS; each type has a default, null for none)
//   cone        radius, height, craterRadius, craterDepth, gullies (count)            paint 'ash'
//   carve       length (2-4 km), width (floor), depth, wallWidth, twist (meander, m), plateau (the
//               mesa band beyond each wall), shoulder (its falloff), segments      paint 'riverbed'
//   cliffStep   width (along the lip), drop, length (upstream + downstream), face, falloff,
//               pool (plunge pool radius)                                         paint 'wetRock'
//   gorge       length, width (top), depth, falloff (end taper), pad (anchor pads) paint 'riverbed'
//   flatten     length, width (the strip), margin (flat apron), shoulder (falloff) paint 'tarmac'
//   islandBase  radius, height (above the water), falloff                          paint 'basalt'
//   basin       radius (the lake bowl), depth (rim to floor), rim (berm width), falloff  paint 'sand'
//   crater      radius (rim crest), depth (rim to floor), rimHeight (above the ground around),
//               rimWidth (outer flank), floor (flat floor share of the radius, 0..0.8)  paint 'ash'
//   terraces    length (downhill), width, steps (shelf count), lip (pool rim height), falloff
//                                                                                 paint 'travertine'
// The basin, crater and terraces hold water: a preset's `waters` list (waters.js) fills them, and
// their resolved records carry the reference heights the water levels are measured from (floorY,
// rimY; the terraces' shelves).

export const STAMP_TYPES = Object.freeze(['cone', 'carve', 'cliffStep', 'gorge', 'flatten', 'islandBase', 'basin', 'crater', 'terraces']);
export const STAMP_PAINTS = Object.freeze(['ash', 'basalt', 'wetRock', 'tarmac', 'riverbed', 'salt', 'sand', 'travertine', 'mud', 'ice']);

const KIND = Object.freeze({ cone: 0, carve: 1, cliffStep: 2, gorge: 3, flatten: 4, islandBase: 5, basin: 6, crater: 7, terraces: 8 });
const PAINT_INDEX = Object.freeze({ ash: 0, basalt: 1, wetRock: 2, tarmac: 3, riverbed: 4, salt: 5, sand: 6, travertine: 7, mud: 8, ice: 9 });
const TAU = Math.PI * 2;
/** A canyon may cut at most this many depths below the ground on its path, and lift it at most this many. */
const MAX_CANYON_CUT = 3;
const MAX_CANYON_LIFT = 1.2;
/** An islet's outline swings between 1 - ISLAND_LOBE_MAX and 1 + ISLAND_LOBE_MAX of its radius (3 and 7 lobes). */
const ISLAND_LOBE_MAX = 0.2;
/** A basin's shoreline swings between 1 - BASIN_LOBE_MAX and 1 + BASIN_LOBE_MAX of its radius (3 and 5 lobes). */
const BASIN_LOBE_MAX = 0.14;
/** A basin fits only where its berm lifts the lowest rim ground at most this many depths (and at least 36 m is allowed). */
const BASIN_MAX_LIFT = 2.2;
/** ...and where it cuts at most this many depths below the highest ground inside its rim. */
const BASIN_MAX_CUT = 4;
/** The rim crest sits this far (m) above the highest ground sampled on the rim. */
const BASIN_FREEBOARD = 1.5;
/** Terraces fit only on slopes that drop at least this much (m) per shelf, and at most TERRACE_MAX_DROP. */
const TERRACE_MIN_DROP = 1.5;
const TERRACE_MAX_DROP = 26;
/** Shares of a terrace step (0 uphill .. 1 downhill): the pool floor, the lip crest, then the riser. */
const TERRACE_POOL_END = 0.68;
const TERRACE_LIP_END = 0.8;
/** The flat side walls that close a terrace's pools (m, inside the width). */
const TERRACE_SIDE_WALL = 6;
/** A gorge fits only where the ground at both bridge anchors lies within this of its rim (m). */
const GORGE_ANCHOR_TOLERANCE = 14;
/** The waterfall lip's largest wander (m) and the gorge wall's (m). */
const LIP_AMPLITUDE = 7.5;
const GORGE_WOBBLE = 6;
/** The canyon's segment grid: cells of this size (m) list, as a bit mask, the segments near them. */
const CARVE_GRID = 64;
/** Per-segment scratch of the canyon's two passes (segments are validated to at most 32). */
const carveCutFloor = new Float64Array(32);
const carveCutShare = new Float64Array(32);

/** Defaults per type: the sizes a preset may leave out. */
const DEFAULTS = Object.freeze({
  cone: Object.freeze({ radius: [900, 1300], height: [320, 480], craterRadius: [150, 220], craterDepth: [70, 120], gullies: [6, 9], paint: 'ash' }),
  carve: Object.freeze({ length: [2000, 3200], width: [34, 56], depth: [70, 120], wallWidth: [18, 30], twist: [180, 380], plateau: [40, 80], shoulder: [110, 170], segments: 14, paint: 'riverbed' }),
  cliffStep: Object.freeze({ width: [280, 420], drop: [80, 140], length: [420, 620], face: [8, 14], falloff: [120, 180], pool: [45, 70], paint: 'wetRock' }),
  gorge: Object.freeze({ length: [700, 1100], width: [80, 130], depth: [80, 120], falloff: [150, 220], pad: [60, 90], paint: 'riverbed' }),
  flatten: Object.freeze({ length: [1100, 1500], width: [40, 60], margin: [30, 55], shoulder: [100, 170], paint: 'tarmac' }),
  islandBase: Object.freeze({ radius: [140, 240], height: [20, 45], falloff: [80, 130], paint: 'basalt' }),
  basin: Object.freeze({ radius: [180, 320], depth: [14, 24], rim: [30, 50], falloff: [80, 130], paint: 'sand' }),
  crater: Object.freeze({ radius: [320, 520], depth: [60, 110], rimHeight: [25, 45], rimWidth: [180, 300], floor: [0.25, 0.45], paint: 'ash' }),
  terraces: Object.freeze({ length: [320, 520], width: [140, 240], steps: [5, 8], lip: [1.2, 2.4], falloff: [60, 110], paint: 'travertine' }),
});

/** Every size field per type, validated as a positive number or an ascending [min, max] range. */
const SIZE_FIELDS = Object.freeze({
  cone: ['radius', 'height', 'craterRadius', 'craterDepth', 'gullies'],
  carve: ['length', 'width', 'depth', 'wallWidth', 'twist', 'plateau', 'shoulder'],
  cliffStep: ['width', 'drop', 'length', 'face', 'falloff', 'pool'],
  gorge: ['length', 'width', 'depth', 'falloff', 'pad'],
  flatten: ['length', 'width', 'margin', 'shoulder'],
  islandBase: ['radius', 'height', 'falloff'],
  basin: ['radius', 'depth', 'rim', 'falloff'],
  crater: ['radius', 'depth', 'rimHeight', 'rimWidth', 'floor'],
  terraces: ['length', 'width', 'steps', 'lip', 'falloff'],
});

function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }
function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * sin(count * angle + phase) from the angle's cosine and sine (no atan2): the complex power
 * (cos + i sin)^count rotated by the phase. count is a small whole number.
 */
function angularWave(cosAngle, sinAngle, count, cosPhase, sinPhase) {
  let real = 1;
  let imaginary = 0;
  for (let step = 0; step < count; step++) {
    const nextReal = real * cosAngle - imaginary * sinAngle;
    imaginary = real * sinAngle + imaginary * cosAngle;
    real = nextReal;
  }
  return imaginary * cosPhase + real * sinPhase;
}

/**
 * A wave sampled every metre over [0, length] (plus one spare sample): a lookup table the hot path
 * interpolates linearly instead of calling Math.sin per height sample. Linear interpolation keeps
 * the height continuous.
 */
function buildWaveTable(length, wave) {
  const table = new Float64Array(Math.ceil(length) + 2);
  for (let index = 0; index < table.length; index++) table[index] = wave(index);
  return table;
}

/** Linear lookup in a buildWaveTable table at `position` metres (clamped to the table). */
function sampleWave(table, position) {
  const last = table.length - 1;
  if (position <= 0) return table[0];
  if (position >= last) return table[last];
  const index = Math.floor(position);
  return table[index] + (table[index + 1] - table[index]) * (position - index);
}

/**
 * The non-increasing sequence closest (least squares) to `values` (pool adjacent violators): a
 * river floor that only runs downhill while following the terrain as closely as it can.
 */
function fitNonIncreasing(values) {
  const levels = [];
  const counts = [];
  for (let index = values.length - 1; index >= 0; index--) {
    levels.push(values[index]);
    counts.push(1);
    while (levels.length > 1 && levels[levels.length - 2] > levels[levels.length - 1]) {
      const count = counts.pop();
      const level = levels.pop();
      const total = counts[counts.length - 1] + count;
      levels[levels.length - 1] = (levels[levels.length - 1] * counts[counts.length - 1] + level * count) / total;
      counts[counts.length - 1] = total;
    }
  }
  const fitted = new Float64Array(values.length);
  let index = values.length - 1;
  for (let block = 0; block < levels.length; block++) {
    for (let repeat = 0; repeat < counts[block]; repeat++) fitted[index--] = levels[block];
  }
  return fitted;
}

function isSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  return Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isFinite(entry) && entry >= 0) && value[0] <= value[1];
}
function maxOf(value) { return Array.isArray(value) ? value[1] : value; }
function minOf(value) { return Array.isArray(value) ? value[0] : value; }
function roll(value, random) {
  if (!Array.isArray(value)) return value;
  return value[0] + (value[1] - value[0]) * random();
}

/** The spec with the type's defaults filled in (the spec's own fields win). */
function withDefaults(spec) {
  return { ...DEFAULTS[spec.type], ...spec };
}

/**
 * Checks one stamp spec; throws an Error naming the preset, the stamp and the field.
 * where: a label such as 'preset "volcano" stamps[0]'.
 */
export function validateStampSpec(spec, where) {
  if (spec === null || typeof spec !== 'object') throw new Error(`${where}: a stamp must be an object`);
  if (!STAMP_TYPES.includes(spec.type)) throw new Error(`${where}.type: "${spec.type}" is not one of ${STAMP_TYPES.join(', ')}`);
  for (const field of SIZE_FIELDS[spec.type]) {
    if (spec[field] !== undefined && !isSize(spec[field])) throw new Error(`${where}.${field}: must be a number >= 0 or an ascending [min, max] range`);
  }
  if (spec.paint !== undefined && spec.paint !== null && !STAMP_PAINTS.includes(spec.paint)) {
    throw new Error(`${where}.paint: "${spec.paint}" is not one of ${STAMP_PAINTS.join(', ')} (or null)`);
  }
  if (spec.offset !== undefined) {
    const offset = spec.offset;
    if (offset === null || typeof offset !== 'object' || !Number.isFinite(offset.along ?? 0) || !Number.isFinite(offset.across ?? 0)) {
      throw new Error(`${where}.offset: must be { along, across } in metres`);
    }
  }
  if (spec.rotation !== undefined && !Number.isFinite(spec.rotation)) throw new Error(`${where}.rotation: must be a number (radians)`);
  if (spec.type === 'carve' && spec.segments !== undefined && !(Number.isInteger(spec.segments) && spec.segments >= 4 && spec.segments <= 32)) {
    throw new Error(`${where}.segments: must be an integer from 4 to 32`);
  }
  const full = withDefaults(spec);
  if (spec.type === 'cone' && maxOf(full.craterRadius) >= maxOf(full.radius) * 0.6) throw new Error(`${where}.craterRadius: must stay under 60 % of the radius`);
  if (spec.type === 'crater' && maxOf(full.floor) > 0.8) throw new Error(`${where}.floor: must stay at or under 0.8 of the radius`);
  if (spec.type === 'terraces' && !(minOf(full.steps) >= 2 && maxOf(full.steps) <= 16)) throw new Error(`${where}.steps: must be from 2 to 16 shelves`);
  if (spec.type === 'basin' && minOf(full.depth) <= 0) throw new Error(`${where}.depth: must be above 0`);
}

/**
 * The farthest any point this spec can touch lies from the site centre (m), for its largest
 * sizes: placement uses it for clearance and to know which cells a site's stamps can reach.
 */
export function stampReach(spec) {
  const full = withDefaults(spec);
  const offset = full.offset ? Math.hypot(full.offset.along ?? 0, full.offset.across ?? 0) : 0;
  let extent;
  switch (full.type) {
    case 'cone':
      extent = maxOf(full.radius);
      break;
    case 'carve':
      extent = maxOf(full.length) / 2 + maxOf(full.twist) + (maxOf(full.width) / 2) * 1.25 + maxOf(full.wallWidth) * 1.2 + maxOf(full.plateau) + maxOf(full.shoulder) + 8;
      break;
    case 'cliffStep':
      extent = Math.hypot(maxOf(full.length) / 2 + maxOf(full.falloff), maxOf(full.width) / 2 + maxOf(full.falloff));
      break;
    case 'gorge':
      extent = Math.hypot(maxOf(full.length) / 2, (maxOf(full.width) / 2) * 1.35 + maxOf(full.pad) * 1.1 + 10);
      break;
    case 'flatten':
      extent = Math.hypot(maxOf(full.length) / 2 + maxOf(full.margin) + maxOf(full.shoulder), maxOf(full.width) / 2 + maxOf(full.margin) + maxOf(full.shoulder));
      break;
    case 'basin':
      extent = (maxOf(full.radius) + maxOf(full.rim) + maxOf(full.falloff)) * (1 + BASIN_LOBE_MAX);
      break;
    case 'crater':
      extent = maxOf(full.radius) + maxOf(full.rimWidth);
      break;
    case 'terraces':
      extent = Math.hypot(maxOf(full.length) / 2 + maxOf(full.falloff), maxOf(full.width) / 2 + maxOf(full.falloff));
      break;
    default:
      extent = (maxOf(full.radius) + maxOf(full.falloff)) * (1 + ISLAND_LOBE_MAX);
  }
  return offset + extent;
}

// ---- Resolution --------------------------------------------------------------------------------
/** Axis-aligned bounds of a rectangle (half extents along / across) rotated into the world. */
function rotatedBounds(stamp, halfAlong, halfAcross) {
  const extentX = Math.abs(stamp.dirX) * halfAlong + Math.abs(stamp.dirZ) * halfAcross;
  const extentZ = Math.abs(stamp.dirZ) * halfAlong + Math.abs(stamp.dirX) * halfAcross;
  stamp.minX = stamp.x - extentX - 1;
  stamp.maxX = stamp.x + extentX + 1;
  stamp.minZ = stamp.z - extentZ - 1;
  stamp.maxZ = stamp.z + extentZ + 1;
}

function circleBounds(stamp, radius) {
  stamp.minX = stamp.x - radius - 1;
  stamp.maxX = stamp.x + radius + 1;
  stamp.minZ = stamp.z - radius - 1;
  stamp.maxZ = stamp.z + radius + 1;
}

function resolveCone(stamp, spec, random, context) {
  const radius = roll(spec.radius, random);
  const height = roll(spec.height, random);
  const craterRadius = Math.min(roll(spec.craterRadius, random), radius * 0.55);
  const craterDepth = Math.min(roll(spec.craterDepth, random), height * 0.8);
  const baseY = Math.max(context.baseHeight(stamp.x, stamp.z), context.waterLevel + 4);
  stamp.radius = radius;
  stamp.height = height;
  stamp.craterRadius = craterRadius;
  stamp.craterDepth = craterDepth;
  stamp.gullies = Math.round(roll(spec.gullies, random));
  const gullyPhase = random() * TAU;
  stamp.gullyCos = Math.cos(gullyPhase);
  stamp.gullySin = Math.sin(gullyPhase);
  const flowPhase = random() * TAU;
  const flowPhaseB = random() * TAU;
  stamp.flowCos = Math.cos(flowPhase);
  stamp.flowSin = Math.sin(flowPhase);
  stamp.flowCosB = Math.cos(flowPhaseB);
  stamp.flowSinB = Math.sin(flowPhaseB);
  stamp.baseY = baseY;
  stamp.peakY = baseY + height;
  stamp.rimY = baseY + height;
  stamp.craterFloorY = baseY + height - craterDepth;
  circleBounds(stamp, radius);
  stamp.keyPoints = [
    { x: stamp.x, z: stamp.z },
    { x: stamp.x + stamp.dirX * craterRadius, z: stamp.z + stamp.dirZ * craterRadius },
    { x: stamp.x - stamp.dirZ * radius * 0.55, z: stamp.z + stamp.dirX * radius * 0.55 },
  ];
}

/**
 * Slot canyon. A seeded meandering polyline; along it a rim profile fitted to the terrain that only
 * runs downhill (so the river does too); a mesa band either side that lifts lower ground up to the
 * rim (never cuts it), and the slot cut `depth` below the rim with twisting walls and a river channel.
 * Where the path crosses higher ground the slot simply runs deeper. The stamp does not fit (placement
 * drops the site) when that would cut deeper than MAX_CANYON_CUT depths or lift ground more than
 * MAX_CANYON_LIFT depths.
 */
function resolveCarve(stamp, spec, random, context) {
  const length = roll(spec.length, random);
  const halfWidth = roll(spec.width, random) / 2;
  const depth = roll(spec.depth, random);
  const wallWidth = roll(spec.wallWidth, random);
  const twist = roll(spec.twist, random);
  const plateau = roll(spec.plateau, random);
  const shoulder = roll(spec.shoulder, random);
  const segments = spec.segments;
  const frequencyA = 0.8 + 0.6 * random();
  const frequencyB = 1.8 + 0.8 * random();
  const phaseA = random() * TAU;
  const phaseB = random() * TAU;
  const count = segments + 1;
  const pointX = new Float64Array(count);
  const pointZ = new Float64Array(count);
  const floor = new Float64Array(count);
  const rim = new Float64Array(count);
  const halfWidths = new Float64Array(count);
  const wallWidths = new Float64Array(count);
  const rightX = -stamp.dirZ;
  const rightZ = stamp.dirX;
  for (let index = 0; index < count; index++) {
    const share = index / segments;
    const along = (share - 0.5) * length;
    const meander = twist * (0.62 * Math.sin(share * TAU * frequencyA + phaseA) + 0.38 * Math.sin(share * TAU * frequencyB + phaseB));
    pointX[index] = stamp.x + stamp.dirX * along + rightX * meander;
    pointZ[index] = stamp.z + stamp.dirZ * along + rightZ * meander;
    halfWidths[index] = halfWidth * (0.75 + 0.5 * random());
    wallWidths[index] = wallWidth * (0.8 + 0.4 * random());
  }
  const segmentLengths = new Float64Array(segments);
  const segmentStart = new Float64Array(segments);
  const unitX = new Float64Array(segments);
  const unitZ = new Float64Array(segments);
  let total = 0;
  for (let index = 0; index < segments; index++) {
    segmentLengths[index] = Math.hypot(pointX[index + 1] - pointX[index], pointZ[index + 1] - pointZ[index]);
    segmentStart[index] = total;
    unitX[index] = (pointX[index + 1] - pointX[index]) / segmentLengths[index];
    unitZ[index] = (pointZ[index + 1] - pointZ[index]) / segmentLengths[index];
    total += segmentLengths[index];
  }
  // The rim (and with it the river floor) only runs downhill from the first point to the last,
  // and the floor stays above the sea.
  const ground = new Float64Array(count);
  for (let index = 0; index < count; index++) ground[index] = context.baseHeight(pointX[index], pointZ[index]);
  const fitted = fitNonIncreasing(ground);
  const floorLimit = context.waterLevel + 2;
  let fits = true;
  for (let index = 0; index < count; index++) {
    floor[index] = Math.max(fitted[index] - depth, floorLimit);
    rim[index] = floor[index] + depth;
    const inside = index > 0 && index < segments;
    if (inside && (ground[index] - floor[index] > depth * MAX_CANYON_CUT || rim[index] - ground[index] > depth * MAX_CANYON_LIFT)) fits = false;
  }
  stamp.fits = fits;
  let maxHalfWidth = 0;
  let maxWall = 0;
  let minHalfWidth = Infinity;
  for (let index = 0; index < count; index++) {
    if (halfWidths[index] > maxHalfWidth) maxHalfWidth = halfWidths[index];
    if (wallWidths[index] > maxWall) maxWall = wallWidths[index];
    if (halfWidths[index] < minHalfWidth) minHalfWidth = halfWidths[index];
  }
  // Wall wobble: the walls twist on their own, up to 30 % of the narrowest floor half-width.
  const wobble = Math.min(7, minHalfWidth * 0.3);
  const corridor = Math.max(maxHalfWidth + maxWall + wobble, maxHalfWidth + maxWall + plateau + shoulder);
  const reach = corridor + 1;
  const segmentBounds = new Float64Array(segments * 4);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < segments; index++) {
    const lowX = Math.min(pointX[index], pointX[index + 1]) - reach;
    const highX = Math.max(pointX[index], pointX[index + 1]) + reach;
    const lowZ = Math.min(pointZ[index], pointZ[index + 1]) - reach;
    const highZ = Math.max(pointZ[index], pointZ[index + 1]) + reach;
    segmentBounds[index * 4] = lowX;
    segmentBounds[index * 4 + 1] = highX;
    segmentBounds[index * 4 + 2] = lowZ;
    segmentBounds[index * 4 + 3] = highZ;
    if (lowX < minX) minX = lowX;
    if (highX > maxX) maxX = highX;
    if (lowZ < minZ) minZ = lowZ;
    if (highZ > maxZ) maxZ = highZ;
  }
  stamp.minX = minX - 1;
  stamp.maxX = maxX + 1;
  stamp.minZ = minZ - 1;
  stamp.maxZ = maxZ + 1;
  stamp.length = total;
  stamp.depth = depth;
  stamp.plateau = plateau;
  stamp.shoulder = shoulder;
  stamp.wobble = wobble;
  stamp.corridor = corridor;
  const leftPhase = random() * TAU;
  const rightPhase = random() * TAU;
  const wobbleLeft = buildWaveTable(total, (metre) => 0.6 * Math.sin(metre * 0.021 + leftPhase) + 0.4 * Math.sin(metre * 0.057 + leftPhase * 1.7));
  const wobbleRight = buildWaveTable(total, (metre) => 0.6 * Math.sin(metre * 0.021 + rightPhase) + 0.4 * Math.sin(metre * 0.057 + rightPhase * 1.7));
  stamp.endRamp = Math.min(total * 0.14, 450);
  // Segment grid over the stamp's bounds: each cell's bit mask names the segments whose bounds reach it.
  const gridColumns = Math.max(1, Math.ceil((stamp.maxX - stamp.minX) / CARVE_GRID));
  const gridRows = Math.max(1, Math.ceil((stamp.maxZ - stamp.minZ) / CARVE_GRID));
  const gridMasks = new Uint32Array(gridColumns * gridRows);
  for (let segment = 0; segment < segments; segment++) {
    const base = segment * 4;
    const firstColumn = Math.max(0, Math.floor((segmentBounds[base] - stamp.minX) / CARVE_GRID));
    const lastColumn = Math.min(gridColumns - 1, Math.floor((segmentBounds[base + 1] - stamp.minX) / CARVE_GRID));
    const firstRow = Math.max(0, Math.floor((segmentBounds[base + 2] - stamp.minZ) / CARVE_GRID));
    const lastRow = Math.min(gridRows - 1, Math.floor((segmentBounds[base + 3] - stamp.minZ) / CARVE_GRID));
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) gridMasks[row * gridColumns + column] |= 1 << segment;
    }
  }
  stamp.data = {
    pointX, pointZ, unitX, unitZ, floor, rim, halfWidths, wallWidths, segmentLengths, segmentStart, segmentBounds, segments,
    wobbleLeft, wobbleRight, gridColumns, gridRows, gridMasks,
  };
  stamp.path = Array.from({ length: count }, (unused, index) => Object.freeze({
    x: pointX[index], z: pointZ[index], floorY: floor[index], rimY: rim[index], halfWidth: halfWidths[index], wallWidth: wallWidths[index],
  }));
  stamp.entry = stamp.path[0];
  stamp.exit = stamp.path[count - 1];
  stamp.keyPoints = [0.2, 0.4, 0.5, 0.6, 0.8].map((share) => {
    const index = Math.round(share * segments);
    return { x: pointX[index], z: pointZ[index] };
  });
}

function resolveCliffStep(stamp, spec, random, context) {
  const width = roll(spec.width, random);
  const drop = roll(spec.drop, random);
  const length = roll(spec.length, random);
  const face = roll(spec.face, random);
  const falloff = roll(spec.falloff, random);
  const pool = roll(spec.pool, random);
  const centreHeight = context.baseHeight(stamp.x, stamp.z);
  const upstreamHeight = context.baseHeight(stamp.x - stamp.dirX * length * 0.35, stamp.z - stamp.dirZ * length * 0.35);
  const topY = Math.max(centreHeight, upstreamHeight) + drop * 0.3;
  const bottomY = Math.max(topY - drop, context.waterLevel + 3);
  stamp.width = width;
  stamp.drop = topY - bottomY;
  stamp.length = length;
  stamp.face = face;
  stamp.falloff = falloff;
  stamp.pool = pool;
  stamp.poolAlong = face * 0.5 + pool * 0.9;
  stamp.poolDepth = 6 + pool * 0.12;
  stamp.channelWidth = 14 + width * 0.03;
  stamp.channelDepth = 4.5;
  stamp.referenceY = centreHeight;
  stamp.topY = topY;
  stamp.bottomY = bottomY;
  const lipPhaseA = random() * TAU;
  const lipPhaseB = random() * TAU;
  // The lip's wander across the cliff, tabled from its -across edge (see sampleWave).
  stamp.lipOffset = width / 2 + falloff;
  stamp.lipTable = buildWaveTable(2 * stamp.lipOffset, (metre) => {
    const across = metre - stamp.lipOffset;
    return 5 * Math.sin(across * 0.061 + lipPhaseA) + 2.5 * Math.sin(across * 0.173 + lipPhaseB);
  });
  stamp.lipX = stamp.x;
  stamp.lipZ = stamp.z;
  stamp.poolX = stamp.x + stamp.dirX * stamp.poolAlong;
  stamp.poolZ = stamp.z + stamp.dirZ * stamp.poolAlong;
  rotatedBounds(stamp, length / 2 + falloff, width / 2 + falloff);
  stamp.keyPoints = [
    { x: stamp.x, z: stamp.z },
    { x: stamp.poolX, z: stamp.poolZ },
    { x: stamp.x - stamp.dirZ * width * 0.45, z: stamp.z + stamp.dirX * width * 0.45 },
  ];
}

function resolveGorge(stamp, spec, random, context) {
  const length = roll(spec.length, random);
  const halfWidth = roll(spec.width, random) / 2;
  const depth = roll(spec.depth, random);
  const falloff = Math.min(roll(spec.falloff, random), length * 0.45);
  const pad = roll(spec.pad, random);
  const rightX = -stamp.dirZ;
  const rightZ = stamp.dirX;
  const anchorOffset = halfWidth + pad / 2;
  const anchorA = { x: stamp.x - rightX * anchorOffset, z: stamp.z - rightZ * anchorOffset };
  const anchorB = { x: stamp.x + rightX * anchorOffset, z: stamp.z + rightZ * anchorOffset };
  const groundA = context.baseHeight(anchorA.x, anchorA.z);
  const groundB = context.baseHeight(anchorB.x, anchorB.z);
  const rimY = Math.max((groundA + groundB) / 2, context.waterLevel + 8);
  // The pads level the anchors to the rim: on a slope that would raise pillars, so it does not fit;
  // nor does ground too low to hold the gorge's full depth above the sea.
  stamp.fits = Math.abs(groundA - rimY) <= GORGE_ANCHOR_TOLERANCE && Math.abs(groundB - rimY) <= GORGE_ANCHOR_TOLERANCE
    && rimY - depth >= context.waterLevel + 2;
  const floorY = Math.max(rimY - depth, context.waterLevel + 2);
  stamp.length = length;
  stamp.halfWidth = halfWidth;
  stamp.depth = rimY - floorY;
  stamp.falloff = falloff;
  stamp.pad = pad;
  stamp.rimY = rimY;
  stamp.floorY = floorY;
  stamp.span = 2 * anchorOffset;
  const wallPhase = random() * TAU;
  // The walls' wander along the gorge, tabled from its -along end (see sampleWave).
  stamp.wallTable = buildWaveTable(length, (metre) => {
    const along = metre - length / 2;
    return 4 * Math.sin(along * 0.037 + wallPhase) + 2 * Math.sin(along * 0.11 + wallPhase * 2.3);
  });
  stamp.anchors = [Object.freeze({ ...anchorA, y: rimY }), Object.freeze({ ...anchorB, y: rimY })];
  rotatedBounds(stamp, length / 2, halfWidth * 1.35 + pad * 1.1 + 10);
  stamp.keyPoints = [{ x: stamp.x, z: stamp.z }, { x: anchorA.x, z: anchorA.z }, { x: stamp.x + stamp.dirX * length * 0.3, z: stamp.z + stamp.dirZ * length * 0.3 }];
}

function resolveFlatten(stamp, spec, random, context) {
  const length = roll(spec.length, random);
  const width = roll(spec.width, random);
  const margin = roll(spec.margin, random);
  const shoulder = roll(spec.shoulder, random);
  let sum = 0;
  for (let index = 0; index <= 8; index++) {
    const along = (index / 8 - 0.5) * length;
    sum += context.baseHeight(stamp.x + stamp.dirX * along, stamp.z + stamp.dirZ * along);
  }
  const level = Math.max(sum / 9, context.waterLevel + 4);
  stamp.length = length;
  stamp.width = width;
  stamp.margin = margin;
  stamp.shoulder = shoulder;
  stamp.y = level;
  stamp.thresholds = [
    Object.freeze({ x: stamp.x - stamp.dirX * length / 2, z: stamp.z - stamp.dirZ * length / 2, y: level }),
    Object.freeze({ x: stamp.x + stamp.dirX * length / 2, z: stamp.z + stamp.dirZ * length / 2, y: level }),
  ];
  rotatedBounds(stamp, length / 2 + margin + shoulder, width / 2 + margin + shoulder);
  stamp.keyPoints = [{ x: stamp.x, z: stamp.z }, stamp.thresholds[0], { x: stamp.x - stamp.dirZ * (width / 2 + margin + shoulder * 0.5), z: stamp.z + stamp.dirX * (width / 2 + margin + shoulder * 0.5) }];
}

function resolveIslandBase(stamp, spec, random, context) {
  const radius = roll(spec.radius, random);
  const height = roll(spec.height, random);
  const falloff = roll(spec.falloff, random);
  stamp.radius = radius;
  stamp.height = height;
  stamp.falloff = falloff;
  stamp.seabedY = context.waterLevel - 14;
  stamp.topY = context.waterLevel + height;
  const ledgePhase = random() * TAU;
  stamp.ledgeCos = Math.cos(ledgePhase);
  stamp.ledgeSin = Math.sin(ledgePhase);
  const lobePhaseA = random() * TAU;
  const lobePhaseB = random() * TAU;
  stamp.lobeCosA = Math.cos(lobePhaseA);
  stamp.lobeSinA = Math.sin(lobePhaseA);
  stamp.lobeCosB = Math.cos(lobePhaseB);
  stamp.lobeSinB = Math.sin(lobePhaseB);
  stamp.outerRadius = (radius + falloff) * (1 + ISLAND_LOBE_MAX);
  circleBounds(stamp, stamp.outerRadius);
  stamp.keyPoints = [{ x: stamp.x, z: stamp.z }, { x: stamp.x + stamp.dirX * radius, z: stamp.z + stamp.dirZ * radius }];
}

/**
 * Lake basin: a lobed bowl whose rim crest sits a little above the highest ground on its rim, with a
 * berm that lifts any lower rim ground up to the crest. Inside the rim the ground follows the bowl
 * (cut down where higher, lifted where lower), so the bowl holds water up to the crest everywhere.
 * It does not fit where the berm would lift the low side of the rim, or the bowl would cut into the
 * ground inside it, by more than a few depths (a lake on a steep slope).
 */
function resolveBasin(stamp, spec, random, context) {
  const radius = roll(spec.radius, random);
  const depth = roll(spec.depth, random);
  const rim = roll(spec.rim, random);
  const falloff = roll(spec.falloff, random);
  const lobePhaseA = random() * TAU;
  const lobePhaseB = random() * TAU;
  stamp.lobeCosA = Math.cos(lobePhaseA);
  stamp.lobeSinA = Math.sin(lobePhaseA);
  stamp.lobeCosB = Math.cos(lobePhaseB);
  stamp.lobeSinB = Math.sin(lobePhaseB);
  stamp.radius = radius;
  stamp.depth = depth;
  stamp.rim = rim;
  stamp.falloff = falloff;
  let ringHigh = -Infinity;
  let ringLow = Infinity;
  let innerHigh = context.baseHeight(stamp.x, stamp.z);
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * TAU;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const lobe = basinLobe(stamp, sine, -cosine);
    const ring = context.baseHeight(stamp.x + sine * radius * lobe, stamp.z - cosine * radius * lobe);
    const inner = context.baseHeight(stamp.x + sine * radius * lobe * 0.55, stamp.z - cosine * radius * lobe * 0.55);
    if (ring > ringHigh) ringHigh = ring;
    if (ring < ringLow) ringLow = ring;
    if (inner > innerHigh) innerHigh = inner;
  }
  const rimY = Math.max(ringHigh + BASIN_FREEBOARD, context.waterLevel + 3);
  const floorY = rimY - depth;
  stamp.rimY = rimY;
  stamp.floorY = floorY;
  stamp.fits = rimY - ringLow <= Math.max(36, depth * BASIN_MAX_LIFT) && innerHigh - floorY <= depth * BASIN_MAX_CUT;
  stamp.outerRadius = (radius + rim + falloff) * (1 + BASIN_LOBE_MAX);
  circleBounds(stamp, stamp.outerRadius);
  stamp.keyPoints = [
    { x: stamp.x, z: stamp.z },
    { x: stamp.x + stamp.dirX * radius * 0.6, z: stamp.z + stamp.dirZ * radius * 0.6 },
    { x: stamp.x - stamp.dirZ * radius, z: stamp.z + stamp.dirX * radius },
  ];
}

/**
 * Impact crater: a raised rim crest at `radius` (rimHeight above the mean ground around it), a bowl
 * `depth` below the crest with a flat floor, and an ejecta flank falling back to the ground over
 * rimWidth. The floor stays above the sea, so a crater lake always sits in its own bowl.
 */
function resolveCrater(stamp, spec, random, context) {
  const radius = roll(spec.radius, random);
  const depth = roll(spec.depth, random);
  const rimHeight = roll(spec.rimHeight, random);
  const rimWidth = roll(spec.rimWidth, random);
  const floor = Math.min(roll(spec.floor, random), 0.8);
  let sum = 0;
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * TAU;
    sum += context.baseHeight(stamp.x + Math.sin(angle) * radius, stamp.z - Math.cos(angle) * radius);
  }
  const groundY = sum / 12;
  const rimY = Math.max(groundY, context.waterLevel + 4) + rimHeight;
  const floorY = Math.max(rimY - depth, context.waterLevel + 2);
  stamp.radius = radius;
  stamp.depth = rimY - floorY;
  stamp.rimHeight = rimHeight;
  stamp.rimWidth = rimWidth;
  stamp.floorShare = floor;
  stamp.groundY = groundY;
  stamp.rimY = rimY;
  stamp.floorY = floorY;
  circleBounds(stamp, radius + rimWidth);
  stamp.keyPoints = [
    { x: stamp.x, z: stamp.z },
    { x: stamp.x + stamp.dirX * radius, z: stamp.z + stamp.dirZ * radius },
    { x: stamp.x - stamp.dirZ * (radius + rimWidth * 0.5), z: stamp.z + stamp.dirX * (radius + rimWidth * 0.5) },
  ];
}

/**
 * Terraces: `steps` flat shelves stepping down the slope along the stamp's forward axis (downhill
 * when the preset aligns its sites downhill). Each shelf holds a pool behind a lip at its downhill
 * edge and between two side walls; a riser drops to the next shelf. It fits only on a slope that
 * drops between TERRACE_MIN_DROP and TERRACE_MAX_DROP per shelf.
 */
function resolveTerraces(stamp, spec, random, context) {
  const length = roll(spec.length, random);
  const width = roll(spec.width, random);
  const steps = Math.round(roll(spec.steps, random));
  const lip = roll(spec.lip, random);
  const falloff = roll(spec.falloff, random);
  const topY = context.baseHeight(stamp.x - stamp.dirX * length / 2, stamp.z - stamp.dirZ * length / 2);
  const bottomY = context.baseHeight(stamp.x + stamp.dirX * length / 2, stamp.z + stamp.dirZ * length / 2);
  const drop = topY - bottomY;
  stamp.fits = drop >= steps * TERRACE_MIN_DROP && drop <= steps * TERRACE_MAX_DROP && bottomY - lip > context.waterLevel + 2;
  const stepDrop = Math.max(drop, steps * TERRACE_MIN_DROP) / steps;
  stamp.length = length;
  stamp.width = width;
  stamp.steps = steps;
  stamp.lip = lip;
  stamp.falloff = falloff;
  stamp.stepLength = length / steps;
  stamp.stepDrop = stepDrop;
  stamp.topY = topY;
  stamp.bottomY = topY - stepDrop * steps;
  // Shelf k: its lip crest (the brim its pool can fill to) and its pool floor, lip below the crest.
  const shelves = [];
  for (let shelf = 0; shelf < steps; shelf++) {
    const crestY = topY - stepDrop * (shelf + 0.5);
    const startAlong = -length / 2 + shelf * stamp.stepLength;
    shelves.push(Object.freeze({
      index: shelf,
      crestY,
      floorY: crestY - lip,
      along: startAlong + stamp.stepLength * TERRACE_POOL_END * 0.5,
      x: stamp.x + stamp.dirX * (startAlong + stamp.stepLength * TERRACE_POOL_END * 0.5),
      z: stamp.z + stamp.dirZ * (startAlong + stamp.stepLength * TERRACE_POOL_END * 0.5),
    }));
  }
  stamp.shelves = shelves;
  rotatedBounds(stamp, length / 2 + falloff, width / 2 + falloff);
  stamp.keyPoints = [
    { x: stamp.x, z: stamp.z },
    { x: shelves[0].x, z: shelves[0].z },
    { x: shelves[steps - 1].x, z: shelves[steps - 1].z },
  ];
}

const RESOLVERS = Object.freeze({
  cone: resolveCone,
  carve: resolveCarve,
  cliffStep: resolveCliffStep,
  gorge: resolveGorge,
  flatten: resolveFlatten,
  islandBase: resolveIslandBase,
  basin: resolveBasin,
  crater: resolveCrater,
  terraces: resolveTerraces,
});

/**
 * Resolves one stamp spec for a site into world-space geometry (a plain, frozen object).
 *   site: { id, presetId, x, z, rotation }
 *   index: the spec's position in the preset's stamps list
 *   random: a seeded () => [0, 1) stream for this stamp
 *   context: { baseHeight(x, z) (the UNSTAMPED height), waterLevel }
 * The result carries type, kind, siteId, presetId, index, order (the global apply order), x, z,
 * rotation, dirX, dirZ, bounds (minX, maxX, minZ, maxZ), paint, paintIndex, keyPoints (the stamp's
 * characteristic places, for tests and structures), fits (false: the ground cannot take this stamp
 * and placement drops the site) and the type's own sizes and reference heights
 * (cone: baseY, peakY, rimY, craterFloorY; carve: path, entry, exit, length; cliffStep: topY,
 * bottomY, lipX/Z, poolX/Z; gorge: rimY, floorY, span, anchors; flatten: y, thresholds;
 * islandBase: topY; basin: rimY, floorY, radius; crater: rimY, floorY, radius; terraces: topY,
 * bottomY, shelves [{ index, crestY, floorY, along, x, z }]).
 */
export function resolveStamp(spec, site, index, random, context) {
  const full = withDefaults(spec);
  const rotation = site.rotation + (Number.isFinite(full.rotation) ? full.rotation : 0);
  const dirX = Math.sin(rotation);
  const dirZ = -Math.cos(rotation);
  const along = full.offset ? full.offset.along ?? 0 : 0;
  const across = full.offset ? full.offset.across ?? 0 : 0;
  const paint = full.paint === undefined ? null : full.paint;
  const stamp = {
    type: full.type,
    kind: KIND[full.type],
    siteId: site.id,
    presetId: site.presetId,
    index,
    order: `${site.id}#${String(index).padStart(2, '0')}`,
    x: site.x + dirX * along - dirZ * across,
    z: site.z + dirZ * along + dirX * across,
    rotation,
    dirX,
    dirZ,
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    paint,
    paintIndex: paint === null ? -1 : PAINT_INDEX[paint],
    fits: true,
    keyPoints: [],
  };
  RESOLVERS[full.type](stamp, full, random, context);
  stamp.keyPoints = Object.freeze(stamp.keyPoints.map((point) => Object.freeze({ x: point.x, z: point.z })));
  if (stamp.path) stamp.path = Object.freeze(stamp.path);
  if (stamp.anchors) stamp.anchors = Object.freeze(stamp.anchors);
  if (stamp.thresholds) stamp.thresholds = Object.freeze(stamp.thresholds);
  if (stamp.shelves) stamp.shelves = Object.freeze(stamp.shelves);
  return Object.freeze(stamp);
}

// ---- Footprints (clearance between sites and from landmarks) ------------------------------------
/** Distance (m) from (x, z) to the ground a rotated rectangle stamp touches; 0 inside. */
function rectangleDistance(stamp, x, z, halfAlong, halfAcross) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = Math.abs(dx * stamp.dirX + dz * stamp.dirZ) - halfAlong;
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX) - halfAcross;
  return Math.hypot(along > 0 ? along : 0, across > 0 ? across : 0);
}

/** Half extents (along, across) of the rectangle stamp types' footprints. */
function rectangleExtents(stamp) {
  if (stamp.kind === 2 || stamp.kind === 8) return [stamp.length / 2 + stamp.falloff, stamp.width / 2 + stamp.falloff];
  if (stamp.kind === 3) return [stamp.length / 2, stamp.halfWidth * 1.35 + stamp.pad * 1.1 + 10];
  return [stamp.length / 2 + stamp.margin + stamp.shoulder, stamp.width / 2 + stamp.margin + stamp.shoulder];
}

/**
 * Distance (m) from (x, z) to the nearest ground this resolved stamp can change (0 inside it). Placement
 * measures landmark and site clearance with it, so a long thin canyon is judged by its real shape.
 */
export function stampFootprintDistance(stamp, x, z) {
  if (stamp.kind === 0) return Math.max(0, Math.hypot(x - stamp.x, z - stamp.z) - stamp.radius);
  if (stamp.kind === 5 || stamp.kind === 6) return Math.max(0, Math.hypot(x - stamp.x, z - stamp.z) - stamp.outerRadius);
  if (stamp.kind === 7) return Math.max(0, Math.hypot(x - stamp.x, z - stamp.z) - stamp.radius - stamp.rimWidth);
  if (stamp.kind === 1) {
    const data = stamp.data;
    let nearest = Infinity;
    for (let segment = 0; segment < data.segments; segment++) {
      const startX = data.pointX[segment];
      const startZ = data.pointZ[segment];
      const segmentLength = data.segmentLengths[segment];
      const unitX = (data.pointX[segment + 1] - startX) / segmentLength;
      const unitZ = (data.pointZ[segment + 1] - startZ) / segmentLength;
      let along = (x - startX) * unitX + (z - startZ) * unitZ;
      along = along < 0 ? 0 : along > segmentLength ? segmentLength : along;
      const distance = Math.hypot(x - (startX + unitX * along), z - (startZ + unitZ * along));
      if (distance < nearest) nearest = distance;
    }
    return Math.max(0, nearest - stamp.corridor);
  }
  const [halfAlong, halfAcross] = rectangleExtents(stamp);
  return rectangleDistance(stamp, x, z, halfAlong, halfAcross);
}

/**
 * Discs { x, z, radius } whose union covers the stamp's footprint (a conservative outline for the
 * clearance between two sites: nothing the stamp touches lies outside them).
 */
export function stampFootprintDiscs(stamp) {
  if (stamp.kind === 0) return [{ x: stamp.x, z: stamp.z, radius: stamp.radius }];
  if (stamp.kind === 5 || stamp.kind === 6) return [{ x: stamp.x, z: stamp.z, radius: stamp.outerRadius }];
  if (stamp.kind === 7) return [{ x: stamp.x, z: stamp.z, radius: stamp.radius + stamp.rimWidth }];
  if (stamp.kind === 1) {
    const data = stamp.data;
    const discs = [];
    for (let segment = 0; segment < data.segments; segment++) {
      discs.push({
        x: (data.pointX[segment] + data.pointX[segment + 1]) / 2,
        z: (data.pointZ[segment] + data.pointZ[segment + 1]) / 2,
        radius: data.segmentLengths[segment] / 2 + stamp.corridor,
      });
    }
    return discs;
  }
  const [halfAlong, halfAcross] = rectangleExtents(stamp);
  const count = Math.max(1, Math.ceil(halfAlong / halfAcross));
  const spacing = (2 * halfAlong) / count;
  const radius = Math.hypot(spacing / 2, halfAcross);
  const discs = [];
  for (let index = 0; index < count; index++) {
    const along = -halfAlong + spacing * (index + 0.5);
    discs.push({ x: stamp.x + stamp.dirX * along, z: stamp.z + stamp.dirZ * along, radius });
  }
  return discs;
}

/** Deterministic apply order of stamps that share cells (code-unit order of `order`). */
export function compareStampOrder(first, second) {
  return first.order < second.order ? -1 : first.order > second.order ? 1 : 0;
}

// ---- Height ------------------------------------------------------------------------------------
/** Cone elevation above its base: a crater bowl inside craterRadius, concave gullied flanks outside. */
function coneElevation(stamp, distance, dx, dz) {
  if (distance < stamp.craterRadius) {
    const share = distance / stamp.craterRadius;
    const bowl = 1 - share * share;
    return stamp.height - stamp.craterDepth * bowl * Math.sqrt(bowl);
  }
  const outward = (distance - stamp.craterRadius) / (stamp.radius - stamp.craterRadius);
  const inward = 1 - outward;
  // Steep near the rim, easing flat at the foot (zero slope at the edge).
  const falloff = inward * inward * (1 + 0.3 * outward);
  const wave = angularWave(dx / distance, dz / distance, stamp.gullies, stamp.gullyCos, stamp.gullySin);
  return stamp.height * falloff * (1 + 0.28 * wave * outward * inward);
}

function coneHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= stamp.radius * stamp.radius) return height;
  const distance = Math.sqrt(distanceSq);
  // The cone rises out of the terrain; its core damps the terrain's own relief so the crater reads cleanly.
  const core = 1 - smoothstep(stamp.radius * 0.35, stamp.radius, distance);
  return stamp.baseY + (height - stamp.baseY) * (1 - 0.85 * core) + coneElevation(stamp, distance, dx, dz);
}

/**
 * Slot canyon: the union of per-segment capsules, each carving down to the river floor with walls
 * over its wall width, so the canyon stays continuous where segments meet.
 */
/** The bit mask of canyon segments near (x, z), from the stamp's segment grid. */
function carveSegmentsNear(stamp, x, z) {
  const data = stamp.data;
  let column = Math.floor((x - stamp.minX) / CARVE_GRID);
  let row = Math.floor((z - stamp.minZ) / CARVE_GRID);
  if (column < 0) column = 0;
  else if (column >= data.gridColumns) column = data.gridColumns - 1;
  if (row < 0) row = 0;
  else if (row >= data.gridRows) row = data.gridRows - 1;
  return data.gridMasks[row * data.gridColumns + column];
}

function carveHeight(stamp, x, z, height) {
  const data = stamp.data;
  const bounds = data.segmentBounds;
  const wobble = stamp.wobble;
  let lift = 0;
  let cuts = 0;
  let mask = carveSegmentsNear(stamp, x, z);
  while (mask !== 0) {
    const lowest = mask & -mask;
    const segment = 31 - Math.clz32(lowest);
    mask ^= lowest;
    const base = segment * 4;
    if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
    const segmentLength = data.segmentLengths[segment];
    const unitX = data.unitX[segment];
    const unitZ = data.unitZ[segment];
    const offsetX = x - data.pointX[segment];
    const offsetZ = z - data.pointZ[segment];
    let along = offsetX * unitX + offsetZ * unitZ;
    along = along < 0 ? 0 : along > segmentLength ? segmentLength : along;
    const awayX = offsetX - unitX * along;
    const awayZ = offsetZ - unitZ * along;
    const distance = Math.sqrt(awayX * awayX + awayZ * awayZ);
    const share = along / segmentLength;
    const halfWidth = data.halfWidths[segment] + (data.halfWidths[segment + 1] - data.halfWidths[segment]) * share;
    const outer = halfWidth + data.wallWidths[segment] + (data.wallWidths[segment + 1] - data.wallWidths[segment]) * share;
    const band = outer + stamp.plateau;
    if (distance >= band + stamp.shoulder && distance - wobble >= outer) continue;
    const travelled = data.segmentStart[segment] + along;
    const end = travelled >= stamp.endRamp && travelled <= stamp.length - stamp.endRamp
      ? 1
      : smoothstep(0, stamp.endRamp, travelled) * smoothstep(0, stamp.endRamp, stamp.length - travelled);
    if (end <= 0) continue;
    // Mesa band: lower ground rises to the rim (raise only), fading out over the shoulder.
    const rimY = data.rim[segment] + (data.rim[segment + 1] - data.rim[segment]) * share;
    if (rimY > height) {
      const band01 = distance <= band ? 1 : 1 - smoothstep(band, band + stamp.shoulder, distance);
      const raise = (rimY - height) * band01 * end;
      if (raise > lift) lift = raise;
    }
    if (distance - wobble >= outer) continue;
    let open = 1;
    if (distance + wobble > halfWidth) {
      // Each wall twists on its own; the two wobbles blend across the floor, where they change nothing.
      const lateral = offsetX * -unitZ + offsetZ * unitX;
      const wobbleRight = sampleWave(data.wobbleRight, travelled);
      const wobbleLeft = sampleWave(data.wobbleLeft, travelled);
      const side = smoothstep(-halfWidth * 0.5, halfWidth * 0.5, lateral);
      const wall = distance + wobble * (wobbleLeft + (wobbleRight - wobbleLeft) * side);
      if (wall >= outer) continue;
      open = 1 - smoothstep(halfWidth, outer, wall);
    }
    const floorY = data.floor[segment] + (data.floor[segment + 1] - data.floor[segment]) * share;
    const channel = distance < halfWidth * 0.45 ? 1.8 * (1 - smoothstep(0, halfWidth * 0.45, distance)) : 0;
    carveCutFloor[cuts] = floorY - channel;
    carveCutShare[cuts] = open * end;
    cuts++;
  }
  // The slot is cut into the lifted ground: the deepest of the segments' cuts wins.
  const lifted = height + lift;
  let deepest = 0;
  for (let index = 0; index < cuts; index++) {
    const cut = lifted - carveCutFloor[index];
    if (cut <= 0) continue;
    const amount = cut * carveCutShare[index];
    if (amount > deepest) deepest = amount;
  }
  return lifted - deepest;
}

function cliffStepHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = dx * stamp.dirX + dz * stamp.dirZ;
  const across = dx * -stamp.dirZ + dz * stamp.dirX;
  const absAcross = Math.abs(across);
  const absAlong = Math.abs(along);
  const halfWidth = stamp.width / 2;
  const halfLength = stamp.length / 2;
  if (absAcross >= halfWidth + stamp.falloff || absAlong >= halfLength + stamp.falloff) return height;
  const mask = (1 - smoothstep(halfWidth, halfWidth + stamp.falloff, absAcross)) * (1 - smoothstep(halfLength, halfLength + stamp.falloff, absAlong));
  if (mask <= 0) return height;
  // The lip wanders at most LIP_AMPLITUDE either way, so beyond that the step is simply top or bottom.
  const halfFace = stamp.face / 2;
  let lip = 0;
  let step;
  if (along <= -halfFace - LIP_AMPLITUDE) step = 0;
  else if (along >= halfFace + LIP_AMPLITUDE) step = 1;
  else {
    lip = sampleWave(stamp.lipTable, across + stamp.lipOffset);
    step = smoothstep(-halfFace, halfFace, along - lip);
  }
  let target = stamp.topY - stamp.drop * step + (height - stamp.referenceY) * 0.15;
  const poolAlong = along - stamp.poolAlong;
  if (poolAlong > -stamp.pool && poolAlong < stamp.pool && absAcross < stamp.pool) {
    const poolShareSq = (poolAlong * poolAlong + across * across) / (stamp.pool * stamp.pool);
    if (poolShareSq < 1) {
      const bowl = 1 - poolShareSq;
      target -= stamp.poolDepth * bowl * bowl;
    }
  }
  if (absAcross < stamp.channelWidth) {
    if (lip === 0 && along > -halfFace - LIP_AMPLITUDE - stamp.face && along < LIP_AMPLITUDE) {
      lip = sampleWave(stamp.lipTable, across + stamp.lipOffset);
    }
    const channelShare = absAcross / stamp.channelWidth;
    const upstream = 1 - smoothstep(-stamp.face, 0, along - lip);
    const downstream = smoothstep(stamp.poolAlong, stamp.poolAlong + stamp.pool, along);
    target -= stamp.channelDepth * (1 - channelShare * channelShare) * (upstream + downstream);
  }
  return height + (target - height) * mask;
}

function gorgeHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = dx * stamp.dirX + dz * stamp.dirZ;
  const across = dx * -stamp.dirZ + dz * stamp.dirX;
  const absAlong = Math.abs(along);
  const absAcross = Math.abs(across);
  const halfLength = stamp.length / 2;
  if (absAlong >= halfLength || absAcross >= stamp.halfWidth * 1.35 + stamp.pad * 1.1 + 10) return height;
  let result = height;
  if (absAcross - GORGE_WOBBLE < stamp.halfWidth * 1.35) {
    const wobble = sampleWave(stamp.wallTable, along + halfLength);
    const share = Math.max(0, absAcross + wobble) / stamp.halfWidth;
    const wallShare = share < 1 ? share : 1;
    const channel = share < 0.3 ? 2 * (1 - smoothstep(0, 0.3, share)) : 0;
    const target = stamp.floorY - channel + (stamp.rimY - stamp.floorY) * wallShare * wallShare * wallShare;
    if (height > target && share < 1.35) {
      const edge = 1 - smoothstep(1, 1.35, share);
      const end = 1 - smoothstep(halfLength - stamp.falloff, halfLength, absAlong);
      result = height - (height - target) * edge * end;
    }
  }
  // Anchor pads: level ground on both rims where the bridge's towers stand.
  const padAcross = Math.abs(absAcross - (stamp.halfWidth + stamp.pad / 2));
  if (absAlong >= stamp.pad * 0.6 || padAcross >= stamp.pad * 0.6) return result;
  const padMask = (1 - smoothstep(stamp.pad * 0.3, stamp.pad * 0.6, absAlong)) * (1 - smoothstep(stamp.pad * 0.3, stamp.pad * 0.6, padAcross));
  return result + (stamp.rimY - result) * padMask;
}

function flattenHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = Math.abs(dx * stamp.dirX + dz * stamp.dirZ);
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX);
  const outsideAlong = along - stamp.length / 2 - stamp.margin;
  const outsideAcross = across - stamp.width / 2 - stamp.margin;
  if (outsideAlong >= stamp.shoulder || outsideAcross >= stamp.shoulder) return height;
  if (outsideAlong <= 0 && outsideAcross <= 0) return stamp.y;
  const overAlong = outsideAlong > 0 ? outsideAlong : 0;
  const overAcross = outsideAcross > 0 ? outsideAcross : 0;
  const distance = Math.sqrt(overAlong * overAlong + overAcross * overAcross);
  if (distance >= stamp.shoulder) return height;
  return height + (stamp.y - height) * (1 - smoothstep(0, stamp.shoulder, distance));
}

/**
 * The islet's distance from its centre measured against its lobed outline: the actual distance
 * divided by the outline's scale in that direction (1 +- ISLAND_LOBE_MAX), so every radius in the
 * height and paint functions follows the lobes.
 */
function islandReach(stamp, dx, dz, distance) {
  if (distance <= 0) return 0;
  const cosAngle = dx / distance;
  const sinAngle = dz / distance;
  const lobe = 1 + ISLAND_LOBE_MAX * (0.65 * angularWave(cosAngle, sinAngle, 3, stamp.lobeCosA, stamp.lobeSinA) + 0.35 * angularWave(cosAngle, sinAngle, 7, stamp.lobeCosB, stamp.lobeSinB));
  return distance / lobe;
}

function islandBaseHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= stamp.outerRadius * stamp.outerRadius) return height;
  const distance = Math.sqrt(distanceSq);
  const reach = islandReach(stamp, dx, dz, distance);
  const outer = stamp.radius + stamp.falloff;
  if (reach >= outer) return height;
  const profile = 1 - smoothstep(stamp.radius * 0.5, stamp.radius, reach);
  const ledge = distance > 0 && profile > 0 ? 1.5 * angularWave(dx / distance, dz / distance, 5, stamp.ledgeCos, stamp.ledgeSin) * profile : 0;
  const target = stamp.seabedY + (stamp.topY - stamp.seabedY) * Math.sqrt(profile) + ledge;
  if (target <= height) return height;
  return height + (target - height) * (1 - smoothstep(stamp.radius, outer, reach));
}

/** The basin's outline scale in the direction (cosAngle, sinAngle) = (dx, dz) / distance (3 and 5 lobes). */
function basinLobe(stamp, cosAngle, sinAngle) {
  return 1 + BASIN_LOBE_MAX * (0.6 * angularWave(cosAngle, sinAngle, 3, stamp.lobeCosA, stamp.lobeSinA) + 0.4 * angularWave(cosAngle, sinAngle, 5, stamp.lobeCosB, stamp.lobeSinB));
}

/**
 * The distance (m) from a basin's centre to (x, z) measured against its lobed shoreline: the actual
 * distance divided by the outline's scale in that direction, so `radius` is the bowl's edge (its
 * rim crest) in every direction. Water bodies clip to basinReach < radius.
 */
export function basinReach(stamp, x, z) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance <= 0) return 0;
  return distance / basinLobe(stamp, dx / distance, dz / distance);
}

/**
 * Blends the ground toward a bowl profile: where the ground is higher it is cut toward the profile
 * by cutMask, where lower it is lifted by liftMask (each 0..1). With both masks at 1 the result IS
 * the profile; with both at 0 it is the ground, so the edits fade out smoothly.
 */
function bowlBlend(height, profile, cutMask, liftMask) {
  return height > profile ? height - (height - profile) * cutMask : height + (profile - height) * liftMask;
}

function basinHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= stamp.outerRadius * stamp.outerRadius) return height;
  const reach = basinReach(stamp, x, z);
  const radius = stamp.radius;
  const outer = radius + stamp.rim + stamp.falloff;
  if (reach >= outer) return height;
  let profile = stamp.rimY;
  if (reach < radius) {
    // Flat in the middle, rounding up to the crest: zero slope at the centre and at the rim.
    const share = reach / radius;
    profile = stamp.floorY + stamp.depth * share * share * (3 - 2 * share);
  }
  // Inside the rim the bowl replaces the ground; outside it higher ground eases down toward the crest
  // and the berm lifts lower ground up to it, both fading out over the rim and the falloff.
  const cutMask = 1 - smoothstep(radius, outer, reach);
  const liftMask = 1 - smoothstep(radius + stamp.rim * 0.4, outer, reach);
  return bowlBlend(height, profile, cutMask, liftMask);
}

function craterHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distanceSq = dx * dx + dz * dz;
  const outer = stamp.radius + stamp.rimWidth;
  if (distanceSq >= outer * outer) return height;
  const distance = Math.sqrt(distanceSq);
  const radius = stamp.radius;
  if (distance < radius) {
    // The bowl: a flat floor, then walls steepening up to the crest.
    const wall = smoothstep(stamp.floorShare * radius, radius, distance);
    const profile = stamp.floorY + (stamp.rimY - stamp.floorY) * Math.pow(wall, 1.6);
    return bowlBlend(height, profile, 1, 1);
  }
  // The ejecta flank: from the crest back down to the ground around, concave, lift only at its foot.
  const flank = (distance - radius) / stamp.rimWidth;
  const inward = 1 - flank;
  const profile = stamp.groundY + (stamp.rimY - stamp.groundY) * inward * inward;
  const cutMask = 1 - smoothstep(0, 0.3, flank);
  const liftMask = 1 - smoothstep(0.7, 1, flank);
  return bowlBlend(height, profile, cutMask, liftMask);
}

/**
 * The terrace profile at a point `along` the stamp (m from its centre, downhill +) and `across` it:
 * the pool floor of its shelf, rising to the lip crest at the downhill edge and to the side walls,
 * then the riser down to the next shelf's pool floor.
 */
function terraceProfile(stamp, along, across) {
  const fromTop = along + stamp.length / 2;
  let shelf = Math.floor(fromTop / stamp.stepLength);
  if (shelf < 0) shelf = 0;
  else if (shelf >= stamp.steps) shelf = stamp.steps - 1;
  const share = fromTop / stamp.stepLength - shelf;
  const crestY = stamp.topY - stamp.stepDrop * (shelf + 0.5);
  const floorY = crestY - stamp.lip;
  let profile;
  if (share < TERRACE_POOL_END) profile = floorY;
  else if (share < TERRACE_LIP_END) profile = floorY + stamp.lip * smoothstep(TERRACE_POOL_END, TERRACE_LIP_END, share);
  else {
    // The riser: from this lip crest down to the next shelf's pool floor.
    const nextFloor = crestY - stamp.stepDrop - stamp.lip;
    profile = crestY + (nextFloor - crestY) * smoothstep(TERRACE_LIP_END, 1, share);
  }
  // The side walls close the pools at the lip crest's height.
  const wall = smoothstep(stamp.width / 2 - TERRACE_SIDE_WALL, stamp.width / 2 - TERRACE_SIDE_WALL * 0.4, Math.abs(across));
  const wallY = share < TERRACE_LIP_END ? crestY : profile;
  return profile + (Math.max(profile, wallY) - profile) * wall;
}

function terracesHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = dx * stamp.dirX + dz * stamp.dirZ;
  const across = dx * -stamp.dirZ + dz * stamp.dirX;
  const halfLength = stamp.length / 2;
  const halfWidth = stamp.width / 2;
  const absAlong = Math.abs(along);
  const absAcross = Math.abs(across);
  if (absAlong >= halfLength + stamp.falloff || absAcross >= halfWidth + stamp.falloff) return height;
  const mask = (1 - smoothstep(halfLength, halfLength + stamp.falloff, absAlong)) * (1 - smoothstep(halfWidth, halfWidth + stamp.falloff, absAcross));
  if (mask <= 0) return height;
  const clampedAlong = along < -halfLength ? -halfLength : along > halfLength ? halfLength : along;
  const clampedAcross = across < -halfWidth ? -halfWidth : across > halfWidth ? halfWidth : across;
  const profile = terraceProfile(stamp, clampedAlong, clampedAcross);
  return height + (profile - height) * mask;
}

/**
 * The shelf (0 .. steps - 1) whose pool holds (x, z), or -1: inside the shelf's pool floor and lip
 * span along the stamp and between its side walls. Water bodies on terraces clip to their shelf.
 */
export function terraceShelfAt(stamp, x, z) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = dx * stamp.dirX + dz * stamp.dirZ;
  const across = dx * -stamp.dirZ + dz * stamp.dirX;
  if (Math.abs(across) >= stamp.width / 2 - TERRACE_SIDE_WALL * 0.4) return -1;
  const fromTop = along + stamp.length / 2;
  if (fromTop < 0 || fromTop >= stamp.length) return -1;
  const shelf = Math.floor(fromTop / stamp.stepLength);
  const share = fromTop / stamp.stepLength - shelf;
  return share < TERRACE_LIP_END ? shelf : -1;
}

/**
 * The height after one resolved stamp at (x, z), given the height before it. Exactly `height`
 * outside the stamp's bounds.
 */
export function applyStampHeight(stamp, x, z, height) {
  return stampHeightByKind(stamp.kind, stamp, x, z, height);
}

/**
 * The height function of each stamp kind (STAMP_TYPES order), each (stamp, x, z, height) -> height.
 * worldgen's hot path keeps the kinds in a typed array and calls through this table, so each type's
 * function only ever sees stamps of one shape and its property reads stay monomorphic.
 */
export const STAMP_HEIGHT = Object.freeze([coneHeight, carveHeight, cliffStepHeight, gorgeHeight, flattenHeight, islandBaseHeight, basinHeight, craterHeight, terracesHeight]);

/** applyStampHeight with the stamp's kind passed in. */
function stampHeightByKind(kind, stamp, x, z, height) {
  switch (kind) {
    case 0: return coneHeight(stamp, x, z, height);
    case 1: return carveHeight(stamp, x, z, height);
    case 2: return cliffStepHeight(stamp, x, z, height);
    case 3: return gorgeHeight(stamp, x, z, height);
    case 4: return flattenHeight(stamp, x, z, height);
    case 5: return islandBaseHeight(stamp, x, z, height);
    case 6: return basinHeight(stamp, x, z, height);
    case 7: return craterHeight(stamp, x, z, height);
    default: return terracesHeight(stamp, x, z, height);
  }
}

// ---- Paint --------------------------------------------------------------------------------------
function paintCone(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const distance = Math.hypot(dx, dz);
  if (distance >= stamp.radius) return;
  const share = coneElevation(stamp, distance, dx, dz) / stamp.height;
  const basaltOnly = stamp.paintIndex === PAINT_INDEX.basalt;
  const ash = basaltOnly ? 0 : smoothstep(0.4, 0.62, share);
  const outward = distance / stamp.radius;
  let basalt;
  if (basaltOnly) basalt = smoothstep(0.08, 0.3, share);
  else if (distance <= 0) basalt = 0;
  else {
    // Lava flows: two angular waves (5 and 8 lobes) whose peaks run down the lower flanks, curling
    // as they go, so the flows are irregular tongues rather than even sectors.
    const turn = outward * 0.6;
    const turnCos = Math.cos(turn);
    const turnSin = Math.sin(turn);
    const cosAngle = (dx * turnCos - dz * turnSin) / distance;
    const sinAngle = (dz * turnCos + dx * turnSin) / distance;
    const flow = 0.6 * angularWave(cosAngle, sinAngle, 5, stamp.flowCos, stamp.flowSin) + 0.4 * angularWave(cosAngle, sinAngle, 8, stamp.flowCosB, stamp.flowSinB);
    basalt = smoothstep(0.55, 0.85, flow) * smoothstep(0.02, 0.1, share) * (1 - smoothstep(0.3, 0.5, share)) * (1 - ash);
  }
  if (ash >= basalt) {
    if (ash > out.weight) { out.weight = ash; out.paintIndex = PAINT_INDEX.ash; }
  } else if (basalt > out.weight) {
    out.weight = basalt;
    out.paintIndex = PAINT_INDEX.basalt;
  }
}

function paintCarve(stamp, x, z, out) {
  const data = stamp.data;
  const bounds = data.segmentBounds;
  let mask = carveSegmentsNear(stamp, x, z);
  while (mask !== 0) {
    const lowest = mask & -mask;
    const segment = 31 - Math.clz32(lowest);
    mask ^= lowest;
    const base = segment * 4;
    if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
    const startX = data.pointX[segment];
    const startZ = data.pointZ[segment];
    const segmentLength = data.segmentLengths[segment];
    const unitX = data.unitX[segment];
    const unitZ = data.unitZ[segment];
    let along = (x - startX) * unitX + (z - startZ) * unitZ;
    along = along < 0 ? 0 : along > segmentLength ? segmentLength : along;
    const distance = Math.hypot(x - (startX + unitX * along), z - (startZ + unitZ * along));
    const halfWidth = data.halfWidths[segment] + (data.halfWidths[segment + 1] - data.halfWidths[segment]) * (along / segmentLength);
    const travelled = data.segmentStart[segment] + along;
    const end = smoothstep(0, stamp.endRamp, travelled) * smoothstep(0, stamp.endRamp, stamp.length - travelled);
    const weight = (1 - smoothstep(halfWidth * 0.75, halfWidth * 1.08, distance)) * end;
    if (weight > out.weight) {
      out.weight = weight;
      out.paintIndex = stamp.paintIndex;
    }
  }
}

function paintCliffStep(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = dx * stamp.dirX + dz * stamp.dirZ;
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX);
  if (across >= stamp.width / 2 + stamp.falloff || Math.abs(along) >= stamp.length / 2 + stamp.falloff) return;
  // Wet dark rock where the water falls and the spray drifts: the middle of the face and the pool.
  const zone = smoothstep(-22, -6, along) * (1 - smoothstep(stamp.poolAlong + stamp.pool * 0.8, stamp.poolAlong + stamp.pool * 1.6, along));
  const wet = zone * (1 - smoothstep(stamp.width * 0.2, stamp.width * 0.42, across));
  const stream = (1 - smoothstep(stamp.channelWidth * 0.6, stamp.channelWidth * 1.1, across)) * (1 - smoothstep(stamp.length / 2, stamp.length / 2 + stamp.falloff, Math.abs(along)));
  if (wet >= stream) {
    if (wet > out.weight) { out.weight = wet; out.paintIndex = stamp.paintIndex; }
  } else if (stream > out.weight) {
    out.weight = stream;
    out.paintIndex = PAINT_INDEX.riverbed;
  }
}

function paintGorge(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = Math.abs(dx * stamp.dirX + dz * stamp.dirZ);
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX);
  const halfLength = stamp.length / 2;
  if (along >= halfLength) return;
  const weight = (1 - smoothstep(0.28, 0.5, across / stamp.halfWidth)) * (1 - smoothstep(halfLength - stamp.falloff, halfLength, along));
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

function paintFlatten(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = Math.abs(dx * stamp.dirX + dz * stamp.dirZ);
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX);
  const weight = (1 - smoothstep(stamp.length / 2 - 4, stamp.length / 2 + 2, along)) * (1 - smoothstep(stamp.width / 2 - 2, stamp.width / 2 + 2, across));
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

function paintIslandBase(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const reach = islandReach(stamp, dx, dz, Math.hypot(dx, dz));
  const weight = smoothstep(stamp.radius * 0.58, stamp.radius * 0.8, reach) * (1 - smoothstep(stamp.radius, stamp.radius + stamp.falloff * 0.6, reach));
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

function paintBasin(stamp, x, z, out) {
  const reach = basinReach(stamp, x, z);
  // The lake bed and a beach along its shore, fading out just past the rim crest.
  const weight = 1 - smoothstep(stamp.radius * 0.84, stamp.radius * 1.02, reach);
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

function paintCrater(stamp, x, z, out) {
  const distance = Math.hypot(x - stamp.x, z - stamp.z);
  // The bowl and the ejecta blanket thinning out down the flank.
  const weight = 1 - smoothstep(stamp.radius + stamp.rimWidth * 0.25, stamp.radius + stamp.rimWidth * 0.7, distance);
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

function paintTerraces(stamp, x, z, out) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const along = Math.abs(dx * stamp.dirX + dz * stamp.dirZ);
  const across = Math.abs(dx * -stamp.dirZ + dz * stamp.dirX);
  const weight = (1 - smoothstep(stamp.length / 2 - 4, stamp.length / 2 + stamp.falloff * 0.3, along))
    * (1 - smoothstep(stamp.width / 2 - 4, stamp.width / 2 + stamp.falloff * 0.3, across));
  if (weight > out.weight) {
    out.weight = weight;
    out.paintIndex = stamp.paintIndex;
  }
}

/**
 * Raises out.weight / out.paintIndex to this stamp's paint at (x, z) when it is stronger there
 * (weights 0..1). Stamps without a paint leave `out` alone.
 */
export function accumulateStampPaint(stamp, x, z, out) {
  accumulateStampPaintByKind(stamp.kind, stamp, x, z, out);
}

/** accumulateStampPaint with the stamp's kind passed in (see stampHeightByKind). */
export function accumulateStampPaintByKind(kind, stamp, x, z, out) {
  if (stamp.paintIndex < 0) return;
  switch (kind) {
    case 0: paintCone(stamp, x, z, out); return;
    case 1: paintCarve(stamp, x, z, out); return;
    case 2: paintCliffStep(stamp, x, z, out); return;
    case 3: paintGorge(stamp, x, z, out); return;
    case 4: paintFlatten(stamp, x, z, out); return;
    case 5: paintIslandBase(stamp, x, z, out); return;
    case 6: paintBasin(stamp, x, z, out); return;
    case 7: paintCrater(stamp, x, z, out); return;
    default: paintTerraces(stamp, x, z, out);
  }
}
