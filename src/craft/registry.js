// Craft registry: the catalog of flyable craft and the modules that implement them.
//
// The catalog (ids, names, picker groups and silhouettes) is fixed data the UI can show before any
// craft module loads. Each craft module (src/craft/<id>.js) registers itself with register(); a
// craft is available once its module is registered. A catalog craft without a module stays visible
// but disabled. Adding a craft is one catalog entry (already here for the 14 craft of Phase 3), one
// module file and one line in src/craft/index.js (docs/architecture.md, "How to add a craft").
//
// The catalog is append-only: settings, bindings and journal records key on the ids, so an id
// never changes meaning. hotkey is informational (the Phase 1 number keys); the number keys are the
// player's ten favorites (settings.craftFavorites, actions craftSelect1-10).

/**
 * Picker silhouettes are top views, nose up, in a 64 x 64 box (the balloon is drawn from the side:
 * from above it is a plain circle). Each part is filled or stroked with currentColor so the UI can
 * tint them.
 */
export const CRAFT_CATALOG = Object.freeze([
  Object.freeze({
    id: 'glider',
    name: 'Glider',
    role: 'Sailplane',
    group: 'planes',
    hotkey: 'Digit1',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M31 7 L33 7 L34 25 L62 27.5 L62 29.5 L34 30 L33 50 L40 53 L40 55 L24 55 L24 53 L31 50 L30 30 L2 29.5 L2 27.5 L30 25 Z' },
    ]),
  }),
  Object.freeze({
    id: 'bushplane',
    name: 'Bush plane',
    role: 'Backcountry taildragger',
    group: 'planes',
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
    group: 'planes',
    hotkey: 'Digit3',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 3 L35 17 L36 29 L58 45 L58 50 L37 46 L38 54 L44 58 L44 60 L20 60 L20 58 L26 54 L27 46 L6 50 L6 45 L28 29 L29 17 Z' },
    ]),
  }),
  Object.freeze({
    id: 'helicopter',
    name: 'Helicopter',
    role: 'Light utility',
    group: 'rotor',
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
    group: 'human',
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
    group: 'rotor',
    hotkey: 'Digit6',
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M21 18 L32 27 L43 18 L46 21 L37 32 L46 43 L43 46 L32 37 L21 46 L18 43 L27 32 L18 21 Z' },
      { mode: 'stroke', d: 'M11 19 A8 8 0 1 0 27 19 A8 8 0 1 0 11 19 M37 19 A8 8 0 1 0 53 19 A8 8 0 1 0 37 19 M11 45 A8 8 0 1 0 27 45 A8 8 0 1 0 11 45 M37 45 A8 8 0 1 0 53 45 A8 8 0 1 0 37 45' },
    ]),
  }),
  // ---- Phase 3 (contract h.1): each becomes available when its module registers ----------------
  Object.freeze({
    id: 'aerobatic',
    name: 'Aerobatic',
    role: 'Unlimited aerobatic monoplane',
    group: 'planes',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M30 7 L34 7 L35 14 L36 21 L60 23 L60 30 L36 31 L35 46 L45 49 L45 54 L19 54 L19 49 L29 46 L28 31 L4 30 L4 23 L28 21 L29 14 Z' },
      { mode: 'stroke', d: 'M21 5 L43 5' },
    ]),
  }),
  Object.freeze({
    id: 'seaplane',
    name: 'Seaplane',
    role: 'Amphibious floatplane',
    group: 'planes',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M29 10 L35 10 L36 20 L60 21 L60 28 L36 28 L34 46 L43 48 L43 53 L21 53 L21 48 L30 46 L28 28 L4 28 L4 21 L28 20 Z' },
      { mode: 'fill', d: 'M17 12 Q19.5 7 22 12 L22 42 L17 42 Z M42 12 Q44.5 7 47 12 L47 42 L42 42 Z' },
      { mode: 'stroke', d: 'M24 7 L40 7' },
    ]),
  }),
  Object.freeze({
    id: 'tiltrotor',
    name: 'Tiltrotor',
    role: 'VTOL proprotor transport',
    group: 'rotor',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M29 8 Q32 3 35 8 L36 48 L45 51 L45 55 L19 55 L19 51 L28 48 Z' },
      { mode: 'fill', d: 'M10 23 L54 23 L54 29 L10 29 Z M5 19 L11 19 L11 33 L5 33 Z M53 19 L59 19 L59 33 L53 33 Z' },
      { mode: 'stroke', d: 'M0 26 A8 8 0 1 0 16 26 A8 8 0 1 0 0 26 M48 26 A8 8 0 1 0 64 26 A8 8 0 1 0 48 26' },
    ]),
  }),
  Object.freeze({
    id: 'paraglider',
    name: 'Paraglider',
    role: 'Foot-launched canopy',
    group: 'human',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M3 25 Q32 9 61 25 L59 31 Q32 17 5 31 Z' },
      { mode: 'stroke', d: 'M9 29 L30 44 M55 29 L34 44 M20 23 L31 44 M44 23 L33 44' },
      { mode: 'fill', d: 'M29 43 L35 43 L34.5 54 L29.5 54 Z' },
    ]),
  }),
  Object.freeze({
    id: 'balloon',
    name: 'Hot air balloon',
    role: 'Burner and envelope',
    group: 'lighterThanAir',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 3 C47 3 56 14 56 25 C56 35 47 41 40 47 L24 47 C17 41 8 35 8 25 C8 14 17 3 32 3 Z' },
      { mode: 'stroke', d: 'M25 47 L28 53 M39 47 L36 53' },
      { mode: 'fill', d: 'M27 53 L37 53 L36 60 L28 60 Z' },
    ]),
  }),
  Object.freeze({
    id: 'airship',
    name: 'Airship',
    role: 'Scenic cruiser',
    group: 'lighterThanAir',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 3 C42 3 45 17 45 31 C45 45 41 55 32 57 C23 55 19 45 19 31 C19 17 22 3 32 3 Z' },
      { mode: 'fill', d: 'M23 46 L12 59 L24 55 Z M41 46 L52 59 L40 55 Z' },
      { mode: 'stroke', d: 'M12 30 L19 30 M45 30 L52 30' },
    ]),
  }),
  Object.freeze({
    id: 'eagle',
    name: 'Eagle / Dragon',
    role: 'Soaring creature',
    group: 'creature',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 6 L35 10 L35 21 L46 17 L58 19 L63 25 L56 25 L59 28 L51 27 L53 30 L44 30 L36 32 L36 42 L42 52 L32 49 L22 52 L28 42 L28 32 L20 30 L11 30 L13 27 L5 28 L8 25 L1 25 L6 19 L18 17 L29 21 L29 10 Z' },
    ]),
  }),
  Object.freeze({
    id: 'spaceplane',
    name: 'Spaceplane',
    role: 'Suborbital rocket plane',
    group: 'space',
    hotkey: null,
    silhouette: Object.freeze([
      { mode: 'fill', d: 'M32 2 L35 14 L37 30 L56 51 L56 56 L38 54 L37 59 L27 59 L26 54 L8 56 L8 51 L27 30 L29 14 Z' },
    ]),
  }),
]);

