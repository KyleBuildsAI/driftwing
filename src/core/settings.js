// Player settings: a versioned, validated schema persisted through core/storage (IndexedDB).
//
// Flat keys hold scalars; a few keys hold small objects (assists per craft, FOV per view, the audio
// mixer, HUD preferences, default view per mode). get/set work on whole keys; update(key, patch)
// merges into an object key. Every change emits 'settings:changed' { key, value, settings }.
//
// Bindings and calibration are not settings: the input system keeps them in their own storage keys
// (input.bindings, input.calibration.<device>) so a device profile can be exported on its own.
import { CONFIG } from './config.js';
import { storage } from './storage.js';

export const SETTINGS_VERSION = 2;
const STORAGE_KEY = 'driftwing.settings';
const LEGACY_STORAGE_KEY = 'driftwing.settings.v1';

export const CRAFT_IDS = Object.freeze(['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv']);
export const FLIGHT_MODES = Object.freeze(['classic', 'sim']);
export const VIEW_IDS = Object.freeze(['chase', 'cockpit', 'wing', 'flyby']);
export const UNIT_SYSTEMS = Object.freeze(['metric', 'aviation']);
export const QUALITY_PREFERENCES = Object.freeze(['auto', 'minimal', 'low', 'medium', 'high', 'ultra']);
export const FRAME_TARGETS = Object.freeze(['auto', 30, 60, 72, 90, 120, 144, 165, 240]);
export const MIXER_BUSES = Object.freeze(['master', 'engine', 'environment', 'ui', 'copilot', 'music']);

const unitRange = (min, max) => (value) => Number.isFinite(value) && value >= min && value <= max;
const oneOf = (list) => (value) => list.includes(value);
const isBoolean = (value) => typeof value === 'boolean';

function perCraft(value) {
  return Object.freeze(Object.fromEntries(CRAFT_IDS.map((id) => [id, value])));
}

/**
 * The schema: default value and validator for every key. Object-valued keys list a validator per
 * field; unknown fields are dropped and invalid ones fall back to the default field value.
 */
const SCHEMA = Object.freeze({
  // v1 keys, unchanged.
  dayLength: { default: CONFIG.DAY_LENGTH_DEFAULT, validate: unitRange(60, 3600) },
  timeFrozen: { default: false, validate: isBoolean },
  quality: { default: 'auto', validate: oneOf(QUALITY_PREFERENCES) },
  mouseSensitivity: { default: 1, validate: unitRange(0.2, 4) },
  invertPitch: { default: false, validate: isBoolean },
  copilotVoice: { default: true, validate: isBoolean },
  copilotChatter: { default: true, validate: isBoolean },
  remoteCopilot: { default: false, validate: isBoolean },
  remoteEndpoint: { default: CONFIG.REMOTE_COPILOT_DEFAULT_ENDPOINT, validate: (value) => typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) },
  showFps: { default: false, validate: isBoolean },
  hudAutoHide: { default: true, validate: isBoolean },

  // v2: flight.
  mode: { default: 'classic', validate: oneOf(FLIGHT_MODES) },
  craft: { default: 'glider', validate: oneOf(CRAFT_IDS) },
  assists: { default: perCraft(1), fields: Object.fromEntries(CRAFT_IDS.map((id) => [id, unitRange(0, 1)])) },
  startOnGround: { default: false, validate: isBoolean },
  units: { default: 'metric', validate: oneOf(UNIT_SYSTEMS) },

  // v2: views and HUD.
  views: {
    default: Object.freeze({ classic: 'chase', sim: 'cockpit' }),
    fields: { classic: oneOf(VIEW_IDS), sim: oneOf(VIEW_IDS) },
  },
  fov: {
    default: Object.freeze({ chase: CONFIG.CAMERA.FOV_BASE, cockpit: 74, wing: 68, flyby: 50, fpv: 120 }),
    fields: { chase: unitRange(40, 100), cockpit: unitRange(50, 110), wing: unitRange(40, 110), flyby: unitRange(20, 90), fpv: unitRange(90, 150) },
  },
  hud: {
    default: Object.freeze({ overlay: false, landingCallouts: false }),
    fields: { overlay: isBoolean, landingCallouts: isBoolean },
  },

  // v2: input behaviour (bindings and calibration live in input storage keys).
  twistYaw: { default: 'auto', validate: oneOf(['auto', 'on', 'off']) },
  afterburnerDetent: { default: 0.95, validate: unitRange(0.8, 1) },
  hotasPrompt: { default: 'ask', validate: oneOf(['ask', 'always', 'never']) },

  // v2: graphics and performance.
  frameTarget: { default: 'auto', validate: oneOf(FRAME_TARGETS) },
  dynamicResolution: { default: true, validate: isBoolean },

  // v2: audio mixer (0..1 per bus).
  mixer: {
    default: Object.freeze({ master: 0.7, engine: 0.9, environment: 0.85, ui: 0.8, copilot: 1, music: 0.7 }),
    fields: Object.fromEntries(MIXER_BUSES.map((bus) => [bus, unitRange(0, 1)])),
  },

  // v2: developer aids.
  devBadge: { default: false, validate: isBoolean },
  windOverlay: { default: false, validate: isBoolean },
});

