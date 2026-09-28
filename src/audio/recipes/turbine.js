// Wind turbines: the rhythmic whoosh of blades sweeping past the tower, one voice for a group of
// three turbines turning at slightly different speeds, over a faint gearbox hum.
//
// Each blade pass is a swell of band-passed air whose band also sweeps up and back (the blade tip
// approaching and receding). setIntensity(0..1) is the wind speed the rotors see: the rotor speed
// follows it (with the inertia of a heavy rotor) from parked to 20 rpm, three blade passes per turn.
import { createPulseWave, glide, smoothstep } from '../synthKit.js';
import { noiseBand } from './recipeKit.js';

const ROTORS = Object.freeze([
  Object.freeze({ rate: 1, band: 640, noiseRate: 1 }),
  Object.freeze({ rate: 0.94, band: 780, noiseRate: 1.09 }),
  Object.freeze({ rate: 1.07, band: 500, noiseRate: 0.92 }),
]);
const BLADES = 3;
const MIN_RPM = 3;
const MAX_RPM = 20;
const ROTOR_INERTIA = 1.6;

/** Blade passes per second of the lead rotor for a wind intensity. */
export function turbineBladePass(intensity) {
  const clamped = Math.min(Math.max(intensity, 0), 1);
  return clamped < 0.02 ? 0 : (BLADES * (MIN_RPM + (MAX_RPM - MIN_RPM) * clamped)) / 60;
}

export default Object.freeze({
  name: 'turbine',
  summary: 'rhythmic whoosh, rate driven by wind speed',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 90, rolloffFactor: 1.4, panningModel: 'equalpower', size: 260, reverb: 0.2 }),
  level: 0.06,
  floor: 0.05,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out, context } = kit;
    const bladeWave = createPulseWave(context, 3);
    let intensity = 0;
    let bladePass = 0;

    const whoosh = scaffold.gain(0);
    whoosh.connect(out);
    const rotors = [];
    for (const rotor of ROTORS) {
      const swish = scaffold.modulated(0.3, 0.7, 0.01, 'sine', bladeWave);
      swish.carrier.connect(whoosh);
      const air = noiseBand(kit, { rate: rotor.noiseRate, type: 'bandpass', frequency: rotor.band, q: 0.9, level: 1, destination: swish.carrier });
      const sweepDepth = scaffold.gain(rotor.band * 0.4);
      swish.lfo.connect(sweepDepth);
      sweepDepth.connect(air.filter.frequency);
      rotors.push({ swish, rotor });
    }

    const gearbox = scaffold.gain(0);
    gearbox.connect(out);
    const hum = kit.pitched(scaffold.oscillator('triangle', 40));
    const humOvertone = kit.pitched(scaffold.oscillator('sine', 80));
    hum.connect(gearbox);
    humOvertone.connect(gearbox);

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        bladePass = turbineBladePass(value);
        const inertia = immediate ? 0.01 : ROTOR_INERTIA;
        for (let index = 0; index < rotors.length; index++) {
          glide(rotors[index].swish.lfo.frequency, Math.max(bladePass * rotors[index].rotor.rate, 0.01), time, inertia);
        }
        const turning = smoothstep(0, 0.15, value);
        glide(whoosh.gain, 1.6 * turning * (0.3 + 0.7 * value), time, inertia);
        glide(gearbox.gain, 0.022 * turning, time, inertia);
        glide(hum.frequency, 28 + 70 * value, time, inertia);
        glide(humOvertone.frequency, 2 * (28 + 70 * value), time, inertia);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity, bladePassHz: bladePass, rpm: bladePass > 0 ? (bladePass * 60) / BLADES : 0 };
      },
    };
  },
});
