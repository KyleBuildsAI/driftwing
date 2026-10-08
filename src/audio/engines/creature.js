// 'creature' family (contract h.2): the eagle and its dragon skin (state.flight.craftState.skin).
//
//   whoosh    one air push per wingbeat (craftState.flapCount), band-passed noise whose level follows
//             the beat's amplitude: a light, airy whoosh for the eagle, a deep one for the dragon
//   thump     the dragon's wingbeat: a low membrane thump on every beat (eagle: silent)
//   screech   the eagle's call (craftState.screechCount): a bright, rasping "kee-eee" that rises and
//             falls, with a fast vibrato
//   roar      the dragon's roar (craftState.roarCount, also at the start of every fire breath): a low,
//             growling sawtooth pair over noise that slides down and opens up
//   fire      the fire whoosh while the dragon breathes (craftState.fireIntensity): a roaring band of
//             noise with a crackle on top
//   whistle   the stoop: a thin whistle of air over tucked wings, rising with airspeed
// The beats and calls are scheduled on the audio clock from the craft state's counters, so nothing is
// created per beat or per frame; the airflow beds and the vario come from the shared layers.
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide, holdAt } from '../synthKit.js';

const SKIN_VOICES = Object.freeze({
  eagle: Object.freeze({ whooshHz: 620, whooshQ: 0.9, whooshLevel: 0.55, thump: 0 }),
  dragon: Object.freeze({ whooshHz: 240, whooshQ: 0.7, whooshLevel: 0.85, thump: 0.75 }),
});

