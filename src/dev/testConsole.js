// Console capture for the dev test harnesses (?test=1, ?test=hotas).
//
// Wraps console.error and console.warn (the original still prints, so nothing is hidden) and listens
// for uncaught errors ('error') and unhandled promise rejections ('unhandledrejection'). Every entry
// is tagged with the harness context active when it happened (for example the flight-test run), so a
// report can say exactly where an error came from. Installed as early as possible in boot, before
// storage and the renderer start, so boot-time problems are caught too.

/** Longest message text kept per entry (characters). */
const MAX_TEXT = 600;
/** Entries kept in memory; counts keep going past it. */
const MAX_ENTRIES = 400;

/** One readable line from console arguments (errors with their message, objects as JSON). */
export function formatConsoleArguments(args) {
  return args.map((value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (value === null || value === undefined || typeof value !== 'object') return String(value);
    try {
      return JSON.stringify(value);
    } catch (error) {
      return `[unserialisable ${value.constructor?.name ?? 'object'}: ${error.message}]`;
    }
  }).join(' ').slice(0, MAX_TEXT);
}

/**
 * Installs the capture. Returns { entries, counts, setContext(label), uninstall() }; onEntry(entry)
 * runs for every captured entry { level: 'error'|'warning', source, text, context, time }.
 */
export function installConsoleCapture({ onEntry = null } = {}) {
  const entries = [];
  const counts = { errors: 0, warnings: 0 };
  const originalError = console.error;
  const originalWarn = console.warn;
  let context = 'boot';

  function record(level, source, text) {
    const entry = { level, source, text, context, time: Math.round(performance.now()) };
    if (level === 'error') counts.errors++;
    else counts.warnings++;
    if (entries.length < MAX_ENTRIES) entries.push(entry);
    if (onEntry) onEntry(entry);
  }

  console.error = function captureError(...args) {
    record('error', 'console.error', formatConsoleArguments(args));
    return originalError.apply(console, args);
  };
  console.warn = function captureWarning(...args) {
    record('warning', 'console.warn', formatConsoleArguments(args));
    return originalWarn.apply(console, args);
  };

  const onError = (event) => {
    const where = event.filename ? ` (${event.filename.split('/').pop()}:${event.lineno})` : '';
    record('error', 'window.error', `${event.message || formatConsoleArguments([event.error])}${where}`.slice(0, MAX_TEXT));
  };
  const onRejection = (event) => {
    record('error', 'unhandledrejection', formatConsoleArguments([event.reason]));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return {
    entries,
    counts,
    /** Tags later entries (for example 'run 4: jet SIM'). */
    setContext(label) {
      context = String(label);
    },
    uninstall() {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
