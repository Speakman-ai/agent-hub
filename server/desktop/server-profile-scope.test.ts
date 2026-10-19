import { describe, expect, it } from 'vitest';
import { organizationWorkspaceId } from '../organization-workspace-id.js';
import { describeProfileProjectId, serverScopedProfileProjectId } from './server-profile-scope.js';

describe('Server-scoped profile keys', () => {
  it('keeps default Server and organization ids, and scopes other Servers distinctly', () => {
    const workspace = organizationWorkspaceId('acme', 'org');
    expect(serverScopedProfileProjectId('default', 'shared')).toBe('shared');
    expect(serverScopedProfileProjectId('acme', workspace)).toBe(workspace);
    const acme = serverScopedProfileProjectId('acme', 'shared');
    const beta = serverScopedProfileProjectId('beta', 'shared');
    expect(new Set(['shared', acme, beta]).size).toBe(3);
    // Scoping is idempotent and reversible for display.
    expect(serverScopedProfileProjectId('acme', acme)).toBe(acme);
    expect(describeProfileProjectId(acme, 'acme')).toEqual({ projectId: 'shared', inServer: true });
    expect(describeProfileProjectId(acme, 'default')).toEqual({
      projectId: 'shared',
      inServer: false,
    });
    expect(describeProfileProjectId('shared', 'default').inServer).toBe(true);
    expect(describeProfileProjectId('shared', 'acme').inServer).toBe(false);
  });
});
