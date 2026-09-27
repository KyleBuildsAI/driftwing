// Gamepad API device registry: polling, identification and hot-plug for standard gamepads and
// Thrustmaster HOTAS devices.
//
// Browsers only expose a controller after one of its buttons has been pressed on the page, and
// the slot (gamepad.index) a device lands in changes across reboots and plug order. Devices are
// therefore identified by the vendor / product id in gamepad.id (hotas/devices.js) and tracked by
// a device key ('044f-b10a', a second identical device becomes '044f-b10a#2'); the slot is only
// used to find this frame's Gamepad object. Connection changes are detected from the
// gamepadconnected / gamepaddisconnected events AND by polling (Chrome does not always fire the
// events, and the Gamepad objects are per-poll snapshots), and published as typed
// deviceConnected / deviceDisconnected events.

import { DEVICE_PROFILES, HOTAS_KINDS, bindingDeviceFor, identifyGamepad } from './hotas/devices.js';

/**
 * bus: EventBus with typed events. debug: log each observed id once (console.info) with ?debug=1.
 * onConnect(device) / onDisconnect(device) run after the typed events.
 */
export function createGamepadRegistry({ bus, debug = false, onConnect = null, onDisconnect = null }) {
  const supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  /** deviceKey -> live device record. */
  const devices = new Map();
  /** slot -> deviceKey for the devices present in the last poll. */
  const slots = new Map();
  const loggedIds = new Set();

  function readPads() {
    if (!supported) return [];
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch (error) {
      // Some embedders block the Gamepad API through permissions policy; treat it as absent.
      return [];
    }
    return pads ? Array.from(pads) : [];
  }

  /** A free device key for a new device: the base key, or base#2, base#3 for identical devices. */
  function allocateKey(baseKey) {
    if (!devices.has(baseKey)) return baseKey;
    for (let copy = 2; copy < 16; copy++) {
      const key = `${baseKey}#${copy}`;
      if (!devices.has(key)) return key;
    }
    return `${baseKey}#${devices.size + 1}`;
  }

  function logObservedId(gamepad, identity) {
    if (!debug || loggedIds.has(gamepad.id)) return;
    loggedIds.add(gamepad.id);
    console.info(`[DRIFTWING] gamepad seen: id="${gamepad.id}" mapping="${gamepad.mapping}" vendor=${identity.vendor ?? '?'} product=${identity.product ?? '?'} profile=${identity.profile} axes=${gamepad.axes.length} buttons=${gamepad.buttons.length}`);
  }

  function connect(gamepad) {
    const identity = identifyGamepad(gamepad);
    logObservedId(gamepad, identity);
    const deviceKey = allocateKey(identity.baseKey);
    const profile = DEVICE_PROFILES[identity.profile];
    const device = {
      ...identity,
      deviceKey,
      id: gamepad.id,
      slot: gamepad.index,
      mapping: gamepad.mapping,
      gamepad,
      axes: Array.from(gamepad.axes, Number),
      buttons: gamepad.buttons.map((button) => ({ pressed: Boolean(button.pressed), value: Number(button.value) || 0 })),
      /** Axis values when the device first appeared (toe brakes rest at idle: pedal note). */
      restAxes: Array.from(gamepad.axes, Number),
      axisLabels: Object.fromEntries(profile.axes.map((axis) => [axis.index, axis.label])),
      buttonLabels: profile.buttonLabels,
      connectedAt: performance.now(),
    };
    device.bindingDevice = bindingDeviceFor(device);
    devices.set(deviceKey, device);
    slots.set(gamepad.index, deviceKey);
    bus.emitTyped('deviceConnected', { deviceKey, kind: device.kind, name: device.name });
    if (onConnect) onConnect(device);
    return device;
  }

  function disconnect(deviceKey) {
    const device = devices.get(deviceKey);
    if (!device) return;
    devices.delete(deviceKey);
    if (slots.get(device.slot) === deviceKey) slots.delete(device.slot);
    bus.emitTyped('deviceDisconnected', { deviceKey, kind: device.kind, name: device.name });
    if (onDisconnect) onDisconnect(device);
  }

  function refresh(device, gamepad) {
    device.gamepad = gamepad;
    const axes = gamepad.axes;
    if (device.axes.length !== axes.length) device.axes.length = axes.length;
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex++) device.axes[axisIndex] = Number(axes[axisIndex]);
    const buttons = gamepad.buttons;
    for (let buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
      const state = device.buttons[buttonIndex] ?? (device.buttons[buttonIndex] = { pressed: false, value: 0 });
      state.pressed = Boolean(buttons[buttonIndex].pressed);
      state.value = Number(buttons[buttonIndex].value) || 0;
    }
    device.buttons.length = buttons.length;
  }

  /**
   * Reads every pad, connecting, refreshing and disconnecting devices. A device that shows up in a
   * different slot with the same id (the browser renumbered its pads) keeps its device key, so its
   * bindings, calibration and held inputs carry on without a disconnect / connect pair.
   */
  function poll() {
    const pads = readPads().filter((gamepad) => gamepad && gamepad.connected !== false);
    const unmatchedPads = [];
    const matchedKeys = new Set();
    for (const gamepad of pads) {
      const knownKey = slots.get(gamepad.index);
      const known = knownKey ? devices.get(knownKey) : null;
      if (known && known.id === gamepad.id && !matchedKeys.has(knownKey)) {
        refresh(known, gamepad);
        matchedKeys.add(knownKey);
      } else {
        unmatchedPads.push(gamepad);
      }
    }
    const pendingPads = [];
    for (const gamepad of unmatchedPads) {
      const moved = [...devices.values()].find((device) => !matchedKeys.has(device.deviceKey) && device.id === gamepad.id);
      if (!moved) {
        pendingPads.push(gamepad);
        continue;
      }
      if (slots.get(moved.slot) === moved.deviceKey) slots.delete(moved.slot);
      moved.slot = gamepad.index;
      slots.set(gamepad.index, moved.deviceKey);
      refresh(moved, gamepad);
      matchedKeys.add(moved.deviceKey);
    }
    for (const deviceKey of [...devices.keys()]) {
      if (!matchedKeys.has(deviceKey)) disconnect(deviceKey);
    }
    for (const gamepad of pendingPads) connect(gamepad);
  }

  if (supported) {
    window.addEventListener('gamepadconnected', poll);
    window.addEventListener('gamepaddisconnected', (event) => {
      const deviceKey = slots.get(event.gamepad?.index);
      if (deviceKey && devices.get(deviceKey)?.id === event.gamepad?.id) disconnect(deviceKey);
    });
  }

  return {
    supported,
    poll,

    /** Live device records (do not mutate). */
    live() {
      return devices.values();
    },

    get(deviceKey) {
      return devices.get(deviceKey) ?? null;
    },

    /** Public summaries of the connected devices, ordered HOTAS first. */
    list() {
      const summaries = [...devices.values()].map((device) => ({
        deviceKey: device.deviceKey,
        kind: device.kind,
        name: device.name,
        profile: device.profile,
        vendor: device.vendor,
        product: device.product,
        known: device.known,
        confirmed: device.confirmed,
        standard: device.standard,
        slot: device.slot,
        id: device.id,
        axisCount: device.axes.length,
        buttonCount: device.buttons.length,
        bindingDevice: device.bindingDevice,
        hotas: HOTAS_KINDS.includes(device.kind),
      }));
      return summaries.sort((first, second) => Number(second.hotas) - Number(first.hotas) || first.deviceKey.localeCompare(second.deviceKey));
    },
  };
}
