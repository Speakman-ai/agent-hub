import { describe, it, expect } from 'vitest';
import {
  buildSessionRunSnapshot,
  buildAggregationSkippedRunSnapshot,
  MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE,
  setSnapshotAggregateLimitForTests,
  getSnapshotAggregateLimit,
} from './session-run-snapshot.js';

function row(payload: object): { event_type: string; payload: string } {
  return { event_type: (payload as { type: string }).type, payload: JSON.stringify(payload) };
}

describe('buildSessionRunSnapshot', () => {
  it('counts tool_use, rate_limit, and errors', () => {
    const s = buildSessionRunSnapshot([
      row({ type: 'tool_use', id: '1', tool: 'Bash', input: { command: 'ls' } }),
      row({ type: 'tool_result', toolUseId: '1', output: 'ok' }),
      row({ type: 'rate_limit', retryAfterMs: 2000, message: 'hold' }),
      row({ type: 'error', message: 'nope' }),
      row({ type: 'tool_use', id: '2', tool: 'Read', input: { file_path: 'AGENTS.md' } }),
      row({ type: 'tool_result', toolUseId: '2', isError: true, output: 'nope' }),
    ]);
    expect(s.toolCalls).toBe(2);
    expect(s.retries).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.toolErrors).toBe(1);
    expect(s.contextReads).toEqual(['AGENTS.md']);
  });

  it('aggregates Write + Edit into one file with kind M', () => {
    const s = buildSessionRunSnapshot([
      row({
        type: 'tool_use',
        id: 'w1',
        tool: 'Write',
        input: { file_path: 'client/a.js', content: 'one' },
      }),
      row({
        type: 'tool_use',
        id: 'e1',
        tool: 'Edit',
        input: { file_path: 'client/a.js', old_string: 'one', new_string: ' two ' },
      }),
    ]);
    const f = s.files.find((x) => x.path === 'client/a.js');
    expect(f).toBeDefined();
    expect(f!.group).toBe('frontend');
    expect(f!.kind).toBe('M');
  });

  describe('Codex-style tool_use with input.changes[]', () => {
    it('parses unified_diff hunks (+/- lines) and skips file/hunk headers', () => {
      const diff = [
        '--- a/server/foo.ts',
        '+++ b/server/foo.ts',
        '@@ -1,3 +1,3 @@',
        '-old',
        '+new',
        ' ctx',
      ].join('\n');
      const s = buildSessionRunSnapshot([
        row({
          type: 'tool_use',
          id: 'c1',
          tool: 'apply_patch',
          input: {
            changes: [{ path: 'server/foo.ts', kind: 'update', unified_diff: diff }],
          },
        }),
      ]);
      const f = s.files.find((x) => x.path === 'server/foo.ts');
      expect(f).toMatchObject({
        group: 'backend',
        addLines: 1,
        delLines: 1,
        kind: 'M',
      });
    });

    it('treats kind delete as kind D with zero delLines (deleted rows do not surface deletions)', () => {
      const s = buildSessionRunSnapshot([
        row({
          type: 'tool_use',
          id: 'd1',
          tool: 'apply_patch',
          input: {
            changes: [{ path: 'client/removed.js', kind: 'delete' }],
          },
        }),
      ]);
      const f = s.files.find((x) => x.path === 'client/removed.js');
      expect(f).toMatchObject({
        group: 'frontend',
        addLines: 0,
        delLines: 0,
        kind: 'D',
      });
    });

    it('uses add=1 for kind add when unified_diff is absent', () => {
      const s = buildSessionRunSnapshot([
        row({
          type: 'tool_use',
          id: 'a1',
          tool: 'apply_patch',
          input: {
            changes: [{ path: 'server/new.ts', kind: 'add' }],
          },
        }),
      ]);
      const f = s.files.find((x) => x.path === 'server/new.ts');
      expect(f).toMatchObject({ addLines: 1, delLines: 0, kind: 'M' });
    });

    it('falls back to Edit line stats when kind is not add/delete and unified_diff is absent', () => {
      const s = buildSessionRunSnapshot([
        row({
          type: 'tool_use',
          id: 'e1',
          tool: 'apply_patch',
          input: {
            changes: [
              {
                path: 'server/bar.ts',
                kind: 'update',
                old_string: 'a\nb',
                new_string: 'a',
              },
            ],
          },
        }),
      ]);
      const f = s.files.find((x) => x.path === 'server/bar.ts');
      expect(f).toMatchObject({ addLines: 1, delLines: 2, kind: 'M' });
    });

    it('aggregates multiple change entries for the same path (edit then delete → D)', () => {
      const diff = ['--- a/z.ts', '+++ b/z.ts', '@@ @@', '-a', '+b'].join('\n');
      const s = buildSessionRunSnapshot([
        row({
          type: 'tool_use',
          id: 'm1',
          tool: 'apply_patch',
          input: {
            changes: [
              { path: 'server/z.ts', kind: 'update', unified_diff: diff },
              { path: 'server/z.ts', kind: 'delete' },
            ],
          },
        }),
      ]);
      const f = s.files.find((x) => x.path === 'server/z.ts');
      expect(f).toMatchObject({ addLines: 1, delLines: 0, kind: 'D' });
    });
  });
});

describe('buildAggregationSkippedRunSnapshot', () => {
  it('returns empty files and flags with event count', () => {
    const s = buildAggregationSkippedRunSnapshot(100_000);
    expect(s.aggregationSkipped).toBe(true);
    expect(s.sessionEventCount).toBe(100_000);
    expect(s.files).toEqual([]);
    expect(MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE).toBe(25_000);
  });
});

describe('getSnapshotAggregateLimit', () => {
  it('reflects setSnapshotAggregateLimitForTests and restores on null', () => {
    setSnapshotAggregateLimitForTests(3);
    try {
      expect(getSnapshotAggregateLimit()).toBe(3);
    } finally {
      setSnapshotAggregateLimitForTests(null);
    }
    expect(getSnapshotAggregateLimit()).toBe(MAX_SESSION_EVENTS_FOR_SNAPSHOT_AGGREGATE);
  });
});
