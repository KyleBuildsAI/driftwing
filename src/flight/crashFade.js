// Soft-crash fade: a full-screen overlay the flight controller darkens and lifts around a respawn.
// It creates its own element with inline styles (no stylesheet dependency), sits above the 3D view
// and below the glass UI (#ui-root is z-index 10) so toasts stay readable, and never takes input.

const OVERLAY_ID = 'dw-crash-fade';
const OVERLAY_COLOR = '#0a0a0f';

/** Returns { element, setOpacity(0..1) }; the element is created on first use and reused. */
export function createCrashFade(root = document.body) {
  let element = document.getElementById(OVERLAY_ID);
  if (!element) {
    element = document.createElement('div');
    element.id = OVERLAY_ID;
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9',
      background: OVERLAY_COLOR,
      opacity: '0',
      pointerEvents: 'none',
      visibility: 'hidden',
    });
    root.appendChild(element);
  }
  let current = 0;

  return {
    element,
    setOpacity(value) {
      const opacity = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      if (opacity === current) return;
      current = opacity;
      element.style.opacity = opacity.toFixed(3);
      element.style.visibility = opacity > 0 ? 'visible' : 'hidden';
    },
    get opacity() {
      return current;
    },
  };
}
