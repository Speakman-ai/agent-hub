import { describe, it, expect } from 'vitest';
import { parseTaskStateFromSession, taskStateFormHasContent } from './sessionTaskState.js';

describe('parseTaskStateFromSession', () => {
  it('returns empty form when session missing', () => {
    expect(parseTaskStateFromSession(null)).toEqual({
      goal: '',
      checklist: [],
      lastFailure: '',
    });
  });

  it('parses checklist strings and objects', () => {
    const s = {
      task_state_json: JSON.stringify({
        goal: 'Ship feature',
        checklist: ['A', { text: 'B', done: true }],
        lastFailure: 'npm failed',
      }),
    };
    const f = parseTaskStateFromSession(s);
    expect(f.goal).toBe('Ship feature');
    expect(f.checklist).toEqual([
      { text: 'A', done: false },
      { text: 'B', done: true },
    ]);
    expect(f.lastFailure).toBe('npm failed');
    expect(taskStateFormHasContent(f)).toBe(true);
  });
});
