// The 'spawns' system (contract sections 3-5): the SpawnManager with its engine registry, lures and
// light pool, the pluggable site feed, and the director hook. main.js creates it after 'wind' and
// 'sky', registers the engines, and the prewarm hook starts it (validates the presets in dev builds,
// initialises the engines and records the memory baseline) behind the loading fade.
//
// Site feed: the placement API (contract 2.1). When the world generator exposes it as
// world.placement it is picked up here; otherwise setSiteFeed(feed) attaches one later.
// Director: attachDirector(director) runs director.update(dt) at DIRECTOR_HZ with the simulated time
// since its previous run, and the debugger reads director.getState().
import { PRESETS } from './presets/index.js';
import { validatePreset, validatePresets } from './schema.js';
import { createEngineRegistry } from './engineRegistry.js';
import { createSpawnManager } from './spawnManager.js';

export const DIRECTOR_HZ = 2;
/** Distance (m) ahead of the craft a debug spawn uses when none is given. */
const DEBUG_SPAWN_DEFAULT_DISTANCE = 1500;

/** Horizontal unit vector of the craft's heading into target ({ x, z }). */
function flatForward(player, target) {
  const forward = player.forward;
  const length = Math.hypot(forward.x, forward.z);
  if (length > 1e-3) {
    target.x = forward.x / length;
    target.z = forward.z / length;
  } else {
    target.x = 0;
    target.z = -1;
  }
  return target;
}

/**
 * Creates the spawns system. options.devHooks adds the dev API (`debug`): force spawns, extra
 * presets and engines, and the dev test kit.
 */
export function createSpawnSystem(ctx, { devHooks = import.meta.env.DEV } = {}) {
  const { state, world, bus } = ctx;
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE: ctx.THREE,
    TSL: ctx.TSL,
    scene: ctx.scene,
    camera: ctx.camera,
    renderer: ctx.renderer,
    backend: ctx.backend,
    wind: ctx.wind,
    audio: ctx.systems.audio ?? null,
    world,
    state,
    sky: ctx.systems.sky ?? null,
    bus,
    perf: ctx.perf,
    settings: ctx.settings,
    uniforms: ctx.uniforms,
    registry,
    presets: PRESETS,
    seed: state.seed,
    siteFeed: world.placement ?? null,
    registerPrewarm: ctx.registerPrewarm,
  });
  let director = null;
  // Doubles live in an object: a double in a closure variable is boxed anew on every write.
  const directorClock = { timer: 0, elapsed: 0 };
  let started = false;
  const forward = { x: 0, z: -1 };

  /** Validates the presets (dev builds and ?debug=1 only), initialises the engines. */
  function start() {
    if (started) return;
    started = true;
    if (devHooks) validatePresets(PRESETS, { engineNames: registry.names() });
    manager.init();
  }

  /** The anchor distance metres ahead of the craft on its heading, on the ground (or the water). */
  function pointAhead(distance) {
    const player = state.player.position;
    flatForward(state.player, forward);
    const x = player.x + forward.x * distance;
    const z = player.z + forward.z * distance;
    return { x, y: Math.max(world.groundHeight(x, z), world.WATER_LEVEL), z };
  }

  /**
   * Starts presetId ahead of the craft (dev): through the director's forceSpawn when a director is
   * attached, else straight through the SpawnManager with source 'debug'. options: { distance (m),
   * force (ignore budgets) }. Returns the spawn id or null.
   */
  function forceSpawn(presetId, { distance = DEBUG_SPAWN_DEFAULT_DISTANCE, force = true } = {}) {
    const position = pointAhead(distance);
    const opts = { position, heading: state.player.heading, source: 'debug', force };
    if (director && typeof director.forceSpawn === 'function') return director.forceSpawn(presetId, opts);
    return manager.activate(presetId, opts);
  }

  const system = {
    update(simDt, realDt) {
      manager.update(simDt, realDt);
      if (!director || !started) return;
      directorClock.elapsed += simDt;
      directorClock.timer -= realDt;
      if (directorClock.timer > 0) return;
      directorClock.timer = 1 / DIRECTOR_HZ;
      const elapsed = directorClock.elapsed;
      directorClock.elapsed = 0;
      try {
        director.update(elapsed);
      } catch (error) {
        console.error('[DRIFTWING] the event director failed and was detached', error);
        director = null;
      }
    },
    /** Starts the manager behind the loading fade, after main.js has registered the engines. */
    prewarm() {
      start();
    },
    start,
    manager,
    register: (engine) => manager.register(engine),
    activate: manager.activate,
    deactivate: manager.deactivate,
    getActive: manager.getActive,
    getInstance: manager.getInstance,
    getStats: manager.getStats,
    setSiteFeed: manager.setSiteFeed,
    /** Attaches the event director: { update(dt), getState(), forceSpawn?(presetId, opts), getNearby?(radiusKm) }. */
    attachDirector(next) {
      if (next !== null && (typeof next?.update !== 'function' || typeof next?.getState !== 'function')) {
        throw new TypeError('[DRIFTWING] a director needs update(dt) and getState()');
      }
      director = next;
      directorClock.timer = 0;
      directorClock.elapsed = 0;
    },
    get director() {
      return director;
    },
    forceSpawn,
    pointAhead,
  };

  if (devHooks) {
    system.debug = {
      /** Adds a preset (validated against the registered engines). */
      addPreset(preset) {
        validatePreset(preset, { engineNames: registry.names() });
        manager.addPreset(preset);
        return preset.id;
      },
      removePreset: manager.removePreset,
      registerEngine: (engine) => manager.register(engine),
      unregisterEngine(name) {
        for (const preset of manager.listPresets()) {
          if (preset.engines.some((entry) => entry.engine === name)) manager.removePreset(preset.id);
        }
        return registry.unregister(name);
      },
      /**
       * Dev builds only: registers the framework's test engines and presets (src/dev/spawnTestKit.js,
       * never part of a production build). Returns { engines, presets }.
       */
      async loadTestKit() {
        if (!import.meta.env.DEV) throw new Error('[DRIFTWING] the spawn test kit exists only in dev builds');
        const kit = await import('../dev/spawnTestKit.js');
        return kit.installSpawnTestKit(system);
      },
    };
  }
  return system;
}
