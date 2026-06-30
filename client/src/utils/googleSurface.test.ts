import { describe, it, expect } from 'vitest';
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  GMAIL_FULL_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GMAIL_SURFACE_SCOPES,
  hasCalendarScope,
  hasGmailReadScope,
  hasGmailSendScope,
  hasGoogleScope,
  isGoogleConnected,
  shouldShowCalendarNav,
  shouldShowGmailNav,
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

  describe('GMAIL_SURFACE_SCOPES', () => {
    it('requests the least-privilege read+send pair and never gmail.modify', () => {
      // The surface only lists/reads threads and sends mail, so consent must
      // ask for gmail.readonly + gmail.send — not the broader gmail.modify.
      expect(GMAIL_SURFACE_SCOPES).toEqual([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
      expect(GMAIL_SURFACE_SCOPES).not.toContain(GMAIL_MODIFY_SCOPE);
    });
  });

  describe('hasGmailReadScope', () => {
    it('accepts gmail.readonly, modify, or the full mail scope, rejects send-only', () => {
      expect(hasGmailReadScope({ grantedScopes: [GMAIL_READONLY_SCOPE] })).toBe(true);
      expect(hasGmailReadScope({ grantedScopes: [GMAIL_MODIFY_SCOPE] })).toBe(true);
      expect(hasGmailReadScope({ grantedScopes: [GMAIL_FULL_SCOPE] })).toBe(true);
      // send alone does not grant read/list of the inbox.
      expect(hasGmailReadScope({ grantedScopes: [GMAIL_SEND_SCOPE] })).toBe(false);
      expect(hasGmailReadScope({ grantedScopes: [CALENDAR_EVENTS_SCOPE] })).toBe(false);
      expect(hasGmailReadScope(null)).toBe(false);
    });
  });

  describe('hasGmailSendScope', () => {
    it('accepts send, modify, or the full mail scope', () => {
      expect(hasGmailSendScope({ grantedScopes: [GMAIL_SEND_SCOPE] })).toBe(true);
      expect(hasGmailSendScope({ grantedScopes: [GMAIL_MODIFY_SCOPE] })).toBe(true);
      expect(hasGmailSendScope({ grantedScopes: [GMAIL_FULL_SCOPE] })).toBe(true);
      expect(hasGmailSendScope({ grantedScopes: [CALENDAR_FULL_SCOPE] })).toBe(false);
      expect(hasGmailSendScope(null)).toBe(false);
    });
  });

  describe('shouldShowGmailNav', () => {
    it('hides the nav entry when signed out', () => {
      expect(shouldShowGmailNav(null)).toBe(false);
      expect(shouldShowGmailNav({ connected: false, grantedScopes: [] })).toBe(false);
    });

    it('shows the nav entry as soon as Google is connected, even before consent', () => {
      // Gated on connection only — the pane shows the inline "Enable Gmail"
      // affordance when the gmail scope is missing.
      expect(shouldShowGmailNav({ connected: true, grantedScopes: [] })).toBe(true);
      expect(shouldShowGmailNav({ connected: true, grantedScopes: [GMAIL_MODIFY_SCOPE] })).toBe(
        true,
      );
    });
  });
});
