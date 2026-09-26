import { CONFIG } from './config.js';
import { storage } from './storage.js';


export const DEFAULT_SETTINGS = Object.freeze({
  dayLength: CONFIG.DAY_LENGTH_DEFAULT,
  timeFrozen: false,
  quality: 'auto',
  mouseSensitivity: 1,
  invertPitch: false,
  copilotVoice: true,
  copilotChatter: true,
  remoteCopilot: false,
  remoteEndpoint: CONFIG.REMOTE_COPILOT_DEFAULT_ENDPOINT,
  masterVolume: 0.7,
  showFps: false,
  hudAutoHide: true,
});


export const QUALITY_PREFERENCES = Object.freeze(['auto', 'minimal', 'low', 'medium', 'high', 'ultra']);

export const SETTING_VALIDATORS = Object.freeze({
  dayLength: (value) => Number.isFinite(value) && value >= 60 && value <= 3600,
  quality: (value) => QUALITY_PREFERENCES.includes(value),
  mouseSensitivity: (value) => Number.isFinite(value) && value >= 0.2 && value <= 4,
  masterVolume: (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  remoteEndpoint: (value) => /^https?:\/\/[^\s]+$/i.test(value),
});


export function isValidSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) || typeof value !== typeof DEFAULT_SETTINGS[key]) return false;
  const validator = SETTING_VALIDATORS[key];
  return validator ? validator(value) : true;
}


export function createSettings(bus) {
  const STORAGE_KEY = 'driftwing.settings.v1';
  const stored = storage.read(STORAGE_KEY, {});
  const values = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored && isValidSetting(key, stored[key])) values[key] = stored[key];
  }
  let saveFailureReported = false;
  return {
    get(key) { return values[key]; },
    all() { return { ...values }; },
    set(key, value) {
      if (!isValidSetting(key, value)) return false;
      if (values[key] === value) return true;
      values[key] = value;
      if (!storage.write(STORAGE_KEY, values) && !saveFailureReported) {
        saveFailureReported = true;
        bus.emit('notify', { text: 'This browser is blocking storage, so settings will reset next visit.', kind: 'warning' });
      }
      bus.emit('settings:changed', { key, value, settings: { ...values } });
      return true;
    },
  };
}
