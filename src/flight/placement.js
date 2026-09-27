// Ground placement for "Start on ground": a nearby flat, dry spot found with a slope check on the
// shared height function (the same one collision uses), and the craft's resting pose on its gear.
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
  /** Dry means the whole footprint stands this far above the water. */
  MIN_DRY_HEIGHT: 1.5,
  RING_STEP: 90,
  MAX_RADIUS: 4500,
  DISTANCE_WEIGHT: 0.000015,
});
const PITCH_SEARCH = Object.freeze({ MIN: -25 * DEG, MAX: 30 * DEG });
const TANGENT_TOLERANCE = 1e-6;

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

/** Largest rise or dip along the take-off run (m), and whether the run stays dry. */
function runway(world, x, z, heading, center, waterLevel) {
  const direction = vectorFromHeading(heading);
  let deviation = 0;
  let dry = true;
  for (let distance = FLAT.RUNWAY_STEP; distance <= FLAT.RUNWAY_LENGTH; distance += FLAT.RUNWAY_STEP) {
    const height = world.groundHeight(x + direction.x * distance, z + direction.z * distance);
    deviation = Math.max(deviation, Math.abs(height - center));
    if (height < waterLevel + FLAT.MIN_DRY_HEIGHT) dry = false;
  }
  return { deviation, dry };
}

/**
 * Nearest flat, dry spot to (x, z), searching outward in rings. headingFor(x, z) gives the take-off
 * heading there (into the wind), whose run must be clear as well. Falls back to the flattest dry spot
 * seen when nothing within MAX_RADIUS passes. Returns { x, z, ground, slope, runwayDeviation, flat }.
 */
export function findFlatSpot(world, x, z, { waterLevel = 0, headingFor = () => 0 } = {}) {
  let fallback = null;
  for (let radius = 0; radius <= FLAT.MAX_RADIUS; radius += FLAT.RING_STEP) {
    const samples = radius === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * radius) / FLAT.RING_STEP));
    let ringBest = null;
    for (let sample = 0; sample < samples; sample++) {
      const angle = (sample / samples) * Math.PI * 2;
      const candidateX = x + Math.cos(angle) * radius;
      const candidateZ = z + Math.sin(angle) * radius;
      const foot = footprint(world, candidateX, candidateZ);
      if (foot.lowest < waterLevel + FLAT.MIN_DRY_HEIGHT) continue;
      const score = foot.slope + radius * FLAT.DISTANCE_WEIGHT;
      if (foot.slope > FLAT.MAX_SLOPE) {
        if (!fallback || score < fallback.score) fallback = { x: candidateX, z: candidateZ, ground: foot.center, slope: foot.slope, runwayDeviation: Infinity, flat: false, score };
        continue;
      }
      const run = runway(world, candidateX, candidateZ, headingFor(candidateX, candidateZ), foot.center, waterLevel);
      const candidate = { x: candidateX, z: candidateZ, ground: foot.center, slope: foot.slope, runwayDeviation: run.deviation, flat: run.dry && run.deviation <= FLAT.RUNWAY_MAX_DEVIATION, score: score + run.deviation / FLAT.RUNWAY_LENGTH };
      if (candidate.flat && (!ringBest || candidate.score < ringBest.score)) ringBest = candidate;
      if (!fallback || candidate.score < fallback.score) fallback = candidate;
    }
    if (ringBest) return ringBest;
  }
  if (fallback) return fallback;
  return { x, z, ground: world.groundHeight(x, z), slope: Infinity, runwayDeviation: Infinity, flat: false, score: Infinity };
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
