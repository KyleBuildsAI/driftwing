// The structure recipes by name (params.recipe). Each is build(context, read): it fills the
// context's builders (body, detail, decal, glow, water) and its `out` record (turbines, socks, puffs,
// zones, surfaces, courses, wake, sway, audio point, radius) and adds gates through context.addGate.
import { AIRFIELD_DEFAULTS, airfieldGroundStart, buildAirfield } from './airfield.js';
import { GATES_DEFAULTS, buildGates } from './gates.js';
import { ISLANDS_DEFAULTS, buildIslands } from './islands.js';
import { ROPE_BRIDGE_DEFAULTS, buildRopeBridge } from './ropeBridge.js';
import { SPIRES_DEFAULTS, buildSpires } from './spires.js';
import { WATERFALL_DEFAULTS, buildWaterfall } from './waterfall.js';
import { WIND_FARM_DEFAULTS, buildWindFarm } from './windFarm.js';
import { CHALLENGE_GATES_DEFAULTS, buildChallengeGates } from './challengeGates.js';
import { LAVA_CHANNELS_DEFAULTS, buildLavaChannels } from './lavaChannels.js';
import { EJECTA_DEFAULTS, buildEjecta } from './ejecta.js';
import { SALT_PILES_DEFAULTS, buildSaltPiles } from './saltPiles.js';
import { GLACIER_DEFAULTS, buildGlacier } from './glacier.js';
import { SHIPWRECK_DEFAULTS, buildShipwreck } from './shipwreck.js';
import { SEA_ARCHES_DEFAULTS, buildSeaArches } from './seaArches.js';
import { CAVE_MOUTH_DEFAULTS, buildCaveMouth } from './caveMouth.js';
// Presets 51-60.
import { MONASTERY_DEFAULTS, buildMonastery } from './monastery.js';
import { CASTLE_RUIN_DEFAULTS, buildCastleRuin } from './castleRuin.js';
import { OBSERVATORY_DEFAULTS, buildObservatory } from './observatory.js';
import { VIADUCT_DEFAULTS, buildViaduct } from './viaduct.js';
import { DAM_DEFAULTS, buildDam } from './dam.js';
import { OASIS_DEFAULTS, buildOasis } from './oasis.js';
import { LABYRINTH_DEFAULTS, buildLabyrinth } from './labyrinth.js';
import { FIREBALL_DEFAULTS, buildFireball } from './fireball.js';
// Phase 3 presets 61-70.
import { WORLD_TREE_DEFAULTS, buildWorldTree } from './worldTree.js';
import { PORTAL_RING_DEFAULTS, buildPortalRing } from './portalRing.js';
import { SLEEPING_GIANT_DEFAULTS, buildSleepingGiant } from './sleepingGiant.js';
import { GHOST_GALLEON_DEFAULTS, buildGhostGalleon } from './ghostGalleon.js';
import { DRAGON_RACE_DEFAULTS, buildDragonRace } from './dragonRace.js';
import { CANYON_GATES_DEFAULTS, buildCanyonGates } from './canyonGates.js';
import { CAVE_TUNNEL_DEFAULTS, buildCaveTunnel } from './caveTunnel.js';
import { FALLS_WALL_DEFAULTS, buildFallsWall } from './fallsWall.js';
import { BALLOON_COURSE_DEFAULTS, buildBalloonCourse } from './balloonCourse.js';
import { KITE_SLALOM_DEFAULTS, buildKiteSlalom } from './kiteSlalom.js';
import { ARCH_CHAIN_DEFAULTS, buildArchChain } from './archChain.js';
import { HOODOOS_DEFAULTS, buildHoodoos } from './hoodoos.js';

/**
 * name -> { build, defaults, audioIntensity ('approach' | 'wind' | 'constant': how the engine drives
 * a preset's voice by default), groundStart? (site, params) -> spots | null }.
 */
