// Mixer: the bus structure every sound feeds.
//
//   engine, environment, ui, music --> duck --+
//   bus reverb sends --> reverb --> return --+--> master --> muffle --> compressor --> destination
//   copilot ---------------------------------+
//
// Bus gains come from settings.mixer normalised to the defaults (a bus at its default slider value
// has unity gain), so the default mix reproduces v1's levels exactly while each slider still
// ranges from silence to a little above default. The master gain is v1's master volume (the
// masterVolume setting is an alias of mixer.master). Every bus except copilot sits behind the duck
// gain, which dips while the copilot speaks. The muffle low-pass is transparent at the Nyquist
// frequency and sweeps down for the soft-crash effect.
import { DEFAULT_SETTINGS, MIXER_BUSES } from '../core/settings.js';
import { glide, holdAt } from './synthKit.js';

export const BUS_NAMES = MIXER_BUSES;
const OUTPUT_BUSES = MIXER_BUSES.filter((name) => name !== 'master');
const REVERB_RETURN_LEVEL = 0.36;
export const DUCKED_LEVEL = 0.4;
const DUCK_ATTACK = 0.12;
const DUCK_RELEASE = 0.55;
const MUFFLE_CUTOFF = 320;

function busLevel(mixer, name) {
  const value = Number.isFinite(mixer?.[name]) ? mixer[name] : DEFAULT_SETTINGS.mixer[name];
  const reference = DEFAULT_SETTINGS.mixer[name];
  return reference > 0 ? Math.min(Math.max(value, 0), 1) / reference : 0;
}

export function createMixer(context, reverbBuffer) {
  const nyquist = context.sampleRate / 2;
  const master = context.createGain();
  master.gain.value = 0;
  const muffle = context.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = nyquist;
  muffle.Q.value = 0.5;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;
  master.connect(muffle);
  muffle.connect(compressor);
  compressor.connect(context.destination);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  compressor.connect(analyser);

  const duck = context.createGain();
  duck.connect(master);
  const reverb = context.createConvolver();
  reverb.buffer = reverbBuffer;
  const reverbReturn = context.createGain();
  reverbReturn.gain.value = REVERB_RETURN_LEVEL;
  reverb.connect(reverbReturn);
  reverbReturn.connect(duck);

  const buses = {};
  for (const name of OUTPUT_BUSES) {
    const input = context.createGain();
    input.connect(name === 'copilot' ? master : duck);
    const send = context.createGain();
    send.connect(reverb);
    buses[name] = { input, send };
  }

  let ducked = false;
  let muffled = false;
  let muffleReleaseEnd = 0;

  return {
    context,
    master,
    duck,
    muffle,
    analyser,

    /** The input node of a bus (connect sources here), or null for an unknown name. */
    input(name) {
      return buses[name]?.input ?? null;
    },

    /** The reverb send of a bus: voices connect a send-amount gain here. */
    send(name) {
      return buses[name]?.send ?? null;
    },

    /** Applies settings.mixer to the bus gains (not the master, which the engine drives). */
    applyLevels(mixer, time) {
      for (const name of OUTPUT_BUSES) {
        const level = busLevel(mixer, name);
        glide(buses[name].input.gain, level, time, 0.08);
        glide(buses[name].send.gain, level, time, 0.08);
      }
    },

    /** Sets bus gains immediately (first build, before anything is audible). */
    initLevels(mixer) {
      for (const name of OUTPUT_BUSES) {
        const level = busLevel(mixer, name);
        buses[name].input.gain.value = level;
        buses[name].send.gain.value = level;
      }
    },

    setMaster(level, time, timeConstant) {
      glide(master.gain, level, time, timeConstant);
    },

    /** Everything but the copilot bus dips while active. */
    setDucked(active, time) {
      if (active === ducked) return;
      ducked = active;
      holdAt(duck.gain, time);
      duck.gain.setTargetAtTime(active ? DUCKED_LEVEL : 1, time, active ? DUCK_ATTACK : DUCK_RELEASE);
    },

    get ducked() {
      return ducked;
    },

    /** Soft-crash muffle: sweeps the master low-pass down, and back open on release. */
    setMuffled(active, time) {
      if (active === muffled) return;
      muffled = active;
      holdAt(muffle.frequency, time);
      if (active) {
        muffle.frequency.setTargetAtTime(MUFFLE_CUTOFF, time, 0.05);
      } else {
        muffle.frequency.setTargetAtTime(nyquist, time, 0.35);
        muffleReleaseEnd = time + 2.2;
      }
    },

    get muffled() {
      return muffled;
    },

    /** Snaps the released muffle exactly back to Nyquist, where the low-pass is transparent. */
    settle(time) {
      if (muffled || muffleReleaseEnd === 0 || time < muffleReleaseEnd) return;
      muffleReleaseEnd = 0;
      muffle.frequency.cancelScheduledValues(time);
      muffle.frequency.setValueAtTime(nyquist, time);
    },

    /** Current gain of every bus (the automated values) for diagnostics. */
    describe() {
      const levels = { master: master.gain.value, duck: duck.gain.value, muffle: muffle.frequency.value };
      for (const name of OUTPUT_BUSES) levels[name] = buses[name].input.gain.value;
      return levels;
    },
  };
}
