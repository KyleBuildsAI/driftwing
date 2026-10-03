// The spawn preset registry: every preset in spec order (docs/specs/phase2-contract.md, section 1).
//
// Presets are PURE DATA (default-exported frozen objects importing nothing but other pure data), so
// the terrain worker imports this list too: worldgen places the site presets' sites and applies their
// terrain stamps in both threads from the same data, with no messaging. To add a preset, add its
// file here in this directory, import it below and append it to PRESETS.
import abandonedAirfield from './abandonedAirfield.js';
import meteorShower from './meteorShower.js';
import totalSolarEclipse from './totalSolarEclipse.js';
import comet from './comet.js';
import skyLanternFestival from './skyLanternFestival.js';
import floatingIslands from './floatingIslands.js';
import skyWhale from './skyWhale.js';
import crystalSpires from './crystalSpires.js';
import jetStream from './jetStream.js';
import stormChase from './stormChase.js';

export const PRESETS = Object.freeze([
  // 21-30: structures, night and celestial, fantasy, flight-play and the legendary set piece.
  abandonedAirfield,
  meteorShower,
  totalSolarEclipse,
  comet,
  skyLanternFestival,
  floatingIslands,
  skyWhale,
  crystalSpires,
  jetStream,
  stormChase,
]);

/** Presets by id. */
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])));
