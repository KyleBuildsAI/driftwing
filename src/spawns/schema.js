// Spawn preset validator (contract section 1). Pure: no imports, so the labs, the terrain worker
// and the main thread can all use it.
//
// validatePreset(preset, options) throws an Error naming the preset and the field at fault, for
// example: [DRIFTWING] preset "tornado": field "lod.mid" must be greater than lod.near (1500), got 900.
// validatePresets(list, options) validates each preset and also checks the ids are unique.
// options.engineNames (optional): the registered engine names; an engine entry naming any other
// engine is refused. Main runs it at startup in dev builds; the labs run it too.

export const PRESET_CATEGORIES = Object.freeze(['weather', 'geo', 'ocean', 'wildlife', 'structure', 'celestial', 'fantasy', 'flightplay', 'setpiece']);
export const PRESET_KINDS = Object.freeze(['site', 'event']);
export const PRESET_RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'legendary']);
export const PRESET_SURFACES = Object.freeze(['land', 'water', 'coast', 'any']);
export const TERRAIN_RELIEFS = Object.freeze(['peak', 'valley', 'flat', 'ridge', 'any']);
/** placement.align: how placement.js orients a site (see ALIGNMENTS there). */
export const PLACEMENT_ALIGNMENTS = Object.freeze(['random', 'downhill', 'ridge']);
/** Time-of-day classes a preset may be limited to (filters.timeOfDay). */
export const TIME_OF_DAY_CLASSES = Object.freeze(['dawn', 'day', 'golden', 'dusk', 'night']);
export const WEATHER_STATE_NAMES = Object.freeze(['clear', 'building', 'storm', 'clearing']);
export const STAMP_TYPES = Object.freeze(['cone', 'carve', 'cliffStep', 'gorge', 'flatten', 'islandBase']);
export const STAMP_PAINTS = Object.freeze(['ash', 'basalt', 'wetRock', 'tarmac', 'riverbed']);
/** FAR lure silhouettes drawn by src/spawns/lure.js. */
export const LURE_TYPES = Object.freeze(['plume', 'anvil', 'funnel', 'whale', 'islands', 'comet']);
/** How the SpawnManager may move an activation before the engines see it (preset.anchor). */
export const ANCHOR_SEEKS = Object.freeze(['peak']);
export const ANCHOR_ALIGNS = Object.freeze(['downwind']);
/** Tokens a callout line may use; they are filled in when the line is spoken. */
export const CALLOUT_TOKENS = Object.freeze(['distance', 'direction', 'name', 'eta']);
/** Every top-level preset field. Anything else is a typo and is refused. */
export const PRESET_FIELDS = Object.freeze([
  'id', 'name', 'category', 'kind', 'rarity', 'heavy', 'placement', 'candidates', 'filters', 'stamps', 'engines',
  'lod', 'lure', 'wind', 'audio', 'journal', 'discovery', 'callouts', 'lifetime', 'achievements',
  'activeState', 'cooldown', 'anchor',
]);

const ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const TOKEN_PATTERN = /\{([^{}]*)\}/g;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : typeof value;
}

/**
 * The checks for one preset. Every failure throws through fail() with the preset id and the field
 * path, so the message says exactly what to fix.
 */
