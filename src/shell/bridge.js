// Shell bridge: V2's side of the launcher shell (the root page, index.html + src/shell/shell.js).
//
// The shell runs one game at a time in a full-window iframe: V1 at /v1/, V2 at /v2/. The bindable
// action versionToggle (F8, T.16000M base button 10) asks for V1:
//   - inside the shell, V2 posts { source: 'driftwing-v2', type: 'switch-version', to: 'v1' } to
//     the parent, targeted at V2's own origin; the shell accepts it only from its own iframe;
//   - standalone at /v2/, V2 navigates the tab to the shell with ?v=1;
//   - inside any other page (a foreign embed), it says so in a toast and stays put.
//
// Seed links: openWorld(hash) reloads into another world (hash from worldHash() in src/core/seed.js).
// Inside the shell V2 posts { source: 'driftwing-v2', type: 'open-world', hash }, and the shell takes the
// hash as its own and reloads V2 with it, so the shell URL names the world; standalone (or inside a
// foreign page) V2 reloads itself with the new seed.
//
// While embedded, <html> carries the class dw-embedded so the HUD keeps the top-left corner free
// for the shell's version pill (src/ui/ui.css).
import { isWorldHash } from '../core/seed.js';

/** The fields every switch request carries; `to` is added per request. */
const SWITCH_MESSAGE = Object.freeze({ source: 'driftwing-v2', type: 'switch-version' });
/** The fields every world request carries; `hash` is added per request. */
const WORLD_MESSAGE = Object.freeze({ source: 'driftwing-v2', type: 'open-world' });
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

/**
 * The shell URL that opens a version directly (?v=1): the shell page beside V2's folder, so it
 * keeps V2's origin and any subpath the site is served from.
 */
export function shellUrlFor(version) {
  const shell = new URL(window.location.protocol === 'file:' ? '../index.html' : '../', window.location.href);
  shell.search = `?v=${version.slice(1)}`;
  return shell.href;
}

/**
 * V2's own address for a world: the current page with ?seed= set, ?time= dropped (the hash's t= then
 * applies) and the world hash.
 */
function worldPageUrl(hash) {
  const url = new URL(window.location.href);
  url.searchParams.set('seed', new URLSearchParams(hash.slice(1)).get('seed'));
  url.searchParams.delete('time');
  url.hash = hash;
  return url;
}

/**
 * Creates the bridge. ctx: the game context (bus). Returns { embedded, availability(),
 * requestVersion(version), openWorld(hash) }: availability() says how a request would go out without
 * sending one, and requestVersion returns how it went out: 'message', 'navigate' or 'unavailable'.
 * openWorld returns 'message' (the shell reloads V2) or 'navigate' (V2 reloads itself).
 */
export function createShellBridge(ctx) {
  const { bus } = ctx;
  const embedded = window.parent !== window;
  if (embedded) document.documentElement.classList.add('dw-embedded');

  /** 'navigate' (standalone), 'message' (inside the shell) or 'unavailable' (a foreign embed). */
  function availability() {
    if (!embedded) return 'navigate';
    return parentIsSameOrigin() ? 'message' : 'unavailable';
  }

  function requestVersion(version) {
    if (!SHELL_VERSIONS.includes(version)) throw new Error(`unknown game version "${version}"`);
    const route = availability();
    if (route === 'navigate') {
      // Standalone at /v2/: this window is the top window, so the whole tab moves to the shell.
      window.top.location.assign(shellUrlFor(version));
    } else if (route === 'message') {
      window.parent.postMessage({ ...SWITCH_MESSAGE, to: version }, window.location.origin);
    } else {
      bus.emit('notify', { text: 'Switching to V1 works from the DRIFTWING launcher page.', kind: 'warning' });
    }
    return route;
  }

  function openWorld(hash) {
    if (!isWorldHash(hash)) throw new Error(`invalid world link "${hash}"`);
    if (availability() === 'message') {
      window.parent.postMessage({ ...WORLD_MESSAGE, hash }, window.location.origin);
      return 'message';
    }
    // Standalone or inside a foreign page: this document reloads itself into the world. A change of
    // the hash alone does not reload, so the same address is reloaded explicitly.
    const target = worldPageUrl(hash);
    const sameDocument = target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search;
    window.location.assign(target.href);
    if (sameDocument) window.location.reload();
    return 'navigate';
  }

  bus.on('input:action', (action) => {
    if (action && action.phase === 'press' && action.id === 'versionToggle') requestVersion('v1');
  });

  return { embedded, availability, requestVersion, openWorld };
}
