import { describe, it, expect } from 'vitest';
import {
  applyPreviewDevInstallDefaults,
  PREVIEW_DEV_INSTALL_DEFAULTS,
} from './preview-dev-install-env.js';

describe('applyPreviewDevInstallDefaults', () => {
  it('defaults NODE_ENV and NPM_CONFIG_INCLUDE for dev-mode installs', () => {
    const env: Record<string, string | undefined> = {};
    applyPreviewDevInstallDefaults(env, () => false);
    expect(env).toEqual({ NODE_ENV: 'development', NPM_CONFIG_INCLUDE: 'dev' });
  });

  it('overrides a leaked NODE_ENV=production from the parent env', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'production', HOME: '/home/node' };
    applyPreviewDevInstallDefaults(env, () => false);
    expect(env.NODE_ENV).toBe('development');
    // Unrelated inherited keys are left untouched.
    expect(env.HOME).toBe('/home/node');
  });

  it('preserves keys the project explicitly configured', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      NPM_CONFIG_INCLUDE: 'optional',
    };
    const configured = new Set(['NODE_ENV', 'NPM_CONFIG_INCLUDE']);
    applyPreviewDevInstallDefaults(env, (key) => configured.has(key));
    expect(env.NODE_ENV).toBe('production');
    expect(env.NPM_CONFIG_INCLUDE).toBe('optional');
  });

  it('only manages its own keys', () => {
    expect(Object.keys(PREVIEW_DEV_INSTALL_DEFAULTS).sort()).toEqual([
      'NODE_ENV',
      'NPM_CONFIG_INCLUDE',
    ]);
  });
});