function createChecker(presetId) {
  function fail(path, message) {
    throw new Error(`[DRIFTWING] preset "${presetId}": field "${path}" ${message}`);
  }
  const check = {
    fail,
    object(value, path) {
      if (!isPlainObject(value)) fail(path, `must be an object, got ${describe(value)}`);
      return value;
    },
    array(value, path) {
      if (!Array.isArray(value)) fail(path, `must be an array, got ${describe(value)}`);
      return value;
    },
    string(value, path) {
      if (typeof value !== 'string' || value.trim() === '') fail(path, `must be a non-empty string, got ${describe(value)}`);
      return value;
    },
    boolean(value, path) {
      if (typeof value !== 'boolean') fail(path, `must be true or false, got ${describe(value)}`);
      return value;
    },
    number(value, path, { min = -Infinity, max = Infinity, above = null } = {}) {
      if (!Number.isFinite(value)) fail(path, `must be a finite number, got ${describe(value)}`);
      if (above !== null && !(value > above)) fail(path, `must be greater than ${above}, got ${value}`);
      if (value < min || value > max) fail(path, `must be within ${min}..${max}, got ${value}`);
      return value;
    },
    oneOf(value, allowed, path) {
      if (!allowed.includes(value)) fail(path, `must be one of ${allowed.join(', ')}, got ${describe(value)}`);
      return value;
    },
    /** null (any) or a non-empty array of allowed strings (allowed null: any non-empty string). */
    listOrNull(value, allowed, path) {
      if (value === null || value === undefined) return value;
      check.array(value, path);
      if (value.length === 0) fail(path, 'must be null (any) or a non-empty array');
      value.forEach((entry, index) => {
        if (allowed) check.oneOf(entry, allowed, `${path}[${index}]`);
        else check.string(entry, `${path}[${index}]`);
      });
      return value;
    },
    onlyKeys(value, keys, path) {
      for (const key of Object.keys(value)) {
        if (!keys.includes(key)) fail(`${path}.${key}`, `is not a known field (known: ${keys.join(', ')})`);
      }
    },
  };
  return check;
}

function validatePlacement(check, placement) {
  check.object(placement, 'placement');
  check.onlyKeys(placement, ['chance', 'minSpacing', 'biomes', 'surface', 'terrain', 'clearance', 'align', 'scale'], 'placement');
  check.number(placement.chance, 'placement.chance', { above: 0, max: 1 });
  check.number(placement.minSpacing, 'placement.minSpacing', { min: 0 });
  check.listOrNull(placement.biomes, null, 'placement.biomes');
  check.oneOf(placement.surface, PRESET_SURFACES, 'placement.surface');
  check.number(placement.clearance, 'placement.clearance', { min: 0 });
  // Optional, as src/world/placement.js reads them: how the site is oriented and its scale range.
  if (placement.align !== undefined) check.oneOf(placement.align, PLACEMENT_ALIGNMENTS, 'placement.align');
  if (placement.scale !== undefined) {
    const scale = placement.scale;
    if (!Array.isArray(scale) || scale.length !== 2 || !scale.every((value) => Number.isFinite(value) && value > 0) || scale[0] > scale[1]) {
      check.fail('placement.scale', `must be an ascending [min, max] range of positive numbers, got ${describe(scale)}`);
    }
  }
  if (placement.terrain !== undefined && placement.terrain !== null) {
    const terrain = check.object(placement.terrain, 'placement.terrain');
    check.onlyKeys(terrain, ['minHeight', 'maxHeight', 'relief'], 'placement.terrain');
    if (terrain.minHeight !== undefined) check.number(terrain.minHeight, 'placement.terrain.minHeight');
    if (terrain.maxHeight !== undefined) check.number(terrain.maxHeight, 'placement.terrain.maxHeight');
    if (terrain.minHeight !== undefined && terrain.maxHeight !== undefined && terrain.maxHeight < terrain.minHeight) {
      check.fail('placement.terrain.maxHeight', `must not be below placement.terrain.minHeight (${terrain.minHeight}), got ${terrain.maxHeight}`);
    }
    if (terrain.relief !== undefined) check.oneOf(terrain.relief, TERRAIN_RELIEFS, 'placement.terrain.relief');
  }
}

function validateCandidates(check, candidates) {
  check.object(candidates, 'candidates');
  check.onlyKeys(candidates, ['cellSize', 'bucketSeconds', 'chance'], 'candidates');
  check.number(candidates.cellSize, 'candidates.cellSize', { above: 0 });
  check.number(candidates.bucketSeconds, 'candidates.bucketSeconds', { above: 0 });
  check.number(candidates.chance, 'candidates.chance', { above: 0, max: 1 });
}

