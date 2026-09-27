// Mock Gamepad API devices for the HOTAS pipeline test (?test=hotas) and input tests.
//
// installMockGamepads() replaces navigator.getGamepads() with scriptable devices that match the
// layouts Chrome reports for a Thrustmaster T.16000M stick and a TWCS throttle (with TFRP pedals
// on its RJ12 port), plus a standard-mapping Xbox-style pad. Ids carry the real vendor / product
// strings, axis and button counts match the hardware, and the stick's hat is in axis form (one
// axis with discrete values and an out-of-range centre) while the throttle's hat is in button form,
// so both hat decoders are exercised. Like Chrome, a plugged device stays invisible until one of
// its buttons is pressed (pass requirePress: false to skip that).
//
// Everything is driven through the returned controller:
//   const mock = installMockGamepads();
//   mock.plug('t16000m', { slot: 1 });      -> 't16000m' (a handle)
//   mock.press('t16000m', 0);               -> device appears, trigger held
//   mock.setAxis('t16000m', 0, 0.5);        -> stick half right
//   mock.setHat('t16000m', 'upLeft');       -> hat up-left (null centres it)
//   mock.moveToSlot('t16000m', 0);          -> same device, different slot

/** Chrome's axis-form hat values: eight directions clockwise from up, and the centred value. */
export const CHROME_HAT_VALUES = Object.freeze({
  up: -1,
  upRight: -0.7142857142857143,
  right: -0.4285714285714286,
  downRight: -0.1428571428571429,
  down: 0.1428571428571428,
  downLeft: 0.4285714285714286,
  left: 0.7142857142857142,
  upLeft: 1,
});
export const CHROME_HAT_CENTER = 1.2857142857142856;

const DIAGONAL_PARTS = Object.freeze({
  up: ['up'],
  upRight: ['up', 'right'],
  right: ['right'],
  downRight: ['down', 'right'],
  down: ['down'],
  downLeft: ['down', 'left'],
  left: ['left'],
  upLeft: ['up', 'left'],
});

/**
 * Device layouts. rest: axis values at rest (throttles at idle, toe brakes released, the
 * axis-form hat centred). axisNames: readable indices for scripts.
 */
export const MOCK_LAYOUTS = Object.freeze({
  t16000m: Object.freeze({
    name: 'T.16000M',
    vendor: '044f',
    product: 'b10a',
    mapping: '',
    rest: Object.freeze([0, 0, 0, 0, 0, 0, 1, 0, 0, CHROME_HAT_CENTER]),
    buttonCount: 16,
    axisNames: Object.freeze({ x: 0, y: 1, twist: 5, slider: 6, hat: 9 }),
    hat: Object.freeze({ form: 'axis', axis: 9 }),
  }),
  twcs: Object.freeze({
    name: 'TWCS Throttle',
    vendor: '044f',
    product: 'b687',
    mapping: '',
    rest: Object.freeze([0, 0, 1, -1, -1, 0, 1, 0]),
    buttonCount: 18,
    axisNames: Object.freeze({ miniX: 0, miniY: 1, throttle: 2, brakeLeft: 3, brakeRight: 4, rocker: 5, antenna: 6, rudder: 7 }),
    hat: Object.freeze({ form: 'buttons', buttons: Object.freeze({ up: 14, right: 15, down: 16, left: 17 }) }),
  }),
  xbox: Object.freeze({
    name: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
    vendor: '045e',
    product: '028e',
    mapping: 'standard',
    rest: Object.freeze([0, 0, 0, 0]),
    buttonCount: 17,
    axisNames: Object.freeze({ leftX: 0, leftY: 1, rightX: 2, rightY: 3 }),
    hat: null,
  }),
});

function formatId(layout, idFormat) {
  if (idFormat === 'prefix') return `${layout.vendor}-${layout.product}-${layout.name}`;
  if (idFormat === 'name') return layout.name;
  return `${layout.name} (Vendor: ${layout.vendor} Product: ${layout.product})`;
}

function dispatchGamepadEvent(type, gamepad) {
  const event = new Event(type);
  Object.defineProperty(event, 'gamepad', { value: gamepad });
  window.dispatchEvent(event);
}

/**
 * Installs the mock. Returns the controller described at the top of this file. uninstall()
 * restores the browser's own navigator.getGamepads.
 */
