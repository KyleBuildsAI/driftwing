import * as THREE from 'three/webgpu';
import { CONFIG } from './config.js';
import { DEG, clamp } from './util.js';


// ---- Sun path -------------------------------------------------------------------
// dayTime in [0, 1): 0 midnight, 0.25 sunrise (east), 0.5 noon (south), 0.75 sunset (west).
export function sunDirectionForDayTime(dayTime, target = new THREE.Vector3()) {
  const angle = (dayTime - 0.25) * Math.PI * 2;
  const elevation = Math.sin(angle) * CONFIG.SUN_MAX_ELEVATION_DEG * DEG;
  const azimuth = Math.PI / 2 + angle;
  return target.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
}

export function moonDirectionForDayTime(dayTime, target = new THREE.Vector3()) {
  sunDirectionForDayTime((dayTime + 0.5) % 1, target);
  target.y = target.y * 0.85 + 0.12;
  return target.normalize();
}

/** dayTime at which the sun sits at elevationDegrees (evening side when evening = true). */
export function dayTimeForSunElevation(elevationDegrees, evening) {
  const ratio = clamp(elevationDegrees / CONFIG.SUN_MAX_ELEVATION_DEG, -1, 1);
  const angle = Math.asin(ratio);
  const phase = evening ? Math.PI - angle : angle;
  return (((0.25 + phase / (Math.PI * 2)) % 1) + 1) % 1;
}
