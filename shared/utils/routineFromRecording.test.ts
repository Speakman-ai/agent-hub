import { describe, expect, it } from 'vitest';
import {
  looksLikeCronExpression,
  routineCronCreateBody,
  routineSkillCreateBody,
  routineSkillProblems,
} from './routineFromRecording';

describe('routineSkillProblems', () => {
  it('passes a valid draft and flags each missing or bad field', () => {
    expect(routineSkillProblems({ name: 'weekly-export', description: 'x', body: 'y' })).toEqual(
      [],
    );
    expect(routineSkillProblems({ name: 'Weekly Export', description: ' ', body: '' })).toEqual([
      'Name must be lowercase letters, digits and hyphens',
      'Description is required',
      'Steps are required',
    ]);
  });
});

describe('routineCronCreateBody', () => {
  it('attaches the skill as a routine under the drafting agent', () => {
    expect(
      routineCronCreateBody({
        projectId: 'p1',
        agentId: 'ops',
        skillName: 'weekly-export',
        schedule: ' 0 9 * * 1-5 ',
        timezone: 'Europe/London',
      }),
    ).toEqual({
      name: 'Routine: weekly-export',
      schedule: '0 9 * * 1-5',
      timezone: 'Europe/London',
      prompt: 'Run the weekly-export routine.',
      project_id: 'p1',
      skill_principal_agent_id: 'ops',
      routine_skill: 'weekly-export',
      enabled: true,
    });
  });

  it('uses owner notes as the run prompt', () => {
    const body = routineCronCreateBody({
      projectId: 'p1',
      agentId: 'ops',
      skillName: 's',
      schedule: '0 * * * *',
      notes: 'Only the EU account',
    });
    expect(body.prompt).toBe('Only the EU account');
    expect(body.timezone).toBeNull();
  });
});

describe('helpers', () => {
  it('trims the skill body fields and checks cron shape', () => {
    expect(routineSkillCreateBody({ name: ' a ', description: ' d ', body: 'b\n' })).toEqual({
      name: 'a',
      description: 'd',
      category: 'general',
      body: 'b\n',
    });
    expect(looksLikeCronExpression('0 9 * * 1-5')).toBe(true);
    expect(looksLikeCronExpression('every day')).toBe(false);
  });
});
