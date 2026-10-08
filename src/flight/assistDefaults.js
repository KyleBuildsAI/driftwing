// Assist defaults: the assists slider (0-100 % per craft, settings.assists) is the only difficulty
// control. It starts at 100 % for keyboard and mouse. The first time a HOTAS device connects
// (typed deviceConnected with a hotas-* kind), every craft whose assists the player never set drops
// to 50 % and a toast says so; settings.hotasAssistsApplied remembers that it happened, so it never
// repeats. After that the player's own choice always wins.
//
// settings.assistsSetByPlayer records, per craft, that the player chose the assists: any change to
// settings.assists this module did not make itself (the settings slider, WREN, a dev tool) marks
// the craft it changed.
import { CRAFT_IDS, HOTAS_ASSIST_LEVEL } from '../core/settings.js';
import { HOTAS_KINDS } from '../input/hotas/devices.js';

/** Assists for craft the player has not set, once a HOTAS has been seen (settings v6 applies it to new craft). */
export { HOTAS_ASSIST_LEVEL };
export const HOTAS_ASSIST_TOAST = 'HOTAS detected - assists set to 50%. Change them in Settings.';

export function createAssistDefaults(ctx) {
  const { bus, settings } = ctx;
  let applying = false;
  let knownAssists = settings.get('assists');

  /** Marks every craft whose assists changed from outside this module as set by the player. */
  function noteAssistChange(next) {
    const previous = knownAssists;
    knownAssists = { ...next };
    if (applying) return;
    const changed = CRAFT_IDS.filter((id) => next[id] !== previous[id]);
    const setByPlayer = settings.get('assistsSetByPlayer');
    const patch = Object.fromEntries(changed.filter((id) => setByPlayer[id] !== true).map((id) => [id, true]));
    if (Object.keys(patch).length > 0) settings.update('assistsSetByPlayer', patch);
  }

  /** The one-time HOTAS default. Returns the craft whose assists it changed. */
  function applyHotasDefault() {
    if (settings.get('hotasAssistsApplied') === true) return [];
    const setByPlayer = settings.get('assistsSetByPlayer');
    const assists = settings.get('assists');
    const patch = {};
    for (const id of CRAFT_IDS) {
      if (setByPlayer[id] !== true && assists[id] !== HOTAS_ASSIST_LEVEL) patch[id] = HOTAS_ASSIST_LEVEL;
    }
    applying = true;
    try {
      if (Object.keys(patch).length > 0) settings.update('assists', patch);
      settings.set('hotasAssistsApplied', true);
    } finally {
      applying = false;
    }
    const changed = Object.keys(patch);
    if (changed.length > 0) bus.emit('notify', { text: HOTAS_ASSIST_TOAST, kind: 'info' });
    return changed;
  }

  bus.on('settings:changed', ({ key, value }) => {
    if (key === 'assists' && value) noteAssistChange(value);
  });
  bus.onTyped('deviceConnected', (device) => {
    if (device && HOTAS_KINDS.includes(device.kind)) applyHotasDefault();
  });

  return {
    applyHotasDefault,
    getStats() {
      return {
        hotasAssistsApplied: settings.get('hotasAssistsApplied'),
        assists: settings.get('assists'),
        assistsSetByPlayer: settings.get('assistsSetByPlayer'),
      };
    },
  };
}
