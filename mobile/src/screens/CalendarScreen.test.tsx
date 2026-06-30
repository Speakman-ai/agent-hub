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
});
