import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));

import {
  buildCalendarEventInput,
  calendarReturnTo,
  CalendarAgendaContent,
  EventModal,
  loadCalendarEventsAcrossAccounts,
  CALENDAR_EVENTS_SCOPE,
  openCalendarOAuth,
} from './CalendarScreen';

describe('CalendarScreen mobile parity', () => {
  it('renders an agenda event with create and refresh controls', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        loading={false}
        eventsLoading={false}
        error={null}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
          serverConfigured: true,
        }}
        events={[
          {
            id: 'event-1',
            summary: 'Planning',
            location: 'Room 4',
            description: 'Prep roadmap',
            start: { dateTime: '2026-07-01T10:00:00Z' },
            end: { dateTime: '2026-07-01T11:00:00Z' },
          },
        ]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCreate={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('Agenda');
    expect(html).toContain('Refresh');
    expect(html).toContain('Create');
    expect(html).toContain('Planning');
    expect(html).toContain('Room 4');
  });

  it('renders the month view below the agenda empty state once Calendar is enabled', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        loading={false}
        eventsLoading={false}
        error={null}
        status={{
          connected: true,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
          serverConfigured: true,
        }}
        events={[]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCreate={() => undefined}
        onEdit={() => undefined}
        monthView={<div>MONTH-GRID</div>}
      />,
    );

    expect(html).toContain('No events this week');
    expect(html.indexOf('MONTH-GRID')).toBeGreaterThan(html.indexOf('No events this week'));
  });

  it('renders the not-linked route to connect Google', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        loading={false}
        eventsLoading={false}
        error={null}
        status={{ connected: false, grantedScopes: [], serverConfigured: true }}
        events={[]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCreate={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('Connect Google to use Calendar');
    expect(html).toContain('Connect Google');
  });

  it('renders the inline Enable Calendar affordance when connected but missing consent', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        loading={false}
        eventsLoading={false}
        error={null}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
          serverConfigured: true,
        }}
        events={[]}
        onRefresh={() => undefined}
        onConnect={() => undefined}
        onOpenSettings={() => undefined}
        onCreate={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('Enable Calendar access');
    expect(html).toContain('Enable Calendar');
  });

  it('builds Google Calendar local dateTimes with explicit timeZone', () => {
    expect(
      buildCalendarEventInput({
        summary: 'Planning',
        location: '',
        description: '',
        allDay: false,
        startDateTime: '2026-07-01T10:00',
        endDateTime: '2026-07-01T11:00',
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      summary: 'Planning',
      start: { dateTime: '2026-07-01T10:00:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-01T11:00:00', timeZone: 'America/Los_Angeles' },
    });
  });

  it('starts OAuth with the GLOBAL calendar hash route (no project segment)', async () => {
    // Regression (card 1287): Calendar is a per-user global surface, so the
    // OAuth returnTo is a bare `/#/calendar` with no projectId.
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    };
    const openURL = vi.fn().mockResolvedValue(true);

    await expect(openCalendarOAuth({ apiClient, openURL })).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    );

    expect(apiClient.startGoogleOAuth).toHaveBeenCalledWith({
      returnTo: '/#/calendar',
      scopes: [CALENDAR_EVENTS_SCOPE],
    });
    expect(openURL).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=abc');
    expect(calendarReturnTo()).toBe('/#/calendar');
  });

  describe('multiple Google accounts', () => {
    const MULTI = {
      connected: true,
      email: 'me@work.com',
      grantedScopes: [CALENDAR_EVENTS_SCOPE],
      serverConfigured: true,
      defaultAccountId: 'work',
      accounts: [
        {
          accountId: 'work',
          email: 'me@work.com',
          isDefault: true,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
        },
        {
          accountId: 'home',
          email: 'me@home.com',
          isDefault: false,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
        },
        { accountId: 'side', email: 'side@x.com', isDefault: false, grantedScopes: [] },
      ],
    };

    it('reads every account and merges events by start', async () => {
      const listGoogleCalendarEvents = vi.fn(async (p: any) => ({
        events:
          p.account === 'work'
            ? [{ id: 'w1', summary: 'Standup', start: { dateTime: '2026-07-01T15:00:00Z' } }]
            : [{ id: 'h1', summary: 'Dentist', start: { dateTime: '2026-07-01T09:00:00Z' } }],
      }));
      const { events, failures } = await loadCalendarEventsAcrossAccounts(
        { listGoogleCalendarEvents },
        [MULTI.accounts[0], MULTI.accounts[1]],
        { timeMin: 'a', timeMax: 'b', maxResults: 10 },
      );
      expect(events.map((e) => [e.summary, e.accountEmail])).toEqual([
        ['Dentist', 'me@home.com'],
        ['Standup', 'me@work.com'],
      ]);
      expect(failures).toEqual([]);
    });

    const events = [
      {
        id: 'h1',
        summary: 'Dentist',
        accountId: 'home',
        accountEmail: 'me@home.com',
        start: { dateTime: '2026-07-01T09:00:00Z' },
      },
      {
        id: 'w1',
        summary: 'Standup',
        accountId: 'work',
        accountEmail: 'me@work.com',
        start: { dateTime: '2026-07-01T15:00:00Z' },
      },
    ];
    const render = (hiddenAccounts: string[] = []) =>
      renderToStaticMarkup(
        <CalendarAgendaContent
          loading={false}
          eventsLoading={false}
          error={null}
          status={MULTI}
          events={events}
          hiddenAccounts={hiddenAccounts}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onCapture={() => undefined}
          onTicket={() => undefined}
        />,
      );

    it('labels each event with its account and shows per-account toggles', () => {
      const html = render();
      expect(html).toContain('Dentist');
      expect(html).toContain('Standup');
      expect(html).toContain('Show me@home.com');
      // An account without Calendar access offers Enable instead of a toggle.
      expect(html).toContain('Enable Calendar for side@x.com');
    });

    it('ignores a stored hidden account once only one is linked', () => {
      const html = renderToStaticMarkup(
        <CalendarAgendaContent
          loading={false}
          eventsLoading={false}
          error={null}
          status={{ ...MULTI, accounts: [MULTI.accounts[1]] }}
          events={[events[0]]}
          hiddenAccounts={['home']}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onCapture={() => undefined}
          onTicket={() => undefined}
        />,
      );
      expect(html).toContain('Dentist');
      expect(html).not.toContain('All accounts hidden');
    });

    it('drops events from a hidden account', () => {
      const html = render(['home']);
      expect(html).not.toContain('Dentist');
      expect(html).toContain('Standup');
      expect(render(['home', 'work'])).toContain('All accounts hidden');
    });

    it('asks which account a new event goes to, marking the default', () => {
      const html = renderToStaticMarkup(
        <EventModal
          event={null}
          accounts={[{ ...MULTI.accounts[0] }, { ...MULTI.accounts[1] }]}
          saving={false}
          error={null}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      );
      expect(html).toContain('Create in me@work.com');
      expect(html).toContain('me@work.com (default)');
    });
  });
});
