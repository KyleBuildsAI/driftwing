// Weather volume forms: the parameter defaults and the deterministic puff layouts of the
// weatherVolume engine (docs/engines/weatherVolume.md is the preset author's reference).
//
// Pure: no three.js and no scene. resolveWeatherParams(params, { event }) merges a preset's engine
// params over the defaults of its form and checks them (a clear error names the field);
// layoutWeatherVolume(resolved, rng, groundAt) lays the puffs, their shading groups and the rain
// shafts out in the volume's own frame (x right, y up from the volume base, z forward along the
// heading), in typed arrays the engine reads every frame.
//
// Forms (one parameter set each, reused by many presets):
//   tower    cumulonimbus: a cauliflower tower on a flat base, an optional anvil spreading downwind,
//            an overshooting top and a lowered, slowly turning wall cloud (supercell, storm chase,
//            snow squall towers, hurricane cells)
//   cumulus  a single heaped cloud without an anvil (towering cumulus, a volcano's pyrocumulus cap)
//   lens     a stack of smooth lens clouds (lenticulars, a pileus cap)
//   bank     a low strip hugging the terrain, optionally curved and with a tall leading wall (fog
//            banks, valley fog rivers with fillBelow, sandstorm walls, hurricane rain bands)
//   sheet    a thin wide layer (a cloud sea for the glory, stratus decks, noctilucent clouds)
//   mist     a column of puffs rising and swelling from its foot (waterfall mist, geyser steam)
//
// Puff record (PUFF_STRIDE floats): x, y, z (m, the puff centre in the volume frame; y above the
// volume base, or above the puff's own ground for ground-following groups), radius (m), squash
// (half height / radius), yaw (rad), brightness, threshold (growth 0..1 at which it appears), group,
// level (0 core: drawn at every tier, 1 body: near and mid, 2 detail: near only), phase (rad, for
// the billow and the mist cycle), groundY (world m, ground-following puffs only).
// Group record (GROUP_STRIDE floats): baseY, topY (m, like the puffs' y), shading centre x, y, z,
// storm (0..1), flatBottom (1 clamps the puffs flat at baseY), spin (rad/s about the group centre),
// follow (1: y is above each puff's own ground), rise (m/s: the mist cycle).
// Shaft record (SHAFT_STRIDE floats): x, z (m, foot in the volume frame), radius (m), top (m above
// the volume base), density (0..1), fallSpeed (m/s), kind (index into RAIN_KINDS), lean (m, how far
// the foot trails along the heading), downdraft (m/s), outflow (m/s).

export const PUFF_STRIDE = 12;
export const GROUP_STRIDE = 10;
export const SHAFT_STRIDE = 10;
/** Most puffs one volume may lay out (the engine's shared mesh holds PUFF_CAPACITY in total). */
export const MAX_PUFFS_PER_VOLUME = 1000;
export const MAX_GROUPS = 8;
export const MAX_SHAFTS = 6;
export const WEATHER_FORMS = Object.freeze(['tower', 'cumulus', 'lens', 'bank', 'sheet', 'mist']);
export const RAIN_KINDS = Object.freeze(['rain', 'snow', 'dust']);
export const FAR_MODES = Object.freeze(['auto', 'coarse', 'hide']);
export const GLOW_TIMES = Object.freeze(['twilight', 'night', 'always']);
/** agl: above the ground under the anchor; msl: above sea level; anchor: above the activation position's y. */
export const BASE_MODES = Object.freeze(['agl', 'msl', 'anchor']);
const FALL_SPEEDS = Object.freeze({ rain: 9, snow: 1.4, dust: 3 });

/** Everything a preset may leave out, shared by every form. */
const COMMON_DEFAULTS = Object.freeze({
  baseMode: 'agl',
  tint: 0xffffff,
  brightness: 1,
  glow: null,
  drift: null,
  billow: 0.15,
  formSeconds: null,
  dissipateSeconds: 30,
  rain: null,
  canopyRain: 0,
  wind: null,
  farMode: 'auto',
  anvil: null,
  overshoot: 0,
  wallCloud: null,
});

