// Preset 3: Waterspout (uncommon ocean event; affects flight). A thinner, milder vortex than the
// tornado that hangs from a dark cumulus over the sea, with a spray ring churning the water at its
// foot (and a foam wake behind it as it wanders). Its core lifts and spins a glider but rarely
// flings it. Docs: docs/engines/vortex.md, waterEffect.md, weatherVolume.md.
export default Object.freeze({
  id: 'waterspout',
  name: 'Waterspout',
  category: 'ocean',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  candidates: { cellSize: 7000, bucketSeconds: 450, chance: 0.45 },
  filters: {
    biomes: null,
    timeOfDay: ['day', 'dawn', 'dusk'],
    altitude: { min: 0, max: 4000 },
    weather: ['building', 'storm'],
    surface: 'water',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      engine: 'vortex',
      params: {
        surface: 'water', coreRadius: 16, topRadius: 85, cloudBase: 700, taper: 2.6, twist: 0.9, wobble: 14, wobblePeriod: 8,
        collar: 0.6, opacity: 0.8, striation: 0.7, color: 0xc9ccce, shadeColor: 0x5a626d, sprayColor: 0xe9f1f4,
        groundParticles: 2000, debrisRadius: 3.2, sprayHeight: 60, particleSize: 3, puffs: 320, puffSize: 45,
        trackSpeed: 5, trackWander: 25, trackMeander: 1200, formSeconds: 25, ropeSeconds: 35, audioIntensity: 0.55, voice: true,
      },
    },
    { engine: 'waterEffect', params: { effect: 'spray', follow: 0, ringRadius: 20, rate: 240, height: 12, spread: 0.5, swirl: 10, size: 1.4, foam: 0.7 } },
    {
      engine: 'weatherVolume',
      params: {
        form: 'cumulus', base: 720, height: 1900, radius: 1150, storm: 0.55, puffs: 46,
        rain: [{ offset: [500, 600], radius: 420, density: 0.5 }],
        wind: { turbulence: 0.25 },
        drift: { speed: 5 },
        formSeconds: 20,
        dissipateSeconds: 40,
        ownsAudio: false,
      },
    },
  ],
  lod: { near: 2000, mid: 7000, far: 22000 },
  lure: null,
  wind: [{ type: 'rankine', params: { maxTangential: 38, inflowRadius: 550, inflowSpeed: 7, updraft: 20, turbulence: 0.75, gust: 5 } }],
  audio: { recipe: 'tornado', params: {} },
  journal: { title: 'Waterspout', description: 'A spinning column of spray and cloud that dances across the sea.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'Waterspout over the water, {distance} {direction}.',
    'There is a {name} {direction}, {distance} out. The spray ring is huge.',
    'Spout {direction}, about {eta} away. Milder than a tornado, still rough inside.',
  ],
  lifetime: { duration: [180, 300], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
