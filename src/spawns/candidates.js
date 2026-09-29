// Event candidates: where and when a temporary happening (a storm, a flock, a meteor shower) COULD
// start. Pure and deterministic, with no imports, so the director, the labs and the determinism
// test all see the same candidates for the same seed.
//
// Every event preset tiles the world with square cells of candidates.cellSize metres and cuts flight
// time into buckets of candidates.bucketSeconds. Each (cell, bucket) rolls once:
//
//   hash(seed, cellX, cellZ, timeBucket, presetId) / 2^32 < candidates.chance
//
// and a hit is a dormant candidate for that bucket, at a seeded point inside the cell (kept away from
// the cell edges) with a seeded heading. The director decides which dormant candidate, if any, is
// activated; one that is not simply lapses when its bucket ends.
//
// Records come from a pool and are reused every director tick (no garbage at 2 Hz). A candidate's
// string id, '<presetId>:<cellX>:<cellZ>:<bucket>', is only built when it is needed (the log, the
// debugger).
//
// Headings and bearings are compass degrees: 0 north (-z), 90 east (+x).

/** Defaults for a preset whose candidates block leaves a field out. */
export const CANDIDATE_DEFAULTS = Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.2 });
/** A candidate sits at least this share of the cell size away from the cell's edges. */
const CELL_MARGIN = 0.1;
const TWO_POW_32 = 4294967296;

/** 32-bit finaliser (murmur3 fmix32): a well-mixed unsigned 32-bit integer. */
export function mix32(value) {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** FNV-1a of a string, finalised with mix32 (the world generator's string hash). */
export function hashString(text) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash >>> 0);
}

/** The world seed's hash, equal to worldgen's seedHash for the same seed string. */
export function seedHashFor(seedString) {
  return hashString(String(seedString).toUpperCase());
}

/** Maps a uint32 hash to [0, 1). */
export function unitFromHash(hash) {
  return (hash >>> 0) / TWO_POW_32;
}

