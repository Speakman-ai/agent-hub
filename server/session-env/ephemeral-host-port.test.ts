import { describe, expect, it, beforeEach } from 'vitest';
import {
  allocateEphemeralHostPort,
  isEphemeralHostPortReservedForTests,
  releaseEphemeralHostPort,
  resetEphemeralHostPortReservationsForTests,
} from './ephemeral-host-port.js';

describe('allocateEphemeralHostPort', () => {
  beforeEach(() => {
    resetEphemeralHostPortReservationsForTests();
  });

  it('reserves the port until release', async () => {
    const port = await allocateEphemeralHostPort();
    expect(port).toBeGreaterThan(0);
    expect(isEphemeralHostPortReservedForTests(port)).toBe(true);
    releaseEphemeralHostPort(port);
    expect(isEphemeralHostPortReservedForTests(port)).toBe(false);
  });

  it('does not hand out a still-reserved port to a concurrent allocate', async () => {
    const a = await allocateEphemeralHostPort();
    // Force the next listen(0) collision path by re-adding after a manual
    // listen is awkward; instead allocate many and assert uniqueness while
    // held.
    const held = new Set<number>([a]);
    for (let i = 0; i < 8; i++) {
      const p = await allocateEphemeralHostPort();
      expect(held.has(p)).toBe(false);
      held.add(p);
    }
    for (const p of held) releaseEphemeralHostPort(p);
  });
});
