// Spawn engine registry (contract section 3). An engine is the reusable machinery behind presets: a
// preset names engines and their params, the SpawnManager creates one engine instance per entry.
//
// Engine interface (every member required):
//   name                         unique camelCase registry name ('vortex', 'emitter', ...)
//   init(ctx)                    once, before the first create (shared geometry, materials, pools)
//   create(preset, params, rng)  returns an instance (see validateInstance); params are the preset's
//                                engine params merged with the activation
//   update(instance, dt, ctx)    every frame while the instance is active; no allocations
//   setLOD(instance, tier)       'near' | 'mid' | 'far'
//   dispose(instance)            returns every GPU resource and removes every wind source
//   stats()                      { instances, particles, lights, buffers, drawCalls }
// Optional: budget { instances, particles }, the engine's default caps (the director may change them).
// Shared resources built in init() live for the whole session; dispose(instance) frees only what
// that instance created, so GPU memory returns to its level from before create().

/** The ten Phase 2 engines, by registry name. */
export const ENGINE_NAMES = Object.freeze([
  'vortex', 'emitter', 'weatherVolume', 'fauna', 'structure', 'celestial', 'waterEffect', 'lightEffect', 'windModifier', 'setPiece',
]);
export const LOD_TIERS = Object.freeze(['near', 'mid', 'far']);
const REQUIRED_METHODS = Object.freeze(['init', 'create', 'update', 'setLOD', 'dispose', 'stats']);
const NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/** Throws a clear error when engine does not implement the interface. Returns the engine. */
export function validateEngine(engine) {
  if (!engine || typeof engine !== 'object') throw new TypeError('[DRIFTWING] spawn engine must be an object');
  const label = typeof engine.name === 'string' ? engine.name : '(no name)';
  if (typeof engine.name !== 'string' || !NAME_PATTERN.test(engine.name)) {
    throw new TypeError(`[DRIFTWING] spawn engine "${label}": name must be a camelCase string`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof engine[method] !== 'function') throw new TypeError(`[DRIFTWING] spawn engine "${label}": ${method}() is missing`);
  }
  if (engine.budget !== undefined) {
    const budget = engine.budget;
    const valid = budget && Number.isFinite(budget.instances) && budget.instances >= 0 && Number.isFinite(budget.particles) && budget.particles >= 0;
    if (!valid) throw new TypeError(`[DRIFTWING] spawn engine "${label}": budget must be { instances, particles } with non-negative numbers`);
  }
  return engine;
}

/**
 * Throws when an engine's create() returned something that is not an instance:
 * { id, presetId, engine, anchor: Vector3, radius, heavy, tier, ended, windSourceIds: [], lights,
 * particles, data }. The SpawnManager fills id, presetId, engine, heavy and tier itself before the
 * check, so an engine only has to provide anchor, radius, windSourceIds, lights, particles and data.
 */
export function validateInstance(engineName, instance) {
  const fail = (message) => {
    throw new TypeError(`[DRIFTWING] spawn engine "${engineName}": create() ${message}`);
  };
  if (!instance || typeof instance !== 'object') fail('must return an instance object');
  const anchor = instance.anchor;
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.z)) fail('must return an instance with a finite anchor Vector3');
  if (!Number.isFinite(instance.radius) || instance.radius < 0) fail('must return an instance with a radius (m)');
  if (!Array.isArray(instance.windSourceIds)) fail('must return an instance with windSourceIds (an array)');
  if (!Number.isFinite(instance.lights) || !Number.isFinite(instance.particles)) fail('must return an instance with lights and particles counts');
  return instance;
}

/** Creates the registry: register(engine), get(name), has(name), list(), names(). */
export function createEngineRegistry() {
  const engines = new Map();
  return {
    /** Adds an engine; throws when it is invalid or its name is taken. Returns the engine. */
    register(engine) {
      validateEngine(engine);
      if (engines.has(engine.name)) throw new Error(`[DRIFTWING] spawn engine "${engine.name}" is already registered`);
      engines.set(engine.name, engine);
      return engine;
    },
    /** Removes an engine (dev test kits only); returns whether it was registered. */
    unregister(name) {
      return engines.delete(name);
    },
    get(name) {
      return engines.get(name) ?? null;
    },
    has(name) {
      return engines.has(name);
    },
    list() {
      return [...engines.values()];
    },
    names() {
      return [...engines.keys()];
    },
    get size() {
      return engines.size;
    },
  };
}
