// Persistent key-value storage on IndexedDB with a versioned schema and migrations.
//
// Everything is loaded into an in-memory cache by init() at boot, so reads stay synchronous
// (read/write keep the v1 call shape used across the game). Writes update the cache at once and
// are persisted asynchronously; flush() resolves when every pending write has landed.
//
// V2 shares its origin with V1 (both run behind the launcher shell), so every piece of V2 storage is
// prefixed 'driftwing-v2': the IndexedDB database is "driftwing-v2" and every key starts with
// 'driftwing-v2.' (read, write and remove throw on any other key). V2 never reads or writes V1's
// localStorage keys (driftwing.settings.v1, driftwing.journal.*, driftwing.ui.*).
//
// Data lives in the "driftwing-v2" database, object store "kv", keyed by strings:
//   driftwing-v2.settings                        settings (see core/settings.js)
//   driftwing-v2.journal.<seed>                  per-world discovery journal
//   driftwing-v2.ui.firstRunHintSeen             first-run hint flag
//   driftwing-v2.input.bindings                  binding profile (global + per-craft overrides)
//   driftwing-v2.input.calibration.<deviceKey>   per-device calibration (HOTAS, gamepads)
//   driftwing-v2.audio.vario                     variometer audio mode (AudioEngine)
//
// IndexedDB is scoped to the origin INCLUDING the port, which is why the dev server is pinned to
// 127.0.0.1:5199. When IndexedDB is unavailable (some private modes), storage falls back to
// localStorage (the same 'driftwing-v2.' keys), and if that is blocked too, to memory for the session.
//
// The Phase 1 build kept the same data, under unprefixed names, in the IndexedDB database
// "driftwing". The first data migration copies it across once (see importPhaseOneDatabase).
//
// The dev verification harnesses (?test=1, ?test=hotas) pass their own database name to init(), so
// their settings, bindings and calibration never touch the player's. Such an isolated database
// skips the data migrations and falls back to memory only (never to the player's localStorage keys).

const DB_NAME = 'driftwing-v2';
const STORE = 'kv';
const META_KEY = '__schema';
/** Every V2 storage key (IndexedDB, localStorage and sessionStorage) starts with this. */
export const STORAGE_KEY_PREFIX = 'driftwing-v2.';
/** The Phase 1 database, imported once into DB_NAME and then deleted. */
export const PHASE_ONE_DB_NAME = 'driftwing';
/** Boot waits at most this long for IndexedDB to open before it takes the localStorage fallback. */
const OPEN_TIMEOUT_MS = 4000;

/** Throws on a key outside V2's namespace: V2 must never touch V1's (or anyone else's) keys. */
function assertOwnedKey(key) {
  if (typeof key !== 'string' || !key.startsWith(STORAGE_KEY_PREFIX)) {
    throw new Error(`storage key "${key}" is outside V2's namespace (${STORAGE_KEY_PREFIX}*)`);
  }
}

/**
 * The new name of a Phase 1 key, or null for data V2 does not carry over. V2-owned data is the
 * settings record, the input.* bindings and calibration, the audio.* keys and the journals;
 * driftwing.settings.v1 (V1's own settings, once imported by Phase 1) and the driftwing.ui.* hint
 * flags stay behind.
 */
export function phaseOneKeyToV2(key) {
  if (key === 'driftwing.settings') return `${STORAGE_KEY_PREFIX}settings`;
  if (key.startsWith('driftwing.journal.') && key.length > 'driftwing.journal.'.length) return `${STORAGE_KEY_PREFIX}${key.slice('driftwing.'.length)}`;
  if (key.startsWith('input.') || key.startsWith('audio.')) return `${STORAGE_KEY_PREFIX}${key}`;
  return null;
}

/**
 * A Phase 1 value as V2 stores it. The settings record loses the CLASSIC | SIM 'mode' field: V2
 * has no CLASSIC mode any more.
 */
function phaseOneValueToV2(key, value) {
  if (key !== 'driftwing.settings' || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { mode, ...rest } = value;
  return rest;
}

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
  // v1: import the Phase 1 database "driftwing" when this one is still empty.
  (context) => importPhaseOneDatabase(context),
];
const DB_VERSION = STRUCTURE_MIGRATIONS.length;
const DATA_VERSION = DATA_MIGRATIONS.length;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function describeError(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Opens a database only if it already exists. An open without a version would create a missing
 * database, so the upgrade that would create it is aborted instead. Resolves the connection, or
 * null when there is no such database; rejects on failure or after timeoutMs (a connection that
 * arrives later is closed).
 */
function openExistingDatabase(name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let settled = false;
    let missing = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`IndexedDB "${name}" did not open within ${timeoutMs} ms`));
    }, timeoutMs);
    function settle(finish) {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      finish();
      return true;
    }
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!settle(() => resolve(database))) database.close();
    };
    request.onerror = () => settle(() => (missing ? resolve(null) : reject(request.error)));
  });
}

