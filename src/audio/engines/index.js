// Engine families and the audioProfile parameters each one reads.
//
// A craft's audioProfile is { engine: family, ...parameters }. resolveAudioProfile() fills every
// parameter the craft leaves out from its family's defaults, so a profile can be as small as
// { engine: 'jet' }. Unknown families fall back to 'glider' (v1's sound).
//
// Parameters every family understands:
//   airflowSpeed         m/s   SIM airspeed at which the airflow beds reach full rush
//   classicAirflowSpeed  m/s   the same for CLASSIC (v1: the arcade top speed, 135)
//   interiorCutoff       Hz    cockpit-view low-pass for a closed cockpit; 0 or null = open (no filter)
//   spatial              bool  false keeps the engine centred and unpositioned in external views
//   stallHorn            bool  sound the stall horn on state.flight.stall.warning (SIM)
//   stallAoa             deg   AoA where buffet peaks when the model reports no stall.buffet; null = off
//   touchdown            'wheels' (thump and tire chirp) | 'skids' (thump and scrape) | 'body' (soft thump)
//   callouts             bool  radar-altitude landing callouts apply to this craft
//   vario                bool  variometer audio; defaults to instruments including 'vario'
//   varioSink            m/s   vario sink tone below this (negative) climb rate
//   level                0..2  overall engine loudness trim
import { CONFIG } from '../../core/config.js';
import { createDroneSynth } from './drone.js';
import { createGliderSynth } from './glider.js';
import { createHeliSynth } from './heli.js';
import { createJetSynth } from './jet.js';
import { createPropSynth } from './prop.js';
import { createWingsuitSynth } from './wingsuit.js';

const COMMON_DEFAULTS = Object.freeze({
  airflowSpeed: 60,
  classicAirflowSpeed: CONFIG.SPEED.MAX,
  interiorCutoff: 1000,
  spatial: true,
  stallHorn: false,
  stallAoa: null,
  touchdown: 'wheels',
  callouts: true,
  vario: null,
  varioSink: -2,
  level: 1,
});

export const ENGINE_FAMILIES = Object.freeze({
  glider: {
    create: createGliderSynth,
    defaults: { spatial: false, airflowSpeed: 55, interiorCutoff: 1500, stallHorn: true, stallAoa: 14 },
  },
  prop: {
    create: createPropSynth,
    // cylinders, blades, maxRpm (rpm at state.flight.rpm = 1), idleRpm.
    defaults: { cylinders: 4, blades: 2, maxRpm: 2700, idleRpm: 750, airflowSpeed: 60, interiorCutoff: 900, stallHorn: true, stallAoa: 15 },
  },
  jet: {
    create: createJetSynth,
    // whineHz (fan/compressor tone at full spool), rumbleHz (exhaust sub tone), idleSpool (0..1),
    // spoolUp / spoolDown (time constants, s), afterburnerRoar (0..2 roar level).
    defaults: {
      whineHz: 3100, rumbleHz: 46, idleSpool: 0.62, spoolUp: 1.1, spoolDown: 1.8, afterburnerRoar: 1,
      airflowSpeed: 280, classicAirflowSpeed: 300, interiorCutoff: 700, stallHorn: true, stallAoa: 25,
    },
  },
  heli: {
    create: createHeliSynth,
    // blades, rotorRpm (governed main-rotor rpm), tailBlades, tailRatio (tail rpm / main rpm), turbineHz.
    defaults: {
      blades: 2, rotorRpm: 390, tailBlades: 2, tailRatio: 5.6, turbineHz: 5200,
      airflowSpeed: 65, interiorCutoff: 1100, touchdown: 'skids',
    },
  },
  drone: {
    create: createDroneSynth,
    // motors, idleHz (motor tone at zero thrust), maxHz (at full thrust).
    defaults: { motors: 4, idleHz: 190, maxHz: 880, airflowSpeed: 42, interiorCutoff: 0, touchdown: 'body', callouts: false },
  },
  wingsuit: {
    create: createWingsuitSynth,
    // flutterHz (fabric flap rate at 40 m/s), proximityRange (m AGL where terrain rush starts).
    defaults: { flutterHz: 14, proximityRange: 90, airflowSpeed: 60, interiorCutoff: 0, touchdown: 'body', callouts: false },
  },
});

const PROFILE_CACHE = new WeakMap();

/**
 * The complete profile for a craft: family defaults under the craft's own audioProfile. vario
 * resolves to the craft's instruments when the profile does not say. Results are cached per
 * profile object.
 */
export function resolveAudioProfile(audioProfile, instruments) {
  const source = audioProfile && typeof audioProfile === 'object' ? audioProfile : null;
  if (source && PROFILE_CACHE.has(source)) return PROFILE_CACHE.get(source);
  const family = source && ENGINE_FAMILIES[source.engine] ? source.engine : 'glider';
  const resolved = { ...COMMON_DEFAULTS, ...ENGINE_FAMILIES[family].defaults, ...(source ?? {}), engine: family };
  if (typeof resolved.vario !== 'boolean') resolved.vario = Array.isArray(instruments) && instruments.includes('vario');
  const frozen = Object.freeze(resolved);
  if (source) PROFILE_CACHE.set(source, frozen);
  return frozen;
}
