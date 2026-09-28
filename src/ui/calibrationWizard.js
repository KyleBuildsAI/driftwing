// Calibration wizard view: the screens for the input system's calibration step machine
// (src/input/calibration.js), shown inside the controls panel.
//
// Order (spec): center everything; move each axis lock to lock; throttle full forward; pedals full
// left / right and each toe brake; press each hat direction; then the results, which Save writes
// through the calibration store. Every step shows live progress (axis centres, the range each axis
// has covered, pedal deflection, learned hat directions) and allows Back, Skip and Cancel. The
// pedal note stays on screen throughout.

import { HAT_DIRECTIONS, HAT_DIRECTION_LABELS } from '../input/hats.js';

const STEP_LABELS = Object.freeze({ center: 'Center', axes: 'Axes', throttle: 'Throttle', pedals: 'Pedals', hats: 'Hats', done: 'Results' });
const PEDAL_LABELS = Object.freeze({ rudderLeft: 'Rudder left', rudderRight: 'Rudder right', brakeLeft: 'Left brake', brakeRight: 'Right brake' });
const PEDAL_ROLES = Object.freeze({ rudderLeft: 'rudder', rudderRight: 'rudder', brakeLeft: 'brakeL', brakeRight: 'brakeR' });
const HAT_CELLS = Object.freeze(['upLeft', 'up', 'upRight', 'left', null, 'right', 'downLeft', 'down', 'downRight']);
/** Live values refresh at this rate; structure changes are picked up on the same poll. */
const REFRESH_SECONDS = 1 / 20;

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function actionButton(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function percentOfRange(raw) {
  return Math.max(0, Math.min(100, ((raw + 1) / 2) * 100));
}

function formatRaw(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '--';
}

/**
 * container: element the wizard draws into (hidden by the controls panel while not in use).
 * getInput(): the input system. announce(text): short status for screen readers and the panel.
 * onExit(outcome): 'saved' | 'cancelled' when the wizard closes.
 */
export function createCalibrationWizardView({ container, getInput, announce, onExit }) {
  let wizard = null;
  let active = false;
  let structureKey = '';
  let refreshTimer = 0;
  let stopListening = null;
  /** Live handles rebuilt with each step: rows of axis bars, the pedal ready chip, the hat compass. */
  let handles = { rows: [], ready: null, compass: null, release: null };

  // ---- Static frame ------------------------------------------------------------------------------
  const head = element('div', 'dw-wizard-head');
  head.append(element('span', 'dw-micro dw-gold', 'Calibration wizard'));
  const stepList = element('ol', 'dw-wizard-steps');
  stepList.setAttribute('aria-label', 'Calibration steps');
  head.append(stepList);
  const note = element('p', 'dw-wizard-note');
  const title = element('h3', 'dw-wizard-title');
  title.tabIndex = -1;
  const prompt = element('p', 'dw-wizard-prompt');
  prompt.setAttribute('aria-live', 'polite');
  const content = element('div', 'dw-panel-body dw-wizard-content');
  const actions = element('div', 'dw-wizard-actions');
  const cancelButton = actionButton('dw-text-button', 'Cancel');
  const backButton = actionButton('dw-text-button', 'Back');
  const skipButton = actionButton('dw-text-button', 'Skip');
  const nextButton = actionButton('dw-text-button dw-solid', 'Next');
  const spacer = element('span', 'dw-wizard-spacer');
  actions.append(cancelButton, spacer, backButton, skipButton, nextButton);
  container.append(head, note, title, prompt, content, actions);

  // ---- Rendering -----------------------------------------------------------------------------------
  function keyOf(state) {
    return [
      state.step,
      state.substep?.index ?? '',
      state.hat ? `${state.hat.index}:${state.hat.directionIndex}` : '',
      state.finished ? 'finished' : '',
      state.devices.map((device) => device.deviceKey).join(','),
      (state.lateDevices ?? []).map((device) => device.deviceKey).join(','),
    ].join('|');
  }

  function renderSteps(state) {
    stepList.replaceChildren();
    state.steps.forEach((step, index) => {
      const item = element('li', 'dw-wizard-step');
      if (index < state.stepIndex) item.classList.add('dw-done');
      if (index === state.stepIndex) {
        item.classList.add('dw-current');
        item.setAttribute('aria-current', 'step');
      }
      item.append(element('span', 'dw-wizard-step-number', String(index + 1)), element('span', 'dw-wizard-step-label', STEP_LABELS[step] ?? step));
      stepList.append(item);
    });
  }

  /** One raw axis row: a -1..1 track with the covered span and the live position. */
  function axisRow(device, axis, { showSpan }) {
    const row = element('div', 'dw-wizard-axis');
    row.append(element('span', 'dw-wizard-axis-label', axis.label));
    const track = element('span', 'dw-wizard-track');
    track.setAttribute('aria-hidden', 'true');
    const span = element('span', 'dw-wizard-span');
    const marker = element('span', 'dw-wizard-marker');
    track.append(element('span', 'dw-wizard-mid'), span, marker);
    const value = element('span', 'dw-wizard-axis-value');
    const check = element('span', 'dw-wizard-check');
    row.append(track, value, check);
    return { row, span, marker, value, check, deviceKey: device.deviceKey, index: axis.index, showSpan, text: '', done: null };
  }

  function deviceBlock(device, axes, options) {
    const block = element('div', 'dw-wizard-device');
    block.append(element('h4', 'dw-micro', device.name));
    if (axes.length === 0) {
      block.append(element('p', 'dw-controls-faint', 'No axes to read on this device for this step.'));
      return block;
    }
    for (const axis of axes) {
      if (axis.hat) {
        const row = element('div', 'dw-wizard-axis dw-hat-axis');
        row.append(element('span', 'dw-wizard-axis-label', axis.label), element('span', 'dw-controls-faint', 'Hat (read as an axis): learned in the last step'));
        block.append(row);
        continue;
      }
      const handle = axisRow(device, axis, options);
      handles.rows.push(handle);
      block.append(handle.row);
    }
    return block;
  }

  function roleAxes(device, role) {
    const indices = new Set(device.roles?.[role] ?? []);
    return device.axes.filter((axis) => indices.has(axis.index));
  }

  function renderCenter(state) {
    content.append(element('p', 'dw-note', 'Hold everything still, then press Next. Axes resting far outside their range are recognised as hats.'));
    for (const device of state.devices) content.append(deviceBlock(device, device.axes, { showSpan: false }));
  }

  function renderAxes(state) {
    const counter = element('p', 'dw-note dw-wizard-counter');
    content.append(counter);
    handles.counter = counter;
    for (const device of state.devices) content.append(deviceBlock(device, device.axes, { showSpan: true }));
  }

  function renderThrottle(state) {
    content.append(element('p', 'dw-note', 'Hold the throttle fully forward while you press Next; the other end becomes idle.'));
    for (const device of state.devices) {
      const axes = roleAxes(device, 'throttle');
      if (axes.length > 0) content.append(deviceBlock(device, axes, { showSpan: false }));
    }
  }

  function renderPedals(state) {
    const substep = state.substep;
    const dots = element('ol', 'dw-wizard-substeps');
    dots.setAttribute('aria-label', 'Pedal positions');
    Object.keys(PEDAL_LABELS).forEach((id, index) => {
      const item = element('li', `dw-wizard-substep${index < substep.index ? ' dw-done' : ''}${index === substep.index ? ' dw-current' : ''}`, PEDAL_LABELS[id]);
      if (index === substep.index) item.setAttribute('aria-current', 'step');
      dots.append(item);
    });
    content.append(dots);
    const ready = element('p', 'dw-wizard-ready');
    ready.setAttribute('aria-live', 'polite');
    content.append(ready);
    handles.ready = ready;
    if (!substep.available) {
      ready.textContent = 'None of the connected devices has this pedal axis. Skip it.';
      return;
    }
    const role = PEDAL_ROLES[substep.id];
    for (const device of state.devices) {
      const axes = roleAxes(device, role);
      if (axes.length > 0) content.append(deviceBlock(device, axes, { showSpan: false }));
    }
  }

  function renderHats(state) {
    const hat = state.hat;
    content.append(element('p', 'dw-note', `Hat ${hat.index + 1} of ${hat.total}. Press and release each direction as it lights up; diagonals press two ways at once.`));
    const wrapper = element('div', 'dw-wizard-hat');
    const compass = element('div', 'dw-controls-hat-grid dw-wizard-compass');
    compass.setAttribute('role', 'img');
    const learned = new Set(hat.learned ?? []);
    for (const direction of HAT_CELLS) {
      const cell = element('span', direction ? 'dw-controls-hat-cell' : 'dw-controls-hat-cell dw-center');
      if (direction && learned.has(direction)) cell.classList.add('dw-learned');
      if (direction === hat.direction) cell.classList.add('dw-target');
      compass.append(cell);
    }
    const learnedText = learned.size === 0 ? 'nothing learned yet' : `learned: ${HAT_DIRECTIONS.filter((direction) => learned.has(direction)).map((direction) => HAT_DIRECTION_LABELS[direction]).join(', ')}`;
    compass.setAttribute('aria-label', `${hat.label}: press ${HAT_DIRECTION_LABELS[hat.direction]}; ${learnedText}`);
    const detail = element('div', 'dw-wizard-hat-detail');
    detail.append(element('strong', 'dw-wizard-hat-target', HAT_DIRECTION_LABELS[hat.direction].toUpperCase()));
    detail.append(element('span', 'dw-controls-faint', `${learned.size} of 8 directions learned${hat.form ? ` · reads as ${hat.form === 'axis' ? 'one axis' : 'buttons'}` : ''}`));
    const release = element('span', 'dw-wizard-release');
    detail.append(release);
    handles.release = release;
    wrapper.append(compass, detail);
    content.append(wrapper);
  }

  function describeAxisResult(entry) {
    if (Number.isFinite(entry.idle)) return `idle ${formatRaw(entry.idle)} · full ${formatRaw(entry.full)}`;
    return `${formatRaw(entry.min)} / ${formatRaw(entry.center)} / ${formatRaw(entry.max)}${entry.reversed ? ' · reversed' : ''}`;
  }

  function renderResults(state) {
    const results = state.results ?? [];
    if (results.length === 0) {
      content.append(element('p', 'dw-note', 'No controllers are connected, so there is nothing to save.'));
      return;
    }
    content.append(element('p', 'dw-note', 'Check the results, then save. Axes show min / centre / max (levers: idle and full); hats show how many directions were learned.'));
    for (const result of results) {
      const device = state.devices.find((candidate) => candidate.deviceKey === result.deviceKey);
      const block = element('div', 'dw-wizard-device dw-wizard-result');
      block.append(element('h4', 'dw-micro', result.name));
      const list = element('dl', 'dw-wizard-results');
      const axisEntries = Object.entries(result.axes);
      if (axisEntries.length === 0) list.append(element('dt', '', 'Axes'), element('dd', '', 'none captured: defaults kept'));
      for (const [index, entry] of axisEntries) {
        const label = device?.axes.find((axis) => axis.index === Number(index))?.label ?? `Axis ${Number(index) + 1}`;
        list.append(element('dt', '', label), element('dd', '', describeAxisResult(entry)));
      }
      result.hats.forEach((hat, index) => {
        const count = hat ? HAT_DIRECTIONS.filter((direction) => (hat.form === 'axis' ? Number.isFinite(hat.values?.[direction]) : Array.isArray(hat.combos?.[direction]))).length : 0;
        list.append(element('dt', '', `Hat ${index + 1}`), element('dd', '', hat ? `${count} of 8 directions (${hat.form === 'axis' ? 'one axis' : 'buttons'})` : 'not learned'));
      });
      block.append(list);
      for (const text of result.notes) block.append(element('p', 'dw-wizard-result-note', text));
      content.append(block);
    }
  }

  /** Devices that connected after the Center step: this run leaves their saved calibration alone. */
  function renderLateDevices(state) {
    const late = state.lateDevices ?? [];
    if (late.length === 0 || state.finished) return;
    const names = late.map((device) => device.name).join(' and ');
    content.append(element('p', 'dw-note', `${names} connected after the Center step, so this run does not calibrate it and its saved calibration stays as it is. Go back to Center (or run the wizard again) to include it.`));
  }

  function renderActions(state) {
    const done = state.step === 'done';
    backButton.hidden = state.finished;
    backButton.disabled = state.stepIndex === 0;
    skipButton.hidden = done || state.finished;
    skipButton.textContent = state.step === 'pedals' ? 'Skip position' : state.step === 'hats' ? 'Skip direction' : 'Skip step';
    nextButton.hidden = state.step === 'hats';
    nextButton.textContent = done ? 'Save calibration' : 'Next';
    nextButton.disabled = !state.canAdvance;
    cancelButton.textContent = 'Cancel';
    if (container.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement && (document.activeElement.hidden || document.activeElement.disabled)) {
      title.focus({ preventScroll: true });
    }
  }

  function render(state) {
    structureKey = keyOf(state);
    handles = { rows: [], ready: null, compass: null, release: null, counter: null };
    renderSteps(state);
    note.textContent = state.note;
    title.textContent = state.devices.length === 0 ? 'No controllers connected' : state.title;
    prompt.textContent = state.devices.length === 0 ? 'Press any button on your stick and throttle (or gamepad) to connect it.' : state.prompt;
    content.replaceChildren();
    renderLateDevices(state);
    if (state.devices.length > 0) {
      if (state.step === 'center') renderCenter(state);
      else if (state.step === 'axes') renderAxes(state);
      else if (state.step === 'throttle') renderThrottle(state);
      else if (state.step === 'pedals') renderPedals(state);
      else if (state.step === 'hats' && state.hat) renderHats(state);
      else if (state.step === 'done') renderResults(state);
    }
    renderActions(state);
    refreshLive(state);
  }

  function refreshLive(state) {
    const byDevice = new Map(state.devices.map((device) => [device.deviceKey, device]));
    let doneCount = 0;
    let axisCount = 0;
    for (const handle of handles.rows) {
      const axis = byDevice.get(handle.deviceKey)?.axes.find((candidate) => candidate.index === handle.index);
      if (!axis) continue;
      handle.marker.style.left = `${percentOfRange(axis.raw).toFixed(1)}%`;
      if (handle.showSpan && Number.isFinite(axis.min) && Number.isFinite(axis.max)) {
        const low = percentOfRange(axis.min);
        handle.span.style.left = `${low.toFixed(1)}%`;
        handle.span.style.width = `${(percentOfRange(axis.max) - low).toFixed(1)}%`;
      }
      const text = handle.showSpan
        ? `${formatRaw(axis.min)} to ${formatRaw(axis.max)}`
        : state.step === 'center' ? `now ${formatRaw(axis.raw)}` : formatRaw(axis.raw);
      if (text !== handle.text) {
        handle.text = text;
        handle.value.textContent = text;
      }
      if (handle.showSpan) {
        axisCount++;
        if (axis.done) doneCount++;
        if (handle.done !== axis.done) {
          handle.done = axis.done;
          handle.check.textContent = axis.done ? 'done' : '';
          handle.check.classList.toggle('dw-on', axis.done);
        }
      }
    }
    if (handles.counter) {
      const text = `${doneCount} of ${axisCount} axes moved lock to lock. Axes you do not have can stay; press Next when done.`;
      if (handles.counter.textContent !== text) handles.counter.textContent = text;
    }
    if (handles.ready && state.substep?.available) {
      const text = state.substep.ready ? 'Position held. Press Next while holding it.' : 'Waiting for the pedals to move.';
      if (handles.ready.textContent !== text) {
        handles.ready.textContent = text;
        handles.ready.classList.toggle('dw-on', state.substep.ready);
      }
    }
    if (handles.release && state.hat) {
      const text = state.hat.waitingForRelease ? 'Got it. Release the hat.' : 'Waiting for the hat.';
      if (handles.release.textContent !== text) handles.release.textContent = text;
    }
  }

  function poll(force = false) {
    if (!wizard) return;
    const state = wizard.getState();
    if (state.cancelled) return;
    if (force || keyOf(state) !== structureKey) {
      const previousStep = structureKey.split('|')[0];
      render(state);
      if (previousStep !== state.step) announce(`${state.title}. ${state.prompt}`);
    } else {
      refreshLive(state);
    }
  }

  function exit(outcome) {
    active = false;
    stopListening?.();
    stopListening = null;
    wizard = null;
    structureKey = '';
    onExit(outcome);
  }

  // ---- Buttons ---------------------------------------------------------------------------------------
  nextButton.addEventListener('click', () => {
    if (!wizard) return;
    const before = wizard.getState();
    if (before.step === 'done') {
      let saved;
      try {
        saved = wizard.finish();
      } catch (error) {
        console.error('[DRIFTWING] saving calibration failed', error);
        prompt.textContent = `Saving failed: ${error.message}. Nothing was changed.`;
        return;
      }
      announce(`Calibration saved for ${saved.map((record) => record.name).join(' and ')}.`);
      exit('saved');
      return;
    }
    wizard.next();
    poll(true);
  });
  skipButton.addEventListener('click', () => {
    if (!wizard) return;
    wizard.skip();
    poll(true);
  });
  backButton.addEventListener('click', () => {
    if (!wizard) return;
    wizard.back();
    poll(true);
  });
  cancelButton.addEventListener('click', () => cancel());

  function cancel() {
    if (!active) return;
    wizard?.cancel();
    exit('cancelled');
  }

  return {
    /** Starts the input system's wizard for deviceKeys (null: every connected controller). */
    start(deviceKeys = null) {
      const input = getInput();
      if (!input) return false;
      stopListening?.();
      wizard = input.startCalibration({ deviceKeys });
      active = true;
      structureKey = '';
      refreshTimer = 0;
      stopListening = wizard.onChange(() => {
        if (active) poll();
      });
      poll(true);
      title.focus({ preventScroll: true });
      return true;
    },

    update(step) {
      if (!active) return;
      refreshTimer -= step;
      if (refreshTimer > 0) return;
      refreshTimer = REFRESH_SECONDS;
      poll();
    },

    cancel,
    isActive: () => active,

    /** The wizard's current state (for tests), or null when it is not running. */
    getState() {
      return active && wizard ? wizard.getState() : null;
    },
  };
}
