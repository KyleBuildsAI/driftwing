// Free-port discovery shared by the headless tools (run-harness.mjs, shell-test.mjs).
import { createServer } from 'node:net';

/** The player's dev server port (IndexedDB is scoped to it): never used by the tools. */
export const RESERVED_PORT = 5199;
/** Ports Chrome refuses to load (net::ERR_UNSAFE_PORT) in the range the OS may hand out. */
const CHROME_UNSAFE_PORTS = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

/** A free TCP port on 127.0.0.1 that Chrome will load and that is not the player's port. */
export async function findFreePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolvePort, rejectPort) => {
      const probe = createServer();
      probe.once('error', rejectPort);
      probe.listen(0, '127.0.0.1', () => {
        const { port: assigned } = probe.address();
        probe.close(() => resolvePort(assigned));
      });
    });
    if (port !== RESERVED_PORT && !CHROME_UNSAFE_PORTS.has(port)) return port;
  }
  throw new Error('no usable free port found');
}
