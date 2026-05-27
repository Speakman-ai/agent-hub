import { describe, it, expect } from 'vitest';
import { filterAgentsForPicker, groupAgentsByProject } from './sessionAgentPicker.js';

describe('sessionAgentPicker', () => {
  const agents = [
    { id: 'a1', name: 'Alpha', projectId: 'p1', projectName: 'Zebra', active: true },
    { id: 'a2', name: 'Beta', projectId: 'p2', projectName: 'Apple', active: true },
    { id: 'a3', name: 'Gamma', projectId: 'p1', projectName: 'Zebra', active: false },
  ];

  it('filterAgentsForPicker excludes inactive and roster ids', () => {
    const out = filterAgentsForPicker(agents, { excludeIds: new Set(['a1']) });
    expect(out.map((a) => a.id)).toEqual(['a2']);
  });

  it('filterAgentsForPicker matches project name', () => {
    const out = filterAgentsForPicker(agents, { query: 'apple' });
    expect(out.map((a) => a.id)).toEqual(['a2']);
  });

  it('groupAgentsByProject sorts groups and agents', () => {
    const groups = groupAgentsByProject(agents.filter((a) => a.active !== false));
    expect(groups.map((g) => g.projectName)).toEqual(['Apple', 'Zebra']);
    expect(groups[0].agents.map((a) => a.id)).toEqual(['a2']);
    expect(groups[1].agents.map((a) => a.id)).toEqual(['a1']);
  });
});
