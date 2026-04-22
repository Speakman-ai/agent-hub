import { describe, it, expect } from 'vitest';
import {
  orchestrationMetaTextFromSession,
  parseOrchestrationMetaForSave,
} from './sessionOrchestration.js';

describe('orchestrationMetaTextFromSession', () => {
  it('formats orchestrationMeta object', () => {
    const s = orchestrationMetaTextFromSession({
      orchestrationMeta: { pr: 1, note: 'x' },
    });
    expect(s).toContain('"pr": 1');
    expect(s).toContain('"note": "x"');
  });

  it('pretty-prints orchestration_meta JSON string', () => {
    const s = orchestrationMetaTextFromSession({
      orchestration_meta: '{"a":1}',
    });
    expect(JSON.parse(s)).toEqual({ a: 1 });
  });

  it('returns raw string when JSON.parse fails', () => {
    expect(orchestrationMetaTextFromSession({ orchestration_meta: 'not-json' })).toBe('not-json');
  });

  it('returns empty string when nothing set', () => {
    expect(orchestrationMetaTextFromSession(null)).toBe('');
    expect(orchestrationMetaTextFromSession({})).toBe('');
  });
});

describe('parseOrchestrationMetaForSave', () => {
  it('treats blank as clear', () => {
    expect(parseOrchestrationMetaForSave('   ')).toEqual({ ok: true, meta: null });
  });

  it('accepts a plain object', () => {
    expect(parseOrchestrationMetaForSave('{"x":1}')).toEqual({ ok: true, meta: { x: 1 } });
  });

  it('rejects invalid JSON', () => {
    expect(parseOrchestrationMetaForSave('{')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects arrays and primitives', () => {
    expect(parseOrchestrationMetaForSave('[1]')).toEqual({ ok: false, reason: 'not_plain_object' });
    expect(parseOrchestrationMetaForSave('"hi"')).toEqual({
      ok: false,
      reason: 'not_plain_object',
    });
    expect(parseOrchestrationMetaForSave('null')).toEqual({
      ok: false,
      reason: 'not_plain_object',
    });
  });
});
