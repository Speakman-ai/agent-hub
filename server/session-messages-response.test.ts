import { describe, it, expect } from 'vitest';
import type { MessageRow } from './types.js';
import {
  applyMessagesLimitQuery,
  capMessagesForJsonResponse,
  buildSessionMessagesHttpBody,
} from './session-messages-response.js';

function msg(id: string, content: string): MessageRow {
  return {
    id,
    session_id: 's1',
    role: 'assistant',
    content,
    engine: null,
    model: null,
    attachments: null,
    metadata: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('applyMessagesLimitQuery', () => {
  const rows = [msg('1', 'a'), msg('2', 'b'), msg('3', 'c')];

  it('returns all rows when limit is absent or invalid', () => {
    expect(applyMessagesLimitQuery(rows, undefined)).toEqual(rows);
    expect(applyMessagesLimitQuery(rows, '0')).toEqual(rows);
    expect(applyMessagesLimitQuery(rows, 'nope')).toEqual(rows);
  });

  it('keeps the newest N rows', () => {
    expect(applyMessagesLimitQuery(rows, '2')).toEqual([msg('2', 'b'), msg('3', 'c')]);
  });
});

describe('capMessagesForJsonResponse', () => {
  it('passes through small payloads unchanged', () => {
    const rows = [msg('1', 'hello'), msg('2', 'world')];
    expect(capMessagesForJsonResponse(rows, 4096)).toEqual({
      messages: rows,
      truncated: false,
      omitted: 0,
      total: 2,
    });
  });

  it('keeps the newest messages when over budget', () => {
    const rows = [msg('1', 'x'.repeat(100)), msg('2', 'y'.repeat(100)), msg('3', 'z'.repeat(100))];
    const capped = capMessagesForJsonResponse(rows, 400);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(3);
    expect(capped.messages.map((m) => m.id)).toEqual(['3']);
    expect(capped.omitted).toBe(2);
  });

  it('always returns at least the newest message', () => {
    const rows = [msg('1', 'x'.repeat(10_000))];
    const capped = capMessagesForJsonResponse(rows, 100);
    expect(capped.messages).toEqual(rows);
    expect(capped.truncated).toBe(true);
    expect(capped.omitted).toBe(0);
  });
});

describe('buildSessionMessagesHttpBody', () => {
  it('returns a bare array when nothing was truncated', () => {
    const rows = [msg('1', 'ok')];
    expect(buildSessionMessagesHttpBody(rows, 4096)).toEqual(rows);
  });

  it('returns an envelope when truncated', () => {
    const rows = [msg('1', 'a'), msg('2', 'b'.repeat(500))];
    const body = buildSessionMessagesHttpBody(rows, 300);
    expect(Array.isArray(body)).toBe(false);
    if (Array.isArray(body)) throw new Error('expected envelope');
    expect(body.truncated).toBe(true);
    expect(body.messages.at(-1)?.id).toBe('2');
  });
});