/** The picker groups (contract h.1), in picker order, each with its craft in order. */
export const CRAFT_GROUPS = Object.freeze({
  planes: Object.freeze(['glider', 'bushplane', 'aerobatic', 'seaplane', 'jet']),
  rotor: Object.freeze(['helicopter', 'tiltrotor', 'fpv']),
  human: Object.freeze(['wingsuit', 'paraglider']),
  lighterThanAir: Object.freeze(['balloon', 'airship']),
  creature: Object.freeze(['eagle']),
  space: Object.freeze(['spaceplane']),
});
export const CRAFT_GROUP_LABELS = Object.freeze({
  planes: 'Planes',
  rotor: 'Rotor',
  human: 'Human',
  lighterThanAir: 'Lighter than air',
  creature: 'Creature',
  space: 'Space',
});

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

/** inputProfile values the controller and the models understand (contract h.2 adds the Phase 3 ones). */
export const INPUT_PROFILE_VALUES = Object.freeze({
  throttle: Object.freeze(['throttle', 'none', 'collective', 'thrust', 'burner', 'flapPower', 'speedBar', 'rocket']),
  antenna: Object.freeze(['flaps', 'zoom', 'nacelle', 'ballonet']),
  toeBrakes: Object.freeze(['wheels', 'wheelsAndSpoilers', 'canopyToggles', 'none', 'waterRudders', 'paragliderBrakes']),
  rocker: Object.freeze(['trim', 'vector']),
  stickX: Object.freeze(['roll', 'weightShift', 'rotationVents']),
});
/** The ability slots a module may fill: craftAbility (Space) and craftAbilityAlt (Shift+Space). */
export const ABILITY_SLOTS = Object.freeze(['craftAbility', 'craftAbilityAlt']);
/** Cockpit styles built by src/camera/cockpit.js; 'custom' calls the module's cockpit.build(). */
export const COCKPIT_STYLE_IDS = Object.freeze(['canopy', 'cabin', 'bubble', 'open', 'none', 'custom']);
export const WATER_LANDINGS = Object.freeze(['floats', 'basket']);
const JOURNAL_OPS = Object.freeze(['add', 'min', 'max']);
const ID_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
const STAT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

