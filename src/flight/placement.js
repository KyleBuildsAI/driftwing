// Ground placement for "Start on ground": a nearby flat, dry spot found with a slope check on the
// shared height function (the same one collision uses), clear of the scattered vegetation along the
// take-off run, and the craft's resting pose on its gear.
import * as THREE from 'three/webgpu';
import { DEG, vectorFromHeading } from '../core/util.js';

const FLAT = Object.freeze({
  /** Largest rise per metre across the parking footprint (about 4 degrees). */
  MAX_SLOPE: 0.07,
  FOOTPRINT_RADII: Object.freeze([6, 14]),
  /** The take-off run into the wind is checked for this length and allowed this much rise or dip. */
  RUNWAY_LENGTH: 180,
  RUNWAY_STEP: 30,
  RUNWAY_MAX_DEVIATION: 7,
  /**
   * Longer strips (a jet's take-off run) must be smooth, not just level: sampled every LONG_STEP, no
   * bump or dip beyond LONG_MAX_BUMP about the straight line from start to end, which may climb or
   * fall by at most LONG_MAX_GRADE.
   */
  LONG_STEP: 15,
  LONG_MAX_BUMP: 3,
  LONG_MAX_GRADE: 0.02,
  /**
   * Smooth long strips are rare in rugged country, so the fallback ranks candidates by the smoothness
   * of their strip (score per metre of bump) and never by a footprint alone.
   */
  LONG_DEVIATION_WEIGHT: 0.03,
  LONG_UNCHECKED_PENALTY: 1,
  /** Dry means the whole footprint stands this far above the water. */
  MIN_DRY_HEIGHT: 1.5,
  RING_STEP: 90,
  MAX_RADIUS: 4500,
  DISTANCE_WEIGHT: 0.000015,
  /** Candidates whose analytic height rises this many times MAX_SLOPE are rejected before the full check. */
  QUICK_REJECT_FACTOR: 1.6,
});
const PITCH_SEARCH = Object.freeze({ MIN: -25 * DEG, MAX: 30 * DEG });
const TANGENT_TOLERANCE = 1e-6;
/**
 * Vegetation clearance. Trees, palms, cacti and rocks come from the world's deterministic scatter at
 * full density (every quality level draws a subset of it); ground-cover flowers never block. At most
 * CHUNK_BUDGET chunks are scattered per search (about 2 ms each), so a forest-covered region cannot
 * stall a craft switch: past the budget, spots are judged on the terrain alone.
 */
const VEGETATION_CLEARANCE = Object.freeze({ CHUNK_BUDGET: 40, TREE_RADIUS: 2.6, SMALL_RADIUS: 1.3 });

/** Obstacle lookups for one search: scatters chunks on demand (cached, within the budget). */
function createVegetationProbe(world) {
  const chunkSize = world.CHUNK_SIZE;
  const stride = world.SCATTER_STRIDE;
  const types = world.VEGETATION;
  const cache = new Map();
  let scattered = 0;

  /** Flat [x, z, radius, ...] obstacles of a chunk, or null once the budget is spent. */
  function chunkObstacles(chunkX, chunkZ) {
    const key = `${chunkX},${chunkZ}`;
    if (cache.has(key)) return cache.get(key);
    if (scattered >= VEGETATION_CLEARANCE.CHUNK_BUDGET) return null;
    scattered++;
    const raw = world.scatterChunk(chunkX, chunkZ, 1);
    const obstacles = [];
    for (let offset = 0; offset < raw.length; offset += stride) {
      const type = raw[offset + 5];
      if (type === types.FLOWERS) continue;
      const small = type === types.ROCK || type === types.CACTUS;
      const radius = (small ? VEGETATION_CLEARANCE.SMALL_RADIUS : VEGETATION_CLEARANCE.TREE_RADIUS) * raw[offset + 3];
      obstacles.push(chunkX * chunkSize + raw[offset], chunkZ * chunkSize + raw[offset + 2], radius);
    }
    cache.set(key, obstacles);
    return obstacles;
  }

  /**
   * Whether vegetation stands within `radius` of the parking spot (x, z) or within `halfWidth` of the
   * take-off run of `length` metres along heading. Returns null when the budget ran out before every
   * chunk involved could be checked.
   */
  function blocked(x, z, heading, { radius, halfWidth, length }) {
    const direction = vectorFromHeading(heading);
    const endX = x + direction.x * length;
    const endZ = z + direction.z * length;
    const margin = Math.max(radius, halfWidth) + VEGETATION_CLEARANCE.TREE_RADIUS * 2;
    const minChunkX = Math.floor((Math.min(x, endX) - margin) / chunkSize);
    const maxChunkX = Math.floor((Math.max(x, endX) + margin) / chunkSize);
    const minChunkZ = Math.floor((Math.min(z, endZ) - margin) / chunkSize);
    const maxChunkZ = Math.floor((Math.max(z, endZ) + margin) / chunkSize);
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
      for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
        const obstacles = chunkObstacles(chunkX, chunkZ);
        if (!obstacles) return null;
        for (let index = 0; index < obstacles.length; index += 3) {
          const offsetX = obstacles[index] - x;
          const offsetZ = obstacles[index + 1] - z;
          const size = obstacles[index + 2];
          if (Math.hypot(offsetX, offsetZ) < radius + size) return true;
          const along = offsetX * direction.x + offsetZ * direction.z;
          if (along < 0 || along > length) continue;
          const across = Math.abs(offsetX * direction.z - offsetZ * direction.x);
          if (across < halfWidth + size) return true;
        }
      }
    }
    return false;
  }

  return { blocked };
}

