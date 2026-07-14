import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain string-tag hosts so renderToStaticMarkup can
// serialize the tree without a native runtime (same approach as
// TodosScreen.test.tsx / CalendarScreen.test.tsx).
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    TouchableOpacity: 'TouchableOpacity',
    ScrollView: 'ScrollView',
    StyleSheet: {
        create: (styles: any) => styles,
        hairlineWidth: 1,
    },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../utils/api', () => ({ api: {} }));

const authMock = vi.hoisted(() => ({ role: 'Admin' as string | null }));
vi.mock('../utils/auth', () => ({
    hasRole: () => authMock.role === 'Admin' || authMock.role === 'Owner',
    getUserRole: () => authMock.role,
}));

import { PendingLessonsSection } from './SkillsScreen';

const IMPROVEMENT = {
    id: 'imp-1',
    skillId: 'kanban',
    skillName: 'Kanban',
    source: 'project',
    entry: 'Always resolve column ids before moving cards.',
    status: 'pending',
    createdAt: '2026-07-13T14:02:00Z',
    sessionId: 'sess-42',
    agentId: 'hub-dev',
};

describe('SkillsScreen — PendingLessonsSection mobile parity', () => {
    it('renders entry text, provenance, WYSIWYG bullet preview, and review buttons for Admin', () => {
        authMock.role = 'Admin';
        const html = renderToStaticMarkup(
            <PendingLessonsSection
                projectId="agent-hub"
                improvements={[IMPROVEMENT]}
                onReviewed={() => {}}
                onOpenSession={() => {}}
            />,
        );
        expect(html).toContain('Pending lessons (1)');
        expect(html).toContain('Always resolve column ids before moving cards.');
        expect(html).toContain('hub-dev');
        expect(html).toContain('view source session');
        expect(html).toContain('Will append as (date stamped at approval):');
        expect(html).toContain('✓ Approve');
        expect(html).toContain('✕ Reject');
    });

    it('hides review buttons below Admin and shows the operator note', () => {
        authMock.role = 'User';
        const html = renderToStaticMarkup(
            <PendingLessonsSection
                projectId="agent-hub"
                improvements={[IMPROVEMENT]}
                onReviewed={() => {}}
            />,
        );
        expect(html).toContain('Always resolve column ids before moving cards.');
        expect(html).not.toContain('✓ Approve');
        expect(html).toContain('Approving requires the Admin role.');
    });

    it('renders nothing when the queue is empty', () => {
        authMock.role = 'Admin';
        const html = renderToStaticMarkup(
            <PendingLessonsSection projectId="agent-hub" improvements={[]} onReviewed={() => {}} />,
        );
        expect(html).toBe('');
    });
});
