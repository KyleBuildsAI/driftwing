// AudioEngine: the procedural Web Audio system (no audio files). createAudioSystem(ctx) is the
// 'audio' system factory.
//
// - The AudioContext is created only inside a user activation ('user:gesture', a key, a pointer
//   press or a gamepad button the browser counts as one) and resumed only after the page has had
//   one, so the autoplay policy never has anything to warn about. Until then every method is a
//   silent no-op. When the context is still not running once the game is ready and the player has
//   interacted (or 5 s have passed), a small glass "Sound off - click to enable" pill appears.
// - Mixer buses master, engine, environment, ui, copilot and music (see mixer.js), levels from
//   settings.mixer. Everything but the copilot bus ducks while the copilot speaks; photo mode dips
//   the master as in v1; a soft crash muffles it.
// - Airflow beds (airflow.js), the craft's engine family (engines/), spatialisation with doppler
//   (spatial.js), flight cues (flightCues.js), v1 event cues and one-shot voices (eventCues.js,
//   voices.js) and radar-altitude landing callouts (callouts.js).
import { clamp } from '../core/util.js';
import { createSoundPill } from '../ui/soundPill.js';
import { createAirflow } from './airflow.js';
import { createBufferFactory } from './buffers.js';
import { createCallouts } from './callouts.js';
import { ENGINE_FAMILIES, resolveAudioProfile } from './engines/index.js';
import { createEventCues } from './eventCues.js';
import { createFlightCues } from './flightCues.js';
import { BUS_NAMES, createMixer } from './mixer.js';
import { createSpatializer } from './spatial.js';
import { createVoices } from './voices.js';

const PARAMETER_INTERVAL = 0.05;
const PHOTO_MODE_LEVEL = 0.55;
const PILL_DELAY_SECONDS = 5;
const PILL_DEBOUNCE_SECONDS = 0.4;
const SPEECH_START_GRACE = 0.8;
const INTERIOR_VIEWS = new Set(['cockpit', 'fpv']);
// Input sources whose presses reach the page as real DOM events (and so unlock audio themselves).
const DOM_SOURCES = new Set(['keyboard', 'mouse', 'touch']);
const VARIO_STORAGE_KEY = 'driftwing-v2.audio.vario';
export const VARIO_MODES = Object.freeze(['on', 'off']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !value.isVector3 && !value.isQuaternion;
}

