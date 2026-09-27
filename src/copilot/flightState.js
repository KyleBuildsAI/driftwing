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
  const mode = typeof flight?.getMode === 'function' ? flight.getMode() : telemetry.mode;
  const craft = typeof flight?.getCraft === 'function' ? flight.getCraft() : telemetry.craft;
  const module = typeof flight?.getCraftModule === 'function' ? flight.getCraftModule() : registry?.get?.(craft) ?? null;
  const catalogEntry = registry?.catalog?.find((entry) => entry.id === craft) ?? null;
  const units = settings.get('units') === 'aviation' ? 'aviation' : 'metric';
  const capabilities = craftCapabilities(module);
  if (mode === 'classic') capabilities.throttle = true;

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
    mode,
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
      appliesInMode: mode === 'sim',
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
    engineOn: telemetry.engineOn !== false,
    stall: { warning: Boolean(telemetry.stall?.warning), stalled: Boolean(telemetry.stall?.stalled) },
    lastLandingGrade: lastLanding ? lastLanding.grade : null,
    lastLanding,
    bestLanding: landingRecord(telemetry.bestLanding),
    landingCount: Number.isFinite(extras.landingCount) ? extras.landingCount : 0,
  };
}
