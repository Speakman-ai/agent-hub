import { describe, it, expect, vi, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  publicUrl: null as string | null,
  browserAllowPrivateNetwork: false,
}));
vi.mock('./config.js', () => ({ default: cfg }));

import { browserNavigationPolicyFromConfig } from './browser-host-policy.js';
import { validateBrowserNavigationUrl } from './browser-navigation-url.js';

describe('browserNavigationPolicyFromConfig private network', () => {
  afterEach(() => {
    cfg.publicUrl = null;
    cfg.browserAllowPrivateNetwork = false;
  });

  it('blocks LAN targets when browserAllowPrivateNetwork is off', () => {
    const policy = browserNavigationPolicyFromConfig();
    expect(validateBrowserNavigationUrl('http://192.168.50.30:3000', policy).ok).toBe(false);
  });

  it('allows LAN targets when browserAllowPrivateNetwork is on', () => {
    cfg.browserAllowPrivateNetwork = true;
    const policy = browserNavigationPolicyFromConfig();
    expect(validateBrowserNavigationUrl('http://192.168.50.30:3000', policy).ok).toBe(true);
  });

  it('keeps the public URL origin allowlisted alongside the private-network flag', () => {
    cfg.browserAllowPrivateNetwork = true;
    cfg.publicUrl = 'http://10.1.2.3:3051';
    expect(browserNavigationPolicyFromConfig()).toEqual({
      allowPrivateNetwork: true,
      allowOrigins: ['http://10.1.2.3:3051'],
    });
  });
});
