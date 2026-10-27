// The ghost galleon: a ship that should not be sailing the clouds. A thin wind whistles through its
// rigging (a narrow band of noise wandering in pitch) over a hollow rush, its timbers creak (sparse
// pulses gating a resonant low band), and under it all a faint, slow choir of two detuned voices
// rises and falls, as if the crew were still singing.
//
// setIntensity(0..1) is the approach: the rigging, the creak and the choir grow as the player closes in.
// trigger('bell', { strength }) strikes the ship's bell: five inharmonic partials (hum, prime, tierce,
// quint, nominal) that ring on and fade over several seconds. The partials run all the time at zero
// level, so a strike only schedules envelopes (no node is made after build).
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, wobble } from './recipeKit.js';

const WHISTLE_LEVEL = 0.12;
const RUSH_LEVEL = 0.2;
const CREAK_LEVEL = 0.45;
const CHOIR_LEVEL = 0.07;
/** The bell's partials: [ratio to the strike note, level, decay s]. */
const BELL = Object.freeze([
  Object.freeze([0.5, 0.5, 7]),
  Object.freeze([1, 1, 5.5]),
  Object.freeze([1.19, 0.55, 4]),
  Object.freeze([1.5, 0.35, 3.2]),
  Object.freeze([2, 0.4, 2.6]),
]);
const BELL_LEVEL = 0.32;

export default Object.freeze({
  name: 'galleon',
  summary: 'wind whistling in rigging, creaking timbers, a faint choir; a tolling ship\'s bell',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 160, rolloffFactor: 1.3, panningModel: 'HRTF', size: 70, reverb: 0.85 }),
  level: 0.05,
  floor: 0.1,
  triggers: Object.freeze(['bell']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const bellHz = option(params, 'bellHz', 392, 120, 1200);
    const choirHz = option(params, 'choirHz', 147, 60, 400);
    let intensity = 0;
    let bells = 0;

    const whistle = noiseBand(kit, { rate: 1.1, type: 'bandpass', frequency: 1500, q: 11 });
    wobble(kit, whistle.filter.frequency, 380, 0.09);
    wobble(kit, whistle.gain.gain, 0.04, 0.23);
    const rush = noiseBand(kit, { rate: 0.7, type: 'lowpass', frequency: 420, q: 0.8 });
    const creak = crackleBand(kit, { rate: 0.5, type: 'bandpass', frequency: 240, q: 7, crackleRate: 0.06, cutoff: 9, drive: 1.5 });

    // The choir: two detuned voices an open fifth apart through a soft low-pass, breathing slowly.
    const choirTone = kit.pitched(scaffold.filter('lowpass', choirHz * 5, 0.9));
    const choirLevel = scaffold.gain(0);
    choirTone.connect(choirLevel);
    choirLevel.connect(out);
    const breathing = scaffold.gain(0.6);
    breathing.connect(choirTone);
    wobble(kit, breathing.gain, 0.4, 0.06);
    for (const [ratio, detune] of [[1, -6], [1, 7], [1.5, -4], [1.5, 5]]) {
      const voice = kit.pitched(scaffold.oscillator('triangle', choirHz * ratio));
      voice.detune.value = detune;
      voice.connect(breathing);
    }

    // The bell: partials always running, each behind its own struck envelope.
    const bellBus = scaffold.gain(BELL_LEVEL);
    bellBus.connect(out);
    const partials = BELL.map(([ratio]) => {
      const envelope = scaffold.gain(0);
      envelope.connect(bellBus);
      const partial = kit.pitched(scaffold.oscillator('sine', bellHz * ratio));
      partial.connect(envelope);
      return envelope;
    });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(whistle.gain.gain, WHISTLE_LEVEL * value, time, timeConstant);
        glide(rush.gain.gain, RUSH_LEVEL * (0.35 + 0.65 * value), time, timeConstant);
        glide(creak.level.gain, CREAK_LEVEL * value, time, timeConstant);
        glide(choirLevel.gain, CHOIR_LEVEL * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'bell') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        bells++;
        for (let index = 0; index < BELL.length; index++) strike(partials[index].gain, time, BELL[index][1] * strength, 0.004, BELL[index][2]);
        return true;
      },
      describe() {
        return { intensity, bells };
      },
    };
  },
});
