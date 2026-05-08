import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CronRow, Project } from './types.js';
import { resolveCronSkillPrincipalAgentId } from './cron-skill-principal.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveCronSkillPrincipalAgentId', () => {
  const aliceBob = {
    agents: [{ id: 'alice' }, { id: 'bob' }],
  } as unknown as Project;

  const solo = {
    agents: [{ id: 'solo-agent' }],
  } as unknown as Project;

  it('uses skill_principal_agent_id when it matches an agent', () => {
    expect(
      resolveCronSkillPrincipalAgentId({ skill_principal_agent_id: 'alice' } as CronRow, aliceBob),
    ).toBe('alice');
  });

  it('falls through when cron field names a non-member (warns)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveCronSkillPrincipalAgentId({ skill_principal_agent_id: 'eve' } as CronRow, aliceBob),
    ).toBeUndefined();
  });

  it('uses project.cronSkillPrincipalAgentId when valid', () => {
    const p = { ...aliceBob, cronSkillPrincipalAgentId: 'bob' } as Project;
    expect(resolveCronSkillPrincipalAgentId({ skill_principal_agent_id: null } as CronRow, p)).toBe(
      'bob',
    );
  });

  it('uses the sole agent when no explicit fields are set', () => {
    expect(
      resolveCronSkillPrincipalAgentId({ skill_principal_agent_id: null } as CronRow, solo),
    ).toBe('solo-agent');
  });

  it('returns undefined for multi-agent projects with no valid principal', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveCronSkillPrincipalAgentId({ skill_principal_agent_id: null } as CronRow, aliceBob),
    ).toBeUndefined();
  });
});
