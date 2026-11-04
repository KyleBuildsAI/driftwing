// Steam train (preset 56): a locomotive working across its viaduct. The chuff of the exhaust beats
// faster as the train gathers speed, the rods clank under it, steam hisses from the cylinders, and
// the whistle sounds as it leaves the tunnel.
//
// Each chuff is a burst of band-passed noise struck on a schedule in update(): the beat rate follows
// setIntensity(0..1) (the recipe mode: the train's speed share; 0 while it waits in the tunnel). The
// clank is a sparse metallic crackle and the hiss high-passed noise, both rising with speed.
// trigger('whistle', { strength, duration }) is the whistle: a three-note chord of reedy pulse tones
// through a vocal band, with a short rise and a breathy release.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, swell } from './recipeKit.js';

/** Chuffs per second at full speed and at a crawl. */
const CHUFF_MAX = 6;
const CHUFF_MIN = 1.1;
const CHUFF_SLOTS = 3;
/** The whistle's chord (Hz): a minor triad, as on many old engines. */
const WHISTLE_HZ = Object.freeze([523, 622, 784]);

export default Object.freeze({
  name: 'train',
  summary: 'a steam locomotive: chuff, clank, hiss and whistle',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 120, rolloffFactor: 0.9, panningModel: 'HRTF', size: 40, reverb: 0.6 }),
  level: 0.06,
  floor: 0.1,
  triggers: Object.freeze(['whistle']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let nextChuff = -1;
    let chuffs = 0;
    let whistles = 0;

    const slots = [];
    for (let index = 0; index < CHUFF_SLOTS; index++) {
      const chuff = noiseBand(kit, { rate: 0.85 + index * 0.07, type: 'bandpass', frequency: 420, q: 0.9 });
      const body = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 150, q: 1 });
      slots.push({ chuff, body });
    }
    const clank = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 1900, q: 3, crackleRate: 0.25, cutoff: 45, drive: 1.6 });
    const hiss = noiseBand(kit, { rate: 1.1, type: 'highpass', frequency: 5200, q: 0.6 });

    // The whistle: three pulse tones through a vocal band, under one envelope, with a breath of noise.
    const whistleEnvelope = scaffold.gain(0);
    const whistleBand = kit.pitched(scaffold.filter('bandpass', 1300, 1.1));
    whistleBand.connect(whistleEnvelope);
    whistleEnvelope.connect(out);
    for (const frequency of WHISTLE_HZ) {
      const tone = kit.pitched(scaffold.oscillator('square', frequency));
      const toneLevel = scaffold.gain(0.33);
      tone.connect(toneLevel);
      toneLevel.connect(whistleBand);
    }
    noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 1500, q: 2, level: 0.25, destination: whistleEnvelope });

    function chuff(time, strength) {
      const slot = slots[chuffs % CHUFF_SLOTS];
      chuffs++;
      strike(slot.chuff.gain.gain, time, 0.5 * strength, 0.01, 0.32);
      strike(slot.body.gain.gain, time, 0.35 * strength, 0.008, 0.22);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.6;
        glide(clank.level.gain, 0.35 * value, time, timeConstant);
        glide(hiss.gain.gain, 0.02 + 0.05 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'whistle') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        const duration = option(options, 'duration', 1.6, 0.3, 6);
        whistles++;
        swell(whistleEnvelope.gain, time, 0.09 * strength, 0.12, duration, 0.5);
        return true;
      },
      update(time) {
        if (intensity < 0.02) {
          nextChuff = -1;
          return;
        }
        if (nextChuff < 0 || nextChuff < time - 1) nextChuff = time;
        if (time >= nextChuff) {
          chuff(time, 0.6 + 0.4 * intensity);
          nextChuff += 1 / (CHUFF_MIN + (CHUFF_MAX - CHUFF_MIN) * intensity);
        }
      },
      describe() {
        return { intensity, chuffs, whistles };
      },
    };
  },
});
