// The terrain stamps the structure recipes build on, as preset data. A structure site's terrain
// edits must be known to the terrain worker, which never runs an engine: so a recipe does not edit the
// ground itself, it names the stamps it needs, and the preset lists them in its `stamps` array, where
// placement (src/world/placement.js) resolves them once per site on both threads. The recipe then
// reads the resolved stamp from `params.site.stamps` (runway thresholds, gorge anchors, islet tops,
// the canyon path).
//
//   stamps: structureStamps('airfield', { length: [1100, 1400] }),
//
// Pure (it imports only src/world/stamps.js), so a preset module that calls it still loads in the
// terrain worker. docs/engines/structure.md lists the options.
import { validateStampSpec } from '../../../world/stamps.js';

/**
 * The stamp type each recipe reads from its site (null: the recipe needs none), and the index param
 * that picks among several stamps of that type (`params.stamp`).
 */
export const RECIPE_STAMP_TYPES = Object.freeze({
  windFarm: null,
  ropeBridge: 'gorge',
  airfield: 'flatten',
  islands: 'islandBase',
  spires: null,
  gates: 'carve',
  waterfall: 'cliffStep',
});

/** Stamp sizes each recipe prefers over the stamp type's own defaults (m, or [min, max] ranges). */
const RECIPE_STAMP_DEFAULTS = Object.freeze({
  ropeBridge: Object.freeze({ length: [800, 1000], width: [90, 120], depth: [80, 110], falloff: [160, 200], pad: [60, 80], paint: 'riverbed' }),
  airfield: Object.freeze({ length: [1100, 1300], width: [42, 50], margin: [36, 48], shoulder: [110, 150], paint: 'tarmac' }),
  islands: Object.freeze({ radius: [170, 230], height: [24, 40], falloff: [90, 120], paint: 'basalt' }),
  gates: Object.freeze({ length: [2200, 2600], width: [36, 50], depth: [75, 95], wallWidth: [18, 26], twist: [180, 260], plateau: [40, 60], shoulder: [110, 140], paint: 'riverbed' }),
  waterfall: Object.freeze({ width: [380, 520], drop: [110, 160], length: [520, 680], face: [8, 12], falloff: [140, 180], pool: [55, 75], paint: 'wetRock' }),
});

/** Islet layout for the islands recipe: how many islets, and how far out the others ring the first. */
const ISLET_LIMIT = 8;
const ISLET_SPREAD = 460;

/**
 * The stamp specs a recipe needs, for a preset's `stamps` array: the recipe's preferred sizes with
 * `options` over them (any stamp spec field: sizes, paint, offset, rotation). For 'islands',
 * `options.islets` (1..8, default 1) islets are placed, the first at the site centre and the rest on a
 * ring `options.spread` metres out (default 460), each floating island hovering over one. Returns a
 * frozen array (empty for recipes that need no stamp). Throws, naming the recipe and field, for an
 * unknown recipe or an invalid spec.
 */
export function structureStamps(recipe, options = {}) {
  if (!Object.hasOwn(RECIPE_STAMP_TYPES, recipe)) {
    throw new Error(`[DRIFTWING] structureStamps: unknown recipe "${recipe}" (one of ${Object.keys(RECIPE_STAMP_TYPES).join(', ')})`);
  }
  const type = RECIPE_STAMP_TYPES[recipe];
  if (type === null) return Object.freeze([]);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`[DRIFTWING] structureStamps("${recipe}"): options must be an object`);
  }
  const { islets = 1, spread = ISLET_SPREAD, ...fields } = options;
  const count = recipe === 'islands' ? islets : 1;
  if (!Number.isInteger(count) || count < 1 || count > ISLET_LIMIT) {
    throw new Error(`[DRIFTWING] structureStamps("${recipe}").islets: must be an integer from 1 to ${ISLET_LIMIT}, got ${JSON.stringify(islets)}`);
  }
  if (!Number.isFinite(spread) || spread < 0) throw new Error(`[DRIFTWING] structureStamps("${recipe}").spread: must be a number >= 0 (m)`);
  const specs = [];
  for (let index = 0; index < count; index++) {
    const spec = { type, ...RECIPE_STAMP_DEFAULTS[recipe], ...fields };
    if (index > 0) {
      // The golden angle keeps the ring even for any count.
      const angle = index * 2.39996;
      spec.offset = { along: Math.round(Math.cos(angle) * spread), across: Math.round(Math.sin(angle) * spread) };
    }
    validateStampSpec(spec, `[DRIFTWING] structureStamps("${recipe}") stamps[${index}]`);
    specs.push(Object.freeze(spec));
  }
  return Object.freeze(specs);
}
