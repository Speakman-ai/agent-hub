import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { isHostPortFree } from './host-port-probe.js';

const servers: net.Server[] = [];

/** Bind a listener and return its port. Closed in afterEach. */
async function listenOn(host: string): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('isHostPortFree', () => {
  it('reports a port nobody is listening on as free', async () => {
    // Bind then release, so the number is known-unused rather than guessed.
    const port = await listenOn('127.0.0.1');
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));

    expect(await isHostPortFree(port)).toBe(true);
  });

  it('reports a port held by a wildcard listener as taken', async () => {
    const port = await listenOn('0.0.0.0');

    expect(await isHostPortFree(port)).toBe(false);
  });

  it('reports a port held by a loopback-only listener as taken', async () => {
    // The case that produced the wrong-app preview: an orphaned dev server
    // bound to 127.0.0.1 only. A wildcard-only probe can miss this on some
    // platforms, so the probe checks loopback separately.
    const port = await listenOn('127.0.0.1');

    expect(await isHostPortFree(port)).toBe(false);
  });

  it('does not leave the probed port bound', async () => {
    const port = await listenOn('127.0.0.1');
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));

    expect(await isHostPortFree(port)).toBe(true);
    // A leaked probe socket would make the second call disagree with the
    // first and permanently remove the port from the pool.
    expect(await isHostPortFree(port)).toBe(true);
  });
});