export function createAudioSystem(ctx) {
  const { THREE, bus, settings, state, camera, storage } = ctx;
  const params = new URLSearchParams(window.location.search);
  const debugEnabled = import.meta.env.DEV || params.get('debug') === '1' || params.has('test');

  let audioContext = null;
  let graph = null;
  let status = 'locked';
  let lastIssue = null;
  let parameterTimer = 0;
  let masterTimeConstant = 0.9;
  let view = 'chase';
  let lastCameraCuts = null;
  let readyAt = null;
  let gamepadRefused = false;
  let notRunningFor = 0;
  let duckRequested = false;
  let duckGraceUntil = 0;
  let debugProfile = null;
  let debugFlight = null;
  let lastProfile = null;
  // A value no longer offered (Phase 1 also stored 'auto') reads as the default.
  const storedVarioMode = storage.read(VARIO_STORAGE_KEY, 'on');
  let varioMode = VARIO_MODES.includes(storedVarioMode) ? storedVarioMode : 'on';

  function noteIssue(error) {
    lastIssue = error && error.message ? error.message : String(error);
  }

  function isReady() {
    return audioContext !== null && graph !== null;
  }

  function isRunning() {
    return audioContext !== null && audioContext.state === 'running';
  }

  /** Transient activation: the only moment an AudioContext may be created. */
  function hasActivation() {
    const activation = navigator.userActivation;
    if (activation && typeof activation.isActive === 'boolean') return activation.isActive;
    return ctx.userHasInteracted === true;
  }

  /** Sticky activation: once the page has had one, a suspended context may be resumed. */
  function hasStickyActivation() {
    const activation = navigator.userActivation;
    if (activation && typeof activation.hasBeenActive === 'boolean') return activation.hasBeenActive;
    return ctx.userHasInteracted === true;
  }

  const buffers = createBufferFactory(noteIssue);
  const callouts = createCallouts({
    settings,
    getUserActivated: () => ctx.userHasInteracted === true,
    getCopilotVoiceName: () => ctx.systems.copilot?.getStats?.().voice ?? null,
    onIssue: noteIssue,
  });
  const eventCues = createEventCues({ bus, state, camera, THREE, isReady, voices: () => graph.voices });
  const pill = createSoundPill({ onEnable: enableFromPill });

  // ---- Graph -----------------------------------------------------------------------------------------
  function buildGraph(context) {
    const { noise, reverb } = buffers.take(context);
    const mixer = createMixer(context, reverb);
    mixer.initLevels(settings.get('mixer'));
    const kit = { context, noise, mixer };
    const voices = createVoices(kit);
    return {
      context,
      noise,
      mixer,
      voices,
      airflow: createAirflow(kit),
      spatializer: createSpatializer({ context, destination: mixer.input('engine'), THREE }),
      flightCues: createFlightCues({ ...kit, voices }),
      engine: null,
      engineProfile: null,
    };
  }

  /** Builds (or swaps to) the engine synth for a resolved profile; the old one fades out. */
  function ensureEngine(profile, time) {
    if (graph.engine && graph.engineProfile === profile) return;
    const hadEngine = graph.engine !== null;
    if (hadEngine) graph.engine.stop(time);
    const kit = { context: audioContext, noise: graph.noise, destination: graph.spatializer.input };
    try {
      graph.engine = ENGINE_FAMILIES[profile.engine].create(kit, profile);
    } catch (error) {
      console.error(`[DRIFTWING] audio engine family "${profile.engine}" failed; using the glider sound`, error);
      noteIssue(error);
      graph.engine = ENGINE_FAMILIES.glider.create(kit, resolveAudioProfile(null));
    }
    graph.engineProfile = profile;
    if (hadEngine) graph.flightCues.reset(time);
  }

  // ---- Unlock ----------------------------------------------------------------------------------------
  function resumeIfSuspended() {
    if (!audioContext || audioContext.state === 'running' || audioContext.state === 'closed') return;
    if (document.hidden || !hasStickyActivation()) return;
    audioContext.resume().catch(noteIssue);
  }

  /** Creates the context (inside a user activation) or resumes it. Returns whether audio is on its way. */
  function unlock() {
    if (status === 'unavailable') return false;
    if (audioContext) {
      resumeIfSuspended();
      return hasStickyActivation();
    }
    if (!hasActivation()) return false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
      status = 'unavailable';
      lastIssue = 'Web Audio is not supported in this browser.';
      return false;
    }
    try {
      audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      graph = buildGraph(audioContext);
    } catch (error) {
      status = 'unavailable';
      noteIssue(error);
      console.error('[DRIFTWING] audio engine failed to start', error);
      if (audioContext) audioContext.close().catch(noteIssue);
      audioContext = null;
      graph = null;
      return false;
    }
    status = audioContext.state;
    audioContext.addEventListener('statechange', () => {
      if (audioContext) status = audioContext.state;
    });
    parameterTimer = 0;
    resumeIfSuspended();
    bus.emit('audio:started', { context: audioContext });
    return true;
  }

  function onActivationInput() {
    if (!audioContext) unlock();
    else resumeIfSuspended();
  }

  function enableFromPill() {
    gamepadRefused = false;
    onActivationInput();
  }

  bus.on('user:gesture', unlock);
  // Touch pointerdown is not an activation in every browser; later presses, taps and keys retry.
  window.addEventListener('pointerdown', onActivationInput, { passive: true });
  window.addEventListener('pointerup', onActivationInput, { passive: true });
  window.addEventListener('keydown', onActivationInput);
  window.addEventListener('touchend', onActivationInput, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!audioContext) return;
    if (document.hidden) audioContext.suspend().catch(noteIssue);
    else resumeIfSuspended();
  });
  // Gamepad and HOTAS buttons (any input:action source that is not a DOM device): Chrome may not
  // count them as a user activation. When it does not, the refusal is remembered and the sound
  // pill offers a click instead.
  bus.on('input:action', (payload) => {
    if (!payload || payload.phase !== 'press' || DOM_SOURCES.has(payload.source) || isRunning()) return;
    if (!unlock()) gamepadRefused = true;
  });

  // ---- Sound-off pill -------------------------------------------------------------------------------
  function updatePill(realDt) {
    const eligible = state.ready && status !== 'unavailable' && !state.photoMode && !document.hidden && !isRunning();
    if (!eligible) {
      notRunningFor = 0;
      pill.setVisible(false);
      return;
    }
    notRunningFor += realDt;
    const interacted = ctx.userHasInteracted === true || gamepadRefused;
    const waited = readyAt !== null && state.time.realElapsed - readyAt >= PILL_DELAY_SECONDS;
    pill.setVisible(notRunningFor >= PILL_DEBOUNCE_SECONDS && (interacted || waited));
  }

  // ---- Copilot ducking ------------------------------------------------------------------------------
  /** Mirrors the copilot's own speak() conditions: no ducking for a line that will not be voiced. */
  function copilotWillSpeak() {
    return 'speechSynthesis' in window && ctx.userHasInteracted === true && settings.get('copilotVoice') === true
      && Number(settings.get('masterVolume')) >= 0.01;
  }

  function speechActive() {
    const synth = window.speechSynthesis;
    return Boolean(synth && (synth.speaking || synth.pending) && !callouts.speaking);
  }

  function updateDuck(time) {
    if (duckRequested && state.time.realElapsed >= duckGraceUntil && !speechActive()) duckRequested = false;
    graph.mixer.setDucked(duckRequested, time);
  }

  // ---- Events ----------------------------------------------------------------------------------------
  bus.on('game:ready', () => {
    readyAt = state.time.realElapsed;
  });
  bus.on('copilot:speech', () => {
    if (!copilotWillSpeak()) return;
    duckRequested = true;
    duckGraceUntil = state.time.realElapsed + SPEECH_START_GRACE;
  });
  bus.on('settings:changed', (payload) => {
    if (!payload) return;
    if ((payload.key === 'mixer' || payload.key === 'masterVolume') && isReady()) {
      graph.mixer.applyLevels(settings.get('mixer'), audioContext.currentTime);
      parameterTimer = 0;
    }
    if (payload.key === 'hud') parameterTimer = 0;
  });
  bus.onTyped('viewChanged', (payload) => {
    if (payload && typeof payload.view === 'string') view = payload.view;
    parameterTimer = 0;
  });
  bus.onTyped('craftChanged', () => {
    callouts.cancel();
    parameterTimer = 0;
  });
  bus.onTyped('landed', (payload) => {
    if (isReady()) graph.flightCues.landed(payload, state.time.realElapsed, currentProfile());
  });
  bus.onTyped('softCrash', (payload) => {
    callouts.cancel();
    if (isReady()) graph.flightCues.softCrash(payload, state.time.realElapsed);
  });

  // ---- Per-update frame ------------------------------------------------------------------------------
  /** state.flight, or with the dev overrides merged over it (nested objects merge one level). */
  function flightView() {
    const flight = state.flight;
    if (!debugFlight) return flight;
    const merged = { ...flight };
    for (const [key, value] of Object.entries(debugFlight)) {
      merged[key] = isPlainObject(value) && isPlainObject(flight[key]) ? { ...flight[key], ...value } : value;
    }
    return merged;
  }

  /** The resolved audioProfile of the craft flying now (or the audition profile). */
  function resolveProfileFor(flight) {
    if (debugProfile) return resolveAudioProfile(debugProfile, debugProfile.instruments);
    const module = ctx.craftRegistry?.get?.(flight.craft) ?? null;
    return resolveAudioProfile(module?.audioProfile ?? null, module?.instruments);
  }

  function currentProfile() {
    return lastProfile ?? resolveProfileFor(flightView());
  }

  const frame = {
    time: 0,
    realTime: 0,
    interval: PARAMETER_INTERVAL,
    paused: false,
    interior: false,
    cameraAttached: true,
    view,
    player: state.player,
    flight: state.flight,
    controls: ctx.controls,
    profile: null,
    camera,
    varioSetting: varioMode,
  };

  function buildFrame(interval) {
    const flight = flightView();
    const player = state.player;
    frame.time = audioContext ? audioContext.currentTime : 0;
    frame.realTime = state.time.realElapsed;
    frame.interval = interval;
    frame.paused = state.paused === true;
    frame.view = view;
    frame.interior = INTERIOR_VIEWS.has(view);
    frame.cameraAttached = !state.photoMode && view !== 'flyby';
    frame.player = player;
    frame.flight = flight;
    frame.controls = ctx.controls;
    frame.profile = resolveProfileFor(flight);
    frame.varioSetting = varioMode;
    lastProfile = frame.profile;
    return frame;
  }

  function updateSound() {
    const time = frame.time;
    ensureEngine(frame.profile, time);
    // A camera cut (view change, flyby relocation, re-seat) is not listener motion for the doppler.
    const cameraCuts = ctx.systems.camera?.getCutCount?.() ?? null;
    if (cameraCuts !== lastCameraCuts) {
      lastCameraCuts = cameraCuts;
      graph.spatializer.cut();
    }
    const pitch = graph.spatializer.update(frame);
    graph.engine.update(frame, pitch);
    graph.airflow.update(frame);
    graph.flightCues.update(frame);
    updateDuck(time);
    const volume = clamp(Number(settings.get('masterVolume')) || 0, 0, 1);
    graph.mixer.setMaster(volume * (state.photoMode ? PHOTO_MODE_LEVEL : 1), time, masterTimeConstant);
    masterTimeConstant = 0.25;
    graph.mixer.settle(time);
  }

  // ---- Diagnostics -----------------------------------------------------------------------------------
  let analyserSamples = null;
  /** RMS level of the final output in dBFS (-Infinity when silent). */
  function outputLevel() {
    const analyser = graph.mixer.analyser;
    if (!analyserSamples) analyserSamples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(analyserSamples);
    let sum = 0;
    for (const sample of analyserSamples) sum += sample * sample;
    const rms = Math.sqrt(sum / analyserSamples.length);
    return rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -Infinity;
  }

  function getStats() {
    const base = {
      state: audioContext ? audioContext.state : status,
      voices: graph ? graph.voices.active : 0,
      sampleRate: audioContext ? audioContext.sampleRate : null,
      issue: lastIssue,
      view,
      varioMode,
      pill: pill.visible,
      gamepadRefused,
      callouts: callouts.describe(),
    };
    if (!isReady()) return base;
    return {
      ...base,
      family: graph.engine ? graph.engine.family : null,
      profile: graph.engineProfile ? { ...graph.engineProfile } : null,
      ducked: graph.mixer.ducked,
      muffled: graph.mixer.muffled,
      buses: graph.mixer.describe(),
      outputDb: outputLevel(),
      engine: graph.engine ? graph.engine.describe() : null,
      spatial: graph.spatializer.describe(),
      airflow: graph.airflow.describe(),
      cues: graph.flightCues.describe(),
      pendingEventCues: eventCues.pending,
    };
  }

  // ---- Dev auditions ---------------------------------------------------------------------------------
  function createDebugTools() {
    const auditions = {
      touchdown: (options) => graph.flightCues.audition.playTouchdown(options),
      clunk: (options) => graph.flightCues.audition.playClunk(options?.level),
      detent: (options) => graph.flightCues.audition.playDetentClick(options?.engaging !== false),
      crash: (options) => graph.flightCues.audition.playCrash(options?.impactSpeed),
      chime: (options) => graph.voices.playChime(options?.step ?? 0, options),
      blip: (options) => graph.voices.playBlip(options),
      flutter: (options) => graph.voices.playFlutter(options?.intensity, options?.pan),
      shutter: () => graph.voices.playShutter(),
    };
    return {
      families: Object.keys(ENGINE_FAMILIES),
      cues: [...Object.keys(auditions), 'callout'],

      /** Auditions an engine family: profile { engine, ...parameters }, or null for the craft's own. */
      setProfile(profile) {
        debugProfile = isPlainObject(profile) ? Object.freeze({ ...profile }) : null;
        parameterTimer = 0;
        return true;
      },

      /** Overrides state.flight fields (merged over the live telemetry every update); null clears. */
      drive(fields) {
        debugFlight = isPlainObject(fields) ? { ...fields } : null;
        parameterTimer = 0;
        return true;
      },

      /** Plays one cue now. Returns whether it started. */
      cue(name, options) {
        if (name === 'callout') return callouts.audition(options?.word ?? 'fifty', state.time.realElapsed);
        if (!isReady() || !auditions[name]) return false;
        return auditions[name](options);
      },

      /** Runs the parameter update on the next frame instead of waiting for the interval. */
      refresh() {
        parameterTimer = 0;
        return true;
      },
    };
  }

  return {
    update(dt, realDt) {
      updatePill(realDt);
      if (isReady()) eventCues.flush();
      parameterTimer -= realDt;
      if (parameterTimer > 0) return;
      parameterTimer = PARAMETER_INTERVAL;
      buildFrame(PARAMETER_INTERVAL);
      callouts.update(frame);
      if (isReady()) updateSound();
    },
    unlock,
    chime(step, options) {
      eventCues.markDirect('chime');
      return isReady() ? graph.voices.playChime(step, options) : false;
    },
    blip(options) {
      eventCues.markDirect('blip');
      return isReady() ? graph.voices.playBlip(options) : false;
    },
    flutter(options) {
      eventCues.markDirect('flutter');
      return isReady() ? graph.voices.playFlutter(options && options.intensity, options && options.pan) : false;
    },

    /** A mixer bus input node (master, engine, environment, ui, copilot, music); null before audio starts. */
    getBus(name) {
      if (!isReady() || !BUS_NAMES.includes(name)) return null;
      return name === 'master' ? graph.mixer.master : graph.mixer.input(name);
    },

    /** The AudioContext once audio has started (see the 'audio:started' event), else null. */
    getContext() {
      return audioContext;
    },

    /** Variometer audio: 'on' (craft with a vario) or 'off'. Persisted. */
    setVarioMode(mode) {
      if (!VARIO_MODES.includes(mode)) return false;
      varioMode = mode;
      storage.write(VARIO_STORAGE_KEY, mode);
      parameterTimer = 0;
      return true;
    },
    getVarioMode() {
      return varioMode;
    },

    getStats,
    debug: debugEnabled ? createDebugTools() : null,
  };
}
