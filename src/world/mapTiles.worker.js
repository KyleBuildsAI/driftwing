// Map-tile worker: generates map tiles (mapTileGen.js) off the main thread from the same worldgen
// module the terrain worker imports, and keeps finished tiles in IndexedDB (driftwing-v2-maptiles) so
// a later visit to the same world opens its map at once. Loaded with Vite's ?worker&inline import, so it
// also works inside the single-file build.
//
// Messages in:
//   { type: 'init', seed, options }                  the world (the same options as the terrain worker)
//   { type: 'tile', id, x, z, size, resolution, fields, stamps, cache }   (stamps false: the bare world)
// Messages out:
//   { type: 'ready', cache: 'indexeddb' | 'off', cacheError? }
//   { type: 'cache', cache: 'off', cacheError }       the cache failed later; tiles go on without it
//   { type: 'tile', id, height?, color?, biome?, surface?, albedo?, fromCache, buildMs }   (buffers transferred)
//   { type: 'error', id?, message, stack }
import { createWorldGen } from './worldgen.js';
import { createMapTileGenerator, mapTileCacheTag, normalizeTileRequest } from './mapTileGen.js';
import { PRESETS } from '../spawns/presets/index.js';

const DATABASE_NAME = 'driftwing-v2-maptiles';
const STORE = 'tiles';
/** Cached tiles kept across worlds; beyond this the least recently written go. */
const MAX_CACHED_TILES = 1200;
/** Writes between two prunes of the cache. */
const PRUNE_EVERY = 64;
const FIELD_TYPES = Object.freeze({ height: Float32Array, color: Uint8ClampedArray, biome: Uint8Array, surface: Float32Array, albedo: Uint8ClampedArray });
/** Fields with four bytes (RGBA) per sample. */
const RGBA_FIELDS = Object.freeze(['color', 'albedo']);

let generator = null;
/** The same world without site stamps, for coarse tiles (mapTileGen.js, the stamps request flag). */
let bareGenerator = null;
let cacheTag = '';
let database = null;
let writesSincePrune = 0;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Opens the tile cache; resolves the database, or rejects when this browser keeps none. */
function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available in this worker'));
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
    store.createIndex('at', 'at');
  };
  return requestToPromise(request);
}

function tileKey(request) {
  return `${cacheTag}|${request.x}|${request.z}|${request.size}|${request.resolution}|${request.fields.join('+')}${request.stamps ? '' : '|bare'}`;
}

async function readCached(key) {
  if (!database) return null;
  const transaction = database.transaction(STORE, 'readonly');
  return requestToPromise(transaction.objectStore(STORE).get(key));
}

/** Drops the oldest tiles once the cache holds more than MAX_CACHED_TILES. */
async function prune() {
  const transaction = database.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const count = await requestToPromise(store.count());
  let excess = count - MAX_CACHED_TILES;
  if (excess <= 0) return;
  await new Promise((resolve, reject) => {
    const cursorRequest = store.index('at').openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || excess <= 0) {
        resolve();
        return;
      }
      cursor.delete();
      excess--;
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

async function writeCached(key, tile) {
  if (!database) return;
  const record = { key, at: Date.now() };
  for (const field of Object.keys(tile)) record[field] = tile[field].slice();
  const transaction = database.transaction(STORE, 'readwrite');
  await requestToPromise(transaction.objectStore(STORE).put(record));
  writesSincePrune++;
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    await prune();
  }
}

/** A cached record back into typed arrays, or null when it does not hold every requested field. */
function fromRecord(record, request) {
  if (!record) return null;
  const tile = {};
  const count = request.resolution * request.resolution;
  for (const field of request.fields) {
    const value = record[field];
    const Type = FIELD_TYPES[field];
    if (!(value instanceof Type) || value.length !== (RGBA_FIELDS.includes(field) ? count * 4 : count)) return null;
    tile[field] = value;
  }
  return tile;
}

/** The cache failed (quota, a closed database): tiles are generated without it from now on. */
function disableCache(error) {
  database = null;
  self.postMessage({ type: 'cache', cache: 'off', cacheError: String(error && error.message ? error.message : error) });
}

function postError(id, error) {
  self.postMessage({ type: 'error', id, message: String(error && error.message ? error.message : error), stack: String(error && error.stack ? error.stack : '') });
}

async function initialise(message) {
  generator = createMapTileGenerator(createWorldGen(message.seed, message.options));
  bareGenerator = createMapTileGenerator(createWorldGen(message.seed, { ...message.options, presets: [] }));
  cacheTag = mapTileCacheTag(message.seed, Array.isArray(message.options.presets) ? message.options.presets : PRESETS);
  try {
    database = await openDatabase();
    self.postMessage({ type: 'ready', cache: 'indexeddb' });
  } catch (error) {
    // A private window or blocked storage: the map still works, it just generates every tile anew.
    database = null;
    self.postMessage({ type: 'ready', cache: 'off', cacheError: String(error && error.message ? error.message : error) });
  }
}

async function makeTile(message) {
  const started = performance.now();
  const request = normalizeTileRequest(message);
  const useCache = message.cache === true && database !== null;
  const key = useCache ? tileKey(request) : '';
  let tile = null;
  let fromCache = false;
  if (useCache) {
    try {
      tile = fromRecord(await readCached(key), request);
      fromCache = tile !== null;
    } catch (error) {
      disableCache(error);
    }
  }
  if (!tile) {
    tile = (request.stamps ? generator : bareGenerator).generate(request);
    if (useCache && database) {
      try {
        await writeCached(key, tile);
      } catch (error) {
        disableCache(error);
      }
    }
  }
  const reply = { type: 'tile', id: message.id, fromCache, buildMs: performance.now() - started };
  const transfer = [];
  for (const field of request.fields) {
    reply[field] = tile[field];
    transfer.push(tile[field].buffer);
  }
  self.postMessage(reply, transfer);
}

// Messages are handled strictly one after another, so a tile never overtakes the init.
let chain = Promise.resolve();
self.onmessage = (event) => {
  const message = event.data;
  chain = chain.then(async () => {
    try {
      if (message.type === 'init') await initialise(message);
      else if (message.type === 'tile') await makeTile(message);
      else throw new Error(`unknown message "${message.type}"`);
    } catch (error) {
      postError(message && message.id, error);
    }
  });
};
