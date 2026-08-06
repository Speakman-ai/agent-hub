import { describe, expect, it, vi } from 'vitest';

// `api.ts` reaches for stored config / auth at import time via these modules;
// stub them so the pure query helper can be imported under the node env.
vi.mock('./config', () => ({ getApiBaseUrl: () => '', getAuthHeaders: () => ({}) }));
vi.mock('./auth', () => ({ getToken: () => null, clearToken: vi.fn() }));

import { infraQuery } from './api';

describe('infraQuery', () => {
  it('drops empty and nullish values', () => {
    // The server reads `?service=` as a filter for a service literally named the
    // empty string, so a cleared chip would return nothing instead of
    // everything.
    expect(infraQuery({ service: '', region: null, state: undefined })).toBe('');
  });

  it('keeps a zero, which is a meaningful seenSince', () => {
    // `seenSince=0` means "everything ever described". Dropping it as falsy
    // would silently fall back to the collector's staleness default — the
    // opposite of what the "include stale" toggle asks for.
    expect(infraQuery({ seenSince: 0 })).toBe('?seenSince=0');
  });

  it('keeps false rather than treating it as absent', () => {
    expect(infraQuery({ enabled: false })).toBe('?enabled=false');
  });

  it('encodes values that need it', () => {
    expect(infraQuery({ resource: '111122223333/us-east-1/ec2/i-abc' })).toBe(
      '?resource=111122223333%2Fus-east-1%2Fec2%2Fi-abc',
    );
  });

  it('prefixes with ? only when there is something to send', () => {
    expect(infraQuery({})).toBe('');
    expect(infraQuery({ service: 'ec2' })).toBe('?service=ec2');
  });
});
