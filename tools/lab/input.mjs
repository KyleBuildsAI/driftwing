// Input lab: runs the controller input modules headless (node, no browser) against scripted device
// readings and checks the cases the v2 Phase 1 review found, so they stay fixed.
//
// Tests:
//   axisPress    bind-by-listening on an axis stores the direction the device mapper tests: one-sided
//                axes resting at raw +1 (TWCS throttle, antenna, stick slider) and a pedal rudder
//                with a reversed calibration; the bound action then fires when the axis is pushed
//   import       importing a bindings file without the connected HOTAS devices keeps them registered,
//                so their default bindings stay live
//   tabKey       a keyboard listen lets Tab and Shift+Tab through (focus moves on) and still binds
//                the next key
//   wizardLate   a throttle that first appears after the Center step keeps its saved calibration
//                (throttle idle / full, learned hat) and is listed as joined late
//   wizardBack   Back on the results screen returns to the last step that has something to learn
//                when no hats are queued (a standard gamepad only)
//
// Usage: node tools/lab/input.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { EventBus } from '../../src/core/eventBus.js';
import { createActionRouter } from '../../src/input/actions.js';
import { createBindingStore } from '../../src/input/bindings.js';
import { createCalibrationStore, createCalibrationWizard } from '../../src/input/calibration.js';
import { createInputCapture } from '../../src/input/capture.js';
import { createControlState } from '../../src/input/controlState.js';
import { createDeviceMapper, createFrameAccumulator, resetFrameAccumulator } from '../../src/input/deviceMapper.js';
import { DEVICE_PROFILES, bindingDeviceFor } from '../../src/input/hotas/devices.js';

const VERBOSE = process.argv.includes('--verbose');
const results = [];

