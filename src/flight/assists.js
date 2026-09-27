// SIM assists: the helpers between the pilot's ControlState and the flight model. They run as one
// control stage (flightModels.registerControlStage) every physics tick, after the autopilot stage, so
// the limiters protect autopilot commands too. The level is 0..1 per craft (settings.assists[craftId],
// forced to 1 by the controller's hands-off hold):
//   100 %  auto-coordination, AoA / stall limiter, auto-level when hands off, G limiter, auto-trim
//          (helicopter: auto-hover and heading hold; drone: angle mode with altitude hold)
//    50 %  auto-coordination, auto-trim, stall warning only
//     0 %  raw physics
// In between, every assist has a weight that ramps with the level: coordination, auto-trim and the
// stall warning come in over 0-50 %, the limiters and auto-level over 50-100 %.
//
// Each model kind has a catalog (what describeAssists lists for the UI tooltip and what fills
// state.flight.activeAssists) and a handler that applies the assists to its controls. The fixed-wing
// handler lives here; later models register theirs:
//   registerAssistCatalog('helicopter', [...entries]);   // optional: replaces the default entries
//   registerAssistHandler('helicopter', { createMemory(), apply(controls, context, weights, memory) });
import { DEG, clamp } from '../core/util.js';

export const ASSIST_STAGE_ORDER = 40;

/**
 * Catalog entries: { key, name, from, full }: the weight ramps from 0 at level `from` to 1 at level
 * `full` (from === full means "on above that level").
 */
