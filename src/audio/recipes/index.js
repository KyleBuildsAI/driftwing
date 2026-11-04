// The spawn sound recipes by name (audio.spawnVoice(name, params)). Each recipe module default-
// exports a frozen definition:
//   { name, summary, spatial, level, floor, triggers, strikes?, build(kit, params) }
// spatial: { distanceModel, refDistance, rolloffFactor, panningModel, size, reverb } (see
//   spawnVoices.js; a preset's audio.params may override refDistance, rolloffFactor, size, reverb).
// level: the approximate RMS at refDistance with intensity 1 (the voice budget ranks voices by it).
// floor: the fraction of level still sounding at intensity 0.
// triggers: the trigger names the recipe answers.
// build(kit, params) returns { setIntensity(value, time, immediate), trigger(name, options, time),
//   update?(time, interval), describe() }.
import bells from './bells.js';
import { goose, raptor } from './birdCall.js';
import burner from './burner.js';
import calving from './calving.js';
import canopy from './canopy.js';
import caravan from './caravan.js';
import caribou from './caribou.js';
import crystal from './crystal.js';
import dam from './dam.js';
import discovery from './discovery.js';
import dolphin from './dolphin.js';
import dragon from './dragon.js';
import fireball from './fireball.js';
import gale from './gale.js';
import galleon from './galleon.js';
import geyser from './geyser.js';
import giant from './giant.js';
import herd from './herd.js';
import lantern from './lantern.js';
import meteor from './meteor.js';
import murmuration from './murmuration.js';
import observatory from './observatory.js';
import portal from './portal.js';
import skyShimmer from './skyShimmer.js';
import surf from './surf.js';
import thunder from './thunder.js';
import tornado from './tornado.js';
import train from './train.js';
import turbine from './turbine.js';
import volcano from './volcano.js';
import waterfall from './waterfall.js';
import { skyWhale, whale } from './whale.js';
import windRush from './windRush.js';
import wisps from './wisps.js';

export const RECIPES = Object.freeze({
  tornado,
  thunder,
  volcano,
  geyser,
  waterfall,
  whale,
  skyWhale,
  crystal,
  turbine,
  murmuration,
  meteor,
  lantern,
  discovery,
  raptor,
  goose,
  // Phase 3 presets 31-100, in spec order.
  gale,
  surf,
  herd,
  calving,
  dolphin,
  caribou,
  bells,
  observatory,
  train,
  dam,
  caravan,
  fireball,
  skyShimmer,
  canopy,
  portal,
  giant,
  galleon,
  dragon,
  wisps,
  windRush,
  burner,
});

/**
 * Every recipe name, in the contract's order, then the later additions (raptor and goose, for the
 * wildlife presets) and the Phase 3 preset recipes in spec order; a preset's audio.recipe must be one
 * of these.
 */
export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
