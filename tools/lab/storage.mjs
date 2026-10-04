// Storage lab: runs src/core/storage.js headless (node) against an in-memory IndexedDB and
// localStorage that can misbehave on purpose, and checks that the game's saved data survives and
// stays inside V2's namespace.
//
// Tests:
//   roundTrip       init on IndexedDB ("driftwing-v2"), write / remove, flush, and the values reach
//                   the database
//   openHang        an open that never answers: init gives up after the timeout and takes the
//                   localStorage fallback; a connection that arrives later is closed
//   fallbackKeys    the localStorage fallback reloads every driftwing-v2.* key (the audio key
//                   included) and nothing else: V1's driftwing.* keys and foreign keys stay unread
//   namespace       read / write / remove refuse keys outside driftwing-v2.*, and a fresh start
//                   neither reads nor changes V1's localStorage keys
//   forcedClose     the browser closes the connection (site data cleared, eviction): the next write
//                   reopens the database and lands, and write() keeps returning true
//   versionChange   another tab opens a newer version: the connection closes so that tab can upgrade,
//                   the next write cannot reopen, the failure listener fires once, the backend drops
//                   to memory and later writes return false
//   phaseOneImport  the Phase 1 database "driftwing" is copied once into the empty "driftwing-v2"
//                   under the new key names (settings without 'mode', input.*, audio.*, journals;
//                   not V1's settings or the UI flags), then deleted
//   importOnce      the import never runs again: not on a later boot, not into a database that
//                   already holds data (the old database is then left alone)
//   noPhaseOne      without a Phase 1 database nothing is imported and no "driftwing" database is
//                   created by looking for it
//   blockedDelete   a Phase 1 database held open by another tab: the data is imported, boot does not
//                   wait for the deletion, and the deletion finishes once that tab closes
//   keyMapping      phaseOneKeyToV2 for every kind of Phase 1 key
//
// Usage: node tools/lab/storage.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PHASE_ONE_DB_NAME, STORAGE_KEY_PREFIX, createStorage, phaseOneKeyToV2 } from '../../src/core/storage.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass, detail });
  if (VERBOSE) process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}${detail ? `: ${detail}` : ''}\n`);
}

const V2_DB = 'driftwing-v2';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

// ============================================================================================
// FAKE BROWSER STORAGE
// ============================================================================================
function createFakeLocalStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const target = {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
  };
  // Object.keys(window.localStorage) lists the stored keys, as in a browser.
  return new Proxy(target, {
    ownKeys: () => [...entries.keys()],
    getOwnPropertyDescriptor: (unused, key) => (entries.has(key) ? { enumerable: true, configurable: true, value: entries.get(key) } : undefined),
  });
}

/**
 * A small IndexedDB: named databases of object stores (key -> value), asynchronous requests and
 * transactions, versionchange / close events, an open without a version (the upgrade that would
 * create a missing database can be aborted), deleteDatabase with its blocked case, and switches
 * to make the open hang. stores / connections / version / upgradeFromAnotherTab act on the main
 * database (V2's "driftwing-v2").
 */
function createFakeIndexedDB({ mainName = V2_DB } = {}) {
  /** name -> { version, stores: Map(name -> Map), connections: Set, pendingDeletes: [] } */
  const databases = new Map();
  const heldOpens = [];
  let hangOpens = false;

  function createRequest() {
    return { result: undefined, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }

  /** Finishes pending deletions of record once its last connection has closed. */
  function settleDeletes(name, record) {
    if (record.connections.size > 0 || record.pendingDeletes.length === 0) return;
    if (databases.get(name) === record) databases.delete(name);
    for (const request of record.pendingDeletes.splice(0)) request.onsuccess?.();
  }

  function createConnection(name, record) {
    const connection = {
      closed: false,
      ignoresVersionChange: false,
      onversionchange: null,
      onclose: null,
      objectStoreNames: { contains: (storeName) => record.stores.has(storeName) },
      createObjectStore(storeName) {
        record.stores.set(storeName, new Map());
      },
      close() {
        connection.closed = true;
        record.connections.delete(connection);
        settleDeletes(name, record);
      },
      transaction(storeName) {
        if (connection.closed) throw namedError('InvalidStateError');
        if (!record.stores.has(storeName)) throw namedError('NotFoundError');
        const data = record.stores.get(storeName);
        const transaction = { error: null, oncomplete: null, onerror: null, onabort: null };
        const operations = [];
        function queue(run) {
          const request = createRequest();
          operations.push(() => {
            request.result = run();
            request.onsuccess?.();
          });
          return request;
        }
        transaction.objectStore = () => ({
          getAllKeys: () => queue(() => [...data.keys()]),
          getAll: () => queue(() => [...data.values()]),
          put: (value, key) => queue(() => data.set(key, structuredClone(value))),
          delete: (key) => queue(() => data.delete(key)),
        });
        setTimeout(() => {
          if (connection.closed) {
            transaction.error = null;
            transaction.onabort?.();
            return;
          }
          for (const operation of operations) operation();
          transaction.oncomplete?.();
        }, 0);
        return transaction;
      },
    };
    record.connections.add(connection);
    return connection;
  }

  function answerOpen(name, request, requestedVersion) {
    const existing = databases.get(name) ?? null;
    const currentVersion = existing ? existing.version : 0;
    const targetVersion = requestedVersion ?? Math.max(currentVersion, 1);
    if (targetVersion < currentVersion) {
      request.error = namedError('VersionError');
      request.onerror?.();
      return;
    }
    const record = existing ?? { version: 0, stores: new Map(), connections: new Set(), pendingDeletes: [] };
    if (!existing) databases.set(name, record);
    const connection = createConnection(name, record);
    request.result = connection;
    if (targetVersion > record.version) {
      const oldVersion = record.version;
      const previousStores = new Map(record.stores);
      let aborted = false;
      request.transaction = { abort() { aborted = true; } };
      record.version = targetVersion;
      request.onupgradeneeded?.({ oldVersion });
      if (aborted) {
        // An aborted upgrade leaves the database as it was; a database it was creating never exists.
        record.version = oldVersion;
        record.stores = previousStores;
        connection.close();
        if (oldVersion === 0 && databases.get(name) === record) databases.delete(name);
        request.result = undefined;
        request.error = namedError('AbortError');
        request.onerror?.();
        return;
      }
    }
    request.onsuccess?.();
  }

  const main = () => databases.get(mainName) ?? null;

  return {
    databases,
    get stores() { return main()?.stores ?? new Map(); },
    get connections() { return main()?.connections ?? new Set(); },
    get version() { return main()?.version ?? 0; },
    set hangOpens(value) { hangOpens = value; },

    open(name, requestedVersion) {
      const request = createRequest();
      if (hangOpens) heldOpens.push({ name, request, requestedVersion });
      else setTimeout(() => answerOpen(name, request, requestedVersion), 0);
      return request;
    },

    deleteDatabase(name) {
      const request = createRequest();
      setTimeout(() => {
        const record = databases.get(name);
        if (!record) {
          request.onsuccess?.();
          return;
        }
        record.pendingDeletes.push(request);
        for (const connection of [...record.connections]) {
          if (!connection.ignoresVersionChange) connection.onversionchange?.({ oldVersion: record.version, newVersion: null });
        }
        if (record.connections.size > 0) request.onblocked?.();
        else settleDeletes(name, record);
      }, 0);
      return request;
    },

    /** Creates a database directly: { [storeName]: { [key]: value } }. */
    seedDatabase(name, version, contents) {
      const stores = new Map(Object.entries(contents).map(([storeName, entries]) => [storeName, new Map(Object.entries(entries))]));
      databases.set(name, { version, stores, connections: new Set(), pendingDeletes: [] });
    },

    /** An open connection from another tab that does not close on versionchange (blocks a delete). */
    holdOpenFromAnotherTab(name) {
      const record = databases.get(name);
      if (!record) throw new Error(`no database ${name}`);
      const connection = createConnection(name, record);
      connection.ignoresVersionChange = true;
      return connection;
    },

    /** Answers every open that was held while hangOpens was on (a late success). */
    releaseHeldOpens() {
      for (const held of heldOpens.splice(0)) answerOpen(held.name, held.request, held.requestedVersion);
    },

    /** The browser closes every connection outright (site data cleared, eviction). */
    forceCloseAll() {
      for (const record of databases.values()) {
        for (const connection of [...record.connections]) {
          connection.closed = true;
          record.connections.delete(connection);
          connection.onclose?.();
        }
      }
    },

    /** Another tab opens a newer version of the main database: every open connection is asked to close first. */
    upgradeFromAnotherTab(newVersion) {
      const record = main();
      for (const connection of [...record.connections]) connection.onversionchange?.({ oldVersion: record.version, newVersion });
      if (record.connections.size > 0) return false;
      record.version = newVersion;
      return true;
    },
  };
}

/** Installs fresh fakes as the globals storage.js reads, and silences its expected error logs. */
function installFakes({ localEntries } = {}) {
  const indexedDB = createFakeIndexedDB();
  const localStorage = createFakeLocalStorage(localEntries);
  globalThis.indexedDB = indexedDB;
  globalThis.window = { localStorage };
  return { indexedDB, localStorage };
}

const loggedErrors = [];
const originalConsoleError = console.error;
console.error = (...parts) => {
  loggedErrors.push(parts.map((part) => (part instanceof Error ? `${part.name}: ${part.message}` : String(part))).join(' '));
};

// ============================================================================================
// TESTS
// ============================================================================================
async function testRoundTrip() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  const backend = await storage.init();
  check('roundTrip', 'init on IndexedDB', backend === 'indexeddb', backend);
  check('roundTrip', 'database is driftwing-v2', storage.databaseName === V2_DB && indexedDB.databases.has(V2_DB), storage.databaseName);
  const wrote = storage.write('driftwing-v2.settings', { craft: 'jet' });
  storage.write('driftwing-v2.input.bindings', { version: 1 });
  storage.remove('driftwing-v2.input.bindings');
  await storage.flush();
  const saved = indexedDB.stores.get('kv');
  check('roundTrip', 'write returns true', wrote === true);
  check('roundTrip', 'value in the database', saved.get('driftwing-v2.settings')?.craft === 'jet');
  check('roundTrip', 'removed key gone', !saved.has('driftwing-v2.input.bindings'));
}

async function testOpenHang() {
  const { indexedDB } = installFakes({ localEntries: { 'driftwing-v2.settings': JSON.stringify({ craft: 'glider' }) } });
  indexedDB.hangOpens = true;
  const storage = createStorage({ openTimeoutMs: 150 });
  const started = Date.now();
  const backend = await Promise.race([storage.init(), sleep(2000).then(() => 'still waiting')]);
  const waited = Date.now() - started;
  check('openHang', 'init settles', backend !== 'still waiting', `${backend} after ${waited} ms`);
  check('openHang', 'falls back to localStorage', backend === 'localstorage');
  check('openHang', 'fallback data loaded', storage.read('driftwing-v2.settings')?.craft === 'glider');
  indexedDB.hangOpens = false;
  indexedDB.releaseHeldOpens();
  await sleep(20);
  check('openHang', 'late connection closed', indexedDB.connections.size === 0, `${indexedDB.connections.size} open`);
  check('openHang', 'backend unchanged by the late open', storage.backend === 'localstorage');
}

async function testFallbackKeys() {
  const localEntries = {
    'driftwing-v2.settings': JSON.stringify({ craft: 'jet' }),
    'driftwing-v2.input.bindings': JSON.stringify({ version: 1 }),
    'driftwing-v2.audio.vario': JSON.stringify('on'),
    'driftwing.settings.v1': JSON.stringify({ masterVolume: 0.3 }),
    'driftwing.journal.ABC': JSON.stringify({ entries: [] }),
    'input.bindings': JSON.stringify({ version: 1, phaseOne: true }),
    'someone.else': JSON.stringify('not ours'),
  };
  installFakes({ localEntries });
  delete globalThis.indexedDB;
  const storage = createStorage({ openTimeoutMs: 150 });
  const backend = await storage.init();
  check('fallbackKeys', 'backend', backend === 'localstorage', backend);
  check('fallbackKeys', 'audio key reloaded', storage.read('driftwing-v2.audio.vario', 'auto') === 'on', storage.read('driftwing-v2.audio.vario', 'auto'));
  check('fallbackKeys', 'settings and input keys reloaded', storage.read('driftwing-v2.settings')?.craft === 'jet' && storage.read('driftwing-v2.input.bindings')?.version === 1);
  const loaded = storage.keys();
  check('fallbackKeys', 'only driftwing-v2.* keys loaded', loaded.length === 3 && loaded.every((key) => key.startsWith(STORAGE_KEY_PREFIX)), loaded.join(', '));
}

async function testNamespace() {
  const v1Entries = {
    'driftwing.settings.v1': JSON.stringify({ masterVolume: 0.3 }),
    'driftwing.journal.ABC': JSON.stringify({ entries: [1] }),
    'driftwing.ui.firstRunHintSeen': 'true',
  };
  const { localStorage } = installFakes({ localEntries: v1Entries });
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  const refused = (run) => {
    try {
      run();
      return false;
    } catch (error) {
      return /outside V2's namespace/.test(error.message);
    }
  };
  check('namespace', 'read of a V1 key throws', refused(() => storage.read('driftwing.settings.v1', null)));
  check('namespace', 'write of a V1 key throws', refused(() => storage.write('driftwing.journal.ABC', {})));
  check('namespace', 'remove of an unprefixed key throws', refused(() => storage.remove('input.bindings')));
  check('namespace', 'nothing of V1 imported', storage.keys().length === 0, storage.keys().join(', ') || 'empty');
  await storage.flush();
  const untouched = Object.entries(v1Entries).every(([key, value]) => localStorage.getItem(key) === value);
  check('namespace', 'V1 localStorage keys unchanged', untouched && Object.keys(localStorage).length === 3, Object.keys(localStorage).join(', '));
}

async function testForcedClose() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  const failures = [];
  storage.onWriteFailure((error) => failures.push(error));
  storage.write('driftwing-v2.settings', { craft: 'glider' });
  await storage.flush();
  indexedDB.forceCloseAll();
  const wrote = storage.write('driftwing-v2.settings', { craft: 'jet' });
  await storage.flush();
  const saved = indexedDB.stores.get('kv').get('driftwing-v2.settings');
  check('forcedClose', 'write returns true', wrote === true);
  check('forcedClose', 'write after the close lands', saved?.craft === 'jet', JSON.stringify(saved));
  check('forcedClose', 'connection reopened', indexedDB.connections.size === 1, `${indexedDB.connections.size} open`);
  check('forcedClose', 'no failure reported', failures.length === 0 && storage.backend === 'indexeddb');

  // A close that lands while the write's transaction is in flight: retried on a new connection.
  const inFlight = storage.write('driftwing-v2.journal.SEED', { entries: 3 });
  indexedDB.forceCloseAll();
  await storage.flush();
  check('forcedClose', 'write in flight when closed lands', inFlight && indexedDB.stores.get('kv').get('driftwing-v2.journal.SEED')?.entries === 3);
}

async function testVersionChange() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  const failures = [];
  storage.onWriteFailure((error) => failures.push(error));
  const upgraded = indexedDB.upgradeFromAnotherTab(2);
  check('versionChange', 'connection closes for the other tab', upgraded && indexedDB.connections.size === 0);
  storage.write('driftwing-v2.settings', { craft: 'jet' });
  storage.write('driftwing-v2.input.bindings', { version: 1 });
  await storage.flush();
  check('versionChange', 'failure listener fired once', failures.length === 1, failures.map((error) => error.name).join(', '));
  check('versionChange', 'backend drops to memory', storage.backend === 'memory', storage.backend);
  check('versionChange', 'later writes return false', storage.write('driftwing-v2.settings', { craft: 'glider' }) === false);
  check('versionChange', 'cache still serves reads', storage.read('driftwing-v2.settings')?.craft === 'glider');
}

/** A Phase 1 database as that build left it: its schema record, V2 data, and data V2 leaves behind. */
function phaseOneContents() {
  return {
    kv: {
      __schema: { dataVersion: 1, migratedAt: '2026-09-20T10:00:00.000Z', notes: [] },
      'driftwing.settings': { version: 3, mode: 'sim', craft: 'jet', assists: { jet: 0.5 } },
      'driftwing.settings.v1': { masterVolume: 0.4 },
      'driftwing.journal.ARCH1': { entries: 4 },
      'driftwing.ui.firstRunHintSeen': true,
      'driftwing.ui.simHintSeen': true,
      'input.bindings': { version: 1, global: { keyboard: { journal: [] } } },
      'input.calibration.044f-b10a': { deviceKey: '044f-b10a', axes: [] },
      'audio.vario': 'off',
    },
  };
}

async function testPhaseOneImport() {
  const { indexedDB } = installFakes();
  indexedDB.seedDatabase(PHASE_ONE_DB_NAME, 1, phaseOneContents());
  const storage = createStorage({ openTimeoutMs: 200 });
  const backend = await storage.init();
  await storage.flush();
  await sleep(10);
  const saved = indexedDB.databases.get(V2_DB)?.stores.get('kv');
  check('phaseOneImport', 'init on IndexedDB', backend === 'indexeddb', backend);
  const settings = storage.read('driftwing-v2.settings', null);
  check('phaseOneImport', 'settings imported without mode', settings?.craft === 'jet' && settings?.assists?.jet === 0.5 && !('mode' in settings), JSON.stringify(settings));
  check('phaseOneImport', 'bindings imported', storage.read('driftwing-v2.input.bindings', null)?.global?.keyboard?.journal?.length === 0);
  check('phaseOneImport', 'calibration imported', storage.read('driftwing-v2.input.calibration.044f-b10a', null)?.deviceKey === '044f-b10a');
  check('phaseOneImport', 'audio imported', storage.read('driftwing-v2.audio.vario', 'auto') === 'off');
  check('phaseOneImport', 'journal imported', storage.read('driftwing-v2.journal.ARCH1', null)?.entries === 4);
  const keys = storage.keys().sort();
  check('phaseOneImport', 'V1 settings and UI flags left behind', keys.length === 5, keys.join(', '));
  check('phaseOneImport', 'copies persisted to driftwing-v2', saved?.get('driftwing-v2.settings')?.craft === 'jet' && saved?.get('driftwing-v2.journal.ARCH1')?.entries === 4);
  const meta = saved?.get('__schema');
  check('phaseOneImport', 'migration recorded', meta?.dataVersion === 1 && meta.notes.some((note) => note.includes('imported 5 of 9')), JSON.stringify(meta?.notes));
  check('phaseOneImport', 'Phase 1 database deleted', !indexedDB.databases.has(PHASE_ONE_DB_NAME), [...indexedDB.databases.keys()].join(', '));
}

async function testImportOnce() {
  // A later boot: the old database reappears (an old tab, say), but the import already ran.
  const { indexedDB } = installFakes();
  indexedDB.seedDatabase(PHASE_ONE_DB_NAME, 1, phaseOneContents());
  const first = createStorage({ openTimeoutMs: 200 });
  await first.init();
  await first.flush();
  first.write('driftwing-v2.settings', { version: 3, craft: 'glider' });
  await first.flush();
  indexedDB.forceCloseAll();
  indexedDB.seedDatabase(PHASE_ONE_DB_NAME, 1, phaseOneContents());
  const second = createStorage({ openTimeoutMs: 200 });
  await second.init();
  await second.flush();
  check('importOnce', 'no second import', second.read('driftwing-v2.settings', null)?.craft === 'glider', JSON.stringify(second.read('driftwing-v2.settings', null)));
  check('importOnce', 'old database left alone on a later boot', indexedDB.databases.has(PHASE_ONE_DB_NAME));

  // A driftwing-v2 database that already holds data (and has no schema record yet): no import.
  const { indexedDB: freshDB } = installFakes();
  freshDB.seedDatabase(V2_DB, 1, { kv: { 'driftwing-v2.settings': { version: 3, craft: 'helicopter' } } });
  freshDB.seedDatabase(PHASE_ONE_DB_NAME, 1, phaseOneContents());
  const third = createStorage({ openTimeoutMs: 200 });
  await third.init();
  await third.flush();
  check('importOnce', 'no import into a database with data', third.read('driftwing-v2.settings', null)?.craft === 'helicopter' && third.keys().length === 1, third.keys().join(', '));
  check('importOnce', 'old database kept when not imported', freshDB.databases.has(PHASE_ONE_DB_NAME));
  check('importOnce', 'migration still recorded', freshDB.databases.get(V2_DB).stores.get('kv').get('__schema')?.dataVersion === 1);
}

async function testNoPhaseOne() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  await storage.flush();
  await sleep(10);
  check('noPhaseOne', 'nothing imported', storage.keys().length === 0, storage.keys().join(', ') || 'empty');
  check('noPhaseOne', 'looking did not create "driftwing"', !indexedDB.databases.has(PHASE_ONE_DB_NAME), [...indexedDB.databases.keys()].join(', '));
  check('noPhaseOne', 'only the game connection stays open', indexedDB.connections.size === 1, `${indexedDB.connections.size} open`);
  check('noPhaseOne', 'migration recorded', indexedDB.stores.get('kv').get('__schema')?.dataVersion === 1);
}

async function testBlockedDelete() {
  const { indexedDB } = installFakes();
  indexedDB.seedDatabase(PHASE_ONE_DB_NAME, 1, phaseOneContents());
  const otherTab = indexedDB.holdOpenFromAnotherTab(PHASE_ONE_DB_NAME);
  const storage = createStorage({ openTimeoutMs: 200 });
  const backend = await Promise.race([storage.init(), sleep(2000).then(() => 'still waiting')]);
  await storage.flush();
  check('blockedDelete', 'init settles', backend === 'indexeddb', backend);
  check('blockedDelete', 'data imported', storage.read('driftwing-v2.settings', null)?.craft === 'jet');
  const notes = indexedDB.stores.get('kv').get('__schema')?.notes ?? [];
  check('blockedDelete', 'blocked deletion noted', notes.some((note) => note.includes('still open in another tab')), JSON.stringify(notes));
  check('blockedDelete', 'old database still there while held', indexedDB.databases.has(PHASE_ONE_DB_NAME));
  otherTab.close();
  check('blockedDelete', 'deleted once the other tab closes', !indexedDB.databases.has(PHASE_ONE_DB_NAME));
}

async function testKeyMapping() {
  const cases = [
    ['driftwing.settings', 'driftwing-v2.settings'],
    ['driftwing.journal.ARCH1', 'driftwing-v2.journal.ARCH1'],
    ['input.bindings', 'driftwing-v2.input.bindings'],
    ['input.calibration.044f-b687', 'driftwing-v2.input.calibration.044f-b687'],
    ['input.prompts', 'driftwing-v2.input.prompts'],
    ['audio.vario', 'driftwing-v2.audio.vario'],
    ['driftwing.settings.v1', null],
    ['driftwing.journal.', null],
    ['driftwing.ui.firstRunHintSeen', null],
    ['__schema', null],
    ['someone.else', null],
  ];
  const wrong = cases.filter(([key, expected]) => phaseOneKeyToV2(key) !== expected).map(([key, expected]) => `${key} -> ${phaseOneKeyToV2(key)} (want ${expected})`);
  check('keyMapping', 'every Phase 1 key maps as specified', wrong.length === 0, wrong.join('; ') || `${cases.length} keys`);
}

const TESTS = [
  testRoundTrip, testOpenHang, testFallbackKeys, testNamespace, testForcedClose, testVersionChange,
  testPhaseOneImport, testImportOnce, testNoPhaseOne, testBlockedDelete, testKeyMapping,
];
for (const test of TESTS) {
  try {
    await test();
  } catch (error) {
    check(test.name, 'ran without throwing', false, error.stack ?? String(error));
  }
}
console.error = originalConsoleError;
if (VERBOSE && loggedErrors.length) process.stdout.write(`storage logged (expected in failure tests):\n  ${loggedErrors.join('\n  ')}\n`);

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test} / ${result.name}${result.detail ? ` (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; ${failed.length} FAILED` : ''}\n`);
process.exit(failed.length ? 1 : 0);