/** Each form's own defaults (see docs/engines/weatherVolume.md for units and ranges). */
const FORM_DEFAULTS = Object.freeze({
  tower: Object.freeze({
    base: 900, height: 9000, radius: 2600, puffs: 150, detail: 0.35, puffSize: 0.42, storm: 0.6,
    anvil: Object.freeze({ radius: 8500, thickness: 1500, altitude: null, lean: 2600, puffs: 110, storm: 0.3 }),
    overshoot: 0.5,
    rain: 'auto',
    haze: Object.freeze({ near: 3000, far: 45000, max: 0.9 }),
    insideFog: Object.freeze({ density: 4.5, color: 0x7a838f, darkness: 0.25 }),
    turbulence: 0.45,
  }),
  cumulus: Object.freeze({
    base: 800, height: 1200, radius: 900, puffs: 40, detail: 0.35, puffSize: 0.45, storm: 0,
    haze: Object.freeze({ near: 1500, far: 20000, max: 0.9 }),
    insideFog: Object.freeze({ density: 3, color: 0xe4e8ee, darkness: 0 }),
    turbulence: 0.2,
  }),
  lens: Object.freeze({
    base: 1800, radius: 1800, aspect: 0.5, thickness: 200, layers: 3, gap: 140, puffs: 16, detail: 0.3, storm: 0, brightness: 1.04,
    haze: Object.freeze({ near: 1500, far: 30000, max: 0.9 }),
    insideFog: Object.freeze({ density: 3, color: 0xe9edf2, darkness: 0 }),
    turbulence: 0.05,
  }),
  bank: Object.freeze({
    base: 0, length: 5000, width: 1400, height: 320, puffs: 90, detail: 0.25, storm: 0.1, tint: 0xe6eaee,
    followTerrain: true, wall: 0, curve: 0, fillBelow: null,
    haze: Object.freeze({ near: 800, far: 12000, max: 0.92 }),
    insideFog: Object.freeze({ density: 7, color: 0xd9dee4, darkness: 0.05 }),
    turbulence: 0.05,
  }),
  sheet: Object.freeze({
    base: 1400, radius: 5000, thickness: 160, puffs: 150, detail: 0.2, ripple: 0, storm: 0,
    haze: Object.freeze({ near: 2000, far: 30000, max: 0.9 }),
    insideFog: Object.freeze({ density: 4, color: 0xe6eaef, darkness: 0 }),
    turbulence: 0.1,
  }),
  mist: Object.freeze({
    base: 0, radius: 220, height: 380, puffs: 48, detail: 0.3, rise: 6, storm: 0, tint: 0xf4f7f9, brightness: 1.08,
    haze: Object.freeze({ near: 600, far: 8000, max: 0.9 }),
    insideFog: Object.freeze({ density: 3.5, color: 0xeef2f5, darkness: 0 }),
    turbulence: 0.15,
  }),
});

const WIND_DEFAULTS = Object.freeze({ updraft: 0, downdraft: 0, outflow: 0, turbulence: null, wave: null });

function fail(field, message) {
  throw new Error(`[DRIFTWING] weatherVolume: param "${field}" ${message}`);
}

function numberParam(value, field, fallback, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) fail(field, `must be a finite number, got ${String(value)}`);
  if (value < min || value > max) fail(field, `must be within ${min}..${max}, got ${value}`);
  return value;
}

function colorParam(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) fail(field, `must be a 0xRRGGBB number, got ${String(value)}`);
  return value;
}

function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) fail(field, `must be one of ${allowed.join(', ')}, got ${String(value)}`);
  return value;
}

function objectParam(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be an object');
  return value;
}

/** The rain shafts of a volume: an array of shaft specs, 'auto' (a tower's own), or none. */
function resolveRain(value, form, sizes) {
  if (value === null || value === undefined) return [];
  let specs = value;
  if (value === 'auto') {
    if (form !== 'tower') return [];
    specs = [{ offset: [sizes.radius * 0.15, sizes.radius * 0.45], radius: sizes.radius * 0.6, density: 0.75 }];
  }
  if (!Array.isArray(specs)) fail('rain', "must be an array of shafts, 'auto' or null");
  if (specs.length > MAX_SHAFTS) fail('rain', `may hold at most ${MAX_SHAFTS} shafts, got ${specs.length}`);
  return specs.map((spec, index) => {
    const field = `rain[${index}]`;
    objectParam(spec, field);
    const offset = spec.offset ?? [0, 0];
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) fail(`${field}.offset`, 'must be [x, z] in metres');
    const kind = oneOf(spec.kind, RAIN_KINDS, `${field}.kind`, 'rain');
    return Object.freeze({
      offsetX: offset[0],
      offsetZ: offset[1],
      radius: numberParam(spec.radius, `${field}.radius`, sizes.radius * 0.5, 10, 20000),
      top: numberParam(spec.top, `${field}.top`, 0, -5000, 20000),
      density: numberParam(spec.density, `${field}.density`, 0.6, 0, 1),
      fallSpeed: numberParam(spec.fallSpeed, `${field}.fallSpeed`, FALL_SPEEDS[kind], 0.1, 60),
      kind,
      lean: numberParam(spec.lean, `${field}.lean`, 0, -5000, 5000),
      downdraft: numberParam(spec.downdraft, `${field}.downdraft`, 0, 0, 60),
      outflow: numberParam(spec.outflow, `${field}.outflow`, 0, 0, 60),
    });
  });
}

