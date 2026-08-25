import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the Content tree without a native runtime (mobile test env is `node`, no RN
// testing-library). Matches the CalendarScreen / EnvironmentTriggersPanel pattern.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

import { PromoteTodoModalContent } from './PromoteTodoModal';
import {
  buildPromotePayload,
  canSubmitPromote,
  defaultPromoteOptionId,
  defaultPromotePriority,
  normalizePromoteOptions,
} from '@shared/utils/promoteTodo';

const noop = () => undefined;

function render(over: Partial<React.ComponentProps<typeof PromoteTodoModalContent>> = {}) {
  return renderToStaticMarkup(
    <PromoteTodoModalContent
      todoTitle="Ship the thing"
      projects={[
        { id: 'proj-a', name: 'Project A' },
        { id: 'proj-b', name: 'Project B' },
      ]}
      projectId="proj-a"
      onSelectProject={noop}
      columns={[
        { id: 'col-todo', name: 'To Do' },
        { id: 'col-doing', name: 'In Progress' },
      ]}
      columnId="col-todo"
      onSelectColumn={noop}
      epics={[{ id: 'epic-1', name: 'Q3 Launch' }]}
      epicId=""
      onSelectEpic={noop}
      priority="high"
      onSelectPriority={noop}
      loadingProjects={false}
      loadingBoard={false}
      submitting={false}
      done={false}
      error={null}
      canSubmit
      onSubmit={noop}
      onClose={noop}
      {...over}
    />,
  );
}

// The picker's pure logic — the shared source of truth for web + mobile parity.
// The write payload and defaults are tested here so a mobile regression fails
// loudly (mobile CI runs this file; shared/*.test.ts is not in the matrix).
describe('promoteTodo helpers', () => {
  it('normalizes board options and stringifies ids', () => {
    expect(normalizePromoteOptions([{ id: 1, name: 'To Do' }, null, 'x'])).toEqual([
      { id: '1', name: 'To Do' },
    ]);
    expect(normalizePromoteOptions(undefined)).toEqual([]);
  });

  it('defaults the column to the first lane and priority to the todo priority', () => {
    expect(
      defaultPromoteOptionId([
        { id: 'c1', name: 'To Do' },
        { id: 'c2', name: 'Doing' },
      ]),
    ).toBe('c1');
    expect(defaultPromoteOptionId([])).toBe('');
    expect(defaultPromotePriority({ priority: 'urgent' })).toBe('urgent');
    expect(defaultPromotePriority({ priority: null })).toBe('medium');
    expect(defaultPromotePriority({})).toBe('medium');
  });

  it('builds the promote payload, omitting a blank epic', () => {
    expect(
      buildPromotePayload({ projectId: 'p', columnId: 'c', priority: 'low', epicId: 'e1' }),
    ).toEqual({ projectId: 'p', columnId: 'c', priority: 'low', epicId: 'e1' });
    // No epic selected -> epicId omitted entirely (not sent as '').
    expect(
      buildPromotePayload({ projectId: 'p', columnId: 'c', priority: 'low', epicId: '' }),
    ).toEqual({ projectId: 'p', columnId: 'c', priority: 'low' });
    expect(
      buildPromotePayload({ projectId: 'p', columnId: 'c', priority: 'low' }),
    ).not.toHaveProperty('epicId');
  });

  it('gates submit on a chosen project + column and idle loading/submit state', () => {
    const base = { projectId: 'p', columnId: 'c', submitting: false, loadingBoard: false };
    expect(canSubmitPromote(base)).toBe(true);
    expect(canSubmitPromote({ ...base, projectId: '' })).toBe(false);
    expect(canSubmitPromote({ ...base, columnId: '' })).toBe(false);
    expect(canSubmitPromote({ ...base, submitting: true })).toBe(false);
    expect(canSubmitPromote({ ...base, loadingBoard: true })).toBe(false);
  });
});

describe('PromoteTodoModalContent (mobile)', () => {
  it('renders a spinner while projects load', () => {
    const html = render({ loadingProjects: true });
    expect(html).toContain('promote-loading-projects');
  });

  it('renders a spinner while the board loads', () => {
    const html = render({ loadingBoard: true });
    expect(html).toContain('promote-loading-board');
  });

  it('renders project, column, priority, and epic chips', () => {
    const html = render();
    expect(html).toContain('promote-project-proj-a');
    expect(html).toContain('promote-project-proj-b');
    expect(html).toContain('promote-column-col-todo');
    expect(html).toContain('promote-priority-high');
    expect(html).toContain('promote-epic-none');
    expect(html).toContain('promote-epic-epic-1');
    expect(html).toContain('Ship the thing');
  });

  it('omits the epic picker when the board has no epics', () => {
    const html = render({ epics: [] });
    expect(html).not.toContain('promote-epic-none');
  });

  it('surfaces a promote failure message', () => {
    const html = render({ error: 'boom' });
    expect(html).toContain('promote-error');
    expect(html).toContain('boom');
  });

  it('shows the promoting / promoted label on the submit button', () => {
    expect(render({ submitting: true })).toContain('Promoting');
    expect(render({ done: true })).toContain('Promoted');
    expect(render()).toContain('Promote');
  });
});
