// Display units for the instruments: settings.units picks metric (km/h, m, m/s) or aviation
// (kt, ft, fpm). Telemetry is SI; every instrument converts through here so a units change
// reaches every gauge on the next redraw.

const METRIC = Object.freeze({
  system: 'metric',
  speed: Object.freeze({ factor: 3.6, label: 'km/h', dial: 'KM/H' }),
  altitude: Object.freeze({ factor: 1, label: 'm', dial: 'M' }),
  vertical: Object.freeze({ factor: 1, label: 'm/s', dial: 'M/S' }),
});

const AVIATION = Object.freeze({
  system: 'aviation',
  speed: Object.freeze({ factor: 1.943844, label: 'kt', dial: 'KNOTS' }),
  altitude: Object.freeze({ factor: 3.280840, label: 'ft', dial: 'FT' }),
  vertical: Object.freeze({ factor: 196.850394, label: 'fpm', dial: 'FPM' }),
});

/** The unit table for a settings.units value (metric for anything unknown). */
export function unitsFor(system) {
  return system === 'aviation' ? AVIATION : METRIC;
}

/**
 * The smallest "nice" step (1, 2, 2.5 or 5 times a power of ten) at or above raw. Dial scales use
 * it so any craft's speed range gets round numerals.
 */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (multiple * magnitude >= raw - 1e-9) return multiple * magnitude;
  }
  return 10 * magnitude;
}

/** value rounded up to a multiple of step. */
export function ceilTo(value, step) {
  return Math.ceil(value / step - 1e-9) * step;
}

/** Signed number with a leading + for positive values ('+1.2', '-0.4', '0.0'). */
export function signed(value, digits = 1) {
  const text = Math.abs(value) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : value.toFixed(digits);
  return value > 0 && Number(text) !== 0 ? `+${text}` : text;
}

/** Integer with thousands separators (thin spaces keep the digits narrow). */
export function grouped(value) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}
