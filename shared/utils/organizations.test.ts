import { describe, expect, it, vi } from 'vitest';
import { createOrganizationApi, OrganizationController } from './organizations';

const organization = (id: string, canManage = true) => ({
  id,
  name: id,
  serverId: 's',
  canManage,
  role: 'Owner' as const,
});
function setup() {
  let scope = 'server-a';
  const links: Record<string, string[]> = { one: ['p'], two: ['p'] };
  const request = vi.fn(async (path: string, options?: { method?: string }) => {
    if (path === '/organizations')
      return { organizations: [organization('one'), organization('two')] };
    if (path === '/organizations/project-choices')
      return {
        projects: [
          { id: 'p', name: 'Project' },
          { id: 'independent', name: 'Independent' },
          { id: 'hub', name: 'Hidden', kind: 'system' },
        ],
      };
    if (path === '/chat/members') return { members: [] };
    const [, , id, resource, project] = path.split('/');
    if (resource === 'members') return { members: [] };
    if (project && options?.method === 'DELETE') links[id] = links[id].filter((p) => p !== project);
    if (project && options?.method === 'PUT') links[id] = [...new Set([...links[id], project])];
    return { projects: (links[id] || []).map((id) => ({ id, name: id })) };
  });
  const controller = new OrganizationController(createOrganizationApi(request), () => scope);
  return {
    controller,
    request,
    links,
    switchServer: () => {
      scope = 'server-b';
    },
  };
}
describe('organization management state', () => {
  it('keeps independent projects and other organization links when removing one membership', async () => {
    const { controller, links } = setup();
    await controller.load();
    expect(controller.state.projects.map((p) => p.id)).toEqual(['p', 'independent']);
    await controller.saveProjectOrganizations('p', ['two']);
    expect(links).toEqual({ one: [], two: ['p'] });
  });
  it('drops late loads and selection after changing Servers', async () => {
    const { controller, request, switchServer } = setup();
    await controller.load('one');
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as never,
    );
    const loading = controller.load('one');
    switchServer();
    resolve({ organizations: [organization('stale')] });
    await loading;
    expect(controller.snapshot().organizations).toEqual([]);
    expect(controller.snapshot().selectedId).toBeNull();
  });
  it('does not continue a multi-project save or refresh on the new Server', async () => {
    const { controller, request, switchServer } = setup();
    await controller.load('one');
    request.mockImplementationOnce(async () => {
      switchServer();
      return { ok: true } as never;
    });
    const count = request.mock.calls.length;
    await controller.saveProjects(['independent']);
    expect(request.mock.calls.length - count).toBe(1);
    expect(controller.snapshot().selectedId).toBeNull();
  });
  it('exposes failures and reloads canonical links after partial saves', async () => {
    const { controller, request, links } = setup();
    await controller.load('one');
    request.mockRejectedValueOnce(new Error('Access changed. Retry.'));
    await controller.saveProjects([]);
    expect(controller.state.error).toContain('Access changed');
    expect(controller.state.links.one.map((p) => p.id)).toEqual(links.one);
    expect(controller.state.busy).toBe(false);
  });
  it('finishes multi-link changes despite its own live update notifications', async () => {
    const { controller, request, links } = setup();
    await controller.load('one');
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (path, options) => {
      const result = await original(path, options);
      if (options?.method) controller.refresh();
      return result;
    });
    await controller.saveProjects(['independent']);
    expect(links.one).toEqual(['independent']);
    expect(controller.state.selectedId).toBe('one');
  });
  it('ignores a late mutation failure after switching Servers', async () => {
    const { controller, request, switchServer } = setup();
    await controller.load('one');
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }) as never,
    );
    const saving = controller.rename('Old Server rename');
    switchServer();
    reject(new Error('Old Server failure'));
    await saving;
    expect(controller.snapshot().error).toBe('');
    expect(controller.snapshot().selectedId).toBeNull();
  });
  it('encodes resource IDs and preserves the legacy Server API namespace', async () => {
    const request = vi.fn().mockResolvedValue({});
    await createOrganizationApi(request).link('org/a', 'project/b', true);
    expect(request).toHaveBeenCalledWith('/organizations/org%2Fa/projects/project%2Fb', {
      method: 'PUT',
    });
  });
});
