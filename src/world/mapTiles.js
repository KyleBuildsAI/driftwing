// Map-tile service: the main thread's side of the map-tile worker (mapTiles.worker.js). Generic on
// purpose, so the world map uses it now and Phase 3's far-field planet tiles can reuse it:
//
//   const tiles = createMapTileService({ seed, worldOptions });
//   tiles.request({ x, z, size, resolution, fields: ['height', 'color', 'biome'], cache }, { priority })
//     -> Promise<{ height?, color?, biome?, fromCache, buildMs } | null>
//
// (x, z) is the tile's north-west corner, size its side in metres, resolution its samples per side;
// the arrays are described in mapTileGen.js. Lower priority numbers go first. The worker starts on the
// first request and generates one tile at a time, so the main thread never builds a tile. A pending
// request can be re-prioritised or dropped with reprioritize(fn); a dropped request resolves null.
// dispose() stops the worker and resolves everything still pending with null.
import MapTileWorker from './mapTiles.worker.js?worker&inline';
import { normalizeTileRequest } from './mapTileGen.js';

/** Tiles sent to the worker at once: one in work and one queued behind it, so it never idles. */
const MAX_IN_FLIGHT = 2;

/**
 * Creates the service. seed and worldOptions are the world's (the same options the terrain worker
 * gets). Returns { request, reprioritize, pendingCount, stats, dispose }.
 */
export function createMapTileService({ seed, worldOptions }) {
  let worker = null;
  let failed = null;
  let nextId = 1;
  let disposed = false;
  const pending = [];
  const inFlight = new Map();
  const counters = { requested: 0, generated: 0, fromCache: 0, dropped: 0, buildMs: 0, cache: 'starting', cacheError: null };

  function fail(detail) {
    if (failed) return;
    failed = detail;
    console.error('[DRIFTWING] the map-tile worker failed; the map shows no terrain', detail);
    for (const entry of inFlight.values()) entry.resolve(null);
    inFlight.clear();
    for (const entry of pending.splice(0)) entry.resolve(null);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' || message.type === 'cache') {
      counters.cache = message.cache;
      counters.cacheError = message.cacheError ?? null;
      return;
    }
    if (message.type === 'error') {
      fail(`${message.message}\n${message.stack}`);
      return;
    }
    if (message.type !== 'tile') return;
    const entry = inFlight.get(message.id);
    if (!entry) return;
    inFlight.delete(message.id);
    counters.buildMs += message.buildMs;
    if (message.fromCache) counters.fromCache++;
    else counters.generated++;
    const tile = { fromCache: message.fromCache, buildMs: message.buildMs };
    for (const field of entry.spec.fields) tile[field] = message[field];
    entry.resolve(tile);
    pump();
  }

  function startWorker() {
    if (typeof Worker !== 'function') {
      fail('this browser has no Worker support');
      return false;
    }
    try {
      worker = new MapTileWorker({ name: 'driftwing-map-tiles' });
    } catch (error) {
      fail(error);
      return false;
    }
    worker.onmessage = (event) => handleMessage(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'map-tile worker error event');
    };
    worker.onmessageerror = () => fail('a map-tile worker message could not be deserialised');
    worker.postMessage({ type: 'init', seed, options: worldOptions });
    return true;
  }

  /** Sends the most urgent pending requests while the worker has room. */
  function pump() {
    if (failed || disposed) return;
    while (inFlight.size < MAX_IN_FLIGHT && pending.length > 0) {
      let best = 0;
      for (let index = 1; index < pending.length; index++) if (pending[index].priority < pending[best].priority) best = index;
      const [entry] = pending.splice(best, 1);
      inFlight.set(entry.id, entry);
      worker.postMessage({ type: 'tile', id: entry.id, ...entry.spec });
    }
  }

  return {
    /** Queues a tile (see the file header). Resolves null when dropped, disposed or the worker failed. */
    request(spec, { priority = 0 } = {}) {
      if (disposed || failed) return Promise.resolve(null);
      const clean = { ...normalizeTileRequest(spec), cache: spec.cache !== false };
      if (!worker && !startWorker()) return Promise.resolve(null);
      counters.requested++;
      return new Promise((resolve) => {
        pending.push({ id: nextId++, spec: clean, priority, resolve });
        pump();
      });
    },

    /**
     * Re-prioritises the pending requests: fn(spec) returns the new priority, or null to drop the
     * request (it resolves null). Requests already in the worker finish as they are.
     */
    reprioritize(fn) {
      for (let index = pending.length - 1; index >= 0; index--) {
        const next = fn(pending[index].spec);
        if (next === null) {
          const [dropped] = pending.splice(index, 1);
          counters.dropped++;
          dropped.resolve(null);
        } else {
          pending[index].priority = next;
        }
      }
    },

    pendingCount() {
      return pending.length + inFlight.size;
    },

    /** { requested, generated, fromCache, dropped, buildMs, cache, cacheError, pending, failed }. */
    stats() {
      return { ...counters, buildMs: Math.round(counters.buildMs), pending: pending.length + inFlight.size, failed: failed !== null, running: worker !== null };
    },

    dispose() {
      disposed = true;
      for (const entry of inFlight.values()) entry.resolve(null);
      inFlight.clear();
      for (const entry of pending.splice(0)) entry.resolve(null);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
      }
    },
  };
}
