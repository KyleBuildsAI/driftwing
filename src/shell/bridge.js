// Shell bridge: V2's side of the launcher shell (the root page, index.html + src/shell/shell.js).
//
// The shell runs one game at a time in a full-window iframe: V1 at /v1/, V2 at /v2/. The bindable
// action versionToggle (F8, TWCS button 8) asks for V1:
//   - inside the shell, V2 posts { source: 'driftwing-v2', type: 'switch-version', to: 'v1' } to
//     the parent, targeted at V2's own origin; the shell accepts it only from its own iframe;
//   - standalone at /v2/, V2 navigates the tab to the shell with ?v=1;
//   - inside any other page (a foreign embed), it says so in a toast and stays put.
//
// While embedded, <html> carries the class dw-embedded so the HUD keeps the top-left corner free
// for the shell's version pill (src/ui/ui.css).

/** The fields every switch request carries; `to` is added per request. */
const SWITCH_MESSAGE = Object.freeze({ source: 'driftwing-v2', type: 'switch-version' });
export const SHELL_VERSIONS = Object.freeze(['v1', 'v2']);

/**
 * True when the parent page shares V2's origin (the shell). ancestorOrigins answers without
 * touching the parent; where a browser lacks it, a message to a foreign parent is still safe
 * because postMessage targets V2's own origin and is dropped there.
 */
function parentIsSameOrigin() {
  const ancestors = window.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0] === window.location.origin;
  return true;
}

/** The shell URL that opens a version directly (/?v=1), keeping V2's own origin. */
export function shellUrlFor(version) {
  return new URL(`/?v=${version.slice(1)}`, window.location.origin).href;
}

/**
 * Creates the bridge. ctx: the game context (bus). Returns { embedded, requestVersion(version) };
 * requestVersion returns how the request went out: 'message', 'navigate' or 'unavailable'.
 */
export function createShellBridge(ctx) {
  const { bus } = ctx;
  const embedded = window.parent !== window;
  if (embedded) document.documentElement.classList.add('dw-embedded');

  function requestVersion(version) {
    if (!SHELL_VERSIONS.includes(version)) throw new Error(`unknown game version "${version}"`);
    if (!embedded) {
      // Standalone at /v2/: this window is the top window, so the whole tab moves to the shell.
      window.top.location.assign(shellUrlFor(version));
      return 'navigate';
    }
    if (parentIsSameOrigin()) {
      window.parent.postMessage({ ...SWITCH_MESSAGE, to: version }, window.location.origin);
      return 'message';
    }
    bus.emit('notify', { text: 'Switching to V1 works from the DRIFTWING launcher page.', kind: 'warning' });
    return 'unavailable';
  }

  bus.on('input:action', (action) => {
    if (action && action.phase === 'press' && action.id === 'versionToggle') requestVersion('v1');
  });

  return { embedded, requestVersion };
}
