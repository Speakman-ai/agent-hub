/**
 * RemindersScreen mounted with react-test-renderer: live reminder events and
 * a slow list response must not undo each other.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReminderWire } from '@shared/utils/reminders';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  RefreshControl: 'RefreshControl',
  Switch: 'Switch',
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (s: any) => s },
}));
vi.mock('../components/HubIcon', () => ({ default: () => null }));

let respond: (v: { reminders: ReminderWire[] }) => void = () => {};
vi.mock('../utils/api', () => ({
  api: {
    listReminders: vi.fn(() => new Promise((r) => (respond = r))),
  },
}));

const listeners = new Set<(e: any) => void>();
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    setActiveAgentId: () => {},
    setActiveSessionId: () => {},
    subscribeReminderUpdates: (fn: (e: any) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  }),
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: RemindersScreen } = await import('./RemindersScreen');
process.env.NODE_ENV = originalNodeEnv;

function rem(over: Partial<ReminderWire>): ReminderWire {
  return {
    id: 'r',
    userId: 'u',
    title: 't',
    notes: '',
    remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'pending',
    createdBy: 'user',
    sessionId: null,
    agentId: null,
    projectId: null,
    calendar: { status: 'none', calendarId: null, eventId: null, eventUrl: null, error: null },
    firedAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
    ...over,
  };
}

const emit = (e: any) => listeners.forEach((fn) => fn(e));
const ids = (r: any) =>
  r.root
    .findAll(
      (n: any) => typeof n.props.testID === 'string' && n.props.testID.startsWith('reminder-row-'),
    )
    .map((n: any) => n.props.testID.replace('reminder-row-', ''));

describe('RemindersScreen (mounted)', () => {
  it('keeps live events that arrive while the list request is out', async () => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(RemindersScreen, {}));
    });
    // Two events in one batch, then the older list response.
    await act(async () => {
      emit({
        action: 'fired',
        reminderId: 'f',
        reminder: rem({ id: 'f', title: 'Fired', status: 'fired', revision: 2 }),
      });
      emit({ action: 'deleted', reminderId: 'd' });
    });
    await act(async () => {
      respond({
        reminders: [
          rem({ id: 'f', title: 'Fired', status: 'pending', revision: 1 }),
          rem({ id: 'd', title: 'Deleted' }),
          rem({ id: 'k', title: 'Kept' }),
        ],
      });
    });
    expect(ids(r).sort()).toEqual(['f', 'k']);
    // The fired reminder still offers its due actions.
    expect(r.root.findAll((n: any) => n.props.testID === 'reminder-dismiss-f')).not.toHaveLength(0);
    await act(async () => r.unmount());
    expect(listeners.size).toBe(0);
  });
});
