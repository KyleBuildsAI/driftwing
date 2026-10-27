// Preset 37: Fissure eruption (heavy site; its active state is rare). A crack a kilometre long splits
// a lava plain (a narrow carve stamp across the site, between ramparts of black spatter), lava glowing
// in its floor. Usually it only steams. When it erupts, a curtain of fire stands along the whole crack:
// lava fountains a hundred metres high surging and falling back, a grey gas plume lit orange from
// below, the low cloud deck above glowing orange at night, and a deep roar with bursts of booms. The
// director starts the eruption (activeState), like the volcano's. Docs: docs/engines/emitter.md (the
// line shape), structure.md (the 'lavaChannels' recipe), weatherVolume.md (glow with a radius).
import { structureStamps } from '../engines/structure/stamps.js';

/** The crack's length range (m); the fountains and the plume run along most of it. */
const CRACK_LENGTH = Object.freeze([900, 1200]);

export default Object.freeze({
  id: 'fissureEruption',
  name: 'Fissure eruption',
  category: 'geo',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  tags: ['spectacle', 'farLure', 'night'],
  placement: {
    chance: 0.06,
    minSpacing: 32000,
    biomes: ['snow', 'pine', 'meadows', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 900, relief: 'any' },
    clearance: 600,
  },
  activeState: { duration: [300, 540] },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 9000 },
    weather: null,
    surface: 'land',
    minDistance: 3000,
    maxDistance: 25000,
  },
  // The crack: a narrow, deep carve turned a quarter turn, so it runs along the site's right axis
  // (the emitters' line shape) with little meander.
  stamps: structureStamps('lavaChannels', {
    length: CRACK_LENGTH, width: [8, 12], depth: [10, 16], wallWidth: [5, 8], twist: [10, 25], plateau: [6, 10], shoulder: [25, 40],
    rotation: Math.PI / 2,
  }),
  engines: [
    {
      // Lava pooled in the crack's floor, and the spatter ramparts along both lips.
      engine: 'structure',
      params: { recipe: 'lavaChannels', toSea: false, width: 0.9, blocks: 26, blockSize: [1.2, 3.5], voice: false },
    },
    {
      // The curtain of fire: lava fountains along the crack, surging in bursts that boom.
      engine: 'emitter',
      params: {
        particles: 8192, style: 'glow', blend: 'additive', shape: { type: 'line', length: 860 }, hugGround: true, offset: [0, 2, 0],
        speed: [22, 46], spread: 9, gravity: 1, drag: 0.05, windFollow: 0.15, life: [3, 6], size: [10, 4], sizeJitter: 0.4, stretch: 0.03,
        colors: [0xfff0b8, 0xff8a24, 0x5a1404], colorMid: 0.4, emissive: 7, emissiveDecay: 1.1, nightBoost: 0.8, fog: 0.45,
        bursts: { interval: [3, 8], count: [400, 900], speedScale: 1.5, minLevel: 0.3 },
        inactiveIntensity: 0,
        light: { color: 0xff7a30, intensity: 4e6, range: 4500, offset: [0, 120, 0], flicker: 0.35 },
        lod: { near: 1, mid: 0.5, far: 0 },
        soundTriggers: { burst: 'boom' }, sound: true,
      },
    },
    {
      // The gas plume rising off the crack, lit from below; dormant, a thin steam.
      engine: 'emitter',
      params: {
        particles: 4000, style: 'puff', shape: { type: 'line', length: 900 }, hugGround: true, offset: [0, 10, 0],
        speed: [8, 16], spread: 14, gravity: 0, buoyancy: 4, buoyancyDecay: 40, drag: 0.1, turbulence: { spread: 10, wobble: 14, frequency: 0.06 },
        life: [30, 50], size: [60, 380], sizeCurve: 0.6, sizeJitter: 0.4, brightnessJitter: 0.2,
        colors: [0x8d8883, 0x77726d, 0xa29e99], opacity: 0.62, softness: 1.3, fadeOut: 1.3, fog: 0.4,
        inactiveIntensity: 0.15, pulse: { period: 11, depth: 0.25 },
        underglow: { color: 0xff5a1e, intensity: 2.4, height: 500, night: 0.85 },
        lod: { near: 1, mid: 0.5, far: 0 },
        sound: false,
      },
    },
    {
      // The low cloud deck over the plain, lit orange from below at night (above the fissure only).
      engine: 'weatherVolume',
      params: {
        form: 'sheet', base: 900, radius: 4500, thickness: 240, puffs: 130, tint: 0xa8a39e, storm: 0.35, brightness: 0.9,
        glow: { color: 0xff5a24, strength: 2.4, when: 'night', radius: 3200, dormant: 0.2 },
        wind: { turbulence: 0 },
        formSeconds: 30,
        ownsAudio: false,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 40000 },
  lure: { type: 'plume', height: 3500, width: 2600, color: 0x6f6a66, glow: 0xff5a1e },
  wind: [],
  audio: { recipe: 'volcano', params: {} },
  journal: { title: 'Fissure eruption', description: 'A kilometre-long crack spouting a curtain of fire under a glowing cloud.' },
  discovery: { radius: 8000, requireInView: true },
  callouts: [
    'Fissure eruption {direction}, {distance} off. A whole curtain of fire.',
    'Lava fountains along a crack {direction}, {distance} out. Keep well above them.',
    'The {name} is about {eta} away, {direction}. At night the clouds over it glow orange.',
    'Fire curtain {direction}, {distance} away. Stay upwind of the gas.',
  ],
  lifetime: { duration: null, despawn: { distance: 40000, hysteresis: 5000, outOfViewSeconds: 30 } },
});
