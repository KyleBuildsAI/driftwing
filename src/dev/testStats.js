// Measurement helpers for the dev test harnesses: frame-time statistics, JS heap readings and
// sessionStorage persistence (the flight test reloads the page for every world seed).

const BYTES_PER_MB = 1024 * 1024;

/** Rounds to a fixed number of decimals (reports stay readable). */
export function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/** The pth percentile (0..100) of an ascending sorted numeric array (nearest rank). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * Records frame intervals (ms) for one measurement window. slowLimitMs: frames above it are listed
 * with their time into the window and the caller's detail (at most maxSlowListed of them; the count
 * keeps going).
 */
export function createFrameRecorder({ slowLimitMs = 50, maxSlowListed = 2000 } = {}) {
  let samples = new Float64Array(4096);
  let count = 0;
  let totalMs = 0;
  let slowCount = 0;
  const slowFrames = [];

  return {
    /** Adds one frame interval; at is the window time (s) the frame ended at; detail is kept for slow frames. */
    push(frameMs, at, detail = null) {
      if (count === samples.length) {
        const grown = new Float64Array(samples.length * 2);
        grown.set(samples);
        samples = grown;
      }
      samples[count++] = frameMs;
      totalMs += frameMs;
      if (frameMs > slowLimitMs) {
        slowCount++;
        if (slowFrames.length < maxSlowListed) slowFrames.push({ at: round(at, 2), ms: round(frameMs, 1), ...detail });
      }
    },

    get count() { return count; },

    /** { frames, seconds, avgFps, p50Ms, p99Ms, maxMs, slowFrames, slowFrameList }. */
    summary() {
      const sorted = Array.from(samples.subarray(0, count)).sort((first, second) => first - second);
      return {
        frames: count,
        seconds: round(totalMs / 1000, 2),
        avgFps: totalMs > 0 ? round((count * 1000) / totalMs, 1) : null,
        p50Ms: round(percentile(sorted, 50), 1),
        p99Ms: round(percentile(sorted, 99), 1),
        maxMs: round(sorted.length > 0 ? sorted[sorted.length - 1] : null, 1),
        slowFrames: slowCount,
        slowFrameList: slowFrames.slice(),
      };
    },
  };
}

/** True when the browser exposes performance.memory (Chrome). */
export function heapAvailable() {
  return typeof performance !== 'undefined' && Boolean(performance.memory) && Number.isFinite(performance.memory.usedJSHeapSize);
}

/** True when a full garbage collection can be forced (Chrome started with --js-flags=--expose-gc). */
export function gcAvailable() {
  return typeof window.gc === 'function';
}

/**
 * Used JS heap in MB, after a forced full garbage collection when the browser allows one (so the
 * reading is the live heap, not garbage waiting to be collected). null when unavailable.
 */
export function readHeapMB({ collect = true } = {}) {
  if (!heapAvailable()) return null;
  if (collect && gcAvailable()) window.gc();
  return round(performance.memory.usedJSHeapSize / BYTES_PER_MB, 2);
}

/** Reads JSON from sessionStorage; returns fallback when missing or unreadable (with the reason). */
export function readSession(key, fallback = null) {
  let raw;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch (error) {
    return { value: fallback, error: `sessionStorage is unavailable: ${error.message}` };
  }
  if (raw === null) return { value: fallback, error: null };
  try {
    return { value: JSON.parse(raw), error: null };
  } catch (error) {
    return { value: fallback, error: `stored ${key} is not valid JSON: ${error.message}` };
  }
}

/** Writes JSON to sessionStorage; returns null on success or the reason it failed. */
export function writeSession(key, value) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (error) {
    return `could not save ${key} to sessionStorage: ${error.message}`;
  }
}

/** Removes a sessionStorage key; returns null on success or the reason it failed. */
export function removeSession(key) {
  try {
    window.sessionStorage.removeItem(key);
    return null;
  } catch (error) {
    return `could not clear ${key} from sessionStorage: ${error.message}`;
  }
}

/** Resolves after the given number of milliseconds. */
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
