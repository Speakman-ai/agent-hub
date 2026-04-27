import { describe, it, expect } from 'vitest';
import { dedupeSkillInvocations } from './dedupeSkillInvocations.js';

describe('dedupeSkillInvocations', () => {
  it('returns [] for non-array input', () => {
    expect(dedupeSkillInvocations(null)).toEqual([]);
    expect(dedupeSkillInvocations(undefined)).toEqual([]);
    expect(dedupeSkillInvocations('foo')).toEqual([]);
  });

  it('returns the input unchanged when there are no duplicates', () => {
    const rows = [
      { id: '1', skill_id: 'kanban', created_at: '2026-04-21T17:00:00Z' },
      { id: '2', skill_id: 'wiki-search', created_at: '2026-04-21T17:01:00Z' },
    ];
    const out = dedupeSkillInvocations(rows);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.skill_id).sort()).toEqual(['kanban', 'wiki-search']);
  });

  it('keeps only the most recent row per skill_id (snake_case)', () => {
    const rows = [
      { id: '1', skill_id: 'kanban', created_at: '2026-04-21T17:00:00Z', status: 'loaded' },
      { id: '2', skill_id: 'kanban', created_at: '2026-04-21T17:05:00Z', status: 'loaded' },
      { id: '3', skill_id: 'kanban', created_at: '2026-04-21T16:55:00Z', status: 'not-found' },
      { id: '4', skill_id: 'wiki-search', created_at: '2026-04-21T17:02:00Z', status: 'loaded' },
    ];
    const out = dedupeSkillInvocations(rows);
    expect(out).toHaveLength(2);
    const kanban = out.find((r) => r.skill_id === 'kanban');
    expect(kanban.id).toBe('2');
    expect(kanban.status).toBe('loaded');
  });

  it('keeps only the most recent row per skillId (camelCase / SessionSummarySidebar shape)', () => {
    const rows = [
      { id: 'a', skillId: 'kanban', createdAt: '2026-04-21T17:00:00Z' },
      { id: 'b', skillId: 'kanban', createdAt: '2026-04-21T17:10:00Z' },
      { id: 'c', skillId: 'design', createdAt: '2026-04-21T17:01:00Z' },
    ];
    const out = dedupeSkillInvocations(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.skillId === 'kanban').id).toBe('b');
  });

  it('skips falsy / malformed rows without throwing', () => {
    const rows = [
      null,
      undefined,
      { skill_id: '', created_at: '2026-04-21T17:00:00Z' },
      { id: '1', skill_id: 'kanban', created_at: '2026-04-21T17:00:00Z' },
      { id: '2', skill_id: 'kanban', created_at: '2026-04-21T17:01:00Z' },
    ];
    const out = dedupeSkillInvocations(rows);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('2');
  });

  it('treats missing created_at as oldest (existing entry wins)', () => {
    const rows = [
      { id: '1', skill_id: 'kanban', created_at: '2026-04-21T17:00:00Z' },
      { id: '2', skill_id: 'kanban' }, // no created_at
    ];
    const out = dedupeSkillInvocations(rows);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('1');
  });

  it('is idempotent: running it twice yields the same result', () => {
    const rows = [
      { id: '1', skill_id: 'kanban', created_at: '2026-04-21T17:00:00Z' },
      { id: '2', skill_id: 'kanban', created_at: '2026-04-21T17:05:00Z' },
      { id: '3', skill_id: 'wiki-search', created_at: '2026-04-21T17:02:00Z' },
    ];
    const once = dedupeSkillInvocations(rows);
    const twice = dedupeSkillInvocations(once);
    expect(twice).toEqual(once);
  });
});
