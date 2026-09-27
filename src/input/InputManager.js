// InputManager: the 'input' system. Reads keyboard, mouse, touch, standard gamepads and
// Thrustmaster HOTAS devices and writes, every frame:
//   ctx.input     v1's arcade struct, exactly as v1 did for keyboard / mouse / touch (CLASSIC flies
//                 on this), plus the controllers' stick, rudder and throttle
//   ctx.controls  the ControlState (controlState.js) that SIM flight reads each physics tick
// and emits 'input:action' { id, phase, source, device } for every action press and release.
//
// It also owns the binding profile (bindings.js), per-device calibration (calibration.js), the
// calibration wizard, bind-by-listening (capture.js) and hot-plug, and exposes all of it to the
// controls panel through the returned API (see the bottom of this file and docs/controls.md).

import { clamp } from '../core/util.js';
import { installMockGamepads } from '../dev/mockGamepads.js';
import { createActionRouter } from './actions.js';
import { createBindingStore, describeRef } from './bindings.js';
import { createCalibrationStore, createCalibrationWizard, PEDAL_NOTE } from './calibration.js';
import { createInputCapture } from './capture.js';
import { AXIS_TARGETS } from './defaultBindings.js';
import { createDeviceMapper, createFrameAccumulator, resetFrameAccumulator } from './deviceMapper.js';
import { createGamepadRegistry } from './gamepad.js';
import { DEVICE_PROFILES } from './hotas/devices.js';
import { createKeyboardMouse } from './keyboardMouse.js';
import { createTouchInput } from './touch.js';

/** Actions that still work in photo mode (v1's photo-mode hotkey subset, plus push-to-talk). */
const PHOTO_MODE_ACTIONS = new Set(['photoMode', 'timeForward', 'timeBack', 'copilotPTT']);
/** Throttle change per wheel notch in SIM (v1's CLASSIC wheel step). */
const WHEEL_THROTTLE_STEP = 0.05;
/** Position targets other than the throttle: levers moved by absolute axes or rate inputs. */
const LEVER_TARGETS = Object.freeze(['collective', 'flaps', 'trim', 'antenna']);
/** Smallest lever change forwarded to CLASSIC's throttle target (avoids re-sending noise). */
const LEVER_SEND_STEP = 0.002;
const HOTAS_PROMPT = 'Press any button on your stick and throttle';

