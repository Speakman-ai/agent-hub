import { describe, it, expect } from 'vitest';
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  GMAIL_FULL_SCOPE,
  SHEETS_SCOPE,
  SHEETS_READONLY_SCOPE,
  hasCalendarReadScope,
  hasGmailReadScope,
  hasGmailModifyScope,
  hasGmailSendScope,
  hasSheetsReadScope,
  hasSheetsWriteScope,
} from './google-scopes.js';

describe('google-scopes read gates', () => {
  it('calendar read accepts events or full, rejects unrelated', () => {
    expect(hasCalendarReadScope([CALENDAR_EVENTS_SCOPE])).toBe(true);
    expect(hasCalendarReadScope([CALENDAR_FULL_SCOPE])).toBe(true);
    expect(hasCalendarReadScope([GMAIL_READONLY_SCOPE])).toBe(false);
    expect(hasCalendarReadScope([])).toBe(false);
  });

  it('gmail read accepts readonly, modify, or full', () => {
    expect(hasGmailReadScope([GMAIL_READONLY_SCOPE])).toBe(true);
    expect(hasGmailReadScope([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(hasGmailReadScope([GMAIL_FULL_SCOPE])).toBe(true);
    expect(hasGmailReadScope([GMAIL_SEND_SCOPE])).toBe(false);
    expect(hasGmailReadScope([])).toBe(false);
  });

  it('sheets read accepts full or readonly', () => {
    expect(hasSheetsReadScope([SHEETS_SCOPE])).toBe(true);
    expect(hasSheetsReadScope([SHEETS_READONLY_SCOPE])).toBe(true);
    expect(hasSheetsReadScope([])).toBe(false);
  });
});

describe('google-scopes write gates', () => {
  it('gmail modify needs modify or full (not readonly/send)', () => {
    expect(hasGmailModifyScope([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(hasGmailModifyScope([GMAIL_FULL_SCOPE])).toBe(true);
    expect(hasGmailModifyScope([GMAIL_READONLY_SCOPE])).toBe(false);
    expect(hasGmailModifyScope([GMAIL_SEND_SCOPE])).toBe(false);
  });

  it('gmail send accepts send, modify, or full', () => {
    expect(hasGmailSendScope([GMAIL_SEND_SCOPE])).toBe(true);
    expect(hasGmailSendScope([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(hasGmailSendScope([GMAIL_FULL_SCOPE])).toBe(true);
    expect(hasGmailSendScope([GMAIL_READONLY_SCOPE])).toBe(false);
  });

  it('sheets write needs the full spreadsheets scope (readonly cannot mutate)', () => {
    expect(hasSheetsWriteScope([SHEETS_SCOPE])).toBe(true);
    expect(hasSheetsWriteScope([SHEETS_READONLY_SCOPE])).toBe(false);
  });
});