/** Throws a readable error for a module field that breaks the contract. */
function fail(module, field, problem) {
  throw new Error(`craft "${module.id}" ${field}: ${problem}`);
}

function validateAbilities(module) {
  const abilities = module.abilities;
  for (const slot of Object.keys(abilities)) {
    if (!ABILITY_SLOTS.includes(slot)) fail(module, 'abilities', `unknown slot "${slot}" (slots: ${ABILITY_SLOTS.join(', ')})`);
    const ability = abilities[slot];
    if (!isPlainObject(ability)) fail(module, `abilities.${slot}`, 'must be an object');
    if (typeof ability.run !== 'function' && typeof ability.update !== 'function') fail(module, `abilities.${slot}`, 'needs run(api) or update(api, dt)');
    if (ability.label !== undefined && typeof ability.label !== 'string') fail(module, `abilities.${slot}.label`, 'must be a string');
    if (ability.initialState !== undefined && typeof ability.initialState !== 'function') fail(module, `abilities.${slot}.initialState`, 'must be a function');
  }
}

function validateInputProfile(module) {
  for (const [field, allowed] of Object.entries(INPUT_PROFILE_VALUES)) {
    const value = module.inputProfile[field];
    if (value !== undefined && !allowed.includes(value)) fail(module, `inputProfile.${field}`, `"${value}" is not one of ${allowed.join(', ')}`);
  }
}

function validateLimits(module) {
  const limits = module.limits;
  if (limits.ceiling !== undefined && !(Number.isFinite(limits.ceiling) && limits.ceiling > 0)) fail(module, 'limits.ceiling', 'must be a positive number of metres');
  if (limits.waterLanding !== undefined && limits.waterLanding !== null && !WATER_LANDINGS.includes(limits.waterLanding)) {
    fail(module, 'limits.waterLanding', `"${limits.waterLanding}" is not one of ${WATER_LANDINGS.join(', ')} or null`);
  }
  for (const field of ['noseOverSpeed', 'skidCrashSpeed', 'bodyStrikeSpeed']) {
    if (limits[field] !== undefined && !(Number.isFinite(limits[field]) && limits[field] > 0)) fail(module, `limits.${field}`, 'must be a positive speed (m/s)');
  }
}

function validateCockpit(module) {
  const cockpit = module.cameraRig.cockpit;
  if (cockpit === undefined || cockpit === null) return;
  if (!isPlainObject(cockpit)) fail(module, 'cameraRig.cockpit', 'must be an object');
  if (cockpit.style !== undefined && !COCKPIT_STYLE_IDS.includes(cockpit.style)) fail(module, 'cameraRig.cockpit.style', `"${cockpit.style}" is not one of ${COCKPIT_STYLE_IDS.join(', ')}`);
  if (cockpit.style === 'custom' && typeof cockpit.build !== 'function') fail(module, 'cameraRig.cockpit.build', "style 'custom' needs build(builder, spec, THREE)");
}

function validateSkins(module) {
  const skins = module.skins;
  if (!isPlainObject(skins) || !Array.isArray(skins.list) || skins.list.length === 0) fail(module, 'skins', '{ default, list: [{ id, name, silhouette? }] } with at least one skin');
  const ids = new Set();
  for (const skin of skins.list) {
    if (!isPlainObject(skin) || !ID_PATTERN.test(skin.id ?? '') || typeof skin.name !== 'string') fail(module, 'skins.list', 'every skin needs an id (camelCase) and a name');
    if (ids.has(skin.id)) fail(module, 'skins.list', `skin "${skin.id}" is listed twice`);
    if (skin.silhouette !== undefined && !Array.isArray(skin.silhouette)) fail(module, `skins.${skin.id}.silhouette`, 'must be a silhouette part list');
    ids.add(skin.id);
  }
  if (!ids.has(skins.default)) fail(module, 'skins.default', `"${skins.default}" is not in the list`);
}

