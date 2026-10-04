// Celestial engine parameters: defaults and checks (docs/engines/celestial.md is the preset author's
// reference). Pure: no three.js.
//
// A celestial instance is a set of optional components, so one preset can combine them (a meteor
// shower under a comet, a moonbow in a waterfall's mist, an eclipse that also raises the stars):
//   meteors  streaks from a radiant, occasional fireballs with a brief flash of light
//   comet    a nucleus and coma with a curved dust tail pointing away from the sun and a straight ion tail
//   eclipse  the moon's disc crossing the sun, the corona, Baily's beads, the sky, fog and light darkening
//   glory    the glory and the full-circle rainbow on every cloud around the craft's own shadow
//   rainbow  a rainbow (or moonbow) inside a volume of mist (a sphere), seen with the light behind you
//   sky      a static sky modifier (stars, darkness, tints) eased in and out with the instance

export const CELESTIAL_COMPONENTS = Object.freeze(['meteors', 'comet', 'eclipse', 'glory', 'rainbow', 'sky']);
export const CELESTIAL_ANCHORS = Object.freeze(['sky', 'world']);
export const LIGHT_SOURCES = Object.freeze(['sun', 'moon']);
export const SKY_WHEN = Object.freeze(['always', 'day', 'night']);
const SKY_SCALARS = Object.freeze({
  sunIntensity: [0, 4], ambient: [0, 4], fogDensity: [0.25, 8], darkness: [0, 1], overcast: [0, 1], stars: [0, 1], skyTintAmount: [0, 1], fogColorAmount: [0, 1],
});

function fail(field, message) {
  throw new Error(`[DRIFTWING] celestial: param "${field}" ${message}`);
}

function number(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) fail(field, `must be a finite number, got ${String(value)}`);
  if (value < min || value > max) fail(field, `must be within ${min}..${max}, got ${value}`);
  return value;
}

function color(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) fail(field, `must be a 0xRRGGBB number, got ${String(value)}`);
  return value;
}

function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) fail(field, `must be one of ${allowed.join(', ')}, got ${String(value)}`);
  return value;
}

/** A component block: undefined, null or false leave it out; true takes its defaults. */
function block(value, field) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be an object, true or null');
  return value;
}

/** An optional sky direction { azimuth (compass deg), elevation (deg) }, or null (seeded). */
function direction(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') fail(field, 'must be { azimuth, elevation } in degrees or null');
  return Object.freeze({
    azimuth: number(value.azimuth, `${field}.azimuth`, 0, -360, 720),
    elevation: number(value.elevation, `${field}.elevation`, 45, -90, 90),
  });
}

/** A [min, max] range, or a single number used for both. */
function range(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (Number.isFinite(value)) return Object.freeze([number(value, field, value, min, max), value]);
  if (!Array.isArray(value) || value.length !== 2) fail(field, 'must be a number or [min, max]');
  const low = number(value[0], `${field}[0]`, fallback[0], min, max);
  const high = number(value[1], `${field}[1]`, fallback[1], min, max);
  if (high < low) fail(field, `must have max >= min, got [${low}, ${high}]`);
  return Object.freeze([low, high]);
}

function resolveMeteors(source) {
  const field = 'meteors';
  return Object.freeze({
    radiant: direction(source.radiant, `${field}.radiant`),
    rate: number(source.rate, `${field}.rate`, 18, 0.1, 600),
    fireballChance: number(source.fireballChance, `${field}.fireballChance`, 0.05, 0, 1),
    fireballFlash: number(source.fireballFlash, `${field}.fireballFlash`, 0.6, 0, 1),
    speed: number(source.speed, `${field}.speed`, 24, 2, 120),
    length: range(source.length, `${field}.length`, Object.freeze([5, 14]), 0.5, 90),
    spread: number(source.spread, `${field}.spread`, 55, 5, 120),
    color: color(source.color, `${field}.color`, 0xd9fff0),
    trail: color(source.trail, `${field}.trail`, 0xffc98f),
    brightness: number(source.brightness, `${field}.brightness`, 1, 0, 4),
    maxActive: Math.round(number(source.maxActive, `${field}.maxActive`, 24, 1, 48)),
    daylight: source.daylight === true,
  });
}

function resolveComet(source) {
  const field = 'comet';
  return Object.freeze({
    position: direction(source.position, `${field}.position`),
    tailLength: number(source.tailLength, `${field}.tailLength`, 22, 2, 90),
    tailWidth: number(source.tailWidth, `${field}.tailWidth`, 4, 0.2, 30),
    curvature: number(source.curvature, `${field}.curvature`, 0.3, -1, 1),
    headSize: number(source.headSize, `${field}.headSize`, 0.8, 0.05, 10),
    brightness: number(source.brightness, `${field}.brightness`, 1, 0, 4),
    color: color(source.color, `${field}.color`, 0xfff0d2),
    ionColor: color(source.ionColor, `${field}.ionColor`, 0x7fb4ff),
    ionTail: number(source.ionTail, `${field}.ionTail`, 0.6, 0, 1),
    sidereal: source.sidereal !== false,
  });
}

