// Bind-by-listening: waits for the next key, mouse button, controller button, hat direction or
// axis movement and turns it into a binding reference for the target being bound.
//
// Action targets take one input: a key (with Shift when held), a mouse button (not the left
// button, which the player needs to click the panel), a controller button, a learned hat
// direction, or an axis pushed past half travel (an axisPress). Axis targets take a controller
// axis moved past half travel, or two inputs in turn: a positive then a negative key (keys) or
// button (buttonAxis for spring axes, buttonRate for levers such as the throttle).
//
// Baselines are taken from the latest readings when the session starts (and when a device first
// appears during it), so a stick resting off-centre or a button already held does not bind
// itself. Escape cancels. Tab is never captured: it stays the key that moves focus through panels.

import { AXIS_TARGETS } from './defaultBindings.js';
import { isAxisTarget } from './bindings.js';
import { DEVICE_PROFILES } from './hotas/devices.js';

const AXIS_CAPTURE_TRAVEL = 0.5;
/** Raw magnitude beyond which a resting axis value is a hat's centre, not an axis position. */
const HAT_REST_THRESHOLD = 1.01;
const KEY_RATE = 0.5;
const BUTTON_RATE = 0.6;
/** Keys a listen lets through: modifiers (combined with the next key) and Tab (moves focus on). */
const IGNORED_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Tab']);

/**
 * registry: gamepad registry; calibration: calibration store (learned hats); mapper: device
 * mapper (decoded hat directions).
 */
