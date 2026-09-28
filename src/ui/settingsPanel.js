// Settings panel: tabs (Flight, Graphics, Sound, Controls, General) and every control in them.
//
// Controls are declared in index.html with data attributes and wired generically here:
//   .dw-switch[data-setting]      boolean key or object field ("hud.overlay")
//   .dw-range[data-setting]       numeric key or field, data-kind picks conversion and label
//   .dw-segmented[data-setting]   choice key; numeric data-value strings become numbers
//   [data-value-for]              live value label for a setting path
// A path is "key" or "key.field"; the field "@craft" means the currently selected craft (used by
// the per-craft assists slider). Everything reads and writes through the settings store, and
// settings:changed keeps the controls in sync with changes made elsewhere (hotkeys, copilot).
import { clamp } from '../core/util.js';
import { RemoteCopilot } from '../copilot/copilot.js';

const SEED_PATTERN = /^[A-Za-z0-9-]{1,24}$/;
/** Seconds between refreshes of the live notes (running quality, frame target, active assists). */
const LIVE_NOTE_SECONDS = 0.25;

function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** 'autoCoordination' or 'auto-coordination' -> 'Auto coordination'. */
function humanize(value) {
  const words = String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return capitalize(words);
}

function describeAssist(entry) {
  if (typeof entry === 'string') return /\s/.test(entry) ? entry : humanize(entry);
  if (entry && typeof entry === 'object') return String(entry.label || entry.name || humanize(entry.id || ''));
  return '';
}

function parseChoice(value) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * Wires the settings panel element. ctx supplies settings, bus, state (perf and flight telemetry
 * for the live notes), quality and craftRegistry; toast(text, options) is the UI's toast and
 * navigateToSeed(seed) reloads into another world.
 */
