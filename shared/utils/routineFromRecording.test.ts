import { describe, expect, it } from 'vitest';
import { routineSkillCreateBody, routineSkillProblems } from './routineFromRecording';

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

describe('helpers', () => {
  it('trims the skill body fields', () => {
    expect(routineSkillCreateBody({ name: ' a ', description: ' d ', body: 'b\n' })).toEqual({
      name: 'a',
      description: 'd',
      category: 'general',
      body: 'b\n',
    });
  });
});
