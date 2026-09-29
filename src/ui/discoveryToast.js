// Discovery toast: the glass card that announces a new spawn discovery (name, category, the preset's
// one-liner and the collection count) and a new achievement. The chime is the audio system's (it plays
// on the typed 'discovery' event); this card follows the journal's 'journal:discovery' and
// 'journal:achievement' announcements, so it only ever shows what the journal really recorded.
// Improved records ('journal:record') get a short toast of their own.
//
// Cards queue and show one at a time. In photo mode (and on touch screens while a panel is open) the
// card is hidden and its clock stops, so it comes back afterwards. Clicking a card opens the journal.
import './discoveryToast.css';
import { JOURNAL_STATS } from '../gameplay/journal.js';
import { discoveryIcon, discoveryIconSvg } from './categoryIcons.js';
import { formatStat, statLabel } from './journalFormat.js';

/** Seconds a card stays up, and its exit animation. */
const SHOW_SECONDS = 6.5;
const LEAVE_SECONDS = 0.5;
/** Cards waiting beyond this many are dropped (the journal keeps them all). */
const MAX_QUEUE = 4;

/**
 * Creates the discovery toast in root. bus: the event bus; toast(text, options): the UI's pill toast
 * (for records); onActivate(): called when the player clicks a card (the UI opens the journal).
 * Returns { element, update(step, photoActive), isShowing(), getCurrent() }.
 */
export function createDiscoveryToast({ root, bus, toast, onActivate }) {
  const element = document.createElement('div');
  element.className = 'dw-discovery glass';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.dataset.state = 'idle';
  element.innerHTML = [
    '<div class="dw-discovery-badge"></div>',
    '<div class="dw-discovery-body">',
    '<span class="dw-discovery-label"></span>',
    '<span class="dw-discovery-title"></span>',
    '<span class="dw-discovery-text"></span>',
    '<span class="dw-discovery-count"><span class="dw-discovery-bar"><i></i></span><span class="dw-discovery-count-text"></span></span>',
    '</div>',
  ].join('');
  root.append(element);
  const parts = {
    badge: element.querySelector('.dw-discovery-badge'),
    label: element.querySelector('.dw-discovery-label'),
    title: element.querySelector('.dw-discovery-title'),
    text: element.querySelector('.dw-discovery-text'),
    count: element.querySelector('.dw-discovery-count'),
    bar: element.querySelector('.dw-discovery-bar i'),
    countText: element.querySelector('.dw-discovery-count-text'),
  };

  const queue = [];
  let current = null;
  let phase = 'idle';
  let phaseTime = 0;

  function enqueue(card) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(card);
  }

  function fill(card) {
    const icon = discoveryIcon(card.icon);
    element.style.setProperty('--dw-discovery-color', icon.color);
    element.dataset.kind = card.kind;
    parts.badge.innerHTML = discoveryIconSvg(card.icon, 'dw-icon');
    parts.label.textContent = card.label;
    parts.title.textContent = card.title;
    parts.text.textContent = card.text;
    parts.text.hidden = !card.text;
    const showCount = card.total > 0;
    parts.count.hidden = !showCount;
    if (showCount) {
      parts.bar.style.width = `${Math.round((card.found / card.total) * 100)}%`;
      parts.countText.textContent = `${card.found} / ${card.total} discovered`;
    }
  }

  function show(card) {
    current = card;
    fill(card);
    phase = 'shown';
    phaseTime = 0;
    element.dataset.state = 'shown';
  }

  function leave() {
    phase = 'leaving';
    phaseTime = 0;
    element.dataset.state = 'leaving';
  }

  function finish() {
    phase = 'idle';
    current = null;
    element.dataset.state = 'idle';
  }

  bus.on('journal:discovery', (payload) => {
    const entry = payload && payload.entry;
    if (!entry) return;
    const icon = discoveryIcon(entry.category);
    enqueue({
      kind: 'discovery',
      icon: entry.category,
      label: `Discovered · ${icon.label}`,
      title: entry.name,
      text: entry.description,
      found: Number(payload.found) || 0,
      total: Number(payload.total) || 0,
      id: entry.id,
    });
  });
  bus.on('journal:achievement', (payload) => {
    const entry = payload && payload.entry;
    if (!entry) return;
    enqueue({ kind: 'achievement', icon: 'achievement', label: 'Achievement', title: entry.title, text: 'Kept in your journal, in every world.', found: 0, total: 0, id: entry.id });
  });
  bus.on('journal:record', (payload) => {
    if (!payload || !payload.improved) return;
    const known = JOURNAL_STATS[payload.key];
    if (known && known.op === 'add') {
      toast(`${statLabel(payload.key)}: ${formatStat(payload.key, payload.value)}`, { kind: 'success', key: `record-${payload.key}` });
    } else if (payload.op !== 'add') {
      toast(`New record · ${statLabel(payload.key)}: ${formatStat(payload.key, payload.value)}`, { kind: 'success', key: `record-${payload.key}` });
    }
  });
  element.addEventListener('click', () => {
    if (phase === 'shown' && typeof onActivate === 'function') onActivate(current);
  });

  return {
    element,
    /** Advances the card clock (seconds of wall time); held (photo mode, a touch panel) stops it. */
    update(step, held) {
      if (held) return;
      if (phase === 'idle') {
        if (queue.length > 0) show(queue.shift());
        return;
      }
      phaseTime += step;
      if (phase === 'shown' && phaseTime >= SHOW_SECONDS) leave();
      else if (phase === 'leaving' && phaseTime >= LEAVE_SECONDS) finish();
    },
    isShowing() {
      return phase === 'shown';
    },
    /** The card on screen ({ kind, title, text, found, total, id }) or null. */
    getCurrent() {
      return current ? { ...current } : null;
    },
  };
}
