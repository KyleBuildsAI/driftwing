import { headingFromVector, wrapDegrees, compassName } from '../core/util.js';
import { describeAssists } from '../flight/assists.js';
import { formatSpeed } from './grammar.js';

/**
 * The v2 half of WREN's flight-state snapshot (the one both brains read, and the body of every remote
 * request; docs/copilot-api.md lists each field), plus what a craft can do, read from its module.
 */

/** Audio engine families that mean the craft has an engine or motors. */
const ENGINE_FAMILIES = new Set(['prop', 'jet', 'heli', 'drone']);

const round = (value, digits = 0) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * What a craft module supports: { engine, chute, flaps, throttle }. A module may declare
 * capabilities: { engine, chute } outright; otherwise they come from its data (a simProfile engine
 * block or an engine audio family; a simProfile chute block; flap notches; a throttle axis).
 */
export function craftCapabilities(module) {
  const declared = module && module.capabilities && typeof module.capabilities === 'object' ? module.capabilities : {};
  const simProfile = module?.simProfile ?? {};
  const engine = typeof declared.engine === 'boolean'
    ? declared.engine
    : Boolean(simProfile.engine) || ENGINE_FAMILIES.has(module?.audioProfile?.engine);
  const chute = typeof declared.chute === 'boolean' ? declared.chute : Boolean(simProfile.chute);
  return {
    engine,
    chute,
    flaps: Number(module?.inputProfile?.flapNotches) > 0,
    throttle: module?.inputProfile?.throttle !== 'none',
  };
}

/**
 * The craftState fields a remote brain reads, per craft (contract h.3, plus the Phase 1 craft's own
 * switches and the spaceplane's climb to space). Anything else in craftState (timers, animation
 * phases, caches) stays in the game.
 */
export const CRAFT_STATE_FIELDS = Object.freeze({
  glider: Object.freeze(['ballast', 'dumping']),
  bushplane: Object.freeze(['smoke']),
  jet: Object.freeze(['afterburner', 'mach', 'overG']),
  helicopter: Object.freeze(['hoverHold']),
  wingsuit: Object.freeze(['canopy', 'phase']),
  fpv: Object.freeze(['droneMode', 'altitudeHold', 'turtle']),
  aerobatic: Object.freeze(['smoke', 'smokeColor', 'figureInProgress', 'lastFigure']),
  seaplane: Object.freeze(['onWater', 'onStep', 'waterRudders', 'porpoise', 'noseOverWarning']),
  tiltrotor: Object.freeze(['nacelleAngle', 'nacelleTarget', 'autoNacelle', 'corridor']),
  paraglider: Object.freeze(['brakeLeft', 'brakeRight', 'speedBar', 'bigEars', 'collapse', 'pendulum']),
  balloon: Object.freeze(['envelopeTemperature', 'ambientTemperature', 'burner', 'vent', 'altitudeHold', 'windColumn']),
  airship: Object.freeze(['ballonet', 'vectorAngle', 'scenicCruise']),
  eagle: Object.freeze(['skin', 'perched', 'perchId', 'flapPower', 'wingTuck']),
  spaceplane: Object.freeze(['apogee', 'dynamicPressure', 'rcsBlend', 'heating', 'blackout', 'attitudeHold', 'autoReentry', 'spaceClimb', 'spaceClimbPeak']),
});
/** Nested records keep only these fields (the wind column's bands, the cruise's waypoints, ...). */
const NESTED_FIELDS = Object.freeze({
  lastFigure: Object.freeze(['figure', 'score']),
  corridor: Object.freeze(['min', 'max', 'state']),
  collapse: Object.freeze(['left', 'right']),
  windColumn: Object.freeze(['altitude', 'fromDegrees', 'speed']),
  scenicCruise: Object.freeze(['active', 'index', 'waypoints']),
  waypoints: Object.freeze(['name', 'x', 'z']),
});
/** The snapshot's bounds: list length, string length and depth. */
const MAX_LIST = 12;
const MAX_TEXT = 48;
const MAX_DEPTH = 3;

