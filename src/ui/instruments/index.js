// Instrument registry and the shared instrument set.
//
// Every instrument id a craft may list in craft.instruments has a renderer here. A renderer is
// { id, label, draw(g, source, theme, memory), createMemory?(), update?(memory, dt, source),
// reset?(memory) } and draws in a 200 x 200 design box (see gaugeKit.js). The instrument set owns
// the per-instrument memory (G tell-tales, vario averager, glide averages, terrain look-ahead) so
// the cockpit panel and the HUD overlay show the same state, and builds the `source` every
// renderer reads: { flight (state.flight), craft (module), mode, units, controls, world, waterLevel }.
import { CONFIG } from '../../core/config.js';
import { THEMES, DESIGN_SIZE } from './gaugeKit.js';
import { unitsFor } from './units.js';
import airspeed from './airspeed.js';
import altitude from './altitude.js';
import attitude from './attitude.js';
import heading from './heading.js';
import vsi from './vsi.js';
import aoa from './aoa.js';
import gMeter from './gMeter.js';
import throttle from './throttle.js';
import flapsGear from './flapsGear.js';
import rotorRpm from './rotorRpm.js';
import torque from './torque.js';
import radarAlt from './radarAlt.js';
import vario from './vario.js';
import ld from './ld.js';
import droneMode from './droneMode.js';
import glide from './glide.js';
import proximity from './proximity.js';

export const INSTRUMENTS = Object.freeze(Object.fromEntries(
  [airspeed, altitude, attitude, heading, vsi, aoa, gMeter, throttle, flapsGear, rotorRpm, torque, radarAlt, vario, ld, droneMode, glide, proximity]
    .map((instrument) => [instrument.id, instrument]),
));
export const INSTRUMENT_IDS = Object.freeze(Object.keys(INSTRUMENTS));

/** The craft's instrument ids that have a renderer, in the craft's order. */
export function knownInstruments(craft) {
  const list = craft && Array.isArray(craft.instruments) ? craft.instruments : [];
  return list.filter((id) => Object.prototype.hasOwnProperty.call(INSTRUMENTS, id));
}

export function createInstrumentSet(ctx) {
  const { state, settings, world } = ctx;
  const memories = new Map();
  for (const instrument of Object.values(INSTRUMENTS)) {
    if (typeof instrument.createMemory === 'function') memories.set(instrument.id, instrument.createMemory());
  }
  const source = {
    flight: state.flight,
    craft: null,
    mode: 'classic',
    units: unitsFor(settings.get('units')),
    controls: ctx.controls,
    world,
    waterLevel: CONFIG.WATER_LEVEL,
  };
  let activeIds = [];
  let unknownIds = [];
  let activeCraft = null;

  function refreshSource() {
    const flightSystem = ctx.systems.flight;
    const craft = flightSystem && typeof flightSystem.getCraftModule === 'function' ? flightSystem.getCraftModule() : null;
    source.flight = state.flight;
    source.mode = state.flight.mode === 'sim' ? 'sim' : 'classic';
    source.units = unitsFor(settings.get('units'));
    if (craft !== activeCraft) {
      activeCraft = craft;
      source.craft = craft;
      activeIds = knownInstruments(craft);
      unknownIds = craft && Array.isArray(craft.instruments) ? craft.instruments.filter((id) => !activeIds.includes(id)) : [];
      resetMemories();
    }
  }

  function resetMemories() {
    for (const [id, memory] of memories) INSTRUMENTS[id].reset?.(memory);
  }

  return {
    source,

    /** The active craft's instrument ids (known renderers only, craft order). */
    get ids() {
      return activeIds;
    },

    /** Ids the craft lists that have no renderer (reported in the camera stats). */
    get unknownIds() {
      return unknownIds;
    },

    get craft() {
      return activeCraft;
    },

    /** Reads the active craft and units, then advances every active instrument's memory by dt. */
    update(dt) {
      refreshSource();
      if (!activeCraft) return;
      for (const id of activeIds) {
        const instrument = INSTRUMENTS[id];
        if (typeof instrument.update === 'function') instrument.update(memories.get(id), dt, source);
      }
    },

    /** Clears tell-tales and averages (craft change, soft crash, relaunch). */
    reset: resetMemories,

    /**
     * Draws one instrument into g at (x, y) with the given size in canvas pixels, in the 'panel' or
     * 'glass' theme.
     */
    draw(id, g, x, y, size, themeId) {
      const instrument = INSTRUMENTS[id];
      if (!instrument || !activeCraft) return;
      g.save();
      g.translate(x, y);
      g.scale(size / DESIGN_SIZE, size / DESIGN_SIZE);
      instrument.draw(g, source, THEMES[themeId] || THEMES.panel, memories.get(id));
      g.restore();
    },
  };
}
