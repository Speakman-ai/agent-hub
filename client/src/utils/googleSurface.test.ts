import { describe, it, expect } from 'vitest';
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  DRIVE_FILE_SCOPE,
  GMAIL_FULL_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GMAIL_SURFACE_SCOPES,
  SHEETS_READONLY_SCOPE,
  SHEETS_SCOPE,
  SHEETS_SURFACE_SCOPES,
  hasCalendarScope,
  hasDriveFileScope,
  hasGmailReadScope,
  hasGmailSendScope,
  hasGoogleScope,
  hasSheetsScope,
  hasSheetsWriteScope,
  isGoogleConnected,
  shouldShowCalendarNav,
  shouldShowGmailNav,
  shouldShowSheetsNav,
  shouldShowDriveNav,
  DRIVE_SURFACE_SCOPES,
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

  describe('SHEETS_SURFACE_SCOPES', () => {
    it('requests the full spreadsheets scope plus drive.file, never a restricted Drive scope', () => {
      // The viewer reads + edits values (full spreadsheets) and lists files via
      // the Drive picker (drive.file). It must NOT request drive.readonly or the
      // full drive scope, which are restricted and trigger annual CASA.
      expect(SHEETS_SURFACE_SCOPES).toEqual([SHEETS_SCOPE, DRIVE_FILE_SCOPE]);
      expect(SHEETS_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
      expect(SHEETS_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
    });
  });

  describe('hasSheetsScope / hasSheetsWriteScope', () => {
    it('reads with full or readonly spreadsheets scope, writes only with the full scope', () => {
      expect(hasSheetsScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(true);
      expect(hasSheetsScope({ grantedScopes: [SHEETS_READONLY_SCOPE] })).toBe(true);
      expect(hasSheetsScope({ grantedScopes: [] })).toBe(false);
      expect(hasSheetsScope(null)).toBe(false);

      // Write requires the full spreadsheets scope; readonly is read-only.
      expect(hasSheetsWriteScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(true);
      expect(hasSheetsWriteScope({ grantedScopes: [SHEETS_READONLY_SCOPE] })).toBe(false);
    });
  });

  describe('hasDriveFileScope', () => {
    it('is true only when drive.file is granted', () => {
      expect(hasDriveFileScope({ grantedScopes: [DRIVE_FILE_SCOPE] })).toBe(true);
      expect(hasDriveFileScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(false);
      expect(hasDriveFileScope(null)).toBe(false);
    });
  });

  describe('shouldShowSheetsNav', () => {
    it('hides the nav entry when signed out', () => {
      expect(shouldShowSheetsNav(null)).toBe(false);
      expect(shouldShowSheetsNav({ connected: false, grantedScopes: [] })).toBe(false);
    });

    it('shows the nav entry as soon as Google is connected, even before consent', () => {
      // Gated on connection only — the pane shows the inline "Enable Sheets"
      // affordance when the spreadsheets scope is missing.
      expect(shouldShowSheetsNav({ connected: true, grantedScopes: [] })).toBe(true);
      expect(shouldShowSheetsNav({ connected: true, grantedScopes: [SHEETS_SCOPE] })).toBe(true);
    });
  });

  describe('DRIVE_SURFACE_SCOPES', () => {
    it('requests only the non-restricted drive.file scope, never a restricted Drive scope', () => {
      expect(DRIVE_SURFACE_SCOPES).toEqual([DRIVE_FILE_SCOPE]);
      expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
      expect(DRIVE_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
    });
  });

  describe('shouldShowDriveNav', () => {
    it('hides the nav entry when signed out', () => {
      expect(shouldShowDriveNav(null)).toBe(false);
      expect(shouldShowDriveNav({ connected: false, grantedScopes: [] })).toBe(false);
    });

    it('shows the nav entry as soon as Google is connected, even before consent', () => {
      // Gated on connection only — the pane shows the inline "Enable Drive"
      // affordance when the drive.file scope is missing.
      expect(shouldShowDriveNav({ connected: true, grantedScopes: [] })).toBe(true);
      expect(shouldShowDriveNav({ connected: true, grantedScopes: [DRIVE_FILE_SCOPE] })).toBe(true);
    });
  });
});
