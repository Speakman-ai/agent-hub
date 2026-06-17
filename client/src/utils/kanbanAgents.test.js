import { describe, it, expect } from 'vitest';
import { filterAgentsByProject } from './kanbanAgents.js';

describe('filterAgentsByProject', () => {
  const agents = [
    { id: 'a1', name: 'Alpha', projectId: 'proj-1' },
    { id: 'a2', name: 'Beta', projectId: 'proj-2' },
    { id: 'a3', name: 'Gamma', projectId: 'proj-1' },
    { id: 'a4', name: 'Delta', projectId: 'proj-3' },
  ];

  it('returns only agents belonging to the given project', () => {
    const result = filterAgentsByProject(agents, 'proj-1');
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('does not leak agents from other projects (regression for the assign dropdown)', () => {
    const result = filterAgentsByProject(agents, 'proj-2');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Beta');
    expect(result.some((a) => a.projectId !== 'proj-2')).toBe(false);
  });

  it('returns an empty array when no agents match the project', () => {
    expect(filterAgentsByProject(agents, 'proj-unknown')).toEqual([]);
  });

  it('returns the full list when projectId is missing (no context to scope by)', () => {
    expect(filterAgentsByProject(agents, undefined)).toEqual(agents);
    expect(filterAgentsByProject(agents, '')).toEqual(agents);
  });

  it('handles non-array / nullish input safely', () => {
    expect(filterAgentsByProject(null, 'proj-1')).toEqual([]);
    expect(filterAgentsByProject(undefined, 'proj-1')).toEqual([]);
  });

  it('skips nullish entries without throwing', () => {
    const withHoles = [null, { id: 'a1', projectId: 'proj-1' }, undefined];
    expect(filterAgentsByProject(withHoles, 'proj-1')).toEqual([{ id: 'a1', projectId: 'proj-1' }]);
  });
});
