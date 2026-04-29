/**
 * Tests for the transport selector. Pure logic — boots no servers,
 * touches no DB. The selector's job is just to return Local for
 * `runnerId == null` and Remote otherwise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRunnerTransport,
  _resetRunnerTransportCacheForTests,
} from './runner-transport-select.js';
import { LocalSpawnTransport, RemoteRunnerTransport } from './runner-transport.js';

describe('getRunnerTransport', () => {
  beforeEach(() => {
    _resetRunnerTransportCacheForTests();
  });

  it('returns LocalSpawnTransport when runnerId is missing', () => {
    const t = getRunnerTransport({ runnerId: undefined } as never);
    expect(t).toBeInstanceOf(LocalSpawnTransport);
  });

  it('returns LocalSpawnTransport when runnerId is null', () => {
    const t = getRunnerTransport({ runnerId: null });
    expect(t).toBeInstanceOf(LocalSpawnTransport);
  });

  it('returns RemoteRunnerTransport when runnerId is set', () => {
    const t = getRunnerTransport({ runnerId: 'r1' });
    expect(t).toBeInstanceOf(RemoteRunnerTransport);
    expect((t as RemoteRunnerTransport).runnerId).toBe('r1');
  });

  it('caches the LocalSpawnTransport across calls (singleton)', () => {
    const a = getRunnerTransport({ runnerId: null });
    const b = getRunnerTransport({ runnerId: null });
    expect(a).toBe(b);
  });

  it('does NOT cache RemoteRunnerTransport across runners', () => {
    const a = getRunnerTransport({ runnerId: 'r1' });
    const b = getRunnerTransport({ runnerId: 'r2' });
    expect(a).not.toBe(b);
  });
});
