// @ts-nocheck
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

  it('GMAIL_SURFACE_SCOPES requests least-privilege readonly+send, not modify', () => {
    expect(GMAIL_SURFACE_SCOPES).toEqual([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
    expect(GMAIL_SURFACE_SCOPES).not.toContain(GMAIL_MODIFY_SCOPE);
  });

  it('hasGmailReadScope accepts readonly/modify/full but not send-only', () => {
    expect(hasGmailReadScope({ grantedScopes: [GMAIL_READONLY_SCOPE] })).toBe(true);
    expect(hasGmailReadScope({ grantedScopes: [GMAIL_MODIFY_SCOPE] })).toBe(true);
    expect(hasGmailReadScope({ grantedScopes: [GMAIL_FULL_SCOPE] })).toBe(true);
    expect(hasGmailReadScope({ grantedScopes: [GMAIL_SEND_SCOPE] })).toBe(false);
    expect(hasGmailReadScope({ grantedScopes: [] })).toBe(false);
  });

  it('hasGmailSendScope accepts send/modify/full', () => {
    expect(hasGmailSendScope({ grantedScopes: [GMAIL_SEND_SCOPE] })).toBe(true);
    expect(hasGmailSendScope({ grantedScopes: [GMAIL_MODIFY_SCOPE] })).toBe(true);
    expect(hasGmailSendScope({ grantedScopes: [CALENDAR_EVENTS_SCOPE] })).toBe(false);
  });

  it('shouldShowGmailNav gates the drawer entry on connection only', () => {
    expect(shouldShowGmailNav(null)).toBe(false);
    expect(shouldShowGmailNav({ connected: false })).toBe(false);
    expect(shouldShowGmailNav({ connected: true, grantedScopes: [] })).toBe(true);
  });

  it('SHEETS_SURFACE_SCOPES requests full spreadsheets + drive.file, never restricted Drive', () => {
    expect(SHEETS_SURFACE_SCOPES).toEqual([SHEETS_SCOPE, DRIVE_FILE_SCOPE]);
    expect(SHEETS_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(SHEETS_SURFACE_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });

  it('hasSheetsScope reads with readonly/full; hasSheetsWriteScope needs the full scope', () => {
    expect(hasSheetsScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(true);
    expect(hasSheetsScope({ grantedScopes: [SHEETS_READONLY_SCOPE] })).toBe(true);
    expect(hasSheetsScope({ grantedScopes: [] })).toBe(false);
    expect(hasSheetsWriteScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(true);
    expect(hasSheetsWriteScope({ grantedScopes: [SHEETS_READONLY_SCOPE] })).toBe(false);
  });

  it('hasDriveFileScope is true only with drive.file', () => {
    expect(hasDriveFileScope({ grantedScopes: [DRIVE_FILE_SCOPE] })).toBe(true);
    expect(hasDriveFileScope({ grantedScopes: [SHEETS_SCOPE] })).toBe(false);
    expect(hasDriveFileScope(null)).toBe(false);
  });

  it('shouldShowSheetsNav gates the drawer entry on connection only', () => {
    expect(shouldShowSheetsNav(null)).toBe(false);
    expect(shouldShowSheetsNav({ connected: false })).toBe(false);
    expect(shouldShowSheetsNav({ connected: true, grantedScopes: [] })).toBe(true);
  });
});
