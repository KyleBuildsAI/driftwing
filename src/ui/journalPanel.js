// The journal panel's body (J, the 'journal' action): this world's totals, its spawn discoveries
// with the collection count (x / N over the implemented presets), the global records (storms chased,
// closest tornado, best canyon run, the highest altitude, best landing, perches landed and any other
// statistic a preset sends), the achievements, the flight time per craft (all 14, by picker group,
// with each craft's own statistics and its skins), the aerobatic figures flown, the challenge bests
// (per course and craft, with medals), the worlds visited through portal rings (with their seed
// links), the biomes, the Phase 1 landmarks, ring courses and this world's landings. A row of section
// buttons jumps through the long list. Everything is read from the journal system
// (src/gameplay/journal.js); the panel shell and its opening belong to ui.js.
import './journalPanel.css';
import { JOURNAL_STATS, PERCH_KINDS, listJournalStats } from '../gameplay/journal.js';
import { FIGURES } from '../flight/maneuverRecognizer.js';
import { discoveryIcon, discoveryIconSvg } from './categoryIcons.js';
import { altitudeParts, distanceParts, durationParts, formatClock, formatCoordinates, formatRunTime, formatStat, formatWhen, statLabel, statParts } from './journalFormat.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const LANDMARK_TYPE_LABELS = { arch: 'Stone arch', monoliths: 'Standing stones', lighthouse: 'Lighthouse', balloons: 'Balloon meet' };
const LANDING_GRADE_LABELS = { butter: 'Butter', smooth: 'Smooth', firm: 'Firm', hard: 'Hard' };
const MEDAL_LABELS = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
const PERCH_KIND_LABELS = { peak: ['peak', 'peaks'], structure: ['structure', 'structures'], tree: ['tree', 'trees'] };
/** The aerobatic best-score statistics: shown in Figures, so the Craft section leaves them out. */
const FIGURE_STATS = new Set(FIGURES.map((figure) => figure.stat));
/** The section jump buttons, in panel order: [section id, label]. */
const SECTIONS = Object.freeze([
  ['discoveries', 'Discoveries'],
  ['records', 'Records'],
  ['craft', 'Craft'],
  ['figures', 'Figures'],
  ['challenges', 'Challenges'],
  ['worlds', 'Worlds'],
]);
/** Newest entries listed per section; the journal keeps them all. */
const MAX_LISTED = 60;
/** Seconds between refreshes of the live totals while the panel is open. */
const STATS_REFRESH_SECONDS = 2;
/** How long "Fly there?" waits for the second press before a world row's Open button resets. */
const OPEN_CONFIRM_MS = 3200;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
function hexToCss(hex) {
  return `#${(Number(hex) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}
function plural(count, [one, many]) {
  return `${count} ${count === 1 ? one : many}`;
}
function statCard(label, parts, statKey, extraClass = '', note = '') {
  return `<div class="dw-stat${extraClass}"><span class="dw-micro">${escapeHtml(label)}</span><span class="dw-stat-value" data-stat="${statKey}">${escapeHtml(parts[0])}<small>${escapeHtml(parts[1])}</small></span>${note ? `<span class="dw-stat-note">${escapeHtml(note)}</span>` : ''}</div>`;
}
/** A section heading row: the title (focusable for the jump buttons) and an optional count on the right. */
function sectionHead(title, count = '', countKey = '') {
  return `<div class="dw-group-head"><h3 class="dw-micro" tabindex="-1">${escapeHtml(title)}</h3>${count ? `<span class="dw-collection"${countKey ? ` data-stat="${countKey}"` : ''}>${escapeHtml(count)}</span>` : ''}</div>`;
}
/** A craft silhouette (registry parts, 64 x 64 top view) as inline SVG. */
function silhouetteSvg(parts) {
  const paths = (Array.isArray(parts) ? parts : []).map((part) => (part.mode === 'stroke'
    ? `<path d="${escapeHtml(part.d)}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${escapeHtml(part.d)}" fill="currentColor"/>`)).join('');
  return `<svg class="dw-journal-craft-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/**
 * Creates the journal panel renderer. body and seedLabel are the panel's elements; ctx supplies
 * state, world, settings, craftRegistry and systems.journal; seedLinks (src/ui/seedLinks.js, optional)
 * copies and opens the worlds visited. Returns { render(), update(step) }.
 */
export function createJournalPanel({ body, seedLabel, ctx, seedLinks = null }) {
  const { state, world, settings } = ctx;
  const liveStats = { distance: null, time: null, altitude: null, landmarks: null, maxAltitude: null, craftTime: null, craftId: null };
  let statsTimer = 0;
  let openConfirm = null;

  function journal() {
    return ctx.systems.journal ?? null;
  }
  function biomeNameFor(value) {
    if (Number.isInteger(value) && world.BIOMES[value]) return world.BIOMES[value].name;
    const match = world.BIOMES.find((biome) => biome.key === value || biome.name === value);
    return match ? match.name : capitalize(value || 'Unknown lands');
  }
  function totalsParts(data) {
    const landmarks = Array.isArray(data.landmarksFound) ? data.landmarksFound.length : 0;
    return {
      distance: distanceParts(data.distanceFlown),
      time: durationParts(data.flightTime),
      altitude: altitudeParts(data.maxAltitude),
      landmarks: [String(landmarks), landmarks === 1 ? 'landmark' : 'landmarks'],
    };
  }

  // ---- Landings (this world, Phase 1) -----------------------------------------------------------
  function craftNameFor(craftId) {
    return ctx.craftRegistry.catalog.find((entry) => entry.id === craftId)?.name ?? capitalize(craftId || 'unknown craft');
  }
  /** Touchdown sink rate in the player's units, with the other unit alongside. */
  function formatSinkRate(sinkRate) {
    const feetPerMinute = Math.round((sinkRate * 196.85) / 10) * 10;
    return settings.get('units') === 'aviation' ? `${feetPerMinute} fpm (${sinkRate.toFixed(1)} m/s)` : `${sinkRate.toFixed(1)} m/s (${feetPerMinute} fpm)`;
  }
  function formatGroundSpeed(metresPerSecond) {
    return settings.get('units') === 'aviation' ? `${Math.round(metresPerSecond * 1.943844)} kt` : `${Math.round(metresPerSecond * 3.6)} km/h`;
  }
  /** Journal section for graded landings: the best one (grade, sink rate, craft, when), count and last. */
  function landingsHtml(landings) {
    const html = ['<div class="dw-group"><h3 class="dw-micro">Landings in this world</h3>'];
    const best = landings && landings.best;
    if (!best || !LANDING_GRADE_LABELS[best.grade]) {
      html.push('<p class="dw-empty">No graded landings yet. Every touchdown is graded butter, smooth, firm or hard, and the best one is kept here.</p></div>');
      return html.join('');
    }
    const meta = [craftNameFor(best.craft), `${formatGroundSpeed(best.groundSpeed)} over the ground`, formatWhen(best.at)].filter(Boolean).join(' · ');
    html.push(`<div class="dw-landing-best dw-grade-${best.grade}" data-landing-grade="${best.grade}"><span class="dw-landing-grade">${LANDING_GRADE_LABELS[best.grade]}</span><span class="dw-landing-detail"><span>Best landing: ${escapeHtml(formatSinkRate(best.sinkRate))} sink</span><span class="dw-landing-meta">${escapeHtml(meta)}</span></span></div>`);
    const count = Math.max(0, Math.round(Number(landings.count) || 0));
    const last = landings.last && LANDING_GRADE_LABELS[landings.last.grade] ? landings.last : null;
    html.push('<div class="dw-landing-bests">');
    html.push(statCard('Graded', [String(count), count === 1 ? 'landing' : 'landings'], 'landings-count'));
    html.push(statCard('Last', last ? [LANDING_GRADE_LABELS[last.grade], formatSinkRate(last.sinkRate).split(' (')[0]] : ['None', ''], 'landings-last'));
    html.push('</div></div>');
    return html.join('');
  }

  // ---- Section jumps -----------------------------------------------------------------------------
  function jumpsHtml() {
    const buttons = SECTIONS.map(([id, label]) => `<button type="button" class="dw-journal-jump" data-journal-jump="${id}">${escapeHtml(label)}</button>`).join('');
    return `<nav class="dw-journal-jumps" aria-label="Journal sections">${buttons}</nav>`;
  }

  // ---- Spawn discoveries (this world) -------------------------------------------------------------
  function discoveriesHtml(data) {
    const entries = Array.isArray(data.spawnsFound) ? data.spawnsFound : [];
    const found = Number(data.collection?.found) || 0;
    const total = Number(data.collection?.total) || 0;
    const html = ['<div class="dw-group dw-discoveries" data-journal-section="discoveries">'];
    html.push(sectionHead('Discoveries', total > 0 ? `${found} / ${total}` : '', 'collection'));
    if (total > 0) html.push(`<div class="dw-collection-bar" role="presentation"><i style="width:${Math.round((found / total) * 100)}%"></i></div>`);
    if (entries.length === 0) {
      html.push('<p class="dw-empty">Nothing yet. Storms, volcanoes, whales and stranger things show on the horizon; fly toward one and it is logged here with where and when you saw it.</p></div>');
      return html.join('');
    }
    html.push('<ul class="dw-finds">');
    for (let index = entries.length - 1; index >= 0 && index >= entries.length - MAX_LISTED; index--) {
      const entry = entries[index];
      const icon = discoveryIcon(entry.category);
      const when = [formatClock(entry.dayTime), entry.timeLabel].filter(Boolean).join(' ');
      const meta = [icon.label, when, formatCoordinates(entry.x, entry.z), formatWhen(entry.foundAt)].filter(Boolean).join(' · ');
      html.push(`<li class="dw-find" data-find="${escapeHtml(entry.id)}" style="--dw-find-color:${icon.color}"><span class="dw-find-icon">${discoveryIconSvg(entry.category)}</span><span class="dw-find-text"><span class="dw-find-name">${escapeHtml(entry.name)}</span>${entry.description ? `<span class="dw-find-line">${escapeHtml(entry.description)}</span>` : ''}<span class="dw-find-meta">${escapeHtml(meta)}</span></span></li>`);
    }
    html.push('</ul></div>');
    return html.join('');
  }

  // ---- Records and achievements (every world) ----------------------------------------------------
  /** Perches landed: the count, with the kinds that have any as a note. */
  function perchesCard(perches) {
    const count = Math.max(0, Math.round(Number(perches?.count) || 0));
    const kinds = PERCH_KINDS.filter((kind) => Number(perches?.kinds?.[kind]) > 0).map((kind) => plural(Math.round(perches.kinds[kind]), PERCH_KIND_LABELS[kind]));
    const note = count > 0 ? kinds.join(' · ') : 'Land the eagle on a peak, a tower or a tree top';
    return statCard('Perches landed', [String(count), ''], 'record-perches', count > 0 ? '' : ' dw-unset', note);
  }

  function recordsHtml(records) {
    const stats = records?.stats ?? {};
    const html = ['<div class="dw-group" data-journal-section="records">', sectionHead('Records · every world'), '<div class="dw-records">'];
    for (const key of Object.keys(JOURNAL_STATS)) {
      const stat = stats[key];
      html.push(statCard(statLabel(key), stat ? statParts(key, stat.value) : ['None', ''], `record-${key}`, stat ? '' : ' dw-unset'));
    }
    const bestLanding = records?.bestLanding;
    html.push(statCard('Best landing', bestLanding && LANDING_GRADE_LABELS[bestLanding.grade] ? [LANDING_GRADE_LABELS[bestLanding.grade], formatSinkRate(bestLanding.sinkRate).split(' (')[0]] : ['None', ''], 'record-bestLanding', bestLanding ? '' : ' dw-unset'));
    html.push(perchesCard(records?.perches));
    // Any other statistic a preset sends; the craft modules' own statistics are listed under each craft.
    const craftKeys = new Set(listJournalStats().filter((stat) => stat.craft).map((stat) => stat.key));
    for (const [key, stat] of Object.entries(stats)) {
      if (JOURNAL_STATS[key] || craftKeys.has(key)) continue;
      html.push(statCard(statLabel(key), statParts(key, stat.value), `record-${key}`));
    }
    html.push('</div></div>');
    return html.join('');
  }

  function achievementsHtml(records) {
    const earned = Array.isArray(records?.achievements) ? records.achievements : [];
    const declared = typeof journal()?.getDeclaredAchievements === 'function' ? journal().getDeclaredAchievements() : [];
    const descriptions = new Map(declared.map((entry) => [entry.id, entry.description]));
    const earnedIds = new Set(earned.map((entry) => entry.id));
    const locked = declared.filter((entry) => !earnedIds.has(entry.id));
    const html = [`<div class="dw-group"><div class="dw-group-head"><h3 class="dw-micro">Achievements</h3><span class="dw-collection" data-stat="achievements">${earned.length}${declared.length > 0 ? ` / ${new Set([...earnedIds, ...declared.map((entry) => entry.id)]).size}` : ''}</span></div>`];
    if (earned.length === 0 && locked.length === 0) {
      html.push('<p class="dw-empty">None yet. Hold the slot in a V of geese, or fly under a rope bridge.</p></div>');
      return html.join('');
    }
    html.push('<ul class="dw-achievements">');
    for (let index = earned.length - 1; index >= 0; index--) {
      const entry = earned[index];
      const detail = [descriptions.get(entry.id), formatWhen(entry.at), entry.seed ? `seed ${entry.seed}` : ''].filter(Boolean).join(' · ');
      html.push(`<li class="dw-achievement dw-earned" data-achievement="${escapeHtml(entry.id)}"><span class="dw-achievement-icon">${discoveryIconSvg('achievement')}</span><span class="dw-find-text"><span class="dw-find-name">${escapeHtml(entry.title)}</span><span class="dw-find-meta">${escapeHtml(detail)}</span></span></li>`);
    }
    for (const entry of locked) {
      html.push(`<li class="dw-achievement" data-achievement="${escapeHtml(entry.id)}"><span class="dw-achievement-icon">${discoveryIconSvg('achievement')}</span><span class="dw-find-text"><span class="dw-find-name">${escapeHtml(entry.title)}</span><span class="dw-find-meta">${escapeHtml(entry.description || 'Not yet earned')}</span></span></li>`);
    }
    html.push('</ul></div>');
    return html.join('');
  }

  // ---- Craft (every world) -------------------------------------------------------------------------
  /** The skin a craft flies in now: its module's skin entry (settings.craftSkins, else the default), or null. */
  function activeSkinOf(module) {
    if (!module || !module.skins) return null;
    const chosen = settings.get('craftSkins')?.[module.id];
    return module.skins.list.find((skin) => skin.id === chosen) ?? module.skins.list.find((skin) => skin.id === module.skins.default) ?? null;
  }

  /**
   * The craft's meta line: the time in each skin (a craft with two or more), then its own statistics
   * that hold a value, else its role.
   */
  function craftMeta(entry, module, records, statsByCraft) {
    const parts = [];
    const skinTime = records.skinTime?.[entry.id] ?? {};
    if (module && module.skins && module.skins.list.length > 1) {
      for (const skin of module.skins.list) {
        const seconds = Number(skinTime[skin.id]);
        parts.push(`${skin.name} ${seconds > 0 ? durationParts(seconds).join(' ') : 'not flown'}`);
      }
    }
    for (const stat of statsByCraft.get(entry.id) ?? []) {
      const record = records.stats?.[stat.key];
      if (record && !FIGURE_STATS.has(stat.key)) parts.push(`${stat.label} ${formatStat(stat.key, record.value)}`);
    }
    return parts.length > 0 ? parts.join(' · ') : entry.role || '';
  }

  /** Flight time per craft: all 14 by picker group, the share of the most flown craft as a bar. */
  function craftHtml(records) {
    const craftTime = records?.craftTime ?? {};
    const statsByCraft = new Map();
    for (const stat of listJournalStats()) {
      if (!stat.craft) continue;
      if (!statsByCraft.has(stat.craft)) statsByCraft.set(stat.craft, []);
      statsByCraft.get(stat.craft).push(stat);
    }
    const groups = ctx.craftRegistry.groups();
    const catalogCount = ctx.craftRegistry.catalog.length;
    const flown = ctx.craftRegistry.catalog.filter((entry) => Number(craftTime[entry.id]) > 0).length;
    const most = Math.max(1, ...ctx.craftRegistry.catalog.map((entry) => Number(craftTime[entry.id]) || 0));
    const current = state.flight ? state.flight.craft : null;
    const html = ['<div class="dw-group dw-journal-craft" data-journal-section="craft">', sectionHead('Craft · every world', `${flown} / ${catalogCount} flown`, 'craft-flown')];
    for (const group of groups) {
      html.push(`<h4 class="dw-journal-subhead">${escapeHtml(group.label)}</h4><ul class="dw-journal-craft-list">`);
      for (const entry of group.craft) {
        const module = ctx.craftRegistry.get(entry.id);
        const seconds = Number(craftTime[entry.id]) || 0;
        const skin = activeSkinOf(module);
        const silhouette = skin && Array.isArray(skin.silhouette) ? skin.silhouette : entry.silhouette;
        const share = Math.round((seconds / most) * 100);
        const classes = ['dw-journal-craft-entry', seconds > 0 ? '' : 'dw-unflown', entry.id === current ? 'dw-current' : ''].filter(Boolean).join(' ');
        const time = seconds > 0 ? durationParts(seconds) : ['Not flown', ''];
        html.push(`<li class="${classes}" data-craft-entry="${escapeHtml(entry.id)}" style="--dw-share:${share}%"><span class="dw-journal-craft-badge">${silhouetteSvg(silhouette)}</span><span class="dw-find-text"><span class="dw-find-name">${escapeHtml(entry.name)}</span><span class="dw-find-meta">${escapeHtml(craftMeta(entry, module, records ?? {}, statsByCraft))}</span></span><span class="dw-journal-craft-time" data-craft-time="${escapeHtml(entry.id)}">${escapeHtml(time[0])}<small>${escapeHtml(time[1])}</small></span></li>`);
      }
      html.push('</ul>');
    }
    html.push('</div>');
    return html.join('');
  }

  // ---- Figures (every world) -----------------------------------------------------------------------
  /** The aerobatic figures: every figure the recognizer knows, its count and best score (0-100). */
  function figuresHtml(records) {
    const figures = records?.figures ?? {};
    const flown = FIGURES.filter((figure) => figures[figure.id]?.count > 0).length;
    const html = ['<div class="dw-group dw-journal-figures" data-journal-section="figures">', sectionHead('Figures · every world', `${flown} / ${FIGURES.length} flown`, 'figures-flown')];
    if (flown === 0) html.push('<p class="dw-empty">No figure judged yet. Fly the aerobatic plane through a loop, a roll or a hammerhead from straight and level flight, and each figure the judge recognises is scored here.</p>');
    html.push('<ul class="dw-journal-figure-list">');
    for (const figure of FIGURES) {
      const entry = figures[figure.id];
      const count = entry ? Math.max(0, Math.round(Number(entry.count) || 0)) : 0;
      const best = entry && Number.isFinite(entry.bestScore) ? Math.max(0, Math.min(100, entry.bestScore)) : 0;
      const detail = count > 0 ? `${count} flown · best ${Math.round(best)}` : 'Not yet';
      html.push(`<li class="dw-journal-figure${count > 0 ? '' : ' dw-unflown'}" data-figure="${escapeHtml(figure.id)}" style="--dw-score:${best}%"><span class="dw-journal-figure-name">${escapeHtml(figure.name)}</span><span class="dw-journal-figure-detail">${escapeHtml(detail)}</span><i class="dw-journal-figure-bar" role="presentation"></i></li>`);
    }
    html.push('</ul></div>');
    return html.join('');
  }

  // ---- Challenges (every world) -----------------------------------------------------------------------
  /** Best time and medal per course and craft, newest best first; the course key's seed names the world. */
  function challengesHtml(records) {
    const courses = records && records.courses && typeof records.courses === 'object' ? Object.entries(records.courses) : [];
    const rows = [];
    for (const [courseKey, course] of courses) {
      for (const [craft, best] of Object.entries(course?.best ?? {})) {
        if (!best || !Number.isFinite(best.time)) continue;
        rows.push({ courseKey, name: course.name || courseKey, craft, best, seed: courseKey.split(':')[0] });
      }
    }
    rows.sort((a, b) => (b.best.date || 0) - (a.best.date || 0));
    const medals = { gold: 0, silver: 0, bronze: 0 };
    for (const row of rows) if (MEDAL_LABELS[row.best.medal]) medals[row.best.medal]++;
    const total = medals.gold + medals.silver + medals.bronze;
    const html = ['<div class="dw-group dw-challenges" data-journal-section="challenges">', sectionHead('Challenges · every world', rows.length > 0 ? `${total} ${total === 1 ? 'medal' : 'medals'}` : '', 'challenge-medals')];
    if (rows.length === 0) {
      html.push('<p class="dw-empty">No challenge flown yet. Gate courses wait at some sites: fly through the start gate, or press the challenge key near one, and your best time per craft is kept here.</p></div>');
      return html.join('');
    }
    html.push('<div class="dw-medal-tally">');
    for (const medal of Object.keys(MEDAL_LABELS)) {
      html.push(`<span class="dw-medal-count" data-medal-count="${medal}"><span class="dw-challenge-badge dw-medal-${medal}">${MEDAL_LABELS[medal].charAt(0)}</span>${medals[medal]} ${MEDAL_LABELS[medal].toLowerCase()}</span>`);
    }
    html.push('</div><ul class="dw-challenge-list">');
    for (const row of rows.slice(0, MAX_LISTED)) {
      const medal = MEDAL_LABELS[row.best.medal] ? row.best.medal : 'none';
      const meta = [craftNameFor(row.craft), MEDAL_LABELS[medal] ?? 'No medal', row.best.missed > 0 ? `${row.best.missed} missed` : 'clean', row.seed ? `seed ${row.seed}` : '', formatWhen(row.best.date)].filter(Boolean).join(' · ');
      html.push(`<li class="dw-challenge-entry" data-challenge="${escapeHtml(row.courseKey)}" data-craft="${escapeHtml(row.craft)}"><span class="dw-challenge-badge dw-medal-${medal}">${medal === 'none' ? '' : MEDAL_LABELS[medal].charAt(0)}</span><span class="dw-find-text"><span class="dw-find-name">${escapeHtml(row.name)}</span><span class="dw-find-meta">${escapeHtml(meta)}</span></span><span class="dw-challenge-best">${escapeHtml(formatRunTime(row.best.time))}</span></li>`);
    }
    html.push('</ul></div>');
    return html.join('');
  }

  // ---- Worlds (every world) --------------------------------------------------------------------------
  /** The worlds visited through portal rings, newest first: the seed, where from, when, and its link. */
  function worldsHtml(records) {
    const visits = Array.isArray(records?.worldsVisited) ? records.worldsVisited : [];
    const distinct = new Set(visits.map((visit) => visit.seed)).size;
    const html = ['<div class="dw-group dw-journal-worlds" data-journal-section="worlds">', sectionHead('Worlds · through portals', visits.length > 0 ? plural(distinct, ['world', 'worlds']) : '', 'worlds-visited')];
    if (visits.length === 0) {
      html.push('<p class="dw-empty">No portal crossed yet. Portal rings stand in some worlds; fly through the light and you arrive in the world beyond, logged here with its seed.</p></div>');
      return html.join('');
    }
    html.push('<ul class="dw-journal-world-list">');
    for (let index = visits.length - 1; index >= 0 && index >= visits.length - MAX_LISTED; index--) {
      const visit = visits[index];
      const here = visit.seed === state.seed;
      const meta = [`from ${visit.from}`, formatWhen(visit.at)].filter(Boolean).join(' · ');
      const actions = [];
      if (seedLinks) {
        actions.push(`<button type="button" class="dw-text-button" data-world-copy="${escapeHtml(visit.seed)}" aria-label="Copy a link to world ${escapeHtml(visit.seed)}"><svg class="dw-icon"><use href="#dw-i-link"/></svg><span>Copy link</span></button>`);
        if (!here) actions.push(`<button type="button" class="dw-text-button" data-world-open="${escapeHtml(visit.seed)}" aria-label="Fly to world ${escapeHtml(visit.seed)}"><svg class="dw-icon"><use href="#dw-i-globe"/></svg><span>Open</span></button>`);
      }
      if (here) actions.push('<span class="dw-journal-world-here">Here now</span>');
      html.push(`<li class="dw-journal-world${here ? ' dw-current' : ''}" data-world="${escapeHtml(visit.seed)}"><span class="dw-find-text"><span class="dw-journal-world-seed">${escapeHtml(visit.seed)}</span><span class="dw-find-meta">${escapeHtml(meta)}</span></span><span class="dw-journal-world-actions">${actions.join('')}</span></li>`);
    }
    html.push('</ul></div>');
    return html.join('');
  }

  // ---- Clicks: section jumps and the worlds' links ----------------------------------------------------
  function jumpTo(sectionId) {
    const section = body.querySelector(`[data-journal-section="${sectionId}"]`);
    if (!section) return;
    const top = body.scrollTop + section.getBoundingClientRect().top - body.getBoundingClientRect().top - 6;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    section.querySelector('h3')?.focus({ preventScroll: true });
  }

  function resetOpenConfirm() {
    if (!openConfirm) return;
    clearTimeout(openConfirm.timer);
    openConfirm.button.classList.remove('dw-confirm');
    const label = openConfirm.button.querySelector('span');
    if (label) label.textContent = 'Open';
    openConfirm = null;
  }

  /** Open asks once ("Fly there?") and leaves for the world on the second press within OPEN_CONFIRM_MS. */
  function openWorld(button) {
    const seed = button.dataset.worldOpen;
    if (openConfirm && openConfirm.button === button) {
      resetOpenConfirm();
      if (!seedLinks.openWorld(seed)) console.error(`[DRIFTWING] the journal could not open world "${seed}"`);
      return;
    }
    resetOpenConfirm();
    button.classList.add('dw-confirm');
    const label = button.querySelector('span');
    if (label) label.textContent = 'Fly there?';
    openConfirm = { button, timer: setTimeout(resetOpenConfirm, OPEN_CONFIRM_MS) };
  }

  body.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const jump = target.closest('[data-journal-jump]');
    if (jump) {
      jumpTo(jump.dataset.journalJump);
      return;
    }
    const copy = target.closest('[data-world-copy]');
    if (copy && seedLinks) {
      seedLinks.copyWorldLink(copy.dataset.worldCopy).catch((error) => console.error('[DRIFTWING] the journal could not copy a world link', error));
      return;
    }
    const open = target.closest('[data-world-open]');
    if (open && seedLinks) openWorld(open);
  });

  // ---- Render ------------------------------------------------------------------------------------
  function render() {
    resetOpenConfirm();
    seedLabel.textContent = `Seed ${state.seed}`;
    const data = journal()?.getData?.();
    if (!data || typeof data !== 'object') {
      body.innerHTML = '<p class="dw-empty">The journal is not available in this session.</p>';
      liveStats.distance = null;
      return;
    }
    const visited = new Set(Array.isArray(data.biomesVisited) ? data.biomesVisited : []);
    const currentKey = state.player.biome ? state.player.biome.key : null;
    const landmarks = Array.isArray(data.landmarksFound) ? data.landmarksFound : [];
    const ringData = data.ringCourses && typeof data.ringCourses === 'object'
      ? data.ringCourses
      : { completed: 0, bestStreak: data.bestRingStreak, bestTime: data.bestRingTime };
    const totals = totalsParts(data);
    const html = [];
    html.push('<div class="dw-stats">');
    html.push(statCard('Distance flown', totals.distance, 'distance'));
    html.push(statCard('Time aloft', totals.time, 'time'));
    html.push(statCard('Highest point', totals.altitude, 'altitude'));
    html.push(statCard('Discovered', totals.landmarks, 'landmarks'));
    html.push('</div>');
    html.push(jumpsHtml());

    html.push(discoveriesHtml(data));
    html.push(recordsHtml(data.records));
    html.push(achievementsHtml(data.records));
    html.push(craftHtml(data.records));
    html.push(figuresHtml(data.records));
    html.push(challengesHtml(data.challenges));
    html.push(worldsHtml(data.records));

    html.push('<div class="dw-group"><h3 class="dw-micro">Biomes</h3><div class="dw-biomes">');
    for (const biome of world.BIOMES) {
      const here = biome.key === currentKey;
      const seen = here || visited.has(biome.key);
      const swatch = (world.PALETTES_SRGB[biome.index] || []).map((hex) => `<span style="background:${hexToCss(hex)}"></span>`).join('');
      const status = here ? 'Here now' : seen ? 'Visited' : 'Not yet';
      html.push(`<div class="dw-biome${seen ? ' dw-visited' : ''}${here ? ' dw-current' : ''}"><div class="dw-swatch">${swatch}</div><span class="dw-biome-name">${escapeHtml(biome.name)}</span><span class="dw-biome-state">${status}</span></div>`);
    }
    html.push('</div></div>');

    html.push('<div class="dw-group"><h3 class="dw-micro">Landmarks</h3>');
    if (landmarks.length === 0) {
      html.push('<p class="dw-empty">None yet. Stone arches, standing stones, lighthouses and balloon meets are scattered across this world. Ask WREN to find one.</p>');
    } else {
      html.push('<ul class="dw-landmarks">');
      for (let index = landmarks.length - 1; index >= 0 && index >= landmarks.length - MAX_LISTED; index--) {
        const landmark = landmarks[index] || {};
        const type = LANDMARK_TYPE_LABELS[landmark.type] ? landmark.type : 'arch';
        html.push(`<li class="dw-landmark"><span class="dw-landmark-icon"><svg class="dw-icon"><use href="#dw-i-${type}"/></svg></span><span><span class="dw-landmark-name">${escapeHtml(landmark.name || LANDMARK_TYPE_LABELS[type])}</span><br><span class="dw-landmark-meta">${escapeHtml(LANDMARK_TYPE_LABELS[type])} · ${escapeHtml(biomeNameFor(landmark.biome))}</span></span></li>`);
      }
      html.push('</ul>');
    }
    html.push('</div>');

    const completed = Math.max(0, Math.round(Number(ringData.completed) || 0));
    const bestStreak = Math.max(0, Math.round(Number(ringData.bestStreak) || 0));
    const bestTime = Number(ringData.bestTime);
    html.push('<div class="dw-group"><h3 class="dw-micro">Ring courses</h3><div class="dw-ring-bests">');
    html.push(statCard('Flown', [String(completed), ''], 'rings-completed'));
    html.push(statCard('Streak', [String(bestStreak), bestStreak === 1 ? 'ring' : 'rings'], 'rings-streak'));
    html.push(statCard('Best', Number.isFinite(bestTime) && bestTime > 0 ? [formatRunTime(bestTime), ''] : ['None', ''], 'rings-time'));
    html.push('</div></div>');
    html.push(landingsHtml(data.landings));

    body.innerHTML = html.join('');
    liveStats.distance = body.querySelector('[data-stat="distance"]');
    liveStats.time = body.querySelector('[data-stat="time"]');
    liveStats.altitude = body.querySelector('[data-stat="altitude"]');
    liveStats.landmarks = body.querySelector('[data-stat="landmarks"]');
    liveStats.maxAltitude = body.querySelector('[data-stat="record-maxAltitude"]');
    liveStats.craftId = state.flight ? state.flight.craft : null;
    liveStats.craftTime = liveStats.craftId ? body.querySelector(`[data-craft-time="${CSS.escape(liveStats.craftId)}"]`) : null;
    statsTimer = STATS_REFRESH_SECONDS;
  }

  function writeStat(element, parts) {
    if (!element) return;
    const valueNode = element.firstChild;
    const unitNode = element.lastChild;
    if (valueNode && valueNode.nodeType === 3 && valueNode.nodeValue !== parts[0]) valueNode.nodeValue = parts[0];
    if (unitNode && unitNode.textContent !== parts[1]) unitNode.textContent = parts[1];
  }

  /**
   * While open: refreshes the live totals (distance, time aloft, highest point, the highest altitude
   * ever and the current craft's flight time) every 2 s.
   */
  function update(step) {
    statsTimer -= step;
    if (statsTimer > 0 || !liveStats.distance) return;
    statsTimer = STATS_REFRESH_SECONDS;
    const data = journal()?.getData?.();
    if (!data || typeof data !== 'object') return;
    const totals = totalsParts(data);
    writeStat(liveStats.distance, totals.distance);
    writeStat(liveStats.time, totals.time);
    writeStat(liveStats.altitude, totals.altitude);
    writeStat(liveStats.landmarks, totals.landmarks);
    const maxAltitude = data.records?.stats?.maxAltitude;
    if (maxAltitude && liveStats.maxAltitude) {
      liveStats.maxAltitude.parentElement.classList.remove('dw-unset');
      writeStat(liveStats.maxAltitude, statParts('maxAltitude', maxAltitude.value));
    }
    const seconds = liveStats.craftId ? Number(data.records?.craftTime?.[liveStats.craftId]) : 0;
    if (seconds > 0 && liveStats.craftTime) {
      liveStats.craftTime.closest('.dw-journal-craft-entry')?.classList.remove('dw-unflown');
      writeStat(liveStats.craftTime, durationParts(seconds));
    }
  }

  return { render, update };
}
