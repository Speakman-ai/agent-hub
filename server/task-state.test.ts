import { describe, it, expect } from 'vitest';
import {
  normalizeTaskStateInput,
  parseSessionTaskStateJson,
  formatPersistedTaskPlanPromptAppend,
  formatTaskStateAgentGuidancePromptAppend,
  sessionTaskStateHasVisibleContent,
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

describe('sessionTaskStateHasVisibleContent', () => {
  it('is false for empty / null', () => {
    expect(sessionTaskStateHasVisibleContent(null)).toBe(false);
    expect(sessionTaskStateHasVisibleContent('{}')).toBe(false);
  });

  it('is true when goal or checklist or lastFailure present', () => {
    expect(sessionTaskStateHasVisibleContent(JSON.stringify({ goal: 'x' }))).toBe(true);
    expect(sessionTaskStateHasVisibleContent(JSON.stringify({ checklist: [{ text: 'a' }] }))).toBe(
      true,
    );
    expect(sessionTaskStateHasVisibleContent(JSON.stringify({ lastFailure: 'e' }))).toBe(true);
  });
});

describe('formatTaskStateAgentGuidancePromptAppend', () => {
  it('returns null without sessionId', () => {
    expect(
      formatTaskStateAgentGuidancePromptAppend({
        persistedTaskStateJson: null,
        isFirstMessage: true,
      }),
    ).toBeNull();
  });

  it('includes protocol on first message when no persisted state', () => {
    const s = formatTaskStateAgentGuidancePromptAppend({
      sessionId: '01900000-0000-7000-8000-000000000001',
      persistedTaskStateJson: null,
      isFirstMessage: true,
    });
    expect(s).toContain('Session task plan');
    expect(s).toContain('<agenthub:task-state>');
  });

  it('short handoff-aware guidance on first message when state already exists', () => {
    const s = formatTaskStateAgentGuidancePromptAppend({
      sessionId: '01900000-0000-7000-8000-000000000001',
      persistedTaskStateJson: JSON.stringify({ goal: 'carry-over' }),
      isFirstMessage: true,
    });
    expect(s).toContain('persisted snapshot is already attached');
    expect(s).toContain('<agenthub:task-state>');
  });

  it('returns null on subsequent turns when still empty (avoid per-turn token growth)', () => {
    const s = formatTaskStateAgentGuidancePromptAppend({
      sessionId: '01900000-0000-7000-8000-000000000001',
      persistedTaskStateJson: null,
      isFirstMessage: false,
    });
    expect(s).toBeNull();
  });

  it('returns null on subsequent turns when snapshot exists', () => {
    expect(
      formatTaskStateAgentGuidancePromptAppend({
        sessionId: '01900000-0000-7000-8000-000000000001',
        persistedTaskStateJson: JSON.stringify({ goal: 'x' }),
        isFirstMessage: false,
      }),
    ).toBeNull();
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
