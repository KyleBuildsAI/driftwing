// Turbulence rattle (environment bus): the airframe's generic response to rough air, heard with the
// camera shake (both follow core/turbulence.js), so every wind spawn sounds right.
//
// Two noise layers under the airflow beds: a rattle (a bright band of noise chopped by a square
// oscillator whose rate wanders between 9 and 17 Hz, like panels and fittings buzzing) and a thump
// (low noise pulsed by a slow triangle, the airframe taking the bumps). In a closed cockpit the rattle
// is close and clear; outside it is a faint buzz under a duller thump. Silent at zero turbulence and
// through the calm-air floor, silent in photo mode and while paused.
import { clamp } from '../core/util.js';
import { turbulenceResponse } from '../core/turbulence.js';
import { glide } from './synthKit.js';

const INTERIOR = Object.freeze({ rattle: 0.11, thump: 0.13 });
const EXTERIOR = Object.freeze({ rattle: 0.025, thump: 0.07 });

/** kit: { context, noise, mixer }. */
export function createTurbulenceRattle(kit) {
  const { context, noise, mixer } = kit;
  const start = context.currentTime + 0.02;
  const output = context.createGain();
  output.gain.value = 1;
  output.connect(mixer.input('environment'));

  // Rattle: bright band-passed noise, chopped by a square wave.
  const rattleSource = context.createBufferSource();
  rattleSource.buffer = noise;
  rattleSource.loop = true;
  rattleSource.playbackRate.value = 1.31;
  const rattleFilter = context.createBiquadFilter();
  rattleFilter.type = 'bandpass';
  rattleFilter.frequency.value = 1900;
  rattleFilter.Q.value = 1.3;
  const rattleChop = context.createGain();
  rattleChop.gain.value = 0.5;
  const chopper = context.createOscillator();
  chopper.type = 'square';
  chopper.frequency.value = 13;
  const chopDepth = context.createGain();
  chopDepth.gain.value = 0.5;
  chopper.connect(chopDepth);
  chopDepth.connect(rattleChop.gain);
  const rattleGain = context.createGain();
  rattleGain.gain.value = 0;
  rattleSource.connect(rattleFilter);
  rattleFilter.connect(rattleChop);
  rattleChop.connect(rattleGain);
  rattleGain.connect(output);

  // Thump: low noise pulsed by a slow triangle.
  const thumpSource = context.createBufferSource();
  thumpSource.buffer = noise;
  thumpSource.loop = true;
  thumpSource.playbackRate.value = 0.47;
  const thumpFilter = context.createBiquadFilter();
  thumpFilter.type = 'lowpass';
  thumpFilter.frequency.value = 110;
  thumpFilter.Q.value = 0.8;
  const thumpPulse = context.createGain();
  thumpPulse.gain.value = 0.55;
  const pulser = context.createOscillator();
  pulser.type = 'triangle';
  pulser.frequency.value = 5.5;
  const pulseDepth = context.createGain();
  pulseDepth.gain.value = 0.45;
  pulser.connect(pulseDepth);
  pulseDepth.connect(thumpPulse.gain);
  const thumpGain = context.createGain();
  thumpGain.gain.value = 0;
  thumpSource.connect(thumpFilter);
  thumpFilter.connect(thumpPulse);
  thumpPulse.connect(thumpGain);
  thumpGain.connect(output);

  rattleSource.start(start, 0.4);
  thumpSource.start(start, 1.1);
  chopper.start(start);
  pulser.start(start);

  const readout = { amount: 0, interior: false, rattle: 0, thump: 0 };

  return {
    /** frame: see AudioEngine buildFrame(). Called at the parameter interval. */
    update(frame) {
      const { time, flight, profile } = frame;
      const turbulence = clamp(Number.isFinite(flight.turbulence) ? flight.turbulence : 0, 0, 1);
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const amount = frame.paused || frame.photo ? 0 : turbulenceResponse(turbulence, airspeed);
      const inside = frame.interior && profile.interiorCutoff > 0;
      const levels = inside ? INTERIOR : EXTERIOR;
      const rattle = levels.rattle * amount;
      const thump = levels.thump * Math.pow(amount, 0.75);
      glide(rattleGain.gain, rattle, time, 0.08);
      glide(thumpGain.gain, amount > 0 ? thump : 0, time, 0.12);
      if (amount > 0) {
        glide(chopper.frequency, 9 + 8 * Math.random(), time, 0.15);
        glide(pulser.frequency, 4 + 3 * Math.random() * (0.5 + amount), time, 0.2);
        glide(rattleFilter.frequency, (inside ? 1700 : 1300) + 900 * amount, time, 0.2);
      }
      readout.amount = amount;
      readout.interior = inside;
      readout.rattle = rattle;
      readout.thump = amount > 0 ? thump : 0;
    },

    describe() {
      return { ...readout, levels: { rattle: rattleGain.gain.value, thump: thumpGain.gain.value } };
    },
  };
}