/** Steepest rise per metre from (x, z) out to the footprint radii, and the lowest point there. */
function footprint(world, x, z) {
  const center = world.groundHeight(x, z);
  let slope = 0;
  let lowest = center;
  for (const radius of FLAT.FOOTPRINT_RADII) {
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const height = world.groundHeight(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      slope = Math.max(slope, Math.abs(height - center) / radius);
      lowest = Math.min(lowest, height);
    }
  }
  return { center, slope, lowest };
}

/**
 * Cheap estimate from the analytic height (5 samples instead of the footprint's 17 mesh heights of
 * 4 samples each): the centre height and the steepest rise per metre out to the outer footprint radius.
 */
function quickLook(world, x, z) {
  const radius = FLAT.FOOTPRINT_RADII[FLAT.FOOTPRINT_RADII.length - 1];
  const center = world.heightAt(x, z);
  const east = Math.abs(world.heightAt(x + radius, z) - center);
  const west = Math.abs(world.heightAt(x - radius, z) - center);
  const south = Math.abs(world.heightAt(x, z + radius) - center);
  const north = Math.abs(world.heightAt(x, z - radius) - center);
  return { center, slope: Math.max(east, west, south, north) / radius };
}

/** Largest rise or dip along the take-off run (m), and whether the run stays dry. */
function runway(world, x, z, heading, center, waterLevel, isWater) {
  const direction = vectorFromHeading(heading);
  let deviation = 0;
  let dry = true;
  for (let distance = FLAT.RUNWAY_STEP; distance <= FLAT.RUNWAY_LENGTH; distance += FLAT.RUNWAY_STEP) {
    const runX = x + direction.x * distance;
    const runZ = z + direction.z * distance;
    const height = world.groundHeight(runX, runZ);
    deviation = Math.max(deviation, Math.abs(height - center));
    if (height < waterLevel + FLAT.MIN_DRY_HEIGHT || (isWater !== null && isWater(runX, runZ))) dry = false;
  }
  return { deviation, dry };
}

/**
 * A long take-off strip: its bumpiness (m) about the straight line from the start to the end, plus
 * the height its grade climbs or falls beyond LONG_MAX_GRADE, and whether it stays dry.
 */
