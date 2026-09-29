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
import crystal from './crystal.js';
import discovery from './discovery.js';
import geyser from './geyser.js';
import lantern from './lantern.js';
import meteor from './meteor.js';
import murmuration from './murmuration.js';
import thunder from './thunder.js';
import tornado from './tornado.js';
import turbine from './turbine.js';
import volcano from './volcano.js';
import waterfall from './waterfall.js';
import { skyWhale, whale } from './whale.js';

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
});

/** Every recipe name, in the contract's order (presets' audio.recipe must be one of these). */
export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));
