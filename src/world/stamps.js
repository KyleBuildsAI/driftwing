// Terrain stamps: deterministic height edits that sites make to the shared height function.
//
// A site preset lists stamp SPECS (sizes as numbers or [min, max] ranges, in metres). Placement
// (placement.js) resolves each spec once per site into a RESOLVED stamp: plain world-space geometry
// (centre, rotation, sizes, reference heights, bounds, paint). worldgen.heightAt then applies the
// resolved stamps after the Phase 1 landmark shaping, so the terrain meshes of every LOD ring, the
// skirts and the collision height (groundHeight) all see the same edited surface.
//
// Every stamp has a smooth falloff and changes nothing outside its bounds (an axis-aligned box that
// placement's spatial hash uses), so the edit blends into the terrain around it.
//
// Pure: no imports and no DOM, so the terrain worker runs exactly this code too.
// Axes: +x east, -z north. A stamp's `rotation` is a compass heading in radians (0 = north,
// clockwise), its forward axis is (dirX, dirZ) = (sin r, -cos r) and its right axis is (-dirZ, dirX).
//
// Spec fields per type (every size may be a [min, max] range; placement rolls it per site):
//   common      offset { along, across } (m, in the site frame), rotation (radians, added to the
//               site's), paint (see STAMP_PAINTS; each type has a default, null for none)
//   cone        radius, height, craterRadius, craterDepth, gullies (count)            paint 'ash'
//   carve       length (2-4 km), width (floor), depth, wallWidth, twist (meander, m),
//               segments                                                          paint 'riverbed'
//   cliffStep   width (along the lip), drop, length (upstream + downstream), face, falloff,
//               pool (plunge pool radius)                                         paint 'wetRock'
//   gorge       length, width (top), depth, falloff (end taper), pad (anchor pads) paint 'riverbed'
//   flatten     length, width (the strip), margin (flat apron), shoulder (falloff) paint 'tarmac'
//   islandBase  radius, height (above the water), falloff                          paint 'basalt'

export const STAMP_TYPES = Object.freeze(['cone', 'carve', 'cliffStep', 'gorge', 'flatten', 'islandBase']);
export const STAMP_PAINTS = Object.freeze(['ash', 'basalt', 'wetRock', 'tarmac', 'riverbed']);

const KIND = Object.freeze({ cone: 0, carve: 1, cliffStep: 2, gorge: 3, flatten: 4, islandBase: 5 });
const PAINT_INDEX = Object.freeze({ ash: 0, basalt: 1, wetRock: 2, tarmac: 3, riverbed: 4 });
const TAU = Math.PI * 2;

/** Defaults per type: the sizes a preset may leave out. */
const DEFAULTS = Object.freeze({
  cone: Object.freeze({ radius: [900, 1300], height: [320, 480], craterRadius: [150, 220], craterDepth: [70, 120], gullies: [6, 9], paint: 'ash' }),
  carve: Object.freeze({ length: [2000, 4000], width: [34, 56], depth: [70, 120], wallWidth: [18, 30], twist: [180, 380], segments: 14, paint: 'riverbed' }),
  cliffStep: Object.freeze({ width: [280, 420], drop: [80, 140], length: [420, 620], face: [8, 14], falloff: [120, 180], pool: [45, 70], paint: 'wetRock' }),
  gorge: Object.freeze({ length: [700, 1100], width: [80, 130], depth: [80, 120], falloff: [150, 220], pad: [60, 90], paint: 'riverbed' }),
  flatten: Object.freeze({ length: [1100, 1500], width: [40, 60], margin: [30, 55], shoulder: [100, 170], paint: 'tarmac' }),
  islandBase: Object.freeze({ radius: [140, 240], height: [20, 45], falloff: [80, 130], paint: 'basalt' }),
});

/** Every size field per type, validated as a positive number or an ascending [min, max] range. */
const SIZE_FIELDS = Object.freeze({
  cone: ['radius', 'height', 'craterRadius', 'craterDepth', 'gullies'],
  carve: ['length', 'width', 'depth', 'wallWidth', 'twist'],
  cliffStep: ['width', 'drop', 'length', 'face', 'falloff', 'pool'],
  gorge: ['length', 'width', 'depth', 'falloff', 'pad'],
  flatten: ['length', 'width', 'margin', 'shoulder'],
  islandBase: ['radius', 'height', 'falloff'],
});

function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }
function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function isSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  return Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isFinite(entry) && entry >= 0) && value[0] <= value[1];
}
function maxOf(value) { return Array.isArray(value) ? value[1] : value; }
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
      extent = maxOf(full.length) / 2 + maxOf(full.twist) + (maxOf(full.width) / 2) * 1.25 + maxOf(full.wallWidth) * 1.2 + 8;
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
    default:
      extent = maxOf(full.radius) + maxOf(full.falloff);
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
  stamp.gullyPhase = random() * TAU;
  stamp.flowPhase = random() * TAU;
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

