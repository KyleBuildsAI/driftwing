// HOTAS pipeline test (?test=hotas, dev builds only; main.js never loads it in production).
//
// Drives two mock Gamepad API devices from src/dev/mockGamepads.js that match the Thrustmaster
// T.16000M stick (axis-form hat) and the TWCS throttle with TFRP pedals (button-form hat), which
// the InputManager installs for ?test=hotas, and checks the whole input pipeline end to end:
//   1. detection: devices stay hidden until a button press (the controls-panel prompt), are
//      identified by vendor / product id (never by slot), and keep their key when their slot moves;
//   2. bindings: the default HOTAS bindings match the spec; axes reach ControlState through the
//      pipeline (deadzone, saturation, expo, unipolar ranges, the rocker's rate trim, the stick slider
//      ignored while the TWCS is present); buttons fire their actions ('input:action'); the throttle
//      hat stays unbound;
//   3. hat decoding and calibration: hats do nothing until learned; the calibration wizard is run
//      through the InputManager API with scripted movements (off-centre rests, short axis travel,
//      throttle forward, pedals, each hat direction) and the learned ranges, centres, idle / full
//      ends and hat values are checked against what was scripted; afterwards the calibrated axes,
//      all 8 directions of both hat forms and the stick hat's view snaps are checked;
//   4. twist auto-disable: twist yaw works until the pedal rudder moves, is ignored after, returns
//      with the setting forced on, and re-arms when the pedals are unplugged;
//   5. persistence: a custom binding and a per-craft tuning are added, the page reloads, and the
//      bindings and both calibration records must come back from IndexedDB unchanged and work
//      (devices re-plugged in other slots with another id format);
//   6. the one-time HOTAS assist default (src/flight/assistDefaults.js): from a first-run state
//      with one craft's assists set by the player, the first HOTAS drops every other craft to 50 %
//      with one toast; after the reload, a re-plugged HOTAS changes nothing and shows no toast, and
//      the player's own choices stay.
// Expected axis values are computed here from the documented pipeline (not by calling the game's
// functions), so a regression in the pipeline shows up as a mismatch.
//
// The test runs in its own IndexedDB database (TEST_DATABASE), so the player's real bindings and
// calibration for these device ids are never touched, and it leaves that database clean. Progress
// crosses the reload in sessionStorage. Output: the on-screen summary panel and
// window.DRIFTWING.testReport (tools/run-harness.mjs --test hotas).
import { CHROME_HAT_CENTER, CHROME_HAT_VALUES } from './mockGamepads.js';
import { HOTAS_ASSIST_LEVEL, HOTAS_ASSIST_TOAST } from '../flight/assistDefaults.js';
import { CRAFT_IDS } from '../core/settings.js';
import { installConsoleCapture } from './testConsole.js';
import { createTestPanel } from './testPanel.js';
import { readSession, removeSession, writeSession } from './testStats.js';

export const TEST_DATABASE = 'driftwing-v2-test-hotas';
const SESSION_KEY = 'driftwing-v2.test.hotas';
const REPORT_KIND = 'driftwing-hotas-test';
const REPORT_VERSION = 1;
const STICK_KEY = '044f-b10a';
const THROTTLE_KEY = '044f-b687';
const HAT_DIRECTIONS = Object.freeze(['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft']);
const THROTTLE_HAT_BUTTONS = Object.freeze({ up: 14, right: 15, down: 16, left: 17 });
const THROTTLE_HAT_COMBOS = Object.freeze({
  up: [14], upRight: [14, 15], right: [15], downRight: [15, 16], down: [16], downLeft: [16, 17], left: [17], upLeft: [14, 17],
});
/** Value comparison tolerance (pipeline outputs, learned calibration values). */
const TOLERANCE = 0.002;
const PROMPT = 'Press any button on your stick and throttle';

/** Default binding set from the spec (Milestone D), by device: button index -> action ids. */
const SPEC_BUTTONS = Object.freeze({
  [STICK_KEY]: {
    0: ['copilotPTT'], 1: ['craftAbility'], 2: ['waypointNearest'], 3: ['photoMode'], 4: ['gearToggle'], 5: ['flapsUp'], 6: ['flapsDown'],
    7: ['craftPrev'], 8: ['craftNext'], 9: ['versionToggle'], 10: ['autopilotToggle'], 11: ['timeForward'], 12: ['timeBack'], 13: ['ringCourse'], 14: ['journal'], 15: ['settings'],
  },
  [THROTTLE_KEY]: {
    0: ['recenterView'], 1: ['airbrake'], 2: ['viewCycle'], 3: ['relaunch'], 4: ['engineToggle'], 5: ['chuteDeploy'], 6: ['controlsPanel'], 7: ['viewToggle1P3P'],
  },
});
const SPEC_STICK_HAT = Object.freeze({ up: 'viewForward', down: 'viewBack', left: 'viewLeft', right: 'viewRight' });
/** Default axis bindings from the spec: target -> { axis, role? }. */
const SPEC_AXES = Object.freeze({
  [STICK_KEY]: { roll: { axis: 0 }, pitch: { axis: 1 }, yaw: { axis: 5, role: 'twist' }, throttle: { axis: 6, role: 'stickThrottle' } },
  [THROTTLE_KEY]: {
    lookX: { axis: 0 }, lookY: { axis: 1 }, throttle: { axis: 2 }, brakeL: { axis: 3 }, brakeR: { axis: 4 }, trim: { axis: 5 }, antenna: { axis: 6 }, yaw: { axis: 7, role: 'rudder' },
  },
});
/** The craft whose assists the player "set" before the HOTAS arrives, and the level chosen. */
const PLAYER_SET_CRAFT = Object.freeze({ craft: 'jet', level: 0.8 });
/** The craft the player sets after the reload (the re-plugged HOTAS must leave it alone too). */
const PLAYER_SET_AFTER_RELOAD = Object.freeze({ craft: 'glider', level: 0.7 });

/** Tuning of the default axis bindings (docs/controls.md), used for the expected values. */
const TUNING = Object.freeze({
  roll: { deadzone: 0.03, saturation: 0.02, expo: 0.15 },
  twist: { deadzone: 0.08, saturation: 0.02, expo: 0.2 },
  throttle: { deadzone: 0.01, saturation: 0.01, expo: 0 },
  brake: { deadzone: 0.05, saturation: 0.02, expo: 0 },
  antenna: { deadzone: 0.01, saturation: 0.01, expo: 0 },
  rudder: { deadzone: 0.05, saturation: 0.02, expo: 0.15 },
  look: { deadzone: 0.12, saturation: 0.02, expo: 0 },
  rockerRate: 0.5,
});

