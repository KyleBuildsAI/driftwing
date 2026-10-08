// 'airshipProp' family: an airship's two vectored propellers, its stern thruster and the envelope.
//
//   drone     the low prop drone: each pod's piston engine (sawtooth at the firing frequency,
//             cylinders * rpm / 120) and its blade-pass hum (blades * rpm / 60) through a dark low-pass;
//             the two pods run a few rpm apart, so the drone beats slowly, the way twin engines do
//   stern     the lateral stern thruster: a ducted-fan whine and its air rush while it pushes the tail
//   blower    the ballonet blowers and valves: a soft hum while the ballonets fill or empty
//   creak     the envelope and its keel creaking under load: short stick-slip pulse bursts through a
//             resonant band, more often and louder with turbulence, body rates and load, quiet but never
//             gone in calm air
// Engine speed follows state.flight.rpm (the props' share of rated, 0..1) between idleRpm and maxRpm.
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide } from '../synthKit.js';

/** The second pod runs this much slower (share of rpm): the slow twin-engine beat. */
const DETUNE = 0.012;
/** Seconds between creaks: calm air at most, heavy load at least. */
const CREAK_INTERVAL = Object.freeze({ CALM: 7, LOADED: 0.6 });

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createAirshipPropSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 10);

  // Drone: two engines and their props into one dark filter.
  const droneFilter = synth.filter('lowpass', 420, 1.2);
  const droneLevel = synth.gain(1);
  droneFilter.connect(droneLevel);
  droneLevel.connect(synth.output);
  const pods = [0, 1].map(() => {
    const engine = synth.oscillator('sawtooth', 60);
    const engineLevel = synth.gain(0.35);
    const blade = synth.oscillator('triangle', 80);
    const bladeLevel = synth.gain(0.5);
    const throb = synth.modulated(0.7, 0.3, 20, 'sine', pulse);
    engine.connect(engineLevel);
    engineLevel.connect(throb.carrier);
    blade.connect(bladeLevel);
    bladeLevel.connect(throb.carrier);
    throb.carrier.connect(droneFilter);
    return { engine, blade, throb };
  });

  // Stern thruster: fan whine and the air it moves.
  const fan = synth.oscillator('triangle', 300);
  const fanFilter = synth.filter('bandpass', 600, 3);
  const fanLevel = synth.gain(0);
  fan.connect(fanFilter);
  fanFilter.connect(fanLevel);
  fanLevel.connect(synth.output);
  const fanNoise = synth.noise(noise, 1);
  const fanNoiseFilter = synth.filter('bandpass', 1200, 0.9);
  const fanNoiseLevel = synth.gain(0);
  fanNoise.connect(fanNoiseFilter);
  fanNoiseFilter.connect(fanNoiseLevel);
  fanNoiseLevel.connect(synth.output);

  // Ballonet blowers.
  const blower = synth.oscillator('sine', 118);
  const blowerNoise = synth.noise(noise, 0.5);
  const blowerFilter = synth.filter('lowpass', 380, 0.8);
  const blowerLevel = synth.gain(0);
  blower.connect(blowerFilter);
  blowerNoise.connect(blowerFilter);
  blowerFilter.connect(blowerLevel);
  blowerLevel.connect(synth.output);

  // Creak: a slow stick-slip pulse train and a little grit, gated per creak.
  const creak = synth.oscillator('sawtooth', 26, pulse);
  const creakGrit = synth.noise(noise, 0.7);
  const creakGritLevel = synth.gain(0.25);
  const creakFilter = synth.filter('bandpass', 520, 8);
  const creakGate = synth.gain(0);
  const creakLevel = synth.gain(0.9);
  creak.connect(creakFilter);
  creakGrit.connect(creakGritLevel);
  creakGritLevel.connect(creakFilter);
  creakFilter.connect(creakGate);
  creakGate.connect(creakLevel);
  creakLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const cylinders = clamp(Math.round(profile.cylinders), 1, 12);
  const blades = clamp(Math.round(profile.blades), 2, 8);
  const maxRpm = Math.max(profile.maxRpm, 500);
  const idleRpm = clamp(profile.idleRpm, 200, maxRpm);
  let engineRpm = 0;
  let stress = 0;
  let creakTimer = 2;
  let creaks = 0;
  const readout = { engineRpm: 0, firingHz: 0, bladeHz: 0, stern: 0, blower: 0, stress: 0, creaks: 0, level: 0 };

  /** One creak at `time`: a short swell, a pitch slide of the slip rate, a random resonance. */
  function playCreak(time, strength) {
    const length = 0.25 + Math.random() * 0.6;
    const peak = (0.12 + 0.5 * strength) * (0.6 + Math.random() * 0.4);
    const startRate = 14 + Math.random() * 18;
    creakGate.gain.cancelScheduledValues(time);
    creakGate.gain.setValueAtTime(0, time);
    creakGate.gain.linearRampToValueAtTime(peak, time + 0.05);
    creakGate.gain.setTargetAtTime(0, time + length * 0.6, length * 0.25);
    creak.frequency.cancelScheduledValues(time);
    creak.frequency.setValueAtTime(startRate, time);
    creak.frequency.linearRampToValueAtTime(startRate * (1.4 + Math.random()), time + length);
    creakFilter.frequency.cancelScheduledValues(time);
    creakFilter.frequency.setValueAtTime(320 + Math.random() * 620, time);
    creaks++;
  }

  return {
    family: 'airshipProp',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState || {};
      const running = flight.engineOn !== false;
      const share = clamp(Number.isFinite(flight.rpm) ? flight.rpm : 0, 0, 1.1);
      const target = running ? idleRpm + (maxRpm - idleRpm) * share : 0;
      engineRpm = approach(engineRpm, target, target > engineRpm ? 0.6 : running ? 0.9 : 2.2, interval);
      const spin = engineRpm / maxRpm;
      const load = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
      const firingHz = (cylinders * engineRpm) / 120;
      const bladeHz = (blades * engineRpm) / 60;
      pods.forEach((pod, index) => {
        const detune = 1 - DETUNE * index;
        glide(pod.engine.frequency, firingHz * detune * pitch, time, 0.08);
        glide(pod.blade.frequency, bladeHz * detune * pitch, time, 0.08);
        glide(pod.throb.lfo.frequency, (engineRpm / 60) * detune * pitch, time, 0.08);
      });
      glide(droneFilter.frequency, (180 + 520 * load + 1.2 * bladeHz) * pitch, time, 0.15);
      glide(droneLevel.gain, spin < 0.05 ? 0 : (0.45 + 0.55 * load) * Math.min(1, spin * 2.5), time, 0.15);

      const stern = clamp(Math.abs(Number.isFinite(craftState.sternThrust) ? craftState.sternThrust : 0), 0, 1);
      glide(fan.frequency, (240 + 520 * stern) * pitch, time, 0.12);
      glide(fanFilter.frequency, (480 + 900 * stern) * pitch, time, 0.12);
      glide(fanLevel.gain, 0.22 * stern, time, 0.15);
      glide(fanNoiseLevel.gain, 0.3 * stern, time, 0.15);

      const ballonet = Number.isFinite(craftState.ballonet) ? craftState.ballonet : 0.5;
      const ballonetTarget = Number.isFinite(craftState.ballonetTarget) ? craftState.ballonetTarget : ballonet;
      const blowing = Math.abs(ballonetTarget - ballonet) > 0.002 ? 1 : 0;
      glide(blowerLevel.gain, 0.16 * blowing, time, 0.4);
      glide(blower.frequency, (ballonetTarget > ballonet ? 124 : 104) * pitch, time, 0.3);

      // Structural load: gusts, body rates and load factor (every creak a little different).
      const rates = flight.angularVelocity;
      const rate = rates ? Math.abs(rates.x) + Math.abs(rates.y) + Math.abs(rates.z) : 0;
      const turbulence = clamp(Number.isFinite(flight.turbulence) ? flight.turbulence : 0, 0, 1);
      const loadFactor = Math.abs((Number.isFinite(flight.gLoad) ? flight.gLoad : 1) - 1);
      const rawStress = clamp(turbulence * 0.8 + rate * 6 + loadFactor * 4 + blowing * 0.2, 0, 1);
      stress = approach(stress, rawStress, 0.6, interval);
      creakTimer -= interval;
      if (creakTimer <= 0 && !frame.paused) {
        playCreak(time, stress);
        const spacing = CREAK_INTERVAL.CALM + (CREAK_INTERVAL.LOADED - CREAK_INTERVAL.CALM) * stress;
        creakTimer = spacing * (0.5 + Math.random());
      }

      const level = 0.11 * profile.level;
      glide(synth.output.gain, level, time, 0.2);
      readout.engineRpm = engineRpm;
      readout.firingHz = firingHz;
      readout.bladeHz = bladeHz;
      readout.stern = stern;
      readout.blower = blowing;
      readout.stress = stress;
      readout.creaks = creaks;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'airshipProp',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { engine: pods[0].engine.frequency.value, blade: pods[0].blade.frequency.value, fan: fan.frequency.value },
        layers: { drone: droneLevel.gain.value, stern: fanLevel.gain.value, blower: blowerLevel.gain.value, creak: creakLevel.gain.value },
      };
    },
  };
}
