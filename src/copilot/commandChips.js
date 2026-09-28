/**
 * The "Aircraft" row of quick chips in the Ask WREN command bar. It uses the command bar's existing
 * hook: any button inside #ui-root with a data-command attribute submits that phrase exactly as if it
 * had been typed (ui.js), so these chips need no UI code of their own.
 */

const GROUP_ID = 'dw-quick-aircraft';

/** [label, command] chips for the current state. */
function chipsFor(hasLanding) {
  const chips = [
    ['Assists up', 'assists up'],
    ['Assists down', 'assists down'],
    ['Airspeed', 'airspeed'],
  ];
  if (hasLanding) chips.push(['My landing', 'how was my landing']);
  chips.push(['Relaunch', 'relaunch']);
  return chips;
}

export function createCommandChips(ctx) {
  const { bus, state } = ctx;
  const groups = typeof document !== 'undefined' ? document.querySelector('#dw-command .dw-command-groups') : null;
  if (!groups) {
    return { available: false, refresh() {}, getStats: () => ({ available: false, chips: [] }) };
  }

  const group = document.createElement('div');
  group.className = 'dw-command-group';
  group.id = GROUP_ID;
  const label = document.createElement('span');
  label.className = 'dw-micro';
  label.textContent = 'Aircraft';
  const row = document.createElement('div');
  row.className = 'dw-chip-row';
  group.append(label, row);
  groups.append(group);

  let signature = '';
  function refresh() {
    const chips = chipsFor(Boolean(state.flight.lastLanding));
    const next = chips.map(([text]) => text).join('|');
    // An inline display wins over the stylesheet's grid (the hidden attribute alone would not).
    group.style.display = chips.length === 0 ? 'none' : '';
    if (next === signature) return;
    signature = next;
    row.replaceChildren(...chips.map(([text, command]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dw-quick';
      button.dataset.command = command;
      button.textContent = text;
      return button;
    }));
  }

  bus.onTyped('craftChanged', refresh);
  bus.onTyped('landed', refresh);
  refresh();

  return {
    available: true,
    refresh,
    getStats: () => ({ available: true, hidden: group.style.display === 'none', chips: [...row.children].map((button) => button.dataset.command) }),
  };
}