/** One craftState value as plain, rounded, bounded data; undefined drops it. */
function plainValue(value, key, depth) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? round(value, 2) : null;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (depth >= MAX_DEPTH || typeof value !== 'object') return undefined;
  const fields = NESTED_FIELDS[key];
  if (Array.isArray(value)) {
    const list = [];
    for (const item of value.slice(0, MAX_LIST)) {
      const plain = plainValue(item, key, depth + 1);
      if (plain !== undefined) list.push(plain);
    }
    return list;
  }
  if (!fields) return undefined;
  const record = {};
  for (const field of fields) {
    const plain = plainValue(value[field], field, depth + 1);
    if (plain !== undefined) record[field] = plain;
  }
  return record;
}

/**
 * The active craft's state for a remote brain (contract h.3): its listed fields only, numbers rounded to
 * 2 decimals, strings cut to 48 characters, lists to 12 entries, nested records to their listed fields.
 */
export function craftStateSnapshot(craft, craftState) {
  const fields = CRAFT_STATE_FIELDS[craft];
  const snapshot = {};
  if (!fields || !craftState || typeof craftState !== 'object') return snapshot;
  for (const field of fields) {
    if (!(field in craftState)) continue;
    const plain = plainValue(craftState[field], field, 0);
    if (plain !== undefined) snapshot[field] = plain;
  }
  return snapshot;
}

/** state.challenge (contract f.2) as plain data for a remote brain, or null with no course near or running. */
export function challengeSnapshot(challenge) {
  if (!challenge || typeof challenge !== 'object') return null;
  const prompt = challenge.prompt && typeof challenge.prompt === 'object'
    ? { name: String(challenge.prompt.name ?? '').slice(0, MAX_TEXT), distance: Math.round(challenge.prompt.distance), bearing: Math.round(challenge.prompt.bearing) % 360 }
    : null;
  if (!challenge.active && !prompt) return null;
  const next = challenge.nextGate && typeof challenge.nextGate === 'object' ? { distance: Math.round(challenge.nextGate.distance), bearing: Math.round(challenge.nextGate.bearing) % 360 } : null;
  return {
    active: Boolean(challenge.active),
    name: typeof challenge.name === 'string' ? challenge.name.slice(0, MAX_TEXT) : null,
    phase: typeof challenge.phase === 'string' ? challenge.phase : null,
    elapsed: round(challenge.elapsed, 1),
    gateIndex: Number.isFinite(challenge.gateIndex) ? challenge.gateIndex : 0,
    gatesTotal: Number.isFinite(challenge.gatesTotal) ? challenge.gatesTotal : 0,
    nextGate: next,
    missed: Number.isFinite(challenge.missed) ? challenge.missed : 0,
    penalties: round(challenge.penalties, 1),
    lastSplit: challenge.lastSplit && typeof challenge.lastSplit === 'object' ? { index: challenge.lastSplit.index, time: round(challenge.lastSplit.time, 1), delta: Number.isFinite(challenge.lastSplit.delta) ? round(challenge.lastSplit.delta, 1) : null } : null,
    medalPace: typeof challenge.medalPace === 'string' ? challenge.medalPace : null,
    best: Number.isFinite(challenge.best) ? round(challenge.best, 1) : null,
    rival: challenge.rival && typeof challenge.rival === 'object' ? { distanceAhead: Math.round(challenge.rival.distanceAhead) } : null,
    prompt,
  };
}

/** Plain copy of a landing record from state.flight, or null. */
function landingRecord(record) {
  if (!record || typeof record.grade !== 'string') return null;
  return { grade: record.grade, sinkRate: round(record.sinkRate, 2), groundSpeed: round(record.groundSpeed, 1), craft: record.craft ?? null };
}

/**
 * The v2 flight-state fields, from state.flight (telemetry), the flight controller and settings.
 * extras: { view, landingCount } kept by the copilot system.
 */
