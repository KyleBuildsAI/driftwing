// Preset 98: Midnight sun (legendary global override, polar and snow regions). On a scheduled night
// (about one in twenty, the same nights for everyone on the seed) the sun over the snow country never
// sets: the director's override bends its path so it skims the northern horizon, 1.5 degrees up at
// midnight, and state.time follows the bent sun (the night factor, the labels, the thermals, the
// time-of-day filters) (contract i.4: override kind 'midnightSun'). The weight is regional: 1 over the
// snow, easing to 0 over 4 km beyond it (snow patches here are 1.5-8 km across), so flying out of the
// snow brings the night back. From half weight the preset's own part starts once that night: a warm,
// low-sun amber laid over the sky and the haze (celestial sky component) with a soft ambient pad
// (lantern), its discovery and journal entry; it ends with the override. Never a director candidate.
// Docs: docs/engines/celestial.md, docs/spawns.md (Global overrides).
export default Object.freeze({
  id: 'midnightSun',
  name: 'Midnight sun',
  category: 'celestial',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['celestial', 'snow', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 1800, chance: 0.2 }),
  filters: Object.freeze({
    biomes: Object.freeze(['snow']),
    timeOfDay: null,
    altitude: null,
    weather: null,
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 30,
        fadeOut: 30,
        sky: Object.freeze({ skyTint: 0xffc48a, skyTintAmount: 0.22, fogColor: 0xffd2a4, fogColorAmount: 0.16, when: 'always' }),
        ownsAudio: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'lantern', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Midnight sun',
    description: 'A night over the snow when the sun never set, skimming the northern horizon in endless gold until morning.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: false }),
  callouts: Object.freeze([
    'It is midnight and the sun is still up. It is skimming the horizon, look north.',
    'Midnight sun over the snow tonight. It will not set at all.',
    'Endless golden hour. The {name} is with us as long as we stay over the snow.',
    'Fly out of the snow and the night comes back. Stay here and the sun stays up.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([1800, 2400]), despawn: Object.freeze({ distance: 40000, hysteresis: 5000, outOfViewSeconds: 60 }) }),
  override: Object.freeze({ kind: 'midnightSun', nightChance: 0.05, region: Object.freeze({ biomes: Object.freeze(['snow']), blendKm: 4 }) }),
});
