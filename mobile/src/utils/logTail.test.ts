import { describe, expect, it } from 'vitest';
import { LOG_TAIL_MAX_RECORDS, mergeLogTail } from './logTail';

describe('mergeLogTail', () => {
  it('deduplicates reconnect overlap and tracks dropped records', () => {
    const next = mergeLogTail([{ id: 4 }, { id: 5 }], [{ id: 5 }, { id: 6 }], 1, 2);
    expect(next).toEqual({ records: [{ id: 4 }, { id: 5 }, { id: 6 }], dropped: 3 });
  });

  it('keeps only the newest bounded window', () => {
    const records = Array.from({ length: LOG_TAIL_MAX_RECORDS + 1 }, (_, id) => ({ id }));
    const next = mergeLogTail([], records);
    expect(next.records).toHaveLength(LOG_TAIL_MAX_RECORDS);
    expect(next.records[0]).toEqual({ id: 1 });
    expect(next.dropped).toBe(1);
  });
});
