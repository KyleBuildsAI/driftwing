// The spawn preset registry: every preset in spec order (docs/specs/phase2-contract.md, section 1).
//
// Presets are PURE DATA (default-exported frozen objects importing nothing but other pure data), so
// the terrain worker imports this list too: worldgen places the site presets' sites and applies their
// terrain stamps in both threads from the same data, with no messaging. To add a preset, add its
// file here in this directory, import it below and append it to PRESETS.
import tornado from './tornado.js';
import supercell from './supercell.js';
import waterspout from './waterspout.js';
import lenticular from './lenticular.js';
import microburst from './microburst.js';
import glory from './glory.js';
import volcano from './volcano.js';
import geyserField from './geyserField.js';
import slotCanyon from './slotCanyon.js';
import megaWaterfall from './megaWaterfall.js';

export const PRESETS = Object.freeze([
  tornado,
  supercell,
  waterspout,
  lenticular,
  microburst,
  glory,
  volcano,
  geyserField,
  slotCanyon,
  megaWaterfall,
]);

/** Presets by id. */
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])));