export const RECIPES = Object.freeze({
  windFarm: Object.freeze({ build: buildWindFarm, defaults: WIND_FARM_DEFAULTS, audioIntensity: 'wind' }),
  ropeBridge: Object.freeze({ build: buildRopeBridge, defaults: ROPE_BRIDGE_DEFAULTS, audioIntensity: 'constant' }),
  airfield: Object.freeze({ build: buildAirfield, defaults: AIRFIELD_DEFAULTS, audioIntensity: 'constant', groundStart: airfieldGroundStart }),
  islands: Object.freeze({ build: buildIslands, defaults: ISLANDS_DEFAULTS, audioIntensity: 'constant' }),
  spires: Object.freeze({ build: buildSpires, defaults: SPIRES_DEFAULTS, audioIntensity: 'approach' }),
  gates: Object.freeze({ build: buildGates, defaults: GATES_DEFAULTS, audioIntensity: 'constant' }),
  waterfall: Object.freeze({ build: buildWaterfall, defaults: WATERFALL_DEFAULTS, audioIntensity: 'constant' }),
  challengeGates: Object.freeze({ build: buildChallengeGates, defaults: CHALLENGE_GATES_DEFAULTS, audioIntensity: 'approach' }),
  lavaChannels: Object.freeze({ build: buildLavaChannels, defaults: LAVA_CHANNELS_DEFAULTS, audioIntensity: 'constant' }),
  ejecta: Object.freeze({ build: buildEjecta, defaults: EJECTA_DEFAULTS, audioIntensity: 'constant' }),
  saltPiles: Object.freeze({ build: buildSaltPiles, defaults: SALT_PILES_DEFAULTS, audioIntensity: 'constant' }),
  // Phase 3 wave 3, presets 41-50.
  glacier: Object.freeze({ build: buildGlacier, defaults: GLACIER_DEFAULTS, audioIntensity: 'constant' }),
  shipwreck: Object.freeze({ build: buildShipwreck, defaults: SHIPWRECK_DEFAULTS, audioIntensity: 'constant' }),
  seaArches: Object.freeze({ build: buildSeaArches, defaults: SEA_ARCHES_DEFAULTS, audioIntensity: 'constant' }),
  caveMouth: Object.freeze({ build: buildCaveMouth, defaults: CAVE_MOUTH_DEFAULTS, audioIntensity: 'constant' }),
  // Presets 51-60.
  monastery: Object.freeze({ build: buildMonastery, defaults: MONASTERY_DEFAULTS, audioIntensity: 'wind' }),
  castleRuin: Object.freeze({ build: buildCastleRuin, defaults: CASTLE_RUIN_DEFAULTS, audioIntensity: 'constant' }),
  observatory: Object.freeze({ build: buildObservatory, defaults: OBSERVATORY_DEFAULTS, audioIntensity: 'recipe' }),
  viaduct: Object.freeze({ build: buildViaduct, defaults: VIADUCT_DEFAULTS, audioIntensity: 'recipe' }),
  dam: Object.freeze({ build: buildDam, defaults: DAM_DEFAULTS, audioIntensity: 'constant' }),
  oasis: Object.freeze({ build: buildOasis, defaults: OASIS_DEFAULTS, audioIntensity: 'constant' }),
  labyrinth: Object.freeze({ build: buildLabyrinth, defaults: LABYRINTH_DEFAULTS, audioIntensity: 'constant' }),
  fireball: Object.freeze({ build: buildFireball, defaults: FIREBALL_DEFAULTS, audioIntensity: 'recipe' }),
  // Phase 3 presets 61-70.
  worldTree: Object.freeze({ build: buildWorldTree, defaults: WORLD_TREE_DEFAULTS, audioIntensity: 'approach' }),
  portalRing: Object.freeze({ build: buildPortalRing, defaults: PORTAL_RING_DEFAULTS, audioIntensity: 'approach' }),
  sleepingGiant: Object.freeze({ build: buildSleepingGiant, defaults: SLEEPING_GIANT_DEFAULTS, audioIntensity: 'constant' }),
  ghostGalleon: Object.freeze({ build: buildGhostGalleon, defaults: GHOST_GALLEON_DEFAULTS, audioIntensity: 'approach' }),
  dragonRace: Object.freeze({ build: buildDragonRace, defaults: DRAGON_RACE_DEFAULTS, audioIntensity: 'approach' }),
  canyonGates: Object.freeze({ build: buildCanyonGates, defaults: CANYON_GATES_DEFAULTS, audioIntensity: 'approach' }),
  caveTunnel: Object.freeze({ build: buildCaveTunnel, defaults: CAVE_TUNNEL_DEFAULTS, audioIntensity: 'approach' }),
  fallsWall: Object.freeze({ build: buildFallsWall, defaults: FALLS_WALL_DEFAULTS, audioIntensity: 'constant' }),
  balloonCourse: Object.freeze({ build: buildBalloonCourse, defaults: BALLOON_COURSE_DEFAULTS, audioIntensity: 'approach' }),
  kiteSlalom: Object.freeze({ build: buildKiteSlalom, defaults: KITE_SLALOM_DEFAULTS, audioIntensity: 'approach' }),
  archChain: Object.freeze({ build: buildArchChain, defaults: ARCH_CHAIN_DEFAULTS, audioIntensity: 'wind' }),
  hoodoos: Object.freeze({ build: buildHoodoos, defaults: HOODOOS_DEFAULTS, audioIntensity: 'wind' }),
});

export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
