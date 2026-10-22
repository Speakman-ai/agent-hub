import { describe, it, expect } from 'vitest';
import {
  addSkillRef,
  addableSkillGroups,
  describeSkillRef,
  removeSkillRef,
  type ServerAgentSkillOptions,
} from './serverAgentSkills';

const opt = (id: string, description = '') => ({
  id,
  name: id,
  description,
  source: 'default' as const,
});

const options: ServerAgentSkillOptions = {
  builtIn: ['agent-hub'],
  global: [opt('github', 'GitHub workflows'), opt('gcloud', 'Google Cloud')],
  projects: [
    {
      projectId: 'p1',
      projectName: 'Payments',
      skills: [{ ...opt('deploy', 'Ship payments'), source: 'project' }],
    },
  ],
};

describe('serverAgentSkills', () => {
  it('groups addable skills Global first, then by project, hiding added ones', () => {
    const groups = addableSkillGroups(options, [{ id: 'github' }]);
    expect(groups.map((g) => g.label)).toEqual(['Global', 'Payments']);
    expect(groups[0]!.items.map((i) => i.ref)).toEqual([{ id: 'gcloud' }]);
    expect(groups[1]!.items.map((i) => i.ref)).toEqual([{ id: 'deploy', projectId: 'p1' }]);
  });

  it('filters by id, name or description and drops empty groups', () => {
    const groups = addableSkillGroups(options, [], 'ship');
    expect(groups.map((g) => g.key)).toEqual(['project:p1']);
    expect(addableSkillGroups(null, [])).toEqual([]);
  });

  it('replaces a same-id ref on add and removes by exact ref', () => {
    const refs = addSkillRef([{ id: 'deploy' }, { id: 'github' }], {
      id: 'deploy',
      projectId: 'p1',
    });
    expect(refs).toEqual([{ id: 'github' }, { id: 'deploy', projectId: 'p1' }]);
    expect(removeSkillRef(refs, { id: 'deploy' })).toEqual(refs);
    expect(removeSkillRef(refs, { id: 'deploy', projectId: 'p1' })).toEqual([{ id: 'github' }]);
  });

  it('describes refs with their scope, falling back to raw ids', () => {
    expect(describeSkillRef({ id: 'deploy', projectId: 'p1' }, options)).toEqual({
      name: 'deploy',
      scope: 'Payments',
    });
    expect(describeSkillRef({ id: 'github' }, options)).toEqual({
      name: 'github',
      scope: 'Global',
    });
    expect(describeSkillRef({ id: 'x', projectId: 'gone' }, null)).toEqual({
      name: 'x',
      scope: 'gone',
    });
  });
});
