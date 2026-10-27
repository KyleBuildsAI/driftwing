// Balloon burners: the festival's soundscape. Propane burners roar in bursts of one to three seconds
// (a deep, rough blast of noise with a hissing top, a hard attack and a soft tail), fired by one
// balloon after another across the field, over a quiet bed of open-air breeze.
//
// setIntensity(0..1) is the festival's presence (the player's approach): the breeze and the bursts
// grow louder and come more often. update() schedules the bursts; trigger('burst', { strength,
// seconds }) fires one at once.
import { glide } from '../synthKit.js';
import { noiseBand, option, swell } from './recipeKit.js';

const BURNER_SLOTS = 3;
const BURST_LEVEL = 0.5;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'burner',
  summary: 'propane burner blasts in bursts over a quiet breeze',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 120, rolloffFactor: 1.3, panningModel: 'equalpower', size: 400, reverb: 0.35 }),
  level: 0.08,
  floor: 0,
  triggers: Object.freeze(['burst']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let nextBurst = -1;
    let bursts = 0;

    const breezeSurge = scaffold.modulated(0.8, 0.2, 0.11);
    breezeSurge.carrier.connect(out);
    const breeze = noiseBand(kit, { rate: 0.7, type: 'lowpass', frequency: 700, q: 0.6, destination: breezeSurge.carrier });

    // Each burner: a rumbling low band and a hissing top through one envelope, roughened by a fast
    // flutter, the way a propane flame tears.
    const slots = [];
    for (let index = 0; index < BURNER_SLOTS; index++) {
      const envelope = scaffold.gain(0);
      const rough = scaffold.modulated(0.75, 0.25, 23 + index * 4.7);
      envelope.connect(rough.carrier);
      rough.carrier.connect(out);
      const roar = noiseBand(kit, { rate: 0.55 + index * 0.07, type: 'lowpass', frequency: 420, q: 0.9, level: 1, destination: envelope });
      const hiss = noiseBand(kit, { rate: 1.05, type: 'bandpass', frequency: 2300 + index * 300, q: 0.8, level: 0.22, destination: envelope });
      slots.push({ envelope, roar, hiss });
    }

    function burst(time, strength, seconds) {
      const slot = slots[bursts % BURNER_SLOTS];
      bursts++;
      swell(slot.envelope.gain, time, BURST_LEVEL * strength * (0.3 + 0.7 * intensity), 0.08, seconds, 0.6);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 1;
        glide(breeze.gain.gain, 0.12 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'burst') return false;
        burst(time, option(options, 'strength', 1, 0, 1.5), option(options, 'seconds', 1.8, 0.3, 6));
        return true;
      },
      update(time) {
        if (nextBurst < 0) nextBurst = time + randomBetween(1, 3);
        if (time < nextBurst) return;
        if (intensity > 0.02) burst(time, randomBetween(0.45, 1), randomBetween(0.9, 2.8));
        // Busier as the player closes in: every 2-4 s near the field, every 5-9 s at its edge.
        nextBurst = time + randomBetween(2, 4) + (1 - intensity) * randomBetween(3, 5);
      },
      describe() {
        return { intensity, bursts };
      },
    };
  },
});
