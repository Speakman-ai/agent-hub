import { describe, expect, it } from 'vitest';
import {
  describeSessionEnvPortRouting,
  resolveSessionEnvPortRouting,
} from './container-routing.js';

describe('resolveSessionEnvPortRouting', () => {
  it('routes by container IP on linux', () => {
    expect(resolveSessionEnvPortRouting({ env: {}, platform: 'linux' })).toBe('container-ip');
  });

  it('falls back to published ports where docker runs in a VM', () => {
    // Docker Desktop's bridge lives inside the VM, so a Hub process on the
    // host cannot open a connection to a container address. Choosing
    // container-IP here would produce previews that hang rather than fail.
    expect(resolveSessionEnvPortRouting({ env: {}, platform: 'darwin' })).toBe('published-ports');
    expect(resolveSessionEnvPortRouting({ env: {}, platform: 'win32' })).toBe('published-ports');
  });

  it('honours an explicit override in both directions', () => {
    // A Hub running in a container attached to the same docker network can
    // reach container IPs on any platform, and only the operator knows that.
    expect(
      resolveSessionEnvPortRouting({
        env: { AGENT_HUB_SESSION_ENV_PORT_ROUTING: 'container-ip' },
        platform: 'darwin',
      }),
    ).toBe('container-ip');
    expect(
      resolveSessionEnvPortRouting({
        env: { AGENT_HUB_SESSION_ENV_PORT_ROUTING: 'published-ports' },
        platform: 'linux',
      }),
    ).toBe('published-ports');
  });

  it('ignores an unrecognised override rather than guessing', () => {
    expect(
      resolveSessionEnvPortRouting({
        env: { AGENT_HUB_SESSION_ENV_PORT_ROUTING: 'sure' },
        platform: 'linux',
      }),
    ).toBe('container-ip');
  });
});

describe('describeSessionEnvPortRouting', () => {
  it('names the override when one is in force', () => {
    expect(
      describeSessionEnvPortRouting({
        env: { AGENT_HUB_SESSION_ENV_PORT_ROUTING: 'container-ip' },
        platform: 'darwin',
      }),
    ).toContain('AGENT_HUB_SESSION_ENV_PORT_ROUTING');
  });

  it('explains the platform reason otherwise', () => {
    expect(describeSessionEnvPortRouting({ env: {}, platform: 'darwin' })).toContain('darwin');
    expect(describeSessionEnvPortRouting({ env: {}, platform: 'linux' })).toContain('linux');
  });
});
