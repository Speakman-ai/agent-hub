// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrganizationDispatchMemoryForTests } from '@shared/utils/organization-portfolio';

const fixture = vi.hoisted(() => ({
  scope: 'server-a',
  dispatches: [] as any[],
  calls: [] as any[],
  overviewStatus: 0,
  hidden: [] as string[],
  // When set, every overview read waits here until the test releases it.
  slow: null as null | Array<() => void>,
  hold: null as null | Promise<void>,
  extraAgents: [] as any[],
  // Beta has this many agents; the overview lists at most 20 of them.
  betaAgents: 1,
  rosterFailures: 0,
  // A second dispatch page; the first page is filtered empty when olderOnly is set.
  older: [] as any[],
  olderOnly: false,
}));
const crew = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i === 0 ? 'beta-dev' : `beta-${i}`,
    name: i === 0 ? 'Beta Dev' : `Beta ${i}`,
    role: null,
  }));
const project = (id: string, name: string) => ({
  id,
  name,
  source: {
    serverId: 'server-a',
    organizationId: 'org',
    projectId: id,
    projectName: name,
    record: `project:${id}`,
  },
  timestamp: null,
  agents: [{ id: `${id}-dev`, name: `${name} Dev`, role: null }],
  agentCount: 1,
  agentsTruncated: false,
  board: { columns: [], openCards: 1, totalCards: 2, epics: 0, phases: 0 },
  wiki: { pages: 0, updatedAt: null },
  sessions: { own: 0, updatedAt: null },
});
const view = (patch: any) => ({
  requestId: 'r1',
  status: 'accepted',
  code: null,
  message: null,
  serverId: 'server-a',
  organizationId: 'org',
  organizationAgentId: 'assistant',
  initiatingSessionId: 'chat-1',
  projectId: 'beta',
  agentId: 'beta-dev',
  name: 'Task',
  sessionId: 'target-1',
  ref: null,
  sessionState: 'waiting_for_user_input',
  createdAt: '',
  updatedAt: '',
  acceptedAt: '',
  ...patch,
});

