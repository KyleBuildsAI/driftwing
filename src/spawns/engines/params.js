// Engine parameter readers shared by the structure and set-piece engines. Every engine param has a
// default; a param a preset sets must be the right type and within its documented range, or create()
// throws an error naming the engine, the preset and the param (the SpawnManager logs it and refuses
// the activation). Ranges ([min, max]) are rolled with the spawn's seeded random generator, so the
// same site always builds the same way.

/**
 * Creates the readers for one engine entry: engine name, preset id, the params object and its path in
 * the preset (for the error messages).
 */
export function createParamReader(engineName, presetId, params, path = 'params') {
  const source = params ?? {};
  const where = (name) => `[DRIFTWING] ${engineName} preset "${presetId}" ${path}.${name}`;
  function fail(name, message) {
    throw new RangeError(`${where(name)}: ${message}`);
  }
  const reader = {
    fail,
    has(name) {
      return source[name] !== undefined && source[name] !== null;
    },
    /** A finite number within [min, max] (default when absent). */
    number(name, fallback, min = -Infinity, max = Infinity) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(name, `must be a number, got ${JSON.stringify(value)}`);
      if (value < min || value > max) fail(name, `must be within [${min}, ${max}], got ${value}`);
      return value;
    },
    /** An integer within [min, max]. */
    integer(name, fallback, min = -Infinity, max = Infinity) {
      const value = reader.number(name, fallback, min, max);
      if (!Number.isInteger(value)) fail(name, `must be an integer, got ${value}`);
      return value;
    },
    /**
     * A number or an ascending [min, max] range within [min, max]; returns the range as [low, high]
     * (equal for a single number).
     */
    range(name, fallback, min = -Infinity, max = Infinity) {
      const value = source[name];
      const pair = value === undefined || value === null ? fallback : value;
      if (typeof pair === 'number') {
        if (!Number.isFinite(pair) || pair < min || pair > max) fail(name, `must be within [${min}, ${max}], got ${pair}`);
        return [pair, pair];
      }
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
        fail(name, `must be a number or a [min, max] pair, got ${JSON.stringify(pair)}`);
      }
      if (pair[0] > pair[1]) fail(name, `must be ascending, got ${JSON.stringify(pair)}`);
      if (pair[0] < min || pair[1] > max) fail(name, `must stay within [${min}, ${max}], got ${JSON.stringify(pair)}`);
      return [pair[0], pair[1]];
    },
    boolean(name, fallback) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'boolean') fail(name, `must be true or false, got ${JSON.stringify(value)}`);
      return value;
    },
    /** A non-empty string. */
    string(name, fallback) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'string' || value.length === 0) fail(name, `must be a non-empty string, got ${JSON.stringify(value)}`);
      return value;
    },
    /** One of the allowed strings. */
    choice(name, fallback, allowed) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (!allowed.includes(value)) fail(name, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
      return value;
    },
    /** An sRGB colour as 0xRRGGBB. */
    color(name, fallback) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (!Number.isInteger(value) || value < 0 || value > 0xffffff) fail(name, `must be a 0xRRGGBB colour, got ${JSON.stringify(value)}`);
      return value;
    },
    /** A plain object (or the fallback), for nested param groups. */
    object(name, fallback) {
      const value = source[name];
      if (value === undefined) return fallback;
      if (value === null) return null;
      if (typeof value !== 'object' || Array.isArray(value)) fail(name, `must be an object or null, got ${JSON.stringify(value)}`);
      return value;
    },
    /** An array (or the fallback). */
    array(name, fallback) {
      const value = source[name];
      if (value === undefined || value === null) return fallback;
      if (!Array.isArray(value)) fail(name, `must be an array, got ${JSON.stringify(value)}`);
      return value;
    },
    /** A reader for the nested group `name` (an object param; absent or null reads as {}). */
    nested(name) {
      const value = reader.object(name, null);
      return createParamReader(engineName, presetId, value ?? {}, `${path}.${name}`);
    },
  };
  return reader;
}

/** A value from a [low, high] pair with the seeded random generator. */
export function roll([low, high], random) {
  return low === high ? low : low + (high - low) * random();
}

/** An integer from a [low, high] pair with the seeded random generator (inclusive). */
export function rollInteger([low, high], random) {
  const min = Math.ceil(low);
  const max = Math.floor(high);
  return max <= min ? min : min + Math.min(max - min, Math.floor(random() * (max - min + 1)));
}
