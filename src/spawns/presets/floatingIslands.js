// Preset 26: Floating islands (rare heavy site). Rock islands with trees and a clear meadow hang over
// sea-stack islets (the placement's islandBase stamps); waterfalls pour off their edges and fade into
// mist, roots trail from the rims, and every top is landable ground (structure engine, islands recipe;
// the tops register in ctx.surfaces). Beyond the terrain's view distance the islands lure stands on
// the horizon. Pure data: the stamp helper below is terrain-worker safe.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'floatingIslands',
  name: 'Floating islands',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  placement: Object.freeze({
    chance: 0.3,
    minSpacing: 22000,
    biomes: Object.freeze(['archipelago', 'meadows', 'pine']),
    surface: 'water',
    clearance: 600,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('islands', { islets: 2, spread: 560 }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'islands',
        count: Object.freeze([4, 5]),
        radius: Object.freeze([70, 150]),
        altitude: Object.freeze([240, 420]),
        spread: 640,
        thickness: Object.freeze([0.95, 1.35]),
        treeDensity: 0.6,
        meadow: 0.32,
        waterfalls: Object.freeze([1, 2]),
        fall: 0.8,
        roots: 16,
        mist: true,
        landable: true,
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 9000, far: 40000 }),
  lure: Object.freeze({ type: 'islands', height: 760, width: 1500, altitude: 220, color: 0x7d705f }),
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Floating islands',
    description: 'Rock islands adrift in the air above the sea, their waterfalls pouring off the edges into mist; the meadows on top take a careful landing.',
  }),
  discovery: Object.freeze({ radius: 4500, requireInView: true }),
  callouts: Object.freeze([
    'Am I seeing this right? Islands floating in the air, {distance} {direction}.',
    'Floating islands {direction}. You can land on the tops if you are gentle.',
    'There are the {name}, about {eta} out. Waterfalls pouring right off the edges.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 40000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
