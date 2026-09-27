// Binding profiles: global bindings plus per-craft overrides, per binding device.
//
// Binding devices are 'keyboard', 'mouse', 'gamepad' (every standard-mapping gamepad) and one per
// HOTAS or other controller, keyed by its device key ('044f-b10a', ...). Defaults come from the
// device profile (defaultBindings.js); the stored profile holds only what the player changed:
//
//   { version, devices: { [device]: { profile, name } },
//     global: { [device]: { [target]: Ref[] } },
//     crafts: { [craftId]: { [device]: { [target]: Ref[] } } } }
//
// Resolution for a target on a device while flying a craft: the craft override if present, else
// the global override, else the profile default. An empty list is a deliberate "unbound".
// Stored in IndexedDB under 'input.bindings'; exported / imported as JSON.

import { ACTION_IDS, ACTIONS } from './controlState.js';
import { AXIS_TARGETS, AXIS_TARGET_IDS, DEFAULT_BINDINGS, UI_RESERVED_KEYS } from './defaultBindings.js';
import { HAT_DIRECTIONS, HAT_DIRECTION_LABELS } from './hats.js';
import { CRAFT_IDS } from '../core/settings.js';

export const BINDINGS_STORAGE_KEY = 'input.bindings';
const PROFILE_VERSION = 1;
const EXPORT_KIND = 'driftwing-bindings';
const MODES = Object.freeze(['classic', 'sim']);
const RANGES = Object.freeze(['bipolar', 'unipolar']);
const ROLES = Object.freeze(['twist', 'rudder', 'stickThrottle']);
const DEVICE_KINDS = Object.freeze(['hotas-stick', 'hotas-throttle', 'hotas-pedals', 'gamepad']);
const BUILT_IN_DEVICES = Object.freeze({
  keyboard: { profile: 'keyboard', name: 'Keyboard' },
  mouse: { profile: 'mouse', name: 'Mouse' },
  gamepad: { profile: 'standard', name: 'Gamepad' },
});
const MAX_REFS_PER_TARGET = 8;
const CODE_PATTERN = /^[A-Za-z0-9]{1,24}$/;
const DEVICE_PATTERN = /^[a-z0-9#-]{1,64}$/;

export const TARGET_IDS = Object.freeze([...ACTION_IDS, ...AXIS_TARGET_IDS]);
const ACTION_SET = new Set(ACTION_IDS);
const AXIS_SET = new Set(AXIS_TARGET_IDS);

export function isAxisTarget(target) {
  return AXIS_SET.has(target);
}

export function targetLabel(target) {
  return ACTIONS[target] ?? AXIS_TARGETS[target]?.label ?? target;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isIndex = (value) => Number.isInteger(value) && value >= 0 && value < 64;
const isUnit = (value, max = 1) => Number.isFinite(value) && value >= 0 && value <= max;

/**
 * Validates one reference for a target. Returns a clean copy (only known fields) or null.
 * Axis targets take axis-shaped references; actions take press-shaped ones.
 */
export function sanitizeRef(raw, target) {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
  const axisTarget = isAxisTarget(target);
  const ref = { type: raw.type };
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode)) return null;
    ref.mode = raw.mode;
  }
  switch (raw.type) {
    case 'key':
      if (axisTarget || !CODE_PATTERN.test(raw.code ?? '')) return null;
      ref.code = raw.code;
      if (raw.shift !== undefined) {
        if (typeof raw.shift !== 'boolean') return null;
        ref.shift = raw.shift;
      }
      return ref;
    case 'keys':
      if (!axisTarget || !CODE_PATTERN.test(raw.positive ?? '') || !CODE_PATTERN.test(raw.negative ?? '')) return null;
      ref.positive = raw.positive;
      ref.negative = raw.negative;
      if (raw.rate !== undefined) {
        if (!isUnit(raw.rate, 5) || raw.rate === 0) return null;
        ref.rate = raw.rate;
      }
      if (raw.doubleTapRoll === true) ref.doubleTapRoll = true;
      return ref;
    case 'mouseButton':
      if (axisTarget || !isIndex(raw.button) || raw.button > 4) return null;
      ref.button = raw.button;
      return ref;
    case 'button':
      if (axisTarget || !isIndex(raw.index)) return null;
      ref.index = raw.index;
      return ref;
    case 'hat':
      if (axisTarget || !isIndex(raw.hat) || !HAT_DIRECTIONS.includes(raw.direction)) return null;
      ref.hat = raw.hat;
      ref.direction = raw.direction;
      return ref;
    case 'axisPress':
      if (axisTarget || !isIndex(raw.axis) || (raw.direction !== 1 && raw.direction !== -1)) return null;
      ref.axis = raw.axis;
      ref.direction = raw.direction;
      return ref;
    case 'axis':
      if (!axisTarget || !isIndex(raw.axis)) return null;
      ref.axis = raw.axis;
      if (raw.range !== undefined) {
        if (!RANGES.includes(raw.range)) return null;
        ref.range = raw.range;
      }
      if (raw.role !== undefined) {
        if (!ROLES.includes(raw.role)) return null;
        ref.role = raw.role;
      }
      if (raw.invert !== undefined) {
        if (typeof raw.invert !== 'boolean') return null;
        ref.invert = raw.invert;
      }
      for (const [field, max] of [['deadzone', 0.5], ['saturation', 0.3], ['expo', 1], ['smoothing', 1]]) {
        if (raw[field] === undefined) continue;
        if (!isUnit(raw[field], max)) return null;
        ref[field] = raw[field];
      }
      if (raw.rate !== undefined) {
        if (!isUnit(raw.rate, 5) || raw.rate === 0) return null;
        ref.rate = raw.rate;
      }
      if (raw.suppressedBy !== undefined) {
        if (!DEVICE_KINDS.includes(raw.suppressedBy)) return null;
        ref.suppressedBy = raw.suppressedBy;
      }
      return ref;
    case 'buttonAxis':
    case 'buttonRate':
      if (!axisTarget || !isIndex(raw.positive) || !isIndex(raw.negative)) return null;
      ref.positive = raw.positive;
      ref.negative = raw.negative;
      if (raw.type === 'buttonRate') {
        if (!isUnit(raw.rate, 5) || raw.rate === 0) return null;
        ref.rate = raw.rate;
      }
      return ref;
    default:
      return null;
  }
}