function longRunway(world, x, z, heading, center, waterLevel, length, isWater) {
  const direction = vectorFromHeading(heading);
  const endHeight = world.groundHeight(x + direction.x * length, z + direction.z * length);
  let bump = 0;
  let dry = endHeight >= waterLevel + FLAT.MIN_DRY_HEIGHT;
  for (let distance = FLAT.LONG_STEP; distance < length; distance += FLAT.LONG_STEP) {
    const runX = x + direction.x * distance;
    const runZ = z + direction.z * distance;
    const height = world.groundHeight(runX, runZ);
    const line = center + ((endHeight - center) * distance) / length;
    bump = Math.max(bump, Math.abs(height - line));
    if (height < waterLevel + FLAT.MIN_DRY_HEIGHT || (isWater !== null && isWater(runX, runZ))) dry = false;
  }
  const gradeExcess = Math.max(0, Math.abs(endHeight - center) / length - FLAT.LONG_MAX_GRADE) * length;
  return { deviation: bump + gradeExcess, dry };
}

/**
 * Clearance a craft needs from vegetation, from its contact points (body axes, m): the parking circle
 * reaches past its farthest point, the take-off corridor (runwayLength metres) past its wingtips.
 */
export function vegetationClearance(contacts, margin = 2, runwayLength = FLAT.RUNWAY_LENGTH) {
  let radius = 0;
  let halfWidth = 0;
  for (const contact of contacts) {
    radius = Math.max(radius, Math.hypot(contact.position[0], contact.position[2]));
    halfWidth = Math.max(halfWidth, Math.abs(contact.position[0]));
  }
  return { radius: radius + margin, halfWidth: halfWidth + margin, length: runwayLength };
}

/**
 * Nearest flat, dry spot to (x, z), searching outward in rings. headingFor(x, z) gives the take-off
 * heading there (into the wind), whose run must be flat and dry as well. With `clearance` (see
 * vegetationClearance) the spot and its run must also be clear of trees, cacti and rocks. Falls back
 * to the flattest dry spot seen when nothing within MAX_RADIUS passes. Returns { x, z, ground, slope,
 * runwayDeviation, flat, clearOfVegetation } (clearOfVegetation is null when it was not checked).
 * runwayLength (m, default 180) is the take-off run a craft needs; a longer strip (the jet's) must also
 * be smooth and gently graded (see longRunway). isWater(x, z) (the shared water query's) keeps the
 * spot and its run out of local water bodies too (lakes, pools, frozen lakes) besides the sea.
 */
export function findFlatSpot(world, x, z, { waterLevel = 0, headingFor = () => 0, clearance = null, runwayLength = FLAT.RUNWAY_LENGTH, isWater = null } = {}) {
  const long = runwayLength > FLAT.RUNWAY_LENGTH;
  const maxDeviation = long ? FLAT.LONG_MAX_BUMP : FLAT.RUNWAY_MAX_DEVIATION;
  const vegetation = clearance && typeof world.scatterChunk === 'function' ? createVegetationProbe(world) : null;
  let fallback = null;
  let gentlest = null;
  for (let radius = 0; radius <= FLAT.MAX_RADIUS; radius += FLAT.RING_STEP) {
    const samples = radius === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * radius) / FLAT.RING_STEP));
    const flatInRing = [];
    for (let sample = 0; sample < samples; sample++) {
      const angle = (sample / samples) * Math.PI * 2;
      const candidateX = x + Math.cos(angle) * radius;
      const candidateZ = z + Math.sin(angle) * radius;
      const rough = quickLook(world, candidateX, candidateZ);
      if (rough.center < waterLevel + FLAT.MIN_DRY_HEIGHT || (isWater !== null && isWater(candidateX, candidateZ))) continue;
      if (rough.slope > FLAT.MAX_SLOPE * FLAT.QUICK_REJECT_FACTOR) {
        if (!gentlest || rough.slope < gentlest.slope) gentlest = { x: candidateX, z: candidateZ, slope: rough.slope };
        continue;
      }
      const foot = footprint(world, candidateX, candidateZ);
      if (foot.lowest < waterLevel + FLAT.MIN_DRY_HEIGHT) continue;
      const score = foot.slope + radius * FLAT.DISTANCE_WEIGHT;
      if (foot.slope > FLAT.MAX_SLOPE) {
        const steepScore = score + (long ? FLAT.LONG_UNCHECKED_PENALTY : 0);
        if (!fallback || steepScore < fallback.score) fallback = { x: candidateX, z: candidateZ, ground: foot.center, slope: foot.slope, runwayDeviation: Infinity, flat: false, clearOfVegetation: null, score: steepScore };
        continue;
      }
      const heading = headingFor(candidateX, candidateZ);
      const run = long ? longRunway(world, candidateX, candidateZ, heading, foot.center, waterLevel, runwayLength, isWater) : runway(world, candidateX, candidateZ, heading, foot.center, waterLevel, isWater);
      const runScore = long ? run.deviation * FLAT.LONG_DEVIATION_WEIGHT + (run.dry ? 0 : FLAT.LONG_UNCHECKED_PENALTY) : run.deviation / FLAT.RUNWAY_LENGTH;
      const candidate = { x: candidateX, z: candidateZ, heading, ground: foot.center, slope: foot.slope, runwayDeviation: run.deviation, flat: run.dry && run.deviation <= maxDeviation, clearOfVegetation: null, score: score + runScore };
      if (candidate.flat) flatInRing.push(candidate);
      if (!fallback || candidate.score < fallback.score) fallback = candidate;
    }
    // Best first: the first flat spot whose parking circle and take-off run are clear of vegetation.
    flatInRing.sort((first, second) => first.score - second.score);
    for (const candidate of flatInRing) {
      if (!vegetation) return candidate;
      const blocked = vegetation.blocked(candidate.x, candidate.z, candidate.heading, clearance);
      if (blocked === true) continue;
      candidate.clearOfVegetation = blocked === false ? true : null;
      return candidate;
    }
  }
  if (fallback) return fallback;
  // Nothing passed the quick check anywhere (rugged country): the gentlest spot seen.
  const last = gentlest ?? { x, z };
  const foot = footprint(world, last.x, last.z);
  return { x: last.x, z: last.z, ground: foot.center, slope: foot.slope, runwayDeviation: Infinity, flat: false, clearOfVegetation: null, score: Infinity };
}

