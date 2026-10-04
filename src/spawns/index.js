// The 'spawns' system (contract sections 3-5): the SpawnManager with its engine registry, lures and
// light pool, the pluggable site feed, and the director hook. main.js creates it after 'wind' and
// 'sky', registers the engines, and the prewarm hook starts it (validates the presets in dev builds,
// initialises the engines and records the memory baseline) behind the loading fade.
//
// Site feed: the placement API (contract 2.1). The world generator exposes it as world.placement,
// which is the manager's feed from the start; setSiteFeed(feed) replaces it (the dev test kits).
// Director (contract 5): created by start() once the manager runs (createGameDirector in director.js),
// with the manager, the presets, the current site feed and the manager's discovered check. update()
// calls it every frame and it ticks at 2 Hz on the flight clock (DIRECTOR_TICK_SECONDS), so its
// activation log depends only on the seed and the flown path. The debugger reads director.getState()
// and calls forceSpawn; the copilot reads getNearby(radiusKm).
import { PRESETS } from './presets/index.js';
import { validatePreset, validatePresets } from './schema.js';
import { createEngineRegistry } from './engineRegistry.js';
import { createSpawnManager } from './spawnManager.js';
import { DIRECTOR_BUDGETS, createGameDirector } from './director.js';

const NO_SITES = Object.freeze([]);
/** Distance (m) ahead of the craft a debug spawn uses when none is given. */
const DEBUG_SPAWN_DEFAULT_DISTANCE = 1500;
/** "Start on ground" goes to a discovered site's ground-start spot within this distance (m). */
const GROUND_START_RANGE = 80000;
/** A site id: '<presetId>:<cellX>:<cellZ>' (src/world/placement.js). */
const SITE_ID_PATTERN = /^([A-Za-z][A-Za-z0-9]*):(-?\d+):(-?\d+)$/;

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
    water: ctx.systems.water?.effects ?? null,
    engineBudgets: DIRECTOR_BUDGETS.engines,
    surfaces: ctx.groundSurfaces ?? null,
    weatherState: () => (ctx.systems.weather ? ctx.systems.weather.getState().state : null),
    game: ctx,
  });
  let director = null;
  let started = false;
  const forward = { x: 0, z: -1 };

  /** The director's view of the sites: whichever feed the manager holds now. */
  const placementView = {
    sitesNear(x, z, radius) {
      const feed = manager.getSiteFeed();
      return feed && typeof feed.sitesNear === 'function' ? feed.sitesNear(x, z, radius) : NO_SITES;
    },
  };

  /** The event director on the running manager, or null (logged) when it cannot be created. */
  function createDirector() {
    try {
      return createGameDirector(ctx, {
        spawnManager: manager,
        presets: PRESETS,
        placement: placementView,
        isDiscovered: (id) => manager.isDiscovered(id),
        budgets: manager.budgets,
        devHooks,
      });
    } catch (error) {
      console.error('[DRIFTWING] the event director could not start; spawns run without it', error);
      return null;
    }
  }

  /**
   * Validates the presets (dev builds and ?debug=1 only), initialises the engines, then creates the
   * director.
   */
  function start() {
    if (started) return;
    started = true;
    if (devHooks) validatePresets(PRESETS, { engineNames: registry.names() });
    manager.init();
    director = createDirector();
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
   * Starts presetId ahead of the craft (dev): through the director's forceSpawn for the director's own
   * presets (it tracks the spawn's lifetime and logs it), else straight through the SpawnManager with
   * source 'debug' (presets added through the dev API). options: { distance (m), force (ignore
   * budgets) }. Returns the spawn id or null.
   */
  function forceSpawn(presetId, { distance = DEBUG_SPAWN_DEFAULT_DISTANCE, force = true } = {}) {
    if (director && director.hasPreset(presetId)) return director.forceSpawn(presetId, { distance, force });
    return manager.activate(presetId, { position: pointAhead(distance), heading: state.player.heading, source: 'debug', force });
  }

  /** Degrees between two compass headings (0..180). */
  function headingGap(first, second) {
    return Math.abs((((first - second) % 360) + 540) % 360 - 180);
  }

  /**
   * The ground-start spot of the nearest DISCOVERED site that offers one, for "Start on ground" (an
   * airfield's runway threshold). An engine offers spots through its optional hook
   * groundStart(preset, params, site) -> [{ x, z, y, heading, runwayLength }] | null (pure: it reads
   * the site's resolved stamps). Of a site's spots the one facing most nearly into the ambient wind
   * wins. Sites are found from the discovered keys (site ids name their cell), so no search runs.
   * Returns { x, z, y, heading, siteId, presetId, name, distance } or null.
   */
  function findGroundStart(x, z, { maxDistance = GROUND_START_RANGE } = {}) {
    const feed = manager.getSiteFeed();
    if (!feed || typeof feed.sitesInCell !== 'function') return null;
    let best = null;
    for (const key of manager.getDiscovered()) {
      const match = SITE_ID_PATTERN.exec(key);
      if (!match) continue;
      const preset = manager.getPreset(match[1]);
      if (!preset || preset.kind !== 'site') continue;
      const site = feed.sitesInCell(Number(match[2]), Number(match[3])).find((candidate) => candidate.id === key);
      if (!site) continue;
      const distance = Math.hypot(site.x - x, site.z - z);
      if (distance > maxDistance || (best && distance >= best.distance)) continue;
      for (const entry of preset.engines) {
        const engine = registry.get(entry.engine);
        if (!engine || typeof engine.groundStart !== 'function') continue;
        let spots = null;
        try {
          spots = engine.groundStart(preset, entry.params ?? {}, site);
        } catch (error) {
          console.error(`[DRIFTWING] spawn engine "${engine.name}" groundStart failed for ${site.id}`, error);
          continue;
        }
        if (!Array.isArray(spots) || spots.length === 0) continue;
        const intoWind = ctx.wind && typeof ctx.wind.ambientAt === 'function' ? ctx.wind.ambientAt({ x: site.x, y: site.groundY + 10, z: site.z }).fromDegrees : spots[0].heading;
        let chosen = spots[0];
        for (const spot of spots) if (headingGap(spot.heading, intoWind) < headingGap(chosen.heading, intoWind)) chosen = spot;
        best = { x: chosen.x, z: chosen.z, y: chosen.y, heading: chosen.heading, siteId: site.id, presetId: preset.id, name: preset.name, distance };
        break;
      }
    }
    return best;
  }

  const system = {
    update(simDt, realDt) {
      manager.update(simDt, realDt);
      if (!director) return;
      try {
        director.update();
      } catch (error) {
        console.error('[DRIFTWING] the event director failed and was stopped', error);
        const failed = director;
        director = null;
        try {
          failed.dispose();
        } catch (disposeError) {
          console.error('[DRIFTWING] the stopped event director failed to dispose', disposeError);
        }
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
    /** The event director (src/spawns/director.js), or null before start() or if it failed. */
    get director() {
      return director;
    },
    /**
     * For the copilot: spawns, dormant candidates and sites within radiusKm, nearest first
     * ([{ id, name, category, distance, bearing, state, etaSeconds }]); empty without a director.
     */
    getNearby(radiusKm) {
      return director ? director.getNearby(radiusKm) : [];
    },
    forceSpawn,
    pointAhead,
    findGroundStart,
  };

  if (devHooks) {
    /** The game presets holdGamePresets took out of the manager. */
    const heldGamePresets = [];
    system.debug = {
      /** Adds a preset (validated against the registered engines). */
      addPreset(preset) {
        validatePreset(preset, { engineNames: registry.names() });
        manager.addPreset(preset);
        return preset.id;
      },
      removePreset: manager.removePreset,
      /**
       * Takes the game's own presets (PRESETS) out of the manager, ending their live spawns, so a
       * check runs on its test presets alone in an otherwise empty game; the director's activations
       * of them are then refused quietly (reason 'preset'). Returns the ids held.
       */
      holdGamePresets() {
        const held = [];
        for (const preset of PRESETS) {
          if (manager.getPreset(preset.id) !== preset) continue;
          manager.removePreset(preset.id);
          heldGamePresets.push(preset);
          held.push(preset.id);
        }
        return held;
      },
      /** Puts the presets holdGamePresets took back. Returns their ids. */
      releaseGamePresets() {
        const released = [];
        for (const preset of heldGamePresets.splice(0)) {
          if (manager.getPreset(preset.id)) continue;
          manager.addPreset(preset);
          released.push(preset.id);
        }
        return released;
      },
      /**
       * Starts the spawns afresh on the current flight clock (the determinism test): the director is
       * disposed (ending what it started), the SpawnManager ends every other spawn and forgets its
       * discoveries and frame state (resetForReplay), and a new director starts. Its activation log
       * then depends only on the seed and the path flown from here. Returns the new director or null.
       */
      restartSpawns() {
        if (director) {
          director.dispose();
          director = null;
        }
        manager.resetForReplay();
        director = createDirector();
        return director;
      },
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