function validateBindings(module) {
  if (!isPlainObject(module.bindings)) fail(module, 'bindings', 'must be { [profile]: { actions?, axes? } }');
  for (const [profile, layer] of Object.entries(module.bindings)) {
    if (!isPlainObject(layer)) fail(module, `bindings.${profile}`, 'must be { actions?, axes? }');
    for (const kind of ['actions', 'axes']) {
      if (layer[kind] === undefined) continue;
      if (!isPlainObject(layer[kind])) fail(module, `bindings.${profile}.${kind}`, 'must map targets to reference lists');
      for (const [target, refs] of Object.entries(layer[kind])) {
        if (!Array.isArray(refs)) fail(module, `bindings.${profile}.${kind}.${target}`, 'must be a list of references');
      }
    }
  }
}

function validateCollision(module) {
  const probes = module.collision?.probes;
  if (!Array.isArray(probes) || probes.length === 0) fail(module, 'collision', '{ probes: [{ id, position: [x, y, z], radius, gear? }] }');
  for (const probe of probes) {
    if (!isPlainObject(probe) || !isVector3(probe.position) || !(probe.radius > 0)) fail(module, 'collision.probes', 'every probe needs a position [x, y, z] and a radius > 0');
  }
}

function validateCopilot(module) {
  const copilot = module.copilot;
  if (!isPlainObject(copilot)) fail(module, 'copilot', 'must be { commands?, status? }');
  if (copilot.status !== undefined && typeof copilot.status !== 'function') fail(module, 'copilot.status', 'must be status(craftState, telemetry) -> string');
  if (copilot.commands === undefined) return;
  if (!Array.isArray(copilot.commands)) fail(module, 'copilot.commands', 'must be a list');
  const ids = new Set();
  for (const command of copilot.commands) {
    if (!isPlainObject(command) || !ID_PATTERN.test(command.id ?? '')) fail(module, 'copilot.commands', 'every command needs a camelCase id');
    if (ids.has(command.id)) fail(module, 'copilot.commands', `command "${command.id}" is listed twice`);
    ids.add(command.id);
    if (typeof command.run !== 'function') fail(module, `copilot.commands.${command.id}`, 'needs run(api, value) -> reply');
    if (!Array.isArray(command.phrases) || command.phrases.length === 0) fail(module, `copilot.commands.${command.id}.phrases`, 'needs at least one regex source');
    for (const phrase of command.phrases) {
      if (typeof phrase !== 'string') fail(module, `copilot.commands.${command.id}.phrases`, 'every phrase is a regex source string');
      try {
        new RegExp(phrase);
      } catch (error) {
        fail(module, `copilot.commands.${command.id}.phrases`, `"${phrase}" is not a valid regex (${error.message})`);
      }
    }
  }
}

function validateJournal(module) {
  const stats = module.journal?.stats;
  if (!Array.isArray(stats)) fail(module, 'journal', '{ stats: [{ key, label, unit, op }] }');
  for (const stat of stats) {
    if (!isPlainObject(stat) || !STAT_KEY_PATTERN.test(stat.key ?? '')) fail(module, 'journal.stats', 'every stat needs a camelCase key');
    if (typeof stat.label !== 'string' || typeof stat.unit !== 'string') fail(module, `journal.stats.${stat.key}`, 'needs a label and a unit');
    if (!JOURNAL_OPS.includes(stat.op)) fail(module, `journal.stats.${stat.key}.op`, `"${stat.op}" is not one of ${JOURNAL_OPS.join(', ')}`);
  }
}

function validateFavor(module, field, favor) {
  if (!isPlainObject(favor)) fail(module, field, 'must be { tags?, categories? }');
  for (const kind of ['tags', 'categories']) {
    if (favor[kind] === undefined) continue;
    if (!isPlainObject(favor[kind])) fail(module, `${field}.${kind}`, 'must map names to weights');
    for (const [name, weight] of Object.entries(favor[kind])) {
      if (!(Number.isFinite(weight) && weight > 0)) fail(module, `${field}.${kind}.${name}`, 'must be a positive weight');
    }
  }
}