/**
 * Merges params over the defaults of params.form and checks every value. options.event tells an
 * event (grows in over formSeconds, default 25 s) from a site (appears whole). Returns a frozen,
 * fully resolved parameter record; throws naming the bad field.
 */
export function resolveWeatherParams(params, { event = true } = {}) {
  const source = params ?? {};
  const form = oneOf(source.form, WEATHER_FORMS, 'form', 'tower');
  const defaults = { ...COMMON_DEFAULTS, ...FORM_DEFAULTS[form] };
  const value = (key) => (source[key] !== undefined ? source[key] : defaults[key]);
  const sizes = {
    radius: numberParam(value('radius'), 'radius', defaults.radius ?? 1000, 10, 60000),
    height: numberParam(value('height'), 'height', defaults.height ?? 400, 10, 20000),
  };
  const haze = { ...defaults.haze, ...(objectParam(source.haze, 'haze') ?? {}) };
  const insideFog = { ...defaults.insideFog, ...(objectParam(source.insideFog, 'insideFog') ?? {}) };
  const wind = { ...WIND_DEFAULTS, ...(objectParam(source.wind, 'wind') ?? {}) };
  const anvilSource = source.anvil === undefined ? defaults.anvil : source.anvil;
  const anvil = anvilSource ? { ...(FORM_DEFAULTS.tower.anvil), ...objectParam(anvilSource, 'anvil') } : null;
  const wallSource = objectParam(value('wallCloud'), 'wallCloud');
  const glowSource = objectParam(value('glow'), 'glow');
  const driftSource = objectParam(value('drift'), 'drift');
  const waveSource = objectParam(wind.wave, 'wind.wave');
  const formSeconds = value('formSeconds');
  return Object.freeze({
    form,
    base: numberParam(value('base'), 'base', 0, -1000, 20000),
    baseMode: oneOf(value('baseMode'), BASE_MODES, 'baseMode', 'agl'),
    radius: sizes.radius,
    height: sizes.height,
    puffs: Math.round(numberParam(value('puffs'), 'puffs', 40, 1, MAX_PUFFS_PER_VOLUME)),
    detail: numberParam(value('detail'), 'detail', 0.3, 0, 0.8),
    puffSize: numberParam(value('puffSize'), 'puffSize', 0.42, 0.1, 1),
    storm: numberParam(value('storm'), 'storm', 0, 0, 1),
    tint: colorParam(value('tint'), 'tint', 0xffffff),
    brightness: numberParam(value('brightness'), 'brightness', 1, 0.3, 2),
    billow: numberParam(value('billow'), 'billow', 0.15, 0, 1),
    formSeconds: numberParam(formSeconds, 'formSeconds', event ? 25 : 0, 0, 1800),
    dissipateSeconds: numberParam(value('dissipateSeconds'), 'dissipateSeconds', 30, 0, 1800),
    farMode: oneOf(value('farMode'), FAR_MODES, 'farMode', 'auto'),
    canopyRain: numberParam(value('canopyRain'), 'canopyRain', 0, 0, 1),
    // tower / cumulus
    anvil: anvil ? Object.freeze({
      radius: numberParam(anvil.radius, 'anvil.radius', 8500, 100, 60000),
      thickness: numberParam(anvil.thickness, 'anvil.thickness', 1500, 20, 8000),
      altitude: numberParam(anvil.altitude, 'anvil.altitude', sizes.height * 0.84, 0, 20000),
      lean: numberParam(anvil.lean, 'anvil.lean', 2600, -40000, 40000),
      puffs: Math.round(numberParam(anvil.puffs, 'anvil.puffs', 110, 1, MAX_PUFFS_PER_VOLUME)),
      storm: numberParam(anvil.storm, 'anvil.storm', 0.3, 0, 1),
    }) : null,
    overshoot: numberParam(value('overshoot'), 'overshoot', 0, 0, 1),
    wallCloud: wallSource ? Object.freeze({
      radius: numberParam(wallSource.radius, 'wallCloud.radius', sizes.radius * 0.35, 20, 20000),
      drop: numberParam(wallSource.drop, 'wallCloud.drop', 350, 0, 5000),
      offset: numberParam(wallSource.offset, 'wallCloud.offset', -sizes.radius * 0.3, -40000, 40000),
      rotation: numberParam(wallSource.rotation, 'wallCloud.rotation', 6, -180, 180),
      puffs: Math.round(numberParam(wallSource.puffs, 'wallCloud.puffs', 22, 3, 200)),
    }) : null,
    // lens
    aspect: numberParam(value('aspect'), 'aspect', 0.5, 0.1, 2),
    thickness: numberParam(value('thickness'), 'thickness', 200, 5, 5000),
    layers: Math.round(numberParam(value('layers'), 'layers', 3, 1, MAX_GROUPS)),
    gap: numberParam(value('gap'), 'gap', 140, 0, 5000),
    // bank
    length: numberParam(value('length'), 'length', 5000, 10, 100000),
    width: numberParam(value('width'), 'width', 1400, 10, 100000),
    followTerrain: value('followTerrain') !== false,
    wall: numberParam(value('wall'), 'wall', 0, 0, 1),
    curve: numberParam(value('curve'), 'curve', 0, -300, 300),
    fillBelow: value('fillBelow') === null || value('fillBelow') === undefined ? null : numberParam(value('fillBelow'), 'fillBelow', 0, -1000, 9000),
    // sheet
    ripple: numberParam(value('ripple'), 'ripple', 0, 0, 1),
    // mist
    rise: numberParam(value('rise'), 'rise', 0, 0, 200),
    // shared
    glow: glowSource ? Object.freeze({
      color: colorParam(glowSource.color, 'glow.color', 0x9fd4ff),
      strength: numberParam(glowSource.strength, 'glow.strength', 1, 0, 8),
      when: oneOf(glowSource.when, GLOW_TIMES, 'glow.when', 'twilight'),
    }) : null,
    drift: driftSource ? Object.freeze({
      speed: numberParam(driftSource.speed, 'drift.speed', 0, 0, 200),
      heading: driftSource.heading === undefined || driftSource.heading === null ? null : numberParam(driftSource.heading, 'drift.heading', 0, -360, 720),
    }) : null,
    haze: Object.freeze({
      near: numberParam(haze.near, 'haze.near', 2000, 0, 200000),
      far: numberParam(haze.far, 'haze.far', 30000, 1, 400000),
      max: numberParam(haze.max, 'haze.max', 0.9, 0, 1),
    }),
    insideFog: Object.freeze({
      density: numberParam(insideFog.density, 'insideFog.density', 3, 1, 8),
      color: colorParam(insideFog.color, 'insideFog.color', 0xdde2e8),
      darkness: numberParam(insideFog.darkness, 'insideFog.darkness', 0, 0, 1),
    }),
    wind: Object.freeze({
      updraft: numberParam(wind.updraft, 'wind.updraft', 0, 0, 60),
      downdraft: numberParam(wind.downdraft, 'wind.downdraft', 0, 0, 60),
      outflow: numberParam(wind.outflow, 'wind.outflow', 0, 0, 60),
      turbulence: numberParam(wind.turbulence, 'wind.turbulence', defaults.turbulence ?? 0, 0, 1),
      wave: waveSource ? Object.freeze({
        lift: numberParam(waveSource.lift, 'wind.wave.lift', 4, 0, 40),
        sink: numberParam(waveSource.sink, 'wind.wave.sink', 3, 0, 40),
        rotor: numberParam(waveSource.rotor, 'wind.wave.rotor', 0.5, 0, 1),
      }) : null,
    }),
    rain: Object.freeze(resolveRain(value('rain'), form, sizes)),
  });
}

