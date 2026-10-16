import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

import CalendarMonthView from './CalendarMonthView';

const noop = () => undefined;

describe('CalendarMonthView (mobile)', () => {
  it('renders a six-week grid with events on their days', () => {
    const html = renderToStaticMarkup(
      <CalendarMonthView
        month={new Date(2026, 9, 1)}
        events={[
          {
            id: 'a',
            summary: 'Standup',
            start: { dateTime: new Date(2026, 9, 5, 9).toISOString() },
          },
          {
            id: 'b',
            summary: 'Launch',
            start: { date: '2026-10-05' },
            end: { date: '2026-10-06' },
          },
          {
            id: 'c',
            summary: 'Retro',
            start: { dateTime: new Date(2026, 9, 5, 15).toISOString() },
          },
        ]}
        onPrev={noop}
        onNext={noop}
        onToday={noop}
        onSelectEvent={noop}
      />,
    );

    expect(html).toContain('October 2026');
    expect(html.match(/testID="calendar-day-/g)).toHaveLength(42);
    const oct5 = html
      .split('testID="calendar-day-2026-10-05"')[1]
      .split('testID="calendar-day-')[0];
    // All-day events sort first (local midnight); two chips then an overflow count.
    expect(oct5).toContain('Launch');
    expect(oct5).toContain('Standup');
    expect(oct5).not.toContain('Retro');
    expect(oct5).toContain('+1');
  });

  it('shows a month-specific error with a retry action', () => {
    const html = renderToStaticMarkup(
      <CalendarMonthView
        month={new Date(2026, 9, 1)}
        events={[]}
        error="Google Calendar unavailable"
        onRetry={noop}
        onPrev={noop}
        onNext={noop}
        onToday={noop}
        onSelectEvent={noop}
      />,
    );

    expect(html).toContain('accessibilityRole="alert"');
    expect(html).toContain('October 2026: Google Calendar unavailable');
    expect(html).toContain('Retry');
  });
});
