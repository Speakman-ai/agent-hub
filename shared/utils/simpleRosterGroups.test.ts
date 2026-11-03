import { describe, expect, it } from 'vitest';
import { groupSimpleChats } from './simpleRosterGroups.js';

const ada = { agentId: 'ada', projectId: 'app', projectName: 'App' };
const bea = { agentId: 'bea', projectId: 'app', projectName: 'App' };
const cam = { agentId: 'cam', projectId: 'site', projectName: 'Site' };
const dee = { agentId: 'dee', projectId: 'notes', projectName: 'Notes' };

describe('groupSimpleChats', () => {
  it('returns null when there are no organizations', () => {
    expect(
      groupSimpleChats({
        items: [ada],
        projectId: (item) => item.projectId,
        projectName: (item) => item.projectName,
        organizations: [],
        membership: {},
      }),
    ).toBeNull();
  });

  it('groups projects under their organization and leaves the rest independent', () => {
    const groups = groupSimpleChats({
      items: [ada, bea, cam, dee],
      projectId: (item) => item.projectId,
      projectName: (item) => item.projectName,
      organizations: [
        { id: 'acme', name: 'Acme' },
        { id: 'beta', name: 'Beta' },
      ],
      membership: { acme: ['app', 'site'], beta: [] },
    });
    expect(groups?.map((group) => group.name)).toEqual(['Acme', 'Independent']);
    expect(groups?.[0].projects.map((project) => project.id)).toEqual(['app', 'site']);
    expect(groups?.[0].projects[0].items.map((item) => item.agentId)).toEqual(['ada', 'bea']);
    expect(groups?.[1].projects.map((project) => project.id)).toEqual(['notes']);
  });

  it('keeps a saved organization and project order, appending anything new', () => {
    const groups = groupSimpleChats({
      items: [ada, cam, dee],
      projectId: (item) => item.projectId,
      projectName: (item) => item.projectName,
      organizations: [
        { id: 'acme', name: 'Acme' },
        { id: 'beta', name: 'Beta' },
      ],
      membership: { acme: ['site'], beta: ['app'] },
      orgOrder: ['beta', 'acme'],
      projectOrderByOrg: { acme: ['gone', 'site'] },
    });
    expect(groups?.map((group) => group.id)).toEqual(['beta', 'acme', 'independent']);
    expect(groups?.[1].projects.map((project) => project.id)).toEqual(['site']);
  });
});
