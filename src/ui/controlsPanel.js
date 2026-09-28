// Controls panel: one tab per device (keyboard and mouse, each connected gamepad, each HOTAS
// device) with live axis bars, button lights and hat indicators; the grouped binding list with
// bind-by-listening, conflict warnings that offer to replace, a global / per-craft scope, per-axis
// tuning with a live response curve, reset with confirmation, JSON export / import, and the
// calibration wizard (calibrationWizard.js).
//
// Everything goes through the input system (ctx.systems.input, see "For developers" in
// docs/controls.md), which persists bindings and calibration in IndexedDB. The panel skeleton
// (#dw-panel-controls) is in index.html; ui.js opens and closes it like the other panels and calls
// update(step) every frame while it is open. The input system is created after the UI, so it is
// looked up lazily, never during construction.

import { ACTION_IDS, ACTIONS } from '../input/controlState.js';
import { AXIS_TARGETS, AXIS_TARGET_IDS } from '../input/defaultBindings.js';
import { DEFAULT_AXIS_TUNING, applyDeadzoneAndSaturation, applyExpo } from '../input/axisPipeline.js';
import { DEVICE_PROFILES } from '../input/hotas/devices.js';
import { HAT_DIRECTION_LABELS } from '../input/hats.js';
import { createCalibrationWizardView } from './calibrationWizard.js';

/** Binding groups in list order. Axis functions first, then the discrete actions. */
const BINDING_GROUPS = Object.freeze([
  { id: 'axes', label: 'Flight axes', targets: AXIS_TARGET_IDS },
  { id: 'flight', label: 'Flight', targets: ['craftAbility', 'gearToggle', 'flapsDown', 'flapsUp', 'airbrake', 'engineToggle', 'chuteDeploy', 'autopilotToggle'] },
  { id: 'view', label: 'View', targets: ['viewCycle', 'viewForward', 'viewBack', 'viewLeft', 'viewRight', 'recenterView', 'photoMode'] },
  { id: 'craft', label: 'Craft', targets: ['craftNext', 'craftPrev', 'craftSelect1', 'craftSelect2', 'craftSelect3', 'craftSelect4', 'craftSelect5', 'craftSelect6', 'relaunch'] },
  { id: 'gameplay', label: 'Gameplay', targets: ['copilotPTT', 'waypointAhead', 'waypointNearest', 'ringCourse', 'timeForward', 'timeBack'] },
  { id: 'ui', label: 'Interface', targets: ['journal', 'settings', 'controlsPanel', 'versionToggle'] },
]);
const KIND_ORDER = Object.freeze({ keyboard: 0, gamepad: 1, 'hotas-stick': 2, 'hotas-throttle': 3, 'hotas-pedals': 4 });
const BUILT_IN_BINDING_DEVICES = new Set(['keyboard', 'mouse', 'gamepad']);
const TUNING_FIELDS = Object.freeze([
  { field: 'deadzone', label: 'Deadzone', max: 0.5, step: 0.01 },
  { field: 'saturation', label: 'Saturation', max: 0.3, step: 0.01 },
  { field: 'expo', label: 'Expo', max: 1, step: 0.05 },
  { field: 'smoothing', label: 'Smoothing', max: 1, step: 0.05 },
]);
const HAT_CELLS = Object.freeze(['upLeft', 'up', 'upRight', 'left', null, 'right', 'downLeft', 'down', 'downRight']);
const LISTEN_TIMEOUT_MS = 10000;
const LIVE_REFRESH_SECONDS = 1 / 30;
const DEVICE_CHECK_SECONDS = 0.25;
const CURVE_SAMPLES = 48;
const MAX_IMPORT_BYTES = 512 * 1024;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function commandButton(className, text, command, data = {}) {
  const node = element('button', className, text);
  node.type = 'button';
  node.dataset.cmd = command;
  for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
  return node;
}

function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Output of the axis pipeline's shaping steps (after calibration) for one normalized input. */
function responseAt(value, range, tuning) {
  let shaped = value;
  if (tuning.invert) shaped = range === 'unipolar' ? 1 - shaped : -shaped;
  shaped = applyDeadzoneAndSaturation(shaped, range, tuning.deadzone, tuning.saturation);
  return applyExpo(shaped, tuning.expo);
}

/** A reference's tuning with the pipeline defaults filled in. */
function tuningOf(ref) {
  return {
    invert: Boolean(ref.invert),
    deadzone: ref.deadzone ?? DEFAULT_AXIS_TUNING.deadzone,
    saturation: ref.saturation ?? DEFAULT_AXIS_TUNING.saturation,
    expo: ref.expo ?? DEFAULT_AXIS_TUNING.expo,
    smoothing: ref.smoothing ?? DEFAULT_AXIS_TUNING.smoothing,
  };
}

/** Curve coordinates in a 100 x 100 box (y up) for a normalized value. */
function curveX(value, range) {
  return range === 'unipolar' ? value * 100 : ((value + 1) / 2) * 100;
}
function curveY(value, range) {
  return range === 'unipolar' ? 100 - value * 100 : 100 - ((value + 1) / 2) * 100;
}

function formatConflictLabel(conflict) {
  if (conflict.kind === 'uiKey') return `the ${conflict.label} key`;
  return conflict.label;
}

/**
 * Wires the controls panel element. ctx supplies settings, bus, craftRegistry and (lazily)
 * systems.input.
 */
