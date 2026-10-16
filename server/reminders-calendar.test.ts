/**
 * The real reminder calendar resolver: mirroring writes events, so a
 * connection without a primary-calendar write scope is skipped up front
 * instead of retrying a 403 forever. No network: the connection store is
 * mocked and no Google call is made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const status = { connected: true, grantedScopes: [] as string[] };
vi.mock('./google-connections-store.js', () => ({
  getGoogleConnectionStatus: () => status,
  getActiveAccessToken: vi.fn(async () => 'token'),
}));

const { resolveReminderCalendarClient } = await import('./reminders-calendar.js');
const OAUTH = { clientId: 'id', clientSecret: 'secret' } as never;

beforeEach(() => {
  status.connected = true;
  status.grantedScopes = [];
});

describe('resolveReminderCalendarClient', () => {
  it('skips a read-only calendar connection', async () => {
    for (const scope of [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      // Only covers secondary calendars the app created, not primary.
      'https://www.googleapis.com/auth/calendar.app.created',
    ]) {
      status.grantedScopes = ['openid', scope];
      expect(await resolveReminderCalendarClient('u1', OAUTH), scope).toEqual({
        skip: 'Google Calendar write access has not been granted',
      });
    }
  });

  it('returns a client for each scope that can write the primary calendar', async () => {
    for (const scope of [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ]) {
      status.grantedScopes = [scope];
      const client = await resolveReminderCalendarClient('u1', OAUTH);
      expect('skip' in client, scope).toBe(false);
    }
  });

  it('skips when Google is not connected or not configured', async () => {
    status.connected = false;
    expect(await resolveReminderCalendarClient('u1', OAUTH)).toEqual({
      skip: 'Google account is not connected',
    });
    expect(await resolveReminderCalendarClient('u1', null)).toEqual({
      skip: 'Google is not configured on this server',
    });
  });
});