export function createSettingsPanel({ panel, ctx, toast, navigateToSeed }) {
  const { settings, bus, state, craftRegistry } = ctx;

  function requireWithin(selector) {
    const found = panel.querySelector(selector);
    if (!found) throw new Error(`DRIFTWING settings: ${selector} is missing from the settings panel.`);
    return found;
  }

  const dom = {
    tabs: Array.from(panel.querySelectorAll('[role="tab"][data-tab]')),
    tabList: requireWithin('[role="tablist"]'),
    tabPanels: Array.from(panel.querySelectorAll('[role="tabpanel"][data-tabpanel]')),
    body: requireWithin('.dw-panel-body'),
    qualityNote: requireWithin('#dw-quality-note'),
    frameNote: requireWithin('#dw-frame-note'),
    scaleNote: requireWithin('#dw-scale-note'),
    assistLabel: requireWithin('#dw-assist-label'),
    assistTip: requireWithin('#dw-assist-tip'),
    endpointInput: requireWithin('#dw-set-endpoint'),
    seedForm: requireWithin('#dw-seed-form'),
    seedInput: requireWithin('#dw-seed-input'),
    controllersNote: requireWithin('#dw-controllers-note'),
  };
  const switches = Array.from(panel.querySelectorAll('.dw-switch[data-setting]'));
  const ranges = Array.from(panel.querySelectorAll('.dw-range[data-setting]'));
  const segmentedGroups = Array.from(panel.querySelectorAll('.dw-segmented[data-setting]'));
  const valueLabels = Array.from(panel.querySelectorAll('[data-value-for]'));
  let activeTab = dom.tabs[0]?.dataset.tab ?? null;
  let liveTimer = 0;
  let assistText = '';
  let controllersText = '';

  // ---- Setting paths ------------------------------------------------------------------------
  function resolvePath(path) {
    const [key, rawField] = String(path).split('.');
    const field = rawField === '@craft' ? settings.get('craft') : rawField;
    return { key, field: field ?? null };
  }
  function readPath(path) {
    const { key, field } = resolvePath(path);
    const value = settings.get(key);
    return field === null ? value : value?.[field];
  }
  function writePath(path, value) {
    const { key, field } = resolvePath(path);
    return field === null ? settings.set(key, value) : settings.update(key, { [field]: value });
  }
  /** True when a control bound to path must refresh after key changed. */
  function pathDependsOn(path, key) {
    const base = String(path).split('.')[0];
    if (base === key) return true;
    if (key === 'masterVolume' && path === 'mixer.master') return true;
    return key === 'craft' && String(path).endsWith('.@craft');
  }

  // ---- Value conversion -----------------------------------------------------------------------
  function rangeToSetting(kind, value) {
    return kind === 'minutes' ? Math.round(value) * 60 : value;
  }
  function settingToRange(kind, value) {
    return kind === 'minutes' ? clamp(Math.round((Number(value) || 360) / 60), 2, 30) : Number(value) || 0;
  }
  function formatSettingValue(kind, value) {
    if (kind === 'minutes') return `${Math.round(value / 60)} min`;
    if (kind === 'factor') return `${Number(value).toFixed(2)}×`;
    if (kind === 'percent') return `${Math.round(Number(value) * 100)}%`;
    if (kind === 'degrees') return `${Math.round(Number(value))}°`;
    if (kind === 'rate') return `${Math.round(Number(value))}°/s`;
    if (kind === 'decimal') return Number(value).toFixed(2);
    return String(value);
  }

  // ---- Sync ----------------------------------------------------------------------------------
  function syncRange(range) {
    const path = range.dataset.setting;
    const kind = range.dataset.kind;
    const value = readPath(path);
    const sliderValue = settingToRange(kind, value);
    if (Number(range.value) !== sliderValue) range.value = String(sliderValue);
    const min = Number(range.min);
    const max = Number(range.max);
    const fill = max > min ? ((Number(range.value) - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--dw-fill', `${fill.toFixed(1)}%`);
    for (const label of valueLabels) {
      if (label.dataset.valueFor === path) label.textContent = formatSettingValue(kind, value);
    }
  }
  function segmentedOptions(group) {
    return Array.from(group.querySelectorAll('button[data-value]'));
  }
  /** Radio group: the checked option is the group's one tab stop (the first when none matches). */
  function syncSegmented(group) {
    const value = readPath(group.dataset.setting);
    const options = segmentedOptions(group);
    const anyChecked = options.some((button) => parseChoice(button.dataset.value) === value);
    options.forEach((button, index) => {
      const checked = parseChoice(button.dataset.value) === value;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked || (!anyChecked && index === 0) ? 0 : -1;
    });
  }
  function syncAssistLabel() {
    const craftId = settings.get('craft');
    const entry = craftRegistry.catalog.find((item) => item.id === craftId);
    dom.assistLabel.textContent = `${entry ? entry.name : capitalize(craftId)} assists`;
  }
  function syncQualityNote() {
    const preference = settings.get('quality');
    const running = ctx.quality && ctx.quality.name ? capitalize(ctx.quality.name) : '';
    dom.qualityNote.textContent = preference === 'auto' ? `Auto, running at ${running || 'High'}` : capitalize(preference);
  }
  /** Frame target and render scale notes from state.perf (refreshed while the panel is open). */
  function syncPerfNotes() {
    const perf = state.perf;
    const preference = settings.get('frameTarget');
    const display = perf.refreshHz ? `${perf.refreshHz} Hz display` : 'display rate not measured';
    let frameText;
    if (preference === 'uncapped') frameText = 'Uncapped';
    else if (preference === 'auto') frameText = perf.targetHz ? `Auto, ${perf.targetHz} fps (${display})` : 'Auto';
    else frameText = perf.targetHz && perf.targetHz < preference ? `${preference} fps, held at ${perf.targetHz} by the display` : `${preference} fps`;
    if (dom.frameNote.textContent !== frameText) dom.frameNote.textContent = frameText;
    const scale = Number(perf.renderScale) || 1;
    let scaleText;
    if (!settings.get('dynamicResolution')) scaleText = 'Off: the view always renders at full resolution.';
    else if (scale >= 0.999) scaleText = 'Rendering at full resolution; drops as low as 0.6× to hold the frame target.';
    else scaleText = `Rendering at ${scale.toFixed(2)}× to hold the frame target.`;
    if (dom.scaleNote.textContent !== scaleText) dom.scaleNote.textContent = scaleText;
  }
  /** Tooltip for the assists slider: the assists the flight model reports active right now. */
  function syncAssistTip() {
    const flight = state.flight || {};
    const list = Array.isArray(flight.activeAssists) ? flight.activeAssists.map(describeAssist).filter(Boolean) : [];
    let text;
    if (list.length > 0) text = `Active now: ${list.join(', ')}`;
    else text = 'No assists active: raw physics';
    if (text === assistText) return;
    assistText = text;
    dom.assistTip.textContent = text;
  }
  /** Controls tab: which controllers are connected and whether they are calibrated. */
  function syncControllersNote() {
    const input = ctx.systems.input;
    const devices = input ? input.getDevices() : [];
    let text;
    if (devices.length === 0) text = 'No controllers connected. Press any button on a gamepad, stick or throttle to connect it.';
    else text = `Connected: ${devices.map((device) => `${device.name}${device.hotas ? (device.needsCalibration ? ' (needs calibration)' : ' (calibrated)') : ''}`).join(', ')}.`;
    if (text === controllersText) return;
    controllersText = text;
    dom.controllersNote.textContent = text;
  }
  function syncEndpoint() {
    if (document.activeElement === dom.endpointInput) return;
    dom.endpointInput.value = settings.get('remoteEndpoint');
    setEndpointInvalid(false);
  }

  /** Refreshes every control bound to key. */
  function syncKey(key) {
    for (const control of switches) {
      if (pathDependsOn(control.dataset.setting, key)) control.setAttribute('aria-checked', String(Boolean(readPath(control.dataset.setting))));
    }
    for (const range of ranges) if (pathDependsOn(range.dataset.setting, key)) syncRange(range);
    for (const group of segmentedGroups) if (pathDependsOn(group.dataset.setting, key)) syncSegmented(group);
    if (key === 'quality') syncQualityNote();
    if (key === 'craft') syncAssistLabel();
    if (key === 'craft') assistText = '';
    if (key === 'frameTarget' || key === 'dynamicResolution') syncPerfNotes();
    if (key === 'remoteEndpoint') syncEndpoint();
  }
  function syncAll() {
    for (const key of Object.keys(settings.all())) syncKey(key);
    syncAssistTip();
    syncPerfNotes();
    syncControllersNote();
  }

  // ---- Remote endpoint and seed (v1) ----------------------------------------------------------
  /** Same rule the remote brain applies: an absolute http(s) URL, or null. */
  function validateEndpoint(value) {
    const text = String(value || '').trim();
    return text ? RemoteCopilot.validEndpoint(text) : null;
  }
  function setEndpointInvalid(invalid) {
    dom.endpointInput.classList.toggle('dw-invalid', invalid);
    dom.endpointInput.setAttribute('aria-invalid', String(invalid));
  }
  function commitEndpoint() {
    const endpoint = validateEndpoint(dom.endpointInput.value);
    if (!endpoint) {
      setEndpointInvalid(true);
      return false;
    }
    setEndpointInvalid(false);
    dom.endpointInput.value = endpoint;
    settings.set('remoteEndpoint', endpoint);
    return true;
  }

  // ---- Tabs ----------------------------------------------------------------------------------
  function selectTab(name, focus = false) {
    const tab = dom.tabs.find((candidate) => candidate.dataset.tab === name);
    if (!tab) return;
    activeTab = name;
    for (const candidate of dom.tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    for (const tabPanel of dom.tabPanels) tabPanel.hidden = tabPanel.dataset.tabpanel !== name;
    dom.body.scrollTop = 0;
    if (focus) tab.focus({ preventScroll: true });
  }

  // ---- Listeners -------------------------------------------------------------------------------
  for (const tab of dom.tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  // Arrow keys move between tabs; the flight keys must not see them while a tab has focus.
  dom.tabList.addEventListener('keydown', (event) => {
    const index = dom.tabs.findIndex((tab) => tab.dataset.tab === activeTab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % dom.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + dom.tabs.length) % dom.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = dom.tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectTab(dom.tabs[next].dataset.tab, true);
  });

  for (const control of switches) {
    control.addEventListener('click', () => {
      const path = control.dataset.setting;
      const next = !readPath(path);
      if (path === 'remoteCopilot' && next && !commitEndpoint()) {
        toast('Add a valid endpoint address first.', { kind: 'warning' });
        return;
      }
      writePath(path, next);
      syncKey(resolvePath(path).key);
    });
  }
  for (const range of ranges) {
    range.addEventListener('input', () => {
      const value = rangeToSetting(range.dataset.kind, Number(range.value));
      if (Number.isFinite(value)) writePath(range.dataset.setting, value);
      syncRange(range);
    });
  }
  for (const group of segmentedGroups) {
    group.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button[data-value]') : null;
      if (!button || !group.contains(button)) return;
      writePath(group.dataset.setting, parseChoice(button.dataset.value));
      syncSegmented(group);
    });
    // Arrow keys (wrapping), Home and End choose an option, as in any radio group; the flight keys
    // must not see them while an option has focus.
    group.addEventListener('keydown', (event) => {
      const options = segmentedOptions(group);
      const index = options.indexOf(document.activeElement);
      if (index < 0) return;
      let next = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      if (next < 0) return;
      event.preventDefault();
      event.stopPropagation();
      writePath(group.dataset.setting, parseChoice(options[next].dataset.value));
      syncSegmented(group);
      options[next].focus({ preventScroll: true });
    });
  }

  dom.endpointInput.addEventListener('change', commitEndpoint);
  dom.endpointInput.addEventListener('input', () => setEndpointInvalid(false));
  dom.endpointInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commitEndpoint()) dom.endpointInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dom.endpointInput.value = settings.get('remoteEndpoint');
      setEndpointInvalid(false);
      dom.endpointInput.blur();
    }
  });
  dom.seedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const seed = dom.seedInput.value.trim();
    const valid = SEED_PATTERN.test(seed);
    dom.seedInput.classList.toggle('dw-invalid', !valid);
    dom.seedForm.classList.toggle('dw-invalid', !valid);
    dom.seedInput.setAttribute('aria-invalid', String(!valid));
    if (valid) navigateToSeed(seed);
  });
  dom.seedInput.addEventListener('input', () => {
    dom.seedInput.classList.remove('dw-invalid');
    dom.seedForm.classList.remove('dw-invalid');
    dom.seedInput.setAttribute('aria-invalid', 'false');
  });
  dom.seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dom.seedInput.blur();
    }
  });

  bus.on('settings:changed', (payload) => {
    if (payload && payload.key) syncKey(payload.key);
  });
  bus.on('quality:changed', syncQualityNote);
  bus.onTyped('craftChanged', () => syncKey('craft'));

  syncAll();

  return {
    /** Re-reads every control (the panel is opening). */
    syncAll,
    selectTab,
    getActiveTab: () => activeTab,
    /** While open: live notes (running quality, frame target, render scale, active assists). */
    update(step) {
      liveTimer -= step;
      if (liveTimer > 0) return;
      liveTimer = LIVE_NOTE_SECONDS;
      syncPerfNotes();
      syncAssistTip();
      syncControllersNote();
    },
  };
}
