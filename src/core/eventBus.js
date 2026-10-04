
export class EventBus {
  constructor() { this.listeners = new Map(); }
  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.off(type, listener);
  }
  off(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, payload) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[DRIFTWING] listener for "${type}" failed`, error);
      }
    }
  }
}