/** Keys that read and write a field of an object key, kept so v1-era callers keep working. */
const ALIASES = Object.freeze({
  masterVolume: { key: 'mixer', field: 'master' },
});

export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(Object.entries(SCHEMA).map(([key, entry]) => [key, entry.default])));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the sanitized value for key, or undefined when value cannot be used at all. */
function sanitize(key, value) {
  const entry = SCHEMA[key];
  if (!entry) return undefined;
  if (entry.fields) {
    if (!isPlainObject(value)) return undefined;
    const result = {};
    for (const [field, validate] of Object.entries(entry.fields)) {
      result[field] = validate(value[field]) ? value[field] : entry.default[field];
    }
    return result;
  }
  return entry.validate(value) ? value : undefined;
}

export function isValidSetting(key, value) {
  const alias = ALIASES[key];
  if (alias) return SCHEMA[alias.key].fields[alias.field](value);
  const entry = SCHEMA[key];
  if (!entry) return false;
  if (entry.fields) return isPlainObject(value) && Object.entries(value).every(([field, fieldValue]) => entry.fields[field]?.(fieldValue));
  return entry.validate(value);
}

/** Upgrades a stored record of any older version to the current flat shape. */
function migrate(stored) {
  const record = isPlainObject(stored) ? { ...stored } : {};
  let version = Number.isInteger(record.version) ? record.version : 1;
  if (version < 2) {
    // v1 kept one volume slider; v2 mixes per bus with that slider as the master.
    if (Number.isFinite(record.masterVolume)) record.mixer = { ...SCHEMA.mixer.default, master: record.masterVolume };
    delete record.masterVolume;
    version = 2;
  }
  record.version = version;
  return record;
}

function loadValues() {
  let stored = storage.read(STORAGE_KEY, null);
  if (!stored) stored = storage.read(LEGACY_STORAGE_KEY, null);
  const record = migrate(stored);
  const values = {};
  for (const key of Object.keys(SCHEMA)) {
    const sanitized = key in record ? sanitize(key, record[key]) : undefined;
    values[key] = sanitized === undefined ? structuredClone(SCHEMA[key].default) : sanitized;
  }
  return values;
}

function valuesEqual(first, second) {
  if (isPlainObject(first) && isPlainObject(second)) {
    const keys = Object.keys(first);
    return keys.length === Object.keys(second).length && keys.every((key) => first[key] === second[key]);
  }
  return first === second;
}

export function createSettings(bus) {
  const values = loadValues();
  let saveFailureReported = false;

  function save() {
    if (!storage.write(STORAGE_KEY, { version: SETTINGS_VERSION, ...values }) && !saveFailureReported) {
      saveFailureReported = true;
      bus.emit('notify', { text: 'This browser is blocking storage, so settings will reset next visit.', kind: 'warning' });
    }
  }

  function commit(key, next) {
    if (valuesEqual(values[key], next)) return true;
    values[key] = next;
    save();
    const published = isPlainObject(next) ? { ...next } : next;
    bus.emit('settings:changed', { key, value: published, settings: snapshot() });
    const alias = Object.entries(ALIASES).find(([, target]) => target.key === key);
    if (alias) bus.emit('settings:changed', { key: alias[0], value: next[alias[1].field], settings: snapshot() });
    return true;
  }

  function snapshot() {
    const copy = {};
    for (const [key, value] of Object.entries(values)) copy[key] = isPlainObject(value) ? { ...value } : value;
    copy.masterVolume = values.mixer.master;
    return copy;
  }

  // Make sure a first run and a v1 import both land in the current format.
  if (storage.read(STORAGE_KEY, null)?.version !== SETTINGS_VERSION) save();

  return {
    /** Current value. Object values are returned as copies. */
    get(key) {
      const alias = ALIASES[key];
      if (alias) return values[alias.key][alias.field];
      const value = values[key];
      return isPlainObject(value) ? { ...value } : value;
    },
    all: snapshot,

    /** Replaces a key (a whole object for object keys). Returns false when the value is invalid. */
    set(key, value) {
      const alias = ALIASES[key];
      if (alias) return this.update(alias.key, { [alias.field]: value });
      if (!isValidSetting(key, value)) return false;
      const entry = SCHEMA[key];
      const next = entry.fields ? { ...values[key], ...value } : value;
      return commit(key, next);
    },

    /** Merges fields into an object key, e.g. update('assists', { jet: 0.5 }). */
    update(key, patch) {
      const entry = SCHEMA[key];
      if (!entry?.fields || !isValidSetting(key, patch)) return false;
      return commit(key, { ...values[key], ...patch });
    },

    /** Restores one key, or every key when none is given, to its default. */
    reset(key) {
      const keys = key ? [key] : Object.keys(SCHEMA);
      for (const name of keys) {
        if (SCHEMA[name]) commit(name, structuredClone(SCHEMA[name].default));
      }
    },
  };
}
