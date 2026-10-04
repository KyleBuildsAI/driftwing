// The journal panel's body (J, the 'journal' action): this world's totals, its spawn discoveries
// with the collection count (x / N over the implemented presets), the global records (storms chased,
// closest tornado, best canyon run, best landing and any other statistic a preset sends), the
// achievements, the biomes, the Phase 1 landmarks, ring courses and this world's landings. Everything
// is read from the journal system (src/gameplay/journal.js); the panel shell and its opening belong
// to ui.js.
import './journalPanel.css';
import { JOURNAL_STATS } from '../gameplay/journal.js';
import { discoveryIcon, discoveryIconSvg } from './categoryIcons.js';
import { distanceParts, formatClock, formatCoordinates, formatRunTime, formatWhen, statLabel, statParts } from './journalFormat.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const LANDMARK_TYPE_LABELS = { arch: 'Stone arch', monoliths: 'Standing stones', lighthouse: 'Lighthouse', balloons: 'Balloon meet' };
const LANDING_GRADE_LABELS = { butter: 'Butter', smooth: 'Smooth', firm: 'Firm', hard: 'Hard' };
/** Newest entries listed per section; the journal keeps them all. */
const MAX_LISTED = 60;
/** Seconds between refreshes of the live totals while the panel is open. */
const STATS_REFRESH_SECONDS = 2;

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
function durationParts(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  if (safe < 60) return [String(Math.floor(safe)), 's'];
  if (safe < 3600) return [String(Math.floor(safe / 60)), 'min'];
  const hours = Math.floor(safe / 3600);
  return [`${hours}:${String(Math.floor((safe - hours * 3600) / 60)).padStart(2, '0')}`, 'h'];
}
function statCard(label, parts, statKey, extraClass = '') {
  return `<div class="dw-stat${extraClass}"><span class="dw-micro">${escapeHtml(label)}</span><span class="dw-stat-value" data-stat="${statKey}">${escapeHtml(parts[0])}<small>${escapeHtml(parts[1])}</small></span></div>`;
}

/**
 * Creates the journal panel renderer. body and seedLabel are the panel's elements; ctx supplies
 * state, world, settings, craftRegistry and systems.journal. Returns { render(), update(step) }.
 */
export function createJournalPanel({ body, seedLabel, ctx }) {
  const { state, world, settings } = ctx;
  const liveStats = { distance: null, time: null, altitude: null, landmarks: null };
  let statsTimer = 0;

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
      altitude: [String(Math.round(Math.max(0, Number(data.maxAltitude) || 0))), 'm'],
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

  // ---- Spawn discoveries (this world) -------------------------------------------------------------
  function discoveriesHtml(data) {
    const entries = Array.isArray(data.spawnsFound) ? data.spawnsFound : [];
    const found = Number(data.collection?.found) || 0;
    const total = Number(data.collection?.total) || 0;
    const html = ['<div class="dw-group dw-discoveries">'];
    html.push(`<div class="dw-group-head"><h3 class="dw-micro">Discoveries</h3>${total > 0 ? `<span class="dw-collection" data-stat="collection">${found} / ${total}</span>` : ''}</div>`);
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
  function recordsHtml(records) {
    const stats = records?.stats ?? {};
    const html = ['<div class="dw-group"><h3 class="dw-micro">Records · every world</h3><div class="dw-records">'];
    for (const key of Object.keys(JOURNAL_STATS)) {
      const stat = stats[key];
      html.push(statCard(statLabel(key), stat ? statParts(key, stat.value) : ['None', ''], `record-${key}`, stat ? '' : ' dw-unset'));
    }
    const bestLanding = records?.bestLanding;
    html.push(statCard('Best landing', bestLanding && LANDING_GRADE_LABELS[bestLanding.grade] ? [LANDING_GRADE_LABELS[bestLanding.grade], formatSinkRate(bestLanding.sinkRate).split(' (')[0]] : ['None', ''], 'record-bestLanding', bestLanding ? '' : ' dw-unset'));
    for (const [key, stat] of Object.entries(stats)) {
      if (JOURNAL_STATS[key]) continue;
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

  // ---- Render ------------------------------------------------------------------------------------
  function render() {
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

    html.push(discoveriesHtml(data));
    html.push(recordsHtml(data.records));
    html.push(achievementsHtml(data.records));

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
    statsTimer = STATS_REFRESH_SECONDS;
  }

  function writeStat(element, parts) {
    if (!element) return;
    const valueNode = element.firstChild;
    const unitNode = element.lastChild;
    if (valueNode && valueNode.nodeType === 3 && valueNode.nodeValue !== parts[0]) valueNode.nodeValue = parts[0];
    if (unitNode && unitNode.textContent !== parts[1]) unitNode.textContent = parts[1];
  }

  /** While open: refreshes the live totals (distance, time aloft, highest point) every 2 s. */
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
  }

  return { render, update };
}
