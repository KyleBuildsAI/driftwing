// Craft registry: the catalog of flyable craft and the modules that implement them.
//
// The catalog (ids, names, picker silhouettes, number keys) is fixed data the UI can show before
// any craft module loads. Each craft module (src/craft/<id>.js) registers itself with register();
// a craft is available once its module is registered. Later phases add craft by appending to the
// catalog and registering a module; nothing else changes.

/**
 * Picker silhouettes are top views, nose up, in a 64 x 64 box. Each part is filled or stroked
 * with currentColor so the UI can tint them.
 */
export const CRAFT_CATALOG = Object.freeze([
  Object.freeze({
    id: 'glider',
    name: 'Glider',
    role: 'Sailplane',
    hotkey: 'Digit1',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M31 7 L33 7 L34 25 L62 27.5 L62 29.5 L34 30 L33 50 L40 53 L40 55 L24 55 L24 53 L31 50 L30 30 L2 29.5 L2 27.5 L30 25 Z' },
    ]),
  }),
  Object.freeze({
    id: 'bushplane',
    name: 'Bush plane',
    role: 'Backcountry taildragger',
    hotkey: 'Digit2',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M29 9 L35 9 L36 20 L58 21 L58 28 L36 28 L34 46 L43 48 L43 53 L21 53 L21 48 L30 46 L28 28 L6 28 L6 21 L28 20 Z' },
      { mode: 'fill', d: 'M23 6 L41 6 L41 8 L23 8 Z' },
    ]),
  }),
  Object.freeze({
    id: 'jet',
    name: 'Jet',
    role: 'Supersonic fighter',
    hotkey: 'Digit3',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 3 L35 17 L36 29 L58 45 L58 50 L37 46 L38 54 L44 58 L44 60 L20 60 L20 58 L26 54 L27 46 L6 50 L6 45 L28 29 L29 17 Z' },
    ]),
  }),
  Object.freeze({
    id: 'helicopter',
    name: 'Helicopter',
    role: 'Light utility',
    hotkey: 'Digit4',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M27 22 Q32 11 37 22 L37 34 Q32 40 27 34 Z' },
      { mode: 'fill', d: 'M31 36 L33 36 L33 55 L38 55 L38 58 L26 58 L26 55 L31 55 Z' },
      { mode: 'stroke', d: 'M9 9 L55 55 M55 9 L9 55' },
    ]),
  }),
  Object.freeze({
    id: 'wingsuit',
    name: 'Wingsuit',
    role: 'Proximity flyer',
    hotkey: 'Digit5',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M30 5 L34 5 L35.5 9 L33.5 12 L30.5 12 L28.5 9 Z' },
      { mode: 'fill', d: 'M29 13 L35 13 L51 26 L47 33 L36 30 L37 44 L42 58 L36 58 L32 47 L28 58 L22 58 L27 44 L28 30 L17 33 L13 26 Z' },
    ]),
  }),
  Object.freeze({
    id: 'fpv',
    name: 'FPV drone',
    role: '5-inch racing quad',
    hotkey: 'Digit6',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M21 18 L32 27 L43 18 L46 21 L37 32 L46 43 L43 46 L32 37 L21 46 L18 43 L27 32 L18 21 Z' },
      { mode: 'stroke', d: 'M11 19 A8 8 0 1 0 27 19 A8 8 0 1 0 11 19 M37 19 A8 8 0 1 0 53 19 A8 8 0 1 0 37 19 M11 45 A8 8 0 1 0 27 45 A8 8 0 1 0 11 45 M37 45 A8 8 0 1 0 53 45 A8 8 0 1 0 37 45' },
    ]),
  }),
]);

/** Fields every craft module must provide (see docs/architecture.md, "Craft modules"). */
const REQUIRED_FIELDS = Object.freeze({
  buildMesh: 'function',
  simProfile: 'object',
  inputProfile: 'object',
  audioProfile: 'object',
  cameraRig: 'object',
  instruments: 'object',
  abilities: 'object',
  spawn: 'object',
  limits: 'object',
});

function createCraftRegistry() {
  const modules = new Map();
  const catalogIds = CRAFT_CATALOG.map((entry) => entry.id);

  return {
    catalog: CRAFT_CATALOG,

    /** Registers a craft module. Throws when it is not in the catalog or misses a required field. */
    register(module) {
      if (!module || !catalogIds.includes(module.id)) throw new Error(`craft "${module && module.id}" is not in the catalog`);
      for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
        if (typeof module[field] !== type || module[field] === null) throw new Error(`craft "${module.id}" is missing ${field} (${type})`);
      }
      if (!Array.isArray(module.instruments)) throw new Error(`craft "${module.id}" instruments must be an array`);
      modules.set(module.id, module);
      return module;
    },

    get(id) {
      return modules.get(id) ?? null;
    },

    has(id) {
      return modules.has(id);
    },

    /** Catalog entries in order, each with available: true once its module is registered. */
    list() {
      return CRAFT_CATALOG.map((entry) => ({ ...entry, available: modules.has(entry.id) }));
    },

    /** The next (direction 1) or previous (-1) available craft after id, wrapping around. */
    step(id, direction) {
      const available = catalogIds.filter((catalogId) => modules.has(catalogId));
      if (available.length === 0) return null;
      const index = available.indexOf(id);
      if (index < 0) return available[0];
      return available[(index + (direction < 0 ? available.length - 1 : 1)) % available.length];
    },
  };
}

export const craftRegistry = createCraftRegistry();
