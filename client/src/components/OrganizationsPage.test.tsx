import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  scope: 'server-a',
  organizations: [] as any[],
  links: {} as Record<string, string[]>,
  members: {} as Record<string, any[]>,
  failure: '',
  deferred: null as null | (() => Promise<any>),
  overviews: [] as string[],
}));
const request = vi.hoisted(() =>
  vi.fn(async (path: string, options: any = {}) => {
    if (fixture.failure) {
      const message = fixture.failure;
      fixture.failure = '';
      throw new Error(message);
    }
    if (path === '/organizations/project-choices')
      return {
        projects: [
          { id: 'p', name: 'Shared project' },
          { id: 'independent', name: 'Independent project' },
        ],
      };
    if (path === '/chat/members')
      return {
        members: [
          { userId: 'owner', username: 'Owner' },
          { userId: 'alice', username: 'Alice' },
        ],
      };
    if (path === '/organizations') {
      if (options.method === 'POST') {
        const organization = {
          id: `o${fixture.organizations.length + 1}`,
          name: JSON.parse(options.body).name,
          serverId: fixture.scope,
          canManage: true,
          role: 'Owner',
        };
        fixture.organizations.push(organization);
        fixture.links[organization.id] = [];
        fixture.members[organization.id] = [{ userId: 'owner', username: 'Owner', role: 'Owner' }];
        return { organization };
      }
      if (fixture.deferred) return fixture.deferred();
      return { organizations: [...fixture.organizations] };
    }
    const [, , id, resource, target] = path.split('/');
    if (!resource) {
      if (options.method === 'PATCH')
        fixture.organizations = fixture.organizations.map((o) =>
          o.id === id ? { ...o, name: JSON.parse(options.body).name } : o,
        );
      if (options.method === 'DELETE')
        fixture.organizations = fixture.organizations.filter((o) => o.id !== id);
      return { ok: true };
    }
    if (resource === 'members') {
      if (target && options.method === 'PUT')
        fixture.members[id] = [
          ...fixture.members[id].filter((m) => m.userId !== target),
          {
            userId: target,
            username: target === 'alice' ? 'Alice' : 'Owner',
            role: JSON.parse(options.body).role,
          },
        ];
      if (target && options.method === 'DELETE')
        fixture.members[id] = fixture.members[id].filter((m) => m.userId !== target);
      return { members: fixture.members[id] || [] };
    }
    if (resource === 'projects') {
      if (target && options.method === 'PUT')
        fixture.links[id] = [...new Set([...fixture.links[id], target])];
      if (target && options.method === 'DELETE')
        fixture.links[id] = fixture.links[id].filter((p) => p !== target);
      return {
        projects: (fixture.links[id] || []).map((id) => ({
          id,
          name: id === 'p' ? 'Shared project' : 'Independent project',
        })),
      };
    }
    throw new Error(`Unexpected ${path}`);
  }),
);
vi.mock('../utils/api', async () => {
  const { createOrganizationApi } = await import('@shared/utils/organizations');
  return {
    api: {
      organizations: createOrganizationApi(request),
      organizationAgents: {
        list: async () => ({ agents: [] }),
        templates: async () => ({ templates: [] }),
        chats: async () => ({ sessions: [] }),
      },
      organizationPortfolio: {
        overview: async (id: string) => {
          fixture.overviews.push(id);
          return {
            nextOffset: null,
            retrievedAt: null,
            projects: [
              {
                id: 'p',
                name: 'Shared project',
                source: { projectName: 'Shared project', record: 'project:p' },
                timestamp: null,
                agents: [],
                agentCount: 0,
                agentsTruncated: false,
                board: { columns: [], openCards: 0, totalCards: 0, epics: 0, phases: 0 },
                wiki: { pages: 0, updatedAt: null },
                sessions: { own: 0, updatedAt: null },
              },
            ],
          };
        },
        dispatches: async () => ({ dispatches: [], nextOffset: null }),
        dispatch: async () => ({}),
      },
      getModelConfig: async () => ({}),
    },
  };
});
vi.mock('../utils/orgs', () => ({ getActiveOrg: () => ({ id: fixture.scope }) }));
vi.mock('../utils/auth', () => ({ getAuthRecord: () => ({ user: { id: 'owner' } }) }));
vi.mock('../utils/connection', () => ({ getApiBase: () => fixture.scope }));

