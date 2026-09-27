// Action routing: turns presses and releases from every input source into ControlState action
// sets and 'input:action' bus events.
//
// Several inputs can hold the same action at once (a key and a stick button, say). Each input is a
// "holder" with a stable key ('key:KeyG', '044f-b10a|gearToggle|0', 'touch:boost', ...). The action
// is pressed when its first holder presses and released when its last holder lets go, so
// 'input:action' always alternates press / release per action id and hold-type actions (airbrake,
// copilotPTT) stay held for exactly as long as any input holds them.
//
// ControlState.actions collects every press until the flight controller consumes (clears) it;
// ControlState.held mirrors the currently held actions.

import { ACTIONS } from './controlState.js';

/**
 * Creates the router. bus: EventBus; controls: the ControlState it writes; onPress(id, source)
 * runs after each press is emitted (the input manager uses it for the CLASSIC boost latch).
 */
export function createActionRouter({ bus, controls, onPress = null }) {
  /** actionId -> Map(holderKey -> { source, device }) */
  const holders = new Map();

  function holdersOf(actionId) {
    let entry = holders.get(actionId);
    if (!entry) {
      entry = new Map();
      holders.set(actionId, entry);
    }
    return entry;
  }

  /**
   * Registers a press from one holder. Returns true when this press started the action (the event
   * fired), false when the holder was already pressing it or another holder already holds it.
   */
  function press(actionId, holderKey, source, device) {
    if (!(actionId in ACTIONS)) throw new Error(`unknown input action "${actionId}"`);
    const entry = holdersOf(actionId);
    if (entry.has(holderKey)) return false;
    entry.set(holderKey, { source, device });
    if (entry.size > 1) return false;
    controls.actions.add(actionId);
    controls.held.add(actionId);
    bus.emit('input:action', { id: actionId, phase: 'press', source, device });
    if (onPress) onPress(actionId, source, device);
    return true;
  }

  /** Releases one holder; the action is released (and the event fires) when no holder remains. */
  function release(actionId, holderKey) {
    const entry = holders.get(actionId);
    const holder = entry?.get(holderKey);
    if (!holder) return false;
    entry.delete(holderKey);
    if (entry.size > 0) return false;
    controls.held.delete(actionId);
    bus.emit('input:action', { id: actionId, phase: 'release', source: holder.source, device: holder.device });
    return true;
  }

  /** Releases every action held by holders whose key passes the filter (a device unplugged, a blur). */
  function releaseWhere(filter) {
    for (const [actionId, entry] of holders) {
      for (const holderKey of [...entry.keys()]) {
        if (filter(holderKey)) release(actionId, holderKey);
      }
    }
  }

  return {
    press,
    release,
    releaseWhere,

    /** Releases everything held by holders whose key starts with prefix. */
    releasePrefix(prefix) {
      releaseWhere((holderKey) => holderKey.startsWith(prefix));
    },

    releaseAll() {
      releaseWhere(() => true);
    },

    /** True while holderKey is pressing actionId. */
    isHolding(actionId, holderKey) {
      return Boolean(holders.get(actionId)?.has(holderKey));
    },

    /** Holder keys currently pressing anything (for per-frame release bookkeeping). */
    heldBy(prefix) {
      const result = [];
      for (const [actionId, entry] of holders) {
        for (const holderKey of entry.keys()) if (holderKey.startsWith(prefix)) result.push([actionId, holderKey]);
      }
      return result;
    },
  };
}
