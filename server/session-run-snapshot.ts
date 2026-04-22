/**
 * Derives a compact "run snapshot" (tool counts, changed files, read paths)
 * from persisted `session_events` rows for a chat session.
 */
export type FileGroup = 'frontend' | 'backend' | 'tests' | 'other';

export interface RunSnapshotFileRow {
  path: string;
  group: FileGroup;
  addLines: number;
  delLines: number;
  kind: 'A' | 'M' | 'D';
}

export interface RunSnapshot {
  toolCalls: number;
  /** `rate_limit` events (retry hints). */
  retries: number;
  /** `type: 'error'` events from the model stream (not `tool_result` failures). */
  warnings: number;
  toolErrors: number;
  files: RunSnapshotFileRow[];
  contextReads: string[];
  /**
   * Set when the session has more than `MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE`
   * message events — we return a count-only check and avoid loading all payloads.
   */
  aggregationSkipped?: boolean;
  sessionEventCount?: number;
}

const BUCKET_TESTS = (p: string) =>
  /\.(test|spec)\.[jt]sx?$/i.test(p) ||
  p.includes('__tests__') ||
  p.includes('/e2e/') ||
  p.startsWith('e2e/');
const BUCKET_FE = (p: string) =>
  p.startsWith('client/') || p.startsWith('mobile/') || p.startsWith('electron/');
const BUCKET_BE = (p: string) => p.startsWith('server/');

function groupForPath(path: string): FileGroup {
  if (!path) return 'other';
  const normalized = path.replace(/\\/g, '/');
  if (BUCKET_TESTS(normalized)) return 'tests';
  if (BUCKET_FE(normalized)) return 'frontend';
  if (BUCKET_BE(normalized)) return 'backend';
  return 'other';
}

type PathAgg = {
  add: number;
  del: number;
  sawWrite: boolean;
  sawEdit: boolean;
  deleted: boolean;
};

function lineCount(s: string): number {
  if (!s) return 0;
  if (!s.includes('\n')) return 1;
  return s.split('\n').length;
}

function lineStatsForEdit(
  tool: string,
  input: Record<string, unknown>,
): { add: number; del: number } {
  if (tool === 'Write') {
    const content = input.content ?? input.fileText ?? input.contents;
    return { add: lineCount(String(content ?? '')), del: 0 };
  }
  const oldS =
    (input.old_string as string) ??
    (input.oldString as string) ??
    (input as { strReplace?: { oldText?: string; newText?: string } })?.strReplace?.oldText ??
    '';
  const newS =
    (input.new_string as string) ??
    (input.newString as string) ??
    (input as { strReplace?: { oldText?: string; newText?: string } })?.strReplace?.newText ??
    '';
  return { add: lineCount(String(newS)), del: lineCount(String(oldS)) };
}

function getAgg(map: Map<string, PathAgg>, path: string): PathAgg {
  if (!path) return { add: 0, del: 0, sawWrite: false, sawEdit: false, deleted: false };
  const x = map.get(path);
  if (x) return x;
  const a: PathAgg = { add: 0, del: 0, sawWrite: false, sawEdit: false, deleted: false };
  map.set(path, a);
  return a;
}

function addCodexChanges(map: Map<string, PathAgg>, input: { changes?: unknown }) {
  const ch = (input as { changes?: Array<{ path?: string; kind?: string; unified_diff?: string }> })
    .changes;
  if (!Array.isArray(ch) || ch.length === 0) return;
  for (const c of ch) {
    const p = typeof c.path === 'string' ? c.path : '';
    if (!p) continue;
    const a = getAgg(map, p);
    const kind = String(c.kind || '').toLowerCase();
    if (kind === 'delete') {
      a.deleted = true;
      a.sawEdit = true;
      continue;
    }
    a.sawEdit = true;
    if (c.unified_diff && typeof c.unified_diff === 'string') {
      const lines = c.unified_diff.split('\n');
      for (const line of lines) {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
        if (line.startsWith('-') && !line.startsWith('---')) a.del += 1;
        else if (line.startsWith('+') && !line.startsWith('+++')) a.add += 1;
      }
    } else {
      const isCreate = kind === 'add';
      const { add, del } = isCreate
        ? { add: 1, del: 0 }
        : lineStatsForEdit('Edit', c as unknown as Record<string, unknown>);
      a.add += add;
      a.del += del;
    }
  }
}

