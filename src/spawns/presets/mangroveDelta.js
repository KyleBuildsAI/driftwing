// Preset 88: Mangrove delta (uncommon site). Where a low coast meets the sea the ground fans out into
// tidal flats cut by meandering channels the sea fills (a delta stamp aligned downhill, out to sea),
// and mangroves stand on their roots across the flats and in the shallows (a region overlay planting
// the mangrove species, palette mangrove). A morning mist lies low over the channels and the roots,
// thick at dawn and thin by day (a weather-volume bank with hours); at night fireflies blink among the
// trees, partly in step; water laps at the roots, frogs and insects call. Docs:
// docs/engines/weatherVolume.md (hours), lightEffect.md (swarm); the delta stamp: src/world/stamps.js.

export default Object.freeze({
  id: 'mangroveDelta',
  name: 'Mangrove delta',
  category: 'ocean',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['coast', 'water', 'calm'],
  placement: {
    chance: 0.6,
    minSpacing: 18000,
    biomes: ['archipelago', 'meadows', 'pine'],
    surface: 'coast',
    clearance: 150,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'coast' },
  // The flats and channels; no paint, so the mangroves grow on them (nothing grows on painted stamp ground).
  stamps: [{ type: 'delta', offset: { along: 550, across: 0 }, length: [1300, 1600], width: [1200, 1600], channels: [4, 7], channelWidth: [26, 42], depth: [2.5, 4], plain: [0.5, 0.85], falloff: [180, 240], paint: null }],
  overlays: [{
    shape: { kind: 'stamp', stamp: 0, grow: 120, falloff: 220 },
    palette: 'mangrove',
    vegetation: { species: ['mangrove'], density: 0.62, mode: 'replace' },
    priority: 1,
  }],
  engines: [
    // The mist over the flats and channels (the puffs over ground below 4 m only), and the marsh's voice.
    {
      engine: 'weatherVolume',
      params: {
        form: 'bank', base: 1, length: 1500, width: 1700, height: 38, puffs: 130, detail: 0.2, tint: 0xeef1f0, brightness: 1.04,
        billow: 0.2, fillBelow: 4, hours: { dawn: 1, day: 0.15, dusk: 0.45, night: 0.7 },
        insideFog: { density: 5, color: 0xdfe5e4, darkness: 0 }, wind: { turbulence: 0.04 }, ownsAudio: true,
      },
    },
    // Fireflies among the mangroves at night, blinking partly in step.
    {
      engine: 'lightEffect',
      params: {
        swarm: {
          count: 2600, radius: 520, height: [1, 7], size: [0.7, 1.1], colors: [0xc8ff7a, 0xe8ff9a, 0xa8ff8a], intensity: 4,
          blink: { period: [1.6, 2.4], duty: 0.25 }, sync: 0.7, wander: { radius: 1.2, speed: 0.3, vertical: 0.4 },
        },
        visibility: { day: 0, night: 1 },
        sound: false,
      },
    },
  ],
  lod: { near: 2500, mid: 7000, far: 16000 },
  lure: null,
  wind: [],
  audio: { recipe: 'marsh', params: { lap: 0.8, frogs: 0.6, insects: 0.6 } },
  journal: {
    title: 'Mangrove Delta',
    description: 'Mangroves on their stilted roots across a maze of tidal channels, with mist lying low at dawn and fireflies at night.',
  },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'A mangrove delta on the coast {direction}, {distance} out. Channels everywhere.',
    'I see the {name} {direction}. Low and slow over the channels, if you like.',
    'The {name} is about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 16000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
