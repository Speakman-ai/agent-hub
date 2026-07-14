import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain string-tag hosts so renderToStaticMarkup can
// serialize the pane sub-trees without a native runtime (same approach as
// TodosScreen.test.tsx / CalendarScreen.test.tsx).
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ScrollView: 'ScrollView',
    RefreshControl: 'RefreshControl',
    Linking: { openURL: () => {} },
    StyleSheet: {
        create: (styles: any) => styles,
        hairlineWidth: 1,
    },
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/SidebarContext', () => ({ SidebarContext: React.createContext(null) }));
vi.mock('../context/AppContext', () => ({
    useApp: () => ({ projects: [], lastUserTodoEvent: null }),
}));
vi.mock('../utils/api', () => ({ api: {} }));
// Surface the icon name so assertions can find which glyph rendered.
vi.mock('../components/HubIcon', () => ({
    default: ({ name }: any) => <span data-name={name} />,
}));

import {
    WorkCardRow,
    TodoRow,
    CalendarRow,
    MailRow,
    GoogleGate,
    EmptyState,
} from './DashboardHomeScreen';

const noop = () => {};

describe('DashboardHomeScreen — aggregation render (mobile parity)', () => {
    it('renders an assigned work card with its priority, title, project and column', () => {
        const html = renderToStaticMarkup(
            <WorkCardRow
                card={{
                    id: 'c1',
                    title: 'Ship the dashboard',
                    priority: 'high',
                    projectName: 'Agent Hub',
                    columnName: 'In Progress',
                    prUrl: 'https://example.test/pr/1',
                }}
                onOpen={noop}
            />,
        );
        expect(html).toContain('Ship the dashboard');
        expect(html).toContain('high');
        expect(html).toContain('Agent Hub');
        expect(html).toContain('In Progress');
        // A linked PR surfaces the pull-request glyph.
        expect(html).toContain('data-name="GitPullRequest"');
    });

    it('renders a todo with a due badge from the aggregation payload', () => {
        const html = renderToStaticMarkup(
            <TodoRow todo={{ id: 't1', title: 'Water the plants', dueAt: null }} />,
        );
        expect(html).toContain('Water the plants');
        expect(html).toContain('data-name="Circle"');
    });

    it('renders a calendar event time and summary, with a Join link when hangout present', () => {
        const html = renderToStaticMarkup(
            <CalendarRow
                ev={{
                    id: 'e1',
                    summary: 'Standup',
                    allDay: false,
                    start: '2026-07-07T09:00:00.000Z',
                    hangoutLink: 'https://meet.test/abc',
                }}
            />,
        );
        expect(html).toContain('Standup');
        expect(html).toContain('Join');
    });

    it('renders an all-day event without a clock time', () => {
        const html = renderToStaticMarkup(
            <CalendarRow ev={{ id: 'e2', summary: 'Holiday', allDay: true, start: null }} />,
        );
        expect(html).toContain('All day');
        expect(html).toContain('Holiday');
    });

    it('renders a recent-mail row with sender and subject', () => {
        const html = renderToStaticMarkup(
            <MailRow
                msg={{
                    id: 'm1',
                    threadId: 'th1',
                    from: 'Jane Doe <jane@example.com>',
                    subject: 'Lunch tomorrow?',
                    snippet: 'Are you free…',
                    internalDate: '1783065600000',
                    date: 'Tue, 07 Jul 2026 08:00:00 +0000',
                    unread: true,
                }}
                onOpen={noop}
            />,
        );
        expect(html).toContain('Jane Doe');
        expect(html).toContain('Lunch tomorrow?');
        // Counter labels no longer appear.
        expect(html).not.toContain('Starred');
        expect(html).not.toContain('Important');
    });
});

describe('DashboardHomeScreen — Google pane gating (mobile parity)', () => {
    it('shows a Connect Google affordance when disconnected', () => {
        const html = renderToStaticMarkup(
            <GoogleGate state="connect" surface="Calendar" onConnect={noop} onOpenSurface={noop} />,
        );
        expect(html).toContain('Connect Google');
        expect(html).toContain('Connect your Google account');
    });

    it('shows an Enable <surface> affordance when a scope is missing', () => {
        const html = renderToStaticMarkup(
            <GoogleGate
                state="scope-required"
                surface="Gmail"
                onConnect={noop}
                onOpenSurface={noop}
            />,
        );
        expect(html).toContain('Enable Gmail');
    });

    it('shows a Reconnect affordance when the token is stale', () => {
        const html = renderToStaticMarkup(
            <GoogleGate state="reconnect" surface="Calendar" onConnect={noop} onOpenSurface={noop} />,
        );
        expect(html).toContain('Reconnect Google');
    });

    it('shows a not-configured notice with no action button', () => {
        const html = renderToStaticMarkup(
            <GoogleGate
                state="not-configured"
                surface="Calendar"
                onConnect={noop}
                onOpenSurface={noop}
            />,
        );
        // renderToStaticMarkup HTML-escapes the apostrophe, so match around it.
        expect(html).toContain('Google Workspace');
        expect(html).toContain('configured on this server');
        expect(html).not.toContain('Connect Google');
    });

    it('EmptyState renders its message', () => {
        const html = renderToStaticMarkup(<EmptyState text="No open cards assigned to you." />);
        expect(html).toContain('No open cards assigned to you.');
    });
});
