import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the tree without a native runtime. Matches the LinkTodoModal test pattern.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
}));

import { LinkedTodosPanelContent } from './LinkedTodosPanel';
import { summarizeLinkedTodos, buildLinkedTodoTarget } from '@shared/utils/linkedTodos';

function todo(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Follow up on login bug',
    status: 'open',
    priority: 'high',
    doDate: null,
    dueAt: null,
    ...over,
  } as any;
}

describe('LinkedTodosPanelContent (mobile)', () => {
  it('renders the from-todos with a count header', () => {
    const html = renderToStaticMarkup(
      <LinkedTodosPanelContent
        todos={summarizeLinkedTodos([todo(), todo({ id: 't2', title: 'Write test' })])}
      />,
    );
    expect(html).toContain('linked-todos-panel');
    expect(html).toContain('From your todos (2)');
    expect(html).toContain('Follow up on login bug');
    expect(html).toContain('Write test');
  });

  it('renders nothing when there are no linked todos', () => {
    const html = renderToStaticMarkup(<LinkedTodosPanelContent todos={[]} />);
    expect(html).toBe('');
  });

  it('marks a done todo', () => {
    const html = renderToStaticMarkup(
      <LinkedTodosPanelContent todos={summarizeLinkedTodos([todo({ status: 'done' })])} />,
    );
    expect(html).toContain('✓');
  });
});

describe('buildLinkedTodoTarget (mobile parity)', () => {
  it('guards drafts and missing project ids the same as web', () => {
    expect(buildLinkedTodoTarget('card', { id: 'c1', __draft: true }, 'p')).toBeNull();
    expect(buildLinkedTodoTarget('epic', { id: 'e1' }, '')).toBeNull();
    expect(buildLinkedTodoTarget('card', { id: 'c1' }, 'p')).toEqual({
      targetType: 'card',
      targetId: 'c1',
      projectId: 'p',
    });
  });
});
