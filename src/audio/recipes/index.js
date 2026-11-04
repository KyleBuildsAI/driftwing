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
import { goose, raptor } from './birdCall.js';
import calving from './calving.js';
import crystal from './crystal.js';
import discovery from './discovery.js';
import dolphin from './dolphin.js';
import gale from './gale.js';
import geyser from './geyser.js';
import herd from './herd.js';
import lantern from './lantern.js';
import meteor from './meteor.js';
import murmuration from './murmuration.js';
import surf from './surf.js';
import thunder from './thunder.js';
import tornado from './tornado.js';
import turbine from './turbine.js';
import volcano from './volcano.js';
import waterfall from './waterfall.js';
import { skyWhale, whale } from './whale.js';
// Presets 51-60.
import caribou from './caribou.js';
import bells from './bells.js';
import observatory from './observatory.js';
import train from './train.js';
import dam from './dam.js';
import caravan from './caravan.js';
import fireball from './fireball.js';
// Phase 3 presets 61-70.
import skyShimmer from './skyShimmer.js';
import canopy from './canopy.js';
import portal from './portal.js';
import giant from './giant.js';
import galleon from './galleon.js';
import dragon from './dragon.js';

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
  // Phase 3 presets, in spec order.
  gale,
  surf,
  herd,
  calving,
  dolphin,
  // Presets 51-60.
  caribou,
  bells,
  observatory,
  train,
  dam,
  caravan,
  fireball,
  // Phase 3 presets 61-70.
  skyShimmer,
  canopy,
  portal,
  giant,
  galleon,
  dragon,
});

/**
 * Every recipe name, in the contract's order, then the later additions (raptor and goose, for the
 * wildlife presets) and the Phase 3 recipes in Milestone G's order; a preset's audio.recipe must be
 * one of these.
 */
export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
