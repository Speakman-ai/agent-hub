import { describe, it, expect } from 'vitest';
import {
  normalizeTaskStateInput,
  parseSessionTaskStateJson,
  formatPersistedTaskPlanPromptAppend,
  detectLastTaskStateBlock,
  parseTaskStateUpdateBlock,
  serializeTaskState,
  tryApplyTaskStateBlockFromAssistant,
} from './task-state.js';

describe('normalizeTaskStateInput', () => {
  it('returns null for empty payload', () => {
    expect(normalizeTaskStateInput({})).toBeNull();
    expect(normalizeTaskStateInput(null)).toBeNull();
  });

  it('keeps goal and checklist', () => {
    const o = normalizeTaskStateInput({
      goal: 'Fix bug',
      checklist: [{ text: '  a  ', done: true }, 'b'],
      lastFailure: 'timeout',
    });
    expect(o?.goal).toBe('Fix bug');
    expect(o?.checklist).toEqual([{ text: 'a', done: true }, { text: 'b' }]);
    expect(o?.lastFailure).toBe('timeout');
  });
});

describe('formatPersistedTaskPlanPromptAppend', () => {
  it('returns null when nothing to show', () => {
    expect(formatPersistedTaskPlanPromptAppend(null)).toBeNull();
    expect(formatPersistedTaskPlanPromptAppend('{}')).toBeNull();
  });

  it('renders fenced JSON so markdown in stored fields cannot break the system prompt', () => {
    const json = JSON.stringify({
      goal: '## not a heading',
      checklist: [{ text: 'One', done: false }],
      lastFailure: 'E',
    });
    const s = formatPersistedTaskPlanPromptAppend(json);
    expect(s).toContain('## Persisted task plan');
    expect(s).toContain('```json');
    expect(s).toContain('"goal":"## not a heading"');
    expect(s).toContain('```');
    expect(s).not.toMatch(/\*\*Goal:\*\*/);
  });
});

describe('tryApplyTaskStateBlockFromAssistant', () => {
  it('returns ok with null serialized when payload clears state', () => {
    const r = tryApplyTaskStateBlockFromAssistant(
      'x\n<agenthub:task-state>{}</agenthub:task-state>',
    );
    expect(r).toEqual({ kind: 'ok', serialized: null });
  });

  it('returns none when no block', () => {
    expect(tryApplyTaskStateBlockFromAssistant('hello').kind).toBe('none');
  });
});

describe('parseTaskStateUpdateBlock', () => {
  it('uses the last block', () => {
    const text = `hello
<agenthub:task-state>
{"goal":"first"}
</agenthub:task-state>
tail
<agenthub:task-state>
{"goal":"second"}
</agenthub:task-state>`;
    expect(parseTaskStateUpdateBlock(text)?.goal).toBe('second');
  });

  it('returns null for invalid json inside tags', () => {
    const text = '<agenthub:task-state>{</agenthub:task-state>';
    expect(parseTaskStateUpdateBlock(text)).toBeNull();
  });
});

describe('detectLastTaskStateBlock', () => {
  it('returns null when absent', () => {
    expect(detectLastTaskStateBlock('no block')).toBeNull();
  });
});

describe('serializeTaskState round-trip', () => {
  it('serializes normalized state', () => {
    const st = normalizeTaskStateInput({ goal: 'x', checklist: [{ text: 'y' }] });
    const ser = serializeTaskState(st);
    expect(ser).toBeTruthy();
    expect(parseSessionTaskStateJson(ser!)?.goal).toBe('x');
  });
});