import Panel from './OrganizationsPage';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
async function render(projectId?: string) {
  flushSync(() => root.render(<Panel projectId={projectId} />));
  await flush();
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
}
async function click(label: string) {
  expect(button(label), label).toBeTruthy();
  button(label).click();
  await flush();
}
async function text(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}
async function check(label: string) {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) =>
      input.getAttribute('aria-label') === label || input.closest('label')?.textContent === label,
  )!;
  expect(input, label).toBeTruthy();
  input.click();
  await flush();
}
function seed(canManage = true) {
  fixture.organizations = [
    {
      id: 'o1',
      name: 'First',
      canManage,
      role: canManage ? 'Owner' : 'Member',
      serverId: 'server-a',
    },
    { id: 'o2', name: 'Second', canManage, role: 'Member', serverId: 'server-a' },
  ];
  fixture.links = { o1: ['p'], o2: ['p'] };
  fixture.members = { o1: [{ userId: 'owner', username: 'Owner', role: 'Owner' }], o2: [] };
}
beforeEach(() => {
  fixture.scope = 'server-a';
  fixture.organizations = [];
  fixture.links = {};
  fixture.members = {};
  fixture.failure = '';
  fixture.deferred = null;
  request.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('web/Electron organization flow', () => {
  it('creates explicitly, links one project to two organizations, and leaves independent projects alone', async () => {
    await render();
    expect(container.textContent).toContain('No organizations yet');
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    await text('New organization name', 'First');
    await click('Create organization');
    await check('Shared project');
    await click('Save project links');
    await text('New organization name', 'Second');
    await click('Create organization');
    await check('Shared project');
    await click('Save project links');
    expect(fixture.links).toEqual({ o1: ['p'], o2: ['p'] });
    await click('First');
    await check('Shared project');
    await click('Save project links');
    expect(fixture.links).toEqual({ o1: [], o2: ['p'] });
    expect(container.textContent).not.toContain('Secret project');
  });
  it('edits project-side memberships without deleting or moving the project', async () => {
    seed();
    await render('p');
    await check('First');
    await click('Save organization links');
    expect(fixture.links).toEqual({ o1: [], o2: ['p'] });
    await check('Second');
    await click('Save organization links');
    expect(fixture.links).toEqual({ o1: [], o2: [] });
    expect(request.mock.calls.every(([path]) => path.startsWith('/organizations'))).toBe(true);
  });
  it('renames, manages membership and confirms archive while preserving other links', async () => {
    seed();
    await render();
    await click('First');
    await text('Organization name', 'Renamed');
    await click('Save name');
    expect(fixture.organizations[0]).toMatchObject({ id: 'o1', name: 'Renamed' });
    const select = container.querySelector(
      'select[aria-label="Server member"]',
    ) as HTMLSelectElement;
    select.value = 'alice';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await click('Add member');
    expect(fixture.members.o1).toContainEqual({
      userId: 'alice',
      username: 'Alice',
      role: 'Member',
    });
    const role = container.querySelector(
      'select[aria-label="Role for Alice"]',
    ) as HTMLSelectElement;
    role.value = 'Admin';
    role.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(fixture.members.o1.find((m) => m.userId === 'alice').role).toBe('Admin');
    await click('Remove Alice');
    expect(fixture.members.o1.some((m) => m.userId === 'alice')).toBe(false);
    await click('Archive organization');
    expect(fixture.organizations).toHaveLength(2);
    await click('Confirm archive');
    expect(fixture.organizations.map((o) => o.id)).toEqual(['o2']);
    expect(fixture.links.o2).toEqual(['p']);
  });
  it('offers read-only membership and actionable retry errors', async () => {
    seed(false);
    await render();
    await click('First');
    expect(container.textContent).toContain('Read only');
    expect(button('Save project links')).toBeUndefined();
    expect(button('Archive organization')).toBeUndefined();
    fixture.failure = '403: Access changed';
    await click('Refresh organizations');
    expect(container.textContent).toContain('403: Access changed');
    expect(container.textContent).toContain('Refresh to retry');
    await click('Refresh organizations');
    expect(button('First')).toBeTruthy();
  });
  it('clears selection and ignores an old Server response after switching', async () => {
    seed();
    await render();
    await click('First');
    let resolve!: (value: any) => void;
    fixture.deferred = () =>
      new Promise((r) => {
        resolve = r;
      });
    button('Refresh organizations').click();
    await flush();
    fixture.scope = 'server-b';
    fixture.organizations = [];
    fixture.deferred = null;
    await render();
    expect(container.textContent).toContain('No organizations yet');
    resolve({ organizations: [{ id: 'old', name: 'Stale organization', canManage: true }] });
    await flush();
    expect(container.textContent).not.toContain('Stale organization');
    expect(button('First')).toBeUndefined();
  });

  it('selects a deep-linked organization and reports selection changes', async () => {
    seed();
    const onSelect = vi.fn();
    flushSync(() =>
      root.render(<Panel initialOrganizationId="o2" onSelectOrganization={onSelect} />),
    );
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('Second');
    expect(onSelect).toHaveBeenLastCalledWith('o2');
    await click('First');
    expect(onSelect).toHaveBeenLastCalledWith('o1');
  });

  it('shows the deep-linked organization portfolio and routes project drill-down', async () => {
    seed();
    fixture.overviews = [];
    const onOpenProject = vi.fn();
    flushSync(() =>
      root.render(<Panel initialOrganizationId="o2" onOpenProject={onOpenProject} />),
    );
    await flush();
    expect(fixture.overviews).toEqual(['o2']);
    expect(container.querySelector('[aria-label="Organization portfolio"]')).toBeTruthy();
    await click('Open Shared project');
    expect(onOpenProject).toHaveBeenCalledWith('p');
  });

  it('follows Back/Forward route changes while the page stays mounted', async () => {
    seed();
    // Stand-in for App: the route feeds the page and page selections write the route back.
    let setRoute!: (id: string | null) => void;
    function Routed() {
      const [route, set] = React.useState<string | null>('o2');
      setRoute = set;
      return <Panel initialOrganizationId={route} onSelectOrganization={set} />;
    }
    flushSync(() => root.render(<Routed />));
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('Second');
    await click('First');
    expect(container.querySelector('h3')?.textContent).toBe('First');
    flushSync(() => setRoute('o2')); // Back
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('Second');
    flushSync(() => setRoute('o1')); // Forward
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('First');
    flushSync(() => setRoute(null)); // Back to the plain list
    await flush();
    expect(container.querySelector('h3')).toBeNull();
  });

  it('keeps an initial deep link selected once App writes selections back to the route', async () => {
    seed();
    const reported: (string | null)[] = [];
    function Routed() {
      const [route, setRoute] = React.useState<string | null>('o2');
      return (
        <Panel
          initialOrganizationId={route}
          onSelectOrganization={(id) => {
            reported.push(id);
            setRoute(id);
          }}
        />
      );
    }
    flushSync(() => root.render(<Routed />));
    await flush();
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('Second');
    // The stale empty selection is never written back over the deep link.
    expect(reported).toEqual(['o2']);
    const settled = request.mock.calls.length;
    await flush();
    await flush();
    expect(request.mock.calls.length).toBe(settled);
    expect(container.querySelector('h3')?.textContent).toBe('Second');
  });

  it('clears the selection when the route names an unavailable organization', async () => {
    seed();
    const reported: (string | null)[] = [];
    let setRoute!: (id: string | null) => void;
    function Routed() {
      const [route, set] = React.useState<string | null>('o1');
      setRoute = set;
      return (
        <Panel
          initialOrganizationId={route}
          onSelectOrganization={(id) => {
            reported.push(id);
            set(id);
          }}
        />
      );
    }
    flushSync(() => root.render(<Routed />));
    await flush();
    expect(container.querySelector('h3')?.textContent).toBe('First');
    flushSync(() => setRoute('missing'));
    await flush();
    await flush();
    expect(container.querySelector('h3')).toBeNull();
    // App is told, so the URL stops naming the unavailable organization.
    expect(reported.at(-1)).toBeNull();
  });
});