/** Scripted calibration movements: rest (off centre on purpose) and lock-to-lock ends per axis. */
const CALIBRATION_SCRIPT = Object.freeze({
  stick: { rest: { 0: 0.04, 1: -0.03, 5: 0.02, 6: 1 }, low: { 0: -0.93, 1: -0.97, 5: -0.9, 6: -1 }, high: { 0: 0.96, 1: 0.94, 5: 0.92, 6: 1 } },
  throttle: {
    rest: { 0: 0.05, 1: -0.04, 2: 1, 3: -1, 4: -1, 5: 0.01, 6: 1, 7: -0.02 },
    low: { 0: -0.98, 1: -0.96, 2: -1, 3: -1, 4: -1, 5: -0.95, 6: -1, 7: -0.97 },
    high: { 0: 0.97, 1: 0.99, 2: 1, 3: 1, 4: 1, 5: 0.95, 6: 1, 7: 0.99 },
  },
});
/** What the wizard must learn from CALIBRATION_SCRIPT. */
const EXPECTED_CALIBRATION = Object.freeze({
  [STICK_KEY]: { 0: { min: -0.93, center: 0.04, max: 0.96 }, 1: { min: -0.97, center: -0.03, max: 0.94 }, 5: { min: -0.9, center: 0.02, max: 0.92 }, 6: { idle: 1, full: -1 } },
  [THROTTLE_KEY]: {
    0: { min: -0.98, center: 0.05, max: 0.97 }, 1: { min: -0.96, center: -0.04, max: 0.99 }, 2: { idle: 1, full: -1 }, 3: { idle: -1, full: 1 },
    4: { idle: -1, full: 1 }, 5: { min: -0.95, center: 0.01, max: 0.95 }, 6: { idle: 1, full: -1 }, 7: { min: -0.97, center: -0.02, max: 0.99 },
  },
});

