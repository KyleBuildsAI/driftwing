// 'jet' engine family: a turbofan with afterburner.
//
// Spool speed follows state.flight.rpm (0..1 of rated, never below idleSpool while running) with
// the slow spool-up and spool-down of a real turbine. Voices:
//   whine     compressor/fan tones at whineHz * spool with a beating partner and a narrow hiss
//   rumble    low broadband exhaust noise plus a sub tone, growing with throttle
//   roar      broadband afterburner roar with a slow turbulent flicker, on state.flight.afterburner
// Inside the cockpit the whine dominates; outside (chase, flyby) the exhaust rumble and roar do.
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide } from '../synthKit.js';

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createJetSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);

  const whineBus = synth.gain(0);
  const whineA = synth.oscillator('sine', 2000);
  const whineB = synth.oscillator('sine', 2026);
  const whineLow = synth.oscillator('triangle', 1000);
  const whineLowLevel = synth.gain(0.35);
  whineA.connect(whineBus);
  whineB.connect(whineBus);
  whineLow.connect(whineLowLevel);
  whineLowLevel.connect(whineBus);
  const hissNoise = synth.noise(noise, 1.3);
  const hissFilter = synth.filter('bandpass', 3000, 5);
  const hissLevel = synth.gain(0.6);
  hissNoise.connect(hissFilter);
  hissFilter.connect(hissLevel);
  hissLevel.connect(whineBus);
  whineBus.connect(synth.output);

  const rumbleNoise = synth.noise(noise, 0.7);
  const rumbleFilter = synth.filter('lowpass', 200, 0.8);
  const rumbleLevel = synth.gain(0);
  rumbleNoise.connect(rumbleFilter);
  rumbleFilter.connect(rumbleLevel);
  rumbleLevel.connect(synth.output);
  const subTone = synth.oscillator('sine', 40);
  const subLevel = synth.gain(0);
  subTone.connect(subLevel);
  subLevel.connect(synth.output);

  const roarNoise = synth.noise(noise, 0.85);
  const roarFilter = synth.filter('lowpass', 1500, 0.5);
  const roarBody = synth.filter('peaking', 90, 0.8);
  roarBody.gain.value = 7;
  // The flicker stage swells the roar around unity with slow turbulent noise; roarGain then
  // scales it by the afterburner amount, so the flicker never leaks through when it is off.
  const flickerStage = synth.gain(1);
  const flicker = synth.noise(noise, 0.02);
  const flickerFilter = synth.filter('lowpass', 12, 0.7);
  const flickerDepth = synth.gain(0.6);
  flicker.connect(flickerFilter);
  flickerFilter.connect(flickerDepth);
  flickerDepth.connect(flickerStage.gain);
  const roarGain = synth.gain(0);
  const roarLevel = synth.gain(0);
  roarNoise.connect(roarFilter);
  roarFilter.connect(roarBody);
  roarBody.connect(flickerStage);
  flickerStage.connect(roarGain);
  roarGain.connect(roarLevel);
  roarLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const idleSpool = clamp(profile.idleSpool, 0.3, 0.9);
  let spool = 0;
  let roar = 0;
  const readout = { spool: 0, whineHz: 0, roar: 0, level: 0 };

  return {
    family: 'jet',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const running = flight.engineOn !== false;
      const rpm = clamp(Number.isFinite(flight.rpm) ? flight.rpm : 0, 0, 1.1);
      const target = running ? Math.max(idleSpool, rpm) : 0;
      spool = approach(spool, target, target > spool ? profile.spoolUp : profile.spoolDown, interval);
      const throttle = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
      const afterburner = running && flight.afterburner === true && spool > 0.8;
      roar = approach(roar, afterburner ? 1 : 0, afterburner ? 0.18 : 0.4, interval);
      const outside = !frame.interior;
      const whineHz = profile.whineHz * spool;

      glide(whineA.frequency, whineHz * pitch, time, 0.08);
      glide(whineB.frequency, whineHz * 1.013 * pitch, time, 0.08);
      glide(whineLow.frequency, whineHz * 0.5 * pitch, time, 0.08);
      glide(hissFilter.frequency, whineHz * 1.4 * pitch, time, 0.1);
      glide(whineBus.gain, (0.02 + 0.05 * spool * spool * spool) * (outside ? 0.45 : 1.25), time, 0.1);

      const rumble = spool * (0.25 + 0.75 * Math.pow(throttle, 1.5));
      glide(rumbleFilter.frequency, (120 + 520 * rumble + 900 * roar) * pitch, time, 0.12);
      glide(rumbleLevel.gain, (0.2 + 0.9 * rumble) * (outside ? 1.25 : 0.7), time, 0.12);
      glide(subTone.frequency, profile.rumbleHz * (0.6 + 0.4 * spool) * pitch, time, 0.1);
      glide(subLevel.gain, 0.18 * rumble, time, 0.12);

      glide(roarGain.gain, roar * 0.8, time, 0.06);
      glide(roarLevel.gain, profile.afterburnerRoar * (outside ? 1.35 : 0.8), time, 0.1);
      glide(roarFilter.frequency, (900 + 1600 * roar) * pitch, time, 0.12);

      const level = spool < 0.04 ? 0 : 0.11 * Math.min(1, spool * 2) * profile.level;
      glide(synth.output.gain, level, time, 0.15);
      readout.spool = spool;
      readout.whineHz = whineHz;
      readout.roar = roar;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.6);
    },
    describe() {
      return {
        family: 'jet',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { whine: whineA.frequency.value, sub: subTone.frequency.value },
        roarGain: roarGain.gain.value,
      };
    },
  };
}
