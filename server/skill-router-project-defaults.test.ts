import { describe, it, expect } from 'vitest';
import { routeSkillsFromMessage } from './skill-router.js';

const SKILLS = [
  { id: 'survey-tracker', name: 'Survey Tracker', description: 'Survey API' },
  { id: 'agent-hub-kanban', name: 'Kanban', description: 'Board cards' },
];

describe('routeSkillsFromMessage — projectDefaultSkillIds', () => {
  it('auto-appends a configured default skill even with no message tell', () => {
    const matches = routeSkillsFromMessage({
      message: 'hello there',
      skills: SKILLS,
      projectDefaultSkillIds: ['survey-tracker'],
    });
    expect(matches.map((m) => m.skillId)).toContain('survey-tracker');
    const st = matches.find((m) => m.skillId === 'survey-tracker');
    expect(st?.reason).toBe('project default skill');
  });

  it('does not append a default that is not in the enabled skills list', () => {
    const matches = routeSkillsFromMessage({
      message: 'hello there',
      skills: SKILLS,
      projectDefaultSkillIds: ['not-enabled-skill'],
    });
    expect(matches.map((m) => m.skillId)).not.toContain('not-enabled-skill');
  });

  it('does not double-add when the same skill already matched explicitly', () => {
    const matches = routeSkillsFromMessage({
      message: 'use the survey-tracker skill please',
      skills: SKILLS,
      projectDefaultSkillIds: ['survey-tracker'],
    });
    const count = matches.filter((m) => m.skillId === 'survey-tracker').length;
    expect(count).toBe(1);
  });

  it('is a no-op when no defaults are configured', () => {
    const matches = routeSkillsFromMessage({
      message: 'hello there',
      skills: SKILLS,
    });
    expect(matches.map((m) => m.skillId)).not.toContain('survey-tracker');
  });
});
