// 'radial' engine family: a big nine-cylinder radial and its propeller, plus the water a floatplane
// makes (the seaplane).
//
// The engine speed follows state.flight.rpm like the 'prop' family. Voices:
//   rumble    a low sawtooth at the firing frequency (cylinders * rpm / 120: an odd number of
//             cylinders fires evenly on every other turn) with its crank sub-harmonic, through a
//             resonant low-pass that opens with load: the deep, round radial voice
//   lope      the rumble's level wobbles at the crank rate with an uneven pulse train, the radial's
//             loping idle that smooths out as the power comes in
//   stacks    exhaust crackle: noise pulsed at the firing frequency through a band-pass, loudest at
//             idle and on the power reduction (popping)
//   prop      the blade-pass buzz (blades * rpm / 60) and a tip rasp that grows with rpm
//   water     floats in the water (flight.craftState.onWater): a slap of low noise bursts at the
//             rate the floats meet the ripples (faster with speed, slower when planing), and a
//             spray hiss that follows craftState.spray
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide, smoothstep } from '../synthKit.js';

/** The wavelength (m) of the ripples the floats slap through: the slap rate is speed / this. */
const RIPPLE_WAVELENGTH = 2.6;
const SLAP_RATE = Object.freeze({ min: 1.2, max: 9 });

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createRadialSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 8);
  const lopePulse = createPulseWave(context, 3);

  const rumbleFilter = synth.filter('lowpass', 420, 4);
  const rumble = synth.oscillator('sawtooth', 60);
  const rumbleLevel = synth.gain(0.55);
  const crank = synth.oscillator('triangle', 30);
  const crankLevel = synth.gain(0.35);
  const harmonic = synth.oscillator('square', 120);
  const harmonicLevel = synth.gain(0.08);
  rumble.connect(rumbleLevel);
  rumbleLevel.connect(rumbleFilter);
  crank.connect(crankLevel);
  crankLevel.connect(rumbleFilter);
  harmonic.connect(harmonicLevel);
  harmonicLevel.connect(rumbleFilter);
  const lope = synth.modulated(0.75, 0.25, 12, 'sine', lopePulse);
  rumbleFilter.connect(lope.carrier);
  lope.carrier.connect(synth.output);

  const stackNoise = synth.noise(noise, 0.9);
  const stackFilter = synth.filter('bandpass', 380, 1.4);
  const stacks = synth.modulated(0.1, 0.9, 60, 'sine', pulse);
  const stackLevel = synth.gain(0.35);
  stackNoise.connect(stackFilter);
  stackFilter.connect(stacks.carrier);
  stacks.carrier.connect(stackLevel);
  stackLevel.connect(synth.output);

  const blade = synth.oscillator('sawtooth', 80);
  const bladeFilter = synth.filter('bandpass', 240, 4);
  const bladeLevel = synth.gain(0.1);
  blade.connect(bladeFilter);
  bladeFilter.connect(bladeLevel);
  bladeLevel.connect(synth.output);

  const raspNoise = synth.noise(noise, 1.1);
  const raspFilter = synth.filter('highpass', 2000, 0.7);
  const rasp = synth.modulated(0.3, 0.7, 80, 'sine', pulse);
  const raspLevel = synth.gain(0);
  raspNoise.connect(raspFilter);
  raspFilter.connect(rasp.carrier);
  rasp.carrier.connect(raspLevel);
  raspLevel.connect(synth.output);

  // Water: the slap (low noise, pulsed) and the spray hiss (high noise). Both silent off the water.
  const slapNoise = synth.noise(noise, 0.6);
  const slapFilter = synth.filter('lowpass', 260, 1.2);
  const slap = synth.modulated(0, 1, SLAP_RATE.min, 'sine', pulse);
  const slapLevel = synth.gain(0);
  slapNoise.connect(slapFilter);
  slapFilter.connect(slap.carrier);
  slap.carrier.connect(slapLevel);
  slapLevel.connect(synth.output);

  const sprayNoise = synth.noise(noise, 1.3);
  const sprayFilter = synth.filter('bandpass', 3200, 0.6);
  const sprayLevel = synth.gain(0);
  sprayNoise.connect(sprayFilter);
  sprayFilter.connect(sprayLevel);
  sprayLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const cylinders = clamp(Math.round(profile.cylinders), 3, 18);
  const blades = clamp(Math.round(profile.blades), 2, 8);
  const maxRpm = Math.max(profile.maxRpm, 500);
  const idleRpm = clamp(profile.idleRpm, 200, maxRpm);
  let engineRpm = 0;
  let previousLoad = 0;
  let popping = 0;
  const readout = { engineRpm: 0, firingHz: 0, bladeHz: 0, level: 0, slapHz: 0, slap: 0, spray: 0 };

  return {
    family: 'radial',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const running = flight.engineOn !== false;
      const rpmFraction = clamp(Number.isFinite(flight.rpm) ? flight.rpm : 0, 0, 1.15);
      const target = running ? Math.max(idleRpm, maxRpm * rpmFraction) : 0;
      engineRpm = approach(engineRpm, target, target > engineRpm ? 0.5 : running ? 0.8 : 2.2, interval);
      const load = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
      // Pulling the power off makes the stacks pop for a moment.
      if (previousLoad - load > 0.002 && interval > 0) popping = Math.min(1, popping + (previousLoad - load) * 6);
      popping = approach(popping, 0, 0.6, interval);
      previousLoad = load;
      const spin = engineRpm / maxRpm;
      const firingHz = (cylinders * engineRpm) / 120;
      const crankHz = engineRpm / 60;
      const bladeHz = (blades * engineRpm) / 60;
      const airflow = clamp((Number.isFinite(flight.airspeed) ? flight.airspeed : 0) / 60, 0, 1.5);

      glide(rumble.frequency, firingHz * pitch, time, 0.06);
      glide(crank.frequency, firingHz * 0.5 * pitch, time, 0.06);
      glide(harmonic.frequency, firingHz * 2 * pitch, time, 0.06);
      glide(rumbleFilter.frequency, (160 + 900 * load + 2 * firingHz) * pitch, time, 0.1);
      glide(lope.lfo.frequency, crankHz * 0.5 * pitch, time, 0.08);
      glide(lope.depth.gain, 0.32 * (1 - smoothstep(0.2, 0.7, load)) + 0.06, time, 0.2);
      glide(stacks.lfo.frequency, firingHz * pitch, time, 0.06);
      glide(stackFilter.frequency, (260 + 2.5 * firingHz) * pitch, time, 0.1);
      glide(stackLevel.gain, 0.18 + 0.25 * (1 - load) * Math.min(1, spin * 4) + 0.5 * popping, time, 0.08);
      glide(blade.frequency, bladeHz * pitch, time, 0.06);
      glide(bladeFilter.frequency, bladeHz * 3 * pitch, time, 0.1);
      glide(bladeLevel.gain, 0.05 + 0.2 * load + 0.08 * airflow, time, 0.1);
      glide(rasp.lfo.frequency, bladeHz * pitch, time, 0.06);
      glide(raspLevel.gain, 0.22 * spin * spin * (0.4 + 0.6 * load), time, 0.1);

      const craftState = flight.craftState;
      const onWater = Boolean(craftState && craftState.onWater === true);
      const waterSpeed = onWater && Number.isFinite(craftState.waterSpeed) ? Math.abs(craftState.waterSpeed) : 0;
      const spray = onWater && Number.isFinite(craftState.spray) ? clamp(craftState.spray, 0, 1) : 0;
      const planing = onWater && craftState.onStep === true;
      const slapHz = clamp(waterSpeed / RIPPLE_WAVELENGTH, SLAP_RATE.min, SLAP_RATE.max) * (planing ? 0.6 : 1);
      const slapAmount = onWater ? (0.25 + 0.75 * smoothstep(0.5, 8, waterSpeed)) * (planing ? 0.55 : 1) : 0;
      glide(slap.lfo.frequency, slapHz, time, 0.15);
      glide(slapFilter.frequency, 180 + 22 * waterSpeed, time, 0.2);
      glide(slapLevel.gain, 0.5 * slapAmount, time, 0.15);
      glide(sprayFilter.frequency, 2400 + 90 * waterSpeed, time, 0.2);
      glide(sprayLevel.gain, 0.45 * spray, time, 0.12);

      const engineLevel = spin < 0.04 ? 0 : (0.04 + 0.085 * load) * Math.min(1, spin * 3);
      const level = Math.max(engineLevel, onWater ? 0.05 * (slapAmount + spray) : 0) * profile.level;
      glide(synth.output.gain, level, time, 0.12);
      readout.engineRpm = engineRpm;
      readout.firingHz = firingHz;
      readout.bladeHz = bladeHz;
      readout.level = level;
      readout.slapHz = slapHz;
      readout.slap = slapAmount;
      readout.spray = spray;
    },
    stop(time) {
      synth.stop(time);
    },
    describe() {
      return {
        family: 'radial',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { rumble: rumble.frequency.value, crank: crank.frequency.value, blade: blade.frequency.value, stacks: stacks.lfo.frequency.value, slap: slap.lfo.frequency.value },
      };
    },
  };
}
