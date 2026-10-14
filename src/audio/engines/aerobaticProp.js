// 'aerobaticProp' engine family: a high-revving six-cylinder aerobatic engine with a big three-blade
// prop, and the smoke system's hiss.
//
// The 'prop' family (prop.js) supplies the engine and blade voices; this family adds, over it:
//   snarl     the high-rpm prop snarl: blade tips near the speed of sound at full power. A buzzy
//             sawtooth at the blade-pass frequency, bandpassed high and gated by the blade passes
//             (rough by exhaustRoughness), that rises steeply with rpm and load, plus a crackle of
//             noise at the firing rate
//   hiss      the smoke system: oil injected into the hot exhaust hisses (bandpassed noise with a
//             slow flutter) while state.flight.craftState.smoke is on, with a short rush as it opens
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide } from '../synthKit.js';
import { createPropSynth } from './prop.js';

/** The snarl starts at this share of max rpm and is full at the top. */
const SNARL_FROM = 0.72;
const HISS_LEVEL = 0.05;
const HISS_OPEN_RUSH = 0.6;

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createAerobaticPropSynth(kit, profile) {
  const { context, noise } = kit;
  const base = createPropSynth(kit, profile);
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 10);

  const snarl = synth.oscillator('sawtooth', 135);
  const snarlFilter = synth.filter('bandpass', 1400, 2.2);
  const snarlGate = synth.modulated(0.35, 0.65, 135, 'sine', pulse);
  const snarlLevel = synth.gain(0);
  snarl.connect(snarlFilter);
  snarlFilter.connect(snarlGate.carrier);
  snarlGate.carrier.connect(snarlLevel);
  snarlLevel.connect(synth.output);

  const crackleNoise = synth.noise(noise, 1.4);
  const crackleFilter = synth.filter('bandpass', 2600, 1.5);
  const crackle = synth.modulated(0.2, 0.8, 90, 'square');
  const crackleLevel = synth.gain(0);
  crackleNoise.connect(crackleFilter);
  crackleFilter.connect(crackle.carrier);
  crackle.carrier.connect(crackleLevel);
  crackleLevel.connect(synth.output);

  const hissNoise = synth.noise(noise, 0.9);
  const hissFilter = synth.filter('bandpass', 3600, 0.8);
  const hissFlutter = synth.modulated(0.8, 0.2, 5.5, 'sine');
  const hissLevel = synth.gain(0);
  hissNoise.connect(hissFilter);
  hissFilter.connect(hissFlutter.carrier);
  hissFlutter.carrier.connect(hissLevel);
  hissLevel.connect(synth.output);

  synth.output.gain.value = 1;
  synth.start(context.currentTime + 0.02);

  const cylinders = clamp(Math.round(profile.cylinders), 1, 18);
  const blades = clamp(Math.round(profile.blades), 2, 8);
  const maxRpm = Math.max(profile.maxRpm, 500);
  const roughness = clamp(Number.isFinite(profile.exhaustRoughness) ? profile.exhaustRoughness : 0.4, 0, 1);
  let rpmShare = 0;
  let smokeOn = false;
  let rush = 0;
  const readout = { snarl: 0, hiss: 0 };

  return {
    family: 'aerobaticProp',
    update(frame, pitch) {
      base.update(frame, pitch);
      const { time, interval, flight } = frame;
      const running = flight.engineOn !== false;
      const target = running ? clamp(Number.isFinite(flight.rpm) ? flight.rpm : 0, 0, 1.15) : 0;
      rpmShare = approach(rpmShare, target, target > rpmShare ? 0.3 : 0.6, interval);
      const load = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
      const engineRpm = rpmShare * maxRpm;
      const bladeHz = (blades * engineRpm) / 60;
      const firingHz = (cylinders * engineRpm) / 120;
      const tip = clamp((rpmShare - SNARL_FROM) / (1 - SNARL_FROM), 0, 1);
      const snarlAmount = tip * tip * (0.35 + 0.65 * load) * profile.level;

      glide(snarl.frequency, bladeHz * pitch, time, 0.05);
      glide(snarlGate.lfo.frequency, bladeHz * pitch, time, 0.05);
      glide(snarlGate.depth.gain, 0.4 + 0.5 * roughness, time, 0.2);
      glide(snarlFilter.frequency, (900 + 9 * bladeHz) * pitch, time, 0.1);
      glide(snarlLevel.gain, 0.05 * snarlAmount, time, 0.1);
      glide(crackle.lfo.frequency, firingHz * pitch, time, 0.05);
      glide(crackleLevel.gain, 0.03 * snarlAmount * roughness, time, 0.1);

      const smoke = Boolean(flight.craftState && flight.craftState.smoke === true);
      if (smoke && !smokeOn) rush = 1;
      smokeOn = smoke;
      rush = approach(rush, 0, 0.35, interval);
      const hiss = smoke ? HISS_LEVEL * (1 + HISS_OPEN_RUSH * rush) * profile.level : 0;
      glide(hissLevel.gain, hiss, time, smoke ? 0.08 : 0.25);
      glide(hissFilter.frequency, (3200 + 900 * load) * pitch, time, 0.2);
      readout.snarl = snarlAmount;
      readout.hiss = hiss;
    },
    stop(time) {
      base.stop(time);
      synth.stop(time);
    },
    describe() {
      const engine = base.describe();
      return {
        ...engine,
        family: 'aerobaticProp',
        snarl: readout.snarl,
        hiss: readout.hiss,
        frequencies: { ...engine.frequencies, snarl: snarl.frequency.value, hiss: hissFilter.frequency.value },
      };
    },
  };
}