/** A ragged crackle wave (a few inharmonic-ish partials): the fire's pops. */
function createCrackleWave(context) {
  const real = new Float32Array([0, 0.3, 0.1, 0.45, 0.05, 0.35, 0.12, 0.28, 0.2]);
  const imaginary = new Float32Array([0, 0.9, 0.6, 0.2, 0.55, 0.15, 0.4, 0.1, 0.3]);
  return context.createPeriodicWave(real, imaginary);
}

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createCreatureSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);

  const whooshNoise = synth.noise(noise, 1);
  const whooshFilter = synth.filter('bandpass', 620, 0.9);
  const whooshLevel = synth.gain(0);
  whooshNoise.connect(whooshFilter);
  whooshFilter.connect(whooshLevel);
  whooshLevel.connect(synth.output);

  const thumpTone = synth.oscillator('sine', 54);
  const thumpLevel = synth.gain(0);
  thumpTone.connect(thumpLevel);
  thumpLevel.connect(synth.output);

  const screechA = synth.oscillator('sawtooth', 2600);
  const screechB = synth.oscillator('square', 3900);
  const screechBLevel = synth.gain(0.18);
  const vibrato = synth.oscillator('sine', 14);
  const vibratoDepth = synth.gain(70);
  vibrato.connect(vibratoDepth);
  vibratoDepth.connect(screechA.frequency);
  vibratoDepth.connect(screechB.frequency);
  const screechFilter = synth.filter('bandpass', 3000, 2.5);
  const screechLevel = synth.gain(0);
  screechA.connect(screechFilter);
  screechB.connect(screechBLevel);
  screechBLevel.connect(screechFilter);
  screechFilter.connect(screechLevel);
  screechLevel.connect(synth.output);

  const roarA = synth.oscillator('sawtooth', 90);
  const roarB = synth.oscillator('sawtooth', 137);
  const roarNoise = synth.noise(noise, 0.6);
  const roarNoiseLevel = synth.gain(0.5);
  const growl = synth.modulated(0.6, 0.4, 23, 'triangle');
  const roarFilter = synth.filter('lowpass', 700, 1.2);
  const roarLevel = synth.gain(0);
  roarA.connect(growl.carrier);
  roarB.connect(growl.carrier);
  roarNoise.connect(roarNoiseLevel);
  roarNoiseLevel.connect(growl.carrier);
  growl.carrier.connect(roarFilter);
  roarFilter.connect(roarLevel);
  roarLevel.connect(synth.output);

  const fireNoise = synth.noise(noise, 0.9);
  const fireFilter = synth.filter('bandpass', 700, 0.6);
  const fireLevel = synth.gain(0);
  fireNoise.connect(fireFilter);
  fireFilter.connect(fireLevel);
  fireLevel.connect(synth.output);
  const crackleNoise = synth.noise(noise, 1.4);
  const crackleFilter = synth.filter('highpass', 2600, 0.7);
  const crackle = synth.modulated(0.05, 0.95, 9, 'sine', createCrackleWave(context));
  const crackleLevel = synth.gain(0);
  crackleNoise.connect(crackleFilter);
  crackleFilter.connect(crackle.carrier);
  crackle.carrier.connect(crackleLevel);
  crackleLevel.connect(synth.output);

  const whistleNoise = synth.noise(noise, 1.2);
  const whistleFilter = synth.filter('bandpass', 2200, 7);
  const whistleLevel = synth.gain(0);
  whistleNoise.connect(whistleFilter);
  whistleFilter.connect(whistleLevel);
  whistleLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);
  const counters = { flaps: NaN, screeches: NaN, roars: NaN, beats: 0, calls: 0 };
  let fire = 0;
  const readout = { skin: 'eagle', amplitude: 0, fire: 0, tuck: 0, beats: 0, calls: 0, level: 0 };

  function beat(time, voices, amplitude, pitch) {
    const peak = voices.whooshLevel * (0.25 + 0.75 * amplitude);
    holdAt(whooshLevel.gain, time);
    whooshLevel.gain.linearRampToValueAtTime(peak, time + 0.07);
    whooshLevel.gain.setTargetAtTime(0, time + 0.07, 0.1);
    glide(whooshFilter.frequency, voices.whooshHz * (0.85 + 0.3 * amplitude) * pitch, time, 0.02);
    whooshFilter.Q.setValueAtTime(voices.whooshQ, time);
    if (voices.thump > 0) {
      holdAt(thumpLevel.gain, time);
      thumpLevel.gain.linearRampToValueAtTime(voices.thump * (0.4 + 0.6 * amplitude), time + 0.03);
      thumpLevel.gain.setTargetAtTime(0, time + 0.04, 0.07);
      thumpTone.frequency.setValueAtTime(58 * pitch, time);
      thumpTone.frequency.exponentialRampToValueAtTime(38 * pitch, time + 0.18);
    }
    counters.beats++;
  }

  function screech(time, pitch) {
    holdAt(screechA.frequency, time);
    screechA.frequency.setValueAtTime(2300 * pitch, time);
    screechA.frequency.linearRampToValueAtTime(3300 * pitch, time + 0.12);
    screechA.frequency.exponentialRampToValueAtTime(2500 * pitch, time + 0.55);
    screechA.frequency.linearRampToValueAtTime(1800 * pitch, time + 0.95);
    holdAt(screechB.frequency, time);
    screechB.frequency.setValueAtTime(3450 * pitch, time);
    screechB.frequency.linearRampToValueAtTime(4950 * pitch, time + 0.12);
    screechB.frequency.exponentialRampToValueAtTime(3750 * pitch, time + 0.55);
    screechB.frequency.linearRampToValueAtTime(2700 * pitch, time + 0.95);
    holdAt(screechLevel.gain, time);
    screechLevel.gain.linearRampToValueAtTime(0.42, time + 0.04);
    screechLevel.gain.setTargetAtTime(0.3, time + 0.1, 0.12);
    screechLevel.gain.setTargetAtTime(0, time + 0.78, 0.07);
    counters.calls++;
  }

  function roar(time, pitch) {
    holdAt(roarA.frequency, time);
    roarA.frequency.setValueAtTime(96 * pitch, time);
    roarA.frequency.exponentialRampToValueAtTime(64 * pitch, time + 1.5);
    holdAt(roarB.frequency, time);
    roarB.frequency.setValueAtTime(143 * pitch, time);
    roarB.frequency.exponentialRampToValueAtTime(97 * pitch, time + 1.5);
    holdAt(roarFilter.frequency, time);
    roarFilter.frequency.setValueAtTime(500, time);
    roarFilter.frequency.linearRampToValueAtTime(1500, time + 0.35);
    roarFilter.frequency.setTargetAtTime(600, time + 0.6, 0.4);
    holdAt(roarLevel.gain, time);
    roarLevel.gain.linearRampToValueAtTime(0.6, time + 0.15);
    roarLevel.gain.setTargetAtTime(0.45, time + 0.3, 0.3);
    roarLevel.gain.setTargetAtTime(0, time + 1.15, 0.18);
    counters.calls++;
  }

  return {
    family: 'creature',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState || {};
      const skin = craftState.skin === 'dragon' ? 'dragon' : 'eagle';
      const voices = SKIN_VOICES[skin];
      const amplitude = clamp(Number(craftState.flapAmplitude) || 0, 0, 1);
      const flapCount = Number(craftState.flapCount) || 0;
      const screechCount = Number(craftState.screechCount) || 0;
      const roarCount = Number(craftState.roarCount) || 0;
      // The first frame only learns the counters: nothing replays on a craft switch.
      if (Number.isNaN(counters.flaps)) {
        counters.flaps = flapCount;
        counters.screeches = screechCount;
        counters.roars = roarCount;
      }
      if (flapCount !== counters.flaps) {
        counters.flaps = flapCount;
        if (amplitude > 0.02) beat(time, voices, amplitude, pitch);
      }
      if (screechCount !== counters.screeches) {
        counters.screeches = screechCount;
        if (skin === 'eagle') screech(time, pitch);
      }
      if (roarCount !== counters.roars) {
        counters.roars = roarCount;
        if (skin === 'dragon') roar(time, pitch);
      }
      // The fire whoosh follows the breath; the whistle the stoop.
      fire = approach(fire, skin === 'dragon' ? clamp(Number(craftState.fireIntensity) || 0, 0, 1) : 0, 0.06, interval);
      glide(fireLevel.gain, 0.7 * fire, time, 0.05);
      glide(fireFilter.frequency, (520 + 520 * fire) * pitch, time, 0.08);
      glide(crackleLevel.gain, 0.22 * fire, time, 0.05);
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const tuck = clamp(Number(craftState.wingTuck) || 0, 0, 1);
      const rush = clamp((airspeed - 18) / 45, 0, 1);
      glide(whistleLevel.gain, 0.3 * tuck * rush, time, 0.15);
      glide(whistleFilter.frequency, (1500 + 2200 * rush) * pitch, time, 0.15);

      const level = 0.5 * profile.level;
      glide(synth.output.gain, level, time, 0.2);
      readout.skin = skin;
      readout.amplitude = amplitude;
      readout.fire = fire;
      readout.tuck = tuck;
      readout.beats = counters.beats;
      readout.calls = counters.calls;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'creature',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { whoosh: whooshFilter.frequency.value, screech: screechA.frequency.value, roar: roarA.frequency.value },
        layers: { whoosh: whooshLevel.gain.value, thump: thumpLevel.gain.value, screech: screechLevel.gain.value, roar: roarLevel.gain.value, fire: fireLevel.gain.value, whistle: whistleLevel.gain.value },
      };
    },
  };
}
