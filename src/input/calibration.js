// Calibration data per device (IndexedDB 'input.calibration.<deviceKey>') and the calibration
// wizard step machine the controls panel drives.
//
// A calibration record:
//   { version, deviceKey, profile, name, calibratedAt,
//     axes: { [index]: { min, center, max, reversed? } | { idle, full } },
//     hats: [ { form: 'axis', axis, center, values: { up: v, ... } }
//           | { form: 'buttons', buttons: [i], combos: { up: [i], upRight: [i, j], ... } } ],
//     notes: [text] }
//
// Wizard order (spec): centre everything; move each axis lock to lock; throttle full forward;
// pedals full left / full right and each toe brake; press each hat direction. The wizard reads live
// raw values through sample() every frame and learns everything from them: centres, ranges,
// throttle direction, rudder direction, brake travel, and each hat's form, centre and 8 directions.

import { HAT_DIRECTIONS, HAT_DIRECTION_LABELS, buttonSignature, compileHat } from './hats.js';
import { DEVICE_PROFILES } from './hotas/devices.js';

export const CALIBRATION_PREFIX = 'input.calibration.';
const RECORD_VERSION = 1;
/** Raw values beyond this magnitude are not axis positions: an axis resting there is a hat. */
const HAT_REST_THRESHOLD = 1.01;
/** Travel (raw units, full range 2) an axis must show to count as moved lock to lock. */
const FULL_TRAVEL = 1.5;
/** Travel below which an axis is treated as absent and keeps its defaults. */
const MIN_TRAVEL = 0.3;
/** Deviation from centre that counts as a hat press / a pedal deflection. */
const HAT_PRESS_DELTA = 0.05;
const DEFLECTION_READY = 0.5;
/** A hat reading must hold this long before it is recorded (lets diagonals settle). */
const HAT_STABLE_SECONDS = 0.12;
const CENTER_SAMPLES = 30;

export const PEDAL_NOTE = 'Keep pedals centered and feet off when plugging in.';

const STEP_TEXT = Object.freeze({
  center: {
    title: 'Center everything',
    prompt: 'Let go of the stick, put the mini-stick, rocker and twist in the middle and take your feet off the pedals.',
  },
  axes: {
    title: 'Move each axis lock to lock',
    prompt: 'Move every axis to both ends: stick in a full circle, twist both ways, throttle, rocker, antenna, mini-stick and pedals.',
  },
  throttle: {
    title: 'Throttle full forward',
    prompt: 'Push the throttle (and the stick\'s throttle slider) fully forward and hold it there.',
  },
  pedals: {
    title: 'Pedals and toe brakes',
    prompt: 'Follow the pedal prompts; press Next while holding each position.',
  },
  hats: {
    title: 'Press each hat direction',
    prompt: 'Press and release the hat in the direction shown. Diagonals press two ways at once.',
  },
  done: {
    title: 'Calibration complete',
    prompt: 'Save to keep these results for this stick and throttle.',
  },
});

const PEDAL_SUBSTEPS = Object.freeze([
  { id: 'rudderLeft', prompt: 'Push the rudder pedals fully LEFT and hold.' },
  { id: 'rudderRight', prompt: 'Push the rudder pedals fully RIGHT and hold.' },
  { id: 'brakeLeft', prompt: 'Press the LEFT toe brake all the way and hold.' },
  { id: 'brakeRight', prompt: 'Press the RIGHT toe brake all the way and hold.' },
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates a stored record; returns a clean record or null. */
function sanitizeRecord(raw, deviceKey) {
  if (!isPlainObject(raw) || raw.deviceKey !== deviceKey) return null;
  const record = {
    version: RECORD_VERSION,
    deviceKey,
    profile: typeof raw.profile === 'string' ? raw.profile : 'generic',
    name: typeof raw.name === 'string' ? raw.name : deviceKey,
    calibratedAt: typeof raw.calibratedAt === 'string' ? raw.calibratedAt : null,
    axes: {},
    hats: [],
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note) => typeof note === 'string').slice(0, 20) : [],
  };
  if (isPlainObject(raw.axes)) {
    for (const [index, entry] of Object.entries(raw.axes)) {
      if (!/^\d{1,2}$/.test(index) || !isPlainObject(entry)) continue;
      if (Number.isFinite(entry.idle) && Number.isFinite(entry.full)) {
        record.axes[index] = { idle: entry.idle, full: entry.full };
      } else if (Number.isFinite(entry.min) && Number.isFinite(entry.center) && Number.isFinite(entry.max) && entry.min <= entry.center && entry.center <= entry.max) {
        record.axes[index] = { min: entry.min, center: entry.center, max: entry.max };
        if (entry.reversed === true) record.axes[index].reversed = true;
      }
    }
  }
  if (Array.isArray(raw.hats)) {
    for (const hat of raw.hats.slice(0, 4)) {
      if (compileHat(hat)) record.hats.push(structuredClone(hat));
      else record.hats.push(null);
    }
  }
  return record;
}

