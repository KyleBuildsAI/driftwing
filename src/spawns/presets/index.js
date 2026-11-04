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
import sandstormWall from './sandstormWall.js';
import snowSquall from './snowSquall.js';
import hurricaneEye from './hurricaneEye.js';
import valleyFogRiver from './valleyFogRiver.js';
import dirtyThunderstorm from './dirtyThunderstorm.js';
import lavaRiversToSea from './lavaRiversToSea.js';
import fissureEruption from './fissureEruption.js';
import meteorCraterLake from './meteorCraterLake.js';
import hotSpringTerraces from './hotSpringTerraces.js';
import saltFlatMirror from './saltFlatMirror.js';
import calvingGlacier from './calvingGlacier.js';
import coralAtoll from './coralAtoll.js';
import reefShipwreck from './reefShipwreck.js';
import dolphinPod from './dolphinPod.js';
import seaStacks from './seaStacks.js';
import rogueWave from './rogueWave.js';
import tidalBore from './tidalBore.js';
import batsAtDusk from './batsAtDusk.js';
import herdStampede from './herdStampede.js';
import flamingoLake from './flamingoLake.js';
// Batch 6: presets 51-60.
import butterflyMigration from './butterflyMigration.js';
import caribouMigration from './caribouMigration.js';
import cliffsideMonastery from './cliffsideMonastery.js';
import seaCliffCastle from './seaCliffCastle.js';
import mountaintopObservatory from './mountaintopObservatory.js';
import steamTrainViaduct from './steamTrainViaduct.js';
import damSpillway from './damSpillway.js';
import desertOasisCaravan from './desertOasisCaravan.js';
import labyrinth from './labyrinth.js';
import fireballImpact from './fireballImpact.js';
// Batch 7: presets 61-70.
import bloodMoon from './bloodMoon.js';
import greenFlash from './greenFlash.js';
import noctilucentClouds from './noctilucentClouds.js';
import milkyWayCore from './milkyWayCore.js';
import moonbow from './moonbow.js';
import worldTree from './worldTree.js';
import portalRing from './portalRing.js';
import sleepingGiant from './sleepingGiant.js';
import ghostGalleon from './ghostGalleon.js';
import dragonRacer from './dragonRacer.js';

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
  // Batch 4: presets 31-40.
  sandstormWall,
  snowSquall,
  hurricaneEye,
  valleyFogRiver,
  dirtyThunderstorm,
  lavaRiversToSea,
  fissureEruption,
  meteorCraterLake,
  hotSpringTerraces,
  saltFlatMirror,
  // Batch 5: presets 41-50.
  calvingGlacier,
  coralAtoll,
  reefShipwreck,
  dolphinPod,
  seaStacks,
  rogueWave,
  tidalBore,
  batsAtDusk,
  herdStampede,
  flamingoLake,
  // Batch 6: presets 51-60.
  butterflyMigration,
  caribouMigration,
  cliffsideMonastery,
  seaCliffCastle,
  mountaintopObservatory,
  steamTrainViaduct,
  damSpillway,
  desertOasisCaravan,
  labyrinth,
  fireballImpact,
  // Batch 7: presets 61-70.
  bloodMoon,
  greenFlash,
  noctilucentClouds,
  milkyWayCore,
  moonbow,
  worldTree,
  portalRing,
  sleepingGiant,
  ghostGalleon,
  dragonRacer,
]);

/** Presets by id. */
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])));