// ---- Layout ------------------------------------------------------------------------------------------
/** An empty layout (allocated once per volume, at create). */
function createLayout() {
  return {
    puffs: new Float32Array(MAX_PUFFS_PER_VOLUME * PUFF_STRIDE),
    puffCount: 0,
    groups: new Float32Array(MAX_GROUPS * GROUP_STRIDE),
    groupCount: 0,
    shafts: new Float32Array(MAX_SHAFTS * SHAFT_STRIDE),
    shaftCount: 0,
    // Horizontal reach (m) from the anchor and the vertical span above the base.
    reach: 0,
    bottom: 0,
    top: 0,
  };
}

function addGroup(layout, baseY, topY, centreX, centreY, centreZ, storm, flatBottom, spin = 0, follow = 0, rise = 0) {
  if (layout.groupCount >= MAX_GROUPS) throw new Error(`[DRIFTWING] weatherVolume: more than ${MAX_GROUPS} shading groups`);
  const offset = layout.groupCount * GROUP_STRIDE;
  const groups = layout.groups;
  groups[offset] = baseY;
  groups[offset + 1] = topY;
  groups[offset + 2] = centreX;
  groups[offset + 3] = centreY;
  groups[offset + 4] = centreZ;
  groups[offset + 5] = storm;
  groups[offset + 6] = flatBottom ? 1 : 0;
  groups[offset + 7] = spin;
  groups[offset + 8] = follow ? 1 : 0;
  groups[offset + 9] = rise;
  return layout.groupCount++;
}

