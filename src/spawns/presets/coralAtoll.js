// Preset 42: Coral atoll (uncommon site). Out in the sea a ring reef about a kilometre across rises from
// water at least 3 m deep everywhere it stands (the stamp's own fit, so it never cuts an island away;
// the site's centre at least 10 m down): a necklace of low white-sand islets (motu) on a reef crest
// just awash, around a lagoon 5-8 m deep (the atoll stamp, painted sand). The lagoon water turns clear
// turquoise, so the sand floor reads through it, and the surf breaks in a white ring along the reef
// crest (waterEffect shallows, fitted to the stamp); fish jump in the lagoon now and then. A calm
// lagoon for a seaplane to set down in. The surf recipe rolls breakers onto the reef. No wind effect.
// Docs: docs/engines/waterEffect.md (shallows, splash).
export default Object.freeze({
  id: 'coralAtoll',
  name: 'Coral atoll',
  category: 'ocean',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['water', 'calm', 'slow', 'spectacle']),
  placement: Object.freeze({
    chance: 0.5,
    minSpacing: 20000,
    biomes: Object.freeze(['archipelago', 'dunes', 'meadows']),
    surface: 'any',
    terrain: Object.freeze({ maxHeight: -10, relief: 'any' }),
    clearance: 400,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'water' }),
  stamps: Object.freeze([
    Object.freeze({
      type: 'atoll',
      radius: Object.freeze([380, 560]),
      width: Object.freeze([80, 120]),
      islets: Object.freeze([4, 7]),
      isletHeight: Object.freeze([2.2, 4.2]),
      lagoonDepth: Object.freeze([5, 8]),
      reefDepth: Object.freeze([0.5, 1.1]),
      falloff: Object.freeze([160, 240]),
      paint: 'sand',
    }),
  ]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'waterEffect',
      params: Object.freeze({
        effect: 'shallows',
        color: 0x3fdccb,
        clarity: 0.85,
        surf: 0.85,
        fadeIn: 3,
        voice: true,
        voiceIntensity: 0.75,
      }),
    }),
    Object.freeze({
      engine: 'waterEffect',
      params: Object.freeze({ effect: 'splash', interval: Object.freeze([2, 5]), scatter: 600, strength: 0.15, glow: 0, waterOnly: true, voice: false }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 6000, far: 14000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'surf', params: Object.freeze({ size: 600 }) }),
  journal: Object.freeze({
    title: 'Coral atoll',
    description: 'A ring of white sand islets on a reef in the open sea, holding a clear turquoise lagoon inside the surf.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Turquoise water {direction}, {distance} out. That is a coral atoll.',
    'A ring of islets {direction} with a lagoon inside, {distance}. Calm water to land on.',
    'The {name} is about {eta} away, {direction}. Look for the white surf ring.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 14000, hysteresis: 2500, outOfViewSeconds: 20 }) }),
});