export function installMockGamepads({ requirePress = true } = {}) {
  const devices = new Map();
  const ownDescriptor = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');

  function slotList() {
    let length = 4;
    for (const device of devices.values()) length = Math.max(length, device.pad.index + 1);
    const list = new Array(length).fill(null);
    for (const device of devices.values()) if (device.exposed) list[device.pad.index] = device.pad;
    return list;
  }

  Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => slotList() });

  function deviceFor(handle) {
    const device = devices.get(handle);
    if (!device) throw new Error(`no mock gamepad "${handle}"`);
    return device;
  }

  function touch(device) {
    device.pad.timestamp = performance.now();
  }

  function expose(device) {
    if (device.exposed) return;
    device.exposed = true;
    dispatchGamepadEvent('gamepadconnected', device.pad);
  }

  function slotTaken(slot, except) {
    for (const device of devices.values()) if (device !== except && device.pad.index === slot) return true;
    return false;
  }

  function freeSlot() {
    let slot = 0;
    while (slotTaken(slot, null)) slot++;
    return slot;
  }

  function writeButton(device, index, pressed, value) {
    const button = device.pad.buttons[index];
    if (!button) throw new Error(`mock gamepad has no button ${index}`);
    button.pressed = Boolean(pressed);
    button.touched = Boolean(pressed);
    button.value = Number.isFinite(value) ? value : (pressed ? 1 : 0);
    touch(device);
    if (pressed && requirePress) expose(device);
  }

  return {
    layouts: MOCK_LAYOUTS,
    hatValues: CHROME_HAT_VALUES,
    hatCenter: CHROME_HAT_CENTER,

    /**
     * Plugs a device. options: slot (default: first free), idFormat 'chrome' | 'prefix' | 'name',
     * handle (default: the layout id, or id-2, id-3 for more of the same). Returns the handle.
     */
    plug(layoutId, { slot = null, idFormat = 'chrome', handle = null } = {}) {
      const layout = MOCK_LAYOUTS[layoutId];
      if (!layout) throw new Error(`unknown mock layout "${layoutId}"`);
      let key = handle ?? layoutId;
      for (let copy = 2; !handle && devices.has(key); copy++) key = `${layoutId}-${copy}`;
      if (devices.has(key)) throw new Error(`mock gamepad "${key}" already plugged`);
      const index = Number.isInteger(slot) ? slot : freeSlot();
      if (slotTaken(index, null)) throw new Error(`slot ${index} is taken`);
      const pad = {
        id: formatId(layout, idFormat),
        index,
        connected: true,
        mapping: layout.mapping,
        timestamp: performance.now(),
        axes: layout.rest.slice(),
        buttons: Array.from({ length: layout.buttonCount }, () => ({ pressed: false, touched: false, value: 0 })),
        vibrationActuator: null,
      };
      const device = { handle: key, layoutId, layout, pad, exposed: !requirePress };
      devices.set(key, device);
      if (device.exposed) dispatchGamepadEvent('gamepadconnected', pad);
      return key;
    },

    unplug(handle) {
      const device = deviceFor(handle);
      devices.delete(handle);
      device.pad.connected = false;
      if (device.exposed) dispatchGamepadEvent('gamepaddisconnected', device.pad);
    },

    /** Moves a device to another (free) slot, as a reboot or re-plug would. */
    moveToSlot(handle, slot) {
      const device = deviceFor(handle);
      if (slotTaken(slot, device)) throw new Error(`slot ${slot} is taken`);
      device.pad.index = slot;
      touch(device);
    },

    /** Sets a raw axis value by index or by the layout's axis name. */
    setAxis(handle, axis, value) {
      const device = deviceFor(handle);
      const axisIndex = typeof axis === 'string' ? device.layout.axisNames[axis] : axis;
      if (!Number.isInteger(axisIndex) || axisIndex < 0 || axisIndex >= device.pad.axes.length) throw new Error(`mock gamepad has no axis ${axis}`);
      device.pad.axes[axisIndex] = Number(value);
      touch(device);
    },

    /** Puts every axis back at rest. */
    restAxes(handle) {
      const device = deviceFor(handle);
      device.pad.axes = device.layout.rest.slice();
      touch(device);
    },

    setButton(handle, index, pressed, value) {
      writeButton(deviceFor(handle), index, pressed, value);
    },

    press(handle, index) {
      writeButton(deviceFor(handle), index, true);
    },

    release(handle, index) {
      writeButton(deviceFor(handle), index, false);
    },

    /** Sets the hat to a direction ('up', 'upRight', ... 'upLeft') or centres it (null). */
    setHat(handle, direction) {
      const device = deviceFor(handle);
      const hat = device.layout.hat;
      if (!hat) throw new Error(`mock gamepad "${handle}" has no hat`);
      if (direction !== null && !(direction in CHROME_HAT_VALUES)) throw new Error(`unknown hat direction "${direction}"`);
      if (hat.form === 'axis') {
        device.pad.axes[hat.axis] = direction === null ? CHROME_HAT_CENTER : CHROME_HAT_VALUES[direction];
        touch(device);
        return;
      }
      const parts = direction === null ? [] : DIAGONAL_PARTS[direction];
      for (const [cardinal, buttonIndex] of Object.entries(hat.buttons)) {
        writeButton(device, buttonIndex, parts.includes(cardinal));
      }
    },

    /** Snapshot of a device's current raw state. */
    get(handle) {
      const device = deviceFor(handle);
      return {
        handle,
        id: device.pad.id,
        slot: device.pad.index,
        exposed: device.exposed,
        axes: device.pad.axes.slice(),
        buttons: device.pad.buttons.map((button) => button.pressed),
      };
    },

    list() {
      return [...devices.keys()];
    },

    uninstall() {
      for (const handle of [...devices.keys()]) this.unplug(handle);
      if (ownDescriptor) Object.defineProperty(navigator, 'getGamepads', ownDescriptor);
      else delete navigator.getGamepads;
    },
  };
}
