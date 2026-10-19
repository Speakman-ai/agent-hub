import { describe, expect, it } from 'vitest';
import { organizationWorkspaceId } from '../organization-workspace-id.js';
import { resolveDesktopComputerIdentity } from './desktop-computer-identity.js';

const orgProject = (serverId: string, organizationId: string) => ({
  id: organizationWorkspaceId(serverId, organizationId),
  workspaceKind: 'organization',
  organizationId,
  serverId,
  agents: [{ id: 'assistant' }],
});

describe('resolveDesktopComputerIdentity', () => {
  it('keeps the (user, agent, project) identity of regular projects', () => {
    expect(
      resolveDesktopComputerIdentity({
        ownerUserId: 'u1',
        agentId: 'dev',
        project: { id: 'agent-hub' },
        serverId: 'default',
      }),
    ).toEqual({ ok: true, key: { userId: 'u1', agentId: 'dev', projectId: 'agent-hub' } });
  });

  it('refuses sessions with no owner or project', () => {
    for (const input of [
      { ownerUserId: null, agentId: 'dev', project: { id: 'p' } },
      { ownerUserId: 'u1', agentId: 'dev', project: null },
    ])
      expect(resolveDesktopComputerIdentity({ ...input, serverId: 'default' }).ok).toBe(false);
  });

  it('keys an organization agent by its Server-qualified workspace', () => {
    const project = orgProject('server-a', 'org-1');
    expect(
      resolveDesktopComputerIdentity({
        ownerUserId: 'u1',
        agentId: 'assistant',
        project,
        serverId: 'server-a',
      }),
    ).toEqual({ ok: true, key: { userId: 'u1', agentId: 'assistant', projectId: project.id } });
  });

  it('refuses workspaces that do not match their Server, organization or roster', () => {
    const valid = orgProject('server-a', 'org-1');
    const cases = [
      // Same workspace read while another Server partition is active.
      { project: valid, serverId: 'server-b' },
      // Claims a different organization than its id was derived from.
      { project: { ...valid, organizationId: 'org-2' }, serverId: 'server-a' },
      // Claims a different Server than its id was derived from.
      { project: { ...valid, serverId: 'server-b' }, serverId: 'server-b' },
      // A regular project squatting on the reserved namespace.
      { project: { id: valid.id }, serverId: 'server-a' },
      // Marker without a valid workspace kind.
      { project: { ...valid, workspaceKind: null }, serverId: 'server-a' },
    ];
    for (const c of cases)
      expect(
        resolveDesktopComputerIdentity({ ownerUserId: 'u1', agentId: 'assistant', ...c }).ok,
      ).toBe(false);
    expect(
      resolveDesktopComputerIdentity({
        ownerUserId: 'u1',
        agentId: 'someone-elses-agent',
        project: valid,
        serverId: 'server-a',
      }).ok,
    ).toBe(false);
  });
});
