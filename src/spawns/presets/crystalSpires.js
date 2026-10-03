// Preset 28: Crystal spires (site). A cluster of glowing crystal spires with shards and boulders,
// brighter at night (structure engine, spires recipe). Their harmonic hum swells and rises in pitch
// as you approach (the crystal voice's intensity is the approach), and flying between two neighbouring
// spires rings a chime (the recipe's fly-through gates). Motes of light drift among the spires after
// dark (lightEffect glows).
export default Object.freeze({
  id: 'crystalSpires',
  name: 'Crystal spires',
  category: 'fantasy',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: Object.freeze({
    chance: 0.14,
    minSpacing: 16000,
    biomes: Object.freeze(['snow', 'dunes', 'meadows', 'pine']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 4, relief: 'any' }),
    clearance: 400,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'spires',
        count: Object.freeze([7, 11]),
        height: Object.freeze([50, 125]),
        radius: Object.freeze([4, 9]),
        spread: 115,
        tilt: 14,
        colors: Object.freeze([0x8fe3ff, 0xb89cff, 0x9ff0d0, 0xffb8f0]),
        shards: Object.freeze([10, 16]),
        chimes: true,
        maxGap: 85,
        approach: 1800,
        audioIntensity: 'approach',
        voice: true,
      }),
    }),
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          Object.freeze({
            layout: 'scatter',
            count: 70,
            radius: 130,
            onGround: true,
            height: Object.freeze([4, 70]),
            size: Object.freeze([1.6, 3.2]),
            colors: Object.freeze([0x9fe8ff, 0xc8b0ff, 0xb0ffe0]),
            intensity: 3.2,
            pulse: Object.freeze({ period: 5, depth: 0.5 }),
            wander: Object.freeze({ radius: 9, speed: 0.12, vertical: 0.4 }),
            shape: 'orb',
          }),
        ]),
        visibility: Object.freeze({ day: 0.1, night: 1 }),
        sound: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 6000, far: 14000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'crystal', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Crystal spires',
    description: 'A grove of glowing crystal spires that hum louder and higher as you close in, and chime when you thread between them.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Something glittering {direction}, {distance} out. Crystal spires.',
    'Crystal spires {direction}. Thread between two of them and listen.',
    'Hear that hum? The {name} are about {eta} away, {direction}.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
