import { describe, it, expect, vi, afterEach } from 'vitest';

describe('server-port', () => {
  afterEach(() => {
    // Reset module state between tests so setActualPort calls don't leak.
    vi.resetModules();
  });

  it('getActualPort() returns 3051 before setActualPort() is called', async () => {
    const { getActualPort } = await import('./server-port.js');
    expect(getActualPort()).toBe(3051);
  });

  it('getActualPort() returns the port set via setActualPort()', async () => {
    const { setActualPort, getActualPort } = await import('./server-port.js');
    setActualPort(41811);
    expect(getActualPort()).toBe(41811);
  });

  it('setActualPort() is idempotent — last write wins', async () => {
    const { setActualPort, getActualPort } = await import('./server-port.js');
    setActualPort(4000);
    setActualPort(5000);
    expect(getActualPort()).toBe(5000);
  });
});
