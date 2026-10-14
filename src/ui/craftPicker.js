// Craft picker (contract h.7): a compact glass strip of low-poly craft silhouettes in the top-left
// corner, grouped as the catalog groups them (Planes, Rotor, Human, Lighter than air, Creature,
// Space), and a glass roster panel for the ten favorites and the skins.
//
// Only craft whose module is registered are shown (the picker works before and after the craft
// modules land; modules registered after boot appear within a second), and a group with none is left
// out. The selected craft is settings.craft: a click writes it through the settings command channel
// and the flight controller applies it, spawning the new craft in a sensible state for the situation
// through the module's situate() hook (contract h.4), or writing the previous craft back when it
// refuses.
//
// Favorites: settings.craftFavorites holds ten slots (keys 1-9 and 0, actions craftSelect1-10;
// craftNext / craftPrev cycle them). A craft's slot number shows on its strip button. The roster panel
// (the grid button at the end of the strip, or a right click on a craft) shows the ten slots: drag a
// craft from the roster onto a slot (or a slot onto another to swap them), or pick a craft's slot
// from its menu; a slot's x clears it. Skins (settings.craftSkins, '' for the module's default) sit
// under their craft in the roster (the eagle / dragon); the strip button shows the chosen skin.
import { FAVORITE_SLOTS } from '../core/settings.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** Seconds between checks for craft modules registered after the picker was built. */
const AVAILABILITY_CHECK_SECONDS = 1;
/** From this many shown craft the strip packs its buttons tighter, so 14 fit beside the compass at 1280 px. */
const DENSE_STRIP_CRAFT = 11;
const DRAG_TYPE = 'text/plain';

/** The key a favorite slot sits on: '1'..'9', then '0' for the tenth. */
export function favoriteKey(index) {
  return index === 9 ? '0' : String(index + 1);
}

/**
 * The favorites with craftId put in slot index (a new ten-slot list). A craft already in another slot
 * swaps places with the target's occupant; a craft not yet a favorite replaces it.
 */
export function assignFavorite(slots, craftId, index) {
  const next = slots.slice(0, FAVORITE_SLOTS);
  while (next.length < FAVORITE_SLOTS) next.push(null);
  if (!Number.isInteger(index) || index < 0 || index >= FAVORITE_SLOTS) return next;
  const current = next.indexOf(craftId);
  if (current === index) return next;
  if (current >= 0) next[current] = next[index];
  next[index] = craftId;
  return next;
}

/** The favorites with slot index emptied (a new ten-slot list). */
export function clearFavorite(slots, index) {
  const next = slots.slice(0, FAVORITE_SLOTS);
  while (next.length < FAVORITE_SLOTS) next.push(null);
  if (Number.isInteger(index) && index >= 0 && index < FAVORITE_SLOTS) next[index] = null;
  return next;
}

/** The favorites with slots `from` and `to` exchanged (a new ten-slot list). */
export function swapFavorites(slots, from, to) {
  const next = slots.slice(0, FAVORITE_SLOTS);
  while (next.length < FAVORITE_SLOTS) next.push(null);
  if ([from, to].every((index) => Number.isInteger(index) && index >= 0 && index < FAVORITE_SLOTS)) {
    const held = next[from];
    next[from] = next[to];
    next[to] = held;
  }
  return next;
}

