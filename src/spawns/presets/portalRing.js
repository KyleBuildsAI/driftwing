// Preset 67: Portal ring (rare site). A ring of dark rune-carved stone 80-90 m across stands on two
// leaning pillars, holding a membrane of violet light that spirals into its centre, with crystal shards
// hovering around it and motes drifting in. Fly through the membrane, either way, and the screen fades
// into its light: the portal leads to the world whose seed is hash(this seed, the portal's site id),
// the URL hash updates to it, the craft arrives exactly as it left (position, height above the ground,
// heading, speed, every setting) and the journal logs the world visited (src/gameplay/portals.js).
// The ring's blocks, pillars and slab are solid. It hums, and surges as you cross.
// Docs: docs/engines/structure.md (recipe portalRing), lightEffect.md.
export default Object.freeze({
  id: 'portalRing',
  name: 'Portal ring',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['spectacle', 'perch']),
  placement: Object.freeze({
    chance: 0.07,
    minSpacing: 30000,
    biomes: null,
    surface: 'land',
    terrain: Object.freeze({ minHeight: 10, maxHeight: 700, relief: 'flat' }),
    clearance: 600,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'portalRing', radius: Object.freeze([38, 46]), thickness: 5.5, lift: 9, voice: true, audioIntensity: 'approach' }),
    }),
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          Object.freeze({
            layout: 'scatter', count: 90, radius: 75, height: Object.freeze([12, 110]), size: Object.freeze([1.5, 3.5]),
            colors: Object.freeze([0xb9a6ff, 0x8fe8ff]), intensity: 3, flicker: 0.4, wander: Object.freeze({ radius: 8, speed: 0.5 }),
          }),
        ]),
        visibility: Object.freeze({ day: 0.35, night: 1 }),
        sound: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1500, mid: 5000, far: 12000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'portal', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Portal ring',
    description: 'A ring of rune-carved stone holding a swirl of light. Fly through it and you come out in another world.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'There is a stone ring {direction} with light swirling inside it. A portal, {distance} out.',
    'Portal ring {direction}. Fly through the middle and we will come out in a different world.',
    'The {name} is about {eta} away, {direction}. Everything comes with us: craft, speed and heading.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
