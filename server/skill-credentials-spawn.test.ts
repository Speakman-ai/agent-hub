import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Project } from './types.js';

// Spy on the runtime skill list so we can assert exactly which allowlist the
// spawn path resolves and forwards — the security-relevant behavior.
vi.mock('./agent-skills-list.js', () => ({
  listEnabledSkills: vi.fn(() => []),
}));
vi.mock('./skill-credentials-store.js', () => ({
  mergeDecryptedSkillCredentialsIntoEnv: vi.fn(),
}));
vi.mock('./skill-credentials-resolve.js', () => ({
  readCredentialsSchemaForSkill: vi.fn(() => ({ error: null, credentials: [] })),
}));

const { listEnabledSkills } = await import('./agent-skills-list.js');
const { mergeSkillCredentialSpawnEnv } = await import('./skill-credentials-spawn.js');

function makeProject(agents: unknown[]): Project {
  return {
    id: 'p1',
    name: 'P',
    cwd: '/tmp',
    ahw: '/tmp/ahw',
    color: '#000',
    agents,
  } as unknown as Project;
}

describe('mergeSkillCredentialSpawnEnv — allowlist resolution (access boundary)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the agent allowlist when the agent is restricted', () => {
    const project = makeProject([
      { id: 'a1', name: 'A1', engine: 'claude-code', allowedSkills: ['kanban'] },
    ]);
    mergeSkillCredentialSpawnEnv({}, { ownerId: 'u1', agentId: 'a1', project });
    expect(listEnabledSkills).toHaveBeenCalledWith('a1', expect.any(String), ['kanban']);
  });

  it('forwards null (unrestricted) when the resolved agent has no allowlist', () => {
    const project = makeProject([{ id: 'a1', name: 'A1', engine: 'claude-code' }]);
    mergeSkillCredentialSpawnEnv({}, { ownerId: 'u1', agentId: 'a1', project });
    expect(listEnabledSkills).toHaveBeenCalledWith('a1', expect.any(String), null);
  });

  it('FAILS CLOSED (empty allowlist) when the agent cannot be resolved from the project', () => {
    // Regression: a resolution miss must not fail OPEN and grant every skill's
    // credentials. The spawn path passes [] so listEnabledSkills filters to none.
    const project = makeProject([{ id: 'other', name: 'Other', engine: 'claude-code' }]);
    mergeSkillCredentialSpawnEnv({}, { ownerId: 'u1', agentId: 'missing', project });
    expect(listEnabledSkills).toHaveBeenCalledWith('missing', expect.any(String), []);
  });
});