function validateDirectorProfile(module) {
  const profile = module.directorProfile;
  if (!isPlainObject(profile)) fail(module, 'directorProfile', 'must be { favor?, above? }');
  if (profile.favor !== undefined) validateFavor(module, 'directorProfile.favor', profile.favor);
  if (profile.above === undefined) return;
  if (!Array.isArray(profile.above)) fail(module, 'directorProfile.above', 'must be a list of { altitude, favor }');
  profile.above.forEach((band, index) => {
    if (!isPlainObject(band) || !Number.isFinite(band.altitude)) fail(module, `directorProfile.above[${index}]`, 'needs an altitude (m)');
    validateFavor(module, `directorProfile.above[${index}].favor`, band.favor);
  });
}

function validateCapabilities(module) {
  if (!isPlainObject(module.capabilities)) fail(module, 'capabilities', 'must be an object of booleans');
  for (const [name, value] of Object.entries(module.capabilities)) {
    if (typeof value !== 'boolean') fail(module, `capabilities.${name}`, 'must be a boolean');
  }
}

/** The optional fields of contract h.2, checked when present. Throws on the first problem. */
function validateOptionalFields(module) {
  validateAbilities(module);
  validateInputProfile(module);
  validateLimits(module);
  validateCockpit(module);
  if (module.skins !== undefined) validateSkins(module);
  if (module.bindings !== undefined) validateBindings(module);
  if (module.collision !== undefined) validateCollision(module);
  if (module.situate !== undefined && typeof module.situate !== 'function') fail(module, 'situate', 'must be situate(situation, api) -> placement');
  if (module.copilot !== undefined) validateCopilot(module);
  if (module.journal !== undefined) validateJournal(module);
  if (module.directorProfile !== undefined) validateDirectorProfile(module);
  if (module.faunaThreat !== undefined && !(Number.isFinite(module.faunaThreat) && module.faunaThreat > 0)) fail(module, 'faunaThreat', 'must be a positive number');
  if (module.capabilities !== undefined) validateCapabilities(module);
  if (typeof module.audioProfile.engine !== 'string') fail(module, 'audioProfile.engine', 'must name an audio engine family');
}

/**
 * A craft registry over a catalog (the game's CRAFT_CATALOG and CRAFT_GROUPS by default; the labs
 * build one over a fixture catalog).
 */
export function createCraftRegistry(catalog = CRAFT_CATALOG, groups = CRAFT_GROUPS, groupLabels = CRAFT_GROUP_LABELS) {
  const modules = new Map();
  const catalogIds = catalog.map((entry) => entry.id);
  for (const entry of catalog) {
    if (!Object.prototype.hasOwnProperty.call(groups, entry.group) || !groups[entry.group].includes(entry.id)) {
      throw new Error(`craft catalog entry "${entry.id}" is not listed in its group "${entry.group}"`);
    }
  }

  return {
    catalog,

    /** Registers a craft module. Throws when it is not in the catalog or breaks the module contract. */
    register(module) {
      if (!module || !catalogIds.includes(module.id)) throw new Error(`craft "${module && module.id}" is not in the catalog`);
      for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
        if (typeof module[field] !== type || module[field] === null) throw new Error(`craft "${module.id}" is missing ${field} (${type})`);
      }
      if (!Array.isArray(module.instruments)) throw new Error(`craft "${module.id}" instruments must be an array`);
      validateOptionalFields(module);
      modules.set(module.id, module);
      return module;
    },

    get(id) {
      return modules.get(id) ?? null;
    },

    has(id) {
      return modules.has(id);
    },

    /** The catalog entry for an id, or null. */
    entry(id) {
      return catalog.find((entry) => entry.id === id) ?? null;
    },

    /** Catalog entries in order, each with available: true once its module is registered. */
    list() {
      return catalog.map((entry) => ({ ...entry, available: modules.has(entry.id) }));
    },

    /** The picker groups in order: [{ id, label, craft: [catalog entries with available] }]. */
    groups() {
      return Object.entries(groups).map(([id, ids]) => ({
        id,
        label: groupLabels[id] ?? id,
        craft: ids.map((craftId) => catalog.find((entry) => entry.id === craftId)).filter(Boolean).map((entry) => ({ ...entry, available: modules.has(entry.id) })),
      }));
    },

    /** The next (direction 1) or previous (-1) available craft after id in catalog order, wrapping around. */
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
