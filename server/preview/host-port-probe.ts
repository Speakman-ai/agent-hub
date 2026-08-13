/**
 * Host-level "is this port actually free?" probe.
 *
 * The dev-server port pool is tracked in SQLite, but a database row is
 * not evidence that the host port is unoccupied: several teardown paths
 * (Hub restart, failed-row reclaim, legacy row sweep) delete the row
 * while the process it described is still listening. Handing that port
 * to the next session produces the worst possible failure — the preview
 * proxy connects successfully and serves a *different project's app*,
 * and the health probe confirms "ready" because something answered 200.
 *
 * Probing the socket before allocation closes that hole: an orphan
 * holding the port makes the port invisible to the allocator instead of
 * silently hijacking the next preview.
 */

import net from 'net';

/** Loopback and wildcard both matter — see `isHostPortFree`. */
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1'] as const;

/**
 * Attempt to bind `port` on one address.
 *
 * Resolves false only for the two errors that mean "someone else has
 * it" (`EADDRINUSE`, `EACCES`). Any other bind error is treated as free
 * so an unexpected platform quirk degrades to today's behavior rather
 * than draining the whole pool.
 */
function probeOne(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      // The socket never bound, so there is nothing to close.
      settle(!(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    });
    server.once('listening', () => {
      server.close(() => settle(true));
    });

    try {
      // `exclusive` defeats SO_REUSEADDR-style sharing so a port held by
      // another listener reliably reports EADDRINUSE.
      server.listen({ port, host, exclusive: true });
    } catch {
      settle(true);
    }
  });
}

/**
 * True when nothing on the host is listening on `port`.
 *
 * Checks the wildcard address and loopback separately: a dev server
 * bound only to `127.0.0.1` still makes the port unusable for the next
 * process, and the reverse holds on platforms where a wildcard bind
 * does not conflict with a loopback one.
 */
export async function isHostPortFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if (!(await probeOne(port, host))) return false;
  }
  return true;
}

/** Signature the dev-server runtime injects; see `isHostPortFree`. */
export type IsPortFreeFn = (port: number) => Promise<boolean>;
