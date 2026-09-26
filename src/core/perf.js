import { clamp } from './util.js';
import { CONFIG } from './config.js';


// ============================================================================
// PERFORMANCE GOVERNOR: steps quality down before frame drops, back up slowly.
// Thresholds are relative to the measured display interval (60 fps floor), and
// CPU time per frame is a leading signal so view distance drops before vsync misses.
// ============================================================================
export function createPerfGovernor(ctx) {
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
  let cpuEmaMs = 4;
  let slowSeconds = 0;
  let fastSeconds = 0;
  let cooldown = 3;
  let readySince = null;
  const blockedUntil = new Array(levels.length).fill(0);
  // Frames behind the loading fade are slow by design (pipelines compiling), and the first
  // seconds after it settle caches: judging them would degrade quality for nothing.
  const SETTLE_SECONDS = 4;

  function apply(index, reason) {
    levelIndex = clamp(index, 0, levels.length - 1);
    const level = levels[levelIndex];
    Object.assign(ctx.quality, level, { levelIndex, auto: settings.get('quality') === 'auto' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, level.pixelRatio));
    bus.emit('quality:changed', { ...ctx.quality, reason });
  }
  function fromSettings() {
    const preference = settings.get('quality');
    apply(preference in fixedIndex ? fixedIndex[preference] : 3, 'settings');
  }
  /** Display refresh interval: a low percentile of recent frame times (vsync-bound frames). */
  function estimateDisplayInterval() {
    sortScratch.set(recentFrameMs.subarray(0, recentCount));
    const sorted = sortScratch.subarray(0, recentCount).sort();
    return clamp(sorted[Math.floor(recentCount * 0.2)], 6.5, 40);
  }
  bus.on('settings:changed', ({ key }) => { if (key === 'quality') fromSettings(); });
  fromSettings();

  return {
    update(realDt, cpuMs = 0) {
      const ms = realDt * 1000;
      emaMs += (ms - emaMs) * 0.08;
      cpuEmaMs += (cpuMs - cpuEmaMs) * 0.08;
      recentFrameMs[recentCursor] = ms;
      recentCursor = (recentCursor + 1) % recentFrameMs.length;
      recentCount = Math.min(recentCount + 1, recentFrameMs.length);
      intervalTimer += realDt;
      if (intervalTimer > 2 && recentCount >= 60) {
        intervalTimer = 0;
        displayIntervalMs = estimateDisplayInterval();
      }
      state.perf.fps = 1000 / emaMs;
      state.perf.frameMs = emaMs;
      state.perf.cpuMs = cpuEmaMs;
      state.perf.displayIntervalMs = displayIntervalMs;
      if (settings.get('quality') !== 'auto' || state.photoMode) return;
      if (!state.ready) return;
      if (readySince === null) readySince = state.time.realElapsed;
      if (state.time.realElapsed - readySince < SETTLE_SECONDS) {
        slowSeconds = 0;
        fastSeconds = 0;
        return;
      }
      const targetMs = Math.max(displayIntervalMs, 1000 / 60);
      const struggling = emaMs > targetMs * 1.1 || cpuEmaMs > targetMs * 0.85;
      const comfortable = emaMs < targetMs * 1.03 && cpuEmaMs < targetMs * 0.5;
      cooldown -= realDt;
      if (struggling) { slowSeconds += realDt; fastSeconds = 0; }
      else if (comfortable) { fastSeconds += realDt; slowSeconds = 0; }
      else { slowSeconds = 0; fastSeconds = 0; }
      if (cooldown > 0) return;
      if (slowSeconds > 1.2 && levelIndex > 0) {
        blockedUntil[levelIndex] = state.time.realElapsed + 30;
        apply(levelIndex - 1, 'auto-degrade');
        cooldown = 4;
        slowSeconds = 0;
      } else if (fastSeconds > 8 && levelIndex < 3 && state.time.realElapsed > blockedUntil[levelIndex + 1]) {
        apply(levelIndex + 1, 'auto-upgrade');
        cooldown = 6;
        fastSeconds = 0;
      }
    },
  };
}