/** Human-readable name of a key code ('KeyG' -> 'G', 'Numpad8' -> 'Num 8'). */
export function keyLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  const names = {
    Space: 'Space', Backquote: '`', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.',
    Slash: '/', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
    ArrowRight: 'Right', Home: 'Home', End: 'End', Enter: 'Enter', NumpadEnter: 'Num Enter',
    Escape: 'Esc', Tab: 'Tab', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backslash: '\\',
  };
  return names[code] ?? code;
}

/** Short label for a reference, for the controls panel ("Shift+F", "Button 3", "Hat 1 up"). */
export function describeRef(ref, device = null) {
  const layer = ref.mode ? ` (${ref.mode.toUpperCase()})` : '';
  const buttonName = (index) => device?.buttonLabels?.[index] ?? `Button ${index + 1}`;
  switch (ref.type) {
    case 'key': return `${ref.shift ? 'Shift+' : ''}${keyLabel(ref.code)}${layer}`;
    case 'keys': return `${keyLabel(ref.positive)} / ${keyLabel(ref.negative)}${layer}`;
    case 'mouseButton': return ['Left mouse', 'Middle mouse', 'Right mouse', 'Mouse back', 'Mouse forward'][ref.button] + layer;
    case 'button': return `${buttonName(ref.index)}${layer}`;
    case 'hat': return `Hat ${ref.hat + 1} ${HAT_DIRECTION_LABELS[ref.direction]}${layer}`;
    case 'axisPress': return `Axis ${ref.axis + 1} ${ref.direction > 0 ? '+' : '-'}${layer}`;
    case 'axis': return `${device?.axisLabels?.[ref.axis] ?? `Axis ${ref.axis + 1}`}${ref.invert ? ' (inverted)' : ''}${ref.rate ? ' (rate)' : ''}${layer}`;
    case 'buttonAxis':
    case 'buttonRate': return `${buttonName(ref.positive)} / ${buttonName(ref.negative)}${layer}`;
    default: return ref.type;
  }
}

