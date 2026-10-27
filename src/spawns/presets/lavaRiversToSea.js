// Preset 36: Lava rivers to the sea (uncommon site). On a volcanic coast two rivers of molten lava run
// down shallow channels between low basalt levees, their dark crust drifting over glowing cracks, and
// pour on down the slope into the sea, where the water flashes to steam: white plumes boil up from
// each sea entry, littoral explosions throw glowing spatter, and at night the lava and the steam's
// underside glow orange. The sea entries hiss and roar. Docs: docs/engines/structure.md (the
// 'lavaChannels' recipe and the lava material), emitter.md (seaEntry).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'lavaRiversToSea',
  name: 'Lava rivers to the sea',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['coast', 'spectacle'],
  // Downhill-aligned on a coast, so the channels run down the fall line toward the water.
  placement: {
    chance: 0.35,
    minSpacing: 18000,
    biomes: null,
    surface: 'coast',
    terrain: { minHeight: 4, maxHeight: 300, relief: 'any' },
    clearance: 500,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'any' },
  // Two lava channels, side by side, upslope of the shore (each flow runs on from its exit to the sea).
  stamps: [
    ...structureStamps('lavaChannels', { offset: { along: -380, across: -150 }, rotation: -0.08 }),
    ...structureStamps('lavaChannels', { offset: { along: -330, across: 160 }, rotation: 0.1 }),
  ],
  engines: [
    {
      engine: 'structure',
      params: { recipe: 'lavaChannels', toSea: true, reach: 2600, width: 0.85, spread: 1.7, blocks: 14, voice: false },
    },
    {
      // Steam from the first sea entry: a boiling plume, with littoral explosions (bursts) that roar.
      engine: 'emitter',
      params: {
        particles: 3000, seaEntry: { stamp: 0 }, style: 'puff', shape: { type: 'disc', radius: 45 }, speed: [5, 12], spread: 30,
        gravity: 0, buoyancy: 3, buoyancyDecay: 20, drag: 0.25, turbulence: { spread: 5, wobble: 8, frequency: 0.12 },
        life: [14, 24], size: [18, 130], sizeCurve: 0.6, sizeJitter: 0.35, colors: [0xf6f6f4, 0xe8e9ea, 0xd2d5d7], opacity: 0.72,
        softness: 1.4, fadeOut: 1.4, fog: 0.6,
        bursts: { interval: [4, 11], count: [70, 150], speedScale: 2.6, minLevel: 0.2 },
        underglow: { color: 0xff6a2a, intensity: 1.6, height: 180, flicker: 0.3, night: 0.9 },
        light: { color: 0xff6a2a, intensity: 1.2e6, range: 1600, offset: [0, 30, 0], flicker: 0.3 },
        lod: { near: 1, mid: 0.5, far: 0.15 },
        soundTriggers: { burst: 'burst' }, sound: true,
      },
    },
    {
      // Steam from the second sea entry.
      engine: 'emitter',
      params: {
        particles: 2500, seaEntry: { stamp: 1 }, style: 'puff', shape: { type: 'disc', radius: 40 }, speed: [5, 11], spread: 30,
        gravity: 0, buoyancy: 3, buoyancyDecay: 20, drag: 0.25, turbulence: { spread: 5, wobble: 8, frequency: 0.12 },
        life: [14, 24], size: [16, 120], sizeCurve: 0.6, sizeJitter: 0.35, colors: [0xf6f6f4, 0xe8e9ea, 0xd2d5d7], opacity: 0.7,
        softness: 1.4, fadeOut: 1.4, fog: 0.6,
        bursts: { interval: [5, 13], count: [60, 130], speedScale: 2.4, minLevel: 0.2 },
        underglow: { color: 0xff6a2a, intensity: 1.4, height: 170, flicker: 0.3, night: 0.9 },
        lod: { near: 1, mid: 0.5, far: 0.15 },
        sound: false,
      },
    },
    {
      // Glowing spatter thrown up by the littoral explosions at the first entry.
      engine: 'emitter',
      params: {
        particles: 1024, seaEntry: { stamp: 0 }, style: 'spark', blend: 'additive', shape: { type: 'disc', radius: 30 }, speed: [12, 32],
        spread: 38, gravity: 1, drag: 0.06, windFollow: 0.1, life: [1.4, 3], size: [2.6, 1.2], stretch: 0.05,
        colors: [0xffdca0, 0xff6a20, 0x3a0c04], emissive: 6, emissiveDecay: 1.5, nightBoost: 0.6, fog: 0.5,
        rate: 0, bursts: { interval: [3, 8], count: [25, 60], minLevel: 0.2 }, lod: { near: 1, mid: 0.4, far: 0 },
        sound: false,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 20000 },
  lure: null,
  wind: [],
  audio: { recipe: 'geyser', params: { refDistance: 160 } },
  journal: { title: 'Lava rivers to the sea', description: 'Rivers of molten lava running down to the sea, flashing to steam where they pour in.' },
  discovery: { radius: 4000, requireInView: true },
  callouts: [
    'Lava running into the sea {direction}, {distance} off. See the steam?',
    'Steam plumes on the coast {direction}, {distance} out. Those are lava rivers meeting the water.',
    'The {name} is about {eta} away, {direction}. It glows best after dark.',
    'Keep out of the steam over the sea entry. It is full of acid and glass.',
  ],
  lifetime: { duration: null, despawn: { distance: 20000, hysteresis: 4000, outOfViewSeconds: 30 } },
});
