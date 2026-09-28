// Flight cues: the craft's instruments and mechanisms, driven by state.flight and typed events.
//
//   stall horn    on stall.warning: a buzzing reed horn (light aircraft) or a pulsed tone (jets)
//   variometer    climb beeps whose pitch and rate rise with the climb, a low tone in strong sink;
//                 for craft with a 'vario' instrument, unless the vario audio is switched off
//   gear motor    while state.flight.gear.transit (or gear.down) changes, then a lock clunk
//   flap motor    while state.flight.flaps moves (or briefly when flapNotch changes)
//   touchdown     'landed' event or a new ground contact: thump plus tire chirp (wheels), scrape
//                 (skids) or a soft body thud, scaled by sink rate and ground speed
//   detent click  afterburner engage/disengage, or crossing craftState.abDetent
//   soft crash    impact boom and a low-passed master (the mixer muffle) until the respawn
//
// Instrument sounds (horn, vario) use the ui bus, mechanisms (motors, detent) the engine bus and
// impacts the environment bus. Continuous cues own persistent nodes; one-shots share the voice pool.
import { clamp } from '../core/util.js';
import { glide, holdAt } from './synthKit.js';

const MOTOR_HOLD_SECONDS = 0.15;
const GEAR_EDGE_RUN_SECONDS = 0.6;
const FLAP_NOTCH_RUN_SECONDS = 0.5;
const TOUCHDOWN_GUARD_SECONDS = 0.35;
const DETENT_GUARD_SECONDS = 0.15;
const VARIO_LOOKAHEAD = 0.14;
const MUFFLE_MIN_SECONDS = 0.6;
const MUFFLE_MAX_SECONDS = 4;