function validateFilters(check, filters) {
  check.object(filters, 'filters');
  check.onlyKeys(filters, ['biomes', 'timeOfDay', 'altitude', 'weather', 'surface', 'minDistance', 'maxDistance'], 'filters');
  check.listOrNull(filters.biomes, null, 'filters.biomes');
  check.listOrNull(filters.timeOfDay, TIME_OF_DAY_CLASSES, 'filters.timeOfDay');
  check.listOrNull(filters.weather, WEATHER_STATE_NAMES, 'filters.weather');
  if (filters.surface !== undefined && filters.surface !== null) check.oneOf(filters.surface, PRESET_SURFACES, 'filters.surface');
  if (filters.altitude !== undefined && filters.altitude !== null) {
    const altitude = check.object(filters.altitude, 'filters.altitude');
    check.onlyKeys(altitude, ['min', 'max'], 'filters.altitude');
    check.number(altitude.min, 'filters.altitude.min');
    check.number(altitude.max, 'filters.altitude.max');
    if (altitude.max < altitude.min) check.fail('filters.altitude.max', `must not be below filters.altitude.min (${altitude.min}), got ${altitude.max}`);
  }
  if (filters.minDistance !== undefined) check.number(filters.minDistance, 'filters.minDistance', { min: 0 });
  if (filters.maxDistance !== undefined) check.number(filters.maxDistance, 'filters.maxDistance', { min: 0 });
  if (filters.minDistance !== undefined && filters.maxDistance !== undefined && filters.maxDistance < filters.minDistance) {
    check.fail('filters.maxDistance', `must not be below filters.minDistance (${filters.minDistance}), got ${filters.maxDistance}`);
  }
}

function validateStamps(check, stamps, kind) {
  if (stamps === undefined) return;
  check.array(stamps, 'stamps');
  if (kind === 'event' && stamps.length > 0) check.fail('stamps', 'must be empty for an event (only sites stamp the terrain)');
  stamps.forEach((stamp, index) => {
    const path = `stamps[${index}]`;
    check.object(stamp, path);
    check.oneOf(stamp.type, STAMP_TYPES, `${path}.type`);
    if (stamp.paint !== undefined && stamp.paint !== null) check.oneOf(stamp.paint, STAMP_PAINTS, `${path}.paint`);
  });
}

function validateEngines(check, engines, engineNames) {
  check.array(engines, 'engines');
  if (engines.length === 0) check.fail('engines', 'must name at least one engine');
  engines.forEach((entry, index) => {
    const path = `engines[${index}]`;
    check.object(entry, path);
    check.onlyKeys(entry, ['engine', 'params'], path);
    check.string(entry.engine, `${path}.engine`);
    if (engineNames && !engineNames.includes(entry.engine)) {
      check.fail(`${path}.engine`, `names an engine that is not registered: ${describe(entry.engine)} (registered: ${engineNames.join(', ') || 'none'})`);
    }
    if (entry.params !== undefined) check.object(entry.params, `${path}.params`);
  });
}

function validateLod(check, lod) {
  check.object(lod, 'lod');
  check.onlyKeys(lod, ['near', 'mid', 'far'], 'lod');
  check.number(lod.near, 'lod.near', { above: 0 });
  check.number(lod.mid, 'lod.mid', { above: lod.near });
  check.number(lod.far, 'lod.far', { above: lod.mid });
}

function validateLure(check, lure, heavy) {
  if (!heavy) {
    if (lure !== null && lure !== undefined) check.fail('lure', 'must be null for a preset that is not heavy (only heavy presets get a FAR lure)');
    return;
  }
  check.object(lure, 'lure');
  check.onlyKeys(lure, ['type', 'height', 'width', 'color', 'altitude', 'glow', 'flash'], 'lure');
  check.oneOf(lure.type, LURE_TYPES, 'lure.type');
  check.number(lure.height, 'lure.height', { above: 0 });
  check.number(lure.width, 'lure.width', { above: 0 });
  if (!Number.isInteger(lure.color) || lure.color < 0 || lure.color > 0xffffff) check.fail('lure.color', `must be a 0xRRGGBB integer, got ${describe(lure.color)}`);
  if (lure.altitude !== undefined) check.number(lure.altitude, 'lure.altitude', { min: 0 });
  if (lure.glow !== undefined && lure.glow !== null && (!Number.isInteger(lure.glow) || lure.glow < 0 || lure.glow > 0xffffff)) {
    check.fail('lure.glow', `must be null or a 0xRRGGBB integer, got ${describe(lure.glow)}`);
  }
  if (lure.flash !== undefined) check.number(lure.flash, 'lure.flash', { min: 0, max: 4 });
}