// ---- Expected values from the documented pipeline ------------------------------------------------------
function clampValue(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function shapeMagnitude(value, { deadzone, saturation, expo }) {
  const magnitude = Math.abs(value);
  const shaped = magnitude <= deadzone ? 0 : clampValue((magnitude - deadzone) / (1 - deadzone - saturation), 0, 1);
  const signed = Math.sign(value) * shaped;
  return signed * (1 - expo) + signed * signed * signed * expo;
}

/** Bipolar axis: calibrated (min / centre / max) normalisation, invert, deadzone, saturation, expo. */
function expectBipolar(raw, tuning, calibration = { min: -1, center: 0, max: 1 }, invert = false) {
  const { min, center, max } = calibration;
  let value = raw >= center ? clampValue((raw - center) / (max - center), 0, 1) : clampValue((raw - center) / (center - min), -1, 0);
  if (invert) value = -value;
  return shapeMagnitude(value, tuning);
}

/** Unipolar axis: 0 at idle, 1 at full, then deadzone and saturation. */
function expectUnipolar(raw, tuning, { idle, full }) {
  return shapeMagnitude(clampValue((raw - idle) / (full - idle), 0, 1), tuning);
}

function close(actual, expected, tolerance = TOLERANCE) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function fixed(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

/** JSON with sorted keys, for comparing stored objects whatever their key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Called by main.js at the very start of boot (dev builds with ?test=hotas). Installs the console
 * capture at once and returns the isolated database name and the system factory.
 */
export function prepareHotasTest() {
  const capture = installConsoleCapture();
  return {
    databaseName: TEST_DATABASE,
    createSystem: (ctx) => createHotasTestSystem(ctx, { capture }),
  };
}

function createHotasTestSystem(ctx, { capture }) {
  const { bus, settings, storage, state } = ctx;
  const panel = createTestPanel({ title: 'HOTAS pipeline test' });
  const stored = readSession(SESSION_KEY);
  const continuing = stored.value && stored.value.kind === REPORT_KIND && stored.value.phase === 'verify';
  const session = continuing
    ? stored.value
    : {
        kind: REPORT_KIND,
        version: REPORT_VERSION,
        phase: 'setup',
        startedAt: new Date().toISOString(),
        checks: [],
        console: [],
        consoleCounts: { errors: 0, warnings: 0 },
        expected: null,
        harnessErrors: stored.error ? [stored.error] : [],
      };
  let frame = 0;
  const frameWaiters = [];
  const actions = [];
  const connections = [];
  const notices = [];
  let currentStep = 'waiting for the game';
  const report = {};

  bus.on('input:action', (action) => {
    if (action && (action.source === 'hotas' || action.source === 'gamepad')) actions.push({ ...action, frame });
  });
  bus.onTyped('deviceConnected', (payload) => connections.push({ type: 'connected', ...payload, frame }));
  bus.onTyped('deviceDisconnected', (payload) => connections.push({ type: 'disconnected', ...payload, frame }));
  bus.on('notify', (payload) => notices.push({ text: payload && typeof payload.text === 'string' ? payload.text : '', frame }));

  // ---- Frame helpers -------------------------------------------------------------------------------
  function nextFrame() {
    return new Promise((resolve) => { frameWaiters.push(resolve); });
  }

  async function waitFrames(count) {
    for (let index = 0; index < count; index++) await nextFrame();
  }

  async function waitSeconds(seconds) {
    const until = performance.now() + seconds * 1000;
    do await nextFrame(); while (performance.now() < until);
  }

  /** Lets filtered axes and edge-triggered actions settle (at least 8 frames and 0.3 s). */
  async function settle() {
    await waitFrames(8);
    await waitSeconds(0.3);
  }

  // ---- Checks ---------------------------------------------------------------------------------------
  function check(group, name, passed, actual, expected) {
    session.checks.push({ group, name, passed: Boolean(passed), actual: String(actual), expected: String(expected), phase: session.phase });
    publish();
  }

  function checkValue(group, name, actual, expected, tolerance = TOLERANCE) {
    check(group, name, close(actual, expected, tolerance), fixed(actual), fixed(expected));
  }

  function step(label) {
    currentStep = label;
    capture.setContext(`hotas ${session.phase}: ${label}`);
    panel.setProgress({ label: 'HOTAS pipeline test', detail: `${session.phase === 'setup' ? 'Part 1 of 2' : 'Part 2 of 2 (after reload)'} · ${label}`, fraction: session.phase === 'setup' ? 0.4 : 0.9 });
    publish();
  }

  // ---- Devices -----------------------------------------------------------------------------------------
  const input = () => ctx.systems.input;
  const mock = () => input().mock;
  const controls = ctx.controls;

  function deviceSummary(deviceKey) {
    return input().getDevices().find((device) => device.deviceKey === deviceKey) ?? null;
  }

  function setAxes(handle, values) {
    for (const [axis, value] of Object.entries(values)) mock().setAxis(handle, Number(axis), value);
  }

  /** Presses and releases a button; returns the 'input:action' events it caused. */
  async function tapButton(handle, index) {
    const from = actions.length;
    mock().press(handle, index);
    await waitFrames(4);
    mock().release(handle, index);
    await waitFrames(4);
    return actions.slice(from);
  }

  function describeActions(events) {
    return events.length === 0 ? 'none' : events.map((event) => `${event.id} ${event.phase} (${event.device})`).join(', ');
  }

  /** Taps a button and checks it pressed then released exactly the expected action. */
  async function checkButtonAction(group, handle, deviceKey, index, expectedId, label = null) {
    const events = await tapButton(handle, index);
    const pressed = events.filter((event) => event.phase === 'press');
    const released = events.filter((event) => event.phase === 'release');
    const passed = pressed.length === 1 && pressed[0].id === expectedId && pressed[0].device === deviceKey && pressed[0].source === 'hotas'
      && released.length === 1 && released[0].id === expectedId;
    check(group, label ?? `${deviceKey === STICK_KEY ? 'stick' : 'throttle'} button ${index} -> ${expectedId}`, passed, describeActions(events), `${expectedId} press + release from ${deviceKey}`);
    return events;
  }

  async function plugAndExpose(handle, layout, slot, idFormat, button) {
    mock().plug(layout, { slot, idFormat, handle });
    await waitFrames(3);
    await tapButton(handle, button);
    await settle();
  }

  // ---- Part 1: detection, bindings, calibration, twist, persistence setup ------------------------------
  async function runSetup() {
    step('preparing');
    check('setup', 'mock gamepads installed for ?test=hotas', Boolean(mock()), Boolean(mock()), true);
    check('setup', 'isolated IndexedDB database', storage.backend === 'indexeddb' && storage.databaseName === TEST_DATABASE, `${storage.backend} ${storage.databaseName}`, `indexeddb ${TEST_DATABASE}`);
    if (!mock()) throw new Error('the InputManager did not install the mock gamepads');
    input().bindings.resetToDefaults();
    input().calibration.reset(STICK_KEY);
    input().calibration.reset(THROTTLE_KEY);
    settings.set('twistYaw', 'auto');
    settings.set('craft', 'glider');
    resetAssistState();
    settings.update('assists', { [PLAYER_SET_CRAFT.craft]: PLAYER_SET_CRAFT.level });
    await settle();
    check('assists', 'first-run state: assists 100 %, the HOTAS default not applied yet', settings.get('hotasAssistsApplied') === false && assistsMatch(expectedAssists(1)), describeAssists(), `${describeLevels(expectedAssists(1))}, applied false`);
    check('assists', `a player change marks that craft as set by the player (${PLAYER_SET_CRAFT.craft})`, setByPlayerList() === PLAYER_SET_CRAFT.craft, setByPlayerList() || 'none', PLAYER_SET_CRAFT.craft);
    const noticesBeforeHotas = notices.length;

    // 1. Detection and identification.
    step('detection');
    mock().plug('t16000m', { slot: 2, idFormat: 'chrome', handle: 'stick' });
    mock().plug('twcs', { slot: 0, idFormat: 'chrome', handle: 'throttle' });
    await settle();
    let connection = input().getConnectionState();
    check('detection', 'devices hidden until a button is pressed', connection.devices.length === 0 && connection.prompt === PROMPT, `${connection.devices.length} devices, prompt "${connection.prompt}"`, `0 devices, prompt "${PROMPT}"`);
    await tapButton('stick', 4);
    await settle();
    const hotasToasts = notices.slice(noticesBeforeHotas).filter((notice) => notice.text === HOTAS_ASSIST_TOAST).length;
    check('assists', `first HOTAS: every craft the player did not set drops to ${HOTAS_ASSIST_LEVEL * 100} %`, assistsMatch(expectedAssists(HOTAS_ASSIST_LEVEL)), describeAssists(), describeLevels(expectedAssists(HOTAS_ASSIST_LEVEL)));
    check('assists', 'first HOTAS: one toast, and the change is remembered', hotasToasts === 1 && settings.get('hotasAssistsApplied') === true, `${hotasToasts} toast(s), applied ${settings.get('hotasAssistsApplied')}`, `1 toast "${HOTAS_ASSIST_TOAST}", applied true`);
    connection = input().getConnectionState();
    check('detection', 'stick appears after its button press, prompt stays for the throttle', connection.hotas.stick && !connection.hotas.throttle && connection.prompt === PROMPT, `stick ${connection.hotas.stick}, throttle ${connection.hotas.throttle}, prompt "${connection.prompt}"`, 'stick true, throttle false, prompt shown');
    const noticesBeforeThrottle = notices.length;
    await tapButton('throttle', 9);
    await settle();
    const throttleToasts = notices.slice(noticesBeforeThrottle).filter((notice) => notice.text === HOTAS_ASSIST_TOAST).length;
    check('assists', 'the second HOTAS device changes nothing', throttleToasts === 0 && assistsMatch(expectedAssists(HOTAS_ASSIST_LEVEL)), `${throttleToasts} toast(s); ${describeAssists()}`, `0 toasts; ${describeLevels(expectedAssists(HOTAS_ASSIST_LEVEL))}`);
    connection = input().getConnectionState();
    check('detection', 'prompt clears once stick and throttle are both present', connection.hotas.complete && connection.prompt === null && connection.hotas.pedals, `complete ${connection.hotas.complete}, pedals ${connection.hotas.pedals}, prompt ${connection.prompt}`, 'complete true, pedals true, prompt null');
    const stick = deviceSummary(STICK_KEY);
    const throttle = deviceSummary(THROTTLE_KEY);
    check('detection', 'stick identified by vendor / product id', stick && stick.kind === 'hotas-stick' && stick.profile === 't16000m', stick ? `${stick.deviceKey} ${stick.kind} ${stick.profile}` : 'missing', `${STICK_KEY} hotas-stick t16000m`);
    check('detection', 'throttle identified by vendor / product id', throttle && throttle.kind === 'hotas-throttle' && throttle.profile === 'twcs', throttle ? `${throttle.deviceKey} ${throttle.kind} ${throttle.profile}` : 'missing', `${THROTTLE_KEY} hotas-throttle twcs`);
    const connectedKeys = connections.filter((event) => event.type === 'connected').map((event) => event.deviceKey);
    check('detection', 'typed deviceConnected events', connectedKeys.includes(STICK_KEY) && connectedKeys.includes(THROTTLE_KEY), connectedKeys.join(', '), `${STICK_KEY}, ${THROTTLE_KEY}`);
    const eventsBeforeMove = connections.length;
    mock().moveToSlot('stick', 3);
    await settle();
    const keysAfterMove = input().getDevices().map((device) => device.deviceKey).sort();
    check('detection', 'a slot change keeps the device key (identified by id, not slot)', keysAfterMove.join(',') === [THROTTLE_KEY, STICK_KEY].sort().join(',') && connections.length === eventsBeforeMove, `${keysAfterMove.join(', ')}; ${connections.length - eventsBeforeMove} connect events`, `${STICK_KEY}, ${THROTTLE_KEY}; 0 connect events`);

    // 2. Default bindings against the spec.
    step('default bindings');
    for (const deviceKey of [STICK_KEY, THROTTLE_KEY]) {
      const effective = input().bindings.getEffective(deviceKey, 'glider');
      const buttonMap = {};
      const hatRefs = [];
      for (const [actionId, refs] of effective.actions) {
        for (const ref of refs) {
          if (ref.type === 'button') (buttonMap[ref.index] ??= []).push(actionId);
          if (ref.type === 'hat') hatRefs.push(`${ref.direction}:${actionId}`);
        }
      }
      const mismatches = [];
      for (const [index, expectedIds] of Object.entries(SPEC_BUTTONS[deviceKey])) {
        const actual = (buttonMap[index] ?? []).slice().sort();
        if (actual.join(',') !== expectedIds.slice().sort().join(',')) mismatches.push(`button ${index}: ${actual.join('+') || 'unbound'} (spec ${expectedIds.join('+')})`);
      }
      const name = deviceKey === STICK_KEY ? 'stick' : 'throttle';
      check('bindings', `${name} default buttons match the spec`, mismatches.length === 0, mismatches.length === 0 ? `${Object.keys(SPEC_BUTTONS[deviceKey]).length} buttons as specified` : mismatches.join('; '), 'spec Milestone D defaults');
      const expectedHats = deviceKey === STICK_KEY ? Object.entries(SPEC_STICK_HAT).map(([direction, id]) => `${direction}:${id}`).sort() : [];
      check('bindings', deviceKey === STICK_KEY ? 'stick hat bound to the view snaps' : 'throttle hat left unbound (Phase 4 music)', hatRefs.sort().join(',') === expectedHats.join(','), hatRefs.join(', ') || 'none', expectedHats.join(', ') || 'none');
      const axisMismatches = [];
      const axisMap = Object.fromEntries(effective.axes);
      for (const [target, spec] of Object.entries(SPEC_AXES[deviceKey])) {
        const ref = (axisMap[target] ?? []).find((candidate) => candidate.type === 'axis' && candidate.axis === spec.axis);
        if (!ref || (spec.role && ref.role !== spec.role)) axisMismatches.push(`${target}: ${ref ? `axis ${ref.axis} role ${ref.role ?? 'none'}` : 'missing'} (spec axis ${spec.axis}${spec.role ? ` ${spec.role}` : ''})`);
      }
      check('bindings', `${name} default axes match the spec`, axisMismatches.length === 0, axisMismatches.length === 0 ? Object.keys(SPEC_AXES[deviceKey]).join(', ') : axisMismatches.join('; '), 'spec Milestone D defaults');
    }

    // 3. Axes through the pipeline (before calibration: full raw range, profile idle ends).
    step('axes before calibration');
    setAxes('stick', { 0: 0.5 });
    await settle();
    checkValue('axes', 'stick X +0.5 -> roll', controls.roll, expectBipolar(0.5, TUNING.roll));
    setAxes('stick', { 0: -0.5, 1: 0.5 });
    await settle();
    checkValue('axes', 'stick X -0.5 -> roll', controls.roll, expectBipolar(-0.5, TUNING.roll));
    checkValue('axes', 'stick Y +0.5 -> pitch', controls.pitch, expectBipolar(0.5, TUNING.roll));
    setAxes('stick', { 0: 0.02, 1: 0 });
    await settle();
    checkValue('axes', 'stick X inside the deadzone -> roll 0', controls.roll, 0);
    setAxes('stick', { 0: 0.99 });
    await settle();
    checkValue('axes', 'stick X at the edge saturates -> roll 1', controls.roll, 1);
    setAxes('stick', { 0: 0 });
    setAxes('stick', { 5: 0.6 });
    await settle();
    checkValue('axes', 'twist 0.6 -> yaw (pedals not used yet)', controls.yaw, expectBipolar(0.6, TUNING.twist));
    setAxes('stick', { 5: 0 });
    setAxes('throttle', { 2: 0 });
    await settle();
    checkValue('axes', 'TWCS throttle half -> throttle', controls.throttle, expectUnipolar(0, TUNING.throttle, { idle: 1, full: -1 }));
    setAxes('throttle', { 2: -0.95 });
    await settle();
    checkValue('axes', 'TWCS throttle past the detent -> throttle', controls.throttle, expectUnipolar(-0.95, TUNING.throttle, { idle: 1, full: -1 }));
    check('axes', 'afterburner detent flagged past 95 %', controls.afterburner === true, controls.afterburner, true);
    const throttleBefore = controls.throttle;
    setAxes('stick', { 6: -1 });
    await settle();
    checkValue('axes', 'stick throttle slider ignored while the TWCS is present', controls.throttle, throttleBefore);
    setAxes('stick', { 6: 1 });
    setAxes('throttle', { 2: 1, 3: 1 });
    await settle();
    checkValue('axes', 'TWCS throttle idle -> 0', controls.throttle, 0);
    checkValue('axes', 'left toe brake pressed -> brakeL', controls.brakeL, expectUnipolar(1, TUNING.brake, { idle: -1, full: 1 }));
    setAxes('throttle', { 3: -1, 4: 0 });
    await settle();
    checkValue('axes', 'right toe brake half -> brakeR', controls.brakeR, expectUnipolar(0, TUNING.brake, { idle: -1, full: 1 }));
    checkValue('axes', 'left toe brake released -> 0', controls.brakeL, 0);
    setAxes('throttle', { 4: -1, 6: 0 });
    await settle();
    checkValue('axes', 'antenna half -> antenna', controls.antenna, expectUnipolar(0, TUNING.antenna, { idle: 1, full: -1 }));
    setAxes('throttle', { 6: 1, 0: 0.8, 1: 0.8 });
    await settle();
    checkValue('axes', 'mini-stick X -> free look X', controls.lookX, expectBipolar(0.8, TUNING.look));
    checkValue('axes', 'mini-stick Y (inverted) -> free look Y', controls.lookY, expectBipolar(0.8, TUNING.look, undefined, true));
    setAxes('throttle', { 0: 0, 1: 0 });
    await settle();
    check('axes', 'mini-stick released -> look returns to centre', controls.lookX === 0 && controls.lookY === 0, `${fixed(controls.lookX)}, ${fixed(controls.lookY)}`, '0, 0');
    const trimStart = controls.trim;
    const trimStartMs = performance.now();
    setAxes('throttle', { 5: 1 });
    await waitSeconds(0.5);
    setAxes('throttle', { 5: 0 });
    const trimSeconds = (performance.now() - trimStartMs) / 1000;
    await settle();
    const trimMoved = controls.trim - trimStart;
    check('axes', 'rocker held forward trims at its rate', trimMoved > 0.1 && trimMoved <= TUNING.rockerRate * (trimSeconds + 0.1) + TOLERANCE, `trim +${fixed(trimMoved, 3)} in ${fixed(trimSeconds, 2)} s`, `up to ${TUNING.rockerRate}/s`);
    const trimRest = controls.trim;
    await settle();
    checkValue('axes', 'rocker centred -> trim holds', controls.trim, trimRest);

    // 4. Buttons -> actions (every effect undone), throttle hat unbound. Stick button 9
    // (versionToggle) is checked in the binding table only: pressing it would leave V2.
    step('buttons');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 4, 'gearToggle');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 1, 'craftAbility');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 0, 'copilotPTT');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 2, 'waypointNearest');
    await checkButtonAction('buttons', 'throttle', THROTTLE_KEY, 0, 'recenterView');
    await checkButtonAction('buttons', 'throttle', THROTTLE_KEY, 4, 'engineToggle');
    await checkButtonAction('buttons', 'throttle', THROTTLE_KEY, 5, 'chuteDeploy');
    const flight = ctx.systems.flight;
    await checkButtonAction('buttons', 'stick', STICK_KEY, 8, 'craftNext');
    await settle();
    await checkButtonAction('buttons', 'stick', STICK_KEY, 7, 'craftPrev');
    await settle();
    check('buttons', 'craftNext then craftPrev returns to the glider', flight.getCraft() === 'glider', flight.getCraft(), 'glider');
    const panelOpen = (name) => () => document.getElementById(`dw-panel-${name}`)?.classList.contains('dw-open') === true;
    for (const [index, id, isOpen] of [[3, 'photoMode', () => state.photoMode], [14, 'journal', panelOpen('journal')], [15, 'settings', panelOpen('settings')]]) {
      await checkButtonAction('buttons', 'stick', STICK_KEY, index, id);
      await settle();
      const opened = isOpen();
      await tapButton('stick', index);
      await settle();
      const closed = isOpen();
      check('buttons', `${id} opens and closes again`, opened === true && closed === false, `${opened} then ${closed}`, 'true then false');
    }
    await checkButtonAction('buttons', 'stick', STICK_KEY, 11, 'timeForward');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 12, 'timeBack');
    await checkButtonAction('buttons', 'stick', STICK_KEY, 10, 'autopilotToggle');
    await settle();
    await tapButton('stick', 10);
    await settle();
    check('buttons', 'autopilotToggle twice leaves the autopilot off', !state.player.autopilot.enabled, state.player.autopilot.enabled, false);
    mock().press('throttle', 1);
    await waitFrames(4);
    const airbrakeHeld = controls.held.has('airbrake');
    mock().release('throttle', 1);
    await waitFrames(4);
    check('buttons', 'throttle button 1 holds airbrake while pressed', airbrakeHeld && !controls.held.has('airbrake'), `held ${airbrakeHeld}, after release ${controls.held.has('airbrake')}`, 'held true, after release false');
    const cameraSystem = ctx.systems.camera;
    const viewBefore = cameraSystem.getView();
    await checkButtonAction('buttons', 'throttle', THROTTLE_KEY, 7, 'viewToggle1P3P');
    await settle();
    const viewSwapped = cameraSystem.getView();
    await tapButton('throttle', 7);
    await settle();
    const viewAfter = cameraSystem.getView();
    check('buttons', 'viewToggle1P3P swaps first / third person and back', viewSwapped !== viewBefore && viewAfter === viewBefore, `${viewBefore} -> ${viewSwapped} -> ${viewAfter}`, `${viewBefore} -> the other person -> ${viewBefore}`);

    // 5. Hats before calibration: nothing is decoded until the wizard has learned them.
    step('hats before calibration');
    const beforeHat = actions.length;
    mock().setHat('stick', 'up');
    await settle();
    const unlearned = input().readDevice(STICK_KEY);
    mock().setHat('stick', null);
    await settle();
    check('hats', 'hats do nothing before calibration', actions.length === beforeHat && unlearned.hats[0].learned === false && unlearned.hats[0].direction === null, `${actions.length - beforeHat} actions, learned ${unlearned.hats[0].learned}`, '0 actions, learned false');
    check('hats', 'devices report that they need calibration', deviceSummary(STICK_KEY)?.needsCalibration === true && deviceSummary(THROTTLE_KEY)?.needsCalibration === true, `${deviceSummary(STICK_KEY)?.needsCalibration}, ${deviceSummary(THROTTLE_KEY)?.needsCalibration}`, 'true, true');

    // 6. Calibration through the InputManager's wizard API with scripted movements.
    await runCalibration();

    // 7. Calibrated pipeline and hat decoding.
    await checkCalibratedPipeline('calibrated');
    step('hat view snaps');
    for (const [direction, id] of Object.entries(SPEC_STICK_HAT)) {
      const from = actions.length;
      mock().setHat('stick', direction);
      await waitFrames(4);
      mock().setHat('stick', null);
      await waitFrames(4);
      const events = actions.slice(from);
      check('hats', `stick hat ${direction} -> ${id}`, events.length === 2 && events[0].id === id && events[0].phase === 'press' && events[1].phase === 'release', describeActions(events), `${id} press + release`);
    }
    const diagonalFrom = actions.length;
    mock().setHat('stick', 'upRight');
    await waitFrames(4);
    mock().setHat('stick', null);
    await waitFrames(4);
    check('hats', 'stick hat diagonal fires nothing (unbound)', actions.length === diagonalFrom, describeActions(actions.slice(diagonalFrom)), 'none');
    const throttleHatFrom = actions.length;
    for (const direction of HAT_DIRECTIONS) {
      mock().setHat('throttle', direction);
      await waitFrames(3);
    }
    mock().setHat('throttle', null);
    await waitFrames(4);
    check('hats', 'throttle hat fires nothing in any direction (reserved)', actions.length === throttleHatFrom, describeActions(actions.slice(throttleHatFrom)), 'none');
    // Back to the forward view (the last snap looked right).
    mock().setHat('stick', 'up');
    await waitFrames(4);
    mock().setHat('stick', null);
    await waitFrames(4);

    // 8. Twist auto-disable.
    await runTwistChecks();

    // 9. Persistence: a custom binding and a per-craft tuning, then a reload.
    step('saving bindings and calibration');
    const bound = input().bindings.bind({ device: THROTTLE_KEY, target: 'recenterView', ref: { type: 'button', index: 9 }, replace: false });
    check('persistence', 'custom binding: throttle button 9 -> recenterView', bound.ok, bound.ok ? 'bound' : bound.error, 'bound');
    const tuned = input().bindings.updateRef({ device: STICK_KEY, target: 'roll', index: 0, patch: { invert: true, deadzone: 0.1 }, craft: 'jet' });
    check('persistence', 'per-craft override: jet stick roll inverted, deadzone 0.1', tuned.ok, tuned.ok ? 'tuned' : tuned.error, 'tuned');
    session.expected = {
      profile: input().bindings.getProfile(),
      calibration: { [STICK_KEY]: input().calibration.get(STICK_KEY), [THROTTLE_KEY]: input().calibration.get(THROTTLE_KEY) },
    };
    await storage.flush();
    check('persistence', 'every write committed to IndexedDB before the reload', storage.pendingWrites === 0, `${storage.pendingWrites} pending`, '0 pending');
    session.phase = 'verify';
    saveSession();
    step('reloading the page');
    window.location.reload();
  }

  async function runCalibration() {
    step('calibration: centre');
    const wizard = input().startCalibration();
    setAxes('stick', CALIBRATION_SCRIPT.stick.rest);
    setAxes('throttle', CALIBRATION_SCRIPT.throttle.rest);
    mock().setHat('stick', null);
    mock().setHat('throttle', null);
    await waitFrames(40);
    let wizardState = wizard.getState();
    check('calibration', 'wizard starts at "center everything" and shows the pedal note', wizardState.step === 'center' && wizardState.note === 'Keep pedals centered and feet off when plugging in.', `${wizardState.step}, "${wizardState.note}"`, 'center, pedal note');
    const actionsDuring = actions.length;
    wizard.next();
    step('calibration: axes lock to lock');
    for (const phase of ['low', 'high', 'rest']) {
      setAxes('stick', CALIBRATION_SCRIPT.stick[phase]);
      setAxes('throttle', CALIBRATION_SCRIPT.throttle[phase]);
      await waitFrames(5);
    }
    wizardState = wizard.getState();
    // The axes the script moved lock to lock (a real device's unused axes never move).
    const unmoved = wizardState.devices.flatMap((device) => {
      const moved = CALIBRATION_SCRIPT[device.deviceKey === STICK_KEY ? 'stick' : 'throttle'].low;
      return device.axes.filter((axis) => String(axis.index) in moved && !axis.done).map((axis) => `${device.deviceKey} ${axis.label}`);
    });
    const movedCount = Object.keys(CALIBRATION_SCRIPT.stick.low).length + Object.keys(CALIBRATION_SCRIPT.throttle.low).length;
    check('calibration', 'the wizard saw every moved axis reach both ends', wizardState.step === 'axes' && unmoved.length === 0, unmoved.length === 0 ? `${movedCount} axes done` : `not done: ${unmoved.join(', ')}`, `${movedCount} axes done`);
    wizard.next();
    step('calibration: throttle forward');
    wizardState = wizard.getState();
    check('calibration', 'wizard asks for the throttle full forward', wizardState.step === 'throttle', wizardState.step, 'throttle');
    setAxes('throttle', { 2: -1 });
    setAxes('stick', { 6: -1 });
    await waitFrames(5);
    wizard.next();
    setAxes('throttle', { 2: 1 });
    setAxes('stick', { 6: 1 });
    await waitFrames(3);
    step('calibration: pedals and toe brakes');
    const pedalMoves = { rudderLeft: { 7: -0.97 }, rudderRight: { 7: 0.99 }, brakeLeft: { 3: 1 }, brakeRight: { 4: 1 } };
    for (const [substep, values] of Object.entries(pedalMoves)) {
      wizardState = wizard.getState();
      const onStep = wizardState.step === 'pedals' && wizardState.substep?.id === substep;
      setAxes('throttle', values);
      await waitFrames(5);
      const ready = wizard.getState().substep?.ready === true;
      check('calibration', `pedal step "${substep}" sees the pedal`, onStep && ready, `${wizardState.step}/${wizardState.substep?.id}, ready ${ready}`, `pedals/${substep}, ready true`);
      wizard.next();
      setAxes('throttle', CALIBRATION_SCRIPT.throttle.rest);
      await waitFrames(3);
    }
    step('calibration: hat directions');
    const learnedOrder = [];
    for (let guard = 0; guard < 24; guard++) {
      wizardState = wizard.getState();
      if (wizardState.step !== 'hats' || !wizardState.hat) break;
      const target = wizardState.hat;
      const handle = target.deviceKey === STICK_KEY ? 'stick' : 'throttle';
      learnedOrder.push(`${handle}:${target.direction}`);
      mock().setHat(handle, target.direction);
      await waitSeconds(0.2);
      await waitFrames(3);
      mock().setHat(handle, null);
      await waitFrames(4);
    }
    check('calibration', 'wizard walks both hats through all 8 directions', learnedOrder.length === 16, `${learnedOrder.length} directions (${learnedOrder.join(' ')})`, '16 directions');
    check('calibration', 'controller actions are ignored while calibrating', actions.length === actionsDuring, `${actions.length - actionsDuring} actions`, '0 actions');
    wizardState = wizard.getState();
    check('calibration', 'wizard reaches "calibration complete"', wizardState.step === 'done', wizardState.step, 'done');
    const results = Object.fromEntries((wizardState.results ?? []).map((result) => [result.deviceKey, result]));
    for (const [deviceKey, axes] of Object.entries(EXPECTED_CALIBRATION)) {
      const learnedAxes = results[deviceKey]?.axes ?? {};
      for (const [axis, expected] of Object.entries(axes)) {
        const learned = learnedAxes[axis];
        const passed = learned && Object.entries(expected).every(([field, value]) => close(learned[field], value, 1e-6)) && !learned.reversed;
        check('calibration', `${deviceKey === STICK_KEY ? 'stick' : 'throttle'} axis ${axis} learned`, passed, learned ? canonical(learned) : 'missing', canonical(expected));
      }
    }
    const stickHat = results[STICK_KEY]?.hats?.[0];
    const stickHatOk = stickHat && stickHat.form === 'axis' && stickHat.axis === 9 && close(stickHat.center, CHROME_HAT_CENTER, 1e-9)
      && HAT_DIRECTIONS.every((direction) => close(stickHat.values?.[direction], CHROME_HAT_VALUES[direction], 1e-9));
    check('calibration', 'stick hat learned in axis form (axis 9, centre and 8 values)', stickHatOk, stickHat ? canonical(stickHat) : 'missing', `axis 9, centre ${fixed(CHROME_HAT_CENTER)}, Chrome hat values`);
    const throttleHat = results[THROTTLE_KEY]?.hats?.[0];
    const throttleHatOk = throttleHat && throttleHat.form === 'buttons' && canonical(throttleHat.buttons) === canonical(Object.values(THROTTLE_HAT_BUTTONS).sort((first, second) => first - second))
      && HAT_DIRECTIONS.every((direction) => canonical((throttleHat.combos?.[direction] ?? []).slice().sort((first, second) => first - second)) === canonical(THROTTLE_HAT_COMBOS[direction]));
    check('calibration', 'throttle hat learned in button form (4 buttons, 8 combinations)', throttleHatOk, throttleHat ? canonical(throttleHat) : 'missing', canonical({ form: 'buttons', combos: THROTTLE_HAT_COMBOS }));
    const saved = wizard.finish();
    await settle();
    check('calibration', 'saving stores a record per device', saved.length === 2 && Boolean(input().calibration.peek(STICK_KEY)) && Boolean(input().calibration.peek(THROTTLE_KEY)), `${saved.length} records`, '2 records');
    check('calibration', 'devices no longer need calibration', deviceSummary(STICK_KEY)?.needsCalibration === false && deviceSummary(THROTTLE_KEY)?.needsCalibration === false, `${deviceSummary(STICK_KEY)?.needsCalibration}, ${deviceSummary(THROTTLE_KEY)?.needsCalibration}`, 'false, false');
  }

  /** Calibrated axes and hat decoding (after the wizard, and again after the reload). */
  async function checkCalibratedPipeline(group) {
    step(`${group}: axes and hats`);
    const stickCalibration = EXPECTED_CALIBRATION[STICK_KEY][0];
    for (const [raw, expected] of [[0.96, 1], [0.04, 0], [-0.93, -1], [0.5, (0.5 - 0.04) / (0.96 - 0.04)]]) {
      setAxes('stick', { 0: raw });
      await settle();
      checkValue(group, `stick X ${raw} reads ${fixed(expected, 3)} on the learned range`, input().readDevice(STICK_KEY).axes[0].value, expected);
    }
    checkValue(group, 'stick X 0.5 -> roll through the calibrated pipeline', controls.roll, expectBipolar(0.5, TUNING.roll, stickCalibration));
    setAxes('stick', { 0: CALIBRATION_SCRIPT.stick.rest[0] });
    await settle();
    checkValue(group, 'stick resting off centre (0.04) -> roll 0', controls.roll, 0);
    setAxes('throttle', { 2: 0 });
    await settle();
    checkValue(group, 'throttle half -> throttle on the learned ends', controls.throttle, expectUnipolar(0, TUNING.throttle, EXPECTED_CALIBRATION[THROTTLE_KEY][2]));
    setAxes('throttle', { 2: 1 });
    await settle();
    for (const handle of ['stick', 'throttle']) {
      const deviceKey = handle === 'stick' ? STICK_KEY : THROTTLE_KEY;
      const decoded = [];
      for (const direction of HAT_DIRECTIONS) {
        mock().setHat(handle, direction);
        await waitFrames(3);
        decoded.push(input().readDevice(deviceKey).hats[0].direction);
      }
      mock().setHat(handle, null);
      await waitFrames(3);
      const centred = input().readDevice(deviceKey).hats[0].direction;
      check(group, `${handle} hat (${handle === 'stick' ? 'axis' : 'button'} form) decodes all 8 directions and centre`, decoded.join(',') === HAT_DIRECTIONS.join(',') && centred === null, `${decoded.join(' ')}; centre ${centred}`, `${HAT_DIRECTIONS.join(' ')}; centre null`);
    }
  }

  async function runTwistChecks() {
    step('twist auto-disable');
    let twist = input().getTwistState();
    check('twist', 'twist live while the pedals have not moved', twist.setting === 'auto' && twist.pedalsPresent && !twist.pedalsMoved && twist.twistActive, canonical(twist), 'auto, pedals present, not moved, twist active');
    const twistCalibration = EXPECTED_CALIBRATION[STICK_KEY][5];
    const rudderCalibration = EXPECTED_CALIBRATION[THROTTLE_KEY][7];
    setAxes('stick', { 5: 0.6 });
    await settle();
    checkValue('twist', 'twist 0.6 -> yaw', controls.yaw, expectBipolar(0.6, TUNING.twist, twistCalibration));
    setAxes('stick', { 5: twistCalibration.center });
    setAxes('throttle', { 7: 0.6 });
    await settle();
    twist = input().getTwistState();
    check('twist', 'pedal rudder movement disables twist', twist.pedalsMoved && !twist.twistActive, `pedals moved ${twist.pedalsMoved}, twist active ${twist.twistActive}`, 'pedals moved true, twist active false');
    checkValue('twist', 'pedal rudder 0.6 -> yaw', controls.yaw, expectBipolar(0.6, TUNING.rudder, rudderCalibration));
    setAxes('throttle', { 7: rudderCalibration.center });
    setAxes('stick', { 5: 0.6 });
    await settle();
    checkValue('twist', 'twist ignored after the pedals moved', controls.yaw, 0);
    settings.set('twistYaw', 'on');
    await settle();
    checkValue('twist', 'twistYaw "on" forces twist back on', controls.yaw, expectBipolar(0.6, TUNING.twist, twistCalibration));
    settings.set('twistYaw', 'auto');
    await settle();
    checkValue('twist', 'back to "auto": twist ignored again', controls.yaw, 0);
    mock().unplug('throttle');
    await settle();
    twist = input().getTwistState();
    checkValue('twist', 'pedals unplugged: twist re-arms', controls.yaw, expectBipolar(0.6, TUNING.twist, twistCalibration));
    check('twist', 'twist state after unplugging the pedals', !twist.pedalsPresent && !twist.pedalsMoved && twist.twistActive, canonical(twist), 'pedals absent, twist active');
    setAxes('stick', { 5: twistCalibration.center });
    await plugAndExpose('throttle', 'twcs', 0, 'chrome', 9);
    setAxes('throttle', CALIBRATION_SCRIPT.throttle.rest);
    await settle();
    check('twist', 'throttle re-plugged under the same key', Boolean(deviceSummary(THROTTLE_KEY)), deviceSummary(THROTTLE_KEY)?.deviceKey ?? 'missing', THROTTLE_KEY);
  }

  // ---- Part 2 (after the reload): persistence -----------------------------------------------------------
  async function runVerify() {
    step('checking what came back from IndexedDB');
    const expected = session.expected;
    check('persistence', 'storage reopened from IndexedDB after the reload', storage.backend === 'indexeddb' && storage.databaseName === TEST_DATABASE, `${storage.backend} ${storage.databaseName}`, `indexeddb ${TEST_DATABASE}`);
    const profile = input().bindings.getProfile();
    check('persistence', 'bindings came back unchanged', Boolean(expected) && canonical(profile) === canonical(expected.profile), `${canonical(profile).length} bytes${expected && canonical(profile) === canonical(expected.profile) ? ', identical' : ', different'}`, `${expected ? canonical(expected.profile).length : 0} bytes, identical`);
    for (const deviceKey of [STICK_KEY, THROTTLE_KEY]) {
      const record = input().calibration.get(deviceKey);
      check('persistence', `${deviceKey === STICK_KEY ? 'stick' : 'throttle'} calibration came back unchanged`, Boolean(expected) && Boolean(record) && canonical(record) === canonical(expected.calibration[deviceKey]), record ? `${Object.keys(record.axes).length} axes, ${record.hats.filter(Boolean).length} hats` : 'missing', 'identical record');
    }
    check('assists', 'after the reload: the HOTAS default is still remembered', settings.get('hotasAssistsApplied') === true && assistsMatch(expectedAssists(HOTAS_ASSIST_LEVEL)), `${describeAssists()}, applied ${settings.get('hotasAssistsApplied')}`, `${describeLevels(expectedAssists(HOTAS_ASSIST_LEVEL))}, applied true`);
    settings.update('assists', { [PLAYER_SET_AFTER_RELOAD.craft]: PLAYER_SET_AFTER_RELOAD.level });
    step('re-plugging in other slots');
    settings.set('craft', 'glider');
    await settle();
    const noticesBeforeReplug = notices.length;
    await plugAndExpose('stick', 't16000m', 0, 'prefix', 4);
    await plugAndExpose('throttle', 'twcs', 3, 'chrome', 12);
    const replugToasts = notices.slice(noticesBeforeReplug).filter((notice) => notice.text === HOTAS_ASSIST_TOAST).length;
    const afterReload = { ...expectedAssists(HOTAS_ASSIST_LEVEL), [PLAYER_SET_AFTER_RELOAD.craft]: PLAYER_SET_AFTER_RELOAD.level };
    check('assists', 'after the reload: a re-plugged HOTAS changes nothing and shows no toast', replugToasts === 0 && assistsMatch(afterReload), `${replugToasts} toast(s); ${describeAssists()}`, `0 toasts; ${describeLevels(afterReload)}`);
    setAxes('stick', CALIBRATION_SCRIPT.stick.rest);
    setAxes('throttle', CALIBRATION_SCRIPT.throttle.rest);
    await settle();
    const keys = input().getDevices().map((device) => `${device.deviceKey}@${device.slot}`).sort();
    check('persistence', 'devices in new slots and another id format keep their keys', Boolean(deviceSummary(STICK_KEY)) && Boolean(deviceSummary(THROTTLE_KEY)), keys.join(', '), `${STICK_KEY}@0, ${THROTTLE_KEY}@3`);
    check('persistence', 'no calibration needed after the reload', deviceSummary(STICK_KEY)?.needsCalibration === false && deviceSummary(THROTTLE_KEY)?.needsCalibration === false, `${deviceSummary(STICK_KEY)?.needsCalibration}, ${deviceSummary(THROTTLE_KEY)?.needsCalibration}`, 'false, false');
    await checkCalibratedPipeline('persistence');
    await checkButtonAction('persistence', 'throttle', THROTTLE_KEY, 9, 'recenterView', 'custom binding works: throttle button 9 -> recenterView');
    settings.set('craft', 'jet');
    await settle();
    const stickCalibration = EXPECTED_CALIBRATION[STICK_KEY][0];
    setAxes('stick', { 0: 0.5 });
    await settle();
    checkValue('persistence', 'jet override works: stick X 0.5 -> inverted roll, deadzone 0.1', controls.roll, expectBipolar(0.5, { ...TUNING.roll, deadzone: 0.1 }, stickCalibration, true));
    settings.set('craft', 'glider');
    await settle();
    checkValue('persistence', 'glider keeps the global binding: stick X 0.5 -> roll', controls.roll, expectBipolar(0.5, TUNING.roll, stickCalibration));
    setAxes('stick', CALIBRATION_SCRIPT.stick.rest);
    await settle();

    step('cleaning up');
    input().bindings.resetToDefaults();
    input().calibration.reset(STICK_KEY);
    input().calibration.reset(THROTTLE_KEY);
    resetAssistState();
    await storage.flush();
    check('cleanup', 'test database left with default bindings and no calibration', input().calibration.keys().length === 0 && canonical(input().bindings.getProfile().global) === '{}', `${input().calibration.keys().length} calibration records`, '0 calibration records, default bindings');
  }

  // ---- Assist defaults ---------------------------------------------------------------------------------
  /** Back to a first run: assists at 100 %, none set by the player, the HOTAS default not applied. */
  function resetAssistState() {
    settings.reset('assists');
    settings.reset('assistsSetByPlayer');
    settings.reset('hotasAssistsApplied');
  }

  /** Every craft at level except the one the player set before the HOTAS arrived. */
  function expectedAssists(level) {
    return Object.fromEntries(CRAFT_IDS.map((id) => [id, id === PLAYER_SET_CRAFT.craft ? PLAYER_SET_CRAFT.level : level]));
  }

  function assistsMatch(expected) {
    const assists = settings.get('assists');
    return CRAFT_IDS.every((id) => close(assists[id], expected[id]));
  }

  function describeLevels(levels) {
    return CRAFT_IDS.map((id) => `${id} ${Math.round(levels[id] * 100)}%`).join(', ');
  }

  function describeAssists() {
    return describeLevels(settings.get('assists'));
  }

  function setByPlayerList() {
    const setByPlayer = settings.get('assistsSetByPlayer');
    return CRAFT_IDS.filter((id) => setByPlayer[id] === true).join(', ');
  }

  // ---- Report -------------------------------------------------------------------------------------------
  function consoleTotals() {
    const pending = capture.entries;
    const errors = session.consoleCounts.errors + capture.counts.errors;
    const warnings = session.consoleCounts.warnings + capture.counts.warnings;
    return { errors, warnings, entries: session.console.concat(pending) };
  }

  function publish() {
    const totals = consoleTotals();
    const passed = session.checks.filter((entry) => entry.passed).length;
    const complete = session.phase === 'complete';
    const failed = session.checks.some((entry) => !entry.passed) || totals.errors > 0 || totals.warnings > 0 || session.harnessErrors.length > 0;
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status: complete ? 'complete' : 'running',
      result: complete ? (failed ? 'FAIL' : 'PASS') : null,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt ?? null,
      progress: { done: session.checks.length, total: null, phase: session.phase, step: currentStep },
      environment: { backend: ctx.backend, backends: [ctx.backend], revision: ctx.THREE.REVISION, userAgent: navigator.userAgent, database: storage.databaseName },
      criteria: [
        { id: 'checks', label: 'Pipeline checks', value: `${passed} / ${session.checks.length}`, status: passed === session.checks.length ? 'pass' : 'fail' },
        { id: 'console', label: 'Console errors / warnings', value: `${totals.errors} / ${totals.warnings}`, status: totals.errors === 0 && totals.warnings === 0 ? 'pass' : 'fail' },
      ],
      totals: { checks: session.checks.length, passed, failed: session.checks.length - passed, consoleErrors: totals.errors, consoleWarnings: totals.warnings },
      checks: session.checks,
      console: totals.entries.slice(0, 200),
      harnessErrors: session.harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function saveSession() {
    for (const entry of capture.entries) {
      if (session.console.length < 200) session.console.push(entry);
    }
    session.consoleCounts.errors += capture.counts.errors;
    session.consoleCounts.warnings += capture.counts.warnings;
    capture.entries.length = 0;
    capture.counts.errors = 0;
    capture.counts.warnings = 0;
    const error = writeSession(SESSION_KEY, session);
    if (error) {
      session.harnessErrors.push(error);
      console.error(`[DRIFTWING test] ${error}`);
    }
  }

  function showSummary() {
    publish();
    const groups = [...new Set(session.checks.map((entry) => entry.group))];
    const summary = groups.map((group) => {
      const inGroup = session.checks.filter((entry) => entry.group === group);
      return `${group}: ${inGroup.filter((entry) => entry.passed).length}/${inGroup.length}`;
    });
    const sections = [{
      title: 'Groups',
      table: {
        columns: [
          { key: 'group', label: 'Group' },
          { key: 'checks', label: 'Checks', numeric: true },
          { key: 'passed', label: 'Passed', numeric: true },
          { key: 'result', label: 'Result' },
        ],
        rows: groups.map((group) => {
          const inGroup = session.checks.filter((entry) => entry.group === group);
          const passedInGroup = inGroup.filter((entry) => entry.passed).length;
          return { group, checks: inGroup.length, passed: passedInGroup, result: { text: passedInGroup === inGroup.length ? 'PASS' : 'FAIL', status: passedInGroup === inGroup.length ? 'pass' : 'fail' } };
        }),
      },
    }, {
      title: 'Checks',
      table: {
        columns: [
          { key: 'group', label: 'Group' },
          { key: 'name', label: 'Check', wrap: true },
          { key: 'actual', label: 'Actual', wrap: true },
          { key: 'expected', label: 'Expected', wrap: true },
          { key: 'result', label: 'Result' },
        ],
        rows: session.checks.map((entry) => ({
          group: entry.phase === 'verify' ? `${entry.group} (reload)` : entry.group,
          name: entry.name,
          actual: entry.actual,
          expected: entry.expected,
          result: { text: entry.passed ? 'PASS' : 'FAIL', status: entry.passed ? 'pass' : 'fail' },
        })),
      },
    }];
    if (report.console.length > 0) sections.push({ title: 'Console errors and warnings', notes: report.console.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) });
    if (report.harnessErrors.length > 0) sections.push({ title: 'Harness problems', notes: report.harnessErrors });
    sections.push({ title: 'About', notes: [
      'Mock devices from src/dev/mockGamepads.js: T.16000M stick (044f:b10a, axis-form hat) and TWCS throttle with TFRP pedals (044f:b687, button-form hat).',
      'Expected axis values are computed from the documented pipeline: calibration, invert, deadzone, saturation, expo; smoothing is allowed to settle.',
      `The test runs in its own IndexedDB database (${TEST_DATABASE}) and leaves it clean; the player's bindings and calibration are never touched.`,
    ] });
    panel.showSummary({
      result: report.result,
      subtitle: summary.join(' · '),
      meta: [
        ['Backend', ctx.backend],
        ['three.js', `r${ctx.THREE.REVISION}`],
        ['Checks', `${report.totals.passed} / ${report.totals.checks} passed`],
        ['Console', `${report.totals.consoleErrors} errors, ${report.totals.consoleWarnings} warnings`],
        ['Finished', report.finishedAt ? new Date(report.finishedAt).toLocaleString() : '-'],
      ],
      criteria: report.criteria,
      sections,
      report,
      filename: `driftwing-hotas-test-${ctx.backend.toLowerCase()}.json`,
      actions: [{ label: 'Run again', onClick: () => {
        const error = removeSession(SESSION_KEY);
        if (error) console.error(`[DRIFTWING test] ${error}`);
        window.location.reload();
      } }],
    });
  }

  function finish() {
    session.phase = 'complete';
    session.finishedAt = new Date().toISOString();
    saveSession();
    const error = removeSession(SESSION_KEY);
    if (error) session.harnessErrors.push(error);
    showSummary();
  }

  function abort(error) {
    const message = `HOTAS test stopped at "${currentStep}": ${error && error.message ? error.message : error}`;
    session.harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    finish();
  }

  bus.on('game:ready', () => {
    publish();
    const run = session.phase === 'verify' ? runVerify().then(finish) : runSetup();
    run.catch(abort);
  });
  panel.setProgress({ label: 'HOTAS pipeline test', detail: continuing ? 'Part 2 of 2: waiting for the game after the reload' : 'Part 1 of 2: waiting for the game', fraction: continuing ? 0.6 : 0 });

  return {
    update() {
      frame++;
      const waiters = frameWaiters.splice(0, frameWaiters.length);
      for (const resolve of waiters) resolve();
    },
    getReport() {
      return report;
    },
  };
}