/**
 * Calibration store: load / save / reset per device key, compiled hats cached per record.
 * storage: core/storage. onChange listeners receive { deviceKey }.
 */
export function createCalibrationStore({ storage }) {
  const records = new Map();
  const compiledHats = new Map();
  const listeners = new Set();

  function load(deviceKey) {
    if (records.has(deviceKey)) return records.get(deviceKey);
    const record = sanitizeRecord(storage.read(`${CALIBRATION_PREFIX}${deviceKey}`, null), deviceKey);
    records.set(deviceKey, record);
    compiledHats.set(deviceKey, record ? record.hats.map((hat) => compileHat(hat)) : []);
    return record;
  }

  function notify(deviceKey) {
    for (const listener of listeners) listener({ deviceKey });
  }

  return {
    /** The calibration record of a device, or null when it has never been calibrated. */
    get(deviceKey) {
      const record = load(deviceKey);
      return record ? structuredClone(record) : null;
    },

    /** Live (not copied) record for the per-frame pipeline; do not mutate. */
    peek(deviceKey) {
      return load(deviceKey);
    },

    /** Compiled hats of a device for decoding (index-aligned with record.hats). */
    hats(deviceKey) {
      load(deviceKey);
      return compiledHats.get(deviceKey) ?? [];
    },

    save(deviceKey, record) {
      const clean = sanitizeRecord({ ...record, deviceKey }, deviceKey);
      if (!clean) throw new Error(`invalid calibration for ${deviceKey}`);
      records.set(deviceKey, clean);
      compiledHats.set(deviceKey, clean.hats.map((hat) => compileHat(hat)));
      storage.write(`${CALIBRATION_PREFIX}${deviceKey}`, clean);
      notify(deviceKey);
      return structuredClone(clean);
    },

    reset(deviceKey) {
      records.set(deviceKey, null);
      compiledHats.set(deviceKey, []);
      storage.remove(`${CALIBRATION_PREFIX}${deviceKey}`);
      notify(deviceKey);
    },

    /** Device keys that have a stored calibration. */
    keys() {
      return storage.keys(CALIBRATION_PREFIX).map((key) => key.slice(CALIBRATION_PREFIX.length));
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Starts a calibration wizard.
 *   readDevices(): live devices [{ deviceKey, profile, name, axes: raw[], buttons: bool[] }]
 *   roleAxes(deviceKey): { throttle: [i], rudder: [i], brakeL: [i], brakeR: [i], unipolar: [i] }
 *     from the current bindings (which axes play which role on that device)
 *   store: the calibration store (finish() saves into it)
 * Drive it with sample(seconds) every frame and next() / back() / skip() / cancel() / finish()
 * from the UI; getState() returns everything a wizard screen needs, onChange(listener) fires on
 * every step change.
 */
export function createCalibrationWizard({ readDevices, roleAxes, store }) {
  const steps = ['center', 'axes', 'throttle', 'pedals', 'hats', 'done'];
  const listeners = new Set();
  /** Per device: learned values. */
  const learned = new Map();
  let stepIndex = 0;
  let pedalIndex = 0;
  let hatQueue = [];
  let hatIndex = 0;
  let hatDirectionIndex = 0;
  let hatCandidate = null;
  let hatAwaitRelease = false;
  let finished = false;
  let cancelled = false;

  function deviceState(device) {
    let entry = learned.get(device.deviceKey);
    if (!entry) {
      entry = {
        deviceKey: device.deviceKey,
        profile: device.profile,
        name: device.name,
        centerSamples: [],
        center: [],
        min: [],
        max: [],
        captures: {},
        hatAxes: [],
        hats: [],
        notes: [],
      };
      learned.set(device.deviceKey, entry);
    }
    return entry;
  }

  function emit() {
    for (const listener of listeners) listener();
  }

  function currentStep() {
    return steps[stepIndex];
  }

  function devicesWithRole(role) {
    const result = [];
    for (const device of readDevices()) {
      const axes = roleAxes(device.deviceKey)[role] ?? [];
      if (axes.length > 0) result.push({ device, axes });
    }
    return result;
  }

  function pedalRole(substepId) {
    return substepId === 'rudderLeft' || substepId === 'rudderRight' ? 'rudder' : substepId === 'brakeLeft' ? 'brakeL' : 'brakeR';
  }

  /** Records the centre of every axis from the recent samples and finds axis-form hats. */
  function commitCenter() {
    for (const device of readDevices()) {
      const entry = deviceState(device);
      const samples = entry.centerSamples.length > 0 ? entry.centerSamples : [device.axes];
      entry.center = device.axes.map((unused, axisIndex) => {
        let sum = 0;
        let count = 0;
        for (const sample of samples) {
          if (Number.isFinite(sample[axisIndex])) {
            sum += sample[axisIndex];
            count++;
          }
        }
        return count > 0 ? sum / count : 0;
      });
      entry.hatAxes = entry.center.map((value, axisIndex) => (Math.abs(value) > HAT_REST_THRESHOLD ? axisIndex : -1)).filter((axisIndex) => axisIndex >= 0);
      entry.min = entry.center.slice();
      entry.max = entry.center.slice();
    }
  }

  function buildHatQueue() {
    hatQueue = [];
    for (const device of readDevices()) {
      const entry = deviceState(device);
      const profileHats = DEVICE_PROFILES[device.profile]?.hats ?? [];
      const count = Math.max(profileHats.length, entry.hatAxes.length);
      for (let index = 0; index < count; index++) {
        hatQueue.push({ deviceKey: device.deviceKey, index, label: profileHats[index]?.label ?? `${device.name} hat ${index + 1}` });
      }
    }
    hatIndex = 0;
    hatDirectionIndex = 0;
    hatCandidate = null;
    hatAwaitRelease = false;
  }

  function enterStep(index) {
    stepIndex = Math.max(0, Math.min(index, steps.length - 1));
    const step = currentStep();
    if (step === 'center') for (const entry of learned.values()) entry.centerSamples = [];
    if (step === 'pedals') {
      pedalIndex = 0;
      if (devicesWithRole('rudder').length === 0 && devicesWithRole('brakeL').length === 0 && devicesWithRole('brakeR').length === 0) {
        enterStep(stepIndex + 1);
        return;
      }
    }
    if (step === 'throttle' && devicesWithRole('throttle').length === 0) {
      enterStep(stepIndex + 1);
      return;
    }
    if (step === 'hats') {
      buildHatQueue();
      if (hatQueue.length === 0) {
        enterStep(stepIndex + 1);
        return;
      }
    }
    emit();
  }

  function captureRole(role, captureId) {
    for (const { device, axes } of devicesWithRole(role)) {
      const entry = deviceState(device);
      for (const axisIndex of axes) entry.captures[`${captureId}:${axisIndex}`] = device.axes[axisIndex];
    }
  }

  /** Hat learning: watch the hat's device for an axis leaving its centre or buttons pressed. */
  function sampleHat(seconds) {
    const target = hatQueue[hatIndex];
    if (!target) return;
    const device = readDevices().find((candidate) => candidate.deviceKey === target.deviceKey);
    if (!device) return;
    const entry = deviceState(device);
    entry.hats[target.index] ??= null;
    let learnedHat = entry.hats[target.index];
    const claimedAxes = new Set(entry.hats.filter((hat) => hat?.form === 'axis').map((hat) => hat.axis));
    const reading = readHat(device, entry, learnedHat, claimedAxes);
    if (hatAwaitRelease) {
      if (!reading.active) hatAwaitRelease = false;
      return;
    }
    if (!reading.active) {
      hatCandidate = null;
      return;
    }
    if (!hatCandidate || hatCandidate.signature !== reading.signature) {
      hatCandidate = { signature: reading.signature, held: 0, reading };
      return;
    }
    hatCandidate.held += seconds;
    if (hatCandidate.held < HAT_STABLE_SECONDS) return;
    const direction = HAT_DIRECTIONS[hatDirectionIndex];
    if (!learnedHat) {
      learnedHat = reading.form === 'axis'
        ? { form: 'axis', axis: reading.axis, center: entry.center[reading.axis], values: {} }
        : { form: 'buttons', buttons: [], combos: {} };
      entry.hats[target.index] = learnedHat;
    }
    if (learnedHat.form === 'axis') {
      learnedHat.values[direction] = reading.value;
    } else {
      learnedHat.combos[direction] = reading.buttons.slice();
      learnedHat.buttons = [...new Set([...learnedHat.buttons, ...reading.buttons])].sort((first, second) => first - second);
    }
    hatCandidate = null;
    hatAwaitRelease = true;
    advanceHatDirection();
  }

  /** Current hat reading on a device: { active, form, axis?, value?, buttons?, signature }. */
  function readHat(device, entry, learnedHat, claimedAxes) {
    if (learnedHat?.form === 'axis' || !learnedHat) {
      const candidates = learnedHat ? [learnedHat.axis] : entry.hatAxes.filter((axisIndex) => !claimedAxes.has(axisIndex));
      for (const axisIndex of candidates) {
        const value = device.axes[axisIndex];
        if (Number.isFinite(value) && Math.abs(value - entry.center[axisIndex]) > HAT_PRESS_DELTA) {
          return { active: true, form: 'axis', axis: axisIndex, value, signature: `a${axisIndex}:${value.toFixed(3)}` };
        }
      }
      if (learnedHat) return { active: false };
    }
    const claimedButtons = new Set(entry.hats.filter((hat) => hat?.form === 'buttons' && hat !== learnedHat).flatMap((hat) => hat.buttons));
    const pressed = [];
    device.buttons.forEach((isPressed, index) => {
      if (isPressed && !claimedButtons.has(index)) pressed.push(index);
    });
    if (pressed.length === 0 || pressed.length > 2) return { active: false };
    return { active: true, form: 'buttons', buttons: pressed, signature: `b${buttonSignature(pressed)}` };
  }

  function advanceHatDirection() {
    hatDirectionIndex++;
    if (hatDirectionIndex >= HAT_DIRECTIONS.length) {
      hatDirectionIndex = 0;
      hatIndex++;
      if (hatIndex >= hatQueue.length) {
        enterStep(steps.indexOf('done'));
        return;
      }
    }
    emit();
  }

  /** Assembles the calibration records from everything learned so far. */
  function buildResults() {
    const results = [];
    for (const device of readDevices()) {
      const entry = deviceState(device);
      const roles = roleAxes(device.deviceKey);
      const unipolar = new Set(roles.unipolar ?? []);
      const throttleAxes = new Set(roles.throttle ?? []);
      const brakeAxes = new Set([...(roles.brakeL ?? []), ...(roles.brakeR ?? [])]);
      const rudderAxes = new Set(roles.rudder ?? []);
      const hatAxes = new Set(entry.hatAxes);
      const profileAxes = DEVICE_PROFILES[device.profile]?.axes ?? [];
      const axes = {};
      const notes = [];
      entry.center.forEach((center, axisIndex) => {
        if (hatAxes.has(axisIndex)) return;
        const low = entry.min[axisIndex];
        const high = entry.max[axisIndex];
        const travel = high - low;
        const label = profileAxes.find((axis) => axis.index === axisIndex)?.label ?? `Axis ${axisIndex + 1}`;
        if (throttleAxes.has(axisIndex) || (unipolar.has(axisIndex) && !brakeAxes.has(axisIndex))) {
          const forward = entry.captures[`throttle:${axisIndex}`];
          if (travel < MIN_TRAVEL && !Number.isFinite(forward)) return;
          let full;
          if (Number.isFinite(forward)) full = forward;
          else {
            const idleGuess = profileAxes.find((axis) => axis.index === axisIndex)?.idleRaw ?? -1;
            full = Math.abs(high - idleGuess) > Math.abs(low - idleGuess) ? high : low;
          }
          const idle = travel >= MIN_TRAVEL ? (Math.abs(high - full) > Math.abs(low - full) ? high : low) : (full >= 0 ? -1 : 1);
          if (Math.abs(full - idle) < MIN_TRAVEL) {
            notes.push(`${label}: not enough travel, defaults kept`);
            return;
          }
          axes[axisIndex] = { idle, full };
          return;
        }
        if (brakeAxes.has(axisIndex)) {
          const captureId = (roles.brakeL ?? []).includes(axisIndex) ? 'brakeLeft' : 'brakeRight';
          const pressed = entry.captures[`${captureId}:${axisIndex}`];
          const idle = center;
          const full = Number.isFinite(pressed) && Math.abs(pressed - idle) >= MIN_TRAVEL ? pressed : (Math.abs(high - idle) > Math.abs(low - idle) ? high : low);
          if (Math.abs(full - idle) < MIN_TRAVEL) {
            notes.push(`${label}: brake did not move, defaults kept`);
            return;
          }
          axes[axisIndex] = { idle, full };
          return;
        }
        if (travel < MIN_TRAVEL) return;
        if (travel < FULL_TRAVEL) notes.push(`${label}: moved only ${Math.round((travel / 2) * 100)}% of its range`);
        const record = { min: Math.min(low, center), center, max: Math.max(high, center) };
        if (rudderAxes.has(axisIndex)) {
          const left = entry.captures[`rudderLeft:${axisIndex}`];
          const right = entry.captures[`rudderRight:${axisIndex}`];
          if (Number.isFinite(left) && Number.isFinite(right) && right < left) record.reversed = true;
        }
        axes[axisIndex] = record;
      });
      const hats = entry.hats.map((hat) => (hat && compileHat(hat) ? structuredClone(hat) : null));
      results.push({
        deviceKey: device.deviceKey,
        profile: device.profile,
        name: device.name,
        calibratedAt: new Date().toISOString(),
        axes,
        hats,
        notes: [...entry.notes, ...notes],
      });
    }
    return results;
  }

  function axisReadout(device, entry) {
    const hatAxes = new Set(entry.hatAxes);
    const labels = DEVICE_PROFILES[device.profile]?.axes ?? [];
    return device.axes.map((raw, axisIndex) => {
      const travel = (entry.max[axisIndex] ?? raw) - (entry.min[axisIndex] ?? raw);
      return {
        index: axisIndex,
        label: labels.find((axis) => axis.index === axisIndex)?.label ?? `Axis ${axisIndex + 1}`,
        raw,
        center: entry.center[axisIndex] ?? null,
        min: entry.min[axisIndex] ?? null,
        max: entry.max[axisIndex] ?? null,
        travel,
        done: travel >= FULL_TRAVEL,
        hat: hatAxes.has(axisIndex),
      };
    });
  }

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Feeds live readings; call every frame while the wizard is open. */
    sample(seconds) {
      if (finished || cancelled) return;
      const step = currentStep();
      for (const device of readDevices()) {
        const entry = deviceState(device);
        if (step === 'center') {
          entry.centerSamples.push(device.axes.slice());
          if (entry.centerSamples.length > CENTER_SAMPLES) entry.centerSamples.shift();
        } else if (step === 'axes' || step === 'throttle' || step === 'pedals') {
          device.axes.forEach((raw, axisIndex) => {
            if (!Number.isFinite(raw) || Math.abs(raw) > HAT_REST_THRESHOLD || entry.hatAxes.includes(axisIndex)) return;
            entry.min[axisIndex] = Math.min(entry.min[axisIndex] ?? raw, raw);
            entry.max[axisIndex] = Math.max(entry.max[axisIndex] ?? raw, raw);
          });
        }
      }
      if (step === 'hats') sampleHat(seconds);
    },

    getState() {
      const step = currentStep();
      const devices = readDevices().map((device) => {
        const entry = deviceState(device);
        return { deviceKey: device.deviceKey, name: device.name, axes: axisReadout(device, entry), roles: roleAxes(device.deviceKey) };
      });
      const state = {
        step,
        stepIndex,
        steps: steps.slice(),
        title: STEP_TEXT[step].title,
        prompt: STEP_TEXT[step].prompt,
        note: PEDAL_NOTE,
        substep: null,
        hat: null,
        devices,
        canAdvance: devices.length > 0,
        finished,
        cancelled,
      };
      if (step === 'pedals') {
        const substep = PEDAL_SUBSTEPS[pedalIndex];
        const role = pedalRole(substep.id);
        const holders = devicesWithRole(role);
        const deflected = holders.some(({ device, axes }) => {
          const entry = deviceState(device);
          return axes.some((axisIndex) => Math.abs(device.axes[axisIndex] - (entry.center[axisIndex] ?? 0)) >= DEFLECTION_READY);
        });
        state.substep = { id: substep.id, index: pedalIndex, total: PEDAL_SUBSTEPS.length, prompt: substep.prompt, available: holders.length > 0, ready: deflected };
        state.prompt = substep.prompt;
      }
      if (step === 'hats') {
        const target = hatQueue[hatIndex];
        if (target) {
          const direction = HAT_DIRECTIONS[hatDirectionIndex];
          const learnedHat = learned.get(target.deviceKey)?.hats[target.index] ?? null;
          const learnedDirections = learnedHat
            ? HAT_DIRECTIONS.filter((candidate) => (learnedHat.form === 'axis' ? Number.isFinite(learnedHat.values[candidate]) : Array.isArray(learnedHat.combos[candidate])))
            : [];
          state.hat = {
            deviceKey: target.deviceKey,
            label: target.label,
            index: hatIndex,
            total: hatQueue.length,
            direction,
            directionIndex: hatDirectionIndex,
            waitingForRelease: hatAwaitRelease,
            form: learnedHat?.form ?? null,
            learned: learnedDirections,
          };
          state.prompt = `${target.label}: press ${HAT_DIRECTION_LABELS[direction].toUpperCase()}, then release.`;
        }
      }
      if (step === 'done') state.results = buildResults();
      return state;
    },

    /** Confirms the current step (or pedal position) and moves on. */
    next() {
      if (finished || cancelled) return this.getState();
      const step = currentStep();
      if (step === 'center') {
        commitCenter();
        enterStep(stepIndex + 1);
      } else if (step === 'axes') {
        enterStep(stepIndex + 1);
      } else if (step === 'throttle') {
        captureRole('throttle', 'throttle');
        enterStep(stepIndex + 1);
      } else if (step === 'pedals') {
        const substep = PEDAL_SUBSTEPS[pedalIndex];
        captureRole(pedalRole(substep.id), substep.id);
        pedalIndex++;
        if (pedalIndex >= PEDAL_SUBSTEPS.length) enterStep(stepIndex + 1);
        else emit();
      } else if (step === 'hats') {
        advanceHatDirection();
      } else if (step === 'done') {
        this.finish();
      }
      return this.getState();
    },

    /** Skips the current pedal position or hat direction (or the whole step elsewhere). */
    skip() {
      const step = currentStep();
      if (step === 'hats') {
        hatCandidate = null;
        hatAwaitRelease = false;
        advanceHatDirection();
      } else if (step === 'pedals') {
        pedalIndex++;
        if (pedalIndex >= PEDAL_SUBSTEPS.length) enterStep(stepIndex + 1);
        else emit();
      } else if (step !== 'done') {
        if (step === 'center') commitCenter();
        enterStep(stepIndex + 1);
      }
      return this.getState();
    },

    /** Goes back one step (restarting that step). */
    back() {
      if (stepIndex > 0 && !finished) {
        let target = stepIndex - 1;
        while (target > 0 && ((steps[target] === 'throttle' && devicesWithRole('throttle').length === 0) || (steps[target] === 'pedals' && devicesWithRole('rudder').length === 0 && devicesWithRole('brakeL').length === 0 && devicesWithRole('brakeR').length === 0))) target--;
        enterStep(target);
      }
      return this.getState();
    },

    cancel() {
      cancelled = true;
      emit();
    },

    /** Saves the learned results for every device and ends the wizard. Returns the saved records. */
    finish() {
      if (finished || cancelled) return [];
      const saved = buildResults().map((result) => store.save(result.deviceKey, result));
      finished = true;
      stepIndex = steps.indexOf('done');
      emit();
      return saved;
    },

    get finished() { return finished; },
    get cancelled() { return cancelled; },
  };
}
