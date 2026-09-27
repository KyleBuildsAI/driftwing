import { clamp } from './util.js';
import { CONFIG } from './config.js';


// ============================================================================
// PERFORMANCE: frame target, dynamic resolution (stage one) and the v1 quality
// governor (stage two).
//
// The loop renders uncapped through setAnimationLoop. The frame target is the measured display
// refresh ('auto') or an explicit rate, never more than the display can show; 'uncapped' holds no
// target and only defends a 30 fps floor. Stage one steps the render scale between 0.6 and 1.0 to
// hold the target: down quickly when frames run long, up slowly when they meet it, and an up-step
// that fails is blocked for a growing time so the scale never oscillates. Stage two is v1's
// governor (view distance, densities, pixel ratio): it only degrades once the scale is pinned at
// 0.6 and only upgrades at 1.0 with headroom.
// ============================================================================

export const COMMON_REFRESH_RATES = Object.freeze([60, 75, 90, 120, 144, 165, 240]);
export const RENDER_SCALE_STEPS = Object.freeze([1, 0.9, 0.8, 0.7, 0.6]);
/** Frame rate the 'uncapped' preference still defends by lowering the render scale. */
export const UNCAPPED_FLOOR_FPS = 30;
/** Frame target used until (or instead of) a display measurement. */
const FALLBACK_REFRESH_HZ = 60;

/** How close (fraction) a measured rate must be to a common display rate to snap to it. */
const SNAP_TOLERANCE = 0.06;
/** Stage one: frames this much over the target for DOWN_DWELL seconds step the scale down. */
const DOWN_THRESHOLD = 1.12;
const DOWN_DWELL = 0.5;
/** Stage one: frames under this fraction of the target for UP_DWELL seconds try a step up. */
const UP_THRESHOLD = 1.04;
const UP_DWELL = 3;
/** Seconds after a step during which stage one only watches (the new scale settles). */
const HOLD_AFTER_DOWN = 0.75;
const HOLD_AFTER_UP = 1.5;
/** An up-step that has to be undone within this many seconds failed; it is then blocked. */
const FAILED_UP_WINDOW = 4;
const BLOCK_SECONDS_FIRST = 8;
const BLOCK_SECONDS_MAX = 64;
/** Frames behind the loading fade are slow by design, and the first seconds after it settle caches. */
const SETTLE_SECONDS = 4;
const SCALE_HISTORY_LIMIT = 40;

/**
 * Snaps a measured refresh rate (Hz) to the nearest common display rate when within 6 %, else
 * rounds it (strict: returns null instead, for estimates that may not be vsync-bound at all).
 */
export function snapRefreshRate(hz, strict = false) {
  if (!(hz > 0)) return null;
  let best = null;
  for (const rate of COMMON_REFRESH_RATES) {
    const error = Math.abs(hz - rate) / rate;
    if (error <= SNAP_TOLERANCE && (best === null || error < Math.abs(hz - best) / best)) best = rate;
  }
  if (best !== null) return best;
  return strict ? null : Math.round(hz);
}

/** Median of the intervals between consecutive timestamps (ms), or NaN when there are too few. */
function medianInterval(timestamps) {
  const intervals = [];
  for (let index = 1; index < timestamps.length; index++) intervals.push(timestamps[index] - timestamps[index - 1]);
  if (intervals.length < 8) return NaN;
  intervals.sort((first, second) => first - second);
  return intervals[Math.floor(intervals.length / 2)];
}

/**
 * Measures the display refresh from requestAnimationFrame timestamps during an idle window (boot
 * awaits storage and the GPU adapter meanwhile, so the main thread is quiet). Resolves
 * { hz, measuredHz, intervalMs, samples } or null when too few frames arrived before the timeout
 * (a hidden tab gets no animation frames).
 */
