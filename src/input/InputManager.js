// InputManager: the 'input' system. Reads keyboard, mouse, touch, standard gamepads and
// Thrustmaster HOTAS devices, writes ctx.controls (the ControlState, controlState.js, that flight
// reads each physics tick) every frame, and emits 'input:action' { id, phase, source, device } for
// every action press and release. The UI's touch stick and slider report through the returned
// touch API.
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
/** Throttle change per wheel notch (v1's wheel step). */
const WHEEL_THROTTLE_STEP = 0.05;
/** Position targets other than the throttle: levers moved by absolute axes or rate inputs. */
const LEVER_TARGETS = Object.freeze(['collective', 'flaps', 'trim', 'antenna']);
const HOTAS_PROMPT = 'Press any button on your stick and throttle';
/** Lever owners that are not a physical lever: rate inputs (keys, buttons), the wheel and touch. */
const SOFT_LEVER_OWNERS = new Set(['rate', 'wheel', 'touch']);

export function createInputManager(ctx) {
  const { state, settings, bus, controls, storage } = ctx;
  const params = new URLSearchParams(window.location.search);
  const debug = params.get('debug') === '1';
  const mock = params.get('test') === 'hotas' ? installMockGamepads() : null;

  // A craft module's own default bindings (contract h.2) sit between the player's and the profile's.
  const bindings = createBindingStore({ storage, craftDefaults: (craft) => ctx.craftRegistry?.get(craft)?.bindings ?? null });
  const calibration = createCalibrationStore({ storage });
  if (bindings.loadErrors.length > 0) {
    bus.emit('notify', { text: 'Some saved control bindings could not be read and were reset to defaults.', kind: 'warning' });
  }

  let wizard = null;
  let pedalsMoved = false;
  /** performance.now() of the last player input on any device (the HUD's auto-hide reads it). */
  let lastActivity = 0;
  const levers = { throttle: { owner: null }, collective: { owner: null }, flaps: { owner: null }, trim: { owner: null }, antenna: { owner: null } };
  const previousButtons = new Map();
  const deviceFrame = createFrameAccumulator();
  const connectedKinds = new Set();

  const getCraft = () => settings.get('craft');
  const markActivity = () => { lastActivity = performance.now(); };
  const wizardActive = () => Boolean(wizard && !wizard.finished && !wizard.cancelled);

  const router = createActionRouter({ bus, controls });

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
  // Whatever a controller still holds when a listen ends (the input just bound) stays silent until
  // it is released, so binding a button does not also fire its new action.
  capture.onChange((listenState) => {
    if (listenState.active) return;
    for (const device of registry.live()) mapper.latchHeld(device);
  });
  const keyboardMouse = createKeyboardMouse(ctx, { bindings, router, canPress, capture, getCraft, markActivity });
  const touch = createTouchInput({ markActivity });

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

  function updateControllers(seconds, craft) {
    if (registry.supported) registry.poll();
    resetFrameAccumulator(deviceFrame);
    connectedKinds.clear();
    for (const device of registry.live()) connectedKinds.add(device.kind);
    const calibrating = wizardActive();
    const axesEnabled = !calibrating && !state.photoMode;
    const context = {
      frame: deviceFrame,
      craft,
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
   * True when a lever candidate takes its target: it moved, or it is seen for the first time and
   * nothing has driven the target yet (a controller connected at the start). A lever that merely
   * starts counting later, such as the stick's slider once the TWCS drops out, waits to be moved.
   */
  function claimsLever(candidate, lever) {
    return candidate.moved || (candidate.fresh && lever.owner === null);
  }

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
      if (claimsLever(candidate, lever)) lever.owner = candidate.key;
      if (lever.owner !== candidate.key) continue;
      controls[target] = clamp(candidate.value, low, 1);
      controls.sources[target] = candidate.source;
      controls.sourceDevices[target] = candidate.deviceKey;
      driven = true;
    }
    const keyRate = keys.rates[target] ?? 0;
    const deviceRate = deviceFrame.rates[target] ?? 0;
    if (keyRate !== 0 || deviceRate !== 0) {
      lever.owner = 'rate';
      controls[target] = clamp(controls[target] + (keyRate + deviceRate) * seconds, low, 1);
      controls.sources[target] = keyRate !== 0 ? 'keyboard' : deviceFrame.sources[target];
      controls.sourceDevices[target] = keyRate !== 0 ? null : deviceFrame.sourceDevices[target] ?? null;
      driven = true;
    }
    return driven;
  }

  /**
   * Throttle: ControlState.throttle moves directly: levers, W / S and triggers at a rate, the wheel
   * in v1's steps and the touch slider.
   */
  function updateThrottle(keys, touchFrame, seconds) {
    const lever = levers.throttle;
    updateLever('throttle', keys, seconds);
    if (touchFrame.throttle !== null) {
      controls.throttle = touchFrame.throttle;
      controls.sources.throttle = 'touch';
      controls.sourceDevices.throttle = null;
      lever.owner = 'touch';
    }
    if (keys.wheelNotches !== 0) {
      controls.throttle = clamp(controls.throttle - keys.wheelNotches * WHEEL_THROTTLE_STEP, 0, 1);
      controls.sources.throttle = 'mouse';
      controls.sourceDevices.throttle = null;
      lever.owner = 'wheel';
    }
  }

  /**
   * Records which source (and which controller, by deviceKey, or null for keyboard, mouse and touch)
   * contributed most to an axis this frame; both are kept when nothing moved it.
   */
  function noteSource(axis, contributions) {
    let best = null;
    let bestDevice = null;
    let bestMagnitude = 0;
    for (const [source, value, deviceKey = null] of contributions) {
      if (Math.abs(value) > bestMagnitude) {
        bestMagnitude = Math.abs(value);
        best = source;
        bestDevice = deviceKey;
      }
    }
    if (!best) return;
    controls.sources[axis] = best;
    controls.sourceDevices[axis] = bestDevice;
  }

  // ---- Frame ---------------------------------------------------------------------------------------
  function update(simDt, realDt) {
    const seconds = Math.min(Math.max(realDt, 0), 0.05);
    const craft = getCraft();
    const photoMode = state.photoMode;
    const invert = settings.get('invertPitch') ? -1 : 1;

    const keys = keyboardMouse.update(seconds);
    const touchFrame = touch.merge(invert, photoMode);
    updateControllers(seconds, craft);
    const pad = deviceFrame.spring;
    const padSource = deviceFrame.sources;
    const padDevice = deviceFrame.sourceDevices;

    controls.pitch = clamp(keys.pitch + keys.stickPitch + touchFrame.pitch + pad.pitch, -1, 1);
    controls.roll = clamp(keys.roll + keys.stickRoll + touchFrame.roll + pad.roll, -1, 1);
    controls.yaw = clamp(keys.yaw + pad.yaw, -1, 1);
    updateThrottle(keys, touchFrame, seconds);
    noteSource('pitch', [['keyboard', keys.pitch], ['mouse', keys.stickPitch], ['touch', touchFrame.pitch], [padSource.pitch, pad.pitch, padDevice.pitch]]);
    noteSource('roll', [['keyboard', keys.roll], ['mouse', keys.stickRoll], ['touch', touchFrame.roll], [padSource.roll, pad.roll, padDevice.roll]]);
    noteSource('yaw', [['keyboard', keys.yaw], [padSource.yaw, pad.yaw, padDevice.yaw]]);
    controls.lookX = clamp(keys.lookX + pad.lookX, -1, 1);
    controls.lookY = clamp(keys.lookY + pad.lookY, -1, 1);
    noteSource('lookX', [['mouse', keys.lookX], [padSource.lookX, pad.lookX, padDevice.lookX]]);
    noteSource('lookY', [['mouse', keys.lookY], [padSource.lookY, pad.lookY, padDevice.lookY]]);
    controls.brakeL = clamp(Math.max(keys.brakeL, deviceFrame.max.brakeL), 0, 1);
    controls.brakeR = clamp(Math.max(keys.brakeR, deviceFrame.max.brakeR), 0, 1);
    noteSource('brakeL', [['keyboard', keys.brakeL], [padSource.brakeL, deviceFrame.max.brakeL, padDevice.brakeL]]);
    noteSource('brakeR', [['keyboard', keys.brakeR], [padSource.brakeR, deviceFrame.max.brakeR, padDevice.brakeR]]);
    for (const target of LEVER_TARGETS) {
      const driven = updateLever(target, keys, seconds);
      if (target === 'collective' && !driven && levers.collective.owner === null) {
        controls.collective = controls.throttle;
        if (controls.sources.throttle) {
          controls.sources.collective = controls.sources.throttle;
          controls.sourceDevices.collective = controls.sourceDevices.throttle ?? null;
        }
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

    /**
     * The on-screen touch controls: the UI reports the stick (setStick(x, y) / releaseStick()) and
     * the throttle slider (setThrottle(value) / releaseThrottle()); readStick() returns the stick.
     */
    touch: {
      setStick: touch.setStick,
      releaseStick: touch.releaseStick,
      setThrottle: touch.setThrottle,
      releaseThrottle: touch.releaseThrottle,
      readStick: touch.readStick,
    },

    /** performance.now() of the last player input on any device (0 before the first). */
    getLastActivity() {
      return lastActivity;
    },

    getDevices,
    getConnectionState,
    readDevice,

    /** Live keyboard state for the controls panel (held key codes). */
    readKeyboard() {
      return { held: keyboardMouse.heldKeys() };
    },

    /**
     * Ground start: a throttle (and collective) no physical lever holds, set by keys, the wheel or
     * touch (or by a lever whose device has gone), goes to idle. A connected device lever keeps its
     * position, since software cannot move it (the flight controller's parking brake covers that).
     * Returns true when the throttle was reset.
     */
    idleThrottle() {
      const soft = (lever) => SOFT_LEVER_OWNERS.has(lever.owner) || !deviceFrame.positions.some((candidate) => candidate.key === lever.owner);
      if (soft(levers.collective)) controls.collective = 0;
      if (!soft(levers.throttle)) return false;
      controls.throttle = 0;
      controls.afterburner = false;
      return true;
    },

    /**
     * Sets the throttle lever to value (0..1) when no physical lever holds it (keys, the wheel,
     * touch): a craft switch that spawns the craft at full power (contract h.4). A HOTAS lever keeps
     * its own position. Returns true when the lever moved.
     */
    presetThrottle(value) {
      const soft = (lever) => SOFT_LEVER_OWNERS.has(lever.owner) || !deviceFrame.positions.some((candidate) => candidate.key === lever.owner);
      if (!Number.isFinite(value) || !soft(levers.throttle)) return false;
      controls.throttle = Math.min(1, Math.max(0, value));
      controls.afterburner = controls.throttle >= controls.afterburnerDetent;
      return true;
    },

    /** Throttle as flight sees it, with the afterburner detent from settings. */
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
