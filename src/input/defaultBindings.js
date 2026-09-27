// Default bindings for every device profile (documented in docs/controls.md).
//
// A binding maps a target (an action id from controlState.ACTIONS, or an axis target from
// AXIS_TARGETS) to a list of input references on one device. Reference shapes:
//
//   keyboard   { type: 'key', code, shift?, mode? }                       action
//              { type: 'keys', positive, negative, rate?, doubleTapRoll?, mode? }   axis
//   mouse      { type: 'mouseButton', button }                            action
//   gamepad /  { type: 'button', index }                                  action
//   HOTAS      { type: 'hat', hat, direction }                            action
//              { type: 'axisPress', axis, direction: 1 | -1 }             action (axis pushed past 60%)
//              { type: 'axis', axis, range?, role?, invert?, deadzone?, saturation?, expo?,
//                smoothing?, suppressedBy? }                              axis
//              { type: 'buttonAxis', positive, negative }                 axis (spring, -1..1)
//              { type: 'buttonRate', positive, negative, rate }           axis (moves a position)
//
// key refs: shift true = only with Shift held, false = only without, absent = either (a Shift
// binding on the same key wins while Shift is held). mode 'classic' | 'sim' limits a reference to
// one flight mode; that is how the SIM keyboard layer reuses keys without touching the v1 layer.
// keys refs without rate are spring axes (-1..1 while held); with rate they move a position axis
// at rate units per second. role marks special axes: 'twist' (yields to the pedals), 'rudder'
// (pedal rudder), 'stickThrottle' (the stick's own slider). suppressedBy: a device kind whose
// presence disables the reference (the stick slider is ignored while a TWCS is connected).

/**
 * Axis targets: how contributions from several references combine, and the value range.
 * sum: spring axes are added and clamped; max: the strongest wins; position: absolute axes take
 * over when they move and rate references move the current value.
 */
export const AXIS_TARGETS = Object.freeze({
  roll: Object.freeze({ combine: 'sum', range: 'bipolar', label: 'Roll' }),
  pitch: Object.freeze({ combine: 'sum', range: 'bipolar', label: 'Pitch' }),
  yaw: Object.freeze({ combine: 'sum', range: 'bipolar', label: 'Yaw / rudder' }),
  throttle: Object.freeze({ combine: 'position', range: 'unipolar', label: 'Throttle' }),
  collective: Object.freeze({ combine: 'position', range: 'unipolar', label: 'Collective' }),
  brakeL: Object.freeze({ combine: 'max', range: 'unipolar', label: 'Left toe brake' }),
  brakeR: Object.freeze({ combine: 'max', range: 'unipolar', label: 'Right toe brake' }),
  flaps: Object.freeze({ combine: 'position', range: 'unipolar', label: 'Flaps lever' }),
  trim: Object.freeze({ combine: 'position', range: 'bipolar', label: 'Pitch trim' }),
  lookX: Object.freeze({ combine: 'sum', range: 'bipolar', label: 'Free look X' }),
  lookY: Object.freeze({ combine: 'sum', range: 'bipolar', label: 'Free look Y' }),
  antenna: Object.freeze({ combine: 'position', range: 'unipolar', label: 'Antenna (flaps or zoom)' }),
});
export const AXIS_TARGET_IDS = Object.freeze(Object.keys(AXIS_TARGETS));

const key = (code, extra = {}) => ({ type: 'key', code, ...extra });
const keys = (positive, negative, extra = {}) => ({ type: 'keys', positive, negative, ...extra });
const button = (index) => ({ type: 'button', index });
const hat = (hatIndex, direction) => ({ type: 'hat', hat: hatIndex, direction });
const axis = (index, extra = {}) => ({ type: 'axis', axis: index, ...extra });

/**
 * Keyboard. The CLASSIC layer is v1 exactly (P, J, T, R, G, O, Space; M, C, Enter, /, H, ?, Esc,
 * X, K, I, Tab stay UI keys in ui.js). The SIM layer reassigns G to gear (the waypoint moves to N),
 * C to view cycle and Space to the craft ability. V toggles CLASSIC / SIM in both modes; v1's
 * voice toggle moved to Shift+V.
 */