function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  if (VERBOSE || !pass) process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}${detail ? `: ${detail}` : ''}\n`);
}

/** In-memory stand-in for core/storage (read, write, remove, keys). */
function createMemoryStorage() {
  const values = new Map();
  return {
    read(key, fallback) {
      return values.has(key) ? structuredClone(values.get(key)) : fallback;
    },
    write(key, value) {
      values.set(key, structuredClone(value));
    },
    remove(key) {
      values.delete(key);
    },
    keys(prefix) {
      return [...values.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

/** Raw resting values of a profile's axes: centred sticks, levers at idle, toe brakes released. */
function restAxes(profileId) {
  const axes = DEVICE_PROFILES[profileId].axes;
  const values = new Array(Math.max(...axes.map((axis) => axis.index)) + 1).fill(0);
  for (const axis of axes) {
    if (axis.range !== 'unipolar') continue;
    values[axis.index] = axis.restIsIdle ? -1 : axis.idleRaw ?? -1;
  }
  return values;
}

/** A connected device as the gamepad registry builds it, from a profile id and raw axis values. */
function makeDevice(profileId, deviceKey, axes, buttonCount = 16) {
  const profile = DEVICE_PROFILES[profileId];
  const device = {
    deviceKey,
    profile: profileId,
    kind: profile.kind,
    name: profile.name,
    axes: axes.slice(),
    restAxes: axes.slice(),
    buttons: Array.from({ length: buttonCount }, () => ({ pressed: false, value: 0 })),
    axisLabels: Object.fromEntries(profile.axes.map((axis) => [axis.index, axis.label])),
    buttonLabels: profile.buttonLabels,
  };
  device.bindingDevice = bindingDeviceFor(device);
  return device;
}

/** The input manager's controller wiring (bindings, calibration, mapper, capture) around live devices. */
function createRig(devices) {
  const storage = createMemoryStorage();
  const bus = new EventBus();
  const controls = createControlState();
  const bindings = createBindingStore({ storage });
  const calibration = createCalibrationStore({ storage });
  const router = createActionRouter({ bus, controls });
  const registry = { live: () => devices };
  const mapper = createDeviceMapper({ bindings, calibration, router, canPress: () => !capture.active });
  const capture = createInputCapture({ registry, calibration, mapper });
  // As in InputManager: whatever a device still holds when a listen ends stays silent until released.
  capture.onChange((listenState) => {
    if (!listenState.active) for (const device of devices) mapper.latchHeld(device);
  });
  for (const device of devices) bindings.registerDevice(device.bindingDevice, device.profile, device.name);
  const frame = createFrameAccumulator();
  const connectedKinds = new Set(devices.map((device) => device.kind));
  /** One input frame: every device through the mapper, then the listen session. */
  function tick() {
    resetFrameAccumulator(frame);
    for (const device of devices) {
      mapper.evaluate(device, { frame, craft: 'glider', mode: 'sim', seconds: 1 / 60, twistEnabled: true, connectedKinds, actionsEnabled: true, axesEnabled: true });
    }
    capture.sample(devices);
    return frame;
  }
  return { storage, bus, controls, bindings, calibration, router, mapper, capture, tick };
}

/** Binds actionId by listening while script() moves the device, then returns the captured ref. */
async function listenFor(rig, actionId, script) {
  const pending = rig.capture.start({ target: actionId });
  rig.tick();
  script();
  rig.tick();
  const captured = await pending;
  if (captured.ok) rig.bindings.bind({ device: captured.device, target: actionId, ref: captured.ref });
  return captured;
}

/** True while actionId is held after the device readings are applied. */
function heldAfter(rig, actionId) {
  rig.tick();
  return rig.controls.held.has(actionId);
}

// ---- axisPress -------------------------------------------------------------------------------------
async function testAxisPress() {
  const oneSided = [
    { profile: 'twcs', key: '044f-b687', axis: 2, label: 'TWCS throttle' },
    { profile: 'twcs', key: '044f-b687', axis: 6, label: 'TWCS antenna' },
    { profile: 't16000m', key: '044f-b10a', axis: 6, label: 'stick slider' },
  ];
  for (const { profile, key, axis, label } of oneSided) {
    const device = makeDevice(profile, key, restAxes(profile));
    const rig = createRig([device]);
    const captured = await listenFor(rig, 'gearToggle', () => { device.axes[axis] = -1; });
    check('axisPress', `${label}: captured`, captured.ok && captured.ref.type === 'axisPress' && captured.ref.axis === axis, JSON.stringify(captured.ref ?? captured));
    check('axisPress', `${label}: direction toward full`, captured.ref?.direction === 1, `direction ${captured.ref?.direction}`);
    device.axes[axis] = 1;
    heldAfter(rig, 'gearToggle');
    device.axes[axis] = -1;
    check('axisPress', `${label}: pushing to full presses`, heldAfter(rig, 'gearToggle'));
    device.axes[axis] = 1;
    check('axisPress', `${label}: back to idle releases`, !heldAfter(rig, 'gearToggle'));
  }

  // Pedal rudder with a reversed calibration: pushing the right pedal lowers the raw value.
  const pedals = makeDevice('twcs', '044f-b687', restAxes('twcs'));
  const rig = createRig([pedals]);
  rig.calibration.save(pedals.deviceKey, {
    deviceKey: pedals.deviceKey,
    profile: 'twcs',
    name: pedals.name,
    calibratedAt: new Date(0).toISOString(),
    axes: { 7: { min: -1, center: 0, max: 1, reversed: true } },
    hats: [],
    notes: [],
  });
  const captured = await listenFor(rig, 'viewRight', () => { pedals.axes[7] = -0.9; });
  check('axisPress', 'reversed rudder: right pedal reads positive', captured.ref?.direction === 1, `direction ${captured.ref?.direction}`);
  pedals.axes[7] = 0;
  heldAfter(rig, 'viewRight');
  pedals.axes[7] = -0.9;
  check('axisPress', 'reversed rudder: right pedal presses', heldAfter(rig, 'viewRight'));
  pedals.axes[7] = 0.9;
  check('axisPress', 'reversed rudder: left pedal does not press', !heldAfter(rig, 'viewRight'));

  // A plain bipolar axis keeps the raw sign (mini-stick pushed left).
  const stickRig = createRig([pedals]);
  pedals.axes[7] = 0;
  const miniStick = await listenFor(stickRig, 'viewLeft', () => { pedals.axes[0] = -0.9; });
  check('axisPress', 'plain bipolar axis: raw sign kept', miniStick.ref?.direction === -1 && miniStick.ref?.axis === 0, JSON.stringify(miniStick.ref));
}

// ---- import ----------------------------------------------------------------------------------------
function testImport() {
  const stick = makeDevice('t16000m', '044f-b10a', restAxes('t16000m'));
  const throttle = makeDevice('twcs', '044f-b687', restAxes('twcs'));
  const rig = createRig([stick, throttle]);
  const axesOf = (device) => rig.bindings.getEffective(device, 'glider').axes.map(([target]) => target);
  const before = axesOf(stick.bindingDevice);
  const file = JSON.stringify({ kind: 'driftwing-bindings', version: 1, profile: { version: 1, devices: {}, global: { keyboard: { gearToggle: [{ type: 'key', code: 'KeyJ' }] } }, crafts: {} } });
  const result = rig.bindings.importJSON(file);
  check('import', 'file accepted', result.ok, result.errors.join('; '));
  check('import', 'imported binding applied', rig.bindings.getRefs('keyboard', 'gearToggle')[0]?.code === 'KeyJ');
  const after = axesOf(stick.bindingDevice);
  check('import', 'stick keeps its default axes', before.length > 0 && after.join(',') === before.join(','), `before [${before}] after [${after}]`);
  check('import', 'throttle keeps its profile', rig.bindings.profileIdFor(throttle.bindingDevice) === 'twcs', rig.bindings.profileIdFor(throttle.bindingDevice));
  check('import', 'stored profile lists the devices', Object.keys(rig.bindings.getProfile().devices).sort().join(',') === '044f-b10a,044f-b687');
}

// ---- tabKey ----------------------------------------------------------------------------------------
async function testTabKey() {
  const rig = createRig([]);
  const pending = rig.capture.start({ target: 'gearToggle', device: 'keyboard' });
  check('tabKey', 'Tab is not consumed', rig.capture.offerKey('Tab', false) === false);
  check('tabKey', 'Shift+Tab is not consumed', rig.capture.offerKey('Tab', true) === false);
  check('tabKey', 'still listening after Tab', rig.capture.active);
  rig.capture.offerKey('KeyJ', false);
  const captured = await pending;
  check('tabKey', 'next key is bound', captured.ok && captured.ref.code === 'KeyJ', JSON.stringify(captured.ref ?? captured));
}

// ---- calibration wizard ----------------------------------------------------------------------------
/** InputManager's roleAxesFor: which axes of a device play which role under its bindings. */
function roleAxesFrom(bindings, devices) {
  return (deviceKey) => {
    const device = devices().find((candidate) => candidate.deviceKey === deviceKey);
    const roles = { throttle: [], rudder: [], brakeL: [], brakeR: [], unipolar: [] };
    if (!device) return roles;
    for (const axis of DEVICE_PROFILES[device.profile].axes) if (axis.range === 'unipolar') roles.unipolar.push(axis.index);
    for (const [target, refs] of bindings.getEffective(device.bindingDevice, 'glider').axes) {
      for (const ref of refs) {
        if (ref.type !== 'axis') continue;
        if ((target === 'throttle' || target === 'collective') && !ref.rate) roles.throttle.push(ref.axis);
        if (ref.role === 'rudder') roles.rudder.push(ref.axis);
        if (target === 'brakeL') roles.brakeL.push(ref.axis);
        if (target === 'brakeR') roles.brakeR.push(ref.axis);
      }
    }
    for (const role of Object.keys(roles)) roles[role] = [...new Set(roles[role])];
    return roles;
  };
}

/** InputManager's wizardDevices: plain snapshots of the live devices. */
function wizardReadings(devices) {
  return () => devices().map((device) => ({ deviceKey: device.deviceKey, profile: device.profile, name: device.name, axes: device.axes, buttons: device.buttons.map((button) => button.pressed) }));
}

function testWizardLate() {
  const stick = makeDevice('t16000m', '044f-b10a', restAxes('t16000m'));
  const throttle = makeDevice('twcs', '044f-b687', restAxes('twcs'));
  const live = [stick];
  const rig = createRig([stick, throttle]);
  const saved = rig.calibration.save(throttle.deviceKey, {
    deviceKey: throttle.deviceKey,
    profile: 'twcs',
    name: throttle.name,
    calibratedAt: new Date(0).toISOString(),
    axes: { 2: { idle: 0.98, full: -0.97 } },
    hats: [{ form: 'buttons', buttons: [12, 13, 14, 15], combos: { up: [12], upRight: [12, 13], right: [13], downRight: [13, 14], down: [14], downLeft: [14, 15], left: [15], upLeft: [12, 15] } }],
    notes: [],
  });
  const wizard = createCalibrationWizard({ readDevices: wizardReadings(() => live), roleAxes: roleAxesFrom(rig.bindings, () => live), store: rig.calibration });
  for (let frame = 0; frame < 10; frame++) wizard.sample(1 / 60);
  wizard.next();
  // The TWCS shows up only now (Chrome exposes it after a button press), during the Axes step.
  live.push(throttle);
  for (const raw of [-1, 1, 0]) {
    stick.axes[0] = raw;
    stick.axes[1] = raw;
    throttle.axes[2] = raw;
    wizard.sample(1 / 60);
  }
  let state = wizard.getState();
  check('wizardLate', 'late throttle listed', state.lateDevices?.some((device) => device.deviceKey === throttle.deviceKey), JSON.stringify(state.lateDevices));
  check('wizardLate', 'late throttle not in this run', !state.devices.some((device) => device.deviceKey === throttle.deviceKey));
  for (let guard = 0; guard < 40 && state.step !== 'done'; guard++) state = wizard.skip();
  check('wizardLate', 'reached the results', state.step === 'done', state.step);
  check('wizardLate', 'results leave the late throttle out', state.results?.every((result) => result.deviceKey !== throttle.deviceKey), (state.results ?? []).map((result) => result.deviceKey).join(','));
  const written = wizard.finish().map((record) => record.deviceKey);
  check('wizardLate', 'stick saved', written.includes(stick.deviceKey), written.join(','));
  const after = rig.calibration.peek(throttle.deviceKey);
  check('wizardLate', 'throttle record kept', JSON.stringify(after?.axes) === JSON.stringify(saved.axes) && after?.hats?.[0]?.form === 'buttons', JSON.stringify(after?.axes));
}

function testWizardBack() {
  const pad = makeDevice('standard', 'gamepad-1', restAxes('standard'), 17);
  pad.bindingDevice = 'gamepad';
  const live = [pad];
  const rig = createRig(live);
  const wizard = createCalibrationWizard({ readDevices: wizardReadings(() => live), roleAxes: roleAxesFrom(rig.bindings, () => live), store: rig.calibration });
  wizard.sample(1 / 60);
  wizard.next();
  let state = wizard.next();
  check('wizardBack', 'gamepad goes from Axes to the results', state.step === 'done', state.step);
  state = wizard.back();
  check('wizardBack', 'Back from the results reaches Axes', state.step === 'axes', state.step);
  state = wizard.back();
  check('wizardBack', 'Back again reaches Center', state.step === 'center', state.step);
}

await testAxisPress();
testImport();
await testTabKey();
testWizardLate();
testWizardBack();

const failures = results.filter((result) => !result.pass);
process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed${failures.length ? `; ${failures.length} FAILED` : ''}\n`);
process.exit(failures.length ? 1 : 0);
