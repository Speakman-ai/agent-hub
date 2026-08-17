import { describe, it, expect } from 'vitest';
import type { SkillInfo } from './routes/skills.js';
import { filterSkillsByAllowlist, isSkillAllowed } from './agent-skills-list.js';

function skill(id: string): SkillInfo {
  return { id, name: id, description: `desc ${id}`, path: `/skills/${id}` } as SkillInfo;
}

describe('filterSkillsByAllowlist (prompt-builder skill filtering)', () => {
  const all = [skill('kanban'), skill('wiki-search'), skill('github'), skill('aws-cli')];

  it('passes every skill through when allowlist is null (unrestricted, default)', () => {
    expect(filterSkillsByAllowlist(all, null).map((s) => s.id)).toEqual([
      'kanban',
      'wiki-search',
      'github',
      'aws-cli',
    ]);
  });

  it('passes every skill through when allowlist is undefined', () => {
    expect(filterSkillsByAllowlist(all, undefined)).toHaveLength(4);
  });

  it('keeps only the allowed skill ids, preserving order', () => {
    expect(filterSkillsByAllowlist(all, ['aws-cli', 'kanban']).map((s) => s.id)).toEqual([
      'kanban',
      'aws-cli',
    ]);
  });

  it('drops sensitive skills not on the list (real access control)', () => {
    const filtered = filterSkillsByAllowlist(all, ['kanban', 'wiki-search']);
    expect(filtered.map((s) => s.id)).not.toContain('github');
    expect(filtered.map((s) => s.id)).not.toContain('aws-cli');
  });

  it('an empty allowlist filters everything out', () => {
    expect(filterSkillsByAllowlist(all, [])).toEqual([]);
  });

  it('ignores allowlist entries that do not match any skill', () => {
    expect(filterSkillsByAllowlist(all, ['kanban', 'does-not-exist']).map((s) => s.id)).toEqual([
      'kanban',
    ]);
  });
});

describe('isSkillAllowed (skill-trigger gate)', () => {
  it('allows anything when unrestricted (null/undefined)', () => {
    expect(isSkillAllowed('github', null)).toBe(true);
    expect(isSkillAllowed('github', undefined)).toBe(true);
  });

  it('allows ids on the list and blocks ids off the list', () => {
    expect(isSkillAllowed('kanban', ['kanban', 'wiki-search'])).toBe(true);
    expect(isSkillAllowed('github', ['kanban', 'wiki-search'])).toBe(false);
  });

  it('blocks everything when the allowlist is empty', () => {
    expect(isSkillAllowed('kanban', [])).toBe(false);
  });
});