const KEYBOARD = {
  actions: {
    copilotPTT: [key('Backquote')],
    craftAbility: [key('Space', { mode: 'sim' })],
    boost: [key('Space', { mode: 'classic' })],
    waypointNearest: [key('KeyN', { shift: true })],
    waypointAhead: [key('KeyG', { mode: 'classic' }), key('KeyN', { mode: 'sim', shift: false })],
    photoMode: [key('KeyP')],
    viewCycle: [key('KeyC', { mode: 'sim' })],
    viewForward: [key('Numpad8')],
    viewBack: [key('Numpad2')],
    viewLeft: [key('Numpad4')],
    viewRight: [key('Numpad6')],
    recenterView: [key('Numpad5')],
    craftNext: [key('BracketRight')],
    craftPrev: [key('BracketLeft')],
    craftSelect1: [key('Digit1')],
    craftSelect2: [key('Digit2')],
    craftSelect3: [key('Digit3')],
    craftSelect4: [key('Digit4')],
    craftSelect5: [key('Digit5')],
    craftSelect6: [key('Digit6')],
    modeToggle: [key('KeyV', { shift: false })],
    gearToggle: [key('KeyG', { mode: 'sim' })],
    flapsUp: [key('KeyF', { shift: true })],
    flapsDown: [key('KeyF', { shift: false })],
    airbrake: [key('KeyB')],
    autopilotToggle: [key('KeyO')],
    timeForward: [key('KeyT')],
    timeBack: [key('KeyT', { shift: true })],
    ringCourse: [key('KeyR')],
    journal: [key('KeyJ')],
    settings: [key('Comma')],
    controlsPanel: [key('Period')],
    relaunch: [key('Backspace')],
    engineToggle: [key('KeyZ')],
    chuteDeploy: [key('KeyU')],
  },
  axes: {
    roll: [keys('KeyD', 'KeyA', { doubleTapRoll: true }), keys('ArrowRight', 'ArrowLeft')],
    pitch: [keys('ArrowUp', 'ArrowDown')],
    yaw: [keys('KeyE', 'KeyQ')],
    throttle: [keys('KeyW', 'KeyS', { rate: 0.5 })],
    trim: [keys('Home', 'End', { rate: 0.4 })],
  },
};

/** Mouse: the virtual stick, wheel throttle and right-drag free look are fixed behaviour. */
const MOUSE = {
  actions: {
    recenterView: [{ type: 'mouseButton', button: 1 }],
  },
  axes: {},
};

/** Standard-mapping (Xbox-style) gamepads. */
const STANDARD_GAMEPAD = {
  actions: {
    craftAbility: [button(0)],
    airbrake: [button(1)],
    gearToggle: [button(2)],
    viewCycle: [button(3)],
    modeToggle: [button(8)],
    settings: [button(9)],
    waypointNearest: [button(10)],
    recenterView: [button(11)],
    flapsUp: [button(12)],
    flapsDown: [button(13)],
    craftPrev: [button(14)],
    craftNext: [button(15)],
  },
  axes: {
    roll: [axis(0, { deadzone: 0.12, expo: 0.3, smoothing: 0.1 })],
    pitch: [axis(1, { deadzone: 0.12, expo: 0.3, smoothing: 0.1 })],
    yaw: [{ type: 'buttonAxis', positive: 5, negative: 4 }],
    throttle: [{ type: 'buttonRate', positive: 7, negative: 6, rate: 0.6 }],
    lookX: [axis(2, { deadzone: 0.15, smoothing: 0.1 })],
    lookY: [axis(3, { deadzone: 0.15, smoothing: 0.1, invert: true })],
  },
};

/**
 * Thrustmaster T.16000M stick. Button 0 is the trigger, 1-3 the head buttons, 4-9 the left base
 * group and 10-15 the right base group (Windows button numbers 1-16).
 */
