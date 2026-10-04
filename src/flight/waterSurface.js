// Water reads for the flight models (contract section c.3): every model and assist asks its tick
// environment for the water surface through these helpers instead of comparing with a flat sea.
//
// The flight controller's env carries the shared water query (env.waterHeight / env.waterSample: the
// ocean's swell and every local water body, at the tick time). An environment without them (the node
// labs' flat-ground rigs, which set env.waterLevel to move or hide their sea) has a flat sea at
// env.waterLevel, exactly as before Phase 3.
//
// Pure: no three.js, no DOM.

/** The water surface height (m) at (x, z), or -Infinity where there is none. */
export function waterHeightAt(env, x, z) {
  if (typeof env.waterHeight === 'function') return env.waterHeight(x, z);
  return Number.isFinite(env.waterLevel) ? env.waterLevel : -Infinity;
}

/** The surface below (x, z) a craft can hit: the higher of the ground and the water. */
export function surfaceHeightAt(env, x, z) {
  const ground = env.groundHeight(x, z);
  const water = waterHeightAt(env, x, z);
  return ground > water ? ground : water;
}

/**
 * The water at (x, z) into out (the water query's sample shape: height, normalX/Y/Z, velocityX/Y/Z,
 * kind, bodyId, body, material, depth, film). Without the query: the flat sea at env.waterLevel
 * wherever the ground is below it (kind 'ocean'), else none.
 */
export function waterSampleAt(env, x, z, out) {
  if (typeof env.waterSample === 'function') return env.waterSample(x, z, out);
  const level = Number.isFinite(env.waterLevel) ? env.waterLevel : -Infinity;
  const ground = env.groundHeight(x, z);
  const wet = ground < level;
  out.height = wet ? level : -Infinity;
  out.normalX = 0;
  out.normalY = 1;
  out.normalZ = 0;
  out.velocityX = 0;
  out.velocityY = 0;
  out.velocityZ = 0;
  out.kind = wet ? 'ocean' : 'none';
  out.bodyId = null;
  out.body = null;
  out.material = 'water';
  out.depth = wet ? level - ground : 0;
  out.film = false;
  return out;
}

/** A reusable sample object for waterSampleAt. */
export function createWaterSampleScratch() {
  return {
    height: -Infinity, normalX: 0, normalY: 1, normalZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
    kind: 'none', bodyId: null, body: null, material: 'water', depth: 0, film: false,
  };
}
