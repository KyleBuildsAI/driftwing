// Preset 75: Thermal street (common event, midday; affects flight). Two rows of flat-based cumulus
// line up with the wind across the sky, 1.8 km apart, each cloud capping a thermal: fly along a row
// under the clouds and every few hundred metres the air lifts you again, a straight road of lift for
// cross-country gliding. The activation turns downwind; the rows run with the wind. Docs:
// docs/engines/weatherVolume.md (clumps, turn, offset), windModifier.md (updraft).
// The clump centres of an 8400 m bank in 8 clumps (weatherVolume's clump layout), 1050 m apart.
const STREET_ALONG = Object.freeze([-3675, -2625, -1575, -525, 525, 1575, 2625, 3675]);
const ROW_SIDE = 900;

/**
 * One row of cumulus `side` metres to the right of the wind line, laid along the wind: turned -90,
 * the bank's length runs downwind and its frame's forward points left, hence the offset's sign.
 */
function cloudRow(side, ownsAudio) {
  return Object.freeze({
    engine: 'weatherVolume',
    params: Object.freeze({
      form: 'bank', clumps: STREET_ALONG.length, turn: -90, offset: Object.freeze([0, -side]), base: 1350, baseMode: 'agl', followTerrain: false,
      length: 8400, width: 900, height: 620, puffs: 176, detail: 0.3, storm: 0, tint: 0xffffff, brightness: 1.04, billow: 0.18,
      formSeconds: 45, dissipateSeconds: 45,
      haze: Object.freeze({ near: 2500, far: 36000, max: 0.88 }),
      insideFog: Object.freeze({ density: 3, color: 0xe6eaef, darkness: 0 }),
      wind: Object.freeze({ turbulence: 0.15 }),
      ownsAudio,
    }),
  });
}

/** The thermals under the row `side` metres right of the wind line: a lift column under each cloud. */
function thermalRow(side) {
  return Object.freeze({
    engine: 'windModifier',
    params: Object.freeze({
      sources: Object.freeze(STREET_ALONG.map((along) => Object.freeze({
        type: 'updraft', direction: 'heading', offset: Object.freeze([along, side, 0]), radius: 330, updraft: 4.2, base: 0, top: 1350,
        sinkRing: 0.15, ringWidth: 1.4, turbulence: 0.35, gust: 2.5, fadeIn: 20,
      }))),
    }),
  });
}

export default Object.freeze({
  id: 'thermalStreet',
  name: 'Thermal street',
  category: 'flightplay',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  tags: Object.freeze(['thermal', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 600, chance: 0.45 }),
  filters: Object.freeze({
    biomes: Object.freeze(['meadows', 'dunes', 'pine']),
    timeOfDay: Object.freeze(['midday']),
    altitude: Object.freeze({ min: 0, max: 4000 }),
    weather: Object.freeze(['clear', 'building']),
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  anchor: Object.freeze({ align: 'downwind' }),
  // One row right of the wind line and one left of it, each with its thermals.
  engines: Object.freeze([cloudRow(ROW_SIDE, true), cloudRow(-ROW_SIDE, false), thermalRow(ROW_SIDE), thermalRow(-ROW_SIDE)]),
  lod: Object.freeze({ near: 5000, mid: 14000, far: 32000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'windRush', params: Object.freeze({ gust: 0.3, refDistance: 900 }) }),
  journal: Object.freeze({
    title: 'Thermal street',
    description: 'Rows of cumulus lined up with the wind, a thermal under every cloud: cross-country in a straight line.',
  }),
  discovery: Object.freeze({ radius: 8000, requireInView: true }),
  callouts: Object.freeze([
    'Cloud street {direction}, {distance} out. A thermal under every cloud.',
    'Cumulus lined up with the wind {direction}. Run the row and climb under each one.',
    'The {name} is about {eta} away, {direction}. Stay under the cloud bases.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([600, 840]), despawn: Object.freeze({ distance: 22000, hysteresis: 4000, outOfViewSeconds: 30 }) }),
});