function resolveEclipse(source, duration) {
  const field = 'eclipse';
  const lifetime = Number.isFinite(duration) && duration > 0 ? duration : 150;
  return Object.freeze({
    crossingSeconds: number(source.crossingSeconds, `${field}.crossingSeconds`, Math.min(90, lifetime * 0.8), 10, 3600),
    totalitySeconds: number(source.totalitySeconds, `${field}.totalitySeconds`, 14, 1, 600),
    pathAngle: source.pathAngle === undefined || source.pathAngle === null ? null : number(source.pathAngle, `${field}.pathAngle`, 0, -360, 360),
    offset: number(source.offset, `${field}.offset`, 0, -3, 3),
    moonScale: number(source.moonScale, `${field}.moonScale`, 1.06, 0.8, 1.4),
    darkness: number(source.darkness, `${field}.darkness`, 0.78, 0, 1),
    stars: number(source.stars, `${field}.stars`, 0.95, 0, 1),
    corona: number(source.corona, `${field}.corona`, 1, 0, 3),
    quietWildlife: source.quietWildlife !== false,
  });
}

function resolveGlory(source) {
  const field = 'glory';
  return Object.freeze({
    strength: number(source.strength, `${field}.strength`, 1, 0, 2),
    bow: number(source.bow, `${field}.bow`, 0.7, 0, 2),
    minSunElevation: number(source.minSunElevation, `${field}.minSunElevation`, 2, -5, 89),
    maxSunElevation: number(source.maxSunElevation, `${field}.maxSunElevation`, 70, -4, 90),
  });
}

function resolveRainbow(source) {
  const field = 'rainbow';
  const offset = source.offset ?? [0, 0];
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) fail(`${field}.offset`, 'must be [x, z] in metres');
  return Object.freeze({
    radius: number(source.radius, `${field}.radius`, 180, 5, 20000),
    height: number(source.height, `${field}.height`, 120, -2000, 20000),
    offsetX: offset[0],
    offsetZ: offset[1],
    strength: number(source.strength, `${field}.strength`, 1, 0, 3),
    secondary: number(source.secondary, `${field}.secondary`, 0.35, 0, 1),
    light: oneOf(source.light, LIGHT_SOURCES, `${field}.light`, 'sun'),
  });
}

function resolveSky(source) {
  const field = 'sky';
  const values = {};
  for (const [key, [min, max]] of Object.entries(SKY_SCALARS)) {
    if (source[key] !== undefined) values[key] = number(source[key], `${field}.${key}`, 0, min, max);
  }
  if (source.skyTint !== undefined) values.skyTint = color(source.skyTint, `${field}.skyTint`, 0xffffff);
  if (source.fogColor !== undefined) values.fogColor = color(source.fogColor, `${field}.fogColor`, 0xffffff);
  const known = [...Object.keys(SKY_SCALARS), 'skyTint', 'fogColor', 'when'];
  for (const key of Object.keys(source)) if (!known.includes(key)) fail(`${field}.${key}`, `is not a known field (known: ${known.join(', ')})`);
  return Object.freeze({ values: Object.freeze(values), when: oneOf(source.when, SKY_WHEN, `${field}.when`, 'always') });
}

/**
 * Resolves a preset's celestial params (see the header). duration is the instance's (s, or null for
 * a site). Throws naming the bad field; at least one component is required.
 */
export function resolveCelestialParams(params, duration = null) {
  const source = params ?? {};
  const meteors = block(source.meteors, 'meteors');
  const comet = block(source.comet, 'comet');
  const eclipse = block(source.eclipse, 'eclipse');
  const glory = block(source.glory, 'glory');
  const rainbow = block(source.rainbow, 'rainbow');
  const sky = block(source.sky, 'sky');
  if (!meteors && !comet && !eclipse && !glory && !rainbow && !sky) fail('meteors', `needs at least one component (${CELESTIAL_COMPONENTS.join(', ')})`);
  return Object.freeze({
    anchor: oneOf(source.anchor, CELESTIAL_ANCHORS, 'anchor', rainbow ? 'world' : 'sky'),
    anchorDistance: number(source.anchorDistance, 'anchorDistance', 1500, 50, 20000),
    fadeIn: number(source.fadeIn, 'fadeIn', 6, 0, 600),
    fadeOut: number(source.fadeOut, 'fadeOut', 10, 0, 600),
    untilDawn: source.untilDawn === true,
    dawnElevation: number(source.dawnElevation, 'dawnElevation', -6, -18, 20),
    meteors: meteors ? resolveMeteors(meteors) : null,
    comet: comet ? resolveComet(comet) : null,
    eclipse: eclipse ? resolveEclipse(eclipse, duration) : null,
    glory: glory ? resolveGlory(glory) : null,
    rainbow: rainbow ? resolveRainbow(rainbow) : null,
    sky: sky ? resolveSky(sky) : null,
  });
}
