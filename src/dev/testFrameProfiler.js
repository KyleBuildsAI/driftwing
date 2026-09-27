// Slow-frame attribution for the flight-test harness: tells a frame the GAME made slow apart from a
// frame the MACHINE made slow.
//
// Two sources:
//   - system timings: every system's update() is wrapped (dev test only) to time it, so each frame
//     interval can say how long the game's systems ran inside it and which ones took longest;
//   - Chrome's Long Animation Frame entries (PerformanceObserver 'long-animation-frame'): a frame
//     whose main-thread work passed 50 ms, with its script time.
// A slow frame is then classed as:
//   'systems'     the game's systems ran for at least half the interval (game work; top systems listed)
//   'mainThread'  a long animation frame covers at least half the interval but the systems did not:
//                 render submission, garbage collection or other browser work on the main thread
//   'delayed'     neither: the main thread was mostly idle and the frame arrived late anyway (GPU
//                 queue, compositor or OS scheduling; on this project's shared test machine that is
//                 the signature of other processes loading the CPU or GPU)

const MAX_LOAF_ENTRIES = 600;
const BUSY_SHARE = 0.5;

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Creates the profiler. exclude: system names not to time (the harness itself). Call instrument()
 * once every system exists, takeFrame() once per frame from the harness update, and
 * attribute(slowFrame) when a run ends (the long-animation-frame entries arrive asynchronously).
 */
export function createFrameProfiler(ctx, { exclude = [] } = {}) {
  const frameTimings = new Map();
  const loafEntries = [];
  const wrapped = [];
  let observer = null;
  const loafSupported = typeof PerformanceObserver !== 'undefined' && Array.isArray(PerformanceObserver.supportedEntryTypes)
    && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');

  if (loafSupported) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
        const scriptsMs = scripts.reduce((sum, script) => sum + (script.duration || 0), 0);
        const topScripts = scripts
          .slice()
          .sort((first, second) => second.duration - first.duration)
          .slice(0, 3)
          .map((script) => `${String(script.sourceURL || script.invoker || 'script').split('/').pop()}${script.sourceFunctionName ? ` ${script.sourceFunctionName}` : ''} ${round1(script.duration)} ms`);
        loafEntries.push({ start: entry.startTime, end: entry.startTime + entry.duration, duration: entry.duration, blockingDuration: entry.blockingDuration ?? null, scriptsMs, topScripts });
        if (loafEntries.length > MAX_LOAF_ENTRIES) loafEntries.shift();
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: false });
  }

  return {
    loafSupported,

    /** Wraps every system's update() with a timer (once). */
    instrument() {
      for (const [name, system] of Object.entries(ctx.systems)) {
        if (exclude.includes(name) || !system || typeof system.update !== 'function' || wrapped.includes(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(system, 'update');
        if (!descriptor || !descriptor.writable || Object.isFrozen(system)) continue;
        const original = system.update;
        system.update = function timedUpdate(simDt, realDt) {
          const start = performance.now();
          try {
            return original.call(system, simDt, realDt);
          } finally {
            frameTimings.set(name, (frameTimings.get(name) ?? 0) + performance.now() - start);
          }
        };
        wrapped.push(name);
      }
    },

    /**
     * The system time since the previous call (the systems that ran inside the frame interval now
     * ending): { systemsMs, top: 'name ms, ...' }. Resets the accumulators.
     */
    takeFrame() {
      let systemsMs = 0;
      const entries = [];
      for (const [name, ms] of frameTimings) {
        systemsMs += ms;
        entries.push([name, ms]);
      }
      frameTimings.clear();
      entries.sort((first, second) => second[1] - first[1]);
      return { systemsMs, top: entries.slice(0, 3).map(([name, ms]) => `${name} ${round1(ms)} ms`).join(', ') };
    },

    /**
     * Classifies a slow frame { startMs, endMs, ms, systemsMs, top } (times from performance.now)
     * and returns the report entry fields: cause, systemsMs, topSystems, loaf.
     */
    attribute(frame) {
      let best = null;
      let bestOverlap = 0;
      for (const entry of loafEntries) {
        const overlap = Math.min(entry.end, frame.endMs) - Math.max(entry.start, frame.startMs);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = entry;
        }
      }
      let cause = 'delayed';
      if (frame.systemsMs >= frame.ms * BUSY_SHARE) cause = 'systems';
      else if (best && bestOverlap >= frame.ms * BUSY_SHARE) cause = 'mainThread';
      return {
        cause,
        systemsMs: round1(frame.systemsMs),
        topSystems: frame.top,
        loaf: best ? { durationMs: round1(best.duration), overlapMs: round1(bestOverlap), scriptsMs: round1(best.scriptsMs), blockingMs: best.blockingDuration === null ? null : round1(best.blockingDuration), topScripts: best.topScripts } : null,
      };
    },

    dispose() {
      if (observer) observer.disconnect();
    },
  };
}
