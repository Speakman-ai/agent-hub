import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the Content tree without a native runtime (mobile test env is `node`, no RN
// testing-library). Matches the PromoteTodoModal test pattern.
import { vi } from 'vitest';
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

import { LinkTodoModalContent } from './LinkTodoModal';
import {
  agentsForProject,
  buildLinkPayload,
  canSubmitLink,
  filterLinkOptions,
  normalizeLinkOptions,
} from '@shared/utils/linkTodo';

const noop = () => undefined;

function render(over: Partial<React.ComponentProps<typeof LinkTodoModalContent>> = {}) {
  return renderToStaticMarkup(
    <LinkTodoModalContent
      todoTitle="Buy milk"
      targetType="card"
      onSelectType={noop}
      projects={[
        { id: 'proj-a', name: 'Project A' },
        { id: 'proj-b', name: 'Project B' },
      ]}
      projectId="proj-a"
      onSelectProject={noop}
      agents={[{ id: 'agent-1', name: 'Dev' }]}
      agentId=""
      onSelectAgent={noop}
      options={[
        { id: 'card-1', name: 'Fix login' },
        { id: 'card-2', name: 'Add dashboard' },
      ]}
      targetId=""
      onSelectTarget={noop}
      filter=""
      onChangeFilter={noop}
      loadingProjects={false}
      loadingList={false}
      submitting={false}
      done={false}
      error={null}
      canSubmit={false}
      onSubmit={noop}
      onClose={noop}
      {...over}
    />,
  );
}

// The picker's pure logic — the shared source of truth for web + mobile parity.
// Tested here too so a mobile regression fails loudly (mobile CI runs this file;
// shared/*.test.ts is not in the mobile matrix).
describe('linkTodo helpers (mobile parity)', () => {
  it('normalizes card options by title and epic/session by name', () => {
    expect(normalizeLinkOptions([{ id: 1, title: 'Card' }], ['title', 'name'])).toEqual([
      { id: '1', name: 'Card' },
    ]);
    expect(normalizeLinkOptions([{ id: 's1', name: 'Sess' }], ['name'])).toEqual([
      { id: 's1', name: 'Sess' },
    ]);
  });

  it('scopes agents to the selected project', () => {
    const agents = [
      { id: 'a1', name: 'Dev', projectId: 'p1' },
      { id: 'a2', name: 'Docs', projectId: 'p2' },
    ];
    expect(agentsForProject(agents, 'p1')).toEqual([{ id: 'a1', name: 'Dev' }]);
  });

  it('builds a card payload with projectId and a session payload without', () => {
    expect(buildLinkPayload({ targetType: 'card', targetId: 'c1', projectId: 'p1' })).toEqual({
      targetType: 'card',
      targetId: 'c1',
      projectId: 'p1',
    });
    expect(buildLinkPayload({ targetType: 'session', targetId: 's1', projectId: 'p1' })).toEqual({
      targetType: 'session',
      targetId: 's1',
    });
  });

  it('gates submit: card needs a project, session does not', () => {
    const base = { submitting: false, loading: false };
    expect(canSubmitLink({ ...base, targetType: 'card', targetId: 'c1', projectId: '' })).toBe(
      false,
    );
    expect(canSubmitLink({ ...base, targetType: 'session', targetId: 's1' })).toBe(true);
  });

  it('filters options by name', () => {
    expect(
      filterLinkOptions(
        [
          { id: '1', name: 'Fix bug' },
          { id: '2', name: 'Add UI' },
        ],
        'bug',
      ),
    ).toEqual([{ id: '1', name: 'Fix bug' }]);
  });
});

describe('LinkTodoModalContent', () => {
  it('renders the card/epic/session type toggle and the todo title', () => {
    const html = render();
    expect(html).toContain('Link to existing');
    expect(html).toContain('Buy milk');
    expect(html).toContain('link-type-card');
    expect(html).toContain('link-type-epic');
    expect(html).toContain('link-type-session');
  });

  it('renders board card options for a card target', () => {
    const html = render({ targetType: 'card' });
    expect(html).toContain('link-option-card-1');
    expect(html).toContain('Fix login');
    // No agent selector for a card target.
    expect(html).not.toContain('link-agent-agent-1');
  });

  it('shows an agent selector for a session target', () => {
    const html = render({ targetType: 'session', options: [] });
    expect(html).toContain('link-agent-agent-1');
    // Empty option list prompts to pick an agent first.
    expect(html).toContain('Pick an agent first');
  });

  it('prompts for sessions once an agent is chosen but none exist', () => {
    const html = render({ targetType: 'session', agentId: 'agent-1', options: [] });
    expect(html).toContain('No sessions for this agent');
  });

  it('shows a loading state while the option list loads', () => {
    const html = render({ loadingList: true, options: [] });
    expect(html).toContain('link-loading-list');
  });
});