export function createInputCapture({ registry, calibration, mapper }) {
  let session = null;
  const listeners = new Set();

  function emit() {
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  function getState() {
    if (!session) return { active: false };
    return {
      active: true,
      target: session.target,
      expects: session.expects,
      device: session.device,
      stage: session.first ? 'negative' : 'first',
      first: session.first ? { device: session.first.device, label: session.first.label } : null,
      remainingMs: Math.max(0, session.timeoutMs - (performance.now() - session.startedAt)),
    };
  }

  function finish(result) {
    if (!session) return;
    const { resolve } = session;
    session = null;
    resolve(result);
    emit();
  }

  /** session.device is null (any device), one binding device, or a list of them. */
  function accepts(device) {
    if (!session.device) return true;
    return Array.isArray(session.device) ? session.device.includes(device) : session.device === device;
  }

  function isLever(target) {
    return AXIS_TARGETS[target]?.combine === 'position';
  }

  /** Second half of a two-input axis binding, or the first half recorded. */
  function takePair(device, kind, value, label) {
    if (!session.first) {
      session.first = { device, kind, value, label };
      emit();
      return;
    }
    if (session.first.device !== device || session.first.kind !== kind || session.first.value === value) return;
    const positive = session.first.value;
    const lever = isLever(session.target);
    if (kind === 'key') {
      finish({ ok: true, device, ref: lever ? { type: 'keys', positive, negative: value, rate: KEY_RATE } : { type: 'keys', positive, negative: value } });
    } else {
      finish({ ok: true, device, ref: lever ? { type: 'buttonRate', positive, negative: value, rate: BUTTON_RATE } : { type: 'buttonAxis', positive, negative: value } });
    }
  }

  /** Axes that are hats on this device (learned axis-form hats, or resting out of range). */
  function hatAxes(device, baseline) {
    const axes = new Set();
    for (const hat of calibration.hats(device.deviceKey)) if (hat?.form === 'axis') axes.add(hat.axis);
    baseline.axes.forEach((value, axisIndex) => {
      if (Math.abs(value) > HAT_REST_THRESHOLD) axes.add(axisIndex);
    });
    return axes;
  }

  function hatButtons(device) {
    const buttons = new Set();
    for (const hat of calibration.hats(device.deviceKey)) if (hat?.form === 'buttons') for (const index of hat.buttons) buttons.add(index);
    return buttons;
  }

  function takeBaseline(device) {
    session.baselines.set(device.deviceKey, {
      axes: device.axes.slice(),
      buttons: device.buttons.map((button) => button.pressed),
      hats: mapper.hatDirections(device.deviceKey),
    });
  }

  /**
   * Direction of an axis press in the terms the device mapper tests it: the calibrated, normalized
   * reading, not the raw travel. A one-sided axis (throttle, antenna, slider: 0 at idle, 1 at full)
   * reads 0..1, so it can only press toward full, whichever way its raw value runs. A bipolar axis
   * takes the sign of its normalized change, so a reversed calibration (pedal rudder) flips with it.
   */
  function pressDirection(device, baseline, axisIndex, travel) {
    const reading = mapper.readAxis(device, axisIndex);
    if (reading.range === 'unipolar') return 1;
    const rest = mapper.readAxis({ ...device, axes: baseline.axes }, axisIndex);
    const change = reading.value - rest.value;
    if (change !== 0) return change > 0 ? 1 : -1;
    return travel > 0 ? 1 : -1;
  }

  function sampleDevice(device) {
    const bindingDevice = device.bindingDevice;
    if (!accepts(bindingDevice)) return;
    const baseline = session.baselines.get(device.deviceKey);
    if (!baseline) {
      takeBaseline(device);
      return;
    }
    const target = session.target;
    const hats = mapper.hatDirections(device.deviceKey);
    if (session.expects === 'action') {
      for (let hatIndex = 0; hatIndex < hats.length; hatIndex++) {
        if (hats[hatIndex] && hats[hatIndex] !== baseline.hats[hatIndex]) {
          finish({ ok: true, device: bindingDevice, ref: { type: 'hat', hat: hatIndex, direction: hats[hatIndex] } });
          return;
        }
      }
    }
    const skipButtons = hatButtons(device);
    for (let buttonIndex = 0; buttonIndex < device.buttons.length; buttonIndex++) {
      const pressed = device.buttons[buttonIndex].pressed;
      if (!pressed) {
        baseline.buttons[buttonIndex] = false;
        continue;
      }
      if (baseline.buttons[buttonIndex] || skipButtons.has(buttonIndex)) continue;
      baseline.buttons[buttonIndex] = true;
      if (session.expects === 'action') {
        finish({ ok: true, device: bindingDevice, ref: { type: 'button', index: buttonIndex } });
      } else {
        takePair(bindingDevice, 'button', buttonIndex, `${device.name} button ${buttonIndex + 1}`);
      }
      return;
    }
    const skipAxes = hatAxes(device, baseline);
    for (let axisIndex = 0; axisIndex < device.axes.length; axisIndex++) {
      if (skipAxes.has(axisIndex)) continue;
      const travel = device.axes[axisIndex] - (baseline.axes[axisIndex] ?? 0);
      if (!(Math.abs(travel) > AXIS_CAPTURE_TRAVEL)) continue;
      if (session.expects === 'action') {
        finish({ ok: true, device: bindingDevice, ref: { type: 'axisPress', axis: axisIndex, direction: pressDirection(device, baseline, axisIndex, travel) } });
        return;
      }
      if (session.first) return;
      const profileAxis = DEVICE_PROFILES[device.profile]?.axes.find((axis) => axis.index === axisIndex);
      const range = profileAxis?.range ?? AXIS_TARGETS[target].range;
      const ref = { type: 'axis', axis: axisIndex };
      if (range !== 'bipolar' || AXIS_TARGETS[target].range !== 'bipolar') ref.range = range;
      finish({ ok: true, device: bindingDevice, ref });
      return;
    }
  }

  return {
    get active() { return session !== null; },
    getState,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Starts listening for target. device limits the search to one binding device ('keyboard',
     * 'mouse', 'gamepad' or a HOTAS device key) or a list of them; null accepts any. Resolves with
     * { ok: true, device, ref } or { ok: false, reason: 'cancelled' | 'timeout' | 'replaced' }.
     */
    start({ target, device = null, timeoutMs = 10000 }) {
      if (session) finish({ ok: false, reason: 'replaced' });
      return new Promise((resolve) => {
        session = {
          target,
          device,
          expects: isAxisTarget(target) ? 'axis' : 'action',
          timeoutMs,
          startedAt: performance.now(),
          baselines: new Map(),
          first: null,
          resolve,
        };
        for (const device of registry.live()) if (accepts(device.bindingDevice)) takeBaseline(device);
        emit();
      });
    },

    cancel() {
      finish({ ok: false, reason: 'cancelled' });
    },

    /** A keydown during a session. Returns true when the key was consumed. */
    offerKey(code, shiftHeld) {
      if (!session) return false;
      if (code === 'Escape') {
        finish({ ok: false, reason: 'cancelled' });
        return true;
      }
      if (IGNORED_KEYS.has(code)) return false;
      if (!accepts('keyboard')) return true;
      if (session.expects === 'action') {
        const ref = { type: 'key', code };
        if (shiftHeld) ref.shift = true;
        finish({ ok: true, device: 'keyboard', ref });
      } else {
        takePair('keyboard', 'key', code, code);
      }
      return true;
    },

    /** A mousedown (not the left button) during a session. Returns true when consumed. */
    offerMouseButton(button) {
      if (!session || button === 0) return false;
      if (session.expects !== 'action' || !accepts('mouse')) return true;
      finish({ ok: true, device: 'mouse', ref: { type: 'mouseButton', button } });
      return true;
    },

    /** Checks every live controller for a new input; call once per frame. */
    sample(devices) {
      if (!session) return;
      if (performance.now() - session.startedAt > session.timeoutMs) {
        finish({ ok: false, reason: 'timeout' });
        return;
      }
      for (const device of devices) {
        sampleDevice(device);
        if (!session) return;
      }
    },
  };
}
