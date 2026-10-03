// Wind farm* (Phase 2 preset 19): a site on open plains and dunes.
//
// One or two staggered rows of three-bladed turbines (structure windFarm), laid across the
// prevailing wind. Each nacelle yaws into the real WindField wind and its rotor speed follows the
// wind speed the player feels there (cut-in 3 m/s, rated 11, feathered past 25). Downwind of every
// rotor the structure engine authors the wake: slower, turbulent air in a widening cone ten rotor
// diameters long (a WindField source, kind 'structure-wake'), which shakes the craft and the camera
// when you fly through it. That wake is the preset's wind effect, so `wind` stays empty. The
// rhythmic whoosh follows the wind speed (turbine recipe). Pure data (contract section 1).
export default Object.freeze({
  id: 'windFarm',
  name: 'Wind farm',
  category: 'structure',
  kind: 'site',
  rarity: 'common',
  heavy: false,
  placement: {
    chance: 0.06,
    minSpacing: 14000,
    biomes: ['meadows', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 15, maxHeight: 700, relief: 'any' },
    clearance: 800,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'windFarm',
        count: [6, 10],
        rows: 2,
        spacing: 270,
        rowSpacing: 520,
        jitter: 0.12,
        hubHeight: [74, 88],
        rotorRadius: [36, 42],
        align: 'wind',
        maxRpm: 16,
        cutIn: 3,
        ratedWind: 11,
        cutOut: 25,
        yawRate: 5,
        wake: { length: 10, deficit: 0.35, turbulence: 0.55, expansion: 0.075 },
        audioIntensity: 'wind',
      },
    },
  ],
  lod: { near: 2500, mid: 7000, far: 16000 },
  lure: null,
  wind: [],
  audio: { recipe: 'turbine', params: {} },
  journal: { title: 'Wind farm', description: 'Rows of white turbines turned into the wind, with rough air in their wakes.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'Wind farm {direction}, {distance} out. Rough air downwind of the rotors.',
    'Turbines {distance} {direction}. They point into the wind, so you can read it off them.',
    'Wind farm about {eta} away. Stay clear of the wakes behind the blades.',
    'White towers on the skyline {direction}: a wind farm, {distance}.',
  ],
  lifetime: { duration: null, despawn: { distance: 16000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
