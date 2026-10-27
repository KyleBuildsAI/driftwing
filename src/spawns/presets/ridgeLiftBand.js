// Preset 73: Ridge lift band (uncommon site; affects flight). Along a long ridgeline the wind is
// forced up the slopes and rises in a band over the crest: a smooth cap cloud drapes the crest along
// its length, and hawks soar the line without a wingbeat. Fly along the ridge just above the crest
// and the band holds a glider up for kilometres (on top of the WindField's own slope lift). Placed
// on ridges and laid along their axis. Docs: docs/engines/weatherVolume.md (turn), fauna.md,
// windModifier.md.
export default Object.freeze({
  id: 'ridgeLiftBand',
  name: 'Ridge lift band',
  category: 'flightplay',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['thermal', 'calm', 'spectacle']),
  placement: Object.freeze({
    chance: 0.08,
    minSpacing: 18000,
    biomes: Object.freeze(['snow', 'pine', 'meadows', 'dunes']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 180, relief: 'ridge' }),
    clearance: 300,
    align: 'ridge',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    // The cap cloud: a smooth bank draped along the crest (turned onto the ridge's axis), its puffs
    // riding the crest's own heights.
    Object.freeze({
      engine: 'weatherVolume',
      params: Object.freeze({
        form: 'bank', turn: 90, base: 55, baseMode: 'agl', followTerrain: true, length: 4600, width: 280, height: 110, puffs: 130, detail: 0.2,
        storm: 0, tint: 0xf5f7f9, brightness: 1.06, billow: 0.1, formSeconds: 0,
        haze: Object.freeze({ near: 1500, far: 24000, max: 0.85 }),
        insideFog: Object.freeze({ density: 3, color: 0xe9edf1, darkness: 0 }),
        wind: Object.freeze({ turbulence: 0.06 }),
        ownsAudio: false,
      }),
    }),
    // Hawks soaring the band over the crest.
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'hawk', behavior: 'circling', count: Object.freeze([6, 9]), size: 1.4, fadeIn: 3, voiceIntensity: 0.7,
        circling: Object.freeze({ radius: Object.freeze([70, 180]), climb: 0.8, bottom: 90, top: 420, useThermals: false }),
        calls: Object.freeze({ trigger: 'call', interval: Object.freeze([20, 45]) }),
        voice: true,
      }),
    }),
    // The band: eight overlapping lift columns along the ridge's axis, centred over the crest.
    Object.freeze({
      engine: 'windModifier',
      params: Object.freeze({
        endWithDuration: false,
        sources: Object.freeze([-2100, -1500, -900, -300, 300, 900, 1500, 2100].map((along) => Object.freeze({
          type: 'updraft', direction: 'heading', offset: Object.freeze([along, 0, 0]), radius: 520, updraft: 3, base: -160, top: 700,
          sinkRing: 0, ringWidth: 0.5, turbulence: 0.22, gust: 2, fadeIn: 0,
        }))),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 9000, far: 20000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'raptor', params: Object.freeze({ pitch: 0.95 }) }),
  journal: Object.freeze({
    title: 'Ridge lift band',
    description: 'Wind forced up a long ridge, marked by a cap cloud and hawks soaring the line: free height all along the crest.',
  }),
  discovery: Object.freeze({ radius: 4000, requireInView: true }),
  callouts: Object.freeze([
    'Cap cloud on the ridge {direction}, {distance} out. The air is rising all along it.',
    'Hawks soaring the ridgeline {direction}. Fly the crest and the lift holds you up.',
    'The {name} is about {eta} away, {direction}. Stay just above the crest.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 20 }) }),
});
