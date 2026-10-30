import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: 'FlatList',
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));
vi.mock('../components/CalendarMonthView', () => ({ default: () => null }));
vi.mock('../components/CaptureToTicketModal', () => ({ default: () => null }));

const api = vi.hoisted(() => ({
  getGoogleStatus: vi.fn(),
  listGoogleCalendars: vi.fn(),
  listGoogleCalendarEvents: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const {
  default: CalendarScreen,
  CALENDAR_EVENTS_SCOPE,
  MONTH_MAX_RESULTS,
} = await import('./CalendarScreen');
process.env.NODE_ENV = originalNodeEnv;

const flush = () => act(async () => {});
const texts = (r: any): string =>
  r.root
    .findAll((n: any) => n.type === 'Text')
    .map((n: any) => [n.props.children].flat().join(''))
    .join('\n');

let mounted: any = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe('CalendarScreen view switching', () => {
  it('finishes loading when the view changes while the first events read is pending', async () => {
    api.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [CALENDAR_EVENTS_SCOPE],
      serverConfigured: true,
    });
    api.listGoogleCalendars.mockResolvedValue(undefined);
    let releaseFirst!: (v: any) => void;
    let listReads = 0;
    api.listGoogleCalendarEvents.mockImplementation((params: any) => {
      if (params.maxResults === MONTH_MAX_RESULTS) return Promise.resolve({ events: [] });
      listReads += 1;
      if (listReads === 1) return new Promise((r) => (releaseFirst = r));
      return Promise.resolve({
        events: [{ id: 'd', summary: 'Dentist', start: { dateTime: '2026-10-16T17:00:00Z' } }],
      });
    });

    await act(async () => {
      mounted = TestRenderer.create(React.createElement(CalendarScreen, { navigation: {} }));
    });
    await flush();
    expect(listReads).toBe(1);

    const day = mounted.root.find(
      (n: any) => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Day',
    );
    await act(async () => day.props.onPress());
    await flush();

    expect(texts(mounted)).not.toContain('Loading Calendar...');
    expect(mounted.root.findByType('FlatList').props.data.map((e: any) => e.summary)).toEqual([
      'Dentist',
    ]);

    // The superseded week read lands late and must not replace the day list.
    await act(async () => {
      releaseFirst({
        events: [{ id: 'w', summary: 'Stale week', start: { dateTime: '2026-10-12T17:00:00Z' } }],
      });
    });
    await flush();
    expect(mounted.root.findByType('FlatList').props.data.map((e: any) => e.summary)).toEqual([
      'Dentist',
    ]);
  });
});
