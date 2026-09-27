// v1 event cues: the audio system listens to flight, ring, waypoint, landmark, bird and UI events
// itself. Cues are queued and flushed once per frame; when another module already played the same
// kind of cue directly this moment (audio.chime() / whoosh() / blip() / flutter()), the event cue
// is skipped so nothing doubles. A landmark threaded in the same frame as its discovery plays only
// the threaded run.
import { clamp } from '../core/util.js';

const EVENT_GUARD_SECONDS = 0.3;
const MAX_PENDING = 24;

/**
 * deps: { bus, state, camera, THREE, isReady(), voices() } where voices() returns the live voice
 * set (null until the context exists).
 */
export function createEventCues({ bus, state, camera, THREE, isReady, voices }) {
  const pendingCues = [];
  const lastDirectCue = { chime: -Infinity, whoosh: -Infinity, flutter: -Infinity, blip: -Infinity };
  const listenerRight = new THREE.Vector3();
  const toSource = new THREE.Vector3();

  // ---- Spatial helpers (stereo pan and distance from the camera) --------------------------------
  function panFor(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return 0;
    toSource.set(position.x - camera.position.x, position.y - camera.position.y, position.z - camera.position.z);
    const distance = toSource.length();
    if (distance < 1) return 0;
    listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return clamp(toSource.dot(listenerRight) / distance, -1, 1) * 0.75;
  }

  function proximity(position, near, far) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return 0.6;
    const sourceY = Number.isFinite(position.y) ? position.y : camera.position.y;
    const distance = Math.hypot(position.x - camera.position.x, sourceY - camera.position.y, position.z - camera.position.z);
    return 1 - 0.8 * clamp((distance - near) / (far - near), 0, 1);
  }

  // ---- Queue ---------------------------------------------------------------------------------------
  function queueCue(category, kind, play) {
    if (!isReady() || pendingCues.length > MAX_PENDING) return;
    pendingCues.push({ category, kind, play });
  }

  function flush() {
    if (pendingCues.length === 0) return;
    const now = state.time.realElapsed;
    const threaded = pendingCues.some((cue) => cue.kind === 'threaded');
    for (const cue of pendingCues) {
      if (threaded && cue.kind === 'discovery') continue;
      if (now - lastDirectCue[cue.category] < EVENT_GUARD_SECONDS) continue;
      cue.play(voices());
    }
    pendingCues.length = 0;
  }

  function playSequence(voiceSet, steps, spacing, options) {
    steps.forEach((step, index) => {
      const last = index === steps.length - 1;
      voiceSet.playChime(step, {
        ...options,
        delay: (options.delay || 0) + index * spacing,
        decay: last ? (options.decay || 2.4) * 1.35 : options.decay,
        volume: (options.volume || 0.5) * (last ? 1.1 : 0.9),
      });
    });
  }

  // ---- Wiring --------------------------------------------------------------------------------------
  bus.on('boost', () => queueCue('whoosh', 'boost', (voiceSet) => voiceSet.playWhoosh(1, 1.8)));
  bus.on('barrelroll', () => queueCue('whoosh', 'barrelroll', (voiceSet) => voiceSet.playWhoosh(0.45, 1.15)));
  bus.on('ring:passed', (payload) => {
    const streak = payload && Number.isFinite(payload.streak) ? payload.streak : 1;
    const step = 2 + clamp(Math.round(streak) - 1, 0, 10);
    const pan = panFor(payload && payload.position);
    queueCue('chime', 'ring', (voiceSet) => {
      voiceSet.playChime(step, { volume: 0.55, pan, decay: 2.2 });
      if (streak >= 3) voiceSet.playChime(step - 2, { volume: 0.22, pan, delay: 0.035, decay: 1.8, brightness: 0.6 });
    });
  });
  bus.on('ring:missed', () => queueCue('chime', 'miss', (voiceSet) => {
    voiceSet.playChime(-3, { volume: 0.3, decay: 0.7, brightness: 0.25, reverb: 0.3 });
    voiceSet.playChime(-5, { volume: 0.26, decay: 0.9, brightness: 0.2, reverb: 0.3, delay: 0.12 });
  }));
  bus.on('rings:started', () => queueCue('chime', 'rings-start', (voiceSet) => playSequence(voiceSet, [0, 2], 0.1, { volume: 0.32, decay: 1.4 })));
  bus.on('rings:finished', () => queueCue('chime', 'rings-finish', (voiceSet) => {
    playSequence(voiceSet, [5, 7, 9, 10, 12], 0.1, { volume: 0.45, decay: 2.6 });
    voiceSet.playChime(0, { volume: 0.3, delay: 0.4, decay: 3.2, brightness: 0.5 });
  }));
  bus.on('rings:cancelled', () => queueCue('blip', 'rings-cancel', (voiceSet) => {
    voiceSet.playBlip({ pitch: 0.9 });
    voiceSet.playBlip({ pitch: 0.7, volume: 0.8 });
  }));
  bus.on('waypoint:reached', (payload) => {
    const pan = panFor(payload && Number.isFinite(payload.x) ? { x: payload.x, y: camera.position.y, z: payload.z } : null);
    queueCue('chime', 'waypoint', (voiceSet) => {
      voiceSet.playChime(5, { volume: 0.42, pan, decay: 2.6 });
      voiceSet.playChime(7, { volume: 0.36, pan, delay: 0.07, decay: 2.6 });
      voiceSet.playChime(9, { volume: 0.34, pan, delay: 0.14, decay: 2.8 });
      voiceSet.playChime(10, { volume: 0.38, pan, delay: 0.24, decay: 3.2 });
    });
  });
  bus.on('landmark:discovered', (payload) => {
    const site = payload && payload.site;
    const pan = panFor(site && Number.isFinite(site.x) ? { x: site.x, y: camera.position.y, z: site.z } : null);
    queueCue('chime', 'discovery', (voiceSet) => playSequence(voiceSet, [4, 6, 8, 10], 0.115, { volume: 0.46, pan, decay: 2.5 }));
  });
  bus.on('landmark:threaded', () => queueCue('chime', 'threaded', (voiceSet) => playSequence(voiceSet, [5, 6, 7, 8, 9, 10, 12], 0.06, { volume: 0.38, decay: 2.2 })));
  bus.on('birds:scattered', (payload) => {
    const count = payload && Number.isFinite(payload.count) ? payload.count : 12;
    const position = payload && payload.position;
    const intensity = clamp(count / 24, 0.3, 1.3) * proximity(position, 40, 400);
    const pan = panFor(position);
    queueCue('flutter', 'birds', (voiceSet) => voiceSet.playFlutter(intensity, pan));
  });
  bus.on('waypoint:set', () => queueCue('blip', 'waypoint-set', (voiceSet) => voiceSet.playBlip({ pitch: 1 })));
  bus.on('waypoint:cleared', () => queueCue('blip', 'waypoint-clear', (voiceSet) => voiceSet.playBlip({ pitch: 0.8, volume: 0.8 })));
  bus.on('autopilot:changed', (payload) => {
    const enabled = Boolean(payload && payload.enabled);
    queueCue('blip', 'autopilot', (voiceSet) => voiceSet.playBlip({ pitch: enabled ? 1.12 : 0.84 }));
  });
  bus.on('ui:command', () => queueCue('blip', 'ui', (voiceSet) => voiceSet.playBlip({ pitch: 1 })));
  bus.on('ui:action', () => queueCue('blip', 'ui', (voiceSet) => voiceSet.playBlip({ pitch: 1.06 })));
  bus.on('copilot:listening', (payload) => {
    if (payload && payload.state === 'listening') queueCue('blip', 'mic', (voiceSet) => voiceSet.playBlip({ pitch: 1.25, volume: 0.8 }, 'copilot'));
  });
  bus.on('screenshot:taken', () => queueCue('blip', 'shutter', (voiceSet) => voiceSet.playShutter()));

  return {
    flush,
    /** Marks a cue category as played directly by another module right now. */
    markDirect(category) {
      lastDirectCue[category] = state.time.realElapsed;
    },
    get pending() {
      return pendingCues.length;
    },
  };
}
