// The "Sound off - click to enable" pill: a small glass button shown when the browser kept the
// AudioContext suspended (autoplay policy, a gamepad press that did not count as a user
// activation, a refused resume). It never blocks play: the game keeps running behind it, and a
// click (a real user activation) hands control back to the audio system, which resumes the context.
import './soundPill.css';

const SPEAKER_OFF_ICON = '<svg class="dw-sound-pill-icon" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />'
  + '<path d="M16 9.5l5 5M21 9.5l-5 5" />'
  + '</svg>';

/**
 * Creates the pill (hidden) and appends it to the document body. onEnable runs inside the click,
 * so it may create or resume an AudioContext.
 */
export function createSoundPill({ onEnable }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dw-sound-pill';
  button.hidden = true;
  button.setAttribute('aria-live', 'polite');
  button.innerHTML = `${SPEAKER_OFF_ICON}<span class="dw-sound-pill-label">Sound off - click to enable</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onEnable();
    // The key that clicked the pill should not stay on it (Space would click it again).
    button.blur();
  });
  document.body.appendChild(button);
  let visible = false;

  return {
    element: button,

    setVisible(next) {
      const show = Boolean(next);
      if (show === visible) return;
      visible = show;
      if (show) {
        button.hidden = false;
        // Next frame, so the entrance transition runs from the hidden style.
        requestAnimationFrame(() => {
          if (visible) button.classList.add('dw-sound-pill-shown');
        });
      } else {
        button.classList.remove('dw-sound-pill-shown');
        button.hidden = true;
      }
    },

    get visible() {
      return visible;
    },
  };
}
