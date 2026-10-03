// Preset 21: Abandoned airfield (site). A flattened strip with faded markings, hangar ruins, a hut,
// broken edge lights and a windsock that shows the real WindField wind (structure engine, airfield
// recipe, on the placement's flatten stamp). Touchdowns on the runway are graded (structure:landing),
// and "Start on ground" prefers the nearest DISCOVERED airfield through the structure engine's
// groundStart hook (spawns.findGroundStart picks the threshold most nearly into the wind).
// Pure data: the stamp helper below is terrain-worker safe.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'abandonedAirfield',
  name: 'Abandoned airfield',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: Object.freeze({
    chance: 0.35,
    minSpacing: 12000,
    biomes: Object.freeze(['meadows', 'dunes', 'pine']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 6, maxHeight: 420, relief: 'flat' }),
    clearance: 500,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('airfield', { length: [1100, 1400], width: [42, 52] }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'airfield',
        fade: 0.62,
        weeds: 0.4,
        hangars: Object.freeze({ count: 3, ruin: 0.62 }),
        hut: true,
        windsock: true,
        edgeLights: true,
        fence: true,
        landing: true,
        groundStart: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 6000, far: 14000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: null,
  journal: Object.freeze({
    title: 'Abandoned airfield',
    description: 'A forgotten strip of cracked tarmac and ruined hangars; its windsock still reads the wind, and every landing here is graded.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Old airstrip {distance} {direction}. The windsock is still up.',
    'Abandoned airfield {direction}, about {eta} out. Fancy a graded landing?',
    'I can see a runway {distance} {direction}. Nobody has used it in years.',
    'There is the {name}, {direction}. Line up into the wind if you want to put it down.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
