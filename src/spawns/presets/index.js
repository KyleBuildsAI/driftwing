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
import whalePod from './whalePod.js';
import maelstrom from './maelstrom.js';
import bioluminescentBay from './bioluminescentBay.js';
import starlingMurmuration from './starlingMurmuration.js';
import geeseFormation from './geeseFormation.js';
import thermalHawks from './thermalHawks.js';
import fireflies from './fireflies.js';
import eagleWingman from './eagleWingman.js';
import windFarm from './windFarm.js';
import ropeBridge from './ropeBridge.js';
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
  // Batch 1: presets 1-10.
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
  // Batch 2: presets 11-20.
  whalePod,
  maelstrom,
  bioluminescentBay,
  starlingMurmuration,
  geeseFormation,
  thermalHawks,
  fireflies,
  eagleWingman,
  windFarm,
  ropeBridge,
  // Batch 3: presets 21-30.
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