/** Height of a body point (x right, y up, z aft) after pitching the nose up by pitch radians. */
function pitchedHeight(position, pitch) {
  return position[1] * Math.cos(pitch) - position[2] * Math.sin(pitch);
}

/**
 * Resting pitch (radians, nose up positive) with wings level: the ground line is the lower tangent of
 * the contact points (side view) through one gear point at or ahead of the centre of mass and one at
 * or behind it, so the craft sits on its gear (a taildragger nose-high on mains and tail wheel).
 */
export function restPitch(contacts, centerOfMassZ = 0) {
  const gear = contacts.filter((contact) => contact.gear && Math.abs(contact.position[0]) < 1.5);
  let best = null;
  for (const front of gear) {
    if (front.position[2] > centerOfMassZ) continue;
    for (const back of gear) {
      if (back === front || back.position[2] < centerOfMassZ || back.position[2] <= front.position[2]) continue;
      const pitch = Math.atan2(front.position[1] - back.position[1], front.position[2] - back.position[2]);
      const normalized = pitch > Math.PI / 2 ? pitch - Math.PI : pitch < -Math.PI / 2 ? pitch + Math.PI : pitch;
      if (normalized < PITCH_SEARCH.MIN || normalized > PITCH_SEARCH.MAX) continue;
      const line = pitchedHeight(front.position, normalized);
      const supported = contacts.every((contact) => pitchedHeight(contact.position, normalized) >= line - TANGENT_TOLERANCE);
      if (!supported) continue;
      const span = back.position[2] - front.position[2];
      if (!best || span > best.span) best = { pitch: normalized, span };
    }
  }
  return best ? best.pitch : 0;
}

/**
 * The craft at rest on its gear at (x, z) facing heading: pitched to its resting attitude and raised
 * until no contact point is below the shared height function (so at least one touches and none
 * intersect). Returns { position, quaternion, pitch }.
 */
export function groundPose(world, contacts, x, z, heading, centerOfMassZ = 0) {
  const pitch = restPitch(contacts, centerOfMassZ);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
  const offset = new THREE.Vector3();
  let height = -Infinity;
  for (const contact of contacts) {
    offset.set(contact.position[0], contact.position[1], contact.position[2]).applyQuaternion(quaternion);
    height = Math.max(height, world.groundHeight(x + offset.x, z + offset.z) - offset.y);
  }
  return { position: new THREE.Vector3(x, height, z), quaternion, pitch };
}