/** Appends one puff; returns false when the volume is full. */
function addPuff(layout, x, y, z, radius, squash, yaw, brightness, threshold, group, level, phase, groundY = 0) {
  if (layout.puffCount >= MAX_PUFFS_PER_VOLUME) return false;
  const offset = layout.puffCount * PUFF_STRIDE;
  const puffs = layout.puffs;
  puffs[offset] = x;
  puffs[offset + 1] = y;
  puffs[offset + 2] = z;
  puffs[offset + 3] = radius;
  puffs[offset + 4] = squash;
  puffs[offset + 5] = yaw;
  puffs[offset + 6] = brightness;
  puffs[offset + 7] = Math.min(0.95, Math.max(0, threshold));
  puffs[offset + 8] = group;
  puffs[offset + 9] = level;
  puffs[offset + 10] = phase;
  puffs[offset + 11] = groundY;
  layout.puffCount++;
  layout.reach = Math.max(layout.reach, Math.sqrt(x * x + z * z) + radius);
  layout.top = Math.max(layout.top, y + radius * squash);
  layout.bottom = Math.min(layout.bottom, y - radius * squash);
  return true;
}

function addShaft(layout, shaft) {
  const offset = layout.shaftCount * SHAFT_STRIDE;
  const shafts = layout.shafts;
  shafts[offset] = shaft.offsetX;
  shafts[offset + 1] = shaft.offsetZ;
  shafts[offset + 2] = shaft.radius;
  shafts[offset + 3] = shaft.top;
  shafts[offset + 4] = shaft.density;
  shafts[offset + 5] = shaft.fallSpeed;
  shafts[offset + 6] = RAIN_KINDS.indexOf(shaft.kind);
  shafts[offset + 7] = shaft.lean;
  shafts[offset + 8] = shaft.downdraft;
  shafts[offset + 9] = shaft.outflow;
  layout.shaftCount++;
  layout.reach = Math.max(layout.reach, Math.sqrt(shaft.offsetX * shaft.offsetX + shaft.offsetZ * shaft.offsetZ) + shaft.radius + Math.abs(shaft.lean));
}

/** How many of count puffs are detail puffs (level 2). */
function detailCount(count, detail) {
  return Math.round(count * detail);
}

/** A point in the unit disc, area-uniform, into out ({ x, z }). */
function discPoint(rng, out) {
  const radius = Math.sqrt(rng());
  const angle = rng() * Math.PI * 2;
  out.x = Math.cos(angle) * radius;
  out.z = Math.sin(angle) * radius;
  return out;
}

/** Radius of a tower at height fraction h: a wide skirt at the base, bulging body, narrower crown. */
function towerEnvelope(radius, h) {
  const skirt = 0.12 * Math.max(0, 1 - h * 6);
  const bulge = 0.08 * Math.sin(h * Math.PI * 3.2);
  return radius * (0.98 - 0.3 * h + skirt + bulge);
}

