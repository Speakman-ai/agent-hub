import { describe, expect, it } from 'vitest';
import { LOG_TAIL_MAX_RECORDS, mergeLogTail } from './logTail';

describe('mergeLogTail', () => {
  it('deduplicates a reconnect overlap by durable cursor id', () => {
    const next = mergeLogTail([{ id: 10 }, { id: 11 }], [{ id: 11 }, { id: 12 }]);
    expect(next.records.map((record: { id: number }) => record.id)).toEqual([10, 11, 12]);
    expect(next.dropped).toBe(0);
  });

  it('bounds the local buffer and accumulates server-reported drops', () => {
    const incoming = Array.from({ length: LOG_TAIL_MAX_RECORDS + 2 }, (_, id) => ({ id }));
    const next = mergeLogTail([], incoming, 3, 4);
    expect(next.records).toHaveLength(LOG_TAIL_MAX_RECORDS);
    expect(next.records[0].id).toBe(2);
    expect(next.dropped).toBe(9);
  });
});
