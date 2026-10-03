// Preset 1: Tornado (heavy, rare event; affects flight). A funnel lowers out of a turning wall cloud
// under its parent storm, touches down and walks across the land with a ring of debris, then ropes out
// and lifts. Inside 1.5 km the inflow pulls toward the core; the core is a violent updraft wrapped in
// 70 m/s rotation and heavy turbulence that can fling a glider. The storm above drifts with the
// funnel and throws lightning. Docs: docs/engines/vortex.md, weatherVolume.md, lightEffect.md.
export default Object.freeze({
  id: 'tornado',
  name: 'Tornado',
  category: 'weather',
  kind: 'event',
  rarity: 'rare',
  heavy: true,
  candidates: { cellSize: 9000, bucketSeconds: 600, chance: 0.55 },
  filters: {
    biomes: ['meadows', 'dunes', 'pine'],
    timeOfDay: ['day', 'dawn', 'dusk'],
    altitude: { min: 0, max: 6000 },
    weather: ['storm'],
    surface: 'land',
    minDistance: 4000,
    maxDistance: 9000,
  },
  engines: [
    {
      engine: 'vortex',
      params: {
        coreRadius: 55, topRadius: 280, cloudBase: 850, taper: 2.3, twist: 0.7, wobble: 30, wobblePeriod: 11,
        ropeLean: 0.65, ropeThin: 0.2, collar: 0.9, opacity: 0.95, striation: 0.65,
        color: 0xa9a49d, shadeColor: 0x41444d, debrisColor: 0x5a4636,
        groundParticles: 2800, debrisRadius: 2.8, debrisHeight: 190, particleSize: 3.5, puffs: 460, puffSize: 80,
        trackSpeed: 9, trackWander: 18, trackMeander: 1800,
        formSeconds: 30, ropeSeconds: 45, voice: true,
        journal: [
          { key: 'closestTornado', record: 'closestDistance', op: 'min', max: 15000 },
          { key: 'stormsChased', value: 1, op: 'add', max: 3000 },
        ],
      },
    },
    {
      engine: 'weatherVolume',
      params: {
        form: 'tower', base: 1250, height: 7600, radius: 2200, storm: 0.85, puffs: 140,
        anvil: { radius: 7200, thickness: 1300, lean: 2400, storm: 0.6 },
        overshoot: 0.5,
        wallCloud: { radius: 760, drop: 400, offset: 0, rotation: 7, puffs: 26 },
        rain: [{ offset: [900, 1500], radius: 1100, density: 0.75, downdraft: 6, outflow: 9 }],
        wind: { turbulence: 0.5, updraft: 4 },
        drift: { speed: 9 },
        formSeconds: 20,
        dissipateSeconds: 50,
        // The parent storm keeps its own far mass beside the funnel lure.
        farMode: 'coarse',
        ownsAudio: false,
      },
    },
    {
      engine: 'lightEffect',
      params: {
        lightning: { rate: 7, radius: 3600, cloudBase: 1250, groundShare: 0.5, branches: 7, flash: 0.6, minCameraDistance: 600 },
        visibility: { day: 1, night: 1 },
        sound: false,
      },
    },
  ],
  // The funnel lure takes over from about 5 km: the camera's far plane and the fog (a few km at golden
  // hour) would hide the funnel's own shell beyond that.
  lod: { near: 2000, mid: 4500, far: 45000 },
  lure: { type: 'funnel', height: 2400, width: 1300, color: 0x4f545e, flash: 0.8 },
  wind: [{ type: 'rankine', params: { maxTangential: 72, inflowRadius: 1500, inflowSpeed: 14, updraft: 45, sinkRing: 0.12, turbulence: 0.95, gust: 8 } }],
  audio: { recipe: 'tornado', params: {} },
  journal: { title: 'Tornado', description: 'A rope of wind that walks across the land, then lifts back into its storm.' },
  discovery: { radius: 5000, requireInView: true },
  callouts: [
    'Tornado on the ground, {distance} {direction}. Keep your distance.',
    'Funnel cloud {direction}, {distance} out. It is tracking across the land.',
    '{name} {distance} {direction}, about {eta} at this speed. The inflow will pull us in.',
    'Wall cloud is rotating {direction}. That {name} is real, {distance} away.',
  ],
  lifetime: { duration: [240, 360], despawn: { distance: 15000, hysteresis: 3000, outOfViewSeconds: 30 } },
});