export function measureDisplayRefresh({ frames = 40, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const timestamps = [];
    let handle = 0;
    let finished = false;
    let timer = 0;
    function finish() {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(handle);
      clearTimeout(timer);
      const intervalMs = medianInterval(timestamps);
      if (!(intervalMs > 0)) {
        resolve(null);
        return;
      }
      const measuredHz = 1000 / intervalMs;
      resolve({ hz: snapRefreshRate(measuredHz), measuredHz, intervalMs, samples: timestamps.length - 1 });
    }
    function onFrame(time) {
      timestamps.push(time);
      if (timestamps.length > frames) finish();
      else handle = requestAnimationFrame(onFrame);
    }
    timer = setTimeout(finish, timeoutMs);
    handle = requestAnimationFrame(onFrame);
  });
}

/**
 * The performance governor. update({ frameMs, cpuMs }) runs once per frame with the unclamped
 * frame interval and the CPU time of the previous frame. Options: devHooks enables
 * simulateLoad() (dev builds and ?debug=1).
 */
export function createPerfGovernor(ctx, { devHooks = false } = {}) {
  const { renderer, settings, bus, state } = ctx;
  const levels = CONFIG.QUALITY_LEVELS;
  const fixedIndex = { minimal: 0, low: 1, medium: 2, high: 3, ultra: 4 };
  const recentFrameMs = new Float32Array(120);
  const sortScratch = new Float32Array(120);
  let recentCount = 0;
  let recentCursor = 0;
  let intervalTimer = 0;
  let displayIntervalMs = 1000 / 60;
  let levelIndex = 3;
  let emaMs = 16.7;
  /**
   * What both stages hold against the target: the same average, but each frame counts for at most
   * twice the target. A lone hitch (a pipeline compile, a GC pause) cannot be fixed by rendering
   * fewer pixels, so it must not push the scale down; sustained slow frames still do.
   */
  let controlEmaMs = 16.7;
  let cpuEmaMs = 4;
  let readySince = null;
  let lastFrameMs = 0;
  /** Wall-clock seconds of measured frames (the sim clock clamps long frames; this must not). */
  let clockSeconds = 0;

  // Display refresh: measured at startup, refined by the running vsync estimate. A browser under
  // automation (WebDriver, headless test runs) paces animation frames without a display, so its
  // measurement is recorded but the frame target falls back to 60 Hz.
  const refresh = { hz: null, measuredHz: null, samples: 0, source: 'pending' };
  const automated = navigator.webdriver === true;

  // Stage one: dynamic resolution.
  let scaleIndex = 0;
  let scaleOverSeconds = 0;
  let scaleUnderSeconds = 0;
  let scaleHold = 0;
  let lastUpStepAt = -Infinity;
  const upBlockedUntil = new Array(RENDER_SCALE_STEPS.length).fill(0);
  const upBlockSeconds = new Array(RENDER_SCALE_STEPS.length).fill(BLOCK_SECONDS_FIRST);
  const scaleHistory = [];

  // Stage two: v1 quality levels.
  let slowSeconds = 0;
  let fastSeconds = 0;
  let cooldown = 3;
  const blockedUntil = new Array(levels.length).fill(0);

  let simulatedLoad = null;
  let captureActive = false;

  function renderScale() {
    return RENDER_SCALE_STEPS[scaleIndex];
  }
  function basePixelRatio() {
    return Math.min(window.devicePixelRatio || 1, levels[levelIndex].pixelRatio);
  }
  /**
   * Applies the render scale. With the post pipeline the scene pass renders at the scale and the
   * cheap output pass stays at full resolution; without it the renderer pixel ratio carries it.
   */
  function applyRenderScale() {
    if (captureActive) return;
    const post = ctx.post;
    const scale = renderScale();
    if (post && typeof post.setRenderScale === 'function') {
      post.setRenderScale(scale);
      if (renderer.getPixelRatio() !== basePixelRatio()) renderer.setPixelRatio(basePixelRatio());
    } else if (renderer.getPixelRatio() !== basePixelRatio() * scale) {
      renderer.setPixelRatio(basePixelRatio() * scale);
    }
    state.perf.renderScale = scale;
  }

  function apply(index, reason) {
    levelIndex = clamp(index, 0, levels.length - 1);
    const level = levels[levelIndex];
    Object.assign(ctx.quality, level, { levelIndex, auto: settings.get('quality') === 'auto' });
    applyRenderScale();
    state.perf.quality = level.name;
    state.perf.qualityIndex = levelIndex;
    bus.emit('quality:changed', { ...ctx.quality, reason });
  }
  function fromSettings() {
    const preference = settings.get('quality');
    apply(preference in fixedIndex ? fixedIndex[preference] : 3, 'settings');
  }

  function setScaleIndex(index, reason) {
    const next = clamp(index, 0, RENDER_SCALE_STEPS.length - 1);
    if (next === scaleIndex) return;
    const stepUp = next < scaleIndex;
    scaleIndex = next;
    scaleOverSeconds = 0;
    scaleUnderSeconds = 0;
    scaleHold = stepUp ? HOLD_AFTER_UP : HOLD_AFTER_DOWN;
    if (stepUp) lastUpStepAt = clockSeconds;
    applyRenderScale();
    scaleHistory.push({ time: Math.round(clockSeconds * 100) / 100, scale: renderScale(), reason, frameMs: Math.round(controlEmaMs * 10) / 10 });
    if (scaleHistory.length > SCALE_HISTORY_LIMIT) scaleHistory.shift();
    bus.emit('perf:renderScale', { scale: renderScale(), reason });
  }

  /** Frame target (Hz or null for uncapped) and the frame time (ms) the governors hold. */
  function resolveTarget() {
    const preference = settings.get('frameTarget');
    const displayHz = refresh.hz ?? FALLBACK_REFRESH_HZ;
    let targetHz = null;
    if (preference === 'auto') targetHz = displayHz;
    else if (Number.isFinite(preference)) targetHz = Math.min(preference, displayHz);
    state.perf.frameTarget = preference;
    state.perf.displayHz = displayHz;
    state.perf.targetHz = targetHz;
    state.perf.targetMs = targetHz ? 1000 / targetHz : null;
    return targetHz ? 1000 / targetHz : 1000 / UNCAPPED_FLOOR_FPS;
  }

  /** Display refresh interval: a low percentile of recent frame times (vsync-bound frames). */
  function estimateDisplayInterval() {
    sortScratch.set(recentFrameMs.subarray(0, recentCount));
    const sorted = sortScratch.subarray(0, recentCount).sort();
    return clamp(sorted[Math.floor(recentCount * 0.2)], 3.5, 40);
  }
  /**
   * The startup measurement is the reference; the running estimate only replaces it when frames
   * prove the display is faster (the window moved to a faster monitor, or startup was busy).
   */
  function refineRefresh() {
    if (automated) return;
    const estimatedHz = snapRefreshRate(1000 / displayIntervalMs, true);
    if (!estimatedHz) return;
    if (refresh.hz === null || estimatedHz > refresh.hz * 1.08) {
      refresh.hz = estimatedHz;
      refresh.source = refresh.source === 'measured' ? 'refined' : 'estimated';
      state.perf.refreshHz = refresh.hz;
      state.perf.refreshSource = refresh.source;
    }
  }

  function updateDynamicResolution(realDt, controlMs) {
    if (!settings.get('dynamicResolution')) {
      if (scaleIndex !== 0) setScaleIndex(0, 'disabled');
      return;
    }
    const now = clockSeconds;
    if (scaleHold > 0) {
      scaleHold -= realDt;
      return;
    }
    const over = controlEmaMs > controlMs * DOWN_THRESHOLD;
    const under = controlEmaMs < controlMs * UP_THRESHOLD;
    scaleOverSeconds = over ? scaleOverSeconds + realDt : 0;
    scaleUnderSeconds = under ? scaleUnderSeconds + realDt : 0;
    if (scaleOverSeconds >= DOWN_DWELL && scaleIndex < RENDER_SCALE_STEPS.length - 1) {
      // Undoing an up-step that just happened: that scale is not sustainable, so block it for a
      // while, twice as long each time it fails again.
      if (now - lastUpStepAt < FAILED_UP_WINDOW) {
        upBlockedUntil[scaleIndex] = now + upBlockSeconds[scaleIndex];
        upBlockSeconds[scaleIndex] = Math.min(upBlockSeconds[scaleIndex] * 2, BLOCK_SECONDS_MAX);
      }
      setScaleIndex(scaleIndex + 1, 'over target');
    } else if (scaleUnderSeconds >= UP_DWELL && scaleIndex > 0 && now >= upBlockedUntil[scaleIndex - 1]) {
      setScaleIndex(scaleIndex - 1, 'headroom');
    }
  }

  function updateQualityGovernor(realDt, controlMs) {
    if (settings.get('quality') !== 'auto') return;
    const dynamic = Boolean(settings.get('dynamicResolution'));
    const struggling = controlEmaMs > controlMs * 1.1 || cpuEmaMs > controlMs * 0.85;
    const comfortable = controlEmaMs < controlMs * 1.03 && cpuEmaMs < controlMs * 0.5;
    // With dynamic resolution the levels only move once the render scale has run out of room.
    const mayDegrade = !dynamic || scaleIndex === RENDER_SCALE_STEPS.length - 1;
    const mayUpgrade = !dynamic || scaleIndex === 0;
    cooldown -= realDt;
    if (struggling && mayDegrade) { slowSeconds += realDt; fastSeconds = 0; }
    else if (comfortable && mayUpgrade) { fastSeconds += realDt; slowSeconds = 0; }
    else { slowSeconds = 0; fastSeconds = 0; }
    if (cooldown > 0) return;
    if (slowSeconds > 1.2 && levelIndex > 0) {
      blockedUntil[levelIndex] = clockSeconds + 30;
      apply(levelIndex - 1, 'auto-degrade');
      cooldown = 4;
      slowSeconds = 0;
    } else if (fastSeconds > 8 && levelIndex < 3 && clockSeconds > blockedUntil[levelIndex + 1]) {
      apply(levelIndex + 1, 'auto-upgrade');
      cooldown = 6;
      fastSeconds = 0;
    }
  }

  /** Adopts a result of measureDisplayRefresh() (null when it failed) as the display refresh. */
  function setMeasuredRefresh(result) {
    if (!result || !(result.hz > 0)) {
      refresh.source = refresh.hz === null ? 'unmeasured' : refresh.source;
      state.perf.refreshSource = refresh.source;
      return;
    }
    refresh.measuredHz = result.measuredHz;
    refresh.samples = result.samples;
    if (automated) {
      refresh.hz = FALLBACK_REFRESH_HZ;
      refresh.source = 'automation';
    } else {
      refresh.hz = result.hz;
      refresh.source = 'measured';
    }
    state.perf.refreshHz = refresh.hz;
    state.perf.refreshMeasuredHz = Math.round(result.measuredHz * 10) / 10;
    state.perf.refreshSamples = result.samples;
    state.perf.refreshSource = refresh.source;
    resolveTarget();
  }

  Object.assign(state.perf, {
    fps: 60,
    frameMs: 16.7,
    controlFrameMs: 16.7,
    cpuMs: 4,
    lastFrameMs: 0,
    displayIntervalMs,
    refreshHz: null,
    refreshMeasuredHz: null,
    refreshSource: 'pending',
    refreshSamples: 0,
    displayHz: 60,
    frameTarget: settings.get('frameTarget'),
    targetHz: 60,
    targetMs: 1000 / 60,
    renderScale: 1,
    dynamicResolution: Boolean(settings.get('dynamicResolution')),
    quality: levels[levelIndex].name,
    qualityIndex: levelIndex,
    scaleHistory,
    simulatedLoad: false,
  });
  bus.on('settings:changed', ({ key }) => {
    if (key === 'quality') fromSettings();
    if (key === 'dynamicResolution') state.perf.dynamicResolution = Boolean(settings.get('dynamicResolution'));
    if (key === 'frameTarget' || key === 'dynamicResolution') {
      // A new target starts stage one from a clean slate.
      for (let index = 0; index < upBlockedUntil.length; index++) {
        upBlockedUntil[index] = 0;
        upBlockSeconds[index] = BLOCK_SECONDS_FIRST;
      }
      scaleOverSeconds = 0;
      scaleUnderSeconds = 0;
      resolveTarget();
    }
  });
  fromSettings();
  resolveTarget();

  return {
    update({ frameMs, cpuMs = 0 }) {
      // Frames that span a hidden tab or a stall say nothing about rendering cost.
      if (!(frameMs > 0) || frameMs > 250) return;
      const realDt = frameMs / 1000;
      clockSeconds += realDt;
      const sampleMs = simulatedLoad ? simulatedLoad.baseMs + simulatedLoad.scaledMs * renderScale() * renderScale() : frameMs;
      lastFrameMs = sampleMs;
      emaMs += (sampleMs - emaMs) * 0.08;
      const controlMs = resolveTarget();
      controlEmaMs += (Math.min(sampleMs, controlMs * 2) - controlEmaMs) * 0.08;
      cpuEmaMs += (cpuMs - cpuEmaMs) * 0.08;
      recentFrameMs[recentCursor] = frameMs;
      recentCursor = (recentCursor + 1) % recentFrameMs.length;
      recentCount = Math.min(recentCount + 1, recentFrameMs.length);
      intervalTimer += realDt;
      if (intervalTimer > 2 && recentCount >= 60) {
        intervalTimer = 0;
        displayIntervalMs = estimateDisplayInterval();
        if (state.ready && !simulatedLoad) refineRefresh();
      }
      state.perf.fps = 1000 / emaMs;
      state.perf.frameMs = emaMs;
      state.perf.controlFrameMs = controlEmaMs;
      state.perf.cpuMs = cpuEmaMs;
      state.perf.lastFrameMs = lastFrameMs;
      state.perf.displayIntervalMs = displayIntervalMs;
      if (state.photoMode || !state.ready) return;
      if (readySince === null) readySince = clockSeconds;
      if (clockSeconds - readySince < SETTLE_SECONDS && !simulatedLoad) {
        slowSeconds = 0;
        fastSeconds = 0;
        return;
      }
      updateDynamicResolution(realDt, controlMs);
      updateQualityGovernor(realDt, controlMs);
    },

    setMeasuredRefresh,

    /** Re-applies the render scale (the post pipeline appeared or failed). */
    refreshRenderScale: applyRenderScale,
    getRenderScale: renderScale,
    getBasePixelRatio: basePixelRatio,

    /**
     * Screenshot capture: full render scale and the pixel ratio raised by factor for the one frame
     * that is captured. Returns a function that restores the running resolution.
     */
    beginCapture(factor, maxPixelRatio) {
      captureActive = true;
      ctx.post?.setRenderScale?.(1);
      const ratio = factor !== 1 ? Math.min(basePixelRatio() * factor, maxPixelRatio) : basePixelRatio();
      if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
      return () => {
        captureActive = false;
        applyRenderScale();
      };
    },

    snapRefreshRate,

    /**
     * Dev hook: replaces the measured frame time with baseMs + scaledMs * scale^2 (pixel cost
     * falls with the square of the render scale), or restores real timing with null.
     */
    simulateLoad(load) {
      if (!devHooks) throw new Error('simulateLoad is only available in development builds or with ?debug=1');
      if (load === null) {
        simulatedLoad = null;
      } else {
        const baseMs = Number(load.baseMs);
        const scaledMs = Number(load.scaledMs);
        if (!(baseMs >= 0) || !(scaledMs >= 0)) throw new Error('simulateLoad expects { baseMs >= 0, scaledMs >= 0 }');
        simulatedLoad = { baseMs, scaledMs };
      }
      state.perf.simulatedLoad = Boolean(simulatedLoad);
      emaMs = simulatedLoad ? simulatedLoad.baseMs + simulatedLoad.scaledMs * renderScale() * renderScale() : emaMs;
      controlEmaMs = emaMs;
      scaleOverSeconds = 0;
      scaleUnderSeconds = 0;
      return state.perf.renderScale;
    },
  };
}
