import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  scope: 'server-a',
  dispatches: [] as any[],
  dispatchCalls: [] as any[],
  overviewStatus: 0,
  hidden: [] as string[],
  // When set, every overview read waits here until the test releases it.
  slow: null as null | Array<() => void>,
  hold: null as null | Promise<void>,
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
  timestamp: '2026-10-19T00:00:00.000Z',
  agents: [{ id: `${id}-dev`, name: `${name} Dev`, role: null }],
  agentCount: 1,
  agentsTruncated: false,
  board: { columns: [], openCards: 2, totalCards: 5, epics: 1, phases: 0 },
  wiki: { pages: 3, updatedAt: null },
  sessions: { own: 1, updatedAt: null },
});
const accepted = (body: any) => ({
  requestId: 'r1',
  status: 'accepted',
  code: null,
  message: null,
  serverId: 'server-a',
  organizationId: 'org',
  organizationAgentId: 'assistant',
  initiatingSessionId: 'chat-1',
  projectId: body.projectId,
  agentId: body.agentId,
  name: body.prompt,
  sessionId: 'target-1',
  ref: null,
  sessionState: 'working',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  acceptedAt: '2026-10-19T00:00:00.000Z',
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
          serverId: 'server-a',
          organizationId: 'org',
          retrievedAt: '2026-10-19T00:00:00.000Z',
          offset: 0,
          nextOffset: null,
          projects: [project('alpha', 'Alpha'), project('beta', 'Beta')].filter(
            (p) => !fixture.hidden.includes(p.id),
          ),
        };
      },
      dispatches: async () => ({
        dispatches: fixture.dispatches.filter((d) => !fixture.hidden.includes(d.projectId)),
        nextOffset: null,
      }),
      dispatch: async (_org: string, sessionId: string, body: any) => {
        fixture.dispatchCalls.push({ sessionId, body });
        if (fixture.hold) await fixture.hold;
        const view = accepted(body);
        fixture.dispatches = [view];
        return view;
      },
    },
    organizationAgents: {
      list: async () => ({
        agents: [
          {
            id: 'assistant',
            name: 'Assistant',
            engine: 'claude-code',
            isAssistant: true,
            effectiveProjectIds: ['alpha', 'beta'],
            organizationScope: {
              enabled: true,
              projects: 'all-linked',
              tools: ['projects:read', 'dispatch'],
            },
          },
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

import Panel from './OrganizationPortfolioPanel';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const organization = {
  id: 'org',
  name: 'Group',
  serverId: 'server-a',
  canManage: false,
  role: 'Member',
} as any;
async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
const scope = () => fixture.scope;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
function choose(label: string, value: string) {
  const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync(() => undefined);
}
function type(value: string) {
  const area = container.querySelector('textarea') as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync(() => undefined);
}

beforeEach(() => {
  fixture.scope = 'server-a';
  fixture.dispatches = [];
  fixture.dispatchCalls = [];
  fixture.overviewStatus = 0;
  fixture.hold = null;
  fixture.hidden = [];
  fixture.slow = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('OrganizationPortfolioPanel', () => {
  it('shows both linked projects with sources and opens one with the project view', async () => {
    const onOpenProject = vi.fn();
    flushSync(() =>
      root.render(
        <Panel organization={organization} scope={scope} onOpenProject={onOpenProject} />,
      ),
    );
    await flush();
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('Source: Alpha · project:alpha');
    expect(container.textContent).toContain('2 open of 5 cards');
    button('Open Beta').click();
    expect(onOpenProject).toHaveBeenCalledWith('beta');
  });

  it('dispatches the chosen agent once, shows its status and opens the target session', async () => {
    const onOpenSession = vi.fn();
    flushSync(() =>
      root.render(
        <Panel organization={organization} scope={scope} onOpenSession={onOpenSession} />,
      ),
    );
    await flush();
    choose('Target project', 'beta');
    choose('Target agent', 'beta-dev');
    type('Ship the release notes');
    let release!: () => void;
    fixture.hold = new Promise<void>((r) => (release = r));
    const submit = button('Dispatch');
    submit.click();
    await flush();
    // Double tap while the first request is in flight.
    expect(button('Dispatching…').disabled).toBe(true);
    (container.querySelector('form') as HTMLFormElement).requestSubmit();
    await flush();
    release();
    await flush();
    expect(fixture.dispatchCalls).toHaveLength(1);
    expect(fixture.dispatchCalls[0]).toMatchObject({
      sessionId: 'chat-1',
      body: { projectId: 'beta', agentId: 'beta-dev', prompt: 'Ship the release notes' },
    });
    const item = container.querySelector('li[aria-label="Dispatch Ship the release notes"]')!;
    expect(item.textContent).toContain('Running');
    expect(item.textContent).toContain('Beta · Beta Dev');
    button('Open target session').click();
    expect(onOpenSession).toHaveBeenCalledWith('beta-dev', 'target-1');
  });

  it('keeps the form locked and clears the task after a reload during a dispatch', async () => {
    flushSync(() => root.render(<Panel organization={organization} scope={scope} />));
    await flush();
    choose('Target project', 'beta');
    choose('Target agent', 'beta-dev');
    type('Ship it');
    let release!: () => void;
    fixture.hold = new Promise<void>((r) => (release = r));
    button('Dispatch').click();
    await flush();
    button('Refresh portfolio').click();
    await flush();
    // The form remounted after the reload: still locked, task still shown.
    expect(button('Dispatching…').disabled).toBe(true);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Ship it');
    (container.querySelector('form') as HTMLFormElement).requestSubmit();
    await flush();
    release();
    await flush();
    expect(fixture.dispatchCalls).toHaveLength(1);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(button('Dispatch').disabled).toBe(true);
  });

  it('shows failed and pending requests without blocking the organization chat', async () => {
    const onOpenChat = vi.fn();
    fixture.dispatches = [
      {
        ...accepted({ projectId: 'alpha', agentId: 'alpha-dev', prompt: 'Broken' }),
        requestId: 'r-fail',
        status: 'failed',
        sessionId: null,
        message: 'Agent "alpha-dev" is disabled',
      },
      {
        ...accepted({ projectId: 'alpha', agentId: 'alpha-dev', prompt: 'Later' }),
        requestId: 'r-queued',
        status: 'queued',
        sessionId: null,
      },
    ];
    flushSync(() =>
      root.render(<Panel organization={organization} scope={scope} onOpenChat={onOpenChat} />),
    );
    await flush();
    const failed = container.querySelector('li[aria-label="Dispatch Broken"]')!;
    expect(failed.textContent).toContain('Failed');
    expect(failed.textContent).toContain('Agent "alpha-dev" is disabled');
    expect(failed.textContent).not.toContain('Open target session');
    expect(container.querySelector('li[aria-label="Dispatch Later"]')!.textContent).toContain(
      'Pending',
    );
    (
      [...failed.querySelectorAll('button')].find(
        (b) => b.textContent === 'Open organization chat',
      ) as HTMLButtonElement
    ).click();
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org', agentId: 'assistant', sessionId: 'chat-1' }),
    );
  });

  it('applies a poll slower than the polling interval instead of superseding it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      flushSync(() => root.render(<Panel organization={organization} scope={scope} />));
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
          ...accepted({ projectId: 'beta', agentId: 'beta-dev', prompt: 'Beta work' }),
          name: 'Beta work',
          projectId: 'beta',
        },
      ];
      flushSync(() => root.render(<Panel organization={organization} scope={scope} />));
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

  it('removes portfolio data when organization access is revoked', async () => {
    fixture.overviewStatus = 404;
    flushSync(() => root.render(<Panel organization={organization} scope={scope} />));
    await flush();
    expect(container.textContent).toContain('Organization not found');
    expect(container.textContent).not.toContain('Alpha');
  });

  it('hides the portfolio after a Server switch until it reloads for that Server', async () => {
    flushSync(() => root.render(<Panel organization={organization} scope={scope} />));
    await flush();
    expect(container.textContent).toContain('Alpha');
    fixture.scope = 'server-b';
    flushSync(() =>
      root.render(<Panel organization={organization} scope={scope} refreshKey={1} />),
    );
    expect(container.textContent).not.toContain('Source: Alpha');
  });
});
