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
// Phase 3 presets 61-70.
import { WORLD_TREE_DEFAULTS, buildWorldTree } from './worldTree.js';
import { PORTAL_RING_DEFAULTS, buildPortalRing } from './portalRing.js';

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
  // Phase 3 presets 61-70.
  worldTree: Object.freeze({ build: buildWorldTree, defaults: WORLD_TREE_DEFAULTS, audioIntensity: 'approach' }),
  portalRing: Object.freeze({ build: buildPortalRing, defaults: PORTAL_RING_DEFAULTS, audioIntensity: 'approach' }),
});

export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
