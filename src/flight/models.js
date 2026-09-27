// Flight model registry: model kind -> factory. The FlightController creates every model through
// here, so a new model plugs in by registering its kind, with no controller changes:
//
//   flightModels.register('fixedWing', createSimFixedWingModel);
//
// A factory is called as factory({ profile, craft, world, bus, state, input }) and returns a
// FlightModel (docs/architecture.md): { kind, reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot) }. `profile` is the craft's simProfile for
// SIM models (its `model` field names the kind) and its arcadeProfile for 'arcade'.
//
// The registry is exposed as ctx.flightModels, so tests can register a kinematic model at runtime.
// While a craft's SIM kind is not registered the controller refuses SIM for that craft.
//
// Registered here: 'arcade' (CLASSIC) and 'fixedWing' (SimFixedWing: glider, bush plane), plus the
// SIM control stages every tick runs through: the PID autopilot (order 20) and the assists (order 40).
import { createArcadeModel } from './ArcadeModel.js';
import { createSimFixedWingModel } from './SimFixedWing.js';
import { createAutopilotStage } from './autopilot.js';
import { createAssistStage } from './assists.js';

export const MODEL_KINDS = Object.freeze(['arcade', 'fixedWing', 'helicopter', 'wingsuit', 'quad']);

/** Methods and fields every model must expose (checked when the controller creates one). */
const MODEL_INTERFACE = Object.freeze({
  reset: 'function',
  step: 'function',
  writeTelemetry: 'function',
  snapshot: 'function',
  restore: 'function',
  state: 'object',
  contact: 'object',
});

function createFlightModelRegistry() {
  const factories = new Map();
  const listeners = new Set();
  const stages = new Map();
  let sortedStages = [];

  function notify(kind, registered) {
    for (const listener of [...listeners]) listener({ kind, registered });
  }

  return {
    /** Registers (or replaces) the factory for a model kind. */
    register(kind, factory) {
      if (typeof kind !== 'string' || !kind) throw new TypeError('flight model kind must be a non-empty string');
      if (typeof factory !== 'function') throw new TypeError(`flight model "${kind}" needs a factory function`);
      factories.set(kind, factory);
      notify(kind, true);
      return kind;
    },

    unregister(kind) {
      const removed = factories.delete(kind);
      if (removed) notify(kind, false);
      return removed;
    },

    has(kind) {
      return factories.has(kind);
    },

    kinds() {
      return [...factories.keys()];
    },

    /**
     * Creates a model and checks it against the FlightModel interface; throws with a readable
     * message when the kind is unknown or the model is incomplete.
     */
    create(kind, options) {
      const factory = factories.get(kind);
      if (!factory) throw new Error(`no flight model registered for "${kind}"`);
      const model = factory(options);
      if (!model || typeof model !== 'object') throw new Error(`flight model "${kind}" factory returned ${model}`);
      for (const [field, type] of Object.entries(MODEL_INTERFACE)) {
        if (typeof model[field] !== type || model[field] === null) throw new Error(`flight model "${kind}" is missing ${field} (${type})`);
      }
      return model;
    },

    /** Called with { kind, registered } whenever a kind is registered or removed; returns an unsubscribe. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Registers a SIM control stage: { id, order = 50, apply(controls, context) }. Every physics tick
     * the controller copies ControlState, applies the craft input profile, zeroes the stick while a
     * disconnected device's hands-off hold is active, then runs the stages in ascending order before
     * model.step. context: { dt, model, craft, craftId, env, autopilot, assists (0..1, forced to 1 by
     * the hands-off hold), handsOff, telemetry, activeAssists (push the names of assists acting this
     * tick; they appear in state.flight.activeAssists) }. Assists and the PID autopilot plug in here.
     */
    registerControlStage(stage) {
      if (!stage || typeof stage.id !== 'string' || !stage.id) throw new TypeError('control stage needs an id');
      if (typeof stage.apply !== 'function') throw new TypeError(`control stage "${stage.id}" needs apply(controls, context)`);
      stages.set(stage.id, { id: stage.id, order: Number.isFinite(stage.order) ? stage.order : 50, apply: stage.apply });
      sortedStages = [...stages.values()].sort((first, second) => first.order - second.order);
      return stage.id;
    },

    unregisterControlStage(id) {
      const removed = stages.delete(id);
      if (removed) sortedStages = [...stages.values()].sort((first, second) => first.order - second.order);
      return removed;
    },

    /** The registered control stages in the order they run. */
    controlStages() {
      return sortedStages;
    },
  };
}

export const flightModels = createFlightModelRegistry();

flightModels.register('arcade', createArcadeModel);
flightModels.register('fixedWing', createSimFixedWingModel);
flightModels.registerControlStage(createAutopilotStage());
flightModels.registerControlStage(createAssistStage());
