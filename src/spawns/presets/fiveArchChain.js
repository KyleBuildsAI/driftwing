// Preset 81: Five-arch chain (uncommon site; challenge). Five natural stone arches in the v1 style
// stand in a line along a level valley floor, 260 m apart, their strata glowing in the low sun: thread
// all five against the clock. The challenge system's start gate fills the first arch, the middle three
// take the splits and the last is the finish, with bronze, silver and gold times and a best time per
// craft (a missed arch costs 5 s). The wind moans through the stone, louder as it rises; every crown
// is a perch. Docs: docs/engines/structure.md (archChain, challengeGates).
import { structureStamps } from '../engines/structure/stamps.js';

/** The five arch gates: 260 m apart along the site heading, each centred 21 m above the floor. */
const ARCH_GATE = Object.freeze({ height: 21, shape: 'rect', halfWidth: 18, halfHeight: 15 });

export default Object.freeze({
  id: 'fiveArchChain',
  name: 'Five-arch chain',
  category: 'flightplay',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['challenge', 'perch', 'spectacle'],
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['meadows', 'dunes', 'pine'],
    surface: 'land',
    terrain: { minHeight: 15, maxHeight: 600, relief: 'flat' },
    clearance: 600,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  // A level, unpainted floor 1.2-1.3 km long under the chain (structureStamps' archChain sizes).
  stamps: structureStamps('archChain'),
  engines: [
    // The arches (one around each gate below) and the wind in them.
    { engine: 'structure', params: { recipe: 'archChain', audioIntensity: 'wind', voice: true } },
    // The timed course through the openings: no frames, the stone is the gate.
    { engine: 'structure', params: { recipe: 'challengeGates', frames: false, voice: false } },
  ],
  challenge: {
    name: 'Five-Arch Chain',
    gates: [
      { id: 'arch1', role: 'start', along: -520, ...ARCH_GATE },
      { id: 'arch2', role: 'checkpoint', along: -260, ...ARCH_GATE },
      { id: 'arch3', role: 'checkpoint', along: 0, ...ARCH_GATE },
      { id: 'arch4', role: 'checkpoint', along: 260, ...ARCH_GATE },
      { id: 'arch5', role: 'finish', along: 520, ...ARCH_GATE },
    ],
    medals: { gold: 18, silver: 25, bronze: 36 },
    missed: { mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 150 },
    start: { mode: 'gate', promptRadius: 1500 },
    abandonDistance: 3000,
    teleportDistance: 400,
  },
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'stoneWind', params: { pitch: 0.8 } },
  journal: {
    title: 'Five-Arch Chain',
    description: 'Five stone arches in a row across a quiet valley floor: thread them all, in order, and beat the clock.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Five stone arches in a line, {distance} {direction}. A timed run through all of them.',
    'I see the {name} {direction}. Line up on the first arch and the clock starts.',
    'The {name} is about {eta} away, {direction}. Gold is under eighteen seconds.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
