// Seed links: the "Copy link" buttons (the seed chip, the settings World group, the map, the menu) and
// the way into another world (the settings seed field, "New world").
//
// A link opens the launcher shell with V2 at this world and this time of day: /?v=2#seed=ABC&t=0.723
// (src/core/seed.js). Opening a world goes through the shell bridge: inside the shell, the shell takes
// the new hash and reloads V2; on its own, V2 reloads itself. Standalone, a hand-edited #seed= in the
// address bar also reloads into that world.
import { normalizeSeed, parseDayTime, randomSeed, shareLink, worldHash } from '../core/seed.js';

/**
 * Creates the seed-link helpers. ctx: state, bus and systems.shell (the bridge); toast(text, options)
 * is the UI's toast. Returns { shareUrl(), copyLink(), openWorld(seed, dayTime?), newWorld() }.
 */
export function createSeedLinks({ ctx, toast }) {
  const { state } = ctx;

  /** The share link for this world at the current time of day. */
  function shareUrl() {
    return shareLink(window.location.href, state.seed, state.time.dayTime);
  }

  /** The legacy copy path for browsers or frames without the async clipboard: a selected textarea. */
  function copyWithSelection(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-200px;left:0;width:10px;height:10px;opacity:0;';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      // Some browsers throw instead of returning false when the command is blocked; the caller then
      // shows the link in a toast for the player to copy by hand.
      copied = false;
    }
    area.remove();
    return copied;
  }

  /** Resolves true when text reached the clipboard. */
  function writeClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => copyWithSelection(text),
      );
    }
    return Promise.resolve(copyWithSelection(text));
  }

  /** Copies the share link; says so, or shows the link to copy by hand. Resolves the link. */
  function copyLink() {
    const link = shareUrl();
    return writeClipboard(link).then((copied) => {
      if (copied) toast('Link copied. It opens this world at this time of day.', { kind: 'success', key: 'share-link' });
      else toast(`Share this world: ${link}`, { duration: 10, wrap: true, key: 'share-link' });
      return link;
    });
  }

  /**
   * Reloads into the world seed (normalised; false when it is not a seed), at dayTime (0..1) when
   * given, else at the opening time of day.
   */
  function openWorld(seed, dayTime = null) {
    const normalised = normalizeSeed(seed);
    if (!normalised) return false;
    const hash = worldHash(normalised, dayTime);
    const bridge = ctx.systems.shell;
    if (bridge && typeof bridge.openWorld === 'function') {
      bridge.openWorld(hash);
      return true;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('seed', normalised);
    url.searchParams.delete('time');
    url.hash = hash;
    window.location.assign(url.href);
    return true;
  }

  /** Reloads into a fresh random world. */
  function newWorld() {
    return openWorld(randomSeed());
  }

  // Standalone V2: a hand-edited #seed= in the address bar opens that world (inside the launcher shell,
  // the shell owns the hash and reloads V2 itself).
  if (window.parent === window) {
    window.addEventListener('hashchange', () => {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const requested = normalizeSeed(hashParams.get('seed'));
      if (requested && requested !== state.seed) openWorld(requested, parseDayTime(hashParams.get('t')));
    });
  }

  return { shareUrl, copyLink, openWorld, newWorld };
}