function validateWind(check, wind) {
  check.array(wind, 'wind');
  wind.forEach((entry, index) => {
    const path = `wind[${index}]`;
    check.object(entry, path);
    check.onlyKeys(entry, ['type', 'params'], path);
    check.string(entry.type, `${path}.type`);
    if (entry.params !== undefined) check.object(entry.params, `${path}.params`);
  });
}

function validateAudio(check, audio) {
  if (audio === null) return;
  check.object(audio, 'audio');
  check.onlyKeys(audio, ['recipe', 'params'], 'audio');
  check.string(audio.recipe, 'audio.recipe');
  if (audio.params !== undefined) check.object(audio.params, 'audio.params');
}

function validateCallouts(check, callouts) {
  check.array(callouts, 'callouts');
  if (callouts.length < 3) check.fail('callouts', `must have at least 3 lines, got ${callouts.length}`);
  callouts.forEach((line, index) => {
    const path = `callouts[${index}]`;
    check.string(line, path);
    for (const match of line.matchAll(TOKEN_PATTERN)) {
      if (!CALLOUT_TOKENS.includes(match[1])) check.fail(path, `uses an unknown token {${match[1]}} (known: ${CALLOUT_TOKENS.map((token) => `{${token}}`).join(' ')})`);
    }
  });
}

function validateLifetime(check, lifetime, kind) {
  check.object(lifetime, 'lifetime');
  check.onlyKeys(lifetime, ['duration', 'despawn'], 'lifetime');
  if (kind === 'site') {
    if (lifetime.duration !== null) check.fail('lifetime.duration', `must be null for a site (sites are persistent), got ${describe(lifetime.duration)}`);
  } else {
    check.array(lifetime.duration, 'lifetime.duration');
    if (lifetime.duration.length !== 2) check.fail('lifetime.duration', 'must be [minSeconds, maxSeconds]');
    check.number(lifetime.duration[0], 'lifetime.duration[0]', { above: 0 });
    check.number(lifetime.duration[1], 'lifetime.duration[1]', { min: lifetime.duration[0] });
  }
  const despawn = check.object(lifetime.despawn, 'lifetime.despawn');
  check.onlyKeys(despawn, ['distance', 'hysteresis', 'outOfViewSeconds'], 'lifetime.despawn');
  check.number(despawn.distance, 'lifetime.despawn.distance', { above: 0 });
  check.number(despawn.hysteresis, 'lifetime.despawn.hysteresis', { min: 0 });
  check.number(despawn.outOfViewSeconds, 'lifetime.despawn.outOfViewSeconds', { min: 0 });
}

function validateAchievements(check, achievements) {
  if (achievements === undefined) return;
  check.array(achievements, 'achievements');
  achievements.forEach((entry, index) => {
    const path = `achievements[${index}]`;
    check.object(entry, path);
    check.onlyKeys(entry, ['id', 'title', 'description'], path);
    check.string(entry.id, `${path}.id`);
    check.string(entry.title, `${path}.title`);
    check.string(entry.description, `${path}.description`);
  });
}

/**
 * activeState (sites only, optional): the site has a director-driven ACTIVE state, such as an
 * erupting volcano. { duration: [minSeconds, maxSeconds] } is how long one active spell lasts; the
 * director starts it as a candidate of the preset's rarity and the SpawnManager starts the site
 * dormant (every part's instance.active = false) until then.
 */
function validateActiveState(check, activeState, kind) {
  if (activeState === undefined || activeState === null) return;
  if (kind !== 'site') check.fail('activeState', 'is for sites only (an event is active for its whole lifetime)');
  check.object(activeState, 'activeState');
  check.onlyKeys(activeState, ['duration'], 'activeState');
  check.array(activeState.duration, 'activeState.duration');
  if (activeState.duration.length !== 2) check.fail('activeState.duration', 'must be [minSeconds, maxSeconds]');
  check.number(activeState.duration[0], 'activeState.duration[0]', { above: 0 });
  check.number(activeState.duration[1], 'activeState.duration[1]', { min: activeState.duration[0] });
}

/**
 * anchor (events only, optional): moves an activation before the engines see it. seek 'peak' takes the
 * highest ground within radius metres of the activation point (lenticular clouds stand over peaks);
 * align 'downwind' turns the spawn's heading downwind of the prevailing wind.
 */
