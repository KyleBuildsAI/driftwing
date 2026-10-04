// Vegetation species: the Phase 1 scatter types (ids 0-5, unchanged) and the Phase 3 species that
// grow only inside region overlays (ids 6-12, contract section d.3).
//
// Worldgen's scatter draws the overlay species, the chunk builder sizes and tints them, the terrain
// system builds one instanced mesh per type and sways it from the WindField (windSway.js), and the
// vegetation collider provider puts a cylinder around every trunk that has one (vegetationColliders.js).
//
// Entry fields:
//   id, name
//   height    [min, max] metres of a grown plant; the scatter scale is height / referenceHeight
//   referenceHeight  the height (m) of the base geometry at scale 1 (terrain.js builds it that tall)
//   trunk     { radius, height } at scale 1 (m), the collider cylinder from the base, or null
//   perch     true: the top of the plant is an eagle perch point
//   sway      { stiffness, gust }: stiffness scales the bend per metre of height squared (as the
//             Phase 1 types' sway), gust how much of the WindField's gusts and turbulence it adds
//   sink      share of the scaled height planted below the ground (roots on slopes)
//   rows      true: planted in rows along an overlay's stripes (lavender, tulips), turned to them
//   waterline null, or metres above sea level it may grow down to inside its overlay (mangroves)
//   tints     per biome (snow, pine, dunes, archipelago, meadows): sRGB hex variants of the tintable
//             parts (foliage, petals); rows take their stripe's colour instead
//
// Pure data: no imports, no DOM (the terrain worker reads it).

/** The Phase 1 scatter types (worldgen VEGETATION), ids 0-5. */
export const BASE_VEGETATION = Object.freeze({ PINE: 0, BROADLEAF: 1, PALM: 2, ROCK: 3, CACTUS: 4, FLOWERS: 5 });

export const VEGETATION_SPECIES = Object.freeze([
  Object.freeze({
    id: 6,
    name: 'cherry',
    height: Object.freeze([6.5, 10]),
    referenceHeight: 8.2,
    trunk: null,
    perch: false,
    sway: Object.freeze({ stiffness: 0.0026, gust: 0.8 }),
    sink: 0.2,
    rows: false,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0xf2b8c9, 0xf6c9d5]),
      Object.freeze([0xf0aec2, 0xf7cbd8, 0xe99bb4]),
      Object.freeze([0xf4bfcf]),
      Object.freeze([0xef9fba, 0xf6c3d3]),
      Object.freeze([0xf2b3c6, 0xf8d4de, 0xeb9db6, 0xfbe3ea]),
    ]),
  }),
  Object.freeze({
    id: 7,
    name: 'redwood',
    height: Object.freeze([60, 110]),
    referenceHeight: 85,
    trunk: Object.freeze({ radius: 2.7, height: 70 }),
    perch: true,
    sway: Object.freeze({ stiffness: 0.00011, gust: 0.4 }),
    sink: 0.02,
    rows: false,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0x2d4a34, 0x34523a]),
      Object.freeze([0x2f5a35, 0x3a6a3e, 0x284f30]),
      Object.freeze([0x3d5c36]),
      Object.freeze([0x2f6238, 0x3b7040]),
      Object.freeze([0x35603a, 0x41703f]),
    ]),
  }),
  Object.freeze({
    id: 8,
    name: 'bamboo',
    height: Object.freeze([10, 16]),
    referenceHeight: 13,
    trunk: null,
    perch: false,
    sway: Object.freeze({ stiffness: 0.0065, gust: 1.6 }),
    sink: 0.04,
    rows: false,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0x6f9a4a]),
      Object.freeze([0x6e9c45, 0x82ad52, 0x5f8a3e]),
      Object.freeze([0x8aa652]),
      Object.freeze([0x6aa046, 0x7fb456, 0x5c9040]),
      Object.freeze([0x78a64c, 0x8cb658]),
    ]),
  }),
  Object.freeze({
    id: 9,
    name: 'saguaro',
    height: Object.freeze([7, 13]),
    referenceHeight: 10,
    trunk: null,
    perch: true,
    sway: Object.freeze({ stiffness: 0, gust: 0 }),
    sink: 0.03,
    rows: false,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0x55784a]),
      Object.freeze([0x52784a]),
      Object.freeze([0x5a8048, 0x4f7444, 0x668a50]),
      Object.freeze([0x50804a]),
      Object.freeze([0x5a8448]),
    ]),
  }),
  Object.freeze({
    id: 10,
    name: 'mangrove',
    height: Object.freeze([6, 10]),
    referenceHeight: 8,
    trunk: null,
    perch: false,
    sway: Object.freeze({ stiffness: 0.0018, gust: 0.6 }),
    sink: 0,
    rows: false,
    waterline: -1.5,
    tints: Object.freeze([
      Object.freeze([0x3f6a3a]),
      Object.freeze([0x3d6b3a, 0x4a7a42]),
      Object.freeze([0x4f7440]),
      Object.freeze([0x356e3c, 0x417c44, 0x2f603a]),
      Object.freeze([0x467640]),
    ]),
  }),
  Object.freeze({
    id: 11,
    name: 'lavender',
    height: Object.freeze([0.7, 1.1]),
    referenceHeight: 0.9,
    trunk: null,
    perch: false,
    sway: Object.freeze({ stiffness: 0.05, gust: 1.2 }),
    sink: 0.1,
    rows: true,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0x9b7fd0]),
      Object.freeze([0x9479c8, 0xa48bd8]),
      Object.freeze([0x9f84d2]),
      Object.freeze([0x8f74c4]),
      Object.freeze([0x9b7fd0, 0xa58fd8, 0x8b6fc0]),
    ]),
  }),
  Object.freeze({
    id: 12,
    name: 'tulip',
    height: Object.freeze([0.45, 0.65]),
    referenceHeight: 0.55,
    trunk: null,
    perch: false,
    sway: Object.freeze({ stiffness: 0.07, gust: 1.4 }),
    sink: 0.05,
    rows: true,
    waterline: null,
    tints: Object.freeze([
      Object.freeze([0xd8443a]),
      Object.freeze([0xd8443a, 0xf2c94c]),
      Object.freeze([0xe05a3c]),
      Object.freeze([0xd8443a, 0xf08ab0]),
      Object.freeze([0xd8443a, 0xf2c94c, 0xf08ab0, 0xf6efe2]),
    ]),
  }),
]);

/** Every scatter type id by name: the Phase 1 types and the species. */
export const VEGETATION_IDS = Object.freeze({
  ...BASE_VEGETATION,
  CHERRY: 6, REDWOOD: 7, BAMBOO: 8, SAGUARO: 9, MANGROVE: 10, LAVENDER: 11, TULIP: 12,
});

/** Scatter types in all (the chunk builder's header and the terrain's instanced meshes). */
export const VEGETATION_TYPE_COUNT = 6 + VEGETATION_SPECIES.length;

const BY_NAME = new Map(VEGETATION_SPECIES.map((species) => [species.name, species]));

/** The species entry for a name ('cherry', ...), or null. */
export function speciesByName(name) {
  return BY_NAME.get(name) ?? null;
}

/** The species entry for a type id (6-12), or null (the Phase 1 types have none). */
export function speciesById(id) {
  return id >= 6 && id < VEGETATION_TYPE_COUNT ? VEGETATION_SPECIES[id - 6] : null;
}

/** The species names an overlay may list. */
export const SPECIES_NAMES = Object.freeze(VEGETATION_SPECIES.map((species) => species.name));
