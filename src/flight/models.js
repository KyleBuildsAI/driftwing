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
import { createArcadeModel } from './ArcadeModel.js';

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
  };
}

export const flightModels = createFlightModelRegistry();

flightModels.register('arcade', createArcadeModel);