function validateAnchor(check, anchor, kind) {
  if (anchor === undefined || anchor === null) return;
  if (kind !== 'event') check.fail('anchor', 'is for events only (a site is placed by its placement rules)');
  check.object(anchor, 'anchor');
  check.onlyKeys(anchor, ['seek', 'radius', 'align'], 'anchor');
  if (anchor.seek !== undefined && anchor.seek !== null) {
    check.oneOf(anchor.seek, ANCHOR_SEEKS, 'anchor.seek');
    check.number(anchor.radius, 'anchor.radius', { above: 0, max: 20000 });
  } else if (anchor.radius !== undefined) {
    check.fail('anchor.radius', 'needs anchor.seek');
  }
  if (anchor.align !== undefined && anchor.align !== null) check.oneOf(anchor.align, ANCHOR_ALIGNS, 'anchor.align');
}

/**
 * Validates one preset against contract section 1. Returns the preset; throws an Error naming the
 * preset and the field at fault.
 */
export function validatePreset(preset, { engineNames = null } = {}) {
  const presetId = isPlainObject(preset) && typeof preset.id === 'string' ? preset.id : '(no id)';
  const check = createChecker(presetId);
  if (!isPlainObject(preset)) check.fail('(preset)', `must be an object, got ${describe(preset)}`);
  if (!Object.isFrozen(preset)) check.fail('(preset)', 'must be frozen (export default Object.freeze({ ... }))');
  check.onlyKeys(preset, PRESET_FIELDS, '(preset)');
  check.string(preset.id, 'id');
  if (!ID_PATTERN.test(preset.id)) check.fail('id', `must be camelCase (letters and digits, starting lower case), got ${describe(preset.id)}`);
  check.string(preset.name, 'name');
  check.oneOf(preset.category, PRESET_CATEGORIES, 'category');
  check.oneOf(preset.kind, PRESET_KINDS, 'kind');
  check.oneOf(preset.rarity, PRESET_RARITIES, 'rarity');
  check.boolean(preset.heavy, 'heavy');
  if (preset.kind === 'site') {
    validatePlacement(check, preset.placement);
    if (preset.candidates !== undefined && preset.candidates !== null) check.fail('candidates', 'must be absent for a site (sites are placed, not rolled as candidates)');
  } else {
    validateCandidates(check, preset.candidates);
    if (preset.placement !== undefined && preset.placement !== null) check.fail('placement', 'must be absent for an event (events are candidates, not placed sites)');
  }
  validateFilters(check, preset.filters);
  validateStamps(check, preset.stamps, preset.kind);
  validateEngines(check, preset.engines, engineNames);
  validateLod(check, preset.lod);
  validateLure(check, preset.lure, preset.heavy);
  validateWind(check, preset.wind);
  validateAudio(check, preset.audio);
  const journal = check.object(preset.journal, 'journal');
  check.onlyKeys(journal, ['title', 'description'], 'journal');
  check.string(journal.title, 'journal.title');
  check.string(journal.description, 'journal.description');
  const discovery = check.object(preset.discovery, 'discovery');
  check.onlyKeys(discovery, ['radius', 'requireInView'], 'discovery');
  check.number(discovery.radius, 'discovery.radius', { above: 0 });
  check.boolean(discovery.requireInView, 'discovery.requireInView');
  validateCallouts(check, preset.callouts);
  validateLifetime(check, preset.lifetime, preset.kind);
  validateAchievements(check, preset.achievements);
  validateActiveState(check, preset.activeState, preset.kind);
  if (preset.cooldown !== undefined) check.number(preset.cooldown, 'cooldown', { min: 0 });
  validateAnchor(check, preset.anchor, preset.kind);
  return preset;
}

/** Validates every preset and that their ids are unique. Returns the list. */
export function validatePresets(presets, options = {}) {
  if (!Array.isArray(presets)) throw new TypeError('[DRIFTWING] validatePresets needs an array of presets');
  const seen = new Set();
  for (const preset of presets) {
    validatePreset(preset, options);
    if (seen.has(preset.id)) throw new Error(`[DRIFTWING] preset "${preset.id}": field "id" is used by another preset`);
    seen.add(preset.id);
  }
  return presets;
}