function layoutTower(layout, params, rng, withAnvil) {
  const { radius, height, puffs, puffSize, storm } = params;
  const body = addGroup(layout, 0, height, 0, height * 0.32, 0, storm, true);
  const cores = Math.max(3, Math.min(12, Math.round(height / (radius * 0.9))));
  // Core column (level 0): the silhouette every tier keeps.
  for (let index = 0; index < cores; index++) {
    const h = (index + 0.5) / cores;
    const envelope = towerEnvelope(radius, h);
    const puffRadius = envelope * 0.86;
    const squash = index === 0 ? 0.62 : 0.82;
    const y = Math.max(puffRadius * squash * 0.3, h * height - puffRadius * squash * 0.25);
    addPuff(layout, (rng() - 0.5) * envelope * 0.15, y, (rng() - 0.5) * envelope * 0.15, puffRadius, squash, rng() * Math.PI, 1, 0.04 + 0.5 * h, body, 0, rng() * Math.PI * 2);
  }
  // The flat skirt: wide low puffs around the base.
  const skirt = Math.max(4, Math.round(puffs * 0.1));
  for (let index = 0; index < skirt; index++) {
    const angle = (index / skirt) * Math.PI * 2 + rng() * 0.5;
    const reach = radius * (0.65 + 0.45 * rng());
    const puffRadius = radius * (0.38 + 0.14 * rng());
    const squash = 0.46 + 0.1 * rng();
    addPuff(layout, Math.cos(angle) * reach, puffRadius * squash * 0.35, Math.sin(angle) * reach, puffRadius, squash, rng() * Math.PI, 0.94 + 0.06 * rng(), 0.05 + 0.1 * rng(), body, 1, rng() * Math.PI * 2);
  }
  // Body and detail puffs on the surface of the envelope, heaped toward the crown.
  const remaining = Math.max(0, puffs - cores - skirt);
  const details = detailCount(remaining, params.detail);
  for (let index = 0; index < remaining; index++) {
    const detail = index < details;
    const h = Math.pow(rng(), 0.9);
    const envelope = towerEnvelope(radius, h);
    const angle = rng() * Math.PI * 2;
    const reach = envelope * (detail ? 0.82 + 0.22 * rng() : 0.5 + 0.38 * rng());
    const puffRadius = envelope * puffSize * (detail ? 0.45 + 0.25 * rng() : 0.8 + 0.45 * rng());
    const squash = 0.74 + 0.2 * rng();
    const y = Math.max(puffRadius * squash * 0.35, h * height);
    addPuff(layout, Math.cos(angle) * reach, y, Math.sin(angle) * reach, puffRadius, squash, rng() * Math.PI, 0.93 + 0.08 * rng(), 0.06 + 0.55 * h + 0.1 * rng() + (detail ? 0.1 : 0), body, detail ? 2 : 1, rng() * Math.PI * 2);
  }
  if (withAnvil && params.anvil) layoutAnvil(layout, params, rng);
  if (params.overshoot > 0) {
    const anvilTop = params.anvil ? params.anvil.altitude + params.anvil.thickness * 0.5 : height;
    const domeRadius = radius * 0.55 * params.overshoot;
    const dome = Math.max(3, Math.round(6 * params.overshoot));
    for (let index = 0; index < dome; index++) {
      const angle = (index / dome) * Math.PI * 2;
      const reach = index === 0 ? 0 : domeRadius * 0.6;
      const puffRadius = domeRadius * (index === 0 ? 1 : 0.62);
      addPuff(layout, Math.cos(angle) * reach, anvilTop - puffRadius * 0.15, Math.sin(angle) * reach, puffRadius, 0.7, rng() * Math.PI, 1.02, 0.7 + 0.1 * rng(), body, index === 0 ? 0 : 1, rng() * Math.PI * 2);
    }
  }
  if (params.wallCloud) layoutWallCloud(layout, params, rng);
}

function layoutAnvil(layout, params, rng) {
  const anvil = params.anvil;
  const baseY = anvil.altitude - anvil.thickness * 0.5;
  // The anvil streams downwind (+z, the heading) from the tower, with a short overhang upwind.
  const centreZ = anvil.lean * 0.3 + anvil.radius * 0.25;
  const group = addGroup(layout, baseY, anvil.altitude + anvil.thickness * 0.5, 0, anvil.altitude, centreZ, anvil.storm, true);
  const point = { x: 0, z: 0 };
  const details = detailCount(anvil.puffs, params.detail * 0.6);
  for (let index = 0; index < anvil.puffs; index++) {
    const detail = index >= anvil.puffs - details;
    discPoint(rng, point);
    const edge = point.x * point.x + point.z * point.z;
    // Semi-axes: long downwind, narrower across; the upwind rim sits over the tower.
    const x = point.x * anvil.radius * 0.78;
    const z = centreZ + point.z * anvil.radius * 0.85;
    const puffRadius = anvil.radius * (detail ? 0.11 : 0.24) * (0.8 + 0.4 * rng()) * (1 - 0.3 * edge);
    const squash = Math.min(0.5, Math.max(0.16, (anvil.thickness * (1 - 0.45 * edge)) / (2.2 * puffRadius)));
    const y = anvil.altitude + (rng() - 0.5) * anvil.thickness * 0.25 - edge * anvil.thickness * 0.15;
    const level = index < 6 ? 0 : detail ? 2 : 1;
    addPuff(layout, x, y, z, puffRadius, squash, rng() * Math.PI, 0.98 + 0.05 * rng(), 0.55 + 0.3 * Math.sqrt(edge) + 0.1 * rng(), group, level, rng() * Math.PI * 2);
  }
}

