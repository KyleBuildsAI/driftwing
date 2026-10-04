import * as THREE from 'three/webgpu';


// ============================================================================
// SHARED UTILITIES
// ============================================================================
export const MathUtils = THREE.MathUtils;

export const DEG = Math.PI / 180;


export function clamp(value, min, max) { return value < min ? min : value > max ? max : value; }

export function damp(current, target, lambda, dt) { return MathUtils.damp(current, target, lambda, dt); }

export function wrapDegrees(degrees) { return ((degrees % 360) + 360) % 360; }

/** Compass heading in degrees (0 = north = -z, 90 = east = +x) of a direction vector. */
export function headingFromVector(x, z) { return wrapDegrees(Math.atan2(x, -z) / DEG); }

/** Unit horizontal direction for a compass heading in degrees. */
export function vectorFromHeading(headingDegrees, target = new THREE.Vector3()) {
  const radians = headingDegrees * DEG;
  return target.set(Math.sin(radians), 0, -Math.cos(radians));
}

export function bearingTo(fromX, fromZ, toX, toZ) { return headingFromVector(toX - fromX, toZ - fromZ); }

export function compassName(headingDegrees) {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(wrapDegrees(headingDegrees) / 45) % 8];
}

export function isFiniteVector(vector) { return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z); }

export function isFiniteQuaternion(q) {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w) && Math.abs(q.lengthSq() - 1) < 0.1;
}
