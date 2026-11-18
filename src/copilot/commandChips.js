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

const GUIDE_GROUP_ID = 'dw-quick-guide';
/** Guide chips refresh at most this often when spawns come and go (s). */
const GUIDE_REFRESH_SECONDS = 2;

/**
 * The "Guide" row: the tour-guide commands ("what's nearby", "find a thermal", "chase the storm",
 * "next discovery"), a "take me to" chip for the nearest live events and discovered sites (never an
 * undiscovered one), and "Yes, heading" / "No thanks" while a callout offer is open; then the
 * cross-craft guide's (craftGuide, optional): "Find water" always, "Find a perch" on a craft that
 * perches (the eagle), "To space" on the spaceplane, "Start challenge" while a course's start prompt
 * shows, and "Yes, switch" / "No" while an offer to switch craft is open. The chips use the same
 * data-command hook as the Aircraft row.
 */
export function createGuideChips(ctx, tourGuide, craftGuide = null) {
  const { bus, state } = ctx;
  const groups = typeof document !== 'undefined' ? document.querySelector('#dw-command .dw-command-groups') : null;
  if (!groups) {
    return { available: false, update() {}, refresh() {}, getStats: () => ({ available: false, chips: [] }) };
  }

  const group = document.createElement('div');
  group.className = 'dw-command-group';
  group.id = GUIDE_GROUP_ID;
  const label = document.createElement('span');
  label.className = 'dw-micro';
  label.textContent = 'Guide';
  const row = document.createElement('div');
  row.className = 'dw-chip-row';
  group.append(label, row);
  groups.append(group);

  let signature = '';
  let dirty = true;
  let timer = 0;
  let promptShown = false;

  /** The active craft's id and module, for the craft-specific chips. */
  function activeCraft() {
    const flight = ctx.systems.flight;
    const id = typeof flight?.getCraft === 'function' ? flight.getCraft() : state.flight.craft;
    const module = typeof flight?.getCraftModule === 'function' ? flight.getCraftModule() : null;
    return { id, module };
  }

  function chipsFor() {
    const chips = [];
    if (craftGuide && craftGuide.hasConfirm()) chips.push(['Yes, switch', 'yes'], ['No', 'no']);
    else if (tourGuide.getOffer()) chips.push(['Yes, heading', 'yes'], ['No thanks', 'no thanks']);
    chips.push(["What's nearby", "what's nearby"]);
    for (const destination of tourGuide.listDestinations(2)) chips.push([`To ${destination.name}`, `take me to the ${destination.name.toLowerCase()}`]);
    chips.push(['Find a thermal', 'find a thermal'], ['Chase the storm', 'chase the storm'], ['Next discovery', 'next discovery']);
    if (craftGuide) {
      const { id, module } = activeCraft();
      chips.push(['Find water', 'find water to land']);
      if (module && module.capabilities && module.capabilities.perch === true) chips.push(['Find a perch', 'find a perch']);
      if (id === 'spaceplane') chips.push(['To space', 'take me to space']);
      if (state.challenge && state.challenge.prompt) chips.push(['Start challenge', 'start the challenge']);
    }
    return chips;
  }

  function refresh() {
    dirty = false;
    const chips = chipsFor();
    const next = chips.map(([text, command]) => `${text}>${command}`).join('|');
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

  const markDirty = () => {
    dirty = true;
  };
  bus.on('copilot:offer', refresh);
  bus.on('copilot:confirm', refresh);
  bus.onTyped('craftChanged', markDirty);
  bus.onTyped('spawnActivated', markDirty);
  bus.onTyped('spawnEnded', markDirty);
  bus.onTyped('discovery', markDirty);
  refresh();

  return {
    available: true,
    refresh,
    /** Refreshes the destinations after spawns changed, at most every GUIDE_REFRESH_SECONDS. */
    update(realDt) {
      // A challenge's start prompt coming or going changes the row at once.
      const prompt = Boolean(state.challenge && state.challenge.prompt);
      if (prompt !== promptShown) {
        promptShown = prompt;
        refresh();
      }
      timer -= realDt;
      if (!dirty || timer > 0) return;
      timer = GUIDE_REFRESH_SECONDS;
      refresh();
    },
    getStats: () => ({ available: true, chips: [...row.children].map((button) => button.dataset.command) }),
  };
}
