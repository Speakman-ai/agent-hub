import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOwnerPasswordResetUrl,
  buildPasswordResetPath,
  buildPasswordResetUrl,
} from './email-sender.js';

describe('password reset email links', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds reset links only from configured HTTP origins', () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://hub.example/base/');

    expect(buildPasswordResetUrl('tok+en')).toBe('https://hub.example/base/reset?token=tok%2Ben');
  });

  it('rejects invalid configured origins for email while preserving Owner fallback paths', () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'javascript:alert(1)');

    expect(buildPasswordResetUrl('token')).toBeNull();
    expect(buildPasswordResetPath('token')).toBe('/reset?token=token');
    expect(buildOwnerPasswordResetUrl('token')).toBe('/reset?token=token');
  });
});
