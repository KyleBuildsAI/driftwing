// Airflow beds (environment bus): v1's two looping noise layers (a low body and a panned, brighter
// rush of air) whose gain and cutoff follow airspeed, g-load and cloud immersion with slow gusts;
// plus a buffet rumble near the stall and a rolling rumble on the ground.
//
// state.flight.airspeed over the craft's airflowSpeed drives the beds, and turbulence widens the
// gusts.
// In the cockpit view of a closed cockpit everything crossfades to a low-passed interior mix.
import { clamp } from '../core/util.js';
import { glide, smoothstep } from './synthKit.js';

const INTERIOR_LEVEL = 0.85;

/** kit: { context, noise, mixer }. */
export function createAirflow(kit) {
  const { context, noise, mixer } = kit;
  const start = context.currentTime + 0.02;
  const environment = mixer.input('environment');

  // Exterior (dry) and interior (low-passed) paths; the chase view is exactly v1's dry path.
  const output = context.createGain();
  const exterior = context.createGain();
  const interiorFilter = context.createBiquadFilter();
  interiorFilter.type = 'lowpass';
  interiorFilter.frequency.value = 1100;
  interiorFilter.Q.value = 0.6;
  const interior = context.createGain();
  interior.gain.value = 0;
  output.connect(exterior);
  exterior.connect(environment);
  output.connect(interiorFilter);
  interiorFilter.connect(interior);
  interior.connect(environment);

  // ---- v1 wind layers --------------------------------------------------------------------------------
  const windBodySource = context.createBufferSource();
  windBodySource.buffer = noise;
  windBodySource.loop = true;
  const windBodyFilter = context.createBiquadFilter();
  windBodyFilter.type = 'lowpass';
  windBodyFilter.frequency.value = 380;
  windBodyFilter.Q.value = 0.4;
  const windBodyGain = context.createGain();
  windBodyGain.gain.value = 0;
  windBodySource.connect(windBodyFilter);
  windBodyFilter.connect(windBodyGain);
  windBodyGain.connect(output);

  const windAirSource = context.createBufferSource();
  windAirSource.buffer = noise;
  windAirSource.loop = true;
  windAirSource.playbackRate.value = 1.19;
  const windAirFilter = context.createBiquadFilter();
  windAirFilter.type = 'bandpass';
  windAirFilter.frequency.value = 1400;
  windAirFilter.Q.value = 0.7;
  const windAirGain = context.createGain();
  windAirGain.gain.value = 0;
  const windPanner = context.createStereoPanner();
  windAirSource.connect(windAirFilter);
  windAirFilter.connect(windAirGain);
  windAirGain.connect(windPanner);
  windPanner.connect(output);

  windBodySource.start(start, 0);
  windAirSource.start(start, 1.7);

  // ---- SIM buffet: low noise, amplitude-modulated at a shaking rate ----------------------------------
  const buffetSource = context.createBufferSource();
  buffetSource.buffer = noise;
  buffetSource.loop = true;
  buffetSource.playbackRate.value = 0.55;
  const buffetFilter = context.createBiquadFilter();
  buffetFilter.type = 'lowpass';
  buffetFilter.frequency.value = 150;
  buffetFilter.Q.value = 0.9;
  const buffetShake = context.createGain();
  buffetShake.gain.value = 0.55;
  const buffetLfo = context.createOscillator();
  buffetLfo.type = 'triangle';
  buffetLfo.frequency.value = 9;
  const buffetDepth = context.createGain();
  buffetDepth.gain.value = 0.45;
  buffetLfo.connect(buffetDepth);
  buffetDepth.connect(buffetShake.gain);
  const buffetGain = context.createGain();
  buffetGain.gain.value = 0;
  buffetSource.connect(buffetFilter);
  buffetFilter.connect(buffetShake);
  buffetShake.connect(buffetGain);
  buffetGain.connect(output);
  buffetSource.start(start, 0.9);
  buffetLfo.start(start);

  // ---- SIM rolling rumble on wheels or skids ----------------------------------------------------------
  const rollSource = context.createBufferSource();
  rollSource.buffer = noise;
  rollSource.loop = true;
  rollSource.playbackRate.value = 0.8;
  const rollFilter = context.createBiquadFilter();
  rollFilter.type = 'lowpass';
  rollFilter.frequency.value = 220;
  rollFilter.Q.value = 0.7;
  const rollGain = context.createGain();
  rollGain.gain.value = 0;
  rollSource.connect(rollFilter);
  rollFilter.connect(rollGain);
  rollGain.connect(output);
  rollSource.start(start, 2.6);

  let gustLevel = 1;
  let gustTarget = 1;
  let gustTimer = 0;
  let windPan = 0;
  const readout = { speedRatio: 0, bodyGain: 0, airGain: 0, buffet: 0, rolling: 0, interior: false };

  /** Buffet from the model (stall.buffet) or, failing that, from AoA against the craft's stall AoA. */
  function buffetAmount(frame) {
    const flight = frame.flight;
    const modelBuffet = clamp(Number.isFinite(flight.stall?.buffet) ? flight.stall.buffet : 0, 0, 1);
    const stallAoa = frame.profile.stallAoa;
    let aoaBuffet = 0;
    if (Number.isFinite(stallAoa) && Number.isFinite(flight.aoa) && !flight.onGround) {
      aoaBuffet = 0.7 * smoothstep(stallAoa - 3, stallAoa + 1.5, Math.abs(flight.aoa));
    }
    const pressure = clamp((flight.airspeed - 8) / 25, 0, 1.4);
    return Math.max(modelBuffet, aoaBuffet) * pressure;
  }

  return {
    /** frame: see AudioEngine buildFrame(). Called at the parameter interval. */
    update(frame) {
      const { time, interval, player, flight, profile } = frame;
      const speed = flight.airspeed;
      const speedRatio = clamp((Number.isFinite(speed) ? speed : 0) / profile.airflowSpeed, 0, 1.4);
      const gLoad = clamp(Math.abs((Number.isFinite(flight.gLoad) ? flight.gLoad : 1) - 1), 0, 3);
      const inCloud = clamp(Number.isFinite(player.inCloud) ? player.inCloud : 0, 0, 1);
      const turbulence = clamp(Number.isFinite(flight.turbulence) ? flight.turbulence : 0, 0, 1);

      gustTimer -= interval;
      if (gustTimer <= 0) {
        gustTarget = 0.78 + Math.random() * (0.5 + 0.6 * turbulence);
        gustTimer = (0.8 + Math.random() * 2.4) * (1 - 0.6 * turbulence);
      }
      gustLevel += (gustTarget - gustLevel) * (0.08 + 0.12 * turbulence);
      windPan += ((Math.random() - 0.5) * 0.4 - windPan) * 0.05;

      const bodyGain = (0.03 + 0.2 * speedRatio * speedRatio) * gustLevel * (1 + 0.25 * gLoad);
      const bodyCutoff = (200 + 950 * speedRatio) * (0.85 + 0.3 * gustLevel) * (1 - 0.3 * inCloud);
      const airGain = (0.004 + 0.1 * speedRatio * speedRatio * speedRatio + 0.02 * gLoad) * (0.7 + 0.3 * gustLevel);
      const airFrequency = (850 + 2500 * speedRatio) * (1 - 0.35 * inCloud);
      glide(windBodyGain.gain, bodyGain, time, 0.18);
      glide(windBodyFilter.frequency, bodyCutoff, time, 0.25);
      glide(windAirGain.gain, airGain, time, 0.2);
      glide(windAirFilter.frequency, airFrequency, time, 0.25);
      glide(windPanner.pan, windPan, time, 0.4);

      const buffet = buffetAmount(frame);
      glide(buffetGain.gain, 0.42 * Math.pow(buffet, 1.3), time, 0.08);
      glide(buffetLfo.frequency, 7 + 6 * Math.random(), time, 0.2);

      const groundSpeed = Number.isFinite(flight.groundSpeed) ? flight.groundSpeed : 0;
      const rolling = flight.onGround && profile.touchdown !== 'body' ? clamp(groundSpeed / 30, 0, 1) : 0;
      glide(rollGain.gain, 0.12 * rolling * (profile.touchdown === 'skids' ? 1.3 : 1), time, 0.1);
      glide(rollFilter.frequency, 120 + 260 * rolling, time, 0.2);

      const inside = frame.interior && profile.interiorCutoff > 0;
      glide(exterior.gain, inside ? 0 : 1, time, 0.12);
      glide(interior.gain, inside ? INTERIOR_LEVEL : 0, time, 0.12);
      if (inside) glide(interiorFilter.frequency, profile.interiorCutoff, time, 0.12);

      readout.speedRatio = speedRatio;
      readout.bodyGain = bodyGain;
      readout.airGain = airGain;
      readout.buffet = buffet;
      readout.rolling = rolling;
      readout.interior = inside;
    },

    describe() {
      return {
        ...readout,
        levels: {
          body: windBodyGain.gain.value,
          air: windAirGain.gain.value,
          buffet: buffetGain.gain.value,
          rolling: rollGain.gain.value,
          exterior: exterior.gain.value,
          interior: interior.gain.value,
          interiorCutoff: interiorFilter.frequency.value,
        },
      };
    },
  };
}