const T16000M = {
  actions: {
    copilotPTT: [button(0)],
    craftAbility: [button(1)],
    waypointNearest: [button(2)],
    photoMode: [button(3)],
    gearToggle: [button(4)],
    flapsUp: [button(5)],
    flapsDown: [button(6)],
    craftPrev: [button(7)],
    craftNext: [button(8)],
    modeToggle: [button(9)],
    autopilotToggle: [button(10)],
    timeForward: [button(11)],
    timeBack: [button(12)],
    ringCourse: [button(13)],
    journal: [button(14)],
    settings: [button(15)],
    viewForward: [hat(0, 'up')],
    viewBack: [hat(0, 'down')],
    viewLeft: [hat(0, 'left')],
    viewRight: [hat(0, 'right')],
  },
  axes: {
    roll: [axis(0, { deadzone: 0.03, expo: 0.15 })],
    pitch: [axis(1, { deadzone: 0.03, expo: 0.15 })],
    yaw: [axis(5, { role: 'twist', deadzone: 0.08, expo: 0.2 })],
    throttle: [axis(6, { range: 'unipolar', role: 'stickThrottle', suppressedBy: 'hotas-throttle', deadzone: 0.01, saturation: 0.01 })],
  },
};

/**
 * Thrustmaster TWCS throttle (with the TFRP pedals on its RJ12 port). The throttle hat is left
 * unbound on purpose: it is reserved for the Phase 4 music controls.
 */
const TWCS = {
  actions: {
    recenterView: [button(0)],
    airbrake: [button(1)],
    viewCycle: [button(2)],
    relaunch: [button(3)],
    engineToggle: [button(4)],
    chuteDeploy: [button(5)],
    controlsPanel: [button(6)],
  },
  axes: {
    lookX: [axis(0, { deadzone: 0.12, smoothing: 0.15 })],
    lookY: [axis(1, { deadzone: 0.12, smoothing: 0.15, invert: true })],
    throttle: [axis(2, { range: 'unipolar', deadzone: 0.01, saturation: 0.01 })],
    brakeL: [axis(3, { range: 'unipolar', deadzone: 0.05 })],
    brakeR: [axis(4, { range: 'unipolar', deadzone: 0.05 })],
    trim: [axis(5, { deadzone: 0.05 })],
    antenna: [axis(6, { range: 'unipolar', deadzone: 0.01, saturation: 0.01 })],
    yaw: [axis(7, { role: 'rudder', deadzone: 0.05, expo: 0.15 })],
  },
};

/** TFRP pedals on their own USB lead (normally they appear through the TWCS instead). */
const TFRP = {
  actions: {},
  axes: {
    brakeL: [axis(0, { range: 'unipolar', deadzone: 0.05 })],
    brakeR: [axis(1, { range: 'unipolar', deadzone: 0.05 })],
    yaw: [axis(5, { role: 'rudder', deadzone: 0.05, expo: 0.15 })],
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Default binding sets by device profile id ('keyboard', 'mouse', 'standard', 't16000m', ...). */
export const DEFAULT_BINDINGS = deepFreeze({
  keyboard: KEYBOARD,
  mouse: MOUSE,
  standard: STANDARD_GAMEPAD,
  t16000m: T16000M,
  twcs: TWCS,
  tfrp: TFRP,
  generic: { actions: {}, axes: {} },
});

/**
 * Keys the UI keeps for itself (not rebindable actions). Binding one of them to an action is
 * reported as a conflict, and an action binding on such a key wins over the UI key.
 */
export const UI_RESERVED_KEYS = Object.freeze([
  { code: 'KeyM', label: 'Talk to WREN (mic)' },
  { code: 'Enter', label: 'Ask WREN' },
  { code: 'NumpadEnter', label: 'Ask WREN' },
  { code: 'Slash', label: 'Ask WREN / help' },
  { code: 'KeyC', mode: 'classic', label: 'Ask WREN (CLASSIC)' },
  { code: 'KeyH', label: 'Help' },
  { code: 'Escape', label: 'Close / leave photo mode' },
  { code: 'KeyX', label: 'Clear waypoint' },
  { code: 'KeyK', label: 'Capture photo' },
  { code: 'KeyI', label: 'FPS and stats' },
  { code: 'KeyV', shift: true, label: 'WREN voice on / off' },
  { code: 'Tab', label: 'Hide or show the HUD' },
]);