export function createControlsPanel({ panel, ctx }) {
  const { settings, bus, craftRegistry } = ctx;
  const root = panel.querySelector('#dw-controls-root');
  if (!root) throw new Error('DRIFTWING controls: #dw-controls-root is missing from the controls panel.');

  // ---- Static structure ----------------------------------------------------------------------
  const mainView = element('div', 'dw-controls-main');
  const toolbar = element('div', 'dw-controls-toolbar');
  const scopeGroup = element('div', 'dw-segmented dw-segmented-2 dw-controls-scope');
  scopeGroup.setAttribute('role', 'radiogroup');
  scopeGroup.setAttribute('aria-label', 'Binding scope');
  const scopeGlobal = commandButton('', 'All craft', 'scope', { scope: 'global' });
  const scopeCraft = commandButton('', 'This craft', 'scope', { scope: 'craft' });
  for (const option of [scopeGlobal, scopeCraft]) option.setAttribute('role', 'radio');
  scopeGroup.append(scopeGlobal, scopeCraft);
  const toolbarActions = element('div', 'dw-controls-actions');
  const calibrateButton = commandButton('dw-text-button dw-solid', 'Calibrate', 'calibrate');
  const exportButton = commandButton('dw-text-button', 'Export', 'export');
  const importButton = commandButton('dw-text-button', 'Import', 'import');
  const resetAllButton = commandButton('dw-text-button', 'Reset all', 'reset-all');
  exportButton.setAttribute('aria-label', 'Export bindings to a JSON file');
  importButton.setAttribute('aria-label', 'Import bindings from a JSON file');
  resetAllButton.setAttribute('aria-label', 'Reset all bindings to defaults');
  calibrateButton.setAttribute('aria-label', 'Calibrate connected controllers');
  toolbarActions.append(calibrateButton, exportButton, importButton, resetAllButton);
  toolbar.append(scopeGroup, toolbarActions);
  const scopeNote = element('p', 'dw-note dw-controls-scope-note');

  const notices = element('div', 'dw-controls-notices');
  const tabList = element('div', 'dw-controls-tabs');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Devices');
  const body = element('div', 'dw-panel-body dw-controls-body');
  body.setAttribute('role', 'tabpanel');
  body.id = 'dw-controls-tabpanel';
  body.tabIndex = -1;
  const liveColumn = element('section', 'dw-controls-live');
  liveColumn.setAttribute('aria-label', 'Live inputs');
  const bindingColumn = element('section', 'dw-controls-bindings');
  bindingColumn.setAttribute('aria-label', 'Bindings');
  body.append(liveColumn, bindingColumn);
  const status = element('p', 'dw-controls-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const alertBox = element('div', 'dw-controls-alert');
  alertBox.setAttribute('role', 'alert');
  alertBox.hidden = true;
  const alertText = element('span', 'dw-controls-alert-text');
  const alertDismiss = commandButton('dw-text-button', 'Dismiss', 'alert-dismiss');
  alertBox.append(alertText, alertDismiss);
  mainView.append(toolbar, scopeNote, notices, tabList, alertBox, body, status);

  const confirmLayer = element('div', 'dw-controls-confirm');
  confirmLayer.hidden = true;
  const confirmBox = element('div', 'dw-controls-confirm-box glass');
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.setAttribute('aria-modal', 'true');
  confirmBox.setAttribute('aria-labelledby', 'dw-controls-confirm-title');
  confirmBox.setAttribute('aria-describedby', 'dw-controls-confirm-text');
  const confirmTitle = element('h3', 'dw-controls-confirm-title');
  confirmTitle.id = 'dw-controls-confirm-title';
  const confirmText = element('p', 'dw-controls-confirm-text');
  confirmText.id = 'dw-controls-confirm-text';
  const confirmActions = element('div', 'dw-controls-confirm-actions');
  const confirmNo = commandButton('dw-text-button', 'Cancel', 'confirm-no');
  const confirmYes = commandButton('dw-text-button dw-solid dw-danger', 'Reset', 'confirm-yes');
  confirmActions.append(confirmNo, confirmYes);
  confirmBox.append(confirmTitle, confirmText, confirmActions);
  confirmLayer.append(confirmBox);

  const wizardContainer = element('div', 'dw-wizard');
  wizardContainer.hidden = true;
  const fileInput = element('input', 'dw-controls-file');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.tabIndex = -1;
  fileInput.setAttribute('aria-hidden', 'true');
  root.append(mainView, wizardContainer, confirmLayer, fileInput);

  // ---- State -----------------------------------------------------------------------------------
  let wired = false;
  let open = false;
  let scope = 'global';
  let tabs = [];
  let tabSignature = '';
  let activeTabId = 'keyboard';
  let listening = null;
  let listenToken = 0;
  let pendingConflict = null;
  let pendingConfirm = null;
  let renderQueued = false;
  let liveTimer = 0;
  let deviceTimer = 0;
  let lastExport = null;
  let lastImport = null;
  const expandedTuning = new Set();
  /** DOM handles of the live section and tuning previews, refreshed without rebuilding. */
  const live = { kind: null, axes: [], buttons: [], hats: [], heldKeys: null, heldSignature: '', stickDot: null, stickText: null, tunes: [], countdown: null };

  const inputSystem = () => ctx.systems.input ?? null;
  const craftFor = () => (scope === 'craft' ? settings.get('craft') : null);
  const craftName = (craftId) => craftRegistry.catalog.find((entry) => entry.id === craftId)?.name ?? capitalize(craftId);
  const activeTab = () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  function targetLabel(target) {
    const selectMatch = /^craftSelect(\d)$/.exec(target);
    if (selectMatch) return `Craft ${selectMatch[1]}: ${ACTIONS[target]}`;
    return ACTIONS[target] ?? AXIS_TARGETS[target]?.label ?? target;
  }

  const wizardView = createCalibrationWizardView({
    container: wizardContainer,
    getInput: inputSystem,
    announce: (text) => setStatus(text),
    onExit(outcome) {
      showMainView();
      if (outcome === 'saved') setStatus('Calibration saved. It is restored whenever these controllers are plugged in again.', 'success');
      else if (outcome === 'cancelled') setStatus('Calibration cancelled; the previous calibration is kept.');
      renderAll();
    },
  });

  // ---- Status and alerts ------------------------------------------------------------------------
  function setStatus(text, kind = 'info') {
    status.textContent = text;
    status.dataset.kind = kind;
  }
  function showError(text) {
    alertText.textContent = text;
    alertBox.hidden = false;
  }
  function clearError() {
    alertBox.hidden = true;
    alertText.textContent = '';
  }

  // ---- Tabs ---------------------------------------------------------------------------------------
  function deviceLabel(profileId, fallbackName) {
    if (profileId === 'twcs') return 'TWCS throttle + pedals';
    const profile = DEVICE_PROFILES[profileId];
    if (profile && profile.kind !== 'gamepad') return profile.name;
    return String(fallbackName || profile?.name || 'Controller').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Controller';
  }

  /** Keyboard and mouse, connected controllers, then HOTAS devices known from earlier sessions. */
  function buildTabs() {
    const input = inputSystem();
    const result = [{ id: 'keyboard', kind: 'keyboard', label: 'Keyboard & mouse', bindingDevices: ['keyboard', 'mouse'], deviceKey: null, connected: true, profile: 'keyboard' }];
    if (!input) return result;
    const devices = input.getDevices().slice().sort((first, second) => (KIND_ORDER[first.kind] ?? 9) - (KIND_ORDER[second.kind] ?? 9));
    const liveBindingDevices = new Set();
    const labelCounts = new Map();
    for (const device of devices) {
      liveBindingDevices.add(device.bindingDevice);
      let label = deviceLabel(device.profile, device.name);
      const seen = labelCounts.get(label) ?? 0;
      labelCounts.set(label, seen + 1);
      if (seen > 0) label = `${label} ${seen + 1}`;
      result.push({ id: device.deviceKey, kind: device.kind, label, bindingDevices: [device.bindingDevice], deviceKey: device.deviceKey, connected: true, profile: device.profile, device });
    }
    for (const entry of input.bindings.listDevices()) {
      if (BUILT_IN_BINDING_DEVICES.has(entry.device) || liveBindingDevices.has(entry.device)) continue;
      const kind = DEVICE_PROFILES[entry.profile]?.kind ?? 'gamepad';
      result.push({ id: `offline:${entry.device}`, kind, label: deviceLabel(entry.profile, entry.name), bindingDevices: [entry.device], deviceKey: null, connected: false, profile: entry.profile });
    }
    return result;
  }

  function signatureOf(list) {
    return list.map((tab) => `${tab.id}:${tab.connected ? 1 : 0}`).join('|');
  }

  /** Rebuilds the tab model; keeps the selected device (also across unplug and replug). */
  function refreshTabs() {
    const previous = activeTab();
    tabs = buildTabs();
    tabSignature = signatureOf(tabs);
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      const sameDevice = previous ? tabs.find((tab) => tab.bindingDevices[0] === previous.bindingDevices[0]) : null;
      activeTabId = sameDevice ? sameDevice.id : 'keyboard';
    }
  }

  function renderTabs() {
    const focusedId = tabList.contains(document.activeElement) ? document.activeElement.dataset.tabId : null;
    tabList.replaceChildren();
    for (const tab of tabs) {
      const selected = tab.id === activeTabId;
      const button = commandButton('dw-controls-tab', '', 'tab', { tabId: tab.id });
      button.setAttribute('role', 'tab');
      button.id = `dw-controls-tab-${tab.id.replace(/[^a-z0-9-]/gi, '-')}`;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-controls', body.id);
      button.tabIndex = selected ? 0 : -1;
      button.append(element('span', 'dw-controls-tab-label', tab.label));
      if (!tab.connected) button.append(element('span', 'dw-controls-tab-state', 'not connected'));
      else if (tab.device?.needsCalibration) button.append(element('span', 'dw-controls-tab-state dw-warn-text', 'calibrate'));
      tabList.append(button);
      if (selected) body.setAttribute('aria-labelledby', button.id);
    }
    if (focusedId) tabList.querySelector(`[data-tab-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }

  function selectTab(tabId, focus = false) {
    if (!tabs.some((tab) => tab.id === tabId)) return false;
    if (listening) cancelListening();
    pendingConflict = null;
    activeTabId = tabId;
    renderTabs();
    renderBody();
    body.scrollTop = 0;
    if (focus) tabList.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)?.focus({ preventScroll: true });
    return true;
  }

  // ---- Toolbar, scope, notices -------------------------------------------------------------------
  function renderToolbar() {
    const craftId = settings.get('craft');
    scopeCraft.textContent = `${craftName(craftId)} only`;
    for (const option of [scopeGlobal, scopeCraft]) {
      const checked = option.dataset.scope === scope;
      option.setAttribute('aria-checked', String(checked));
      option.tabIndex = checked ? 0 : -1;
    }
    scopeNote.textContent = scope === 'craft'
      ? `Editing overrides for the ${craftName(craftId)}. Dimmed rows are inherited from the bindings shared by all craft; binding one creates an override.`
      : 'Editing the bindings shared by every craft. Switch to the craft scope to override single bindings for the current craft.';
    const input = inputSystem();
    const controllers = input ? input.getDevices().length : 0;
    calibrateButton.disabled = controllers === 0;
    calibrateButton.title = controllers === 0 ? 'Connect a controller first: press any button on it' : '';
  }

  function renderNotices() {
    const input = inputSystem();
    notices.replaceChildren();
    if (!input) return;
    const connection = input.getConnectionState();
    if (!connection.supported) {
      notices.append(element('p', 'dw-controls-notice', 'This browser does not expose game controllers (Gamepad API unavailable). Keyboard, mouse and touch still work.'));
      return;
    }
    if (connection.prompt) {
      const notice = element('div', 'dw-controls-notice dw-controls-prompt');
      notice.append(element('strong', '', connection.prompt));
      const chips = element('span', 'dw-controls-chips');
      for (const [key, label] of [['stick', 'Stick'], ['throttle', 'Throttle']]) {
        const chip = element('span', `dw-controls-chip${connection.hotas[key] ? ' dw-on' : ''}`, `${label}: ${connection.hotas[key] ? 'connected' : 'waiting'}`);
        chips.append(chip);
      }
      notice.append(chips, element('span', 'dw-controls-pedal-note', connection.pedalNote));
      notices.append(notice);
    }
    if (!connection.devices.some((device) => device.kind === 'gamepad')) {
      notices.append(element('p', 'dw-controls-notice dw-controls-hint', 'Using a gamepad? Press any button on it and it appears here as its own tab.'));
    }
  }

  // ---- Live section ------------------------------------------------------------------------------
  function resetLiveHandles(kind) {
    live.kind = kind;
    live.axes = [];
    live.buttons = [];
    live.hats = [];
    live.heldKeys = null;
    live.heldSignature = '';
    live.stickDot = null;
    live.stickText = null;
  }

  function renderDeviceHeader(tab) {
    const header = element('div', 'dw-controls-device');
    const title = element('div', 'dw-controls-device-title');
    title.append(element('h3', 'dw-controls-device-name', tab.label));
    const meta = element('p', 'dw-controls-device-meta');
    if (tab.kind === 'keyboard') {
      meta.textContent = 'Keys, mouse buttons, the mouse virtual stick and the wheel throttle.';
    } else if (!tab.connected) {
      meta.textContent = 'Not connected. Press any button on it to wake it up; its bindings can be edited meanwhile.';
    } else {
      const device = tab.device;
      const ids = device.vendor && device.product ? `${device.vendor}:${device.product}` : 'no USB id';
      meta.textContent = `Connected in slot ${device.slot + 1} · ${ids} · ${device.axisCount} axes, ${device.buttonCount} buttons`;
      const badge = element('span', `dw-controls-badge${device.needsCalibration ? ' dw-warn' : device.calibrated ? ' dw-ok' : ''}`,
        device.needsCalibration ? 'Needs calibration' : device.calibrated ? 'Calibrated' : 'Default ranges');
      title.append(badge);
    }
    const actions = element('div', 'dw-controls-device-actions');
    if (tab.connected && tab.kind !== 'keyboard') actions.append(commandButton('dw-text-button', 'Calibrate this device', 'calibrate-device', { focus: 'device:calibrate' }));
    if (tab.connected && tab.device?.calibrated) actions.append(commandButton('dw-text-button', 'Forget calibration', 'forget-calibration', { focus: 'device:forget' }));
    actions.append(commandButton('dw-text-button', scope === 'craft' ? 'Remove craft overrides' : 'Reset device', 'reset-device', { focus: 'device:reset' }));
    header.append(title, meta, actions);
    return header;
  }

  function renderKeyboardLive() {
    const block = element('div', 'dw-controls-kbm');
    const heldGroup = element('div', 'dw-controls-live-group');
    heldGroup.append(element('h4', 'dw-micro', 'Held keys'));
    const held = element('div', 'dw-controls-held');
    held.append(element('span', 'dw-controls-faint', 'Press a key'));
    heldGroup.append(held);
    const stickGroup = element('div', 'dw-controls-live-group');
    stickGroup.append(element('h4', 'dw-micro', 'Mouse virtual stick'));
    const stickRow = element('div', 'dw-controls-stick-row');
    const box = element('div', 'dw-controls-stick-box');
    box.setAttribute('aria-hidden', 'true');
    const dot = element('span', 'dw-controls-stick-dot');
    box.append(element('span', 'dw-controls-stick-cross'), dot);
    const stickText = element('p', 'dw-controls-stick-text');
    stickRow.append(box, stickText);
    stickGroup.append(stickRow);
    block.append(heldGroup, stickGroup);
    live.heldKeys = held;
    live.stickDot = dot;
    live.stickText = stickText;
    return block;
  }

  function renderAxisRow(axis) {
    const row = element('div', 'dw-controls-axis');
    row.append(element('span', 'dw-controls-axis-label', axis.label));
    const track = element('span', `dw-controls-bar${axis.range === 'unipolar' ? ' dw-unipolar' : ''}`);
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-label', axis.label);
    track.setAttribute('aria-valuemin', axis.range === 'unipolar' ? '0' : '-100');
    track.setAttribute('aria-valuemax', '100');
    const fill = element('span', 'dw-controls-bar-fill');
    track.append(fill);
    const value = element('span', 'dw-controls-axis-value');
    row.append(track, value);
    return { row, track, fill, value, index: axis.index, hat: axis.hat, shown: NaN, text: '' };
  }

  function renderControllerLive(tab) {
    const input = inputSystem();
    const reading = input?.readDevice(tab.deviceKey);
    const block = element('div', 'dw-controls-device-live');
    if (!reading) {
      block.append(element('p', 'dw-controls-faint', 'Waiting for readings from this device.'));
      return block;
    }
    const axesGroup = element('div', 'dw-controls-live-group');
    axesGroup.append(element('h4', 'dw-micro', 'Axes'));
    for (const axis of reading.axes) {
      const handle = renderAxisRow(axis);
      if (axis.hat) handle.row.classList.add('dw-hat-axis');
      axesGroup.append(handle.row);
      live.axes.push(handle);
    }
    const buttonsGroup = element('div', 'dw-controls-live-group');
    buttonsGroup.append(element('h4', 'dw-micro', 'Buttons'));
    const grid = element('div', 'dw-controls-buttons');
    for (const buttonReading of reading.buttons) {
      const light = element('span', 'dw-controls-light', String(buttonReading.index + 1));
      light.title = buttonReading.label;
      light.setAttribute('aria-label', `${buttonReading.label} released`);
      light.setAttribute('role', 'img');
      grid.append(light);
      live.buttons.push({ light, label: buttonReading.label, pressed: null });
    }
    buttonsGroup.append(grid);
    block.append(axesGroup, buttonsGroup);
    if (reading.hats.length > 0) {
      const hatsGroup = element('div', 'dw-controls-live-group');
      hatsGroup.append(element('h4', 'dw-micro', 'Hats'));
      const hatRow = element('div', 'dw-controls-hats');
      for (const hat of reading.hats) {
        const wrapper = element('div', 'dw-controls-hat');
        const compass = element('div', `dw-controls-hat-grid${hat.learned ? '' : ' dw-unlearned'}`);
        compass.setAttribute('role', 'img');
        const cells = new Map();
        for (const direction of HAT_CELLS) {
          const cell = element('span', direction ? 'dw-controls-hat-cell' : 'dw-controls-hat-cell dw-center');
          compass.append(cell);
          cells.set(direction ?? 'center', cell);
        }
        wrapper.append(compass, element('span', 'dw-controls-hat-label', hat.learned ? hat.label : `${hat.label}: calibrate to learn`));
        hatRow.append(wrapper);
        live.hats.push({ compass, cells, label: hat.label, learned: hat.learned, direction: undefined });
      }
      hatsGroup.append(hatRow);
      block.append(hatsGroup);
    }
    return block;
  }

  function renderLive() {
    const tab = activeTab();
    resetLiveHandles(tab.kind === 'keyboard' ? 'keyboard' : tab.connected ? 'controller' : 'offline');
    liveColumn.replaceChildren(renderDeviceHeader(tab));
    if (tab.kind === 'keyboard') liveColumn.append(renderKeyboardLive());
    else if (tab.connected) liveColumn.append(renderControllerLive(tab));
    if (tab.profile === 'twcs' || tab.profile === 'tfrp') liveColumn.append(element('p', 'dw-controls-pedal-note', inputSystem()?.getConnectionState().pedalNote ?? ''));
    refreshLive();
  }

  function refreshKeyboardLive(input) {
    const held = input.readKeyboard().held;
    const heldList = [...held].sort();
    const signature = heldList.join(',');
    if (signature !== live.heldSignature) {
      live.heldSignature = signature;
      live.heldKeys.replaceChildren();
      if (heldList.length === 0) live.heldKeys.append(element('span', 'dw-controls-faint', 'Press a key'));
      for (const code of heldList) live.heldKeys.append(element('kbd', '', input.describeRef({ type: 'key', code }, 'keyboard')));
    }
    const stick = input.getStick();
    live.stickDot.style.transform = `translate(${(stick.x * 34).toFixed(1)}px, ${(-stick.y * 34).toFixed(1)}px)`;
    const modeText = stick.mode === 'free' ? 'The offset from the screen centre is the deflection.' : 'Springs back to centre.';
    const stateText = stick.locked ? 'Mouse captured.' : stick.dragging ? 'Drag steering.' : 'Click the view to capture the mouse.';
    const text = `${stateText} ${modeText}`;
    if (live.stickText.textContent !== text) live.stickText.textContent = text;
  }

  function refreshControllerLive(input, tab) {
    const reading = input.readDevice(tab.deviceKey);
    if (!reading) return false;
    for (const handle of live.axes) {
      const axis = reading.axes[handle.index];
      if (!axis) continue;
      if (handle.hat || axis.hat) {
        const text = `raw ${axis.raw.toFixed(2)}`;
        if (text !== handle.text) {
          handle.text = text;
          handle.value.textContent = text;
          handle.fill.style.left = '0%';
          handle.fill.style.width = '0%';
        }
        continue;
      }
      const value = axis.value;
      if (Math.abs(value - handle.shown) < 0.004) continue;
      handle.shown = value;
      if (axis.range === 'unipolar') {
        handle.fill.style.left = '0%';
        handle.fill.style.width = `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
      } else {
        const clamped = Math.max(-1, Math.min(1, value));
        handle.fill.style.left = `${(50 + Math.min(0, clamped) * 50).toFixed(1)}%`;
        handle.fill.style.width = `${(Math.abs(clamped) * 50).toFixed(1)}%`;
      }
      const percent = Math.round(value * 100);
      const text = `${percent}%`;
      if (text !== handle.text) {
        handle.text = text;
        handle.value.textContent = text;
        handle.track.setAttribute('aria-valuenow', String(percent));
      }
    }
    reading.buttons.forEach((buttonReading, index) => {
      const handle = live.buttons[index];
      if (!handle || handle.pressed === buttonReading.pressed) return;
      handle.pressed = buttonReading.pressed;
      handle.light.classList.toggle('dw-on', buttonReading.pressed);
      handle.light.setAttribute('aria-label', `${handle.label} ${buttonReading.pressed ? 'pressed' : 'released'}`);
    });
    reading.hats.forEach((hat, index) => {
      const handle = live.hats[index];
      if (!handle) return;
      if (handle.learned !== hat.learned) {
        scheduleRender();
        return;
      }
      if (handle.direction === hat.direction) return;
      handle.direction = hat.direction;
      for (const [direction, cell] of handle.cells) cell.classList.toggle('dw-on', hat.learned && (direction === (hat.direction ?? 'center')));
      handle.compass.setAttribute('aria-label', hat.learned ? `${handle.label}: ${hat.direction ? HAT_DIRECTION_LABELS[hat.direction] : 'centred'}` : `${handle.label}: not learned yet`);
    });
    for (const tune of live.tunes) {
      const axis = reading.axes[tune.axis];
      if (!axis || axis.hat || axis.range !== tune.range) {
        tune.dot.setAttribute('visibility', 'hidden');
        continue;
      }
      const output = responseAt(axis.value, tune.range, tune.tuning);
      tune.dot.setAttribute('visibility', 'visible');
      tune.dot.setAttribute('cx', curveX(axis.value, tune.range).toFixed(1));
      tune.dot.setAttribute('cy', curveY(output, tune.range).toFixed(1));
    }
    return true;
  }

  function refreshLive() {
    const input = inputSystem();
    if (!input) return;
    const tab = activeTab();
    if (live.kind === 'keyboard' && live.heldKeys) refreshKeyboardLive(input);
    else if (live.kind === 'controller' && !refreshControllerLive(input, tab)) scheduleRender();
    if (listening && live.countdown) {
      const state = input.getListenState();
      const seconds = state.active ? Math.ceil(state.remainingMs / 1000) : 0;
      const text = `${seconds}s`;
      if (live.countdown.textContent !== text) live.countdown.textContent = text;
    }
  }

  // ---- Binding list ----------------------------------------------------------------------------
  /** Effective references of a target on the tab's binding devices, with where they come from. */
  function rowData(tab, target) {
    const input = inputSystem();
    const craft = craftFor();
    const parts = tab.bindingDevices.map((device) => ({
      device,
      refs: input.bindings.getRefs(device, target, craft),
      source: input.bindings.sourceOf(device, target, craft),
    }));
    const sources = new Set(parts.map((part) => part.source));
    const source = sources.has('craft') ? 'craft' : sources.has('global') ? 'global' : 'default';
    return { parts, source, count: parts.reduce((sum, part) => sum + part.refs.length, 0) };
  }

  function sourceText(source) {
    if (scope === 'craft') {
      if (source === 'craft') return 'Override';
      return source === 'global' ? 'Inherited, custom' : 'Inherited';
    }
    return source === 'global' ? 'Custom' : 'Default';
  }

  function listenPrompt(tab, target, stage) {
    const axisTarget = AXIS_TARGETS[target] !== undefined;
    if (tab.kind === 'keyboard') {
      if (!axisTarget) return 'Press a key (hold Shift for a Shift combination) or a mouse button.';
      return stage === 'negative' ? 'Now press the key for the opposite direction.' : 'Press the key for right, up or more.';
    }
    if (!axisTarget) return 'Press a button or hat direction, or push an axis past half travel.';
    return stage === 'negative' ? 'Now press the button for the opposite direction.' : 'Move an axis past half travel, or press a button for right, up or more.';
  }

  /** Conflicts (by target) on the tab's binding devices in the current scope. */
  function conflictMap(tab) {
    const input = inputSystem();
    const byTarget = new Map();
    const summary = [];
    const seen = new Set();
    for (const device of tab.bindingDevices) {
      for (const conflict of input.bindings.findConflicts({ device, craft: craftFor() })) {
        const labels = conflict.targets.map(targetLabel);
        const text = conflict.kind === 'uiKey' ? `${labels.join(', ')} uses the ${conflict.reserved} key` : labels.join(' and ');
        for (const target of conflict.targets) {
          if (!byTarget.has(target)) byTarget.set(target, []);
          byTarget.get(target).push(text);
        }
        if (!seen.has(text)) {
          seen.add(text);
          summary.push(text);
        }
      }
    }
    return { byTarget, summary };
  }

  function renderConflictPrompt(tab) {
    const conflict = pendingConflict;
    const input = inputSystem();
    const box = element('div', 'dw-bind-conflict');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', `Conflict for ${targetLabel(conflict.target)}`);
    const refLabel = input.describeRef(conflict.ref, conflict.device);
    const duplicates = conflict.conflicts.filter((entry) => entry.kind === 'duplicate');
    const reserved = conflict.conflicts.filter((entry) => entry.kind === 'uiKey');
    const lines = [];
    if (duplicates.length > 0) lines.push(`${refLabel} is already bound to ${duplicates.map(formatConflictLabel).join(', ')}.`);
    if (reserved.length > 0) lines.push(`${refLabel} is ${reserved.map(formatConflictLabel).join(', ')}; this binding would take it over.`);
    box.append(element('p', 'dw-bind-conflict-text', lines.join(' ')));
    const actions = element('div', 'dw-bind-conflict-actions');
    if (duplicates.length > 0) actions.append(commandButton('dw-text-button dw-solid', 'Replace', 'conflict-replace', { focus: 'conflict:replace' }));
    actions.append(commandButton('dw-text-button', duplicates.length > 0 ? 'Keep both' : 'Bind anyway', 'conflict-keep', { focus: 'conflict:keep' }));
    actions.append(commandButton('dw-text-button', 'Cancel', 'conflict-cancel', { focus: 'conflict:cancel' }));
    box.append(actions);
    if (tab.kind !== 'keyboard' && duplicates.length > 0) box.append(element('p', 'dw-note', 'Replace removes it from the other binding.'));
    return box;
  }

  function renderTuning(tab, target, axisRefs) {
    const input = inputSystem();
    const block = element('div', 'dw-bind-tuning');
    const device = tab.bindingDevices[0];
    const profileAxes = DEVICE_PROFILES[input.bindings.profileIdFor(device)]?.axes ?? [];
    for (const { ref, index } of axisRefs) {
      const tuning = tuningOf(ref);
      const profileAxis = profileAxes.find((axis) => axis.index === ref.axis);
      const range = ref.range ?? profileAxis?.range ?? AXIS_TARGETS[target].range;
      const section = element('div', 'dw-bind-tune');
      const header = element('div', 'dw-row');
      header.append(element('span', 'dw-bind-tune-name', input.describeRef({ ...ref, invert: false, rate: undefined }, device)));
      const invert = commandButton('dw-switch', '', 'invert', { target, index: String(index), focus: `tune:${target}:${index}:invert` });
      invert.setAttribute('role', 'switch');
      invert.setAttribute('aria-checked', String(tuning.invert));
      invert.setAttribute('aria-label', `Invert ${targetLabel(target)}`);
      invert.append(element('span'));
      const invertLabel = element('span', 'dw-bind-tune-invert');
      invertLabel.append(element('span', '', 'Invert'), invert);
      header.append(invertLabel);
      section.append(header);
      const grid = element('div', 'dw-bind-tune-grid');
      const sliders = element('div', 'dw-bind-tune-sliders');
      for (const { field, label, max, step } of TUNING_FIELDS) {
        const id = `dw-tune-${target}-${index}-${field}`;
        const fieldBox = element('div', 'dw-field');
        const row = element('div', 'dw-row');
        const labelNode = element('label', '', label);
        labelNode.htmlFor = id;
        const valueNode = element('span', 'dw-row-value', `${Math.round(tuning[field] * 100)}%`);
        row.append(labelNode, valueNode);
        const slider = element('input', 'dw-range');
        slider.type = 'range';
        slider.id = id;
        slider.min = '0';
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(tuning[field]);
        slider.dataset.tuneTarget = target;
        slider.dataset.tuneIndex = String(index);
        slider.dataset.tuneField = field;
        slider.dataset.focus = `tune:${target}:${index}:${field}`;
        slider.style.setProperty('--dw-fill', `${((tuning[field] / max) * 100).toFixed(1)}%`);
        fieldBox.append(row, slider);
        sliders.append(fieldBox);
      }
      const figure = element('figure', 'dw-bind-curve');
      const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
      svg.setAttribute('viewBox', '-4 -4 108 108');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Response curve for ${targetLabel(target)}: input across, output up`);
      const frame = document.createElementNS(SVG_NAMESPACE, 'path');
      frame.setAttribute('class', 'dw-curve-grid');
      frame.setAttribute('d', range === 'unipolar' ? 'M0 0H100V100H0Z' : 'M0 0H100V100H0Z M50 0V100 M0 50H100');
      const linear = document.createElementNS(SVG_NAMESPACE, 'path');
      linear.setAttribute('class', 'dw-curve-linear');
      linear.setAttribute('d', 'M0 100L100 0');
      const curve = document.createElementNS(SVG_NAMESPACE, 'polyline');
      curve.setAttribute('class', 'dw-curve-line');
      const dot = document.createElementNS(SVG_NAMESPACE, 'circle');
      dot.setAttribute('class', 'dw-curve-dot');
      dot.setAttribute('r', '3.2');
      dot.setAttribute('visibility', 'hidden');
      svg.append(frame, linear, curve, dot);
      figure.append(svg, element('figcaption', 'dw-controls-faint', 'Input across, output up; the dot is the live position.'));
      grid.append(sliders, figure);
      section.append(grid);
      block.append(section);
      const tune = { target, index, axis: ref.axis, range, tuning, curve, dot, section };
      drawCurve(tune);
      live.tunes.push(tune);
    }
    return block;
  }

  function drawCurve(tune) {
    const points = [];
    const start = tune.range === 'unipolar' ? 0 : -1;
    for (let sample = 0; sample <= CURVE_SAMPLES; sample++) {
      const value = start + ((1 - start) * sample) / CURVE_SAMPLES;
      const output = responseAt(value, tune.range, tune.tuning);
      points.push(`${curveX(value, tune.range).toFixed(2)},${curveY(output, tune.range).toFixed(2)}`);
    }
    tune.curve.setAttribute('points', points.join(' '));
  }

  function renderRow(tab, target, conflicts) {
    const input = inputSystem();
    const data = rowData(tab, target);
    const row = element('div', 'dw-bind-row');
    row.dataset.target = target;
    const inherited = scope === 'craft' && data.source !== 'craft';
    if (inherited) row.classList.add('dw-inherited');
    const isListening = listening?.target === target;
    if (isListening) row.classList.add('dw-listening');
    const rowConflicts = conflicts.byTarget.get(target) ?? [];
    if (rowConflicts.length > 0) row.classList.add('dw-conflicted');

    const main = commandButton('dw-bind-main', '', 'bind', { target, focus: `bind:${target}` });
    const name = element('span', 'dw-bind-name', targetLabel(target));
    const refs = element('span', 'dw-bind-refs');
    if (isListening) {
      const state = input.getListenState();
      refs.append(element('span', 'dw-bind-listen', listenPrompt(tab, target, state.stage)));
      if (state.first) refs.append(element('kbd', '', state.first.label));
      const countdown = element('span', 'dw-bind-countdown');
      refs.append(countdown);
      live.countdown = countdown;
      main.setAttribute('aria-label', `Listening for ${targetLabel(target)}. ${listenPrompt(tab, target, state.stage)} Escape cancels.`);
    } else if (data.count === 0) {
      refs.append(element('span', 'dw-bind-none', 'Unbound'));
    } else {
      for (const part of data.parts) {
        for (const ref of part.refs) refs.append(element('span', 'dw-bind-chip', input.describeRef(ref, part.device)));
      }
    }
    main.append(name, refs);
    if (!isListening) {
      const described = data.count === 0 ? 'unbound' : [...refs.querySelectorAll('.dw-bind-chip')].map((chip) => chip.textContent).join(', ');
      main.setAttribute('aria-label', `${targetLabel(target)}: ${described}. ${sourceText(data.source)}. Activate to bind.`);
    }
    row.append(main);

    const side = element('div', 'dw-bind-side');
    if (rowConflicts.length > 0) {
      const warn = element('span', 'dw-bind-warn', '!');
      warn.title = `Conflict: ${rowConflicts.join('; ')}`;
      warn.setAttribute('role', 'img');
      warn.setAttribute('aria-label', `Conflict: ${rowConflicts.join('; ')}`);
      side.append(warn);
    }
    side.append(element('span', `dw-bind-source dw-source-${data.source}`, sourceText(data.source)));
    const axisRefs = tab.kind === 'keyboard' ? [] : data.parts[0].refs.map((ref, index) => ({ ref, index })).filter((entry) => entry.ref.type === 'axis');
    if (isListening) {
      side.append(commandButton('dw-text-button dw-small-text', 'Cancel', 'listen-cancel', { focus: `cancel:${target}` }));
    } else {
      if (axisRefs.length > 0) {
        const tune = commandButton('dw-text-button dw-small-text', 'Tune', 'tune', { target, focus: `tune:${target}` });
        tune.setAttribute('aria-expanded', String(expandedTuning.has(target)));
        tune.setAttribute('aria-label', `Tune ${targetLabel(target)}`);
        side.append(tune);
      }
      const layerSource = scope === 'craft' ? 'craft' : 'global';
      if (data.source === layerSource) {
        const revert = commandButton('dw-icon-button dw-small', '', 'revert', { target, focus: `revert:${target}` });
        revert.setAttribute('aria-label', scope === 'craft' ? `Remove the ${craftName(settings.get('craft'))} override for ${targetLabel(target)}` : `Reset ${targetLabel(target)} to its default`);
        revert.dataset.tip = scope === 'craft' ? 'Remove override' : 'Reset to default';
        revert.dataset.tipPos = 'left';
        revert.append(iconSvg('M5 12a7 7 0 1 0 2.05-4.95M5 4.5V9h4.5'));
        side.append(revert);
      }
      if (data.count > 0) {
        const unbind = commandButton('dw-icon-button dw-small', '', 'unbind', { target, focus: `unbind:${target}` });
        unbind.setAttribute('aria-label', `Unbind ${targetLabel(target)}`);
        unbind.dataset.tip = 'Unbind';
        unbind.dataset.tipPos = 'left';
        unbind.append(iconSvg('M7 7l10 10M17 7L7 17'));
        side.append(unbind);
      }
    }
    row.append(side);
    const wrapper = element('div', 'dw-bind-item');
    wrapper.append(row);
    if (pendingConflict?.target === target) wrapper.append(renderConflictPrompt(tab));
    if (!isListening && expandedTuning.has(target) && axisRefs.length > 0) wrapper.append(renderTuning(tab, target, axisRefs));
    return wrapper;
  }

  function iconSvg(pathData) {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('class', 'dw-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    return svg;
  }

  function renderBindings() {
    const input = inputSystem();
    const focusKey = bindingColumn.contains(document.activeElement) ? document.activeElement.dataset.focus ?? null : null;
    const scrollTop = body.scrollTop;
    bindingColumn.replaceChildren();
    live.tunes = [];
    live.countdown = null;
    if (!input) return;
    const tab = activeTab();
    const conflicts = conflictMap(tab);
    const head = element('div', 'dw-controls-bindings-head');
    head.append(element('h3', 'dw-micro dw-gold', scope === 'craft' ? `Bindings · ${craftName(settings.get('craft'))} overrides` : 'Bindings · all craft'));
    const summary = element('p', `dw-controls-conflicts${conflicts.summary.length > 0 ? ' dw-has-conflicts' : ''}`);
    summary.textContent = conflicts.summary.length === 0
      ? 'No conflicts.'
      : `${conflicts.summary.length} conflict${conflicts.summary.length === 1 ? '' : 's'}: ${conflicts.summary.join('; ')}.`;
    head.append(summary);
    bindingColumn.append(head);
    const grouped = new Set();
    const groups = BINDING_GROUPS.map((group) => ({ ...group, targets: group.targets.filter((target) => AXIS_TARGETS[target] || ACTION_IDS.includes(target)) }));
    for (const group of groups) for (const target of group.targets) grouped.add(target);
    const leftovers = ACTION_IDS.filter((target) => !grouped.has(target));
    if (leftovers.length > 0) groups.push({ id: 'other', label: 'Other', targets: leftovers });
    for (const group of groups) {
      const section = element('div', 'dw-group dw-bind-group');
      section.append(element('h4', 'dw-micro', group.label));
      const list = element('div', 'dw-bind-list');
      for (const target of group.targets) list.append(renderRow(tab, target, conflicts));
      section.append(list);
      bindingColumn.append(section);
    }
    body.scrollTop = scrollTop;
    if (focusKey) bindingColumn.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    refreshLive();
  }

  function renderBody() {
    renderLive();
    renderBindings();
  }

  function renderAll() {
    if (!inputSystem()) {
      setStatus('Controls are still starting up.');
      return;
    }
    refreshTabs();
    renderToolbar();
    renderNotices();
    renderTabs();
    renderBody();
  }

  /** Coalesces re-renders from store listeners into one per frame. */
  function scheduleRender() {
    if (!open || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!open || wizardView.isActive()) return;
      refreshTabs();
      renderToolbar();
      renderNotices();
      renderTabs();
      renderBody();
    });
  }

  function focusBinding(target) {
    bindingColumn.querySelector(`[data-focus="${CSS.escape(`bind:${target}`)}"]`)?.focus({ preventScroll: false });
  }

  // ---- Binding actions ---------------------------------------------------------------------------
  async function startListening(target) {
    const input = inputSystem();
    const tab = activeTab();
    if (!input) return;
    if (!tab.connected) {
      setStatus(`${tab.label} is not connected. Press any button on it first.`, 'warning');
      return;
    }
    if (listening) cancelListening();
    pendingConflict = null;
    clearError();
    const token = ++listenToken;
    const craft = craftFor();
    listening = { target, tabId: tab.id };
    renderBindings();
    focusBinding(target);
    setStatus(`Listening for ${targetLabel(target)}. ${listenPrompt(tab, target, 'first')} Escape cancels.`);
    const device = tab.bindingDevices.length === 1 ? tab.bindingDevices[0] : tab.bindingDevices;
    const result = await input.listen({ target, device, timeoutMs: LISTEN_TIMEOUT_MS });
    if (token !== listenToken) return;
    listening = null;
    if (!result.ok) {
      if (result.reason === 'timeout') setStatus(`Nothing was pressed for ${targetLabel(target)}; the binding is unchanged.`);
      else if (result.reason === 'cancelled') setStatus(`Binding ${targetLabel(target)} cancelled.`);
      if (open) {
        renderBindings();
        focusBinding(target);
      }
      return;
    }
    const conflicts = input.bindings.conflictsFor({ device: result.device, target, ref: result.ref, craft });
    if (conflicts.length === 0) {
      applyBinding({ target, device: result.device, ref: result.ref, craft, release: false });
      return;
    }
    pendingConflict = { target, device: result.device, ref: result.ref, craft, conflicts };
    setStatus(`${input.describeRef(result.ref, result.device)} is already in use. Replace, keep both or cancel.`, 'warning');
    renderBindings();
    const focusTarget = bindingColumn.querySelector('[data-focus="conflict:replace"]') ?? bindingColumn.querySelector('[data-focus="conflict:keep"]');
    focusTarget?.focus({ preventScroll: false });
  }

  function cancelListening() {
    const input = inputSystem();
    listenToken++;
    const target = listening?.target ?? null;
    listening = null;
    input?.cancelListen();
    if (target && open) renderBindings();
  }

  function applyBinding({ target, device, ref, craft, release }) {
    const input = inputSystem();
    if (release) input.bindings.releaseInputs({ device, target, ref, craft });
    const outcome = input.bindings.bind({ device, target, ref, craft, replace: true });
    pendingConflict = null;
    if (!outcome.ok) {
      setStatus(`Could not bind ${targetLabel(target)}: ${outcome.error}.`, 'warning');
    } else {
      const where = craft ? ` for the ${craftName(craft)}` : '';
      setStatus(`${targetLabel(target)} is now ${input.describeRef(outcome.ref, device)}${where}.`, 'success');
    }
    renderBindings();
    focusBinding(target);
    return outcome;
  }

  function resolveConflict(choice) {
    const conflict = pendingConflict;
    if (!conflict) return;
    if (choice === 'cancel') {
      pendingConflict = null;
      setStatus(`Binding ${targetLabel(conflict.target)} cancelled; nothing changed.`);
      renderBindings();
      focusBinding(conflict.target);
      return;
    }
    applyBinding({ ...conflict, release: choice === 'replace' });
  }

  function unbindTarget(target) {
    const input = inputSystem();
    const craft = craftFor();
    for (const device of activeTab().bindingDevices) input.bindings.unbind({ device, target, craft });
    setStatus(`${targetLabel(target)} is unbound${craft ? ` for the ${craftName(craft)}` : ''}.`);
  }

  function revertTarget(target) {
    const input = inputSystem();
    const craft = craftFor();
    for (const device of activeTab().bindingDevices) input.bindings.clearOverride({ device, target, craft });
    setStatus(craft ? `${targetLabel(target)} follows the bindings shared by all craft again.` : `${targetLabel(target)} is back to its default.`);
  }

  function setScope(next) {
    if (next !== 'global' && next !== 'craft') return;
    if (listening) cancelListening();
    pendingConflict = null;
    scope = next;
    renderToolbar();
    renderBody();
  }

  function applyTuning(target, index, patch) {
    const input = inputSystem();
    const device = activeTab().bindingDevices[0];
    const result = input.bindings.updateRef({ device, target, index, patch, craft: craftFor() });
    if (!result.ok) setStatus(`Could not tune ${targetLabel(target)}: ${result.error}.`, 'warning');
    return result;
  }

  // ---- Reset, export, import ------------------------------------------------------------------------
  function askConfirm({ title, text, confirmLabel, run }) {
    pendingConfirm = { run, returnFocus: document.activeElement };
    confirmTitle.textContent = title;
    confirmText.textContent = text;
    confirmYes.textContent = confirmLabel;
    confirmLayer.hidden = false;
    confirmNo.focus({ preventScroll: true });
  }

  function closeConfirm(confirmed) {
    const confirm = pendingConfirm;
    pendingConfirm = null;
    confirmLayer.hidden = true;
    if (!confirm) return;
    if (confirmed) confirm.run();
    if (confirm.returnFocus && document.contains(confirm.returnFocus)) confirm.returnFocus.focus({ preventScroll: true });
    else body.focus({ preventScroll: true });
  }

  function confirmResetDevice() {
    const tab = activeTab();
    const craft = craftFor();
    askConfirm({
      title: craft ? 'Remove craft overrides?' : 'Reset device bindings?',
      text: craft
        ? `Remove every ${craftName(craft)} override on ${tab.label}? It goes back to the bindings shared by all craft.`
        : `Reset every binding on ${tab.label} to the defaults? Its per-craft overrides are removed too. Calibration is kept.`,
      confirmLabel: craft ? 'Remove overrides' : 'Reset device',
      run() {
        const input = inputSystem();
        for (const device of tab.bindingDevices) input.bindings.resetToDefaults({ device, craft });
        setStatus(craft ? `${tab.label}: ${craftName(craft)} overrides removed.` : `${tab.label} bindings reset to defaults.`, 'success');
      },
    });
  }

  function confirmResetAll() {
    askConfirm({
      title: 'Reset all bindings?',
      text: 'Reset the bindings of every device to the defaults? All custom bindings and per-craft overrides are removed. Calibration is kept.',
      confirmLabel: 'Reset all',
      run() {
        inputSystem().bindings.resetToDefaults();
        setStatus('All bindings are back to their defaults.', 'success');
      },
    });
  }

  function confirmForgetCalibration() {
    const tab = activeTab();
    askConfirm({
      title: 'Forget calibration?',
      text: `Forget the calibration of ${tab.label}? Its axes go back to default ranges and its hats stop working until you calibrate again.`,
      confirmLabel: 'Forget',
      run() {
        inputSystem().calibration.reset(tab.deviceKey);
        setStatus(`${tab.label} calibration removed.`);
      },
    });
  }

  function exportProfile() {
    const input = inputSystem();
    const text = input.bindings.exportJSON();
    const filename = `driftwing-bindings-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    lastExport = { filename, text };
    setStatus(`Saved ${filename} to your downloads.`, 'success');
    return lastExport;
  }

  /** Imports exported JSON text; a rejected file leaves the bindings untouched. */
  function importText(text, sourceName = 'The file') {
    const input = inputSystem();
    clearError();
    const result = input.bindings.importJSON(text);
    lastImport = { name: sourceName, ok: result.ok, errors: result.errors.slice() };
    if (!result.ok) {
      showError(`Import failed: ${sourceName} is ${result.errors[0] ?? 'not a DRIFTWING bindings export'}. Your bindings are unchanged.`);
      return result;
    }
    if (result.errors.length > 0) setStatus(`Imported ${sourceName}; ${result.errors.length} invalid entr${result.errors.length === 1 ? 'y was' : 'ies were'} skipped.`, 'warning');
    else setStatus(`Imported ${sourceName}. Your bindings are replaced.`, 'success');
    return result;
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showError(`Import failed: ${file.name} is too large to be a bindings file (the limit is 512 KB).`);
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (error) {
      showError(`Import failed: ${file.name} could not be read (${error.message}).`);
      return;
    }
    importText(text, file.name);
  }

  // ---- Wizard -------------------------------------------------------------------------------------
  function showMainView() {
    wizardContainer.hidden = true;
    mainView.hidden = false;
  }

  function startCalibration(deviceKeys = null) {
    const input = inputSystem();
    if (!input) return false;
    if (input.getDevices().length === 0) {
      setStatus('Connect a controller first: press any button on your stick, throttle or gamepad.', 'warning');
      return false;
    }
    if (listening) cancelListening();
    pendingConflict = null;
    closeConfirm(false);
    mainView.hidden = true;
    wizardContainer.hidden = false;
    wizardView.start(deviceKeys);
    return true;
  }

  // ---- Events -----------------------------------------------------------------------------------
  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-cmd]') : null;
    if (!target || !root.contains(target) || target.disabled) return;
    const { cmd } = target.dataset;
    switch (cmd) {
      case 'tab': selectTab(target.dataset.tabId); break;
      case 'scope': setScope(target.dataset.scope); break;
      case 'bind':
        if (listening?.target === target.dataset.target) cancelListening();
        else startListening(target.dataset.target);
        break;
      case 'listen-cancel': cancelListening(); break;
      case 'unbind': unbindTarget(target.dataset.target); break;
      case 'revert': revertTarget(target.dataset.target); break;
      case 'tune': {
        const name = target.dataset.target;
        if (expandedTuning.has(name)) expandedTuning.delete(name);
        else expandedTuning.add(name);
        renderBindings();
        break;
      }
      case 'invert': {
        const index = Number(target.dataset.index);
        const next = target.getAttribute('aria-checked') !== 'true';
        applyTuning(target.dataset.target, index, { invert: next ? true : null });
        break;
      }
      case 'conflict-replace': resolveConflict('replace'); break;
      case 'conflict-keep': resolveConflict('keep'); break;
      case 'conflict-cancel': resolveConflict('cancel'); break;
      case 'calibrate': startCalibration(null); break;
      case 'calibrate-device': startCalibration([activeTab().deviceKey]); break;
      case 'forget-calibration': confirmForgetCalibration(); break;
      case 'reset-device': confirmResetDevice(); break;
      case 'reset-all': confirmResetAll(); break;
      case 'export': exportProfile(); break;
      case 'import': fileInput.click(); break;
      case 'alert-dismiss': clearError(); break;
      case 'confirm-yes': closeConfirm(true); break;
      case 'confirm-no': closeConfirm(false); break;
      default: break;
    }
  }

  function tuneSliderValue(slider) {
    const value = Number(slider.value);
    return Number.isFinite(value) ? value : 0;
  }

  /** Slider drag: preview the curve at once, write the binding when the value is committed. */
  function onTuneInput(event) {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement) || !slider.dataset.tuneField) return;
    const value = tuneSliderValue(slider);
    const max = Number(slider.max) || 1;
    slider.style.setProperty('--dw-fill', `${((value / max) * 100).toFixed(1)}%`);
    const label = slider.parentElement?.querySelector('.dw-row-value');
    if (label) label.textContent = `${Math.round(value * 100)}%`;
    const tune = live.tunes.find((entry) => entry.target === slider.dataset.tuneTarget && entry.index === Number(slider.dataset.tuneIndex));
    if (tune) {
      tune.tuning = { ...tune.tuning, [slider.dataset.tuneField]: value };
      drawCurve(tune);
    }
  }

  function onTuneChange(event) {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement) || !slider.dataset.tuneField) return;
    applyTuning(slider.dataset.tuneTarget, Number(slider.dataset.tuneIndex), { [slider.dataset.tuneField]: tuneSliderValue(slider) });
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', onTuneInput);
  root.addEventListener('change', onTuneChange);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] ?? null;
    fileInput.value = '';
    importFile(file);
  });
  tabList.addEventListener('keydown', (event) => {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectTab(tabs[next].id, true);
  });
  scopeGroup.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    event.stopPropagation();
    setScope(scope === 'global' ? 'craft' : 'global');
    (scope === 'global' ? scopeGlobal : scopeCraft).focus({ preventScroll: true });
  });
  // The confirmation keeps focus inside itself while open.
  confirmBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    (document.activeElement === confirmNo ? confirmYes : confirmNo).focus({ preventScroll: true });
  });

  function wire() {
    const input = inputSystem();
    if (wired || !input) return;
    wired = true;
    input.bindings.onChange(() => scheduleRender());
    input.calibration.onChange(() => scheduleRender());
    bus.onTyped('deviceConnected', () => scheduleRender());
    bus.onTyped('deviceDisconnected', () => scheduleRender());
    bus.onTyped('craftChanged', () => scheduleRender());
    bus.on('settings:changed', (payload) => {
      if (payload?.key === 'craft' || payload?.key === 'mode') scheduleRender();
    });
  }

  return {
    /** The panel is opening: wire to the input system and draw everything. */
    onOpen() {
      open = true;
      wire();
      clearError();
      showMainView();
      renderAll();
      body.focus({ preventScroll: true });
    },

    /** The panel closed: stop listening and cancel a running calibration (controllers resume). */
    onClose() {
      open = false;
      if (listening) cancelListening();
      pendingConflict = null;
      if (pendingConfirm) closeConfirm(false);
      if (wizardView.isActive()) wizardView.cancel();
      showMainView();
    },

    /** Escape inside the panel: closes the innermost layer first. Returns true when it did. */
    handleEscape() {
      if (pendingConfirm) {
        closeConfirm(false);
        return true;
      }
      if (wizardView.isActive()) {
        wizardView.cancel();
        return true;
      }
      if (pendingConflict) {
        resolveConflict('cancel');
        return true;
      }
      return false;
    },

    update(step) {
      if (!open) return;
      if (wizardView.isActive()) {
        wizardView.update(step);
        return;
      }
      deviceTimer -= step;
      if (deviceTimer <= 0) {
        deviceTimer = DEVICE_CHECK_SECONDS;
        if (signatureOf(buildTabs()) !== tabSignature) scheduleRender();
      }
      liveTimer -= step;
      if (liveTimer > 0) return;
      liveTimer = LIVE_REFRESH_SECONDS;
      refreshLive();
    },

    startCalibration,
    selectTab,
    setScope,
    importText,
    exportProfile,
    isOpen: () => open,
    wizard: wizardView,

    /** Snapshot for tests and the dev tools. */
    getState() {
      return {
        open,
        scope,
        activeTab: activeTabId,
        tabs: tabs.map((tab) => ({ id: tab.id, label: tab.label, kind: tab.kind, connected: tab.connected, bindingDevices: tab.bindingDevices.slice() })),
        listening: listening ? { ...listening } : null,
        conflict: pendingConflict ? { target: pendingConflict.target, device: pendingConflict.device, ref: { ...pendingConflict.ref }, conflicts: pendingConflict.conflicts.map((entry) => ({ ...entry })) } : null,
        confirm: Boolean(pendingConfirm),
        wizard: wizardView.isActive(),
        status: status.textContent,
        error: alertBox.hidden ? null : alertText.textContent,
        lastExport: lastExport ? { filename: lastExport.filename, bytes: lastExport.text.length } : null,
        lastImport: lastImport ? { ...lastImport } : null,
      };
    },
  };
}
