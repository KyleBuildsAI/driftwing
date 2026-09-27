// Applies a controller's bindings to its live readings: axes through the calibration and the axis
// pipeline, hats through their learned decoding, buttons and hats and axis presses into actions.
//
// One mapper serves every Gamepad API device (standard gamepads and HOTAS). For each device and
// frame it adds the device's share into a frame accumulator the input manager combines with the
// keyboard, mouse and touch:
//   spring    roll, pitch, yaw, lookX, lookY: summed, -1..1
//   max       brakeL, brakeR: strongest wins, 0..1
//   positions absolute levers (throttle, antenna, flaps, collective, trim when bound absolute):
//             { target, key, value, moved } candidates; the manager gives the target to the last
//             lever that moved
//   rates     rate references (buttonRate, axis with rate): units per second into a position
// Actions go straight to the action router on press / release edges.

import { AXIS_TARGETS } from './defaultBindings.js';
import { DEFAULT_AXIS_TUNING, createAxisFilter, defaultIdleRaw, shapeAxis } from './axisPipeline.js';
import { decodeHat } from './hats.js';
import { DEVICE_PROFILES, HOTAS_KINDS } from './hotas/devices.js';

/** Axis-press actions trigger past this deflection and release below the lower one. */
const AXIS_PRESS_ON = 0.6;
const AXIS_PRESS_OFF = 0.4;
/** Change that counts as a lever being moved (takes the target over). */
const POSITION_MOVE = 0.02;
/** Change of a pedal rudder axis (from where it first rested) that marks the pedals as in use. */
const RUDDER_MOVE = 0.3;
/** Change on any output that counts as player activity (keeps the HUD awake). */
const ACTIVITY_DELTA = 0.05;

export function createFrameAccumulator() {
  return {
    spring: { roll: 0, pitch: 0, yaw: 0, lookX: 0, lookY: 0 },
    max: { brakeL: 0, brakeR: 0 },
    positions: [],
    rates: {},
    sources: {},
    throttleDirection: 0,
    rudderMoved: false,
    rudderPresent: false,
    activity: false,
  };
}

export function resetFrameAccumulator(frame) {
  for (const target of Object.keys(frame.spring)) frame.spring[target] = 0;
  frame.max.brakeL = 0;
  frame.max.brakeR = 0;
  frame.positions.length = 0;
  frame.rates = {};
  frame.sources = {};
  frame.throttleDirection = 0;
  frame.rudderMoved = false;
  frame.rudderPresent = false;
  frame.activity = false;
  return frame;
}

/**
 * bindings: binding store; calibration: calibration store; router: action router;
 * canPress(actionId, source): the manager's gate for new presses.
 */