function resolveCarve(stamp, spec, random, context) {
  const length = roll(spec.length, random);
  const halfWidth = roll(spec.width, random) / 2;
  const depth = roll(spec.depth, random);
  const wallWidth = roll(spec.wallWidth, random);
  const twist = roll(spec.twist, random);
  const segments = spec.segments;
  const frequencyA = 0.8 + 0.6 * random();
  const frequencyB = 1.8 + 0.8 * random();
  const phaseA = random() * TAU;
  const phaseB = random() * TAU;
  const count = segments + 1;
  const pointX = new Float64Array(count);
  const pointZ = new Float64Array(count);
  const floor = new Float64Array(count);
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
  // The river floor only ever runs downhill from the first point to the last, and stays above the sea.
  const segmentLengths = new Float64Array(segments);
  const segmentStart = new Float64Array(segments);
  let total = 0;
  for (let index = 0; index < segments; index++) {
    segmentLengths[index] = Math.hypot(pointX[index + 1] - pointX[index], pointZ[index + 1] - pointZ[index]);
    segmentStart[index] = total;
    total += segmentLengths[index];
  }
  const floorLimit = context.waterLevel + 2;
  for (let index = 0; index < count; index++) {
    const own = context.baseHeight(pointX[index], pointZ[index]) - depth;
    const previous = index === 0 ? Infinity : floor[index - 1] - segmentLengths[index - 1] * 0.004;
    floor[index] = Math.max(Math.min(previous, own), floorLimit);
  }
  let maxHalfWidth = 0;
  let maxWall = 0;
  for (let index = 0; index < count; index++) {
    if (halfWidths[index] > maxHalfWidth) maxHalfWidth = halfWidths[index];
    if (wallWidths[index] > maxWall) maxWall = wallWidths[index];
  }
  // Wall wobble: the walls twist on their own, up to 30 % of the narrowest floor half-width.
  let minHalfWidth = Infinity;
  for (let index = 0; index < count; index++) if (halfWidths[index] < minHalfWidth) minHalfWidth = halfWidths[index];
  const wobble = Math.min(7, minHalfWidth * 0.3);
  const reach = maxHalfWidth + maxWall + wobble + 1;
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
  stamp.wobble = wobble;
  stamp.wobblePhaseLeft = random() * TAU;
  stamp.wobblePhaseRight = random() * TAU;
  stamp.endRamp = Math.min(total * 0.14, 450);
  stamp.data = { pointX, pointZ, floor, halfWidths, wallWidths, segmentLengths, segmentStart, segmentBounds, segments };
  stamp.path = Array.from({ length: count }, (unused, index) => Object.freeze({
    x: pointX[index], z: pointZ[index], floorY: floor[index], halfWidth: halfWidths[index], wallWidth: wallWidths[index],
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
  stamp.lipPhaseA = random() * TAU;
  stamp.lipPhaseB = random() * TAU;
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
  const rimY = Math.max((context.baseHeight(anchorA.x, anchorA.z) + context.baseHeight(anchorB.x, anchorB.z)) / 2, context.waterLevel + 8);
  const floorY = Math.max(rimY - depth, context.waterLevel + 2);
  stamp.length = length;
  stamp.halfWidth = halfWidth;
  stamp.depth = rimY - floorY;
  stamp.falloff = falloff;
  stamp.pad = pad;
  stamp.rimY = rimY;
  stamp.floorY = floorY;
  stamp.span = 2 * anchorOffset;
  stamp.wallPhase = random() * TAU;
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
  stamp.ledgePhase = random() * TAU;
  circleBounds(stamp, radius + falloff);
  stamp.keyPoints = [{ x: stamp.x, z: stamp.z }, { x: stamp.x + stamp.dirX * radius, z: stamp.z + stamp.dirZ * radius }];
}

const RESOLVERS = Object.freeze({
  cone: resolveCone,
  carve: resolveCarve,
  cliffStep: resolveCliffStep,
  gorge: resolveGorge,
  flatten: resolveFlatten,
  islandBase: resolveIslandBase,
});

/**
 * Resolves one stamp spec for a site into world-space geometry (a plain, frozen object).
 *   site: { id, presetId, x, z, rotation }
 *   index: the spec's position in the preset's stamps list
 *   random: a seeded () => [0, 1) stream for this stamp
 *   context: { baseHeight(x, z) (the UNSTAMPED height), waterLevel }
 * The result carries type, kind, siteId, presetId, index, order (the global apply order), x, z,
 * rotation, dirX, dirZ, bounds (minX, maxX, minZ, maxZ), paint, paintIndex, keyPoints (the stamp's
 * characteristic places, for tests and structures) and the type's own sizes and reference heights
 * (cone: baseY, peakY, rimY, craterFloorY; carve: path, entry, exit, length; cliffStep: topY,
 * bottomY, lipX/Z, poolX/Z; gorge: rimY, floorY, span, anchors; flatten: y, thresholds;
 * islandBase: topY).
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
    keyPoints: [],
  };
  RESOLVERS[full.type](stamp, full, random, context);
  stamp.keyPoints = Object.freeze(stamp.keyPoints.map((point) => Object.freeze({ x: point.x, z: point.z })));
  if (stamp.path) stamp.path = Object.freeze(stamp.path);
  if (stamp.anchors) stamp.anchors = Object.freeze(stamp.anchors);
  if (stamp.thresholds) stamp.thresholds = Object.freeze(stamp.thresholds);
  return Object.freeze(stamp);
}

/** Deterministic apply order of stamps that share cells (code-unit order of `order`). */
export function compareStampOrder(first, second) {
  return first.order < second.order ? -1 : first.order > second.order ? 1 : 0;
}

// ---- Height ------------------------------------------------------------------------------------
function coneElevation(stamp, distance, dx, dz) {
  if (distance < stamp.craterRadius) {
    const share = distance / stamp.craterRadius;
    const bowl = 1 - share * share;
    return stamp.height - stamp.craterDepth * bowl * Math.sqrt(bowl);
  }
  const outward = (distance - stamp.craterRadius) / (stamp.radius - stamp.craterRadius);
  const falloff = Math.pow(1 - outward, 1.7);
  const angle = Math.atan2(dz, dx);
  const gully = 1 + 0.07 * Math.sin(angle * stamp.gullies + stamp.gullyPhase + outward * 2.2) * outward * (1 - outward) * 4;
  return stamp.height * falloff * gully;
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
function carveHeight(stamp, x, z, height) {
  const data = stamp.data;
  const bounds = data.segmentBounds;
  let deepest = 0;
  for (let segment = 0; segment < data.segments; segment++) {
    const base = segment * 4;
    if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
    const startX = data.pointX[segment];
    const startZ = data.pointZ[segment];
    const segmentLength = data.segmentLengths[segment];
    const unitX = (data.pointX[segment + 1] - startX) / segmentLength;
    const unitZ = (data.pointZ[segment + 1] - startZ) / segmentLength;
    const offsetX = x - startX;
    const offsetZ = z - startZ;
    let along = offsetX * unitX + offsetZ * unitZ;
    along = along < 0 ? 0 : along > segmentLength ? segmentLength : along;
    const share = along / segmentLength;
    const nearestX = startX + unitX * along;
    const nearestZ = startZ + unitZ * along;
    const distance = Math.hypot(x - nearestX, z - nearestZ);
    const halfWidth = data.halfWidths[segment] + (data.halfWidths[segment + 1] - data.halfWidths[segment]) * share;
    const wallWidth = data.wallWidths[segment] + (data.wallWidths[segment + 1] - data.wallWidths[segment]) * share;
    const travelled = data.segmentStart[segment] + along;
    // Each wall twists on its own; the two wobbles blend across the floor, where they change nothing.
    const lateral = offsetX * -unitZ + offsetZ * unitX;
    const right = stamp.wobblePhaseRight;
    const left = stamp.wobblePhaseLeft;
    const wobbleRight = 0.6 * Math.sin(travelled * 0.021 + right) + 0.4 * Math.sin(travelled * 0.057 + right * 1.7);
    const wobbleLeft = 0.6 * Math.sin(travelled * 0.021 + left) + 0.4 * Math.sin(travelled * 0.057 + left * 1.7);
    const side = smoothstep(-halfWidth * 0.5, halfWidth * 0.5, lateral);
    const wall = distance + stamp.wobble * (wobbleLeft + (wobbleRight - wobbleLeft) * side);
    if (wall >= halfWidth + wallWidth) continue;
    const end = smoothstep(0, stamp.endRamp, travelled) * smoothstep(0, stamp.endRamp, stamp.length - travelled);
    if (end <= 0) continue;
    const floorY = data.floor[segment] + (data.floor[segment + 1] - data.floor[segment]) * share;
    const channel = 1.8 * (1 - smoothstep(0, halfWidth * 0.45, distance));
    const cut = height - (floorY - channel);
    if (cut <= 0) continue;
    const amount = cut * (1 - smoothstep(halfWidth, halfWidth + wallWidth, wall)) * end;
    if (amount > deepest) deepest = amount;
  }
  return height - deepest;
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
  const lip = 5 * Math.sin(across * 0.061 + stamp.lipPhaseA) + 2.5 * Math.sin(across * 0.173 + stamp.lipPhaseB);
  let target = stamp.topY - stamp.drop * smoothstep(-stamp.face / 2, stamp.face / 2, along - lip);
  target += (height - stamp.referenceY) * 0.15;
  const poolDistance = Math.hypot(along - stamp.poolAlong, across);
  if (poolDistance < stamp.pool) {
    const bowl = 1 - (poolDistance / stamp.pool) * (poolDistance / stamp.pool);
    target -= stamp.poolDepth * bowl * bowl;
  }
  if (absAcross < stamp.channelWidth) {
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
  const wobble = 4 * Math.sin(along * 0.037 + stamp.wallPhase) + 2 * Math.sin(along * 0.11 + stamp.wallPhase * 2.3);
  const share = Math.max(0, absAcross + wobble) / stamp.halfWidth;
  const wallShare = share < 1 ? share : 1;
  const channel = 2 * (1 - smoothstep(0, 0.3, share));
  const target = stamp.floorY - channel + (stamp.rimY - stamp.floorY) * wallShare * wallShare * wallShare;
  const edge = 1 - smoothstep(1, 1.35, share);
  const end = 1 - smoothstep(halfLength - stamp.falloff, halfLength, absAlong);
  let result = height;
  if (height > target) result = height - (height - target) * edge * end;
  // Anchor pads: level ground on both rims where the bridge's towers stand.
  const padAcross = Math.abs(absAcross - (stamp.halfWidth + stamp.pad / 2));
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
  const distance = Math.hypot(outsideAlong > 0 ? outsideAlong : 0, outsideAcross > 0 ? outsideAcross : 0);
  if (distance >= stamp.shoulder) return height;
  return height + (stamp.y - height) * (1 - smoothstep(0, stamp.shoulder, distance));
}

function islandBaseHeight(stamp, x, z, height) {
  const dx = x - stamp.x;
  const dz = z - stamp.z;
  const outer = stamp.radius + stamp.falloff;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= outer * outer) return height;
  const distance = Math.sqrt(distanceSq);
  const profile = 1 - smoothstep(stamp.radius * 0.5, stamp.radius, distance);
  const ledge = 1.5 * Math.sin(Math.atan2(dz, dx) * 5 + stamp.ledgePhase) * profile;
  const target = stamp.seabedY + (stamp.topY - stamp.seabedY) * Math.sqrt(profile) + ledge;
  if (target <= height) return height;
  return height + (target - height) * (1 - smoothstep(stamp.radius, outer, distance));
}

/**
 * The height after one resolved stamp at (x, z), given the height before it. Exactly `height`
 * outside the stamp's bounds.
 */
export function applyStampHeight(stamp, x, z, height) {
  switch (stamp.kind) {
    case 0: return coneHeight(stamp, x, z, height);
    case 1: return carveHeight(stamp, x, z, height);
    case 2: return cliffStepHeight(stamp, x, z, height);
    case 3: return gorgeHeight(stamp, x, z, height);
    case 4: return flattenHeight(stamp, x, z, height);
    default: return islandBaseHeight(stamp, x, z, height);
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
  const streak = 0.5 + 0.5 * Math.sin(Math.atan2(dz, dx) * 5 + stamp.flowPhase + outward * 3);
  const basalt = basaltOnly
    ? smoothstep(0.08, 0.3, share)
    : smoothstep(0.62, 0.82, streak) * smoothstep(0.02, 0.14, share) * (1 - ash);
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
  for (let segment = 0; segment < data.segments; segment++) {
    const base = segment * 4;
    if (x < bounds[base] || x > bounds[base + 1] || z < bounds[base + 2] || z > bounds[base + 3]) continue;
    const startX = data.pointX[segment];
    const startZ = data.pointZ[segment];
    const segmentLength = data.segmentLengths[segment];
    const unitX = (data.pointX[segment + 1] - startX) / segmentLength;
    const unitZ = (data.pointZ[segment + 1] - startZ) / segmentLength;
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
  const distance = Math.hypot(x - stamp.x, z - stamp.z);
  const weight = smoothstep(stamp.radius * 0.55, stamp.radius * 0.75, distance) * (1 - smoothstep(stamp.radius, stamp.radius + stamp.falloff * 0.6, distance));
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
  if (stamp.paintIndex < 0) return;
  switch (stamp.kind) {
    case 0: paintCone(stamp, x, z, out); return;
    case 1: paintCarve(stamp, x, z, out); return;
    case 2: paintCliffStep(stamp, x, z, out); return;
    case 3: paintGorge(stamp, x, z, out); return;
    case 4: paintFlatten(stamp, x, z, out); return;
    default: paintIslandBase(stamp, x, z, out);
  }
}
