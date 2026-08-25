// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveDesignRedirect, isDesignMigrated } from './designRedirect';
describe('resolveDesignRedirect (mobile)', () => {
  it('returns the session target for a migrated design', () => {
    expect(resolveDesignRedirect({ imported_session_id: 'sess-1' })).toEqual({
      sessionId: 'sess-1',
    });
  });
  it('trims the recorded session id', () => {
    expect(resolveDesignRedirect({ imported_session_id: '  sess-2  ' })).toEqual({
      sessionId: 'sess-2',
    });
  });
  it('returns null for a not-yet-migrated design', () => {
    expect(resolveDesignRedirect({ imported_session_id: null })).toBeNull();
    expect(resolveDesignRedirect({})).toBeNull();
    expect(resolveDesignRedirect({ imported_session_id: '   ' })).toBeNull();
  });
  it('returns null for nullish input', () => {
    expect(resolveDesignRedirect(undefined)).toBeNull();
    expect(resolveDesignRedirect(null)).toBeNull();
  });
});
describe('isDesignMigrated (mobile)', () => {
  it('reflects redirect resolvability', () => {
    expect(isDesignMigrated({ imported_session_id: 'sess-1' })).toBe(true);
    expect(isDesignMigrated({ imported_session_id: null })).toBe(false);
    expect(isDesignMigrated(null)).toBe(false);
  });
});
