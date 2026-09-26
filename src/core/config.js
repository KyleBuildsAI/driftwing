// Tuning constants shared by every system, and the options handed to the world generator.
import { bloom } from 'three/addons/tsl/display/BloomNode.js';


// ============================================================================
// CONFIG: tuning constants shared by every system.
// ============================================================================
export const CONFIG = Object.freeze({
  VERSION: '1.0.0',
  CHUNK_SIZE: 256,
  LOD_RESOLUTIONS: Object.freeze([64, 32, 16, 8]),
  LOD_RING_LIMITS: Object.freeze([1, 3, 6]),
  SKIRT_DEPTH: 36,
  WATER_LEVEL: 0,
  LANDMARK_CELL: 2400,
  VEGETATION_RINGS: 3,
  GROUND_CLEARANCE: 4,
  WATER_CLEARANCE: 2.5,
  MAX_ALTITUDE: 2600,
  SPEED: Object.freeze({ MIN: 24, STALL: 32, CRUISE: 62, MAX: 135, BOOST_MAX: 170 }),
  DAY_LENGTH_DEFAULT: 360,
  START_SUN_ELEVATION_DEG: 13,
  SUN_MAX_ELEVATION_DEG: 62,
  CLOUD_SHADOW: Object.freeze({ SIZE: 128, WORLD: 4096 }),
  CAMERA: Object.freeze({ FOV_BASE: 60, FOV_MAX: 78, NEAR: 1 }),
  REMOTE_COPILOT_DEFAULT_ENDPOINT: 'http://localhost:3000/copilot',
  REMOTE_COPILOT_TIMEOUT_MS: 800,
  UI_IDLE_HIDE_MS: 3000,
  QUALITY_LEVELS: Object.freeze([
    Object.freeze({ name: 'minimal', viewRings: 5, pixelRatio: 0.75, shadowMapSize: 1024, vegetationRings: 1, vegetationDensity: 0.45, cloudDensity: 0.5, birdDensity: 0.5, bloom: false }),
    Object.freeze({ name: 'low', viewRings: 6, pixelRatio: 1.0, shadowMapSize: 1024, vegetationRings: 2, vegetationDensity: 0.65, cloudDensity: 0.7, birdDensity: 0.7, bloom: true }),
    Object.freeze({ name: 'medium', viewRings: 8, pixelRatio: 1.25, shadowMapSize: 2048, vegetationRings: 2, vegetationDensity: 0.85, cloudDensity: 0.85, birdDensity: 1, bloom: true }),
    Object.freeze({ name: 'high', viewRings: 10, pixelRatio: 1.5, shadowMapSize: 2048, vegetationRings: 3, vegetationDensity: 1, cloudDensity: 1, birdDensity: 1, bloom: true }),
    Object.freeze({ name: 'ultra', viewRings: 12, pixelRatio: 2, shadowMapSize: 4096, vegetationRings: 3, vegetationDensity: 1, cloudDensity: 1, birdDensity: 1, bloom: true }),
  ]),
});


export const WORLD_OPTIONS = Object.freeze({
  chunkSize: CONFIG.CHUNK_SIZE,
  lod0Resolution: CONFIG.LOD_RESOLUTIONS[0],
  waterLevel: CONFIG.WATER_LEVEL,
  landmarkCell: CONFIG.LANDMARK_CELL,
});