const DEFAULT_CATALOGS = {
  fixedWing: [
    { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
    { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
    { key: 'stallWarning', name: 'stall warning', from: 0, full: 0 },
    { key: 'aoaLimiter', name: 'AoA limiter', from: 0.5, full: 1 },
    { key: 'gLimiter', name: 'G limiter', from: 0.5, full: 1 },
    { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
  ],
  helicopter: [
    { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
    { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
    { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
    { key: 'autoHover', name: 'auto-hover', from: 0.5, full: 1 },
    { key: 'headingHold', name: 'heading hold', from: 0.5, full: 1 },
  ],
  quad: [
    { key: 'angleMode', name: 'angle mode', from: 0.5, full: 1 },
    { key: 'altitudeHold', name: 'altitude hold', from: 0.5, full: 1 },
  ],
};

const catalogs = new Map(Object.entries(DEFAULT_CATALOGS).map(([kind, entries]) => [kind, Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))]));
const handlers = new Map();

function entryWeight(entry, level) {
  if (entry.full <= entry.from) return level > entry.from ? 1 : 0;
  return clamp((level - entry.from) / (entry.full - entry.from), 0, 1);
}

/** Replaces the assist catalog of a model kind (entries as above). */
export function registerAssistCatalog(kind, entries) {
  if (!Array.isArray(entries)) throw new TypeError(`assist catalog for "${kind}" must be an array`);
  catalogs.set(kind, Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))));
}

/** Registers the handler that applies a model kind's assists: { createMemory(), apply(controls, context, weights, memory) }. */
export function registerAssistHandler(kind, handler) {
  if (!handler || typeof handler.apply !== 'function') throw new TypeError(`assist handler for "${kind}" needs apply()`);
  handlers.set(kind, handler);
}

export function hasAssistHandler(kind) {
  return handlers.has(kind);
}

/** { key: weight 0..1 } of every assist of a model kind at a level (0..1). */
export function assistWeights(level, modelKind, target = {}) {
  const catalog = catalogs.get(modelKind) ?? [];
  const clamped = clamp(Number.isFinite(level) ? level : 1, 0, 1);
  for (const entry of catalog) target[entry.key] = entryWeight(entry, clamped);
  return target;
}

/** Names of the assists active at a level (0..1) for a model kind, for the UI tooltip. */
export function describeAssists(level, modelKind) {
  const catalog = catalogs.get(modelKind) ?? [];
  const clamped = clamp(Number.isFinite(level) ? level : 1, 0, 1);
  return catalog.filter((entry) => entryWeight(entry, clamped) > 0).map((entry) => entry.name);
}

/** The stall warning (horn and HUD cue): any assist level above 0, within the margin, airborne. */
export const STALL_WARNING_MARGIN = 3.5 * DEG;
export function stallWarningActive(level, stallMargin, stalled, suppressed) {
  if (suppressed || !(level > 0)) return false;
  return stalled || stallMargin < STALL_WARNING_MARGIN;
}

// ============================================================================================
// FIXED-WING ASSISTS
// ============================================================================================
const FIXED_WING = Object.freeze({
  /** Stick inside this is "hands off" for that axis. */
  IDLE: 0.05,
  /** Below this airspeed (m/s) or on the ground the air assists stand down (the rudder steers). */
  MIN_AIRSPEED: 9,
  COORDINATION: Object.freeze({ SIDESLIP_GAIN: 4.5, SIDESLIP_RATE_GAIN: 0.9, AILERON_FEED: 0.1, LIMIT: 0.7 }),
  AUTO_LEVEL: Object.freeze({ DELAY: 0.5, BANK_GAIN: 1.4, RATE_GAIN: 0.45, LIMIT: 0.5 }),
  AUTO_TRIM: Object.freeze({
    IDLE_DELAY: 0.25,
    /** While the stick is held, the trim creeps toward it over this many seconds (relieving the pilot). */
    FOLLOW_SECONDS: 3,
    /** Hands off, a PI loop holds the angle of attack captured at release (elevator per rad, per rad s). */
    HOLD_P: 1.6,
    HOLD_I: 2.4,
    /** The hold never trims closer to the critical angle of attack than this, nor below LOW_SPAN under it. */
    STALL_MARGIN: 4 * DEG,
    LOW_SPAN: 15 * DEG,
    MAX_OFFSET: 0.8,
    GROUND_DECAY_SECONDS: 6,
  }),
  LIMITER: Object.freeze({
    AOA_MARGIN: 2 * DEG,
    /** The limiter acts inside this band below the limit, predicting the angle of attack LEAD seconds ahead. */
    AOA_BAND: 5 * DEG,
    AOA_LEAD: 0.35,
    AOA_GAIN: 7,
    /** Past the limit the elevator comes back faster (stick per second per rad, per g of overshoot). */
    AOA_OVERSHOOT_GAIN: 60,
    G_OVERSHOOT_GAIN: 4,
    NEGATIVE_AOA: -8 * DEG,
    G_SHARE: 0.9,
    NEGATIVE_G_SHARE: 0.4,
    G_BAND: 0.9,
    G_GAIN: 0.9,
    RATE_SMOOTHING: 18,
  }),
});

function createFixedWingMemory() {
  return {
    resetCount: -1,
    pitchIdleSeconds: 0,
    rollIdleSeconds: 0,
    trimBase: 0,
    holding: false,
    holdAoa: 0,
    lastSideslip: NaN,
    lastAoa: NaN,
    aoaRate: 0,
    lastPitch: 0,
  };
}

/** Auto-trim: the trim follows a held stick, and hands off it holds the angle of attack at release. */
function applyAutoTrim(controls, data, weight, memory, dt) {
  const tuning = FIXED_WING.AUTO_TRIM;
  const idle = Math.abs(controls.pitch) < FIXED_WING.IDLE;
  memory.pitchIdleSeconds = idle ? memory.pitchIdleSeconds + dt : 0;
  const highest = data.aoaCritical - tuning.STALL_MARGIN;
  let offset = memory.trimBase;
  if (!idle) {
    memory.holding = false;
    const nearStall = data.aoa > highest && controls.pitch > 0;
    if (!nearStall) memory.trimBase += (weight * controls.pitch * dt) / tuning.FOLLOW_SECONDS;
    offset = memory.trimBase;
  } else if (memory.pitchIdleSeconds >= tuning.IDLE_DELAY) {
    if (!memory.holding) {
      memory.holding = true;
      memory.holdAoa = clamp(data.aoa, data.aoaCritical - tuning.LOW_SPAN, highest);
    }
    const error = memory.holdAoa - data.aoa;
    memory.trimBase += weight * tuning.HOLD_I * error * dt;
    offset = memory.trimBase + weight * tuning.HOLD_P * error;
  }
  memory.trimBase = clamp(memory.trimBase, -tuning.MAX_OFFSET, tuning.MAX_OFFSET);
  controls.pitch = clamp(controls.pitch + clamp(offset, -tuning.MAX_OFFSET, tuning.MAX_OFFSET), -1, 1);
}

/** Auto-level: hands off the roll axis, the wings come back level. */
function applyAutoLevel(controls, data, weight, memory, dt) {
  const tuning = FIXED_WING.AUTO_LEVEL;
  const idle = Math.abs(controls.roll) < FIXED_WING.IDLE;
  memory.rollIdleSeconds = idle ? memory.rollIdleSeconds + dt : 0;
  if (!idle || memory.rollIdleSeconds < tuning.DELAY) return;
  const command = clamp(-tuning.BANK_GAIN * data.bank - tuning.RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT);
  controls.roll = clamp(controls.roll + weight * command, -1, 1);
}

/** Auto-coordination: rudder to null the sideslip, with aileron feed-forward against adverse yaw. */
function applyCoordination(controls, data, weight, memory, dt) {
  const tuning = FIXED_WING.COORDINATION;
  const sideslipRate = Number.isFinite(memory.lastSideslip) ? (data.sideslip - memory.lastSideslip) / dt : 0;
  memory.lastSideslip = data.sideslip;
  const command = clamp(tuning.SIDESLIP_GAIN * data.sideslip + tuning.SIDESLIP_RATE_GAIN * clamp(sideslipRate, -2, 2) + tuning.AILERON_FEED * controls.roll, -tuning.LIMIT, tuning.LIMIT);
  // The pilot's own rudder takes over as it is pushed.
  const share = weight * (1 - Math.min(1, Math.abs(controls.yaw)));
  controls.yaw = clamp(controls.yaw + share * command, -1, 1);
}

/**
 * AoA and G limiters: an elevator ceiling (and floor) that, inside a band near the limit, may only
 * move toward more pull as fast as the remaining margin allows and pushes back past it.
 */
function applyLimiters(controls, data, weights, memory, dt, gLimit) {
  const tuning = FIXED_WING.LIMITER;
  const rawRate = Number.isFinite(memory.lastAoa) ? (data.aoa - memory.lastAoa) / dt : 0;
  memory.lastAoa = data.aoa;
  memory.aoaRate += (clamp(rawRate, -3, 3) - memory.aoaRate) * (1 - Math.exp(-tuning.RATE_SMOOTHING * dt));
  const predicted = data.aoa + tuning.AOA_LEAD * memory.aoaRate;
  const desired = controls.pitch;
  let ceiling = 1;
  let floor = -1;
  if (weights.aoaLimiter > 0) {
    // The worst wing panel counts too: in a skid or a roll one wing reaches its stall first.
    const aoaLimit = data.aoaCritical - tuning.AOA_MARGIN;
    const panelMargin = Number.isFinite(data.panelMargin) ? data.panelMargin - tuning.AOA_MARGIN - tuning.AOA_LEAD * memory.aoaRate : Infinity;
    const margin = Math.min(aoaLimit - predicted, panelMargin);
    if (margin < tuning.AOA_BAND) ceiling = Math.min(ceiling, memory.lastPitch + (tuning.AOA_GAIN * margin + tuning.AOA_OVERSHOOT_GAIN * Math.min(margin, 0)) * dt);
    const negativeMargin = predicted - tuning.NEGATIVE_AOA;
    if (negativeMargin < tuning.AOA_BAND) floor = Math.max(floor, memory.lastPitch - (tuning.AOA_GAIN * negativeMargin + tuning.AOA_OVERSHOOT_GAIN * Math.min(negativeMargin, 0)) * dt);
  }
  if (weights.gLimiter > 0) {
    const positiveMargin = tuning.G_SHARE * gLimit - data.gLoad;
    if (positiveMargin < tuning.G_BAND) ceiling = Math.min(ceiling, memory.lastPitch + (tuning.G_GAIN * positiveMargin + tuning.G_OVERSHOOT_GAIN * Math.min(positiveMargin, 0)) * dt);
    const negativeMargin = data.gLoad + tuning.NEGATIVE_G_SHARE * gLimit;
    if (negativeMargin < tuning.G_BAND) floor = Math.max(floor, memory.lastPitch - (tuning.G_GAIN * negativeMargin + tuning.G_OVERSHOOT_GAIN * Math.min(negativeMargin, 0)) * dt);
  }
  const limited = clamp(desired, Math.min(floor, ceiling), ceiling);
  const weight = Math.max(weights.aoaLimiter, weights.gLimiter);
  controls.pitch = clamp(desired + weight * (limited - desired), -1, 1);
}

const fixedWingHandler = Object.freeze({
  createMemory: createFixedWingMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (data.onGround || data.airspeed < FIXED_WING.MIN_AIRSPEED) {
      // On the ground the trim creeps back to neutral and the rudder is the pilot's (it steers).
      memory.trimBase -= memory.trimBase * Math.min(1, dt / FIXED_WING.AUTO_TRIM.GROUND_DECAY_SECONDS);
      memory.holding = false;
      memory.lastSideslip = NaN;
      memory.lastAoa = NaN;
      if (weights.autoTrim > 0 && !autopilotFlying) controls.pitch = clamp(controls.pitch + memory.trimBase, -1, 1);
      memory.lastPitch = controls.pitch;
      return;
    }
    if (!autopilotFlying) {
      if (weights.autoTrim > 0) applyAutoTrim(controls, data, weights.autoTrim, memory, dt);
      if (weights.autoLevel > 0) applyAutoLevel(controls, data, weights.autoLevel, memory, dt);
      if (weights.coordination > 0) applyCoordination(controls, data, weights.coordination, memory, dt);
    } else {
      // The autopilot flies pitch itself; keep the trim where it is so hand-back is smooth.
      memory.pitchIdleSeconds = 0;
      memory.holding = false;
      memory.trimBase = clamp(controls.pitch, -FIXED_WING.AUTO_TRIM.MAX_OFFSET, FIXED_WING.AUTO_TRIM.MAX_OFFSET);
    }
    if (weights.aoaLimiter > 0 || weights.gLimiter > 0) applyLimiters(controls, data, weights, memory, dt, data.gLimit);
    else {
      memory.lastAoa = data.aoa;
      memory.aoaRate = 0;
    }
    memory.lastPitch = controls.pitch;
  },
});

registerAssistHandler('fixedWing', fixedWingHandler);

/**
 * The assists control stage. Per model it keeps the handler's memory (re-created when the model is
 * reset), lists the active assists into context.activeAssists and applies the handler.
 */
export function createAssistStage() {
  const memories = new WeakMap();
  const weights = {};
  return {
    id: 'assists',
    order: ASSIST_STAGE_ORDER,
    apply(controls, context) {
      const model = context.model;
      if (!model) return;
      const level = clamp(Number.isFinite(context.assists) ? context.assists : 1, 0, 1);
      const catalog = catalogs.get(model.kind) ?? [];
      for (const entry of catalog) {
        const weight = entryWeight(entry, level);
        weights[entry.key] = weight;
        if (weight > 0) context.activeAssists.push(entry.name);
      }
      const handler = handlers.get(model.kind);
      if (!handler || !(context.dt > 0)) return;
      let memory = memories.get(model);
      const resetCount = Number.isFinite(model.resetCount) ? model.resetCount : 0;
      if (!memory || memory.resetCount !== resetCount) {
        memory = handler.createMemory();
        memory.resetCount = resetCount;
        memories.set(model, memory);
      }
      handler.apply(controls, context, weights, memory);
    },
  };
}
