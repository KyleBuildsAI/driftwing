// Formatting shared by the journal panel, the discovery toast and the world map: record statistics,
// world coordinates, discovery times and dates.
import { JOURNAL_STATS } from '../gameplay/journal.js';

function padNumber(value, length) {
  return String(value).padStart(length, '0');
}

/** 'bestLoopTime' -> 'Best loop time'. */
export function humanizeKey(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/** A distance in metres as [value, unit]: '212', 'm' below a kilometre, else kilometres. */
export function distanceParts(metres) {
  const safe = Math.max(0, Number(metres) || 0);
  if (safe < 1000) return [String(Math.round(safe)), 'm'];
  return [safe < 100000 ? (safe / 1000).toFixed(1) : String(Math.round(safe / 1000)), 'km'];
}

/** A run time in seconds as 'M:SS.t'. */
export function formatRunTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const wholeSeconds = Math.floor(rest);
  const tenths = Math.floor((rest - wholeSeconds) * 10);
  return `${minutes}:${padNumber(wholeSeconds, 2)}.${tenths}`;
}

/** The label of a record statistic: the known label, else the key in words. */
export function statLabel(key) {
  return JOURNAL_STATS[key]?.label ?? humanizeKey(key);
}

/**
 * A record statistic as [value, unit] for a stat card: counts as whole numbers, distances in m / km,
 * run times as M:SS.t; other keys print their number.
 */
export function statParts(key, value) {
  const unit = JOURNAL_STATS[key]?.unit ?? null;
  if (!Number.isFinite(value)) return ['None', ''];
  if (unit === 'count') return [String(Math.round(value)), ''];
  if (unit === 'metres') return distanceParts(value);
  if (unit === 'seconds') return [formatRunTime(value), ''];
  return [String(Math.round(value * 100) / 100), ''];
}

/** A record statistic as one string ('212 m', '1:42.3', '3'). */
export function formatStat(key, value) {
  const [number, unit] = statParts(key, value);
  return unit ? `${number} ${unit}` : number;
}

/** A time of day (0..1) as a 24-hour clock 'HH:MM'. */
export function formatClock(dayTime) {
  const minuteOfDay = Math.floor((((Number(dayTime) || 0) % 1 + 1) % 1) * 1440) % 1440;
  return `${padNumber(Math.floor(minuteOfDay / 60), 2)}:${padNumber(minuteOfDay % 60, 2)}`;
}

/** World coordinates as compass offsets from the world origin: 'E 12.4 km, N 3.1 km' (-z is north). */
export function formatCoordinates(x, z) {
  const east = Number(x) || 0;
  const north = -(Number(z) || 0);
  const part = (value, positive, negative) => {
    const [number, unit] = distanceParts(Math.abs(value));
    return `${value >= 0 ? positive : negative} ${number} ${unit}`;
  };
  return `${part(east, 'E', 'W')}, ${part(north, 'N', 'S')}`;
}

/** A first-seen date: 'just now', 'n min ago', 'n h ago', else the calendar date. */
export function formatWhen(epochMs) {
  if (!(epochMs > 0)) return '';
  const seconds = (Date.now() - epochMs) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
