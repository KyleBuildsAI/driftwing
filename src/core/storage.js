// Persistent key-value storage on IndexedDB with a versioned schema and migrations.
//
// Everything is loaded into an in-memory cache by init() at boot, so reads stay synchronous
// (read/write keep the v1 call shape used across the game). Writes update the cache at once and
// are persisted asynchronously; flush() resolves when every pending write has landed.
//
// Data lives in the "driftwing" database, object store "kv", keyed by strings:
//   driftwing.settings               settings (see core/settings.js; migrated from v1's driftwing.settings.v1)
//   driftwing.journal.<seed>         per-world discovery journal
//   driftwing.ui.firstRunHintSeen    first-run hint flag
//   input.bindings                   binding profile (global + per-craft overrides)
//   input.calibration.<deviceKey>    per-device calibration (HOTAS, gamepads)
//   input.prompts                    remembered answers to input prompts
//
// IndexedDB is scoped to the origin INCLUDING the port, which is why the dev server is pinned to
// 127.0.0.1:5199. When IndexedDB is unavailable (some private modes), storage falls back to
// localStorage, and if that is blocked too, to memory for the session.
//
// The dev verification harnesses (?test=1, ?test=hotas) pass their own database name to init(), so
// their settings, bindings and calibration never touch the player's. Such an isolated database
// skips the v1 localStorage import and falls back to memory only (never to the player's
// localStorage keys).

const DB_NAME = 'driftwing';
const STORE = 'kv';
const META_KEY = '__schema';

/**
 * Schema migrations, applied in order. Structural ones run in onupgradeneeded (the IndexedDB
 * version); data ones run after load against the cache. Add new steps at the end, never edit old ones.
 */
const STRUCTURE_MIGRATIONS = [
  // v1: one key-value store.
  (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  },
];
const DATA_MIGRATIONS = [
  // v1: import everything the single-file v1 kept in localStorage under its driftwing.* keys.
  (context) => {
    let localKeys = [];
    try {
      localKeys = Object.keys(window.localStorage).filter((key) => key.startsWith('driftwing.'));
    } catch (error) {
      return;
    }
    for (const key of localKeys) {
      if (context.cache.has(key)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (raw !== null) context.put(key, JSON.parse(raw));
      } catch (error) {
        context.report(`skipped unreadable legacy entry ${key}`);
      }
    }
  },
];
const DB_VERSION = STRUCTURE_MIGRATIONS.length;
const DATA_VERSION = DATA_MIGRATIONS.length;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createStorage() {
  const cache = new Map();
  let db = null;
  let backend = 'memory';
  let initPromise = null;
  let pending = Promise.resolve();
  let pendingCount = 0;
  let writeFailureReported = false;
  let databaseName = DB_NAME;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(databaseName, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        for (let version = event.oldVersion; version < DB_VERSION; version++) STRUCTURE_MIGRATIONS[version](database);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
    });
  }

  async function loadAll() {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const [keys, values] = await Promise.all([requestToPromise(store.getAllKeys()), requestToPromise(store.getAll())]);
    keys.forEach((key, index) => cache.set(key, values[index]));
  }

  function persist(key, value, remove = false) {
    if (backend === 'indexeddb') {
      pendingCount++;
      pending = pending
        .then(() => new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, 'readwrite');
          const store = transaction.objectStore(STORE);
          if (remove) store.delete(key);
          else store.put(value, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
        }))
        .catch((error) => {
          if (!writeFailureReported) {
            writeFailureReported = true;
            console.error('[DRIFTWING] storage write failed', error);
          }
        })
        .finally(() => { pendingCount--; });
      return true;
    }
    if (backend === 'localstorage') {
      try {
        if (remove) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  function runDataMigrations() {
    const meta = cache.get(META_KEY) || { dataVersion: 0 };
    const notes = [];
    const context = {
      cache,
      put(key, value) {
        cache.set(key, value);
        persist(key, value);
      },
      report(note) { notes.push(note); },
    };
    for (let version = meta.dataVersion; version < DATA_VERSION; version++) DATA_MIGRATIONS[version](context);
    if (meta.dataVersion !== DATA_VERSION) {
      const updated = { dataVersion: DATA_VERSION, migratedAt: new Date().toISOString(), notes };
      cache.set(META_KEY, updated);
      persist(META_KEY, updated);
    }
  }

  function loadFromLocalStorage() {
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (!key.startsWith('driftwing.') && !key.startsWith('input.')) continue;
        const raw = window.localStorage.getItem(key);
        if (raw !== null) cache.set(key, JSON.parse(raw));
      }
      backend = 'localstorage';
    } catch (error) {
      backend = 'memory';
    }
  }

  return {
    /** 'indexeddb' | 'localstorage' | 'memory' (after init). */
    get backend() { return backend; },
    get available() { return backend !== 'memory'; },
    /** Name of the IndexedDB database in use ('driftwing', or a test harness's isolated one). */
    get databaseName() { return databaseName; },

    /**
     * Opens the database, runs migrations and fills the cache. Safe to call more than once (the
     * first call's options win). options.databaseName opens an isolated database instead of the
     * player's (dev test harnesses).
     */
    init(options = {}) {
      if (!initPromise) {
        if (typeof options.databaseName === 'string' && options.databaseName) databaseName = options.databaseName;
        const isolated = databaseName !== DB_NAME;
        initPromise = (async () => {
          try {
            db = await openDatabase();
            backend = 'indexeddb';
            await loadAll();
            if (!isolated) runDataMigrations();
          } catch (error) {
            db = null;
            if (isolated) backend = 'memory';
            else loadFromLocalStorage();
          }
          return backend;
        })();
      }
      return initPromise;
    },

    /** Synchronous read from the cache; returns fallback when the key is missing. */
    read(key, fallback) {
      return cache.has(key) ? cache.get(key) : fallback;
    },

    /** Updates the cache and persists in the background. Returns false only when nothing can persist. */
    write(key, value) {
      cache.set(key, value);
      return persist(key, value);
    },

    remove(key) {
      cache.delete(key);
      return persist(key, undefined, true);
    },

    /** Keys currently stored that start with prefix. */
    keys(prefix = '') {
      return [...cache.keys()].filter((key) => key !== META_KEY && key.startsWith(prefix));
    },

    /** Resolves once every queued write has been committed. */
    flush() {
      return pending;
    },

    get pendingWrites() { return pendingCount; },
  };
}

export const storage = createStorage();