vi.mock('../utils/api', () => ({
  api: {
    organizationPortfolio: {
      overview: async () => {
        if (fixture.slow) {
          const queue = fixture.slow;
          await new Promise<void>((resolve) => queue.push(resolve));
        }
        if (fixture.overviewStatus)
          throw Object.assign(new Error('Organization not found'), {
            status: fixture.overviewStatus,
          });
        return {
          retrievedAt: null,
          offset: 0,
          nextOffset: null,
          projects: [
            project('alpha', 'Alpha'),
            {
              ...project('beta', 'Beta'),
              agents: crew(Math.min(fixture.betaAgents, 20)),
              agentCount: fixture.betaAgents,
              agentsTruncated: fixture.betaAgents > 20,
            },
          ].filter((p) => !fixture.hidden.includes(p.id)),
        };
      },
      projectAgents: async (_org: string, projectId: string, offset = 0) => {
        if (fixture.rosterFailures > 0) {
          fixture.rosterFailures--;
          throw new TypeError('Network request failed');
        }
        const all = projectId === 'beta' ? crew(fixture.betaAgents) : [];
        return {
          items: all.slice(offset, offset + 50),
          nextOffset: all.length > offset + 50 ? offset + 50 : null,
        };
      },
      dispatches: async (_org: string, offset = 0) => {
        if (offset > 0) return { dispatches: fixture.older, nextOffset: null };
        return {
          dispatches: fixture.olderOnly
            ? []
            : fixture.dispatches.filter((d) => !fixture.hidden.includes(d.projectId)),
          nextOffset: fixture.older.length ? 50 : null,
        };
      },
      dispatch: async (_org: string, sessionId: string, body: any) => {
        fixture.calls.push({ sessionId, body });
        if (fixture.hold) await fixture.hold;
        const result = view({
          name: body.prompt,
          projectId: body.projectId,
          agentId: body.agentId,
        });
        fixture.dispatches = [result];
        return result;
      },
    },
    organizationAgents: {
      list: async () => ({
        agents: [
          {
            id: 'assistant',
            name: 'Assistant',
            engine: 'claude-code',
            effectiveProjectIds: ['alpha', 'beta'],
            organizationScope: { enabled: true, projects: 'all-linked', tools: ['dispatch'] },
          },
          ...fixture.extraAgents,
        ],
      }),
      chats: async () => ({
        sessions: [
          {
            id: 'chat-1',
            name: 'Chat',
            agentId: 'assistant',
            agentName: 'Assistant',
            agentAvailable: true,
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
      startChat: async () => ({ session: { id: 'chat-new' } }),
    },
  },
}));
vi.mock('./HubChatRefs', () => ({ HubChatPlainTextWithRefs: () => null }));
function host(tag: string) {
  return ({ children, onPress, disabled, accessibilityLabel, accessibilityRole }: any) =>
    React.createElement(
      tag,
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, role: accessibilityRole },
      children,
    );
}
vi.mock('react-native', () => ({
  View: host('div'),
  Text: host('span'),
  TouchableOpacity: host('button'),
  TextInput: ({ accessibilityLabel, value, onChangeText }: any) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
  StyleSheet: { create: (styles: any) => styles },
}));

import Section from './OrganizationPortfolioSection';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const organization = { id: 'org', name: 'Group', canManage: false } as any;
const scope = () => fixture.scope;
async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
const press = async (label: string) => {
  const target = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  expect(target, label).toBeTruthy();
  target.click();
  await flush();
};
async function type(value: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

beforeEach(() => {
  resetOrganizationDispatchMemoryForTests();
  Object.assign(fixture, { scope: 'server-a', dispatches: [], calls: [], overviewStatus: 0 });
  fixture.hold = null;
  fixture.hidden = [];
  fixture.slow = null;
  fixture.extraAgents = [];
  fixture.betaAgents = 1;
  fixture.rosterFailures = 0;
  fixture.older = [];
  fixture.olderOnly = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('OrganizationPortfolioSection', () => {
  it('shows both linked projects and dispatches the chosen agent once', async () => {
    const onOpenProject = vi.fn();
    const onOpenSession = vi.fn();
    flushSync(() =>
      root.render(
        <Section
          organization={organization}
          scope={scope}
          onOpenProject={onOpenProject}
          onOpenSession={onOpenSession}
        />,
      ),
    );
    await flush();
    expect(container.textContent).toContain('Source: Alpha · project:alpha');
    expect(container.textContent).toContain('Source: Beta · project:beta');
    await press('Open Alpha');
    expect(onOpenProject).toHaveBeenCalledWith('alpha');

    await press('Project Beta');
    await press('Agent Beta Dev');
    await type('Write the changelog');
    let release!: () => void;
    fixture.hold = new Promise<void>((r) => (release = r));
    const dispatch = container.querySelector('button[aria-label="Dispatch"]') as HTMLButtonElement;
    dispatch.click();
    dispatch.click();
    await flush();
    release();
    await flush();
    expect(fixture.calls).toEqual([
      {
        sessionId: 'chat-1',
        body: {
          projectId: 'beta',
          agentId: 'beta-dev',
          prompt: 'Write the changelog',
          idempotencyKey: expect.stringMatching(/^ui-/),
        },
      },
    ]);
    const item = container.querySelector('[aria-label="Dispatch Write the changelog"]')!;
    expect(item.textContent).toContain('Completed');
    await press('Open target session');
    expect(onOpenSession).toHaveBeenCalledWith('beta-dev', 'target-1');
  });

  it('asks for a new source instead of switching when the chosen one leaves the roster', async () => {
    fixture.extraAgents = [
      {
        id: 'ops',
        name: 'Ops',
        engine: 'claude-code',
        effectiveProjectIds: ['alpha', 'beta'],
        organizationScope: { enabled: true, projects: 'all-linked', tools: ['dispatch'] },
      },
    ];
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    await press('From Ops');
    await press('Project Beta');
    await press('Agent Beta Dev');
    await type('Ship it');
    fixture.extraAgents = [];
    await press('Refresh portfolio');
    expect(container.textContent).toContain('no longer available to dispatch');
    const dispatch = container.querySelector('button[aria-label="Dispatch"]') as HTMLButtonElement;
    dispatch.click();
    await flush();
    expect(fixture.calls).toEqual([]);
  });

  it('offers every agent of a project whose overview list is capped', async () => {
    fixture.betaAgents = 25;
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    await press('Project Beta');
    await press('Agent Beta 24');
    await type('Ship it');
    await press('Dispatch');
    expect(fixture.calls[0].body).toMatchObject({ projectId: 'beta', agentId: 'beta-24' });
  });

  const hasAgent = (name: string) =>
    !!container.querySelector(`button[aria-label="Agent ${name}"]`);

  it('pages a large roster with Load more agents', async () => {
    fixture.betaAgents = 60;
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    await press('Project Beta');
    expect(hasAgent('Beta 49')).toBe(true);
    expect(hasAgent('Beta 59')).toBe(false);
    await press('Load more agents');
    expect(hasAgent('Beta 59')).toBe(true);
    expect(container.querySelector('button[aria-label="Load more agents"]')).toBeNull();
  });

  it('retries a failed roster request', async () => {
    fixture.betaAgents = 25;
    fixture.rosterFailures = 1;
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    await press('Project Beta');
    expect(container.textContent).toContain('Network request failed');
    expect(hasAgent('Beta 24')).toBe(false);
    await press('Retry loading agents');
    expect(hasAgent('Beta 24')).toBe(true);
  });

  it('loads older dispatch requests and names agents beyond the capped overview list', async () => {
    fixture.dispatches = [view({ projectId: 'beta', agentId: 'beta-dev', name: 'Recent' })];
    fixture.older = [
      view({
        requestId: 'r-old',
        projectId: 'beta',
        agentId: 'beta-40',
        agentName: 'Beta 40',
        name: 'Old task',
      }),
    ];
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    expect(container.textContent).not.toContain('Old task');
    await press('Load older requests');
    const item = container.querySelector('[aria-label="Dispatch Old task"]')!;
    expect(item.textContent).toContain('Beta · Beta 40');
    expect(container.querySelector('button[aria-label="Load older requests"]')).toBeNull();
  });

  it('shows older requests when the first page is filtered empty', async () => {
    fixture.olderOnly = true;
    fixture.older = [
      view({ requestId: 'r-old', projectId: 'beta', agentId: 'beta-dev', name: 'Old task' }),
    ];
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    expect(container.querySelector('[aria-label="Dispatch Old task"]')).toBeTruthy();
  });

  it('keeps the form locked and clears the task after a reload during a dispatch', async () => {
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    await press('Project Beta');
    await press('Agent Beta Dev');
    await type('Ship it');
    let release!: () => void;
    fixture.hold = new Promise<void>((r) => (release = r));
    await press('Dispatch');
    await press('Refresh portfolio');
    const dispatch = () =>
      container.querySelector('button[aria-label="Dispatch"]') as HTMLButtonElement;
    expect(dispatch().disabled).toBe(true);
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('Ship it');
    dispatch().click();
    await flush();
    release();
    await flush();
    expect(fixture.calls).toHaveLength(1);
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('shows a failed target without stranding the organization chat', async () => {
    const onOpenChat = vi.fn();
    fixture.dispatches = [
      view({ status: 'rejected', sessionId: null, message: 'Project not found', name: 'Gone' }),
    ];
    flushSync(() =>
      root.render(<Section organization={organization} scope={scope} onOpenChat={onOpenChat} />),
    );
    await flush();
    const item = container.querySelector('[aria-label="Dispatch Gone"]')!;
    expect(item.textContent).toContain('Failed');
    expect(item.textContent).toContain('Project not found');
    expect(container.querySelector('button[aria-label="Open target session"]')).toBeNull();
    await press('Open organization chat');
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org',
        // Without the name the chat's Computer owner reads "in this organization".
        organizationName: 'Group',
        agentId: 'assistant',
        sessionId: 'chat-1',
      }),
    );
  });

  it('applies a poll slower than the polling interval instead of superseding it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      flushSync(() => root.render(<Section organization={organization} scope={scope} />));
      await flush();
      expect(container.textContent).toContain('Source: Beta · project:beta');
      fixture.hidden = ['beta'];
      fixture.slow = [];
      // Every snapshot takes longer than the interval: three ticks pass before the first lands.
      vi.advanceTimersByTime(30000);
      await flush();
      vi.advanceTimersByTime(30000);
      await flush();
      vi.advanceTimersByTime(30000);
      await flush();
      expect(fixture.slow).toHaveLength(1);
      fixture.slow[0]();
      await flush();
      expect(container.textContent).not.toContain('Beta');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a project and its dispatches after access to it is lost, without a reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      fixture.dispatches = [
        {
          ...view({ projectId: 'beta', agentId: 'beta-dev', prompt: 'Beta work' }),
          name: 'Beta work',
          projectId: 'beta',
        },
      ];
      flushSync(() => root.render(<Section organization={organization} scope={scope} />));
      await flush();
      expect(container.textContent).toContain('Source: Beta · project:beta');
      expect(container.textContent).toContain('Beta work');
      // Beta is unlinked (or its ACL removed) while organization membership stays valid.
      fixture.hidden = ['beta'];
      vi.advanceTimersByTime(30000);
      await flush();
      expect(container.textContent).toContain('Source: Alpha · project:alpha');
      expect(container.textContent).not.toContain('Beta');
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes portfolio data when access is revoked', async () => {
    fixture.overviewStatus = 403;
    flushSync(() => root.render(<Section organization={organization} scope={scope} />));
    await flush();
    expect(container.textContent).toContain('Organization not found');
    expect(container.textContent).not.toContain('Alpha');
  });
});
