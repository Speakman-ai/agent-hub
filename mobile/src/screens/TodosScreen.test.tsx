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

    it('shows a Ticket badge when the todo is linked to a card', () => {
        const html = renderRow({
            id: '4',
            title: 'Linked',
            status: 'open',
            dueAt: null,
            linkedCardId: 'card-abc',
        });
        expect(html).toContain('Ticket');
    });

    it('renders save/cancel controls in edit mode', () => {
        const html = renderRow({ id: '5', title: 'Editing', status: 'open', dueAt: null }, { editing: true });
        expect(html).toContain('data-name="Check"');
        expect(html).toContain('data-name="X"');
    });
});