function layoutWallCloud(layout, params, rng) {
  const wall = params.wallCloud;
  const spin = (wall.rotation * Math.PI) / 180;
  const group = addGroup(layout, -wall.drop, 0, 0, -wall.drop * 0.5, wall.offset, 1, true, spin);
  for (let index = 0; index < wall.puffs; index++) {
    const ring = index % 3;
    const angle = (index / wall.puffs) * Math.PI * 2 * 3 + rng() * 0.4;
    const reach = wall.radius * (ring === 0 ? 0.2 : 0.55 + 0.25 * rng());
    const puffRadius = wall.radius * (0.42 + 0.18 * rng());
    const squash = 0.6 + 0.2 * rng();
    const y = -wall.drop + puffRadius * squash * (0.3 + 0.7 * (ring / 2)) + rng() * wall.drop * 0.3;
    addPuff(layout, Math.cos(angle) * reach, y, wall.offset + Math.sin(angle) * reach, puffRadius, squash, rng() * Math.PI, 0.9, 0.2 + 0.3 * rng(), group, ring === 0 ? 0 : 1, rng() * Math.PI * 2);
  }
}

function layoutLens(layout, params, rng) {
  const { radius, aspect, thickness, layers, gap, puffs } = params;
  for (let layer = 0; layer < layers; layer++) {
    const layerRadius = radius * (1 - 0.18 * layer);
    const y = layer * (thickness + gap) + thickness * 0.5;
    const group = addGroup(layout, y - thickness * 0.5, y + thickness * 0.5, 0, y, 0, params.storm, false);
    const spine = Math.max(3, puffs);
    const details = detailCount(spine, params.detail);
    for (let index = 0; index < spine; index++) {
      const t = spine === 1 ? 0 : (index / (spine - 1)) * 2 - 1;
      const across = Math.sqrt(Math.max(0, 1 - t * t));
      const detail = index % Math.max(1, Math.round(spine / Math.max(1, details))) === 1 && details > 0;
      const puffRadius = layerRadius * aspect * (0.55 * across + 0.16) * (detail ? 0.6 : 1);
      const squash = Math.min(0.5, Math.max(0.12, thickness / (2 * puffRadius)));
      const x = t * layerRadius * 0.86;
      const z = (rng() - 0.5) * layerRadius * aspect * 0.12 + (detail ? (rng() < 0.5 ? -1 : 1) * puffRadius * 0.7 : 0);
      const level = Math.abs(t) < 0.5 && !detail ? 0 : detail ? 2 : 1;
      addPuff(layout, x, y + (rng() - 0.5) * thickness * 0.1, z, puffRadius, squash, rng() * Math.PI, params.brightness * (0.97 + 0.04 * rng()), 0.1 + 0.4 * Math.abs(t) + 0.15 * layer, group, level, rng() * Math.PI * 2);
    }
  }
}

function layoutBank(layout, params, rng, groundAt, frame) {
  const { length, width, height, puffs, wall, curve, fillBelow, followTerrain } = params;
  const group = addGroup(layout, 0, height * (1 + 3 * wall), 0, height * 0.4, 0, params.storm, false, 0, followTerrain);
  const curveRadians = (curve * Math.PI) / 180;
  const arcRadius = Math.abs(curveRadians) > 1e-4 ? length / curveRadians : 0;
  const details = detailCount(puffs, params.detail);
  let placed = 0;
  // Candidates dropped by fillBelow are replaced, up to three tries per puff.
  for (let attempt = 0; attempt < puffs * 3 && placed < puffs; attempt++) {
    const detail = placed >= puffs - details;
    const t = rng() - 0.5;
    const s = (rng() - 0.5 + (rng() - 0.5)) * 0.5;
    let x = t * length;
    let z = s * width;
    if (arcRadius !== 0) {
      const angle = t * curveRadians;
      const bend = arcRadius - z;
      x = Math.sin(angle) * bend;
      z = arcRadius - Math.cos(angle) * bend;
    }
    const front = Math.min(1, Math.max(0, s + 0.5));
    const lift = 1 + 3 * wall * front * front;
    const puffRadius = height * (detail ? 0.5 : 0.95) * (0.8 + 0.4 * rng()) * (1 + 0.5 * wall * front);
    const squash = Math.min(1, 0.45 * lift);
    let groundY = 0;
    if (followTerrain) {
      groundY = groundAt(frame.x + x * frame.rightX + z * frame.forwardX, frame.z + x * frame.rightZ + z * frame.forwardZ);
      if (fillBelow !== null && groundY > fillBelow) continue;
    }
    const y = puffRadius * squash * (0.35 + 0.2 * rng());
    const level = placed % 4 === 0 && !detail ? 0 : detail ? 2 : 1;
    if (!addPuff(layout, x, y, z, puffRadius, squash, rng() * Math.PI, params.brightness * (0.95 + 0.06 * rng()), 0.05 + 0.5 * Math.abs(t) + 0.2 * rng(), group, level, rng() * Math.PI * 2, groundY)) break;
    placed++;
  }
}

