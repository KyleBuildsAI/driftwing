// World seeds and seed links.
//
// A seed is 1-24 characters of A-Z, 0-9 and dashes. It is resolved at boot in this order: the query
// (?seed=), the hash (#seed=, the form share links and the launcher shell forward), the seed saved in
// the settings (the world flown last), else a fresh random one. A link may also carry the time of day:
// ?time= (0..1, the v1 parameter) wins over the hash's t= (0..1, or 24-hour HH:MM).
//
// Share links open the launcher shell, which forwards its hash to V2: /?v=2#seed=ABC&t=0.723.

/** A valid, normalised seed. */
export const SEED_PATTERN = /^[A-Z0-9-]{1,24}$/;
const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RANDOM_SEED_LENGTH = 6;
/** Decimals of the time of day in a link (0.001 of a day is under 1.5 minutes). */
const DAY_TIME_DECIMALS = 3;

/**
 * Normalises a requested seed: upper case, runs of other characters become one dash, no dashes at the
 * ends (before the cut to 24 characters). Returns null when nothing usable is left.
 */
export function normalizeSeed(value) {
  if (typeof value !== 'string') return null;
  const normalised = value.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return SEED_PATTERN.test(normalised) ? normalised : null;
}

/** A fresh random seed from an alphabet without look-alike characters. */
export function randomSeed() {
  const bytes = new Uint8Array(RANDOM_SEED_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SEED_ALPHABET[byte % SEED_ALPHABET.length]).join('');
}

/**
 * The world seed: the query (?seed=) wins, then the hash (#seed=), then savedSeed (the settings), else a
 * fresh random one. params and hashParams are URLSearchParams (hashParams may be null).
 */
export function resolveSeed(params, hashParams = null, savedSeed = null) {
  return normalizeSeed(params.get('seed')) ?? normalizeSeed(hashParams?.get('seed') ?? null) ?? normalizeSeed(savedSeed) ?? randomSeed();
}

/**
 * Parses a time of day: a fraction of the day (0.5 is noon; any finite number wraps into 0..1) or a
 * 24-hour clock time HH:MM. Returns 0..1, or null when the value is not a time.
 */
export function parseDayTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    return (hours * 60 + minutes) / 1440;
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const fraction = Number(text);
  return Number.isFinite(fraction) ? ((fraction % 1) + 1) % 1 : null;
}

/** The requested start time of day (0..1): ?time= wins over the hash's t=; null when neither is given. */
export function resolveStartTime(params, hashParams = null) {
  return parseDayTime(params.get('time')) ?? parseDayTime(hashParams?.get('t') ?? null);
}

/** A time of day as it appears in a link: the fraction of the day to three decimals. */
export function formatDayTime(dayTime) {
  const wrapped = ((dayTime % 1) + 1) % 1;
  return wrapped.toFixed(DAY_TIME_DECIMALS);
}

/** The hash of a world link: '#seed=ABC' or '#seed=ABC&t=0.723'. Throws on an invalid seed. */
export function worldHash(seed, dayTime = null) {
  if (!SEED_PATTERN.test(seed)) throw new Error(`invalid seed "${seed}"`);
  const time = Number.isFinite(dayTime) ? `&t=${formatDayTime(dayTime)}` : '';
  return `#seed=${seed}${time}`;
}

/** True for a hash worldHash() can produce (the launcher shell checks messages with it). */
export function isWorldHash(hash) {
  return typeof hash === 'string' && /^#seed=[A-Z0-9-]{1,24}(&t=(0\.\d{1,4}|1\.0{1,4}|0|1))?$/.test(hash);
}

/**
 * The share link for a world: the launcher shell next to V2 (/, or index.html beside the v2 folder
 * when opened from files) with ?v=2 and the world hash. pageHref is V2's own address.
 */
export function shareLink(pageHref, seed, dayTime = null) {
  const page = new URL(pageHref);
  const shell = new URL(page.protocol === 'file:' ? '../index.html' : '../', page);
  shell.search = '?v=2';
  shell.hash = worldHash(seed, dayTime);
  return shell.href;
}
