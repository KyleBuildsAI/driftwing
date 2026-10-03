// Eagle wingman (Phase 2 preset 18): an uncommon daytime event over high and open country.
//
// A large eagle circles at about your height (fauna wingman, altitude mode 'player'). Fly within
// about 2 km and it comes over to join you off your wing, matching your speed within its own
// (9-36 m/s: a glider or a slow bush plane); it screams as it joins. After about 60 s on the wing it
// screams again and peels off in a climbing turn, and the event ends shortly after. Outrun it and it
// gives up early. If you never come, it fades out with its duration. The scream is the raptor recipe,
// pitched down for an eagle. No wind effect. Pure data (contract section 1).
export default Object.freeze({
  id: 'eagleWingman',
  name: 'Eagle wingman',
  category: 'wildlife',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  candidates: { cellSize: 6000, bucketSeconds: 450, chance: 0.45 },
  filters: {
    biomes: ['snow', 'pine', 'meadows', 'dunes'],
    timeOfDay: ['day'],
    altitude: { min: 0, max: 3000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 7000,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'eagle',
        behavior: 'wingman',
        count: 1,
        size: 1.35,
        sizeJitter: 0.05,
        altitude: { mode: 'player', value: 40, spread: 30, ceiling: 2200 },
        fadeIn: 3,
        fadeOut: 8,
        voiceIntensity: 1,
        wingman: {
          side: 0,
          right: 18,
          up: 3,
          forward: 2,
          joinRadius: 2200,
          escortSeconds: 60,
          lostDistance: 450,
          lostSeconds: 7,
          peelSeconds: 18,
          trigger: 'call',
          waitAltitude: 150,
          waitRadius: 90,
        },
      },
    },
  ],
  lod: { near: 1500, mid: 4000, far: 8000 },
  lure: null,
  wind: [],
  audio: { recipe: 'raptor', params: { pitch: 0.8 } },
  journal: { title: 'Eagle wingman', description: 'An eagle that joined you off the wing for a minute, then peeled away with a scream.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: [
    'Eagle circling {direction}, {distance} out. Fly past it and it might join you.',
    'Big bird {distance} {direction}: an eagle. Go say hello.',
    'There is an eagle about {eta} away, {direction}. Keep your speed down and it will fly with you.',
    'Eagle {direction}, {distance}. It looks curious.',
  ],
  lifetime: { duration: [300, 420], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