/** A second independent value from a hash (salted remix). */
export function rehash(hash, salt) {
  return mix32((hash ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0);
}

/** hash(seed, cellX, cellZ, timeBucket, presetId) as a uint32; presetHash is hashString(presetId). */
export function candidateHash(seedHash, cellX, cellZ, timeBucket, presetHash) {
  let hash = mix32((seedHash ^ Math.imul(presetHash | 0, 0x9e3779b1)) >>> 0);
  hash = mix32((hash ^ (cellX | 0)) >>> 0);
  hash = mix32((hash + Math.imul(cellZ | 0, 0x27d4eb2d)) >>> 0);
  return mix32((hash ^ Math.imul(timeBucket | 0, 0x165667b1)) >>> 0);
}

/** The preset's candidate settings with the defaults filled in. */
export function candidateSettings(preset) {
  const own = preset && preset.candidates ? preset.candidates : {};
  return {
    cellSize: Number.isFinite(own.cellSize) && own.cellSize > 0 ? own.cellSize : CANDIDATE_DEFAULTS.cellSize,
    bucketSeconds: Number.isFinite(own.bucketSeconds) && own.bucketSeconds > 0 ? own.bucketSeconds : CANDIDATE_DEFAULTS.bucketSeconds,
    chance: Number.isFinite(own.chance) ? Math.min(1, Math.max(0, own.chance)) : CANDIDATE_DEFAULTS.chance,
  };
}

/** Compass bearing (degrees, 0 north, 90 east) from one point to another. */
export function bearingDegrees(fromX, fromZ, toX, toZ) {
  const degrees = (Math.atan2(toX - fromX, -(toZ - fromZ)) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** Smallest absolute difference between two compass angles (0..180 degrees). */
export function angleBetween(first, second) {
  return Math.abs((((first - second) % 360) + 540) % 360 - 180);
}

/** A reusable candidate record. */
function createRecord() {
  return {
    hash: 0,
    presetIndex: -1,
    cellX: 0,
    cellZ: 0,
    bucket: 0,
    x: 0,
    z: 0,
    roll: 0,
    heading: 0,
    /** Site active states: the index of the site in the director's site scratch, else -1. */
    siteIndex: -1,
    distance: 0,
    bearing: 0,
    offAxis: 0,
    score: 0,
    /** The director's ranking for one choice (due tier, ahead score and roll). */
    rank: 0,
    /** Its environment filters admit it now (the director lists it as dormant). */
    viable: false,
    /** The director may activate it now. */
    eligible: false,
    /** Why the director passed it over ('' when eligible). */
    rejection: '',
  };
}

/**
 * A growable pool of candidate records. reset() starts a new tick; acquire() hands out the next
 * record (records are only created when a tick needs more than any tick before it).
 */
export function createCandidatePool(initialCapacity = 64) {
  const records = [];
  for (let index = 0; index < initialCapacity; index++) records.push(createRecord());
  const pool = {
    records,
    count: 0,
    reset() {
      pool.count = 0;
    },
    acquire() {
      if (pool.count === records.length) records.push(createRecord());
      const record = records[pool.count++];
      record.siteIndex = -1;
      record.viable = false;
      record.eligible = false;
      record.rejection = '';
      record.score = 0;
      record.rank = 0;
      return record;
    },
  };
  return pool;
}

/**
 * Appends one preset's dormant candidates within radius of (x, z) at flight time `time` to the pool.
 * settings is candidateSettings(preset). Cells are visited in a fixed order (z rows, then x), so the
 * pool order is deterministic. Returns how many were added.
 */
export function collectPresetCandidates(pool, { seedHash, presetIndex, presetHash, settings, x, z, radius, time }) {
  const { cellSize, bucketSeconds, chance } = settings;
  if (chance <= 0) return 0;
  const bucket = Math.floor(time / bucketSeconds);
  const minCellX = Math.floor((x - radius) / cellSize);
  const maxCellX = Math.floor((x + radius) / cellSize);
  const minCellZ = Math.floor((z - radius) / cellSize);
  const maxCellZ = Math.floor((z + radius) / cellSize);
  const radiusSq = radius * radius;
  const span = 1 - 2 * CELL_MARGIN;
  let added = 0;
  for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      const hash = candidateHash(seedHash, cellX, cellZ, bucket, presetHash);
      const roll = unitFromHash(hash);
      if (roll >= chance) continue;
      const candidateX = (cellX + CELL_MARGIN + span * unitFromHash(rehash(hash, 1))) * cellSize;
      const candidateZ = (cellZ + CELL_MARGIN + span * unitFromHash(rehash(hash, 2))) * cellSize;
      const dx = candidateX - x;
      const dz = candidateZ - z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > radiusSq) continue;
      const record = pool.acquire();
      record.hash = hash;
      record.presetIndex = presetIndex;
      record.cellX = cellX;
      record.cellZ = cellZ;
      record.bucket = bucket;
      record.x = candidateX;
      record.z = candidateZ;
      record.roll = roll / chance;
      record.heading = unitFromHash(rehash(hash, 3)) * 360;
      record.distance = Math.sqrt(distanceSq);
      added++;
    }
  }
  return added;
}

/** The candidate's stable id: '<presetId>:<cellX>:<cellZ>:<bucket>'. */
export function candidateId(record, presetId) {
  return `${presetId}:${record.cellX}:${record.cellZ}:${record.bucket}`;
}

/**
 * How well a candidate sits ahead of the player: 1 dead ahead at the preferred distance, falling off
 * with the angle off the heading and with the distance from the preferred one; 0 outside the cone or
 * the [minDistance, maxDistance] band (never behind).
 */
export function aheadScore(distance, offAxis, { minDistance, maxDistance, maxOffAxis }) {
  if (!(distance >= minDistance && distance <= maxDistance) || !(offAxis <= maxOffAxis)) return 0;
  const preferred = (minDistance + maxDistance) / 2;
  const halfBand = Math.max(1, (maxDistance - minDistance) / 2);
  const distanceFit = 1 - 0.5 * Math.min(1, Math.abs(distance - preferred) / halfBand);
  const axisFit = Math.cos((offAxis * Math.PI) / 180);
  return distanceFit * axisFit;
}

/**
 * Total order for choosing among scored candidates: higher score first, then lower hash, preset
 * index, cell and bucket, so equal scores never depend on the pool order.
 */
export function compareCandidates(first, second) {
  if (first.score !== second.score) return second.score - first.score;
  if (first.hash !== second.hash) return first.hash - second.hash;
  if (first.presetIndex !== second.presetIndex) return first.presetIndex - second.presetIndex;
  if (first.cellX !== second.cellX) return first.cellX - second.cellX;
  if (first.cellZ !== second.cellZ) return first.cellZ - second.cellZ;
  return first.bucket - second.bucket;
}