function buildSilhouette(parts, className = 'dw-craft-icon') {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', className);
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

function buildSpriteIcon(symbol) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'dw-icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

/** The roster button's grid glyph (nine squares), in currentColor. */
function buildGridIcon() {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'dw-craft-icon dw-craft-grid-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const square = document.createElementNS(SVG_NAMESPACE, 'rect');
      square.setAttribute('x', String(4 + column * 6));
      square.setAttribute('y', String(4 + row * 6));
      square.setAttribute('width', '4');
      square.setAttribute('height', '4');
      square.setAttribute('rx', '1');
      square.setAttribute('fill', 'currentColor');
      svg.append(square);
    }
  }
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Builds the picker inside element (the strip; the roster panel joins element's parent). onSelect()
 * runs after a click asked for a craft.
 */
export function createCraftPicker({ element: strip, settings, bus, craftRegistry, onSelect }) {
  strip.classList.add('dw-craft-picker');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Craft');
  const host = strip.parentElement ?? strip;
  /** Strip buttons by craft id (kept across rebuilds). */
  const buttons = new Map();
  let availabilityKey = '';
  let selectedId = null;
  let checkTimer = 0;
  let favorites = readFavorites();
  let skins = settings.get('craftSkins') || {};
  let panelOpen = false;
  let dragSource = null;

  // ---- Settings ----------------------------------------------------------------------------------
  function readFavorites() {
    const stored = settings.get('craftFavorites');
    return Array.isArray(stored) && stored.length === FAVORITE_SLOTS ? stored : new Array(FAVORITE_SLOTS).fill(null);
  }

  function available(id) {
    return typeof id === 'string' && craftRegistry.has(id);
  }

  function nameOf(id) {
    const entry = craftRegistry.entry(id);
    return entry ? entry.name : id;
  }

  /** The skin a craft flies in now (its module's default when the setting is '' or unknown). */
  function activeSkin(id) {
    const module = craftRegistry.get(id);
    const list = module && module.skins ? module.skins.list : null;
    if (!list) return null;
    const chosen = skins[id];
    return list.find((skin) => skin.id === chosen) ?? list.find((skin) => skin.id === module.skins.default) ?? list[0];
  }

  function silhouetteOf(id) {
    const skin = activeSkin(id);
    if (skin && Array.isArray(skin.silhouette)) return skin.silhouette;
    return craftRegistry.entry(id).silhouette;
  }

  function writeFavorites(next) {
    if (!settings.set('craftFavorites', next)) {
      bus.emit('notify', { text: 'That favorite could not be saved.', kind: 'warning' });
      return false;
    }
    return true;
  }

  // ---- Strip -------------------------------------------------------------------------------------
  function select(craftId) {
    if (!available(craftId)) {
      bus.emit('notify', { text: `${nameOf(craftId)} is not installed in this build.`, kind: 'warning' });
      return false;
    }
    if (settings.get('craft') === craftId) return true;
    if (!settings.set('craft', craftId)) {
      bus.emit('notify', { text: 'That craft could not be selected.', kind: 'warning' });
      return false;
    }
    renderSelection();
    onSelect?.(craftId);
    return true;
  }

  function stripButton(entry) {
    let item = buttons.get(entry.id);
    if (item) return item;
    const button = element('button', 'dw-craft-button');
    button.type = 'button';
    button.dataset.craft = entry.id;
    button.dataset.tipPos = 'bottom';
    const key = element('span', 'dw-craft-key');
    key.setAttribute('aria-hidden', 'true');
    button.append(buildSilhouette(silhouetteOf(entry.id)), key);
    button.addEventListener('click', () => select(entry.id));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openPanel(entry.id);
    });
    item = { button, key, entry, skinId: activeSkin(entry.id)?.id ?? null };
    buttons.set(entry.id, item);
    return item;
  }

  const rosterButton = element('button', 'dw-craft-button dw-craft-roster-button');
  rosterButton.type = 'button';
  rosterButton.dataset.tipPos = 'bottom';
  rosterButton.dataset.tip = 'Craft, favorites and skins (right-click a craft too)';
  rosterButton.setAttribute('aria-label', 'Craft, favorites and skins');
  rosterButton.setAttribute('aria-haspopup', 'dialog');
  rosterButton.setAttribute('aria-expanded', 'false');
  rosterButton.append(buildGridIcon());
  rosterButton.addEventListener('click', () => (panelOpen ? closePanel() : openPanel()));

  /** The groups with at least one installed craft: [{ id, label, craft: [entries] }]. */
  function shownGroups() {
    return craftRegistry.groups()
      .map((group) => ({ id: group.id, label: group.label, craft: group.craft.filter((entry) => entry.available) }))
      .filter((group) => group.craft.length > 0);
  }

  /** Rebuilds the strip and the roster when the installed craft change. Returns whether it did. */
  function renderAvailability() {
    const key = craftRegistry.catalog.map((entry) => (craftRegistry.has(entry.id) ? '1' : '0')).join('');
    if (key === availabilityKey) return false;
    availabilityKey = key;
    const groups = shownGroups();
    const children = [];
    let shown = 0;
    for (const group of groups) {
      if (children.length > 0) {
        const separator = element('span', 'dw-craft-separator');
        separator.setAttribute('aria-hidden', 'true');
        children.push(separator);
      }
      const box = element('span', 'dw-craft-group');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', group.label);
      box.dataset.group = group.id;
      for (const entry of group.craft) {
        box.append(stripButton(entry).button);
        shown++;
      }
      children.push(box);
    }
    children.push(rosterButton);
    strip.replaceChildren(...children);
    strip.classList.toggle('dw-dense', shown >= DENSE_STRIP_CRAFT);
    selectedId = null;
    renderRoster();
    renderLabels();
    renderSelection();
    return true;
  }

  /** Slot numbers, tooltips and skin silhouettes on the strip buttons. */
  function renderLabels() {
    for (const item of buttons.values()) {
      const { button, key, entry } = item;
      const slot = favorites.indexOf(entry.id);
      key.textContent = slot >= 0 ? favoriteKey(slot) : '';
      const skin = activeSkin(entry.id);
      const skinId = skin ? skin.id : null;
      if (skinId !== item.skinId) {
        item.skinId = skinId;
        button.replaceChild(buildSilhouette(silhouetteOf(entry.id)), button.firstChild);
      }
      const name = skin && skin.name ? `${skin.name} (${entry.name})` : entry.name;
      const text = `${name} · ${entry.role}${slot >= 0 ? ` (key ${favoriteKey(slot)})` : ''}`;
      button.dataset.tip = text;
      button.setAttribute('aria-label', text);
    }
  }

  function renderSelection() {
    const craftId = settings.get('craft');
    if (craftId === selectedId) return;
    selectedId = craftId;
    for (const { button, entry } of buttons.values()) button.setAttribute('aria-pressed', String(entry.id === craftId));
    for (const row of rosterRows.values()) row.fly.setAttribute('aria-pressed', String(row.id === craftId));
  }

  // ---- Roster panel ------------------------------------------------------------------------------
  const panel = element('div', 'dw-craft-panel glass');
  panel.id = 'dw-craft-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Craft, favorites and skins');
  panel.hidden = true;
  rosterButton.setAttribute('aria-controls', panel.id);
  const head = element('div', 'dw-craft-panel-head');
  const title = element('span', 'dw-micro', 'Craft');
  const closeButton = element('button', 'dw-icon-button dw-small');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close the craft roster');
  closeButton.append(buildSpriteIcon('dw-i-close'));
  closeButton.addEventListener('click', () => closePanel());
  head.append(title, closeButton);

  const favoritesLabel = element('div', 'dw-craft-panel-label', 'Favorites');
  const favoritesHint = element('span', 'dw-craft-panel-hint', 'keys 1-0 · drag a craft onto a number');
  favoritesLabel.append(favoritesHint);
  const favoritesBar = element('div', 'dw-fav-bar');
  favoritesBar.setAttribute('role', 'list');
  favoritesBar.setAttribute('aria-label', 'Favorites on the number keys');
  const slotItems = [];
  for (let index = 0; index < FAVORITE_SLOTS; index++) {
    const slot = element('div', 'dw-fav-slot');
    slot.setAttribute('role', 'listitem');
    slot.dataset.slot = String(index);
    const fly = element('button', 'dw-fav-fly');
    fly.type = 'button';
    fly.dataset.tipPos = 'bottom';
    const key = element('span', 'dw-fav-key', favoriteKey(index));
    key.setAttribute('aria-hidden', 'true');
    const clear = element('button', 'dw-fav-clear');
    clear.type = 'button';
    clear.setAttribute('aria-label', `Clear favorite ${index + 1}`);
    clear.dataset.tip = `Clear favorite ${index + 1}`;
    clear.dataset.tipPos = 'bottom';
    clear.append(buildSpriteIcon('dw-i-close'));
    fly.addEventListener('click', () => {
      const id = favorites[index];
      if (available(id)) select(id);
    });
    clear.addEventListener('click', () => {
      if (favorites[index]) writeFavorites(clearFavorite(favorites, index));
    });
    slot.addEventListener('dragstart', (event) => startDrag(event, { kind: 'slot', index }));
    slot.addEventListener('dragend', endDrag);
    slot.addEventListener('dragover', (event) => {
      if (!dragSource) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      slot.classList.add('dw-drop-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('dw-drop-target'));
    slot.addEventListener('drop', (event) => {
      event.preventDefault();
      slot.classList.remove('dw-drop-target');
      dropOnSlot(index);
    });
    slot.append(fly, key, clear);
    favoritesBar.append(slot);
    slotItems.push({ slot, fly, clear, craftId: undefined });
  }

  const roster = element('div', 'dw-craft-roster');
  // A slot dragged back onto the roster is cleared.
  roster.addEventListener('dragover', (event) => {
    if (!dragSource || dragSource.kind !== 'slot') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  roster.addEventListener('drop', (event) => {
    if (!dragSource || dragSource.kind !== 'slot') return;
    event.preventDefault();
    writeFavorites(clearFavorite(favorites, dragSource.index));
  });
  panel.append(head, favoritesLabel, favoritesBar, roster);
  host.append(panel);
  /** Roster rows by craft id: { id, row, fly, menu, skins }. */
  const rosterRows = new Map();

  function startDrag(event, source) {
    if (source.kind === 'slot' && !favorites[source.index]) {
      event.preventDefault();
      return;
    }
    dragSource = source;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, source.kind === 'slot' ? `slot:${source.index}` : `craft:${source.id}`);
    panel.classList.add('dw-dragging');
  }

  function endDrag() {
    dragSource = null;
    panel.classList.remove('dw-dragging');
    for (const item of slotItems) item.slot.classList.remove('dw-drop-target');
  }

  function dropOnSlot(index) {
    const source = dragSource;
    endDrag();
    if (!source) return;
    if (source.kind === 'slot') {
      if (source.index !== index) writeFavorites(swapFavorites(favorites, source.index, index));
    } else {
      writeFavorites(assignFavorite(favorites, source.id, index));
    }
  }

  function buildRosterRow(entry) {
    const row = element('div', 'dw-roster-row');
    row.draggable = true;
    row.dataset.craft = entry.id;
    row.addEventListener('dragstart', (event) => startDrag(event, { kind: 'craft', id: entry.id }));
    row.addEventListener('dragend', endDrag);
    const fly = element('button', 'dw-roster-fly');
    fly.type = 'button';
    const text = element('span', 'dw-roster-text');
    text.append(element('span', 'dw-roster-name', entry.name), element('span', 'dw-roster-role', entry.role));
    fly.append(buildSilhouette(silhouetteOf(entry.id), 'dw-craft-icon dw-roster-icon'), text);
    fly.addEventListener('click', () => select(entry.id));
    const menu = element('select', 'dw-roster-slot');
    menu.setAttribute('aria-label', `Favorite key for ${entry.name}`);
    menu.append(new Option('No key', ''));
    for (let index = 0; index < FAVORITE_SLOTS; index++) menu.append(new Option(`Key ${favoriteKey(index)}`, String(index)));
    menu.addEventListener('change', () => {
      const value = menu.value;
      if (value === '') {
        const slot = favorites.indexOf(entry.id);
        if (slot >= 0) writeFavorites(clearFavorite(favorites, slot));
      } else {
        writeFavorites(assignFavorite(favorites, entry.id, Number(value)));
      }
    });
    row.append(fly, menu);
    const item = { id: entry.id, row, fly, menu, skins: null, skinButtons: [] };
    const module = craftRegistry.get(entry.id);
    if (module && module.skins && module.skins.list.length > 1) {
      // Skins sit right under their craft (the eagle / dragon).
      const skinBox = element('div', 'dw-roster-skins');
      skinBox.setAttribute('role', 'radiogroup');
      skinBox.setAttribute('aria-label', `${entry.name} skin`);
      for (const skin of module.skins.list) {
        const choice = element('button', 'dw-roster-skin');
        choice.type = 'button';
        choice.setAttribute('role', 'radio');
        choice.dataset.skin = skin.id;
        if (Array.isArray(skin.silhouette)) choice.append(buildSilhouette(skin.silhouette, 'dw-craft-icon dw-skin-icon'));
        choice.append(element('span', '', skin.name));
        choice.addEventListener('click', () => setSkin(entry.id, skin.id));
        skinBox.append(choice);
        item.skinButtons.push({ button: choice, id: skin.id });
      }
      item.skins = skinBox;
    }
    return item;
  }

  function renderRoster() {
    const sections = [];
    for (const group of shownGroups()) {
      const section = element('section', 'dw-roster-group');
      section.dataset.group = group.id;
      section.append(element('h3', 'dw-micro dw-roster-heading', group.label));
      for (const entry of group.craft) {
        let item = rosterRows.get(entry.id);
        if (!item) {
          item = buildRosterRow(entry);
          rosterRows.set(entry.id, item);
        }
        section.append(item.row);
        if (item.skins) section.append(item.skins);
      }
      sections.push(section);
    }
    roster.replaceChildren(...sections);
  }

  /** The favorites bar, every row's key menu and skin choice, from the settings. */
  function renderPanel() {
    slotItems.forEach((item, index) => {
      const id = favorites[index];
      const installed = available(id);
      if (item.craftId !== id || item.installed !== installed) {
        item.craftId = id;
        item.installed = installed;
        const icon = installed ? buildSilhouette(silhouetteOf(id), 'dw-craft-icon dw-fav-icon') : element('span', 'dw-fav-empty');
        item.fly.replaceChildren(icon);
      }
      const label = installed
        ? `Key ${favoriteKey(index)}: ${nameOf(id)}`
        : id ? `Key ${favoriteKey(index)}: empty (${nameOf(id)} is not in this build)` : `Key ${favoriteKey(index)}: empty`;
      item.fly.dataset.tip = label;
      item.fly.setAttribute('aria-label', label);
      item.fly.disabled = !installed;
      item.slot.draggable = installed;
      item.slot.classList.toggle('dw-fav-filled', installed);
      item.clear.hidden = !id;
    });
    for (const item of rosterRows.values()) {
      const slot = favorites.indexOf(item.id);
      item.menu.value = slot >= 0 ? String(slot) : '';
      const skin = activeSkin(item.id);
      for (const choice of item.skinButtons) choice.button.setAttribute('aria-checked', String(skin !== null && choice.id === skin.id));
    }
  }

  function onDocumentPointer(event) {
    if (!panelOpen) return;
    if (panel.contains(event.target) || rosterButton.contains(event.target)) return;
    if (strip.contains(event.target) && event.button === 2) return;
    closePanel();
  }

  function onPanelKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
    rosterButton.focus({ preventScroll: true });
  }
  panel.addEventListener('keydown', onPanelKey);
  document.addEventListener('pointerdown', onDocumentPointer, true);

  /** Opens the roster panel, focusing a craft's row when given. */
  function openPanel(craftId = null) {
    renderAvailability();
    renderPanel();
    panel.hidden = false;
    panelOpen = true;
    rosterButton.setAttribute('aria-expanded', 'true');
    host.classList.add('dw-craft-panel-open');
    const row = craftId ? rosterRows.get(craftId) : null;
    const target = row ? row.menu : rosterRows.get(settings.get('craft'))?.fly ?? closeButton;
    target.focus({ preventScroll: true });
    if (row) row.row.scrollIntoView({ block: 'nearest' });
    return true;
  }

  /** Closes the roster panel. Returns whether it was open. */
  function closePanel() {
    if (!panelOpen) return false;
    endDrag();
    panel.hidden = true;
    panelOpen = false;
    rosterButton.setAttribute('aria-expanded', 'false');
    host.classList.remove('dw-craft-panel-open');
    return true;
  }

  /** Chooses a craft's skin (settings.craftSkins; the module's default is stored as ''). */
  function setSkin(craftId, skinId) {
    const module = craftRegistry.get(craftId);
    if (!module || !module.skins || !module.skins.list.some((skin) => skin.id === skinId)) return false;
    const value = skinId === module.skins.default ? '' : skinId;
    if ((skins[craftId] ?? '') === value) return true;
    if (!settings.update('craftSkins', { [craftId]: value })) {
      bus.emit('notify', { text: 'That skin could not be selected.', kind: 'warning' });
      return false;
    }
    return true;
  }

  function refresh() {
    if (!renderAvailability()) {
      renderLabels();
      renderSelection();
    }
    if (panelOpen) renderPanel();
  }

  bus.on('settings:changed', (payload) => {
    if (!payload) return;
    if (payload.key === 'craft') renderSelection();
    if (payload.key === 'craftFavorites') {
      favorites = readFavorites();
      renderLabels();
      if (panelOpen) renderPanel();
    }
    if (payload.key === 'craftSkins') {
      skins = settings.get('craftSkins') || {};
      renderLabels();
      for (const item of rosterRows.values()) {
        const icon = buildSilhouette(silhouetteOf(item.id), 'dw-craft-icon dw-roster-icon');
        item.fly.replaceChild(icon, item.fly.firstChild);
      }
      if (panelOpen) renderPanel();
    }
  });
  bus.onTyped('craftChanged', refresh);
  refresh();

  return {
    refresh,
    /** Cheap periodic check so craft modules registered after boot show up. */
    update(step) {
      checkTimer -= step;
      if (checkTimer > 0) return;
      checkTimer = AVAILABILITY_CHECK_SECONDS;
      if (renderAvailability() && panelOpen) renderPanel();
    },
    getSelected: () => selectedId,
    openPanel,
    closePanel,
    isOpen: () => panelOpen,
    select,
    setSkin,
    /** Puts craftId in favorite slot index (0-9) through the settings. Returns whether it saved. */
    assignFavorite: (craftId, index) => writeFavorites(assignFavorite(favorites, craftId, index)),
    /** Empties favorite slot index. Returns whether it saved. */
    clearFavorite: (index) => writeFavorites(clearFavorite(favorites, index)),
    /** What the picker shows now (the picker step file reads it). */
    getState() {
      return {
        groups: shownGroups().map((group) => ({ id: group.id, label: group.label, craft: group.craft.map((entry) => entry.id) })),
        strip: [...strip.querySelectorAll('.dw-craft-group')].map((box) => ({ group: box.dataset.group, craft: [...box.querySelectorAll('.dw-craft-button')].map((button) => button.dataset.craft) })),
        keys: Object.fromEntries([...buttons.values()].filter((item) => item.button.isConnected).map((item) => [item.entry.id, item.key.textContent])),
        favorites: favorites.slice(),
        skins: { ...skins },
        selected: selectedId,
        open: panelOpen,
        dense: strip.classList.contains('dw-dense'),
      };
    },
  };
}