/** kit: { context, noise, mixer, voices }. */
export function createFlightCues(kit) {
  const { context, noise, mixer, voices } = kit;
  const start = context.currentTime + 0.02;
  const persistentSources = [];

  function loopNoise(playbackRate, offset) {
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.playbackRate.value = playbackRate;
    persistentSources.push({ source, offset });
    return source;
  }

  function oscillator(type, frequency) {
    const node = context.createOscillator();
    node.type = type;
    node.frequency.value = frequency;
    persistentSources.push({ source: node, offset: null });
    return node;
  }

  function gain(value) {
    const node = context.createGain();
    node.gain.value = value;
    return node;
  }

  function filter(type, frequency, q) {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  // ---- Stall horn: two reedy squares through a resonant band, optionally pulsed -----------------
  const hornReed = oscillator('square', 1580);
  const hornBuzz = oscillator('sawtooth', 790);
  const hornVibrato = oscillator('sine', 6.5);
  const hornVibratoDepth = gain(14);
  hornVibrato.connect(hornVibratoDepth);
  hornVibratoDepth.connect(hornReed.frequency);
  const hornBand = filter('bandpass', 1750, 2.4);
  const hornBuzzLevel = gain(0.45);
  hornReed.connect(hornBand);
  hornBuzz.connect(hornBuzzLevel);
  hornBuzzLevel.connect(hornBand);
  // Pulse stage: gain = base + depth * square(t); base 1 / depth 0 is the continuous horn.
  const hornPulse = gain(1);
  const hornPulseLfo = oscillator('square', 5);
  const hornPulseDepth = gain(0);
  hornPulseLfo.connect(hornPulseDepth);
  hornPulseDepth.connect(hornPulse.gain);
  const hornGate = gain(0);
  hornBand.connect(hornPulse);
  hornPulse.connect(hornGate);
  hornGate.connect(mixer.input('ui'));

  // ---- Variometer: a climb-beep oscillator with scheduled envelopes and a steady sink tone --------
  const varioBeep = oscillator('triangle', 700);
  const varioBeepGate = gain(0);
  const varioSinkTone = oscillator('sine', 300);
  const varioSinkGain = gain(0);
  const varioLevel = gain(0.09);
  varioBeep.connect(varioBeepGate);
  varioBeepGate.connect(varioLevel);
  varioSinkTone.connect(varioSinkGain);
  varioSinkGain.connect(varioLevel);
  varioLevel.connect(mixer.input('ui'));

  // ---- Motors: gear (heavy, low) and flaps (light, higher), each a whirring band of harmonics -----
  function createMotor(baseHz, cutoff, level) {
    const drive = oscillator('sawtooth', baseHz);
    const second = oscillator('square', baseHz * 2.01);
    const secondLevel = gain(0.3);
    const whirr = oscillator('sine', 23);
    const whirrDepth = gain(0.25);
    const body = filter('bandpass', cutoff, 1.3);
    const trem = gain(0.75);
    whirr.connect(whirrDepth);
    whirrDepth.connect(trem.gain);
    const grind = loopNoise(1.1, 0.4);
    const grindFilter = filter('bandpass', cutoff * 2.2, 3);
    const grindLevel = gain(0.35);
    drive.connect(body);
    second.connect(secondLevel);
    secondLevel.connect(body);
    grind.connect(grindFilter);
    grindFilter.connect(grindLevel);
    grindLevel.connect(body);
    const output = gain(0);
    body.connect(trem);
    trem.connect(output);
    output.connect(mixer.input('engine'));
    return { drive, second, whirr, body, output, level, baseHz, cutoff };
  }
  const gearMotor = createMotor(92, 520, 0.16);
  const flapMotor = createMotor(176, 900, 0.1);

  for (const { source, offset } of persistentSources) {
    if (offset === null) source.start(start);
    else source.start(start, offset);
  }

  // ---- One-shots ------------------------------------------------------------------------------------
  // A one-shot is a shot { nodes, output, last }: every helper adds its nodes and keeps last
  // pointing at the source that stops latest, which releases the whole voice when it ends.
  function remember(shot, source, end) {
    if (!shot.last || end > shot.lastEnd) {
      shot.last = source;
      shot.lastEnd = end;
    }
  }

  /** A decaying sine sweep (thumps, booms and clunks). */
  function sweep(shot, { from, to, length, level, at, type = 'sine' }) {
    const tone = context.createOscillator();
    tone.type = type;
    tone.frequency.setValueAtTime(from, at);
    tone.frequency.exponentialRampToValueAtTime(to, at + length);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    tone.connect(envelope);
    envelope.connect(shot.output);
    tone.start(at);
    tone.stop(at + length + 0.03);
    shot.nodes.push(tone, envelope);
    remember(shot, tone, at + length + 0.03);
  }

  /** A filtered burst from the shared noise buffer. */
  function burst(shot, { type, frequency, endFrequency, q, length, level, at, attack = 0.004 }) {
    const source = context.createBufferSource();
    source.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = type;
    band.Q.value = q;
    band.frequency.setValueAtTime(frequency, at);
    if (endFrequency) band.frequency.exponentialRampToValueAtTime(endFrequency, at + length);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(band);
    band.connect(envelope);
    envelope.connect(shot.output);
    source.start(at, Math.random() * Math.max(0, noise.duration - length - 0.1));
    source.stop(at + length + 0.03);
    shot.nodes.push(source, band, envelope);
    remember(shot, source, at + length + 0.03);
  }

  /** Runs build(shot, at) as one pooled voice on a bus; returns false when the pool is full. */
  function oneShot(busName, level, build) {
    if (!voices.canStart()) return false;
    const at = context.currentTime + 0.01;
    const output = context.createGain();
    output.gain.value = level;
    output.connect(mixer.input(busName));
    const shot = { nodes: [output], output, last: null, lastEnd: 0 };
    build(shot, at);
    voices.track(shot.nodes, shot.last);
    return true;
  }

  function playTouchdown({ sinkRate = 1, groundSpeed = 20, surface = 'wheels', grade = null } = {}) {
    const impact = clamp(sinkRate / 3.5, 0.08, 1.4);
    const gradeScale = grade === 'butter' ? 0.55 : grade === 'hard' ? 1.25 : 1;
    const speed = clamp(groundSpeed / 35, 0, 1.3);
    return oneShot('environment', gradeScale, (shot, at) => {
      sweep(shot, { from: 95, to: 32, length: 0.35 + 0.25 * impact, level: 0.2 + 0.45 * impact, at });
      burst(shot, { type: 'lowpass', frequency: 260 + 200 * impact, q: 0.7, length: 0.12 + 0.1 * impact, level: 0.25 * impact, at });
      if (surface === 'wheels' && groundSpeed > 5) {
        // One chirp per main wheel, a few milliseconds apart: rubber spinning up against the runway.
        for (const [offset, pitch] of [[0, 1], [0.028 + Math.random() * 0.02, 0.93]]) {
          const chirpAt = at + offset;
          const chirpLength = 0.1 + 0.12 * speed;
          const chirpLevel = (0.05 + 0.1 * speed) * (0.5 + 0.5 * Math.min(impact, 1));
          sweep(shot, { from: 2150 * pitch, to: 1500 * pitch, length: chirpLength, level: chirpLevel * 0.6, at: chirpAt, type: 'triangle' });
          burst(shot, { type: 'bandpass', frequency: 2600 * pitch, endFrequency: 1700 * pitch, q: 5, length: chirpLength, level: chirpLevel * 1.6, at: chirpAt });
        }
      } else if (surface === 'skids') {
        burst(shot, { type: 'bandpass', frequency: 1100, endFrequency: 380, q: 1.4, length: 0.3 + 0.35 * speed, level: 0.06 + 0.12 * speed, at, attack: 0.02 });
      } else if (surface === 'body') {
        burst(shot, { type: 'highpass', frequency: 1800, q: 0.7, length: 0.18, level: 0.05, at: at + 0.02, attack: 0.01 });
      }
    });
  }

  function playClunk(level = 1) {
    return oneShot('engine', level, (shot, at) => {
      sweep(shot, { from: 180, to: 60, length: 0.16, level: 0.28, at });
      burst(shot, { type: 'bandpass', frequency: 900, q: 1.5, length: 0.07, level: 0.18, at });
    });
  }

  function playDetentClick(engaging = true) {
    const scale = engaging ? 1 : 0.7;
    return oneShot('engine', scale, (shot, at) => {
      burst(shot, { type: 'highpass', frequency: 2400, q: 0.8, length: 0.018, level: 0.35, at, attack: 0.001 });
      sweep(shot, { from: engaging ? 1500 : 1150, to: engaging ? 900 : 700, length: 0.035, level: 0.12, at, type: 'triangle' });
      sweep(shot, { from: 320, to: 140, length: 0.07, level: 0.16, at: at + 0.004 });
    });
  }

  function playCrash(impactSpeed = 30) {
    const level = clamp(impactSpeed / 50, 0.35, 1.2);
    return oneShot('environment', level, (shot, at) => {
      burst(shot, { type: 'lowpass', frequency: 1400, endFrequency: 160, q: 0.6, length: 0.9, level: 0.5, at, attack: 0.003 });
      sweep(shot, { from: 70, to: 26, length: 1.1, level: 0.6, at });
    });
  }

  // ---- State ----------------------------------------------------------------------------------------
  let hornActive = false;
  let hornStyle = 'horn';
  let varioOn = false;
  let nextBeepTime = 0;
  let varioMode = 'quiet';
  const motors = {
    gear: { synth: gearMotor, activeUntil: 0, running: false, runStart: 0, lastValue: null, lastDown: null },
    flaps: { synth: flapMotor, activeUntil: 0, running: false, runStart: 0, lastValue: null, lastNotch: null },
  };
  let lastOnGround = null;
  let lastAfterburner = null;
  let lastDetent = null;
  let lastDetentClickAt = -Infinity;
  let lastTouchdownAt = -Infinity;
  let muffleStartedAt = null;
  const readout = {
    horn: false,
    vario: { enabled: false, mode: 'quiet', climb: 0, frequency: 0, period: 0 },
    motors: { gear: false, flaps: false },
    touchdowns: 0,
    clicks: 0,
    clunks: 0,
    crashes: 0,
  };

  function setHorn(active, style, time) {
    if (style !== hornStyle) {
      hornStyle = style;
      glide(hornPulseDepth.gain, style === 'beep' ? 0.5 : 0, time, 0.01);
      glide(hornPulse.gain, style === 'beep' ? 0.5 : 1, time, 0.01);
      glide(hornReed.frequency, style === 'beep' ? 1020 : 1580, time, 0.01);
      glide(hornBuzz.frequency, style === 'beep' ? 510 : 790, time, 0.01);
      glide(hornBand.frequency, style === 'beep' ? 1100 : 1750, time, 0.01);
    }
    if (active === hornActive) return;
    hornActive = active;
    glide(hornGate.gain, active ? 0.075 : 0, time, active ? 0.015 : 0.04);
  }

  /** Climb-rate to beep pitch (Hz) and period (s), in the style of a sailplane audio vario. */
  function varioBeepFor(climb) {
    return {
      frequency: clamp(620 + 170 * climb, 620, 1900),
      period: clamp(0.62 - 0.09 * climb, 0.13, 0.62),
    };
  }

  function stopVario(time) {
    if (!varioOn && varioMode === 'quiet') return;
    holdAt(varioBeepGate.gain, time);
    varioBeepGate.gain.setTargetAtTime(0, time, 0.01);
    glide(varioSinkGain.gain, 0, time, 0.05);
    varioOn = false;
    varioMode = 'quiet';
    readout.vario.mode = 'quiet';
    readout.vario.frequency = 0;
    readout.vario.period = 0;
  }

  function updateVario(time, climb, profile) {
    varioOn = true;
    readout.vario.climb = climb;
    if (climb > profile.varioLift) {
      const beep = varioBeepFor(climb);
      if (varioMode !== 'lift') {
        varioMode = 'lift';
        nextBeepTime = Math.max(nextBeepTime, time + 0.02);
        glide(varioSinkGain.gain, 0, time, 0.03);
      }
      // Schedule every beep that starts inside the lookahead window at the current climb rate.
      while (nextBeepTime < time + VARIO_LOOKAHEAD) {
        const at = Math.max(nextBeepTime, time + 0.005);
        const length = beep.period * 0.52;
        varioBeep.frequency.setValueAtTime(beep.frequency, at);
        varioBeepGate.gain.setValueAtTime(0, at);
        varioBeepGate.gain.linearRampToValueAtTime(1, at + 0.008);
        varioBeepGate.gain.setValueAtTime(1, at + length - 0.012);
        varioBeepGate.gain.linearRampToValueAtTime(0, at + length);
        nextBeepTime = at + beep.period;
      }
      readout.vario.frequency = beep.frequency;
      readout.vario.period = beep.period;
    } else if (climb < profile.varioSink) {
      if (varioMode === 'lift') {
        holdAt(varioBeepGate.gain, time);
        varioBeepGate.gain.setTargetAtTime(0, time, 0.01);
      }
      varioMode = 'sink';
      const frequency = clamp(380 + 28 * climb, 170, 340);
      glide(varioSinkTone.frequency, frequency, time, 0.1);
      glide(varioSinkGain.gain, 0.7, time, 0.06);
      readout.vario.frequency = frequency;
      readout.vario.period = 0;
    } else {
      if (varioMode === 'sink') glide(varioSinkGain.gain, 0, time, 0.06);
      varioMode = 'quiet';
      readout.vario.frequency = 0;
      readout.vario.period = 0;
    }
    readout.vario.mode = varioMode;
  }

  function runMotor(motor, moving, time, pitch, load) {
    const { synth } = motor;
    if (moving) motor.activeUntil = Math.max(motor.activeUntil, time + MOTOR_HOLD_SECONDS);
    const running = time < motor.activeUntil;
    if (running && !motor.running) motor.runStart = time;
    const stoppedAfterRun = motor.running && !running && time - motor.runStart > 0.25;
    motor.running = running;
    const baseHz = synth.baseHz * pitch * (0.92 + 0.16 * load);
    glide(synth.drive.frequency, baseHz, time, 0.08);
    glide(synth.second.frequency, baseHz * 2.01, time, 0.08);
    glide(synth.whirr.frequency, 18 + 10 * load, time, 0.1);
    glide(synth.body.frequency, synth.cutoff * pitch, time, 0.1);
    glide(synth.output.gain, running ? synth.level : 0, time, running ? 0.04 : 0.07);
    return stoppedAfterRun;
  }

  function updateMotors(time, flight, profile) {
    const pitch = clamp(Number.isFinite(profile.motorPitch) ? profile.motorPitch : 1, 0.5, 2);
    const gear = flight.gear ?? {};
    const gearState = motors.gear;
    const transit = Number.isFinite(gear.transit) ? gear.transit : 0;
    let gearMoving = gearState.lastValue !== null && Math.abs(transit - gearState.lastValue) > 1e-4;
    // A model that flips gear.down without animating transit still gets a short motor run.
    if (gear.retractable && gearState.lastDown !== null && gear.down !== gearState.lastDown) {
      gearState.activeUntil = Math.max(gearState.activeUntil, time + GEAR_EDGE_RUN_SECONDS);
      gearMoving = true;
    }
    gearState.lastValue = transit;
    gearState.lastDown = gear.down;
    if (runMotor(gearState, gearMoving, time, pitch, clamp(transit, 0, 1))) {
      playClunk(0.9);
      readout.clunks++;
    }

    const flapState = motors.flaps;
    const flaps = Number.isFinite(flight.flaps) ? flight.flaps : 0;
    let flapsMoving = flapState.lastValue !== null && Math.abs(flaps - flapState.lastValue) > 1e-4;
    // Likewise a notch change the model applies in one step runs the flap motor briefly.
    const notch = Number.isFinite(flight.flapNotch) ? flight.flapNotch : 0;
    if (flapState.lastNotch !== null && notch !== flapState.lastNotch) {
      flapState.activeUntil = Math.max(flapState.activeUntil, time + FLAP_NOTCH_RUN_SECONDS);
      flapsMoving = true;
    }
    flapState.lastValue = flaps;
    flapState.lastNotch = notch;
    runMotor(flapState, flapsMoving, time, pitch, clamp(flaps, 0, 1));
    readout.motors.gear = gearState.running;
    readout.motors.flaps = flapState.running;
  }

  function updateContacts(realTime, flight, profile) {
    const onGround = flight.onGround === true;
    if (lastOnGround === false && onGround && realTime - lastTouchdownAt > TOUCHDOWN_GUARD_SECONDS) {
      const sinkRate = Math.max(0, -(Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed : 0));
      lastTouchdownAt = realTime;
      playTouchdown({ sinkRate, groundSpeed: flight.groundSpeed ?? 0, surface: profile.touchdown });
      readout.touchdowns++;
    }
    lastOnGround = onGround;
  }

  function updateDetent(realTime, flight) {
    const afterburner = flight.afterburner === true;
    const detent = typeof flight.craftState?.abDetent === 'boolean' ? flight.craftState.abDetent : null;
    let click = null;
    if (lastAfterburner !== null && afterburner !== lastAfterburner) click = afterburner;
    if (detent !== null && lastDetent !== null && detent !== lastDetent) click = detent;
    lastAfterburner = afterburner;
    lastDetent = detent;
    if (click === null || realTime - lastDetentClickAt < DETENT_GUARD_SECONDS) return;
    lastDetentClickAt = realTime;
    playDetentClick(click);
    readout.clicks++;
  }

  function updateMuffle(time, realTime, flight) {
    if (muffleStartedAt === null) return;
    const elapsed = realTime - muffleStartedAt;
    const crashActive = flight.crash?.active === true;
    if ((elapsed > MUFFLE_MIN_SECONDS && !crashActive) || elapsed > MUFFLE_MAX_SECONDS) {
      muffleStartedAt = null;
      mixer.setMuffled(false, time);
    }
  }

  return {
    /**
     * frame fields used: time, realTime, flight, profile, paused, varioSetting ('on'|'off').
     * Called at the parameter interval.
     */
    update(frame) {
      const { time, realTime, flight, profile } = frame;
      const warning = profile.stallHorn && flight.stall?.warning === true && flight.onGround !== true;
      setHorn(warning, profile.stallHornStyle === 'beep' ? 'beep' : 'horn', time);
      readout.horn = warning;

      const varioAllowed = profile.vario && frame.varioSetting !== 'off';
      const climb = Number.isFinite(flight.vario) ? flight.vario : Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed : 0;
      if (varioAllowed && flight.onGround !== true && !frame.paused) updateVario(time, climb, profile);
      else stopVario(time);
      readout.vario.enabled = varioOn;

      updateMotors(time, flight, profile);
      updateContacts(realTime, flight, profile);
      updateDetent(realTime, flight);
      updateMuffle(time, realTime, flight);
    },

    /** Typed 'landed': the graded touchdown (a contact edge in the same moment is not repeated). */
    landed(payload, realTime, profile) {
      if (realTime - lastTouchdownAt < TOUCHDOWN_GUARD_SECONDS) return;
      lastTouchdownAt = realTime;
      lastOnGround = true;
      playTouchdown({
        sinkRate: Number.isFinite(payload?.sinkRate) ? payload.sinkRate : 1,
        groundSpeed: Number.isFinite(payload?.groundSpeed) ? payload.groundSpeed : 20,
        surface: profile.touchdown,
        grade: payload?.grade ?? null,
      });
      readout.touchdowns++;
    },

    /** Typed 'softCrash': impact boom and the master muffle until the respawn. */
    softCrash(payload, realTime) {
      playCrash(Number.isFinite(payload?.impactSpeed) ? payload.impactSpeed : 30);
      mixer.setMuffled(true, context.currentTime);
      muffleStartedAt = realTime;
      readout.crashes++;
    },

    /** Silences the continuous cues at once (craft change, mode change). */
    reset(time) {
      setHorn(false, hornStyle, time);
      stopVario(time);
      for (const motor of Object.values(motors)) {
        motor.activeUntil = 0;
        motor.lastValue = null;
        glide(motor.synth.output.gain, 0, time, 0.05);
      }
      motors.gear.lastDown = null;
      motors.flaps.lastNotch = null;
      lastOnGround = null;
      lastAfterburner = null;
      lastDetent = null;
    },

    /** One-shot auditions (dev tools): touchdown, clunk, detent, crash. */
    audition: { playTouchdown, playClunk, playDetentClick, playCrash },

    describe() {
      return {
        ...readout,
        vario: { ...readout.vario },
        motors: { ...readout.motors },
        levels: {
          horn: hornGate.gain.value,
          hornFrequency: hornReed.frequency.value,
          varioBeep: varioBeepGate.gain.value,
          varioSink: varioSinkGain.gain.value,
          gearMotor: gearMotor.output.gain.value,
          flapMotor: flapMotor.output.gain.value,
        },
        muffled: mixer.muffled,
      };
    },
  };
}
