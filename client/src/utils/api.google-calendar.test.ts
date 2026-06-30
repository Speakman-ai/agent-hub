import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api Google Calendar helpers', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists events through the user-scoped Google proxy', async () => {
    await api.listGoogleCalendarEvents({
      timeMin: '2026-07-01T00:00:00Z',
      timeMax: '2026-07-08T00:00:00Z',
      timeZone: 'America/Los_Angeles',
      maxResults: 100,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(
      '/api/google/calendar/events?timeMin=2026-07-01T00%3A00%3A00Z&timeMax=2026-07-08T00%3A00%3A00Z&timeZone=America%2FLos_Angeles&maxResults=100',
    );
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('creates and updates events through the Calendar proxy', async () => {
    await api.createGoogleCalendarEvent({ calendarId: 'primary', event: { summary: 'One' } });
    await api.updateGoogleCalendarEvent('event/1', {
      calendarId: 'primary',
      event: { summary: 'Two' },
    });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/google/calendar/events');
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      calendarId: 'primary',
      event: { summary: 'One' },
    });
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/google/calendar/events/event%2F1');
    expect(fetchSpy.mock.calls[1][1].method).toBe('PATCH');
  });
});
