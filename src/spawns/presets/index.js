// The spawn preset registry: every preset in spec order (docs/specs/phase2-contract.md, section 1).
//
// Presets are PURE DATA (default-exported frozen objects importing nothing but other pure data), so
// the terrain worker imports this list too: worldgen places the site presets' sites and applies their
// terrain stamps in both threads from the same data, with no messaging. To add a preset, add its
// file here in this directory, import it below and append it to PRESETS.
import whalePod from './whalePod.js';

export const PRESETS = Object.freeze([
  // Batch 2: presets 11-20.
  whalePod,
]);

/** Presets by id. */
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])));
