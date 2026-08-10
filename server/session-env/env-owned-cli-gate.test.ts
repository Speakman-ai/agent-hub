import { describe, it, expect } from 'vitest';
import { envOwnedHostCliRefusal } from './env-owned-cli-gate.js';

describe('envOwnedHostCliRefusal', () => {
  it('allows all adapters (guest CLI spawn is wired)', () => {
    expect(envOwnedHostCliRefusal('firecracker')).toBeNull();
    expect(envOwnedHostCliRefusal('host')).toBeNull();
    expect(envOwnedHostCliRefusal('sysbox')).toBeNull();
    expect(envOwnedHostCliRefusal('container')).toBeNull();
  });
});
