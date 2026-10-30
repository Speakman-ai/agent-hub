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

import { calendarLoadWarning, withCalendarMeta } from '@shared/utils/googleCalendars';
import {
  buildCalendarEventInput,
  calendarReturnTo,
  CalendarAgendaContent,
  EventModal,
  eventCalendarId,
  loadCalendarEventsAcrossCalendars,
  loadCalendarSources,
  CALENDAR_EVENTS_SCOPE,
  openCalendarOAuth,
} from './CalendarScreen';

const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

describe('CalendarScreen mobile parity', () => {
  it('renders an agenda event with create and refresh controls', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        view="week"
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

  it('shows only the month grid by default and the list in week or day view', () => {
    const props = {
      loading: false,
      eventsLoading: false,
      error: null,
      status: {
        connected: true,
        grantedScopes: [CALENDAR_EVENTS_SCOPE],
        serverConfigured: true,
      },
      events: [],
      onRefresh: () => undefined,
      onConnect: () => undefined,
      onOpenSettings: () => undefined,
      onCreate: () => undefined,
      onEdit: () => undefined,
      monthView: <div>MONTH-GRID</div>,
      listLabel: 'Oct 25 to Oct 31, 2026',
    };
    const month = renderToStaticMarkup(<CalendarAgendaContent {...props} />);
    expect(month).toContain('MONTH-GRID');
    expect(month).not.toContain('No events this week');
    expect(month).toContain('Month');
    expect(month).toContain('Week');
    expect(month).toContain('Day');

    const week = renderToStaticMarkup(<CalendarAgendaContent {...props} view="week" />);
    expect(week).not.toContain('MONTH-GRID');
    expect(week).toContain('No events this week');
    expect(week).toContain('Oct 25 to Oct 31, 2026');
    expect(week).toContain('Previous week');

    const day = renderToStaticMarkup(<CalendarAgendaContent {...props} view="day" />);
    expect(day).toContain('No events this day');
    expect(day).toContain('Next day');
  });

  it('renders the not-linked route to connect Google', () => {
    const html = renderToStaticMarkup(
      <CalendarAgendaContent
        view="week"
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
        view="week"
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
      scopes: [CALENDAR_EVENTS_SCOPE, LIST_SCOPE],
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
      const apiClient = { listGoogleCalendarEvents, listGoogleCalendars: vi.fn() };
      const sources = await loadCalendarSources(apiClient, [MULTI.accounts[0], MULTI.accounts[1]]);
      // Neither account granted the list scope, so each reads its primary only.
      expect(apiClient.listGoogleCalendars).not.toHaveBeenCalled();
      const { events, failures } = await loadCalendarEventsAcrossCalendars(apiClient, sources, {
        timeMin: 'a',
        timeMax: 'b',
        maxResults: 10,
      });
      expect(listGoogleCalendarEvents).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: undefined }),
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
          view="week"
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
          view="week"
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

  describe('several calendars', () => {
    const ACCOUNT = {
      accountId: 'me',
      email: 'me@example.com',
      isDefault: true,
      grantedScopes: [CALENDAR_EVENTS_SCOPE, LIST_SCOPE],
    };
    const STATUS = {
      connected: true,
      email: 'me@example.com',
      grantedScopes: ACCOUNT.grantedScopes,
      serverConfigured: true,
      defaultAccountId: 'me',
      accounts: [ACCOUNT],
    };
    const CALENDARS = [
      {
        id: 'me@example.com',
        summary: 'Ryan',
        primary: true,
        selected: true,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
      },
      {
        id: 'spouse@gmail.com',
        summary: 'Sepideh',
        primary: false,
        selected: true,
        accessRole: 'reader',
        backgroundColor: '#16a765',
      },
      {
        id: 'holidays',
        summary: 'Holidays',
        primary: false,
        selected: false,
        accessRole: 'reader',
        backgroundColor: '#cccccc',
      },
    ];

    it('reads every listed calendar by id and tags its events', async () => {
      const listGoogleCalendarEvents = vi.fn(async (p: any) => ({
        events: [{ id: `${p.calendarId}-1`, summary: p.calendarId, start: { date: '2026-07-01' } }],
      }));
      const listGoogleCalendars = vi.fn().mockResolvedValue({ calendars: CALENDARS });
      const apiClient = { listGoogleCalendarEvents, listGoogleCalendars };

      const sources = await loadCalendarSources(apiClient, [ACCOUNT]);
      expect(listGoogleCalendars).toHaveBeenCalledWith({ account: 'me' });
      const { events } = await loadCalendarEventsAcrossCalendars(apiClient, sources, {
        timeMin: 'a',
        timeMax: 'b',
        maxResults: 10,
      });
      expect(listGoogleCalendarEvents).toHaveBeenCalledTimes(3);
      const hers = withCalendarMeta(events, sources).find(
        (e) => e.calendarId === 'spouse@gmail.com',
      );
      expect(hers).toMatchObject({
        calendarName: 'Sepideh',
        calendarColor: '#16a765',
        calendarWritable: false,
      });
      expect(eventCalendarId(hers)).toBe('spouse@gmail.com');
      expect(eventCalendarId({})).toBe('primary');
    });

    it('shows checked calendars, hides unchecked ones, and renders a chip per calendar', async () => {
      const sources = await loadCalendarSources(
        { listGoogleCalendars: vi.fn().mockResolvedValue({ calendars: CALENDARS }) },
        [ACCOUNT],
      );
      const events = [
        { id: '1', summary: 'My meeting', accountId: 'me', calendarId: 'me@example.com' },
        { id: '2', summary: 'Pure Barre', accountId: 'me', calendarId: 'spouse@gmail.com' },
        { id: '3', summary: 'Some holiday', accountId: 'me', calendarId: 'holidays' },
      ].map((e) => ({ ...e, start: { dateTime: '2026-07-01T10:00:00Z' } }));
      const render = (visibility = {}) =>
        renderToStaticMarkup(
          <CalendarAgendaContent
            view="week"
            loading={false}
            eventsLoading={false}
            error={null}
            status={STATUS}
            events={events}
            calendarSources={sources}
            calendarVisibility={visibility}
            onRefresh={() => undefined}
            onConnect={() => undefined}
            onOpenSettings={() => undefined}
            onCreate={() => undefined}
            onEdit={() => undefined}
            onCapture={() => undefined}
            onTicket={() => undefined}
          />,
        );

      const html = render();
      expect(html).toContain('Pure Barre');
      expect(html).toContain('My meeting');
      expect(html).not.toContain('Some holiday');
      expect(html).toContain('Show calendar Sepideh');
      expect(html).toContain('Show calendar Holidays');

      const flipped = render({ 'me|spouse@gmail.com': false, 'me|holidays': true });
      expect(flipped).not.toContain('Pure Barre');
      expect(flipped).toContain('Some holiday');
    });

    it('shows the sole remaining calendar even if it was hidden while there were two', async () => {
      const sources = await loadCalendarSources(
        { listGoogleCalendars: vi.fn().mockResolvedValue({ calendars: [CALENDARS[0]] }) },
        [ACCOUNT],
      );
      const html = renderToStaticMarkup(
        <CalendarAgendaContent
          view="week"
          loading={false}
          eventsLoading={false}
          error={null}
          status={STATUS}
          events={[
            {
              id: '1',
              summary: 'My meeting',
              accountId: 'me',
              calendarId: 'me@example.com',
              start: { dateTime: '2026-07-01T10:00:00Z' },
            },
          ]}
          calendarSources={sources}
          calendarVisibility={{ 'me|me@example.com': false }}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onCapture={() => undefined}
          onTicket={() => undefined}
        />,
      );
      expect(html).toContain('My meeting');
      expect(html).not.toContain('Show calendar');
      expect(html).not.toContain('All calendars hidden');
    });

    it('warns when the calendar list fails but the primary still loads', async () => {
      const sources = await loadCalendarSources(
        {
          listGoogleCalendars: vi
            .fn()
            .mockRejectedValue(new Error('Google Calendar rate limit exceeded')),
        },
        [ACCOUNT],
      );
      const { events, failures } = await loadCalendarEventsAcrossCalendars(
        {
          listGoogleCalendarEvents: vi.fn().mockResolvedValue({
            events: [{ id: '1', summary: 'My meeting', start: { date: '2026-07-01' } }],
          }),
        },
        sources,
        { timeMin: 'a', timeMax: 'b', maxResults: 10 },
      );
      const warning = calendarLoadWarning(sources, failures);
      expect(warning).toBe(
        "Couldn't list calendars for me@example.com (Google Calendar rate limit exceeded); showing its primary calendar only.",
      );
      const html = renderToStaticMarkup(
        <CalendarAgendaContent
          view="week"
          loading={false}
          eventsLoading={false}
          error={null}
          warning={warning}
          status={STATUS}
          events={events}
          calendarSources={sources}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onCapture={() => undefined}
          onTicket={() => undefined}
        />,
      );
      expect(html).toContain('My meeting');
      expect(html).toContain('showing its primary calendar only');
      expect(html).not.toContain('Show your other calendars');
    });

    it('lets writerWithoutPrivateAccess edit only non-private events', async () => {
      const sources = await loadCalendarSources(
        {
          listGoogleCalendars: vi.fn().mockResolvedValue({
            calendars: [{ ...CALENDARS[1], accessRole: 'writerWithoutPrivateAccess' }],
          }),
        },
        [ACCOUNT],
      );
      const { events } = await loadCalendarEventsAcrossCalendars(
        {
          listGoogleCalendarEvents: vi.fn().mockResolvedValue({
            events: [
              { id: 'open', summary: 'Open', visibility: 'default', start: { date: '2026-07-01' } },
              {
                id: 'secret',
                summary: 'Secret',
                visibility: 'private',
                start: { date: '2026-07-01' },
              },
            ],
          }),
        },
        sources,
        { timeMin: 'a', timeMax: 'b', maxResults: 10 },
      );
      expect(withCalendarMeta(events, sources).map((e) => [e.id, e.calendarWritable])).toEqual([
        ['open', true],
        ['secret', false],
      ]);
    });

    it('offers to list other calendars when the scope is missing', async () => {
      const account = { ...ACCOUNT, grantedScopes: [CALENDAR_EVENTS_SCOPE] };
      const sources = await loadCalendarSources({ listGoogleCalendars: vi.fn() }, [account]);
      const html = renderToStaticMarkup(
        <CalendarAgendaContent
          view="week"
          loading={false}
          eventsLoading={false}
          error={null}
          status={{ ...STATUS, grantedScopes: account.grantedScopes, accounts: [account] }}
          events={[]}
          calendarSources={sources}
          onRefresh={() => undefined}
          onConnect={() => undefined}
          onOpenSettings={() => undefined}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onCapture={() => undefined}
          onTicket={() => undefined}
        />,
      );
      expect(html).toContain('Show your other calendars');
    });

    it('opens events from read-only calendars without a Save button', () => {
      const html = renderToStaticMarkup(
        <EventModal
          event={{
            id: 'hers',
            summary: 'Pure Barre',
            accountId: 'me',
            accountEmail: 'me@example.com',
            calendarId: 'spouse@gmail.com',
            calendarName: 'Sepideh',
            calendarWritable: false,
            start: { dateTime: '2026-07-01T10:00:00Z' },
            end: { dateTime: '2026-07-01T11:00:00Z' },
          }}
          accounts={[ACCOUNT]}
          saving={false}
          error={null}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      );
      expect(html).toContain('Sepideh');
      expect(html).toContain('read-only');
      expect(html).toContain('Close');
      expect(html).not.toContain('>Save<');
    });
  });
});
