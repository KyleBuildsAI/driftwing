// CLASSIC | SIM pill (top-left glass toggle).
//
// The pill shows the persisted settings.mode and changes it through the settings command channel:
// a click writes settings.set('mode', ...), the flight controller applies the switch and emits
// modeChanged, or refuses it and writes the previous value back. The pill follows both
// settings:changed and modeChanged, so a refused switch snaps back visually.

const MODE_LABELS = Object.freeze({ classic: 'CLASSIC', sim: 'SIM' });

/**
 * Builds the pill inside element (a <button>). onToggle(mode) is called after a click has asked
 * for a new mode (the UI uses it for the blip and to wake the HUD).
 */
export function createModePill({ element, settings, bus, onToggle }) {
  element.classList.add('dw-mode-pill');
  element.setAttribute('role', 'switch');
  element.innerHTML = [
    '<span class="dw-mode-thumb" aria-hidden="true"></span>',
    `<span class="dw-mode-option" data-mode="classic">${MODE_LABELS.classic}</span>`,
    `<span class="dw-mode-option" data-mode="sim">${MODE_LABELS.sim}</span>`,
  ].join('');
  let shownMode = null;

  function currentMode() {
    const mode = settings.get('mode');
    return mode in MODE_LABELS ? mode : 'classic';
  }

  function render() {
    const mode = currentMode();
    if (mode === shownMode) return;
    shownMode = mode;
    element.dataset.mode = mode;
    element.setAttribute('aria-checked', String(mode === 'sim'));
    const next = mode === 'sim' ? 'classic' : 'sim';
    const label = `Flight mode ${MODE_LABELS[mode]}. Switch to ${MODE_LABELS[next]} (V)`;
    element.setAttribute('aria-label', label);
    element.dataset.tip = `Switch to ${MODE_LABELS[next]} (V)`;
  }

  element.addEventListener('click', () => {
    const next = currentMode() === 'sim' ? 'classic' : 'sim';
    if (!settings.set('mode', next)) {
      bus.emit('notify', { text: 'Flight mode could not be changed.', kind: 'warning' });
      return;
    }
    render();
    onToggle?.(next);
  });

  bus.on('settings:changed', (payload) => {
    if (payload && payload.key === 'mode') render();
  });
  bus.onTyped('modeChanged', render);
  render();

  return {
    /** Mode the pill currently shows. */
    getMode: () => shownMode,
    refresh: render,
  };
}
