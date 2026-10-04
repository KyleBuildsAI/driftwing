// Dev spawn debugger (F9). Created only in dev builds or with ?dev=1 (main.js decides); it is never a
// player feature, and it stays hidden until F9 opens it.
//
// Sections:
//   Presets    the preset list, filtered by category, kind, rarity and heavy; Spawn force-spawns a
//              preset ahead of the craft (at the chosen distance, ignoring the budgets); Nearest
//              teleports to the nearest site of that preset from the site feed
//   Time       a time-of-day scrubber and presets
//   Director   the spawns system's director (getState and getNearby): drought and pacing, weather,
//              heavy count and shed level, lights and engine use, rarity tiers, cooldowns,
//              candidates, active spawns, nearby entries and the activation log ("Director not
//              running" when it failed to start)
//   Spawns     the active spawns (tier, distance, source) with an End button each
//   Engines    per-engine instances, particles, lights, buffers; heavy count, real lights, lures,
//              memory
//   Wind       the WindField overlay toggle and the source count
//
// Keyboard: F9 opens the panel (focus moves into it) and closes it (focus returns). Esc closes it
// from inside. While it has focus, keys stay in the panel; while it is closed it listens to F9 only,
// so it never takes a flight key.
import './spawnDebugger.css';

const TOGGLE_KEY = 'F9';
const REFRESH_HZ = 4;
const DISTANCES = Object.freeze([['auto', 'Auto'], ['800', '800 m'], ['3000', '3 km'], ['8000', '8 km'], ['30000', '30 km']]);
const TIME_PRESETS = Object.freeze([['golden', 'Golden'], ['noon', 'Noon'], ['dusk', 'Dusk'], ['night', 'Night']]);
/** The director's getNearby radius shown in the Director section (km). */
const NEARBY_RADIUS_KM = 10;
const LIST_PREVIEW = 6;
const TELEPORT_APPROACH = 1800;
const TELEPORT_HEIGHT = 350;

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function button(label, title, onClick, extraClass = '') {
  const node = element('button', `dw-text-button${extraClass ? ` ${extraClass}` : ''}`, label);
  node.type = 'button';
  if (title) node.title = title;
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

function select(label, entries, onChange) {
  const node = element('select', 'dw-spawndbg-select');
  node.setAttribute('aria-label', label);
  for (const [value, text] of entries) {
    const option = element('option', '', text);
    option.value = value;
    node.append(option);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function section(title) {
  const node = element('section', 'dw-spawndbg-section');
  node.append(element('span', 'dw-micro', title));
  return node;
}

function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '-';
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function createSpawnDebugger(ctx) {
  const { bus, state, settings } = ctx;
  const spawns = ctx.systems.spawns;
  if (!spawns || !spawns.manager) throw new Error('[DRIFTWING] the spawn debugger needs the spawns system');
  const manager = spawns.manager;
  const root = document.getElementById('ui-root') ?? document.body;

  const filters = { category: 'all', kind: 'all', rarity: 'all', heavy: 'all' };
  let distanceChoice = 'auto';
  let open = false;
  let refreshTimer = 0;
  let restoreFocus = null;
  let presetSignature = '';
  let spawnSignature = '';

  // ---- Panel -------------------------------------------------------------------------------------
  const panel = element('div', 'dw-spawndbg glass');
  panel.id = 'dw-spawn-debugger';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Spawn debugger');
  panel.tabIndex = -1;
  const head = element('div', 'dw-spawndbg-head');
  const titleBlock = element('div');
  titleBlock.append(element('span', 'dw-micro dw-gold', 'Dev - F9'), element('h2', '', 'Spawn debugger'));
  const closeButton = button('Close', 'Close the spawn debugger (F9 or Esc)', () => setOpen(false), 'dw-spawndbg-close');
  head.append(titleBlock, closeButton);
  const body = element('div', 'dw-spawndbg-body');
  panel.append(head, body);

  // Presets.
  const presetSection = section('Presets');
  const filterRow = element('div', 'dw-spawndbg-filters');
  const categorySelect = select('Category', [['all', 'Category']], (value) => { filters.category = value; renderPresets(true); });
  const kindSelect = select('Kind', [['all', 'Kind'], ['site', 'Site'], ['event', 'Event']], (value) => { filters.kind = value; renderPresets(true); });
  const raritySelect = select('Rarity', [['all', 'Rarity'], ['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['legendary', 'Legendary']], (value) => { filters.rarity = value; renderPresets(true); });
  const heavySelect = select('Heavy', [['all', 'Weight'], ['heavy', 'Heavy'], ['light', 'Light']], (value) => { filters.heavy = value; renderPresets(true); });
  filterRow.append(categorySelect, kindSelect, raritySelect, heavySelect);
  const distanceRow = element('div', 'dw-spawndbg-row');
  distanceRow.append(element('span', 'dw-spawndbg-label', 'Spawn ahead at'), select('Spawn distance', DISTANCES, (value) => { distanceChoice = value; }));
  distanceRow.style.marginTop = '6px';
  const presetList = element('ul', 'dw-spawndbg-list');
  presetList.setAttribute('aria-label', 'Presets');
  const presetEmpty = element('p', 'dw-spawndbg-empty', '');
  presetSection.append(filterRow, distanceRow, presetList, presetEmpty);

  // Time of day.
  const timeSection = section('Time of day');
  const timeRow = element('div', 'dw-spawndbg-row');
  const timeRange = element('input', 'dw-range');
  timeRange.type = 'range';
  timeRange.min = '0';
  timeRange.max = '1';
  timeRange.step = '0.001';
  timeRange.setAttribute('aria-label', 'Time of day');
  const clock = element('span', 'dw-spawndbg-clock', '');
  timeRange.addEventListener('input', () => {
    ctx.systems.sky?.setDayTime?.(Number(timeRange.value), { transition: 0 });
    refreshClock();
  });
  timeRow.append(timeRange, clock);
  const timePresetRow = element('div', 'dw-spawndbg-row');
  for (const [preset, label] of TIME_PRESETS) {
    timePresetRow.append(button(label, `Jump to ${label.toLowerCase()}`, () => {
      ctx.systems.sky?.setPreset?.(preset);
    }));
  }
  timeSection.append(timeRow, timePresetRow);

  // Director.
  const directorSection = section('Director');
  const directorList = element('dl', 'dw-spawndbg-kv');
  const directorNote = element('p', 'dw-spawndbg-empty', 'Director not running');
  directorSection.append(directorList, directorNote);

  // Active spawns.
  const activeSection = section('Active spawns');
  const activeList = element('ul', 'dw-spawndbg-list');
  activeList.setAttribute('aria-label', 'Active spawns');
  const activeEmpty = element('p', 'dw-spawndbg-empty', 'No spawns active');
  activeSection.append(activeList, activeEmpty);

  // Engines.
  const engineSection = section('Engines');
  const engineTable = element('table', 'dw-spawndbg-table');
  const engineHead = engineTable.createTHead().insertRow();
  for (const [label, numeric] of [['Engine', false], ['Inst', true], ['Particles', true], ['Lights', true], ['Buffers', true]]) {
    const cell = element('th', numeric ? 'dw-spawndbg-num' : '', label);
    engineHead.append(cell);
  }
  const engineBody = engineTable.createTBody();
  const engineEmpty = element('p', 'dw-spawndbg-empty', 'No engines registered');
  const budgetList = element('dl', 'dw-spawndbg-kv');
  budgetList.style.marginTop = '8px';
  engineSection.append(engineTable, engineEmpty, budgetList);

  // Wind.
  const windSection = section('Wind');
  const windRow = element('div', 'dw-spawndbg-row');
  const overlayButton = button('Wind arrows', 'Toggle the WindField overlay (warm lifts, cool sinks)', () => {
    settings.set('windOverlay', !settings.get('windOverlay'));
    refreshWind();
  });
  const windSources = element('span', 'dw-spawndbg-label', '');
  windRow.append(overlayButton, windSources);
  windSection.append(windRow);

  body.append(presetSection, timeSection, directorSection, activeSection, engineSection, windSection);
  root.append(panel);

  // ---- Actions -----------------------------------------------------------------------------------
  function notify(text, kind) {
    bus.emit('notify', kind ? { text, kind } : { text });
  }

  function spawnDistanceFor(preset) {
    if (distanceChoice !== 'auto') return Number(distanceChoice);
    return Math.min(4000, Math.max(600, preset.lod.near * 0.6));
  }

  function forceSpawn(preset) {
    const distance = spawnDistanceFor(preset);
    let id = null;
    try {
      id = spawns.forceSpawn(preset.id, { distance, force: true });
    } catch (error) {
      console.error(`[DRIFTWING] spawn debugger: force spawn of "${preset.id}" failed`, error);
    }
    if (id) notify(`${preset.name} spawned ${formatDistance(distance)} ahead.`);
    else notify(`${preset.name} was refused (${manager.getStats().lastRefusal ?? 'see the console'}).`, 'warning');
    renderActive(true);
  }

  function teleportToNearest(preset) {
    const player = state.player.position;
    if (!manager.getSiteFeed()) {
      notify('No site feed is attached yet: sites cannot be searched.', 'warning');
      return;
    }
    const site = manager.findNearestSite(preset.id, player.x, player.z);
    if (!site) {
      notify(`No ${preset.name} within 60 km.`, 'warning');
      return;
    }
    const awayX = player.x - site.x;
    const awayZ = player.z - site.z;
    const away = Math.hypot(awayX, awayZ) || 1;
    const x = site.x + (awayX / away) * TELEPORT_APPROACH;
    const z = site.z + (awayZ / away) * TELEPORT_APPROACH;
    const ground = Math.max(ctx.world.groundHeight(x, z), site.groundY, ctx.world.WATER_LEVEL);
    const heading = ctx.util.bearingTo(x, z, site.x, site.z);
    ctx.systems.flight?.resetTo?.({ x, y: ground + TELEPORT_HEIGHT, z, heading });
    notify(`Teleported ${formatDistance(TELEPORT_APPROACH)} from ${preset.name}.`);
  }

  // ---- Rendering ---------------------------------------------------------------------------------
  function refreshCategories(presets) {
    const categories = [...new Set(presets.map((preset) => preset.category))].sort();
    const current = [...categorySelect.options].slice(1).map((option) => option.value);
    if (current.join(',') === categories.join(',')) return;
    while (categorySelect.options.length > 1) categorySelect.remove(1);
    for (const category of categories) {
      const option = element('option', '', category);
      option.value = category;
      categorySelect.append(option);
    }
    if (!categories.includes(filters.category)) {
      filters.category = 'all';
      categorySelect.value = 'all';
    }
  }

  function passesFilters(preset) {
    if (filters.category !== 'all' && preset.category !== filters.category) return false;
    if (filters.kind !== 'all' && preset.kind !== filters.kind) return false;
    if (filters.rarity !== 'all' && preset.rarity !== filters.rarity) return false;
    if (filters.heavy === 'heavy' && !preset.heavy) return false;
    if (filters.heavy === 'light' && preset.heavy) return false;
    return true;
  }

  function renderPresets(force = false) {
    const presets = manager.listPresets();
    const signature = presets.map((preset) => preset.id).join(',');
    if (!force && signature === presetSignature) return;
    presetSignature = signature;
    refreshCategories(presets);
    presetList.replaceChildren();
    const shown = presets.filter(passesFilters);
    for (const preset of shown) {
      const item = element('li', 'dw-spawndbg-item');
      const text = element('div', 'dw-spawndbg-item-text');
      const name = element('div', 'dw-spawndbg-item-name', preset.name);
      if (preset.heavy) name.append(' ', element('span', 'dw-spawndbg-heavy', 'heavy'));
      text.append(name, element('div', 'dw-spawndbg-item-meta', `${preset.category} - ${preset.kind} - ${preset.rarity} - ${preset.engines.map((entry) => entry.engine).join(', ')}`));
      const spawnButton = button('Spawn', `Force-spawn ${preset.name} ahead of the craft`, () => forceSpawn(preset));
      const nearestButton = button('Nearest', preset.kind === 'site' ? `Teleport near the nearest ${preset.name}` : 'Only sites have places to teleport to', () => teleportToNearest(preset));
      nearestButton.disabled = preset.kind !== 'site';
      item.append(text, spawnButton, nearestButton);
      presetList.append(item);
    }
    presetEmpty.textContent = presets.length === 0 ? 'No presets registered yet.' : shown.length === 0 ? 'No preset matches these filters.' : '';
    presetEmpty.hidden = presetEmpty.textContent === '';
  }

  function refreshClock() {
    const sky = ctx.systems.sky;
    if (!sky?.getDayTime) {
      clock.textContent = 'no sky';
      return;
    }
    if (document.activeElement !== timeRange) timeRange.value = String(sky.getDayTime());
    clock.textContent = `${sky.getClockString?.() ?? ''} ${state.time.label}`;
  }

  /** The rows of the director section from director.getState() (src/spawns/director.js). */
  function directorRows(directorState, nearby) {
    const { budgets, pacing, tiers, candidates, log } = directorState;
    const engineCaps = Object.entries(budgets.engines)
      .filter(([, used]) => used.instances > 0)
      .map(([name, used]) => `${name} ${used.instances}/${used.maxInstances}`);
    const eligible = candidates.filter((candidate) => candidate.eligible);
    const shownCandidates = (eligible.length > 0 ? eligible : candidates).slice(0, LIST_PREVIEW)
      .map((candidate) => `${candidate.presetId} ${formatDistance(candidate.distance)} ${candidate.offAxis} deg${candidate.eligible ? '' : ` (${candidate.rejection})`}`);
    const cooldowns = Object.entries(directorState.cooldowns).map(([id, seconds]) => `${id} ${seconds} s`);
    return [
      ['Drought', `${directorState.droughtSeconds} s of ${directorState.droughtThreshold} s (longest ${directorState.longestDrought} s, ${directorState.droughtFills} fills)`],
      ['Pacing', `${pacing.withinWindow}/${pacing.droughts} droughts ended within 90 s; ${directorState.notables} notables, last ${directorState.lastNotable.kind}`],
      ['Weather', directorState.weather],
      ['Heavy', `${directorState.heavyCount}/${budgets.maxHeavy}${directorState.deferHeavy ? ' - deferred' : ''} - shed level ${directorState.shedLevel}`],
      ['Lights', `${budgets.lights}/${budgets.maxRealLights}`],
      ['Engines', engineCaps.length > 0 ? engineCaps.join(', ') : 'none in use'],
      ['Tiers', Object.entries(tiers).map(([name, tier]) => `${name} ${tier.dueIn} s (${tier.activations})`).join(', ')],
      ['Cooldowns', cooldowns.length > 0 ? cooldowns.join(', ') : 'none'],
      ['Candidates', `${candidates.length} (${eligible.length} eligible)${shownCandidates.length > 0 ? `: ${shownCandidates.join(' | ')}` : ''}`],
      ['Active', directorState.active.length > 0 ? directorState.active.map((spawn) => `${spawn.presetId} ${spawn.source} ${spawn.age} s`).join(', ') : 'none'],
      ['Nearby', nearby.length > 0 ? nearby.slice(0, LIST_PREVIEW).map((entry) => `${entry.name} ${formatDistance(entry.distance)} ${entry.state}`).join(' | ') : 'nothing within 10 km'],
      ['Log', log.length > 0 ? log.slice(-LIST_PREVIEW).map((entry) => `${Math.round(entry.time)} s ${entry.presetId} (${entry.reason})`).join(' | ') : 'empty'],
      ['Log hash', `${directorState.logHash} (${directorState.logLength} entries, ${directorState.ticks} ticks)`],
    ];
  }

  function renderDirector() {
    const director = spawns.director;
    directorList.replaceChildren();
    if (!director) {
      directorNote.hidden = false;
      return;
    }
    let rows = null;
    try {
      rows = directorRows(director.getState(), director.getNearby(NEARBY_RADIUS_KM));
    } catch (error) {
      console.error('[DRIFTWING] spawn debugger: reading the director failed', error);
    }
    if (!rows) {
      directorNote.textContent = 'Director state unavailable';
      directorNote.hidden = false;
      return;
    }
    directorNote.hidden = true;
    for (const [label, value] of rows) directorList.append(element('dt', '', label), element('dd', '', value));
  }

  function renderActive(force = false) {
    const active = manager.getActive();
    const signature = active.map((spawn) => spawn.id).join(',');
    if (force || signature !== spawnSignature) {
      spawnSignature = signature;
      activeList.replaceChildren();
      for (const spawn of active) {
        const item = element('li', 'dw-spawndbg-item');
        item.dataset.id = spawn.id;
        const text = element('div', 'dw-spawndbg-item-text');
        text.append(element('div', 'dw-spawndbg-item-name', spawn.name), element('div', 'dw-spawndbg-item-meta', ''));
        item.append(text, button('End', `End ${spawn.name}`, () => {
          manager.deactivate(spawn.id, 'debug');
          renderActive(true);
        }));
        activeList.append(item);
      }
    }
    activeEmpty.hidden = active.length > 0;
    for (const spawn of active) {
      const item = activeList.querySelector(`[data-id="${CSS.escape(spawn.id)}"]`);
      if (!item) continue;
      const lure = spawn.lure === null ? '' : ` - lure ${Math.round(spawn.lure * 100)}%`;
      const flags = `${spawn.heavy ? ' - heavy' : ''}${spawn.inView ? ' - in view' : ''}${spawn.discovered ? ' - discovered' : ''}`;
      item.querySelector('.dw-spawndbg-item-meta').textContent = `${spawn.tier} - ${formatDistance(spawn.distance)} - ${spawn.source}${lure}${flags}`;
    }
  }

  function renderEngines() {
    const stats = manager.getStats();
    engineBody.replaceChildren();
    const names = Object.keys(stats.engines);
    for (const name of names) {
      const entry = stats.engines[name];
      const row = engineBody.insertRow();
      const values = [
        entry.failed ? `${name} (failed)` : name,
        `${entry.active}/${entry.budget.instances}`,
        `${entry.particles}/${entry.budget.particles}`,
        entry.lights,
        entry.buffers,
      ];
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = String(value);
        if (index > 0) cell.className = 'dw-spawndbg-num';
        if (index === 0 && entry.failed) cell.classList.add('dw-spawndbg-warn');
      });
    }
    engineTable.hidden = names.length === 0;
    engineEmpty.hidden = names.length > 0;
    const memory = stats.memory.current;
    const rows = [
      ['Spawns', `${stats.spawns} (${stats.sites} sites, ${stats.events} events)`],
      ['Tiers', `near ${stats.tiers.near}, mid ${stats.tiers.mid}, far ${stats.tiers.far}`],
      ['Heavy', `${stats.heavy}/${stats.heavyLimit}`],
      ['Real lights', `${stats.lights.active}/${stats.lights.size}`],
      ['Lures', `${stats.lures.drawn} drawn of ${stats.lures.active}`],
      ['GPU memory', `${memory.geometries} geometries, ${memory.textures} textures`],
      ['Discovered', String(stats.discovered)],
    ];
    if (stats.leaks.windSources + stats.leaks.lights > 0) rows.push(['Leaks', `${stats.leaks.windSources} wind sources, ${stats.leaks.lights} lights`]);
    budgetList.replaceChildren();
    for (const [label, value] of rows) budgetList.append(element('dt', '', label), element('dd', '', value));
  }

  function refreshWind() {
    const on = Boolean(settings.get('windOverlay'));
    overlayButton.setAttribute('aria-pressed', String(on));
    overlayButton.classList.toggle('dw-solid', on);
    windSources.textContent = `${ctx.wind?.sourceCount ?? 0} wind sources`;
  }

  function refresh() {
    renderPresets();
    refreshClock();
    renderDirector();
    renderActive();
    renderEngines();
    refreshWind();
  }

  // ---- Open / close ------------------------------------------------------------------------------
  function setOpen(next) {
    if (next === open) return;
    open = next;
    panel.classList.toggle('dw-open', open);
    if (open) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      renderPresets(true);
      refresh();
      refreshTimer = 1 / REFRESH_HZ;
      panel.focus({ preventScroll: true });
    } else {
      if (panel.contains(document.activeElement)) {
        if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus({ preventScroll: true });
        else document.activeElement.blur();
      }
      restoreFocus = null;
    }
  }

  window.addEventListener('keydown', (event) => {
    if (event.code !== TOGGLE_KEY || event.repeat) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    setOpen(!open);
  }, true);

  // Keys typed inside the panel belong to it: they never reach the flight controls or the HUD keys.
  panel.addEventListener('keydown', (event) => {
    if (event.code === TOGGLE_KEY) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
    event.stopPropagation();
  });

  return {
    update(simDt, realDt) {
      if (!open) return;
      refreshTimer -= realDt;
      if (refreshTimer > 0) return;
      refreshTimer = 1 / REFRESH_HZ;
      refresh();
    },
    isOpen: () => open,
    setOpen,
    toggle() {
      setOpen(!open);
    },
  };
}
