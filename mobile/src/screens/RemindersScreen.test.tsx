import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  RefreshControl: 'RefreshControl',
  Switch: 'Switch',
  Linking: { openURL: () => {} },
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    lastReminderEvent: null,
    setActiveAgentId: () => {},
    setActiveSessionId: () => {},
  }),
}));
vi.mock('../utils/api', () => ({
  api: { listReminders: () => new Promise(() => {}) },
}));
vi.mock('../components/HubIcon', () => ({
  default: ({ name }: any) => <span data-name={name} />,
}));

import RemindersScreen, { pickPreset, resolveRemindAt } from './RemindersScreen';
import { REMINDER_PRESETS } from '@shared/utils/reminders';

const preset = (id: string) => REMINDER_PRESETS.find((p) => p.id === id)!;

describe('RemindersScreen', () => {
  it('renders the add form with quick picks and the calendar toggle', () => {
    const html = renderToStaticMarkup(<RemindersScreen />);
    expect(html).toContain('reminder-new-title');
    expect(html).toContain('reminder-preset-tomorrow-9am');
    expect(html).toContain('Tomorrow 9 AM');
    expect(html).toContain('Add to Google Calendar');
  });

  it('keeps a picked preset at the moment it was tapped', () => {
    // "Tomorrow 9 AM" tapped at noon, Add tapped ten minutes later: still 9:00.
    const picked = pickPreset(preset('tomorrow-9am'), new Date(2026, 9, 16, 12, 0));
    expect(resolveRemindAt('', picked)).toBe(new Date(2026, 9, 17, 9, 0).toISOString());
    const tenMin = pickPreset(preset('10m'), new Date('2026-10-16T12:00:00.000Z'));
    expect(resolveRemindAt('', tenMin)).toBe('2026-10-16T12:10:00.000Z');
    expect(resolveRemindAt('', null)).toBeNull();
  });

  it('never falls back to the preset when typed text is not a real time', () => {
    const picked = pickPreset(preset('10m'), new Date('2026-10-16T12:00:00.000Z'));
    for (const bad of [
      '2026-10-17 09',
      'next week',
      '2026-10-17 25:00',
      '2026-10-17 09:75',
      '2027-02-30 09:00',
      '2026-13-01 09:00',
    ]) {
      expect(resolveRemindAt(bad, picked), bad).toBeNull();
    }
    expect(resolveRemindAt('2026-10-17 09:30', picked)).toBe(
      new Date(2026, 9, 17, 9, 30).toISOString(),
    );
  });
});