export function createInputManager(ctx) {
  const { state, settings, bus, input, controls, storage } = ctx;
  const params = new URLSearchParams(window.location.search);
  const debug = params.get('debug') === '1';
  const mock = params.get('test') === 'hotas' ? installMockGamepads() : null;

  const bindings = createBindingStore({ storage });
  const calibration = createCalibrationStore({ storage });
  if (bindings.loadErrors.length > 0) {
    bus.emit('notify', { text: 'Some saved control bindings could not be read and were reset to defaults.', kind: 'warning' });
  }

  let pendingBoost = false;
  let wizard = null;
  let pedalsMoved = false;
  let lastThrottleTarget = input.throttleTarget;
  let lastLeverSent = -1;
  const levers = { throttle: { owner: null }, collective: { owner: null }, flaps: { owner: null }, trim: { owner: null }, antenna: { owner: null } };
  const previousButtons = new Map();
  const deviceFrame = createFrameAccumulator();
  const connectedKinds = new Set();

  const getMode = () => settings.get('mode');
  const getCraft = () => settings.get('craft');
  const markActivity = () => { input.lastActivity = performance.now(); };
  const wizardActive = () => Boolean(wizard && !wizard.finished && !wizard.cancelled);

  const router = createActionRouter({
    bus,
    controls,
    onPress(actionId) {
      // CLASSIC boost is v1's latched input.boost, whatever device pressed it.
      if (actionId === 'boost' && getMode() === 'classic' && !state.photoMode) pendingBoost = true;
    },
  });

  /** Gate for new presses: nothing while binding or (for controllers) calibrating; photo subset. */
  function canPress(actionId, source) {
    if (capture.active) return false;
    if (wizardActive() && (source === 'gamepad' || source === 'hotas')) return false;
    if (state.photoMode && !PHOTO_MODE_ACTIONS.has(actionId)) return false;
    return true;
  }

  const registry = createGamepadRegistry({
    bus,
    debug,
    onConnect(device) {
      if (device.bindingDevice !== 'gamepad') bindings.registerDevice(device.bindingDevice, device.profile, device.name);
      markActivity();
    },
    onDisconnect(device) {
      mapper.forget(device.deviceKey);
      previousButtons.delete(device.deviceKey);
    },
  });
  const mapper = createDeviceMapper({ bindings, calibration, router, canPress });
  const capture = createInputCapture({ registry, calibration, mapper });
  const keyboardMouse = createKeyboardMouse(ctx, { bindings, router, canPress, capture, getMode, getCraft });
  const touch = createTouchInput({ input, router, markActivity });

  // ---- Controllers ---------------------------------------------------------------------------
  /** Twist yaw is used unless the player's pedals are in use (auto) or the setting forces it. */
  function twistEnabled() {
    const setting = settings.get('twistYaw');
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    return !pedalsMoved;
  }

  /**
   * Gamepads do not grant user activation in Chrome, so a button press can only unlock audio when
   * the browser says activation is live (for example right after a click). Never faked.
   */
  function noteButtonPresses(device) {
    let previous = previousButtons.get(device.deviceKey);
    if (!previous) {
      previous = [];
      previousButtons.set(device.deviceKey, previous);
    }
    let pressedNow = false;
    device.buttons.forEach((button, buttonIndex) => {
      if (button.pressed && !previous[buttonIndex]) pressedNow = true;
      previous[buttonIndex] = button.pressed;
    });
    if (!pressedNow) return;
    markActivity();
    if (!ctx.userHasInteracted && navigator.userActivation?.isActive) {
      ctx.userHasInteracted = true;
      bus.emit('user:gesture', {});
    }
  }

  function updateControllers(seconds, mode, craft) {
    if (registry.supported) registry.poll();
    resetFrameAccumulator(deviceFrame);
    connectedKinds.clear();
    for (const device of registry.live()) connectedKinds.add(device.kind);
    const calibrating = wizardActive();
    const axesEnabled = !calibrating && !state.photoMode;
    const context = {
      frame: deviceFrame,
      craft,
      mode,
      seconds,
      twistEnabled: twistEnabled(),
      connectedKinds,
      actionsEnabled: !calibrating,
      axesEnabled,
    };
    for (const device of registry.live()) {
      noteButtonPresses(device);
      mapper.evaluate(device, context);
    }
    if (axesEnabled) {
      if (deviceFrame.rudderMoved) pedalsMoved = true;
      if (!deviceFrame.rudderPresent) pedalsMoved = false;
    }
    if (deviceFrame.activity) markActivity();
    capture.sample(registry.live());
    if (calibrating) wizard.sample(seconds);
  }

  // ---- Levers -----------------------------------------------------------------------------------
  /**
   * Applies absolute levers and rate inputs to one position target. The last lever that moved owns
   * the target; a rate input (keys, buttons, the rocker) takes it over while it is used.
   * Returns true when anything drove the target this frame.
   */
  function updateLever(target, keys, seconds) {
    const lever = levers[target];
    const low = AXIS_TARGETS[target].range === 'bipolar' ? -1 : 0;
    let driven = false;
    for (const candidate of deviceFrame.positions) {
      if (candidate.target !== target) continue;
      if (candidate.moved) lever.owner = candidate.key;
      if (lever.owner !== candidate.key) continue;
      controls[target] = clamp(candidate.value, low, 1);
      controls.sources[target] = candidate.source;
      driven = true;
    }
    const keyRate = keys.rates[target] ?? 0;
    const deviceRate = deviceFrame.rates[target] ?? 0;
    if (keyRate !== 0 || deviceRate !== 0) {
      lever.owner = 'rate';
      controls[target] = clamp(controls[target] + (keyRate + deviceRate) * seconds, low, 1);
      controls.sources[target] = keyRate !== 0 ? 'keyboard' : deviceFrame.sources[target];
      driven = true;
    }
    return driven;
  }

  /**
   * Throttle. CLASSIC keeps v1's path (W / S as throttleDelta, wheel and slider as throttleTarget)
   * and a moved HOTAS or gamepad lever sets throttleTarget too; ControlState mirrors the arcade
   * throttle. SIM moves ControlState.throttle directly: levers, W / S and triggers at a rate, the
   * wheel in v1's steps and the touch slider.
   */
  function updateThrottle(mode, keys, touchFrame, seconds) {
    const lever = levers.throttle;
    if (mode === 'classic') {
      if (input.throttleTarget !== lastThrottleTarget && input.throttleTarget !== null) lever.owner = 'pointer';
      let leverCandidate = null;
      for (const candidate of deviceFrame.positions) {
        if (candidate.target !== 'throttle') continue;
        if (candidate.moved && lever.owner !== candidate.key) {
          lever.owner = candidate.key;
          lastLeverSent = -1;
        }
        if (lever.owner === candidate.key) leverCandidate = candidate;
      }
      if (touchFrame.throttle !== null) {
        input.throttleTarget = touchFrame.throttle;
        lever.owner = 'touch';
      }
      if (leverCandidate && lever.owner === leverCandidate.key && Math.abs(leverCandidate.value - lastLeverSent) > LEVER_SEND_STEP) {
        input.throttleTarget = clamp(leverCandidate.value, 0, 1);
        lastLeverSent = leverCandidate.value;
        controls.sources.throttle = leverCandidate.source;
      }
      const deviceDirection = state.photoMode ? 0 : deviceFrame.throttleDirection;
      input.throttleDelta = clamp(keys.throttleDelta + deviceDirection, -1, 1);
      if (input.throttleDelta !== 0) {
        input.throttleTarget = null;
        lever.owner = 'rate';
      }
      lastThrottleTarget = input.throttleTarget;
      controls.throttle = clamp(Number(state.player.throttle) || 0, 0, 1);
      return;
    }
    input.throttleDelta = 0;
    updateLever('throttle', keys, seconds);
    if (touchFrame.throttle !== null) {
      controls.throttle = touchFrame.throttle;
      controls.sources.throttle = 'touch';
      lever.owner = 'touch';
    }
    if (keys.wheelNotches !== 0) {
      controls.throttle = clamp(controls.throttle - keys.wheelNotches * WHEEL_THROTTLE_STEP, 0, 1);
      controls.sources.throttle = 'mouse';
      lever.owner = 'wheel';
    }
    lastThrottleTarget = input.throttleTarget;
  }

  /** Records which source contributed most to an axis this frame (kept when nothing moved it). */
  function noteSource(axis, contributions) {
    let best = null;
    let bestMagnitude = 0;
    for (const [source, value] of contributions) {
      if (Math.abs(value) > bestMagnitude) {
        bestMagnitude = Math.abs(value);
        best = source;
      }
    }
    if (best) controls.sources[axis] = best;
  }

  // ---- Frame ---------------------------------------------------------------------------------------
  function update(simDt, realDt) {
    const seconds = Math.min(Math.max(realDt, 0), 0.05);
    const mode = getMode();
    const craft = getCraft();
    const photoMode = state.photoMode;
    const invert = settings.get('invertPitch') ? -1 : 1;

    const keys = keyboardMouse.update(seconds, mode);
    const touchFrame = touch.merge(invert, photoMode, mode);
    updateControllers(seconds, mode, craft);
    const pad = deviceFrame.spring;
    const padSource = deviceFrame.sources;

    input.pitch = clamp(keys.pitch + keys.stickPitch + touchFrame.pitch + pad.pitch, -1, 1);
    input.roll = clamp(keys.roll + keys.stickRoll + touchFrame.roll + pad.roll, -1, 1);
    input.yaw = clamp(keys.yaw + pad.yaw, -1, 1);
    updateThrottle(mode, keys, touchFrame, seconds);
    input.boost = pendingBoost && !photoMode;
    pendingBoost = false;
    input.fineControl = keys.fineControl;

    controls.pitch = input.pitch;
    controls.roll = input.roll;
    controls.yaw = input.yaw;
    noteSource('pitch', [['keyboard', keys.pitch], ['mouse', keys.stickPitch], ['touch', touchFrame.pitch], [padSource.pitch, pad.pitch]]);
    noteSource('roll', [['keyboard', keys.roll], ['mouse', keys.stickRoll], ['touch', touchFrame.roll], [padSource.roll, pad.roll]]);
    noteSource('yaw', [['keyboard', keys.yaw], [padSource.yaw, pad.yaw]]);
    controls.lookX = clamp(keys.lookX + pad.lookX, -1, 1);
    controls.lookY = clamp(keys.lookY + pad.lookY, -1, 1);
    noteSource('lookX', [['mouse', keys.lookX], [padSource.lookX, pad.lookX]]);
    noteSource('lookY', [['mouse', keys.lookY], [padSource.lookY, pad.lookY]]);
    controls.brakeL = clamp(Math.max(keys.brakeL, deviceFrame.max.brakeL), 0, 1);
    controls.brakeR = clamp(Math.max(keys.brakeR, deviceFrame.max.brakeR), 0, 1);
    noteSource('brakeL', [['keyboard', keys.brakeL], [padSource.brakeL, deviceFrame.max.brakeL]]);
    noteSource('brakeR', [['keyboard', keys.brakeR], [padSource.brakeR, deviceFrame.max.brakeR]]);
    for (const target of LEVER_TARGETS) {
      const driven = updateLever(target, keys, seconds);
      if (target === 'collective' && !driven && levers.collective.owner === null) {
        controls.collective = controls.throttle;
        if (controls.sources.throttle) controls.sources.collective = controls.sources.throttle;
      }
    }
    controls.afterburnerDetent = settings.get('afterburnerDetent');
    controls.afterburner = controls.throttle >= controls.afterburnerDetent - 1e-6;
  }

  // ---- Controls panel API ---------------------------------------------------------------------------
  /** Which axes of a device play which role under its current bindings (for the wizard). */
  function roleAxesFor(deviceKey) {
    const device = registry.get(deviceKey);
    const roles = { throttle: [], rudder: [], brakeL: [], brakeR: [], unipolar: [] };
    if (!device) return roles;
    const profileAxes = DEVICE_PROFILES[device.profile]?.axes ?? [];
    for (const axis of profileAxes) if (axis.range === 'unipolar') roles.unipolar.push(axis.index);
    for (const [target, refs] of bindings.getEffective(device.bindingDevice, getCraft()).axes) {
      for (const ref of refs) {
        if (ref.type !== 'axis') continue;
        if ((target === 'throttle' || target === 'collective') && !ref.rate) roles.throttle.push(ref.axis);
        if (ref.role === 'rudder') roles.rudder.push(ref.axis);
        if (target === 'brakeL') roles.brakeL.push(ref.axis);
        if (target === 'brakeR') roles.brakeR.push(ref.axis);
        if (ref.range === 'unipolar') roles.unipolar.push(ref.axis);
      }
    }
    for (const role of Object.keys(roles)) roles[role] = [...new Set(roles[role])];
    return roles;
  }

  function wizardDevices(deviceKeys) {
    const result = [];
    for (const device of registry.live()) {
      if (deviceKeys && !deviceKeys.includes(device.deviceKey)) continue;
      result.push({ deviceKey: device.deviceKey, profile: device.profile, name: device.name, axes: device.axes, buttons: device.buttons.map((button) => button.pressed) });
    }
    return result;
  }

  function labelsFor(bindingDevice) {
    for (const device of registry.live()) {
      if (device.bindingDevice === bindingDevice) return { buttonLabels: device.buttonLabels, axisLabels: device.axisLabels };
    }
    const profile = DEVICE_PROFILES[bindings.profileIdFor(bindingDevice)];
    if (!profile) return null;
    return { buttonLabels: profile.buttonLabels, axisLabels: Object.fromEntries(profile.axes.map((axis) => [axis.index, axis.label])) };
  }

  function readDevice(deviceKey) {
    const device = registry.get(deviceKey);
    if (!device) return null;
    const profile = DEVICE_PROFILES[device.profile];
    const compiledHats = calibration.hats(deviceKey);
    const hatAxes = new Set(compiledHats.filter((hat) => hat?.form === 'axis').map((hat) => hat.axis));
    const directions = mapper.hatDirections(deviceKey);
    const hatCount = Math.max(profile.hats.length, compiledHats.length);
    return {
      deviceKey,
      name: device.name,
      kind: device.kind,
      profile: device.profile,
      bindingDevice: device.bindingDevice,
      calibrated: Boolean(calibration.peek(deviceKey)),
      axes: device.axes.map((raw, axisIndex) => {
        const hat = hatAxes.has(axisIndex) || Math.abs(raw) > 1.01;
        const reading = hat ? { value: 0, range: 'bipolar' } : mapper.readAxis(device, axisIndex);
        return { index: axisIndex, label: device.axisLabels[axisIndex] ?? `Axis ${axisIndex + 1}`, raw, value: reading.value, range: reading.range, hat };
      }),
      buttons: device.buttons.map((button, buttonIndex) => ({ index: buttonIndex, label: device.buttonLabels[buttonIndex] ?? `Button ${buttonIndex + 1}`, pressed: button.pressed, value: button.value })),
      hats: Array.from({ length: hatCount }, (unused, hatIndex) => ({
        index: hatIndex,
        label: profile.hats[hatIndex]?.label ?? `Hat ${hatIndex + 1}`,
        learned: Boolean(compiledHats[hatIndex]),
        direction: directions[hatIndex] ?? null,
      })),
    };
  }

  function getDevices() {
    return registry.list().map((summary) => {
      const record = calibration.peek(summary.deviceKey);
      const hats = DEVICE_PROFILES[summary.profile]?.hats.length ?? 0;
      return {
        ...summary,
        calibrated: Boolean(record),
        needsCalibration: summary.hotas && (!record || record.hats.filter(Boolean).length < hats),
      };
    });
  }

  function getConnectionState() {
    const devices = getDevices();
    const stick = devices.some((device) => device.kind === 'hotas-stick');
    const throttle = devices.some((device) => device.kind === 'hotas-throttle');
    const pedals = throttle || devices.some((device) => device.kind === 'hotas-pedals');
    return {
      supported: registry.supported,
      devices,
      hotas: { stick, throttle, pedals, complete: stick && throttle },
      prompt: stick && throttle ? null : HOTAS_PROMPT,
      pedalNote: PEDAL_NOTE,
    };
  }

  window.addEventListener('blur', () => {
    capture.cancel();
  });

  return {
    update,
    bindings,
    calibration,
    mock,

    isPointerLocked: keyboardMouse.isPointerLocked,
    readPhotoControls: keyboardMouse.readPhotoControls,
    getStick: keyboardMouse.getStick,
    centerStick: keyboardMouse.centerStick,

    /** True when a keydown belongs to input (bound action or an active listen); the UI skips it. */
    consumesKey: keyboardMouse.consumesKey,

    getDevices,
    getConnectionState,
    readDevice,

    /** Live keyboard state for the controls panel (held key codes). */
    readKeyboard() {
      return { held: keyboardMouse.heldKeys() };
    },

    /** Throttle as SIM sees it, with the afterburner detent from settings. */
    getThrottleReading() {
      return {
        value: controls.throttle,
        afterburnerDetent: controls.afterburnerDetent,
        afterburner: controls.afterburner,
        source: controls.sources.throttle ?? null,
      };
    },

    /** Twist-yaw state: the setting, whether pedals are present and moved, and whether twist is live. */
    getTwistState() {
      return { setting: settings.get('twistYaw'), pedalsPresent: deviceFrame.rudderPresent, pedalsMoved, twistActive: twistEnabled() };
    },

    /** Short label of a binding reference with the device's own button / axis names. */
    describeRef(ref, bindingDevice) {
      return describeRef(ref, labelsFor(bindingDevice));
    },

    /**
     * Listens for the next input for target (see capture.js). Resolves { ok, device, ref } or
     * { ok: false, reason }. Actions do not fire while listening.
     */
    listen({ target, device = null, timeoutMs = 10000 }) {
      router.releaseAll();
      return capture.start({ target, device, timeoutMs });
    },
    cancelListen() {
      capture.cancel();
    },
    getListenState: capture.getState,
    onListenChange: capture.onChange,

    /**
     * Listens, then binds what was captured (globally, or as an override for craft). Resolves with
     * the bind result { ok, device, ref, conflicts } or { ok: false, reason | error }.
     */
    async bindByListening({ target, craft = null, device = null, replace = true, timeoutMs = 10000 }) {
      router.releaseAll();
      const captured = await capture.start({ target, device, timeoutMs });
      if (!captured.ok) return captured;
      const result = bindings.bind({ device: captured.device, target, ref: captured.ref, craft, replace });
      return { ...result, device: captured.device };
    },

    /**
     * Starts the calibration wizard for the connected controllers (or only deviceKeys). Controller
     * actions and axes are ignored while it runs. Returns the wizard (calibration.js).
     */
    startCalibration({ deviceKeys = null } = {}) {
      if (wizardActive()) wizard.cancel();
      for (const device of registry.live()) router.releasePrefix(`${device.deviceKey}|`);
      wizard = createCalibrationWizard({
        readDevices: () => wizardDevices(deviceKeys),
        roleAxes: roleAxesFor,
        store: calibration,
      });
      return wizard;
    },

    /** The running (or last) calibration wizard, or null. */
    getCalibrationWizard() {
      return wizard;
    },
  };
}

export { createInputManager as createInputSystem };
