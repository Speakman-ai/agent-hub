import { describe, it, expect } from 'vitest';
import { filterForwardTargets } from './forwardTargets.js';

const source = {
  id: 'src-1',
  name: 'Hub Frontend',
  projectId: 'proj-a',
  active: true,
};

const siblingA = {
  id: 'sib-a',
  name: 'Hub Backend',
  projectId: 'proj-a',
  active: true,
};

const siblingB = {
  id: 'sib-b',
  name: 'Hub Lead',
  projectId: 'proj-a',
  active: true,
};

const otherProject = {
  id: 'other-1',
  name: 'Side Agent',
  projectId: 'proj-b',
  active: true,
};

const inactiveSibling = {
  id: 'inactive-1',
  name: 'Retired',
  projectId: 'proj-a',
  active: false,
};

describe('filterForwardTargets (mobile)', () => {
  it('keeps only active agents from the same project, minus the source', () => {
    const agents = [source, siblingA, siblingB, otherProject, inactiveSibling];
    const result = filterForwardTargets(agents, source);
    expect(result.map((a) => a.id)).toEqual(['sib-a', 'sib-b']);
  });

  it('drops agents from other projects even if active', () => {
    const result = filterForwardTargets([source, otherProject], source);
    expect(result).toEqual([]);
  });

  it('drops inactive agents from the same project', () => {
    const result = filterForwardTargets([source, inactiveSibling], source);
    expect(result).toEqual([]);
  });

  it('returns [] when source is missing or has no project', () => {
    expect(filterForwardTargets([source, siblingA], null)).toEqual([]);
    expect(
      filterForwardTargets([source, siblingA], { id: 'x', active: true }),
    ).toEqual([]);
  });

  it('returns [] on non-array input', () => {
    expect(filterForwardTargets(null, source)).toEqual([]);
    expect(filterForwardTargets(undefined, source)).toEqual([]);
  });
});
