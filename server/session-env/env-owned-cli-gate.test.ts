import { describe, it, expect } from 'vitest';
import { envOwnedHostCliRefusal } from './env-owned-cli-gate.js';

describe('envOwnedHostCliRefusal', () => {
  it('refuses firecracker (env-owned)', () => {
    const msg = envOwnedHostCliRefusal('firecracker');
    expect(msg).toMatch(/not supported/);
    expect(msg).toMatch(/firecracker/);
  });

  it('allows host-shared adapters', () => {
    expect(envOwnedHostCliRefusal('host')).toBeNull();
    expect(envOwnedHostCliRefusal('sysbox')).toBeNull();
    expect(envOwnedHostCliRefusal('container')).toBeNull();
  });
});