export function createDeviceMapper({ bindings, calibration, router, canPress }) {
  /** Per device key: filters, lever baselines, raw press states, rudder rest values, hat states. */
  const deviceStates = new Map();

  function stateFor(deviceKey) {
    let entry = deviceStates.get(deviceKey);
    if (!entry) {
      entry = { filters: new Map(), levers: new Map(), rawPressed: new Map(), rudderRest: new Map(), lastOutputs: new Map(), hats: [] };
      deviceStates.set(deviceKey, entry);
    }
    return entry;
  }

  function filterFor(entry, refKey) {
    let filter = entry.filters.get(refKey);
    if (!filter) {
      filter = createAxisFilter();
      entry.filters.set(refKey, filter);
    }
    return filter;
  }

  /** Decoded direction of every learned hat on a device (null when centred or unlearned). */
  function decodeHats(device, entry) {
    const compiled = calibration.hats(device.deviceKey);
    const pressed = (buttonIndex) => Boolean(device.buttons[buttonIndex]?.pressed);
    entry.hats.length = compiled.length;
    for (let hatIndex = 0; hatIndex < compiled.length; hatIndex++) entry.hats[hatIndex] = decodeHat(compiled[hatIndex], device.axes, pressed);
    return entry.hats;
  }

  /**
   * One axis reading through calibration and the pipeline (without smoothing). range comes from
   * the reference, then the device profile, then the target.
   */
  function axisValue(device, ref, target) {
    const raw = device.axes[ref.axis];
    if (!Number.isFinite(raw)) return null;
    const profileAxis = DEVICE_PROFILES[device.profile]?.axes.find((axis) => axis.index === ref.axis) ?? null;
    const range = ref.range ?? profileAxis?.range ?? AXIS_TARGETS[target]?.range ?? 'bipolar';
    const record = calibration.peek(device.deviceKey);
    const axisCalibration = record?.axes?.[ref.axis] ?? null;
    const idleFallback = defaultIdleRaw(profileAxis, device.restAxes[ref.axis]);
    let value = shapeAxis(raw, range, axisCalibration, ref, idleFallback);
    if (axisCalibration?.reversed && range === 'bipolar') value = -value;
    return { value, range };
  }

  /** Raw press state of an action reference this frame. */
  function refPressed(device, entry, ref, hats, holderKey, target) {
    switch (ref.type) {
      case 'button': return Boolean(device.buttons[ref.index]?.pressed);
      case 'hat': return hats[ref.hat] === ref.direction;
      case 'axisPress': {
        const reading = axisValue(device, { ...ref, deadzone: 0, saturation: 0, expo: 0 }, target);
        if (!reading) return false;
        const threshold = entry.rawPressed.get(holderKey) ? AXIS_PRESS_OFF : AXIS_PRESS_ON;
        return reading.value * ref.direction > threshold;
      }
      default: return false;
    }
  }

  function buttonValue(device, buttonIndex) {
    const button = device.buttons[buttonIndex];
    if (!button) return 0;
    if (button.value > 0) return button.value;
    return button.pressed ? 1 : 0;
  }

  function noteOutput(entry, key, value, frame) {
    const previous = entry.lastOutputs.get(key);
    if (previous === undefined || Math.abs(previous - value) > ACTIVITY_DELTA) {
      entry.lastOutputs.set(key, value);
      if (previous !== undefined) frame.activity = true;
    }
  }

  /**
   * Routes the device's action references; blocked presses stay blocked until released. Holders
   * whose reference no longer exists (rebound while held) are released.
   */
  function routeActions(device, entry, effective, hats, context) {
    const source = HOTAS_KINDS.includes(device.kind) ? 'hotas' : 'gamepad';
    const visited = new Set();
    for (const [actionId, refs] of effective.actions) {
      refs.forEach((ref, refIndex) => {
        const holderKey = `${device.deviceKey}|${actionId}|${refIndex}`;
        visited.add(holderKey);
        const active = context.actionsEnabled && (!ref.mode || ref.mode === context.mode);
        const pressed = active && refPressed(device, entry, ref, hats, holderKey, actionId);
        const wasPressed = entry.rawPressed.get(holderKey) === true;
        entry.rawPressed.set(holderKey, pressed);
        if (pressed && !wasPressed) {
          context.frame.activity = true;
          if (canPress(actionId, source)) router.press(actionId, holderKey, source, device.deviceKey);
        } else if (!pressed && router.isHolding(actionId, holderKey)) {
          router.release(actionId, holderKey);
        }
      });
    }
    for (const [actionId, holderKey] of router.heldBy(`${device.deviceKey}|`)) {
      if (!visited.has(holderKey)) router.release(actionId, holderKey);
    }
  }

  /** Adds the device's axis references to the frame. */
  function routeAxes(device, entry, effective, context) {
    const { frame, seconds, mode } = context;
    const source = HOTAS_KINDS.includes(device.kind) ? 'hotas' : 'gamepad';
    for (const [target, refs] of effective.axes) {
      const spec = AXIS_TARGETS[target];
      refs.forEach((ref, refIndex) => {
        const refKey = `${target}|${refIndex}`;
        if (ref.mode && ref.mode !== mode) return;
        if (ref.suppressedBy && context.connectedKinds.has(ref.suppressedBy)) return;
        if (ref.role === 'twist' && !context.twistEnabled) {
          entry.filters.get(refKey)?.reset();
          return;
        }
        if (ref.type === 'axis') {
          const reading = axisValue(device, ref, target);
          if (!reading) return;
          const filtered = filterFor(entry, refKey).update(reading.value, ref.smoothing ?? DEFAULT_AXIS_TUNING.smoothing, seconds);
          noteOutput(entry, refKey, filtered, frame);
          if (ref.role === 'rudder') trackRudder(entry, refKey, filtered, frame);
          if (ref.rate) {
            frame.rates[target] = (frame.rates[target] ?? 0) + filtered * ref.rate;
            if (filtered !== 0) frame.sources[target] = source;
            if (target === 'throttle') frame.throttleDirection += filtered;
            return;
          }
          addValue(entry, frame, target, spec, refKey, filtered, source, device.deviceKey);
        } else if (ref.type === 'buttonAxis') {
          const value = buttonValue(device, ref.positive) - buttonValue(device, ref.negative);
          addValue(entry, frame, target, spec, refKey, spec.range === 'unipolar' ? Math.max(0, value) : value, source, device.deviceKey);
        } else if (ref.type === 'buttonRate') {
          const direction = buttonValue(device, ref.positive) - buttonValue(device, ref.negative);
          if (direction !== 0) {
            frame.rates[target] = (frame.rates[target] ?? 0) + direction * ref.rate;
            frame.sources[target] = source;
            frame.activity = true;
            if (target === 'throttle') frame.throttleDirection += direction;
          }
        }
      });
    }
  }

  function addValue(entry, frame, target, spec, refKey, value, source, deviceKey) {
    if (spec.combine === 'sum') {
      frame.spring[target] += value;
      if (value !== 0) frame.sources[target] = source;
    } else if (spec.combine === 'max') {
      if (value > frame.max[target]) {
        frame.max[target] = value;
        frame.sources[target] = source;
      }
    } else {
      const leverKey = `${deviceKey}|${refKey}`;
      const baseline = entry.levers.get(refKey);
      const moved = baseline === undefined || Math.abs(value - baseline) > POSITION_MOVE;
      if (moved) entry.levers.set(refKey, value);
      frame.positions.push({ target, key: leverKey, value, moved, source });
    }
  }

  /** Pedal rudder: remembers where it first rested and reports once it has clearly moved. */
  function trackRudder(entry, refKey, value, frame) {
    frame.rudderPresent = true;
    if (!entry.rudderRest.has(refKey)) entry.rudderRest.set(refKey, value);
    if (Math.abs(value - entry.rudderRest.get(refKey)) > RUDDER_MOVE) frame.rudderMoved = true;
  }

  return {
    /**
     * Evaluates one connected device. context: { frame, craft, mode, seconds, twistEnabled,
     * connectedKinds (Set), actionsEnabled, axesEnabled }.
     */
    evaluate(device, context) {
      const entry = stateFor(device.deviceKey);
      const hats = decodeHats(device, entry);
      const effective = bindings.getEffective(device.bindingDevice, context.craft);
      routeActions(device, entry, effective, hats, context);
      if (context.axesEnabled) routeAxes(device, entry, effective, context);
    },

    /** Latest decoded hat directions of a device (for the controls panel). */
    hatDirections(deviceKey) {
      return deviceStates.get(deviceKey)?.hats.slice() ?? [];
    },

    /** Calibrated, normalized reading of one axis (no deadzone / expo), for live axis bars. */
    readAxis(device, axisIndex) {
      const reading = axisValue(device, { type: 'axis', axis: axisIndex, deadzone: 0, saturation: 0, expo: 0 }, null);
      return reading ? reading : { value: 0, range: 'bipolar' };
    },

    /** Forgets a device's filters and press states (unplugged); its held actions are released. */
    forget(deviceKey) {
      deviceStates.delete(deviceKey);
      router.releasePrefix(`${deviceKey}|`);
    },
  };
}