export function buildFlightFields(ctx, extras = {}) {
  const { state, settings } = ctx;
  const telemetry = state.flight;
  const flight = ctx.systems.flight;
  const registry = ctx.craftRegistry;
  const craft = typeof flight?.getCraft === 'function' ? flight.getCraft() : telemetry.craft;
  const module = typeof flight?.getCraftModule === 'function' ? flight.getCraftModule() : registry?.get?.(craft) ?? null;
  const catalogEntry = registry?.catalog?.find((entry) => entry.id === craft) ?? null;
  const units = settings.get('units') === 'aviation' ? 'aviation' : 'metric';
  const capabilities = craftCapabilities(module);

  const assistSetting = settings.get('assists');
  const configured = Number.isFinite(assistSetting?.[craft]) ? assistSetting[craft] : 1;
  const overridden = Boolean(flight?.isAssistOverridden?.());
  const level = overridden ? 1 : configured;
  const modelKind = module?.simProfile?.model ?? 'fixedWing';

  const wind = telemetry.wind;
  const windSpeed = Math.hypot(wind.x, wind.z);
  const gear = telemetry.gear ?? {};
  const indicated = formatSpeed(telemetry.indicatedAirspeed, units);
  const ground = formatSpeed(telemetry.groundSpeed, units);
  const lastLanding = landingRecord(telemetry.lastLanding);

  return {
    craft,
    craftName: catalogEntry?.name ?? craft,
    availableCraft: registry?.list ? registry.list().filter((entry) => entry.available).map((entry) => entry.id) : [craft],
    units,
    view: typeof extras.view === 'string' ? extras.view : null,
    capabilities,
    assists: {
      level: round(level, 2),
      percent: Math.round(level * 100),
      configured: round(configured, 2),
      overridden,
      active: describeAssists(level, modelKind),
    },
    airspeed: {
      trueMs: round(telemetry.airspeed, 1),
      indicatedMs: round(telemetry.indicatedAirspeed, 1),
      groundSpeedMs: round(telemetry.groundSpeed, 1),
      mach: round(telemetry.mach, 3),
      unit: indicated.unit,
      indicated: indicated.value,
      groundSpeed: ground.value,
    },
    aoa: round(telemetry.aoa, 1),
    gLoad: round(telemetry.gLoad, 2),
    agl: Math.round(telemetry.agl),
    windAtCraft: {
      x: round(wind.x, 2),
      y: round(wind.y, 2),
      z: round(wind.z, 2),
      speed: round(windSpeed, 1),
      fromDegrees: windSpeed > 0.05 ? Math.round(wrapDegrees(headingFromVector(wind.x, wind.z) + 180)) : null,
      fromName: windSpeed > 0.05 ? compassName(wrapDegrees(headingFromVector(wind.x, wind.z) + 180)) : null,
      vertical: round(wind.y, 2),
      turbulence: round(telemetry.turbulence, 2),
    },
    gear: { retractable: Boolean(gear.retractable), down: gear.down !== false },
    flaps: { position: round(telemetry.flaps, 2), notch: Number.isFinite(telemetry.flapNotch) ? telemetry.flapNotch : 0 },
    onGround: Boolean(telemetry.onGround),
    // Floating on water (floats, the basket, a paraglider pilot in a lake): contract h.3.
    onWater: Boolean(telemetry.onWater),
    engineOn: telemetry.engineOn !== false,
    stall: { warning: Boolean(telemetry.stall?.warning), stalled: Boolean(telemetry.stall?.stalled) },
    lastLandingGrade: lastLanding ? lastLanding.grade : null,
    lastLanding,
    bestLanding: landingRecord(telemetry.bestLanding),
    landingCount: Number.isFinite(extras.landingCount) ? extras.landingCount : 0,
    // The active craft's own copilot commands (contract h.6): [{ id, phrases }] (phrases are regex
    // sources); a remote brain answers with { type: 'craftCommand', craft, command, value? }.
    craftCommands: typeof flight?.getCraftCommands === 'function' ? flight.getCraftCommands() : [],
    craftStatus: typeof flight?.getCraftStatus === 'function' ? flight.getCraftStatus() : '',
    // The active craft's own state (contract h.3: nacelle angle, envelope temperature, apogee, perched...).
    craftState: craftStateSnapshot(craft, telemetry.craftState),
    // The challenge run or the start prompt near us (contract f.2), or null.
    challenge: challengeSnapshot(state.challenge),
  };
}
