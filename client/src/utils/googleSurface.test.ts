import { describe, it, expect } from 'vitest';
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  hasCalendarScope,
  hasGoogleScope,
  isGoogleConnected,
  shouldShowCalendarNav,
} from './googleSurface';

describe('googleSurface', () => {
  describe('isGoogleConnected', () => {
    it('is false for a missing or disconnected status', () => {
      expect(isGoogleConnected(null)).toBe(false);
      expect(isGoogleConnected({})).toBe(false);
      expect(isGoogleConnected({ connected: false })).toBe(false);
    });

    it('is true only when connected', () => {
      expect(isGoogleConnected({ connected: true })).toBe(true);
    });
  });

  describe('hasGoogleScope / hasCalendarScope', () => {
    it('detects an exact granted scope', () => {
      expect(hasGoogleScope({ grantedScopes: ['a', 'b'] }, 'b')).toBe(true);
      expect(hasGoogleScope({ grantedScopes: ['a'] }, 'b')).toBe(false);
      expect(hasGoogleScope(null, 'b')).toBe(false);
    });

    it('accepts either the events or full calendar scope', () => {
      expect(hasCalendarScope({ grantedScopes: [CALENDAR_EVENTS_SCOPE] })).toBe(true);
      expect(hasCalendarScope({ grantedScopes: [CALENDAR_FULL_SCOPE] })).toBe(true);
      expect(
        hasCalendarScope({ grantedScopes: ['https://www.googleapis.com/auth/gmail.send'] }),
      ).toBe(false);
      expect(hasCalendarScope({ grantedScopes: [] })).toBe(false);
    });
  });

  describe('shouldShowCalendarNav', () => {
    it('hides the nav entry when signed out', () => {
      expect(shouldShowCalendarNav(null)).toBe(false);
      expect(shouldShowCalendarNav({ connected: false, grantedScopes: [] })).toBe(false);
    });

    it('shows the nav entry as soon as Google is connected, even before consent', () => {
      // Gated on connection only: a connected-but-unconsented user still sees
      // the nav item; the pane shows the inline "Enable Calendar" affordance.
      expect(shouldShowCalendarNav({ connected: true, grantedScopes: [] })).toBe(true);
      expect(
        shouldShowCalendarNav({ connected: true, grantedScopes: [CALENDAR_EVENTS_SCOPE] }),
      ).toBe(true);
    });
  });
});