/**
 * The concrete inputs a reference occupies, as strings such as 'classic|key:KeyF|shift' or
 * 'sim|button:3'. Two references conflict when they occupy the same input. A key reference
 * without a shift preference occupies the Shift variant only when no Shift binding claims it
 * (see resolveKeyVariants), so it is expanded by the caller.
 */
function refInputs(ref) {
  const modes = ref.mode ? [ref.mode] : MODES;
  const inputs = [];
  const add = (name) => { for (const mode of modes) inputs.push(`${mode}|${name}`); };
  switch (ref.type) {
    case 'key':
      if (ref.shift !== true) add(`key:${ref.code}|plain`);
      if (ref.shift === true) add(`key:${ref.code}|shift`);
      break;
    case 'keys':
      for (const code of [ref.positive, ref.negative]) {
        add(`key:${code}|plain`);
        add(`key:${code}|shift`);
      }
      break;
    case 'mouseButton': add(`mouse:${ref.button}`); break;
    case 'button': add(`button:${ref.index}`); break;
    case 'hat': add(`hat:${ref.hat}:${ref.direction}`); break;
    case 'axisPress':
    case 'axis': add(`axis:${ref.axis}`); break;
    case 'buttonAxis':
    case 'buttonRate':
      add(`button:${ref.positive}`);
      add(`button:${ref.negative}`);
      break;
    default: break;
  }
  return inputs;
}

function copyRefs(refs) {
  return refs.map((ref) => ({ ...ref }));
}

function emptyProfile() {
  return { version: PROFILE_VERSION, devices: {}, global: {}, crafts: {} };
}

/** Validates a stored or imported profile. Returns { profile, errors }. */
function sanitizeProfile(raw) {
  const errors = [];
  const profile = emptyProfile();
  if (!isPlainObject(raw)) return { profile, errors: ['profile is not an object'] };
  if (isPlainObject(raw.devices)) {
    for (const [device, meta] of Object.entries(raw.devices)) {
      if (!DEVICE_PATTERN.test(device) || !isPlainObject(meta) || typeof meta.profile !== 'string' || !DEFAULT_BINDINGS[meta.profile]) {
        errors.push(`device ${device}: unknown profile`);
        continue;
      }
      profile.devices[device] = { profile: meta.profile, name: typeof meta.name === 'string' ? meta.name.slice(0, 80) : device };
    }
  }
  const readLayer = (layer, where) => {
    const result = {};
    if (!isPlainObject(layer)) return result;
    for (const [device, targets] of Object.entries(layer)) {
      if (!DEVICE_PATTERN.test(device) || !isPlainObject(targets)) {
        errors.push(`${where}: bad device ${device}`);
        continue;
      }
      for (const [target, refs] of Object.entries(targets)) {
        if (!ACTION_SET.has(target) && !AXIS_SET.has(target)) {
          errors.push(`${where}/${device}: unknown target ${target}`);
          continue;
        }
        if (!Array.isArray(refs)) {
          errors.push(`${where}/${device}/${target}: not a list`);
          continue;
        }
        const clean = [];
        for (const ref of refs.slice(0, MAX_REFS_PER_TARGET)) {
          const sanitized = sanitizeRef(ref, target);
          if (sanitized) clean.push(sanitized);
          else errors.push(`${where}/${device}/${target}: dropped invalid reference ${JSON.stringify(ref)}`);
        }
        result[device] ??= {};
        result[device][target] = clean;
      }
    }
    return result;
  };
  profile.global = readLayer(raw.global, 'global');
  if (isPlainObject(raw.crafts)) {
    for (const [craft, layer] of Object.entries(raw.crafts)) {
      if (!CRAFT_IDS.includes(craft)) {
        errors.push(`crafts: unknown craft ${craft}`);
        continue;
      }
      const cleanLayer = readLayer(layer, `crafts/${craft}`);
      if (Object.keys(cleanLayer).length > 0) profile.crafts[craft] = cleanLayer;
    }
  }
  return { profile, errors };
}

