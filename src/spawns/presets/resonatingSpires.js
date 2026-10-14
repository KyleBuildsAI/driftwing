// Preset 99: Resonating crystal spires (legendary combo, thunderstorm, at a crystal spires site). When a
// thunderstorm stands over a grove of crystal spires (28), the grove resonates: arcs of blue-white light
// leap from spire tip to spire tip and the spires' own glow swells (lightEffect arcs on the spires
// site's arc points, its glow multiplier raised), lightning strikes down into the grove (lightEffect
// lightning, its flash and thunder), and every arc rings the crystal chord (crystal voice at full
// intensity, a chime per arc). Combo scheduling (contract i.3): its preconditions move the candidate
// onto the nearest crystal spires site within 8 km and want storm weather there; the Phase 2 supercell
// is its member, its storm tower standing 3.5 km beyond the grove. Docs: docs/engines/lightEffect.md,
// structure.md.
export default Object.freeze({
  id: 'resonatingSpires',
  name: 'Resonating crystal spires',
  category: 'fantasy',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['spectacle']),
  candidates: Object.freeze({ cellSize: 8000, bucketSeconds: 600, chance: 0.6 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: null,
    altitude: null,
    weather: Object.freeze(['storm']),
    surface: 'land',
    minDistance: 2000,
    maxDistance: 9000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        lightning: Object.freeze({
          rate: 9,
          radius: 220,
          cloudBase: 1400,
          groundShare: 0.85,
          color: 0xd6e6ff,
          width: 3.5,
          branches: 7,
          flash: 0.6,
          light: Object.freeze({ intensity: 2e7, range: 6000, priority: 3 }),
          thunder: 1,
          minCameraDistance: 250,
        }),
        arcs: Object.freeze({
          target: 'crystalSpires',
          radius: 2500,
          rate: 42,
          maxGap: 170,
          color: 0xc4f0ff,
          width: 1.8,
          brightness: 9,
          branches: 3,
          duration: 0.5,
          glow: 1,
          thunder: 0.3,
          resonance: 1.8,
          chime: true,
        }),
        visibility: Object.freeze({ day: 1, night: 1 }),
        sound: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 8000, far: 20000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'crystal', params: Object.freeze({ baseHz: 146.8, rangeSemitones: 12, refDistance: 120 }) }),
  journal: Object.freeze({
    title: 'Resonating crystal spires',
    description: 'A thunderstorm over the crystal spires set them ringing, arcs of light leaping from tip to tip while lightning struck into the grove.',
  }),
  discovery: Object.freeze({ radius: 4000, requireInView: true }),
  callouts: Object.freeze([
    'The crystal spires {direction} are resonating with the storm. Look at the arcs between them.',
    'Lightning is jumping between the spires {distance} {direction}. Do not fly through that grove now.',
    'Hear them ringing? The {name} are about {eta} away.',
    'Every strike sets the spires off. Arcs from tip to tip, {direction}.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([240, 360]), despawn: Object.freeze({ distance: 16000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({
      weather: Object.freeze(['storm']),
      near: Object.freeze({ sites: Object.freeze(['crystalSpires']), radius: 8000 }),
    }),
    members: Object.freeze([Object.freeze({ presetId: 'supercell', place: Object.freeze({ bearing: 0, distance: 3500, jitter: 500 }) })]),
    exclusive: true,
    heavySlots: 1,
  }),
});