function layoutSheet(layout, params, rng) {
  const { radius, thickness, puffs, ripple } = params;
  const group = addGroup(layout, 0, thickness, 0, thickness * 0.3, 0, params.storm, true);
  const spacing = radius * Math.sqrt(Math.PI / Math.max(1, puffs));
  const point = { x: 0, z: 0 };
  const details = detailCount(puffs, params.detail);
  const waves = 2 + ripple * 10;
  for (let index = 0; index < puffs; index++) {
    const detail = index >= puffs - details;
    discPoint(rng, point);
    const x = point.x * radius;
    const z = point.z * radius;
    const band = Math.sin((x / radius) * waves * Math.PI + z * 0.0004);
    const puffRadius = spacing * (detail ? 0.7 : 1.35) * (0.85 + 0.3 * rng());
    const squash = Math.min(0.5, Math.max(0.12, thickness / (2 * puffRadius)));
    const y = puffRadius * squash * 0.4 + (rng() - 0.5) * thickness * 0.3 + ripple * band * thickness * 0.5;
    const brightness = params.brightness * (0.96 + 0.06 * rng()) * (1 + 0.14 * ripple * band);
    const level = index % 5 === 0 && !detail ? 0 : detail ? 2 : 1;
    addPuff(layout, x, y, z, puffRadius, squash, rng() * Math.PI, brightness, 0.05 + 0.6 * (point.x * point.x + point.z * point.z) + 0.1 * rng(), group, level, rng() * Math.PI * 2);
  }
}

function layoutMist(layout, params, rng) {
  const { radius, height, puffs, rise } = params;
  const group = addGroup(layout, 0, height, 0, height * 0.35, 0, params.storm, false, 0, false, rise);
  const point = { x: 0, z: 0 };
  const details = detailCount(puffs, params.detail);
  for (let index = 0; index < puffs; index++) {
    const detail = index >= puffs - details;
    discPoint(rng, point);
    const puffRadius = radius * (detail ? 0.2 : 0.32) * (0.8 + 0.4 * rng());
    // With rise > 0 the phase (0..1 of the height) cycles the puff up the column; y is its start.
    const start = index / puffs;
    addPuff(layout, point.x * radius * 0.55, start * height, point.z * radius * 0.55, puffRadius, 0.85, rng() * Math.PI, params.brightness * (0.97 + 0.05 * rng()), 0.05 + 0.5 * rng(), group, index % 4 === 0 ? 0 : detail ? 2 : 1, start * Math.PI * 2);
  }
}

/**
 * Lays a resolved volume out. rng is the spawn's seeded generator; groundAt(x, z) is the ground or
 * water height (m) for ground-following banks; frame ({ x, z, rightX, rightZ, forwardX, forwardZ })
 * places the volume frame in the world for those ground samples. Returns the layout (typed arrays).
 */
export function layoutWeatherVolume(params, rng, groundAt, frame) {
  const layout = createLayout();
  switch (params.form) {
    case 'tower': layoutTower(layout, params, rng, true); break;
    case 'cumulus': layoutTower(layout, params, rng, false); break;
    case 'lens': layoutLens(layout, params, rng); break;
    case 'bank': layoutBank(layout, params, rng, groundAt, frame); break;
    case 'sheet': layoutSheet(layout, params, rng); break;
    case 'mist': layoutMist(layout, params, rng); break;
    default: throw new Error(`[DRIFTWING] weatherVolume: unknown form "${params.form}"`);
  }
  for (const shaft of params.rain) addShaft(layout, shaft);
  return layout;
}
