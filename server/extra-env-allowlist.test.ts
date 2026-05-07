import { describe, it, expect } from 'vitest';
import { EXTRA_ENV_ALLOWLIST, mergeAllowlistedExtraEnv } from './extra-env-allowlist.js';

describe('extra-env-allowlist module', () => {
  it('allowlist is exactly DEV_HUB_API_KEY (explicit contract for callers)', () => {
    expect([...EXTRA_ENV_ALLOWLIST].sort()).toEqual(['DEV_HUB_API_KEY']);
  });

  it('merge is a no-op when extraEnv is undefined', () => {
    const env = { PATH: '/x' } as NodeJS.ProcessEnv;
    mergeAllowlistedExtraEnv(env, undefined);
    expect(env).toEqual({ PATH: '/x' });
  });
});
