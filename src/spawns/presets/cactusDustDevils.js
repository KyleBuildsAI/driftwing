// Preset 89: Cactus forest with dust devils* (uncommon site; affects flight). A forest of tall saguaros
// stands on warm desert ground (a region overlay adding the saguaro species, palette saguaroDesert), and
// two dust devils wander between the cacti, each a slender spinning column of sand on its own seeded
// meandering path (vortex parts with a track; a site walks its path back and forth). Their wind is
// real: a small Rankine vortex with a rising core that tosses a light craft and lifts a glider. The
// desert hisses with the whirl of sand. Docs: docs/engines/vortex.md (the dust devil example).

/** What both dust devils share: a slim, collarless sand column with a dusty foot and no cloud. */
const DUST_DEVIL = Object.freeze({
  startStage: 'mature', surface: 'land', taper: 1.6, twist: 1.4, wobblePeriod: 7, collar: 0, opacity: 0.5, striation: 0.9,
  color: 0xc9a77c, shadeColor: 0x7a6248, debrisColor: 0xa8865e, debrisRadius: 3, particleSize: 1.1, puffs: 0,
  trackWander: 60, trackMeander: 320,
});

export default Object.freeze({
  id: 'cactusDustDevils',
  name: 'Cactus forest with dust devils',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['desert', 'thermal', 'spectacle'],
  placement: {
    chance: 0.14,
    minSpacing: 16000,
    biomes: ['dunes'],
    surface: 'land',
    terrain: { minHeight: 10, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [1200, 1500], falloff: 300 },
    palette: 'saguaroDesert',
    vegetation: { species: ['saguaro'], density: 0.22, mode: 'add' },
    priority: 1,
  }],
  engines: [
    // The larger devil (owns the voice).
    {
      engine: 'vortex',
      params: {
        ...DUST_DEVIL, coreRadius: 6, topRadius: 24, cloudBase: 230, wobble: 7, groundParticles: 1200, debrisHeight: 60,
        trackSpeed: 3, trackTurn: 0, voice: true, audioIntensity: 0.45,
      },
    },
    // A slighter one on another path.
    {
      engine: 'vortex',
      params: {
        ...DUST_DEVIL, coreRadius: 4, topRadius: 16, cloudBase: 160, wobble: 5, groundParticles: 800, debrisHeight: 40,
        trackSpeed: 2.4, trackTurn: 140, maxTangential: 12, inflowRadius: 100, updraft: 5, voice: false,
      },
    },
  ],
  lod: { near: 2000, mid: 5000, far: 12000 },
  lure: null,
  // Read by both vortex parts (the slighter one overrides its strength in its own params).
  wind: [{ type: 'rankine', params: { coreRadius: 6, maxTangential: 16, inflowRadius: 140, inflowSpeed: 4, updraft: 7, top: 230, sinkRing: 0.1, turbulence: 0.6, gust: 3 } }],
  audio: { recipe: 'tornado', params: { refDistance: 60 } },
  journal: {
    title: 'Cactus Forest',
    description: 'A forest of giant saguaros with dust devils wandering between them, small whirlwinds you can feel in the cockpit.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Saguaros {direction}, {distance} out, and dust devils wandering between them.',
    'Watch the dust devils {direction}: a light craft will get tossed, and a glider can ride the lift.',
    'The {name} is about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
