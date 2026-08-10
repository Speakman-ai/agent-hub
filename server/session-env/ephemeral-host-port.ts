/**
 * In-process ephemeral host-port reservation for published-ports SessionEnvs.
 *
 * `listen(0)` + immediate `close` alone races: another concurrent allocate
 * (or host process) can claim the same number before `docker run -p` binds it.
 * We keep claimed ports in a process-wide set until {@link releaseEphemeralHostPort}
 * after Docker has the mapping (or the start attempt fails).
 */

import { createServer, type Server } from 'net';

const reserved = new Set<number>();

function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (port <= 0) {
        server.close(() => reject(new Error('Failed to allocate ephemeral host port')));
        return;
      }
      resolve({ server, port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Reserve a free loopback port until {@link releaseEphemeralHostPort}.
 * Retries when `listen(0)` lands on a port already reserved in this process.
 */
export async function allocateEphemeralHostPort(maxAttempts = 32): Promise<number> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { server, port } = await listenEphemeral();
      if (reserved.has(port)) {
        await closeServer(server);
        continue;
      }
      reserved.add(port);
      await closeServer(server);
      return port;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Failed to allocate ephemeral host port after ${maxAttempts} attempts`);
}

/** Drop the reservation so the port may be allocated again. */
export function releaseEphemeralHostPort(port: number): void {
  reserved.delete(port);
}

/** Test helper — clear the reservation set between cases. */
export function resetEphemeralHostPortReservationsForTests(): void {
  reserved.clear();
}

export function isEphemeralHostPortReservedForTests(port: number): boolean {
  return reserved.has(port);
}
