// HOTAS prompt: when a Thrustmaster stick or throttle connects while flying CLASSIC, offer SIM.
//
// settings.hotasPrompt remembers the answer: 'ask' shows the prompt (Yes switches once, Always
// switches and stops asking, No stops asking), 'always' switches automatically with a short
// notice, 'never' stays quiet. The switch itself goes through the settings command channel.

const HOTAS_KINDS = new Set(['hotas-stick', 'hotas-throttle']);
/** Seconds an unanswered prompt stays up; it then leaves without remembering anything. */
const PROMPT_SECONDS = 20;

/**
 * Builds the prompt card inside container (the toast stack). toast(text, options) is the UI's
 * toast function; isPhotoMode() holds the prompt back while photo mode owns the screen.
 */
export function createHotasPrompt({ container, settings, bus, toast, isPhotoMode, onAnswer }) {
  const card = document.createElement('div');
  card.className = 'dw-prompt glass';
  card.id = 'dw-hotas-prompt';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-labelledby', 'dw-hotas-prompt-text');
  card.hidden = true;
  card.innerHTML = [
    '<span class="dw-toast-dot" aria-hidden="true"></span>',
    '<span class="dw-prompt-text" id="dw-hotas-prompt-text" aria-live="polite">HOTAS detected - switch to SIM?</span>',
    '<span class="dw-prompt-actions">',
    '<button type="button" class="dw-text-button dw-solid" data-answer="yes">Yes</button>',
    '<button type="button" class="dw-text-button" data-answer="no">No</button>',
    '<button type="button" class="dw-text-button" data-answer="always">Always</button>',
    '</span>',
  ].join('');
  container.prepend(card);

  let open = false;
  let pending = false;
  let remaining = 0;

  function switchToSim() {
    if (settings.get('mode') === 'sim') return true;
    return settings.set('mode', 'sim');
  }

  function show() {
    if (open) {
      remaining = PROMPT_SECONDS;
      return;
    }
    open = true;
    remaining = PROMPT_SECONDS;
    card.hidden = false;
  }

  function hide() {
    pending = false;
    if (!open) return;
    open = false;
    card.hidden = true;
  }

  function answer(choice) {
    hide();
    if (choice === 'always') {
      settings.set('hotasPrompt', 'always');
      switchToSim();
    } else if (choice === 'yes') {
      switchToSim();
    } else if (choice === 'no') {
      settings.set('hotasPrompt', 'never');
      toast('Staying in CLASSIC. Switch any time with the mode pill or V', { key: 'hotas' });
    }
    onAnswer?.(choice);
  }

  card.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-answer]') : null;
    if (button) answer(button.dataset.answer);
  });

  /** Reacts to a connected device: prompt, switch automatically, or stay quiet. */
  function onDeviceConnected(payload) {
    if (!payload || !HOTAS_KINDS.has(payload.kind)) return;
    if (settings.get('mode') !== 'classic') return;
    const preference = settings.get('hotasPrompt');
    if (preference === 'never') return;
    if (preference === 'always') {
      if (switchToSim()) toast('HOTAS detected. Switching to SIM', { key: 'hotas', kind: 'success' });
      return;
    }
    if (isPhotoMode()) {
      pending = true;
      return;
    }
    show();
  }

  bus.onTyped('deviceConnected', onDeviceConnected);
  bus.on('settings:changed', (payload) => {
    if (!payload) return;
    // Switched to SIM some other way (pill, V, copilot), or the preference changed in settings.
    if (payload.key === 'mode' && settings.get('mode') !== 'classic') hide();
    if (payload.key === 'hotasPrompt' && settings.get('hotasPrompt') !== 'ask') hide();
  });

  return {
    update(step) {
      if (pending && !isPhotoMode()) {
        pending = false;
        if (settings.get('mode') === 'classic' && settings.get('hotasPrompt') === 'ask') show();
      }
      if (!open) return;
      if (isPhotoMode()) return;
      remaining -= step;
      if (remaining <= 0) hide();
    },
    isOpen: () => open,
    answer,
  };
}