/** Every [key, value] pair in database's key-value store. */
async function readEntries(database) {
  const transaction = database.transaction(STORE, 'readonly');
  const store = transaction.objectStore(STORE);
  const [keys, values] = await Promise.all([requestToPromise(store.getAllKeys()), requestToPromise(store.getAll())]);
  return keys.map((key, index) => [key, values[index]]);
}

/**
 * Deletes a database. Resolves 'deleted', or 'blocked' when another tab still holds it open: the
 * browser then finishes the deletion once that tab lets go, so boot does not wait for it.
 */
function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve('deleted');
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve('blocked');
  });
}

/**
 * Data migration v1: when the "driftwing-v2" database is still empty and the Phase 1 database
 * "driftwing" exists, copies V2's own records across under their new names (phaseOneKeyToV2), then
 * deletes the old database once every copied record has landed. Runs once per database: the
 * schema record marks it done even when there was nothing to import.
 */
async function importPhaseOneDatabase(context) {
  if (context.keys().length > 0 || typeof indexedDB === 'undefined') return;
  let legacy;
  try {
    legacy = await openExistingDatabase(PHASE_ONE_DB_NAME, context.openTimeoutMs);
  } catch (error) {
    context.report(`the Phase 1 database could not be opened, so nothing was imported (${describeError(error)})`);
    return;
  }
  if (!legacy) return;
  let entries;
  try {
    entries = await readEntries(legacy);
  } catch (error) {
    context.report(`the Phase 1 database could not be read, so nothing was imported (${describeError(error)})`);
    return;
  } finally {
    legacy.close();
  }
  let imported = 0;
  for (const [key, value] of entries) {
    const newKey = typeof key === 'string' ? phaseOneKeyToV2(key) : null;
    if (!newKey) continue;
    context.put(newKey, phaseOneValueToV2(key, value));
    imported++;
  }
  context.report(`imported ${imported} of ${entries.length} Phase 1 records`);
  if (!(await context.writesLanded())) {
    context.report('the Phase 1 database was kept because the imported records could not be saved');
    return;
  }
  try {
    const outcome = await deleteDatabase(PHASE_ONE_DB_NAME);
    if (outcome === 'blocked') context.report('the Phase 1 database is still open in another tab; the browser deletes it once that tab closes');
  } catch (error) {
    context.report(`the Phase 1 database could not be deleted (${describeError(error)})`);
  }
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
  let databaseName = DB_NAME;

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
      const request = indexedDB.open(databaseName, DB_VERSION);
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

  async function runDataMigrations() {
    const meta = cache.get(META_KEY) || { dataVersion: 0 };
    const notes = [];
    const context = {
      openTimeoutMs,
      /** Stored game keys (the schema record excluded). */
      keys() {
        return [...cache.keys()].filter((key) => key !== META_KEY);
      },
      put(key, value) {
        cache.set(key, value);
        persist(key, value);
      },
      /** Waits for every queued write; true when they all landed in IndexedDB. */
      async writesLanded() {
        await pending;
        return backend === 'indexeddb' && !writeFailureReported;
      },
      report(note) { notes.push(note); },
    };
    for (let version = meta.dataVersion; version < DATA_VERSION; version++) await DATA_MIGRATIONS[version](context);
    if (meta.dataVersion !== DATA_VERSION) {
      const updated = { dataVersion: DATA_VERSION, migratedAt: new Date().toISOString(), notes };
      cache.set(META_KEY, updated);
      persist(META_KEY, updated);
    }
  }

  function loadFromLocalStorage() {
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
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
    /** Name of the IndexedDB database in use ('driftwing-v2', or a test harness's isolated one). */
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
            attachConnection(await openDatabase());
            backend = 'indexeddb';
            await loadAll();
            if (!isolated) await runDataMigrations();
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
      assertOwnedKey(key);
      return cache.has(key) ? cache.get(key) : fallback;
    },

    /** Updates the cache and persists in the background. Returns false only when nothing can persist. */
    write(key, value) {
      assertOwnedKey(key);
      cache.set(key, value);
      return persist(key, value);
    },

    remove(key) {
      assertOwnedKey(key);
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
