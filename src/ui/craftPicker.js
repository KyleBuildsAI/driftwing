// Craft picker: a compact glass strip of low-poly craft silhouettes beside the mode pill.
//
// Icons come from craftRegistry.catalog (SVG parts filled or stroked with currentColor). The
// selected craft is settings.craft; a click writes it through the settings command channel and the
// flight controller applies it (emitting craftChanged, or writing the previous craft back when it
// refuses). A catalog craft whose module is not registered stays visible but disabled.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** Seconds between checks for craft modules registered after the picker was built. */
const AVAILABILITY_CHECK_SECONDS = 1;

function hotkeyLabel(hotkey) {
  const match = /^Digit(\d)$/.exec(String(hotkey || ''));
  return match ? match[1] : '';
}

function buildSilhouette(parts) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'dw-craft-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const part of parts) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', part.d);
    if (part.mode === 'stroke') {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    } else {
      path.setAttribute('fill', 'currentColor');
    }
    svg.append(path);
  }
  return svg;
}

/**
 * Builds the picker inside element. onSelect(craftId) runs after a click asked for a craft.
 */
export function createCraftPicker({ element, settings, bus, craftRegistry, onSelect }) {
  element.classList.add('dw-craft-picker');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Craft');
  const buttons = new Map();
  let availabilityKey = '';
  let selectedId = null;
  let checkTimer = 0;

  for (const entry of craftRegistry.catalog) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dw-craft-button';
    button.dataset.craft = entry.id;
    button.dataset.tipPos = 'bottom';
    const key = document.createElement('span');
    key.className = 'dw-craft-key';
    key.setAttribute('aria-hidden', 'true');
    key.textContent = hotkeyLabel(entry.hotkey);
    button.append(buildSilhouette(entry.silhouette), key);
    button.addEventListener('click', () => select(entry.id));
    element.append(button);
    buttons.set(entry.id, { button, entry });
  }

  function select(craftId) {
    const item = buttons.get(craftId);
    if (!item || !craftRegistry.has(craftId)) {
      bus.emit('notify', { text: `${item ? item.entry.name : 'That craft'} is not installed in this build.`, kind: 'warning' });
      return;
    }
    if (settings.get('craft') === craftId) return;
    if (!settings.set('craft', craftId)) {
      bus.emit('notify', { text: 'That craft could not be selected.', kind: 'warning' });
      return;
    }
    renderSelection();
    onSelect?.(craftId);
  }

  function describe(entry, available) {
    const key = hotkeyLabel(entry.hotkey);
    if (!available) return `${entry.name} is not installed in this build`;
    return `${entry.name} · ${entry.role}${key ? ` (${key})` : ''}`;
  }

  /** Enables, disables and labels every button from the registry. */
  function renderAvailability() {
    const key = craftRegistry.catalog.map((entry) => (craftRegistry.has(entry.id) ? '1' : '0')).join('');
    if (key === availabilityKey) return;
    availabilityKey = key;
    for (const { button, entry } of buttons.values()) {
      const available = craftRegistry.has(entry.id);
      button.classList.toggle('dw-unavailable', !available);
      button.setAttribute('aria-disabled', String(!available));
      const text = describe(entry, available);
      button.dataset.tip = text;
      button.setAttribute('aria-label', text);
    }
  }

  function renderSelection() {
    const craftId = settings.get('craft');
    if (craftId === selectedId) return;
    selectedId = craftId;
    for (const { button, entry } of buttons.values()) button.setAttribute('aria-pressed', String(entry.id === craftId));
  }

  function refresh() {
    renderAvailability();
    renderSelection();
  }

  bus.on('settings:changed', (payload) => {
    if (payload && payload.key === 'craft') renderSelection();
  });
  bus.onTyped('craftChanged', refresh);
  refresh();

  return {
    refresh,
    /** Cheap periodic check so craft modules registered after boot enable their buttons. */
    update(step) {
      checkTimer -= step;
      if (checkTimer > 0) return;
      checkTimer = AVAILABILITY_CHECK_SECONDS;
      renderAvailability();
    },
    getSelected: () => selectedId,
  };
}
