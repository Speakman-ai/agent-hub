import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain string-tag hosts so renderToStaticMarkup can
// serialize the TodoRow tree without a native runtime (same approach as
// CalendarScreen.test.tsx).
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    TouchableOpacity: 'TouchableOpacity',
    ScrollView: 'ScrollView',
    RefreshControl: 'RefreshControl',
    StyleSheet: {
        create: (styles: any) => styles,
        hairlineWidth: 1,
    },
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ lastUserTodoEvent: null }) }));
vi.mock('../utils/api', () => ({ api: {} }));
// Surface the icon name so assertions can find which glyph rendered.
vi.mock('../components/HubIcon', () => ({
    default: ({ name }: any) => <span data-name={name} />,
}));

import { TodoRow } from './TodosScreen';

const noop = () => {};

function renderRow(todo: any, over: any = {}) {
    return renderToStaticMarkup(
        <TodoRow
            todo={todo}
            isFirst={over.isFirst ?? false}
            isLast={over.isLast ?? false}
            editing={over.editing ?? false}
            onStartEdit={noop}
            onCancelEdit={noop}
            onToggle={noop}
            onSave={noop}
            onDelete={noop}
            onUnlink={noop}
            onMoveUp={noop}
            onMoveDown={noop}
        />,
    );
}

describe('TodosScreen — TodoRow mobile parity', () => {
    it('renders an open todo with an unchecked circle and reorder/edit controls', () => {
        const html = renderRow({ id: '1', title: 'Write the report', status: 'open', dueAt: null });
        expect(html).toContain('Write the report');
        expect(html).toContain('data-name="Circle"');
        expect(html).toContain('data-name="ChevronUp"');
        expect(html).toContain('data-name="Pencil"');
        expect(html).toContain('data-name="Trash2"');
    });

    it('renders a done todo with a filled check and no reorder controls', () => {
        const html = renderRow({ id: '2', title: 'Ship it', status: 'done', dueAt: null });
        expect(html).toContain('data-name="CircleCheck"');
        // Done rows hide the up/down reorder affordances.
        expect(html).not.toContain('data-name="ChevronUp"');
        expect(html).not.toContain('data-name="Pencil"');
    });

    it('shows a due badge for a dated todo', () => {
        // A far-future date always classifies as "upcoming" regardless of clock.
        const html = renderRow({ id: '3', title: 'Renew', status: 'open', dueAt: '2099-01-15T00:00:00' });
        expect(html).toContain('todo-due-badge');
    });

    it('always shows a priority chip, defaulting to medium', () => {
        const html = renderRow({ id: 'p0', title: 'No priority', status: 'open', dueAt: null });
        expect(html).toContain('todo-priority');
        expect(html).toContain('medium');
    });

    it('renders the todo priority value on the chip', () => {
        const html = renderRow({
            id: 'p1',
            title: 'Urgent thing',
            status: 'open',
            dueAt: null,
            priority: 'urgent',
        });
        expect(html).toContain('todo-priority');
        expect(html).toContain('urgent');
    });

    it('prefers doDate over the deprecated dueAt for the due badge', () => {
        const html = renderRow({
            id: 'dd',
            title: 'Do date',
            status: 'open',
            doDate: '2099-01-15T00:00:00',
            dueAt: null,
        });
        expect(html).toContain('todo-due-badge');
    });

    it('appends a time window to the due badge when a window is set', () => {
        const html = renderRow({
            id: 'tw',
            title: 'Windowed',
            status: 'open',
            doDate: '2099-01-15T00:00:00',
            dueAt: null,
            doStartAt: '2099-01-15T14:00:00Z',
            doEndAt: '2099-01-15T15:30:00Z',
        });
        expect(html).toContain('todo-due-badge');
        // A start–end window renders an en dash between the two clock times.
        expect(html).toContain('–');
    });

    it('shows a Ticket badge when the todo is linked to a card', () => {
        const html = renderRow({
            id: '4',
            title: 'Linked',
            status: 'open',
            dueAt: null,
            linkedCardId: 'card-abc',
        });
        expect(html).toContain('todo-link-badge');
        expect(html).toContain('Ticket');
    });

    it('shows an Epic badge for a linkedType of epic', () => {
        const html = renderRow({
            id: 'ep',
            title: 'Epic link',
            status: 'open',
            dueAt: null,
            linkedType: 'epic',
        });
        expect(html).toContain('todo-link-badge');
        expect(html).toContain('Epic');
    });

    it('shows a Session badge for a linkedType of session', () => {
        const html = renderRow({
            id: 'se',
            title: 'Session link',
            status: 'open',
            dueAt: null,
            linkedType: 'session',
        });
        expect(html).toContain('todo-link-badge');
        expect(html).toContain('Session');
    });

    it('shows an unlink control on an open linked todo', () => {
        const html = renderRow({
            id: 'ul',
            title: 'Unlinkable',
            status: 'open',
            dueAt: null,
            linkedType: 'card',
            linkedId: 'card-1',
        });
        expect(html).toContain('todo-unlink');
    });

    it('hides the unlink control on a done linked todo', () => {
        const html = renderRow({
            id: 'uld',
            title: 'Done linked',
            status: 'done',
            dueAt: null,
            linkedType: 'card',
            linkedId: 'card-1',
        });
        expect(html).toContain('todo-link-badge');
        expect(html).not.toContain('todo-unlink');
    });

    it('renders save/cancel controls in edit mode', () => {
        const html = renderRow({ id: '5', title: 'Editing', status: 'open', dueAt: null }, { editing: true });
        expect(html).toContain('data-name="Check"');
        expect(html).toContain('data-name="X"');
    });
});
