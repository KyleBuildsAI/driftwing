// Slow-frame attribution for the flight-test harness: tells a frame the GAME made slow apart from a
// frame the MACHINE made slow.
//
// Two sources:
//   - system timings: every system's update() is wrapped (dev test only) to time it, so each frame
//     interval can say how long the game's systems ran inside it and which ones took longest;
//   - Chrome's Long Animation Frame entries (PerformanceObserver 'long-animation-frame'): a frame
//     whose main-thread work passed 50 ms, with its script time.
// plus the JS heap before and after the frame (performance.memory, precise in the test runner): a
// garbage collection shows as a drop of the used heap across the frame.
// A slow frame is then classed as:
//   'systems'     the game's systems ran for at least half the interval (game work; top systems listed)
//   'gc'          main-thread time outside the systems while the used heap dropped by GC_DROP_MB or
//                 more across the frame: a garbage collection pause
//   'mainThread'  a long animation frame covers at least half the interval but the systems did not
//                 and no collection shows: render submission or other browser work on the main thread
//   'delayed'     neither: the main thread was mostly idle and the frame arrived late anyway (GPU
//                 queue, compositor or OS scheduling; on this project's shared test machine that is
//                 the signature of other processes loading the CPU or GPU)

const MAX_LOAF_ENTRIES = 600;
const BUSY_SHARE = 0.5;
/** Used-heap drop across a frame (MB) that marks a garbage collection in it. */
const GC_DROP_MB = 2;

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
        const end = entry.startTime + entry.duration;
        // Phases: tasks before the rendering update, the rendering update up to style and layout
        // (rAF callbacks: the game frame), then style, layout and paint.
        const renderStart = entry.renderStart > 0 ? entry.renderStart : end;
        const styleStart = entry.styleAndLayoutStart > 0 ? entry.styleAndLayoutStart : end;
        const phases = { tasksMs: round1(renderStart - entry.startTime), renderMs: round1(styleStart - renderStart), styleLayoutMs: round1(end - styleStart) };
        loafEntries.push({ start: entry.startTime, end, duration: entry.duration, blockingDuration: entry.blockingDuration ?? null, scriptsMs, topScripts, phases });
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
     * Classifies a slow frame { startMs, endMs, ms, systemsMs, top, heapDeltaMB } (times from
     * performance.now) and returns the report entry fields: cause, systemsMs, topSystems, loaf.
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
      else if (Number.isFinite(frame.heapDeltaMB) && frame.heapDeltaMB <= -GC_DROP_MB) cause = 'gc';
      else if (best && bestOverlap >= frame.ms * BUSY_SHARE) cause = 'mainThread';
      return {
        cause,
        systemsMs: round1(frame.systemsMs),
        heapDeltaMB: Number.isFinite(frame.heapDeltaMB) ? round1(frame.heapDeltaMB) : null,
        topSystems: frame.top,
        loaf: best ? { durationMs: round1(best.duration), overlapMs: round1(bestOverlap), scriptsMs: round1(best.scriptsMs), blockingMs: best.blockingDuration === null ? null : round1(best.blockingDuration), topScripts: best.topScripts, ...best.phases } : null,
      };
    },

    dispose() {
      if (observer) observer.disconnect();
    },
  };
}
