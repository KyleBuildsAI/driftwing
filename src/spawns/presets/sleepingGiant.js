// Preset 68: Sleeping stone giant (rare site). A mountain shaped like a giant asleep on its back, 3.2 km
// from head to toe and 420 m to the chest: the terrain itself (the `giant` stamp, basalt where it
// stands high), so it reads from altitude and from the far field like any mountain. A face looks up at
// the sky (brow, eye hollows, nose, lips, chin), the hands are folded on the belly, one knee is raised.
// A ring of standing stones crowns the chest (the tallest is a perch) and scree litters the flanks. It
// breathes: every nine seconds a slow plume of mist rises from its nose, and the voice breathes with it,
// a deep rush with a grinding snore at the top of each breath.
// The breath stands at the nose by a fixed offset: the stamp's sizes are fixed (structureStamps
// 'sleepingGiant'), its base is the site's own ground and placement.scale is 1, so the nose is
// GIANT_NOSE.along x 3200 = 1254 m ahead and 0.8 x (420 + 109) - 109 = 314 m up.
// Docs: docs/engines/structure.md (recipe sleepingGiant), emitter.md.
export default Object.freeze({
  id: 'sleepingGiant',
  name: 'Sleeping stone giant',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['perch', 'spectacle', 'calm']),
  placement: Object.freeze({
    chance: 0.1,
    minSpacing: 30000,
    biomes: Object.freeze(['meadows', 'pine', 'dunes', 'snow']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 30, maxHeight: 520, relief: 'any' }),
    // Phase 1 landmarks are dense: a wider clearance leaves almost no 3 km stretch of land for it.
    clearance: 300,
    align: 'random',
    scale: Object.freeze([1, 1]),
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([
    Object.freeze({ type: 'giant', length: 3200, height: 420, falloff: 0.26, paint: 'basalt' }),
  ]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'sleepingGiant', voice: false }),
    }),
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 600, style: 'puff', shape: Object.freeze({ type: 'disc', radius: 10 }), offset: Object.freeze([0, 317, 1254]),
        speed: Object.freeze([3, 7]), spread: 22, buoyancy: 0.6, buoyancyDecay: 20, drag: 0.35, windFollow: 0.75,
        turbulence: Object.freeze({ spread: 6, wobble: 4, frequency: 0.08 }),
        life: Object.freeze([12, 20]), size: Object.freeze([12, 70]), sizeCurve: 0.6, sizeJitter: 0.35, brightnessJitter: 0.12,
        colors: Object.freeze([0xeef1f3, 0xdfe5ea, 0xf6f7f8]), opacity: 0.3, softness: 1.2, fadeOut: 1.3, fog: 0.5,
        pulse: Object.freeze({ period: 9, depth: 0.92 }),
        lod: Object.freeze({ near: 1, mid: 0.6, far: 0 }),
        sound: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 9000, far: 30000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'giant', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Sleeping stone giant',
    description: 'A mountain that is a giant asleep on its back, face to the sky, breathing mist from its nose.',
  }),
  discovery: Object.freeze({ radius: 5000, requireInView: true }),
  callouts: Object.freeze([
    'Look at that ridge {direction}. It is a giant lying on its back, {distance} out. You can see the face.',
    'The {name} is {direction}, about {eta} away. Watch its nose: it breathes.',
    'Stone giant {direction}, {distance} out. There is a ring of standing stones on its chest to land by.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 30000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
