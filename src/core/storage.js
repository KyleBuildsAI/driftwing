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
//   audio.vario                      variometer audio mode (AudioEngine)
//
// IndexedDB is scoped to the origin INCLUDING the port, which is why the dev server is pinned to
// 127.0.0.1:5199. When IndexedDB is unavailable (some private modes), storage falls back to
// localStorage, and if that is blocked too, to memory for the session.

const DB_NAME = 'driftwing';
const STORE = 'kv';
const META_KEY = '__schema';
/** Every game key starts with one of these; the localStorage fallback reloads only these keys. */
const OWNED_KEY_PREFIXES = Object.freeze(['driftwing.', 'input.', 'audio.']);
/** Boot waits at most this long for IndexedDB to open before it takes the localStorage fallback. */
const OPEN_TIMEOUT_MS = 4000;

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
      // Blocked localStorage (a privacy setting): there is nothing v1 could have left to import.
      context.report(`localStorage is blocked, so no v1 data was imported (${error && error.message ? error.message : error})`);
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

/**
 * Creates a storage instance (the game uses the shared `storage` below; labs make their own).
 * openTimeoutMs: how long init() waits for IndexedDB to open before taking the fallback.
 */
export function createStorage({ openTimeoutMs = OPEN_TIMEOUT_MS } = {}) {
  const cache = new Map();
  let db = null;
  let backend = 'memory';
  let initPromise = null;
  let pending = Promise.resolve();
  let pendingCount = 0;
  let writeFailureReported = false;
  const failureListeners = new Set();

  /**
   * Opens the database. Rejects when IndexedDB is missing, fails, is blocked, or has not opened
   * within openTimeoutMs (some engines never answer an open): boot then takes the localStorage
   * fallback instead of waiting forever. A connection that arrives after the timeout is closed.
   */
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`IndexedDB did not open within ${openTimeoutMs} ms`));
      }, openTimeoutMs);
      function settle(finish) {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        finish();
        return true;
      }
      request.onupgradeneeded = (event) => {
        const database = request.result;
        for (let version = event.oldVersion; version < DB_VERSION; version++) STRUCTURE_MIGRATIONS[version](database);
      };
      request.onsuccess = () => {
        const database = request.result;
        if (!settle(() => resolve(database))) database.close();
      };
      request.onerror = () => settle(() => reject(request.error));
      request.onblocked = () => settle(() => reject(new Error('IndexedDB upgrade blocked by another open tab')));
    });
  }

  async function loadAll() {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const [keys, values] = await Promise.all([requestToPromise(store.getAllKeys()), requestToPromise(store.getAll())]);
    keys.forEach((key, index) => cache.set(key, values[index]));
  }

  /**
   * Makes database the live connection. The browser can take it away: another tab opening a newer
   * version asks us to close (versionchange), and clearing site data, eviction or a backgrounded
   * tab can close it outright. Either way db goes null and the next write reopens it.
   */
  function attachConnection(database) {
    database.onversionchange = () => {
      database.close();
      if (db === database) db = null;
    };
    database.onclose = () => {
      if (db === database) db = null;
    };
    db = database;
  }

  function writeTransaction(database, key, value, remove) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      if (remove) store.delete(key);
      else store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  /** True when a write failed because the connection went away, not because the write was refused. */
  function lostConnection(error, database) {
    return database !== db || (error && (error.name === 'InvalidStateError' || error.name === 'AbortError'));
  }

  /** Writes one key, reopening the database once when the browser closed the connection. */
  async function writeToDatabase(key, value, remove) {
    if (!db) attachConnection(await openDatabase());
    const database = db;
    try {
      await writeTransaction(database, key, value, remove);
    } catch (error) {
      if (!lostConnection(error, database)) throw error;
      if (db === database) db = null;
      database.close();
      attachConnection(await openDatabase());
      await writeTransaction(db, key, value, remove);
    }
  }

  /**
   * A write that did not land. When the database cannot be reopened (a newer version is open in
   * another tab, or storage was disabled) the backend drops to memory, so later writes return false
   * instead of claiming to persist. Listeners hear about the first failure once.
   */
  function handleWriteFailure(error) {
    if (!db) backend = 'memory';
    if (writeFailureReported) return;
    writeFailureReported = true;
    console.error('[DRIFTWING] storage write failed', error);
    for (const listener of failureListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.error('[DRIFTWING] storage failure listener threw', listenerError);
      }
    }
  }

  function persist(key, value, remove = false) {
    if (backend === 'indexeddb') {
      pendingCount++;
      pending = pending
        .then(() => writeToDatabase(key, value, remove))
        .catch(handleWriteFailure)
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
        if (!OWNED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
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

    /** Opens the database, runs migrations and fills the cache. Safe to call more than once. */
    init() {
      if (!initPromise) {
        initPromise = (async () => {
          try {
            attachConnection(await openDatabase());
            backend = 'indexeddb';
            await loadAll();
            runDataMigrations();
          } catch (error) {
            db = null;
            loadFromLocalStorage();
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

    /**
     * listener(error) runs once, on the first background write that did not land (write() had
     * already returned true for it). Returns an unsubscribe function.
     */
    onWriteFailure(listener) {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
  };
}

export const storage = createStorage();
