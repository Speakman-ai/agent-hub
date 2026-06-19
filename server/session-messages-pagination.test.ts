import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MESSAGES_PAGE_SIZE,
  MAX_MESSAGES_PAGE_SIZE,
  isPaginatedMessagesQuery,
  parseBeforeMessageId,
  parseMessagesPageSize,
  toAscendingPage,
} from './session-messages-pagination.js';
import type { MessageRow } from './types.js';

function row(id: string): MessageRow {
  return {
    id,
    session_id: 's1',
    role: 'user',
    content: id,
    created_at: '2026-01-01T00:00:00.000Z',
  } as MessageRow;
}

describe('isPaginatedMessagesQuery', () => {
  it('is false for legacy queries (no flag, no cursor)', () => {
    expect(isPaginatedMessagesQuery({})).toBe(false);
    expect(isPaginatedMessagesQuery({ limit: '10' } as Record<string, unknown>)).toBe(false);
  });

  it('is true when paginated flag is truthy', () => {
    expect(isPaginatedMessagesQuery({ paginated: '1' })).toBe(true);
    expect(isPaginatedMessagesQuery({ paginated: 'true' })).toBe(true);
    expect(isPaginatedMessagesQuery({ paginated: 'yes' })).toBe(true);
  });

  it('is false for a non-truthy paginated value', () => {
    expect(isPaginatedMessagesQuery({ paginated: '0' })).toBe(false);
    expect(isPaginatedMessagesQuery({ paginated: 'false' })).toBe(false);
  });

  it('is true when a before cursor is present (implies pagination)', () => {
    expect(isPaginatedMessagesQuery({ before: 'm123' })).toBe(true);
  });

  it('ignores an empty before string', () => {
    expect(isPaginatedMessagesQuery({ before: '' })).toBe(false);
  });
});

describe('parseMessagesPageSize', () => {
  it('defaults when missing or invalid', () => {
    expect(parseMessagesPageSize(undefined)).toBe(DEFAULT_MESSAGES_PAGE_SIZE);
    expect(parseMessagesPageSize('abc')).toBe(DEFAULT_MESSAGES_PAGE_SIZE);
    expect(parseMessagesPageSize('0')).toBe(DEFAULT_MESSAGES_PAGE_SIZE);
    expect(parseMessagesPageSize('-5')).toBe(DEFAULT_MESSAGES_PAGE_SIZE);
  });

  it('honors a valid size', () => {
    expect(parseMessagesPageSize('25')).toBe(25);
  });

  it('clamps to the max page size', () => {
    expect(parseMessagesPageSize('99999')).toBe(MAX_MESSAGES_PAGE_SIZE);
  });
});

describe('parseBeforeMessageId', () => {
  it('returns null for the initial page (missing/empty)', () => {
    expect(parseBeforeMessageId(undefined)).toBeNull();
    expect(parseBeforeMessageId('')).toBeNull();
    expect(parseBeforeMessageId(123 as unknown)).toBeNull();
  });

  it('passes through a message id', () => {
    expect(parseBeforeMessageId('m-42')).toBe('m-42');
  });
});

describe('toAscendingPage', () => {
  it('reverses a newest-first DB page into oldest-first render order', () => {
    const desc = [row('m5'), row('m4'), row('m3')];
    expect(toAscendingPage(desc).map((m) => m.id)).toEqual(['m3', 'm4', 'm5']);
  });

  it('does not mutate the input array', () => {
    const desc = [row('m2'), row('m1')];
    toAscendingPage(desc);
    expect(desc.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('handles an empty page', () => {
    expect(toAscendingPage([])).toEqual([]);
  });
});
