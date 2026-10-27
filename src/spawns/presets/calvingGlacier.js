// Preset 41: Calving glacier (uncommon site). Where the snow country meets the sea, a tidewater glacier
// flows down to an ice cliff 34-48 m high standing in the water: crevassed snow on top, moraine along
// its edges, the face banded from white to deep blue. Every minute or so a slab of the front cracks
// with a report like a gunshot, topples outward and plunges into the sea with a splash and a ring wave
// that spreads across the water (and lifts what floats on it), then drifts off as a berg and melts.
// A field of icebergs drifts before the front, each one solid (a collider hull turned with it); the
// tongue's top is landable ice with a perch at its highest point. Groaning ice, the crack and the
// splash are the calving recipe. Docs: docs/engines/structure.md (recipe glacier, movers).
export default Object.freeze({
  id: 'calvingGlacier',
  name: 'Calving glacier',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['water', 'coast', 'snow', 'perch', 'spectacle']),
  placement: Object.freeze({
    chance: 0.4,
    minSpacing: 18000,
    biomes: Object.freeze(['snow', 'pine']),
    surface: 'coast',
    clearance: 600,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'coast' }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'glacier',
        length: Object.freeze([1400, 1900]),
        width: Object.freeze([380, 540]),
        frontHeight: Object.freeze([34, 48]),
        slabs: Object.freeze([3, 5]),
        bergs: Object.freeze([6, 9]),
        bergSize: Object.freeze([10, 30]),
        bergSpread: 900,
        interval: Object.freeze([45, 85]),
        first: Object.freeze([8, 18]),
        wave: Object.freeze({ height: 2.6, width: 16, speed: 9, travel: 900 }),
        audioIntensity: 'constant',
        audioLevel: 0.55,
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2200, mid: 6000, far: 14000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'calving', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Calving glacier',
    description: 'A river of ice ending in a blue cliff over the sea, where slabs crack away, crash into the water and drift off as icebergs.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Glacier front {distance} {direction}. Wait for it: the ice cliff calves every minute or so.',
    'Icebergs in the water {direction}, {distance} out, drifting off a glacier. They are solid ice.',
    'The {name} is about {eta} away, {direction}. Keep clear of the face when it cracks.',
    'Blue ice cliff {direction}, {distance}. You can set down on the glacier top.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 14000, hysteresis: 2500, outOfViewSeconds: 20 }) }),
});
