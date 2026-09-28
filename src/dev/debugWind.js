// Dev debug wind source: proves the Phase 2 wind writer path end to end before spawns exist.
//
// Only created in dev builds (import.meta.env.DEV) or with ?debug=1 (main.js decides); it is never a
// player feature. The L key or the Updraft button in the dev badge's Wind row drops a debug updraft
// (WindField createDebugUpdraft: a rising column with a gentle swirl) PLACE_AHEAD metres ahead of the
// craft at its altitude through wind.addSource; the next press removes it with wind.removeSource.
// The toasts come from the typed windSourceAdded / windSourceRemoved events, so each one confirms
// that the event fired. The wind arrows show the column, and flight through it climbs because the
// flight models fly through WindField.sample.
import { createDebugUpdraft } from '../env/WindField.js';
import { badgeWindRow, createBadgeButton } from './windOverlay.js';

const SOURCE_ID = 'debug-updraft';
const SOURCE_KIND = 'debug-updraft';
const PLACE_AHEAD = 450;
const RADIUS = 220;
const STRENGTH = 6;
const TOGGLE_KEY = 'KeyL';
const LABEL_HZ = 4;

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function createDebugWindSystem(ctx) {
  const { bus, state } = ctx;
  let active = null;
  let labelTimer = 0;

  function headingVector(target) {
    const forward = state.player.forward;
    const length = Math.hypot(forward.x, forward.z);
    if (length > 1e-3) {
      target.x = forward.x / length;
      target.z = forward.z / length;
    } else {
      target.x = 0;
      target.z = -1;
    }
    return target;
  }

  function place() {
    const wind = ctx.wind;
    if (!wind || typeof wind.addSource !== 'function') {
      bus.emit('notify', { text: 'No wind field to add a debug updraft to.', kind: 'warning' });
      return false;
    }
    const player = state.player.position;
    const ahead = headingVector({ x: 0, z: 0 });
    const center = { x: player.x + ahead.x * PLACE_AHEAD, y: player.y, z: player.z + ahead.z * PLACE_AHEAD };
    try {
      wind.addSource(createDebugUpdraft({ id: SOURCE_ID, center, radius: RADIUS, strength: STRENGTH }));
    } catch (error) {
      console.error('[DRIFTWING] debug updraft could not be added', error);
      bus.emit('notify', { text: 'The debug updraft could not be added.', kind: 'warning' });
      return false;
    }
    active = { center, radius: RADIUS, strength: STRENGTH };
    return true;
  }

  function remove() {
    const removed = ctx.wind && typeof ctx.wind.removeSource === 'function' ? ctx.wind.removeSource(SOURCE_ID) : false;
    active = null;
    return removed;
  }

  /** Drops the updraft ahead of the craft, or removes it when it is already there. Returns whether it is active now. */
  function toggle() {
    if (active) {
      remove();
      return false;
    }
    return place();
  }

  bus.onTyped('windSourceAdded', (payload) => {
    if (payload.kind !== SOURCE_KIND) return;
    bus.emit('notify', { text: `Debug updraft ${PLACE_AHEAD} m ahead: ${STRENGTH} m/s rising column, ${RADIUS} m radius. L removes it.` });
  });
  bus.onTyped('windSourceRemoved', (payload) => {
    if (payload.kind !== SOURCE_KIND) return;
    active = null;
    bus.emit('notify', { text: 'Debug updraft removed.' });
  });

  window.addEventListener('keydown', (event) => {
    if (event.code !== TOGGLE_KEY || event.repeat || event.defaultPrevented) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (state.photoMode || isEditableTarget(event.target)) return;
    toggle();
  });

  const button = (() => {
    const row = badgeWindRow();
    if (!row) return null;
    return createBadgeButton(row, 'Updraft', `Debug updraft ahead of the craft (key L): proves the wind source path`, toggle);
  })();

  function distanceToSource() {
    if (!active) return null;
    const player = state.player.position;
    return Math.hypot(player.x - active.center.x, player.z - active.center.z);
  }

  return {
    /** Keeps the badge button's pressed state and the distance to the updraft current. */
    update(simDt, realDt) {
      if (!button) return;
      labelTimer -= realDt;
      if (labelTimer > 0) return;
      labelTimer = 1 / LABEL_HZ;
      button.setPressed(Boolean(active));
      const distance = distanceToSource();
      button.setText(distance === null ? 'Updraft' : `Updraft ${Math.round(distance)} m`);
    },
    toggle,
    getStatus() {
      return {
        active: Boolean(active),
        id: SOURCE_ID,
        center: active ? { ...active.center } : null,
        radius: active ? active.radius : 0,
        strength: active ? active.strength : 0,
        distance: distanceToSource(),
      };
    },
  };
}
