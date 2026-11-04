// Lighthouse beacons: a diaphone foghorn over the slow wash of the sea. The horn is the classic
// two-tone "BEEE-oh": a reedy low note (a buzzy pulse through a wide resonance) held for a couple of
// seconds, then the grunt, a drop of a few semitones as the air runs out, carried far on the night
// air with a long tail.
//
// setIntensity(0..1) is the beacon's presence: the sea's wash under it (low noise breathing with the
// swell). trigger('horn', { strength, pitch }) sounds one horn (pitch scales the note, so nearer and
// farther lighthouses differ); two horn slots alternate, so a chain's answers may overlap.
import { createPulseWave, glide } from '../synthKit.js';
import { noiseBand, option, swell } from './recipeKit.js';

const HORN_SLOTS = 2;
const HORN_HZ = 110;
const GRUNT_RATIO = 0.74;
const HORN_LEVEL = 0.34;
const HOLD_SECONDS = 2.2;

export default Object.freeze({
  name: 'foghorn',
  summary: 'diaphone foghorn over the wash of the sea',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 900, rolloffFactor: 0.5, panningModel: 'equalpower', size: 200, reverb: 0.9 }),
  level: 0.08,
  floor: 0.3,
  triggers: Object.freeze(['horn']),

  build(kit) {
    const { scaffold, out, context } = kit;
    let intensity = 0;
    let horns = 0;

    // The sea: low noise breathing with a slow swell.
    const swellGain = scaffold.modulated(0.6, 0.4, 0.09);
    swellGain.carrier.connect(out);
    const wash = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 420, q: 0.6, destination: swellGain.carrier });

    const reed = createPulseWave(context, 18);
    const slots = [];
    for (let index = 0; index < HORN_SLOTS; index++) {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const body = kit.pitched(scaffold.filter('bandpass', 380, 1.3));
      body.connect(envelope);
      const tone = kit.pitched(scaffold.oscillator('custom', HORN_HZ, reed));
      const sub = kit.pitched(scaffold.oscillator('sine', HORN_HZ * 0.5));
      const subLevel = scaffold.gain(0.6);
      tone.connect(body);
      sub.connect(subLevel);
      subLevel.connect(envelope);
      slots.push({ envelope, tone, sub });
    }

    /** One horn at time: the held note, then the grunt a few semitones down. */
    function horn(time, strength, pitch) {
      const slot = slots[horns % HORN_SLOTS];
      horns++;
      const note = HORN_HZ * pitch;
      slot.tone.frequency.cancelScheduledValues(time);
      slot.tone.frequency.setValueAtTime(note, time);
      slot.tone.frequency.setValueAtTime(note, time + HOLD_SECONDS);
      slot.tone.frequency.exponentialRampToValueAtTime(note * GRUNT_RATIO, time + HOLD_SECONDS + 0.25);
      slot.sub.frequency.cancelScheduledValues(time);
      slot.sub.frequency.setValueAtTime(note * 0.5, time);
      slot.sub.frequency.setValueAtTime(note * 0.5, time + HOLD_SECONDS);
      slot.sub.frequency.exponentialRampToValueAtTime(note * 0.5 * GRUNT_RATIO, time + HOLD_SECONDS + 0.25);
      swell(slot.envelope.gain, time, HORN_LEVEL * strength, 0.12, HOLD_SECONDS + 0.5, 0.9);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        glide(wash.gain.gain, 0.9 * (0.3 + 0.7 * value), time, immediate ? 0.01 : 1.5);
      },
      trigger(name, options, time) {
        if (name !== 'horn') return false;
        horn(time, option(options, 'strength', 1, 0, 1.5), option(options, 'pitch', 1, 0.5, 2));
        return true;
      },
      describe() {
        return { intensity, horns };
      },
    };
  },
});
