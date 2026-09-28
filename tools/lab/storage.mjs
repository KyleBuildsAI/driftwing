// Storage lab: runs src/core/storage.js headless (node) against an in-memory IndexedDB and
// localStorage that can misbehave on purpose, and checks that the game's saved data survives.
//
// Tests:
//   roundTrip     init on IndexedDB, write / remove, flush, and the values reach the database
//   openHang      an open that never answers: init gives up after the timeout and takes the
//                 localStorage fallback; a connection that arrives later is closed
//   fallbackKeys  the localStorage fallback reloads every game key, audio.vario included
//   forcedClose   the browser closes the connection (site data cleared, eviction): the next write
//                 reopens the database and lands, and write() keeps returning true
//   versionChange another tab opens a newer version: the connection closes so that tab can upgrade,
//                 the next write cannot reopen, the failure listener fires once, the backend drops
//                 to memory and later writes return false
//
// Usage: node tools/lab/storage.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { createStorage } from '../../src/core/storage.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass, detail });
  if (VERBOSE) process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}${detail ? `: ${detail}` : ''}\n`);
}

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
 * A small IndexedDB: one database, object stores of key -> value, asynchronous requests and
 * transactions, versionchange / close events, and switches to make the open hang.
 */
function createFakeIndexedDB() {
  const stores = new Map();
  const connections = new Set();
  const heldOpens = [];
  let version = 0;
  let hangOpens = false;

  function createRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }

  function createConnection() {
    const connection = {
      closed: false,
      onversionchange: null,
      onclose: null,
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name) {
        stores.set(name, new Map());
      },
      close() {
        connection.closed = true;
        connections.delete(connection);
      },
      transaction(name) {
        if (connection.closed) throw namedError('InvalidStateError');
        const data = stores.get(name);
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
    connections.add(connection);
    return connection;
  }

  function answerOpen(request, requestedVersion) {
    if (requestedVersion < version) {
      request.error = namedError('VersionError');
      request.onerror?.();
      return;
    }
    const connection = createConnection();
    request.result = connection;
    if (requestedVersion > version) {
      const oldVersion = version;
      version = requestedVersion;
      request.onupgradeneeded?.({ oldVersion });
    }
    request.onsuccess?.();
  }

  return {
    stores,
    connections,
    get version() { return version; },
    set hangOpens(value) { hangOpens = value; },

    open(name, requestedVersion) {
      const request = createRequest();
      if (hangOpens) heldOpens.push({ request, requestedVersion });
      else setTimeout(() => answerOpen(request, requestedVersion), 0);
      return request;
    },

    /** Answers every open that was held while hangOpens was on (a late success). */
    releaseHeldOpens() {
      for (const held of heldOpens.splice(0)) answerOpen(held.request, held.requestedVersion);
    },

    /** The browser closes every connection outright (site data cleared, eviction). */
    forceCloseAll() {
      for (const connection of [...connections]) {
        connection.closed = true;
        connections.delete(connection);
        connection.onclose?.();
      }
    },

    /** Another tab opens a newer version: every open connection is asked to close first. */
    upgradeFromAnotherTab(newVersion) {
      for (const connection of [...connections]) connection.onversionchange?.({ oldVersion: version, newVersion });
      if (connections.size > 0) return false;
      version = newVersion;
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
  const wrote = storage.write('driftwing.settings', { mode: 'sim' });
  storage.write('input.bindings', { version: 1 });
  storage.remove('input.bindings');
  await storage.flush();
  const saved = indexedDB.stores.get('kv');
  check('roundTrip', 'write returns true', wrote === true);
  check('roundTrip', 'value in the database', saved.get('driftwing.settings')?.mode === 'sim');
  check('roundTrip', 'removed key gone', !saved.has('input.bindings'));
}

async function testOpenHang() {
  const { indexedDB } = installFakes({ localEntries: { 'driftwing.settings': JSON.stringify({ mode: 'classic' }) } });
  indexedDB.hangOpens = true;
  const storage = createStorage({ openTimeoutMs: 150 });
  const started = Date.now();
  const backend = await Promise.race([storage.init(), sleep(2000).then(() => 'still waiting')]);
  const waited = Date.now() - started;
  check('openHang', 'init settles', backend !== 'still waiting', `${backend} after ${waited} ms`);
  check('openHang', 'falls back to localStorage', backend === 'localstorage');
  check('openHang', 'fallback data loaded', storage.read('driftwing.settings')?.mode === 'classic');
  indexedDB.hangOpens = false;
  indexedDB.releaseHeldOpens();
  await sleep(20);
  check('openHang', 'late connection closed', indexedDB.connections.size === 0, `${indexedDB.connections.size} open`);
  check('openHang', 'backend unchanged by the late open', storage.backend === 'localstorage');
}

async function testFallbackKeys() {
  const localEntries = {
    'driftwing.settings': JSON.stringify({ mode: 'sim' }),
    'input.bindings': JSON.stringify({ version: 1 }),
    'audio.vario': JSON.stringify('on'),
    'someone.else': JSON.stringify('not ours'),
  };
  installFakes({ localEntries });
  delete globalThis.indexedDB;
  const storage = createStorage({ openTimeoutMs: 150 });
  const backend = await storage.init();
  check('fallbackKeys', 'backend', backend === 'localstorage', backend);
  check('fallbackKeys', 'audio.vario reloaded', storage.read('audio.vario', 'auto') === 'on', storage.read('audio.vario', 'auto'));
  check('fallbackKeys', 'driftwing and input keys reloaded', storage.read('driftwing.settings')?.mode === 'sim' && storage.read('input.bindings')?.version === 1);
  check('fallbackKeys', 'foreign keys ignored', storage.read('someone.else', null) === null);
}

async function testForcedClose() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  const failures = [];
  storage.onWriteFailure((error) => failures.push(error));
  storage.write('driftwing.settings', { mode: 'classic' });
  await storage.flush();
  indexedDB.forceCloseAll();
  const wrote = storage.write('driftwing.settings', { mode: 'sim' });
  await storage.flush();
  const saved = indexedDB.stores.get('kv').get('driftwing.settings');
  check('forcedClose', 'write returns true', wrote === true);
  check('forcedClose', 'write after the close lands', saved?.mode === 'sim', JSON.stringify(saved));
  check('forcedClose', 'connection reopened', indexedDB.connections.size === 1, `${indexedDB.connections.size} open`);
  check('forcedClose', 'no failure reported', failures.length === 0 && storage.backend === 'indexeddb');

  // A close that lands while the write's transaction is in flight: retried on a new connection.
  const inFlight = storage.write('driftwing.journal.SEED', { entries: 3 });
  indexedDB.forceCloseAll();
  await storage.flush();
  check('forcedClose', 'write in flight when closed lands', inFlight && indexedDB.stores.get('kv').get('driftwing.journal.SEED')?.entries === 3);
}

async function testVersionChange() {
  const { indexedDB } = installFakes();
  const storage = createStorage({ openTimeoutMs: 200 });
  await storage.init();
  const failures = [];
  storage.onWriteFailure((error) => failures.push(error));
  const upgraded = indexedDB.upgradeFromAnotherTab(2);
  check('versionChange', 'connection closes for the other tab', upgraded && indexedDB.connections.size === 0);
  storage.write('driftwing.settings', { mode: 'sim' });
  storage.write('input.bindings', { version: 1 });
  await storage.flush();
  check('versionChange', 'failure listener fired once', failures.length === 1, failures.map((error) => error.name).join(', '));
  check('versionChange', 'backend drops to memory', storage.backend === 'memory', storage.backend);
  check('versionChange', 'later writes return false', storage.write('driftwing.settings', { mode: 'classic' }) === false);
  check('versionChange', 'cache still serves reads', storage.read('driftwing.settings')?.mode === 'classic');
}

const TESTS = [testRoundTrip, testOpenHang, testFallbackKeys, testForcedClose, testVersionChange];
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
