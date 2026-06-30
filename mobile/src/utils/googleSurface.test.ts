// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  hasCalendarScope,
  hasGoogleScope,
  isGoogleConnected,
  shouldShowCalendarNav,
} from './googleSurface';

describe('googleSurface (mobile)', () => {
  it('isGoogleConnected reflects the connected flag', () => {
    expect(isGoogleConnected(null)).toBe(false);
    expect(isGoogleConnected({ connected: false })).toBe(false);
    expect(isGoogleConnected({ connected: true })).toBe(true);
  });

  it('hasGoogleScope / hasCalendarScope detect granted scopes', () => {
    expect(hasGoogleScope({ grantedScopes: ['x'] }, 'x')).toBe(true);
    expect(hasGoogleScope(null, 'x')).toBe(false);
    expect(hasCalendarScope({ grantedScopes: [CALENDAR_EVENTS_SCOPE] })).toBe(true);
    expect(hasCalendarScope({ grantedScopes: [CALENDAR_FULL_SCOPE] })).toBe(true);
    expect(hasCalendarScope({ grantedScopes: [] })).toBe(false);
  });

  it('shouldShowCalendarNav gates the drawer entry on connection only', () => {
    expect(shouldShowCalendarNav(null)).toBe(false);
    expect(shouldShowCalendarNav({ connected: false })).toBe(false);
    // Connected but unconsented still shows the entry (inline Enable affordance).
    expect(shouldShowCalendarNav({ connected: true, grantedScopes: [] })).toBe(true);
  });
});