/**
 * Creates the binding store. storage: core/storage (read / write). Listeners registered with
 * onChange run after every change with { reason }.
 */
export function createBindingStore({ storage }) {
  const loaded = sanitizeProfile(storage.read(BINDINGS_STORAGE_KEY, emptyProfile()));
  let profile = loaded.profile;
  let version = 0;
  const listeners = new Set();
  const effectiveCache = new Map();

  function profileIdFor(device) {
    return BUILT_IN_DEVICES[device]?.profile ?? profile.devices[device]?.profile ?? 'generic';
  }

  function defaultRefs(device, target) {
    const defaults = DEFAULT_BINDINGS[profileIdFor(device)];
    if (!defaults) return [];
    return (isAxisTarget(target) ? defaults.axes[target] : defaults.actions[target]) ?? [];
  }

  function changed(reason) {
    version++;
    effectiveCache.clear();
    storage.write(BINDINGS_STORAGE_KEY, profile);
    for (const listener of listeners) listener({ reason });
  }

  function layerFor(craft, create) {
    if (!craft) return profile.global;
    if (!CRAFT_IDS.includes(craft)) throw new Error(`unknown craft "${craft}"`);
    if (!profile.crafts[craft] && create) profile.crafts[craft] = {};
    return profile.crafts[craft] ?? null;
  }

  /** Effective references for one target (craft override, then global, then default). */
  function getRefs(device, target, craft = null) {
    const craftRefs = craft ? profile.crafts[craft]?.[device]?.[target] : undefined;
    if (craftRefs) return craftRefs;
    const globalRefs = profile.global[device]?.[target];
    if (globalRefs) return globalRefs;
    return defaultRefs(device, target);
  }

  /** Where the effective binding comes from: 'craft' | 'global' | 'default'. */
  function sourceOf(device, target, craft = null) {
    if (craft && profile.crafts[craft]?.[device]?.[target]) return 'craft';
    if (profile.global[device]?.[target]) return 'global';
    return 'default';
  }

  /** Every effective binding of a device for a craft: { actions: [[id, refs]], axes: [[id, refs]] }. */
  function getEffective(device, craft = null) {
    const cacheKey = `${device}|${craft ?? ''}`;
    let effective = effectiveCache.get(cacheKey);
    if (!effective) {
      effective = { actions: [], axes: [] };
      for (const target of ACTION_IDS) {
        const refs = getRefs(device, target, craft);
        if (refs.length > 0) effective.actions.push([target, refs]);
      }
      for (const target of AXIS_TARGET_IDS) {
        const refs = getRefs(device, target, craft);
        if (refs.length > 0) effective.axes.push([target, refs]);
      }
      effectiveCache.set(cacheKey, effective);
    }
    return effective;
  }

  /** Every [input, target, ref] the effective bindings of a device occupy (for conflicts). */
  function occupiedInputs(device, craft) {
    const effective = getEffective(device, craft);
    const entries = [];
    for (const [target, refs] of [...effective.actions, ...effective.axes]) {
      for (const ref of refs) for (const input of refInputs(ref)) entries.push({ input, target, ref });
    }
    // A plain key (no shift preference) also answers Shift+key unless a Shift binding claims it.
    const shiftClaimed = new Set(entries.filter((entry) => entry.input.endsWith('|shift')).map((entry) => entry.input));
    for (const [target, refs] of effective.actions) {
      for (const ref of refs) {
        if (ref.type !== 'key' || ref.shift !== undefined) continue;
        for (const mode of ref.mode ? [ref.mode] : MODES) {
          const shiftInput = `${mode}|key:${ref.code}|shift`;
          if (!shiftClaimed.has(shiftInput)) entries.push({ input: shiftInput, target, ref, fallback: true });
        }
      }
    }
    return entries;
  }

  function reservedKeyConflicts(entries) {
    const conflicts = [];
    for (const reserved of UI_RESERVED_KEYS) {
      const modes = reserved.mode ? [reserved.mode] : MODES;
      const variants = reserved.shift === true ? ['shift'] : reserved.shift === false ? ['plain'] : ['plain', 'shift'];
      for (const mode of modes) {
        for (const variant of variants) {
          const input = `${mode}|key:${reserved.code}|${variant}`;
          const users = entries.filter((entry) => entry.input === input && !entry.fallback);
          for (const entry of users) conflicts.push({ input, targets: [entry.target], reserved: reserved.label, kind: 'uiKey' });
        }
      }
    }
    return conflicts;
  }

  /**
   * Conflicts on one binding device for a craft (null = global): every input used by more than one
   * target, and keyboard bindings on keys the UI keeps. Each entry: { device, input, targets,
   * kind: 'duplicate' | 'uiKey', reserved? }.
   */
  function findConflicts({ device, craft = null }) {
    const entries = occupiedInputs(device, craft);
    const byInput = new Map();
    for (const entry of entries) {
      if (!byInput.has(entry.input)) byInput.set(entry.input, new Set());
      byInput.get(entry.input).add(entry.target);
    }
    const conflicts = [];
    for (const [input, targets] of byInput) {
      if (targets.size > 1) conflicts.push({ device, input, targets: [...targets], kind: 'duplicate' });
    }
    if (device === 'keyboard') for (const conflict of reservedKeyConflicts(entries)) conflicts.push({ device, ...conflict });
    return conflicts;
  }

  /** Targets other than target that already use the inputs of ref (to warn before binding). */
  function conflictsFor({ device, target, ref, craft = null }) {
    const clean = sanitizeRef(ref, target);
    if (!clean) return [];
    const wanted = new Set(refInputs(clean));
    const found = new Set();
    for (const entry of occupiedInputs(device, craft)) {
      if (entry.target !== target && wanted.has(entry.input)) found.add(entry.target);
    }
    const result = [...found].map((other) => ({ target: other, label: targetLabel(other), kind: 'duplicate' }));
    if (device === 'keyboard' && clean.type === 'key') {
      for (const reserved of UI_RESERVED_KEYS) {
        if (reserved.code !== clean.code) continue;
        if (reserved.mode && clean.mode && reserved.mode !== clean.mode) continue;
        if (reserved.shift !== undefined && clean.shift !== undefined && reserved.shift !== clean.shift) continue;
        result.push({ target: null, label: reserved.label, kind: 'uiKey' });
      }
    }
    return result;
  }

  return {
    get version() { return version; },

    /** Errors found while loading the stored profile (dropped entries). */
    loadErrors: loaded.errors,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Remembers which profile a binding device uses (so its bindings list even while unplugged). */
    registerDevice(device, profileId, name) {
      if (BUILT_IN_DEVICES[device] || !DEVICE_PATTERN.test(device) || !DEFAULT_BINDINGS[profileId]) return;
      const existing = profile.devices[device];
      if (existing && existing.profile === profileId && existing.name === name) return;
      profile.devices[device] = { profile: profileId, name: String(name).slice(0, 80) };
      changed('device');
    },

    /** Binding devices with their profile and name, built-ins first. */
    listDevices() {
      return [
        ...Object.entries(BUILT_IN_DEVICES).map(([device, meta]) => ({ device, ...meta })),
        ...Object.entries(profile.devices).map(([device, meta]) => ({ device, ...meta })),
      ];
    },

    profileIdFor,
    getRefs(device, target, craft = null) {
      return copyRefs(getRefs(device, target, craft));
    },
    sourceOf,
    getEffective,

    /** Default references of a target on a device (for "reset this binding" in the UI). */
    getDefaultRefs(device, target) {
      return copyRefs(defaultRefs(device, target));
    },

    /**
     * Binds ref to target on device, globally (craft null) or as an override for craft.
     * replace: true replaces the target's references, false adds to them. Returns { ok, ref,
     * conflicts } where conflicts lists other targets already using that input (still bound).
     */
    bind({ device, target, ref, craft = null, replace = true }) {
      if (!TARGET_IDS.includes(target)) return { ok: false, error: `unknown target ${target}`, conflicts: [] };
      if (!DEVICE_PATTERN.test(device)) return { ok: false, error: `bad device ${device}`, conflicts: [] };
      const clean = sanitizeRef(ref, target);
      if (!clean) return { ok: false, error: 'invalid reference for this target', conflicts: [] };
      const conflicts = conflictsFor({ device, target, ref: clean, craft });
      const layer = layerFor(craft, true);
      layer[device] ??= {};
      const current = replace ? [] : copyRefs(getRefs(device, target, craft));
      const duplicate = current.some((existing) => JSON.stringify(existing) === JSON.stringify(clean));
      layer[device][target] = duplicate ? current : [...current, clean].slice(-MAX_REFS_PER_TARGET);
      changed('bind');
      return { ok: true, ref: clean, conflicts };
    },

    /**
     * Changes fields of one reference of a target (axis tuning: invert, deadzone, saturation, expo,
     * smoothing, rate; or a key's shift / mode) in the global layer or craft's override layer. The
     * target's effective references are copied into that layer first, so tuning an inherited
     * binding creates the override. A patch value of null removes that field. Returns { ok, ref }
     * or { ok: false, error }.
     */
    updateRef({ device, target, index, patch, craft = null }) {
      if (!TARGET_IDS.includes(target)) return { ok: false, error: `unknown target ${target}` };
      if (!DEVICE_PATTERN.test(device)) return { ok: false, error: `bad device ${device}` };
      if (!isPlainObject(patch)) return { ok: false, error: 'patch must be an object' };
      const current = copyRefs(getRefs(device, target, craft));
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { ok: false, error: `no reference ${index}` };
      const merged = { ...current[index], ...patch };
      for (const [field, value] of Object.entries(patch)) if (value === null) delete merged[field];
      const clean = sanitizeRef(merged, target);
      if (!clean) return { ok: false, error: 'invalid reference for this target' };
      current[index] = clean;
      const layer = layerFor(craft, true);
      layer[device] ??= {};
      layer[device][target] = current;
      changed('tune');
      return { ok: true, ref: { ...clean } };
    },

    /** Removes one reference (or all when ref is omitted, leaving the target deliberately unbound). */
    unbind({ device, target, craft = null, ref = null }) {
      if (!TARGET_IDS.includes(target)) return false;
      const layer = layerFor(craft, true);
      layer[device] ??= {};
      const current = copyRefs(getRefs(device, target, craft));
      const serialized = ref ? JSON.stringify(sanitizeRef(ref, target)) : null;
      layer[device][target] = serialized ? current.filter((existing) => JSON.stringify(existing) !== serialized) : [];
      changed('unbind');
      return true;
    },

    /**
     * Frees the inputs ref occupies from every other target on device (the "replace" answer to a
     * conflict warning), in the global layer or craft's override layer. A plain key reference that
     * only answers the Shift variant as a fallback is narrowed to plain presses (shift: false)
     * instead of being removed. Returns the targets that changed.
     */
    releaseInputs({ device, target, ref, craft = null }) {
      if (!TARGET_IDS.includes(target) || !DEVICE_PATTERN.test(device)) return [];
      const clean = sanitizeRef(ref, target);
      if (!clean) return [];
      const wanted = new Set(refInputs(clean));
      const changedTargets = [];
      for (const other of TARGET_IDS) {
        if (other === target) continue;
        let modified = false;
        const kept = [];
        for (const existing of getRefs(device, other, craft)) {
          if (refInputs(existing).some((input) => wanted.has(input))) {
            modified = true;
            continue;
          }
          if (existing.type === 'key' && existing.shift === undefined) {
            const shiftInputs = (existing.mode ? [existing.mode] : MODES).map((mode) => `${mode}|key:${existing.code}|shift`);
            if (shiftInputs.some((input) => wanted.has(input))) {
              kept.push({ ...existing, shift: false });
              modified = true;
              continue;
            }
          }
          kept.push({ ...existing });
        }
        if (!modified) continue;
        const layer = layerFor(craft, true);
        layer[device] ??= {};
        layer[device][other] = kept;
        changedTargets.push(other);
      }
      if (changedTargets.length > 0) changed('release');
      return changedTargets;
    },

    /** Drops an override so the target inherits again (craft -> global -> default). */
    clearOverride({ device, target, craft = null }) {
      const layer = layerFor(craft, false);
      if (!layer?.[device] || !(target in layer[device])) return false;
      delete layer[device][target];
      if (Object.keys(layer[device]).length === 0) delete layer[device];
      if (craft && Object.keys(profile.crafts[craft]).length === 0) delete profile.crafts[craft];
      changed('clear');
      return true;
    },

    /**
     * Reset to defaults: everything, one device (all layers), one craft's overrides, or one device
     * inside one craft.
     */
    resetToDefaults({ device = null, craft = null } = {}) {
      if (!device && !craft) {
        profile = { ...emptyProfile(), devices: profile.devices };
      } else if (craft) {
        if (device) delete profile.crafts[craft]?.[device];
        else delete profile.crafts[craft];
        if (profile.crafts[craft] && Object.keys(profile.crafts[craft]).length === 0) delete profile.crafts[craft];
      } else {
        delete profile.global[device];
        for (const craftId of Object.keys(profile.crafts)) {
          delete profile.crafts[craftId][device];
          if (Object.keys(profile.crafts[craftId]).length === 0) delete profile.crafts[craftId];
        }
      }
      changed('reset');
    },

    findConflicts,
    conflictsFor,

    /** Every conflict on every known binding device (global layer and each craft). */
    findAllConflicts() {
      const conflicts = [];
      const devices = this.listDevices().map((entry) => entry.device);
      for (const craft of [null, ...Object.keys(profile.crafts)]) {
        for (const device of devices) {
          for (const conflict of findConflicts({ device, craft })) conflicts.push({ ...conflict, craft });
        }
      }
      return conflicts;
    },

    /** A deep copy of the stored profile (overrides only). */
    getProfile() {
      return structuredClone(profile);
    },

    /** JSON text of the whole binding profile, for saving to a file. */
    exportJSON() {
      return JSON.stringify({ kind: EXPORT_KIND, version: PROFILE_VERSION, exportedAt: new Date().toISOString(), profile }, null, 2);
    },

    /**
     * Replaces the profile with an exported one. Returns { ok, errors }: ok is false (nothing
     * changed) when the text is not a DRIFTWING binding export; invalid entries are dropped and
     * listed in errors.
     */
    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return { ok: false, errors: [`not valid JSON: ${error.message}`] };
      }
      if (!isPlainObject(parsed) || parsed.kind !== EXPORT_KIND || !isPlainObject(parsed.profile)) {
        return { ok: false, errors: ['not a DRIFTWING bindings export'] };
      }
      if (!Number.isInteger(parsed.version) || parsed.version > PROFILE_VERSION) {
        return { ok: false, errors: [`unsupported bindings version ${parsed.version}`] };
      }
      const result = sanitizeProfile(parsed.profile);
      profile = result.profile;
      changed('import');
      return { ok: true, errors: result.errors };
    },
  };
}
