import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain string-tag hosts so renderToStaticMarkup can
// serialize the row without a native runtime (same approach as
// DashboardHomeScreen.test.tsx / CalendarScreen.test.tsx).
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  RefreshControl: 'RefreshControl',
  Linking: { openURL: () => {} },
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/SidebarContext', () => ({ SidebarContext: React.createContext(null) }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../components/HubIcon', () => ({ default: ({ name }: any) => <span data-name={name} /> }));
vi.mock('../components/SessionStateIcon', () => ({ default: () => <span /> }));
vi.mock('../components/CaptureToTicketModal', () => ({ default: () => <span /> }));

import { DashboardCalendarRow } from './DashboardScreen';

const EVENT = {
  id: 'event-1',
  summary: 'Planning',
  location: 'Room 4',
  start: { dateTime: '2026-07-01T17:00:00Z' },
  end: { dateTime: '2026-07-01T18:00:00Z' },
};

const noop = () => {};

describe('DashboardCalendarRow — This week capture buttons (mobile parity)', () => {
  it('renders the event with both Todo and Ticket capture affordances', () => {
    const html = renderToStaticMarkup(
      <DashboardCalendarRow
        event={EVENT}
        capturingId={null}
        capturedId={null}
        onOpen={noop}
        onCapture={noop}
        onTicket={noop}
      />,
    );
    expect(html).toContain('Planning');
    expect(html).toContain('Room 4');
    expect(html).toContain('+ Add to todos');
    expect(html).toContain('+ Ticket');
  });

  it('shows the added confirmation once the event was captured to todos', () => {
    const html = renderToStaticMarkup(
      <DashboardCalendarRow
        event={EVENT}
        capturingId={null}
        capturedId="event-1"
        onOpen={noop}
        onCapture={noop}
        onTicket={noop}
      />,
    );
    expect(html).toContain('✓ Added to todos');
    expect(html).not.toContain('+ Add to todos');
  });

  it('invokes the capture and ticket handlers with the event', () => {
    const onCapture = vi.fn();
    const onTicket = vi.fn();
    let capturePress: any;
    let ticketPress: any;
    // Walk the element tree to grab the two TouchableOpacity onPress handlers.
    const tree: any = (
      <DashboardCalendarRow
        event={EVENT}
        rowKey="event-1-0"
        capturingId={null}
        capturedId={null}
        onOpen={noop}
        onCapture={onCapture}
        onTicket={onTicket}
      />
    );
    const rendered = tree.type(tree.props);
    const captureRow = rendered.props.children[1];
    [capturePress, ticketPress] = captureRow.props.children.map((c: any) => c.props.onPress);

    capturePress();
    ticketPress();
    // Capture is invoked with the event plus the stable, index-folded row key so
    // same-titled id-less events don't share capture state.
    expect(onCapture).toHaveBeenCalledWith(EVENT, 'event-1-0');
    expect(onTicket).toHaveBeenCalledWith(EVENT);
  });

  it('uses the index-folded rowKey to drive the added/loading state', () => {
    // Same summary, no id, different rows: only the row whose rowKey matches
    // `capturedId` shows the confirmation.
    const idless = { summary: 'Standup', start: { dateTime: '2026-07-01T17:00:00Z' } };
    const captured = renderToStaticMarkup(
      <DashboardCalendarRow
        event={idless}
        rowKey="Standup-1"
        capturingId={null}
        capturedId="Standup-1"
        onOpen={noop}
        onCapture={noop}
        onTicket={noop}
      />,
    );
    expect(captured).toContain('✓ Added to todos');

    const other = renderToStaticMarkup(
      <DashboardCalendarRow
        event={idless}
        rowKey="Standup-0"
        capturingId={null}
        capturedId="Standup-1"
        onOpen={noop}
        onCapture={noop}
        onTicket={noop}
      />,
    );
    expect(other).not.toContain('✓ Added to todos');
    expect(other).toContain('+ Add to todos');
  });
});
