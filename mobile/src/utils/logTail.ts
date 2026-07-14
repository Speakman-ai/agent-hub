/** Bounded, cursor-safe client state for the customer Logs live tail. */
export const LOG_TAIL_MAX_RECORDS = 1000;

export interface LogTailRecord {
  id: number;
  [key: string]: unknown;
}

export function mergeLogTail(
  previous: readonly LogTailRecord[] | unknown,
  incoming: readonly LogTailRecord[] | unknown,
  previousDropped = 0,
  incomingDropped = 0,
): { records: LogTailRecord[]; dropped: number } {
  const byId = new Map<number, LogTailRecord>();
  for (const record of Array.isArray(previous) ? previous : []) {
    if (Number.isInteger(record?.id)) byId.set(record.id, record);
  }
  for (const record of Array.isArray(incoming) ? incoming : []) {
    if (Number.isInteger(record?.id)) byId.set(record.id, record);
  }
  const records = [...byId.values()].sort((a, b) => a.id - b.id);
  const overflow = Math.max(0, records.length - LOG_TAIL_MAX_RECORDS);
  return {
    records: overflow > 0 ? records.slice(overflow) : records,
    dropped: Math.max(0, previousDropped) + Math.max(0, incomingDropped) + overflow,
  };
}