function kindForAgg(a: PathAgg): 'A' | 'M' | 'D' {
  if (a.deleted) return 'D';
  if (a.sawWrite && !a.sawEdit) return 'A';
  return 'M';
}

/**
 * @param eventRows  Rows from `getSessionEventsForSession` (or equivalent).
 */
export function buildSessionRunSnapshot(
  eventRows: Array<{ event_type: string; payload: string }>,
): RunSnapshot {
  let toolCalls = 0;
  let retries = 0;
  let warnings = 0;
  let toolErrors = 0;
  const pathMap = new Map<string, PathAgg>();
  const readOrder: string[] = [];
  const readSet = new Set<string>();

  for (const row of eventRows) {
    let ev: { type?: string; [k: string]: unknown };
    try {
      ev = JSON.parse(row.payload) as { type?: string; [k: string]: unknown };
    } catch {
      continue;
    }
    if (!ev || typeof ev.type !== 'string') continue;

    if (ev.type === 'tool_use') {
      const tool = ev.tool;
      if (typeof tool !== 'string') continue;
      toolCalls += 1;
      const input = (ev.input as Record<string, unknown>) || {};

      if (tool === 'Read') {
        const path = (input.file_path as string) || (input.path as string) || '';
        if (path && !readSet.has(path)) {
          readSet.add(path);
          readOrder.push(path);
        }
        continue;
      }

      if (input.changes && Array.isArray((input as { changes?: unknown }).changes)) {
        addCodexChanges(pathMap, input);
        continue;
      }

      if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
        const path = (input.file_path as string) || (input.path as string) || '';
        if (!path) continue;
        const a = getAgg(pathMap, path);
        if (tool === 'Write') {
          a.sawWrite = true;
          const { add, del } = lineStatsForEdit('Write', input);
          a.add += add;
          a.del += del;
        } else {
          a.sawEdit = true;
          const { add, del } = lineStatsForEdit(tool, input);
          a.add += add;
          a.del += del;
        }
      }
      continue;
    }

    if (ev.type === 'rate_limit') {
      retries += 1;
      continue;
    }
    if (ev.type === 'error') {
      warnings += 1;
      continue;
    }
    if (ev.type === 'tool_result') {
      const isErr =
        (ev as { isError?: boolean }).isError === true ||
        (ev as { is_error?: boolean }).is_error === true;
      if (isErr) toolErrors += 1;
    }
  }

  const files: RunSnapshotFileRow[] = [];
  for (const [path, a] of pathMap) {
    if (!path) continue;
    const del = a.deleted ? 0 : a.del;
    files.push({
      path,
      group: groupForPath(path),
      addLines: a.add,
      delLines: del,
      kind: kindForAgg(a),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    toolCalls,
    retries,
    warnings,
    toolErrors,
    files,
    contextReads: readOrder.slice(0, 10),
  };
}

/** Above this count (per session, message-scoped events), skip loading all event payloads. */
export const MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE = 25_000;

let snapshotAggregateLimitOverride: number | null = null;

/**
 * Vitest-only: lower the event cap so integration tests need not insert 25k+ rows.
 * Pass `null` to restore the default cap. Non-null values are refused outside Vitest.
 */
export function setSnapshotAggregateLimitForTests(limit: number | null): void {
  if (limit !== null && process.env.VITEST !== 'true') {
    throw new Error('setSnapshotAggregateLimitForTests: override only allowed when VITEST=true');
  }
  snapshotAggregateLimitOverride = limit;
}

export function getSnapshotAggregateLimit(): number {
  return snapshotAggregateLimitOverride ?? MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE;
}

export function buildAggregationSkippedRunSnapshot(eventCount: number): RunSnapshot {
  return {
    toolCalls: 0,
    retries: 0,
    warnings: 0,
    toolErrors: 0,
    files: [],
    contextReads: [],
    aggregationSkipped: true,
    sessionEventCount: eventCount,
  };
}
