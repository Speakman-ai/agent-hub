/**
 * Unit tests for the finalize connect-snapshot builder. The builder turns the
 * set of non-terminal finalize runs into one `finalize_run_phase_changed`
 * event each, which the WS connect handler replays so a reconnecting client
 * converges its checks block / button to the server's truth — the durable,
 * server-side counterpart to the client reconnect-refetch heuristics. See
 * `server/finalize/finalize-snapshot.ts` and the wiki page
 * `finalize-checks-ui-stale-after-websocket-reconnect`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFinalizeSnapshotEvents,
  finalizeSnapshotEventFromRow,
  type FinalizeSnapshotRunRow,
} from './finalize-snapshot.js';

function row(overrides: Partial<FinalizeSnapshotRunRow> = {}): FinalizeSnapshotRunRow {
  return {
    id: 'run-1',
    session_id: 'sess-1',
    phase: 'tasks',
    status: 'running',
    ...overrides,
  };
}

function stmtsReturning(rows: unknown[]) {
  return { getActiveFinalizeRuns: { all: () => rows } };
}

describe('finalizeSnapshotEventFromRow', () => {
  it('maps an active run to a live-shaped finalize_run_phase_changed event', () => {
    expect(finalizeSnapshotEventFromRow(row())).toEqual({
      type: 'finalize_run_phase_changed',
      run_id: 'run-1',
      session_id: 'sess-1',
      phase: 'tasks',
      status: 'running',
      snapshot: true,
    });
  });

  it('preserves the parked ready_to_push state (non-terminal, button must reflect it)', () => {
    const event = finalizeSnapshotEventFromRow(row({ status: 'ready_to_push', phase: null }));
    expect(event).toMatchObject({ status: 'ready_to_push', phase: null });
  });

  it('drops a run with no session_id (visibility filter + client match both need it)', () => {
    expect(finalizeSnapshotEventFromRow(row({ session_id: null }))).toBeNull();
    expect(finalizeSnapshotEventFromRow(row({ session_id: '' }))).toBeNull();
  });

  it('drops a malformed row (missing id / status)', () => {
    expect(finalizeSnapshotEventFromRow(row({ id: '' }))).toBeNull();
    expect(
      finalizeSnapshotEventFromRow({ id: 'x', session_id: 's', phase: 'tasks' } as any),
    ).toBeNull();
    expect(finalizeSnapshotEventFromRow(null)).toBeNull();
    expect(finalizeSnapshotEventFromRow(undefined)).toBeNull();
  });

  it('normalizes an absent phase to null', () => {
    const event = finalizeSnapshotEventFromRow({
      id: 'r',
      session_id: 's',
      phase: undefined as any,
      status: 'reviewing',
    });
    expect(event?.phase).toBeNull();
  });
});

describe('buildFinalizeSnapshotEvents', () => {
  it('emits one event per active run, preserving statement order', () => {
    const events = buildFinalizeSnapshotEvents(
      stmtsReturning([
        row({ id: 'run-a', session_id: 'sess-a', status: 'reviewing', phase: 'review' }),
        row({ id: 'run-b', session_id: 'sess-b', status: 'running', phase: 'tasks' }),
      ]),
    );
    expect(events.map((e) => e.run_id)).toEqual(['run-a', 'run-b']);
    expect(events[0]).toMatchObject({ session_id: 'sess-a', status: 'reviewing' });
    expect(events[1]).toMatchObject({ session_id: 'sess-b', status: 'running' });
  });

  it('filters out rows the mapper rejects (no session_id) without aborting the batch', () => {
    const events = buildFinalizeSnapshotEvents(
      stmtsReturning([
        row({ id: 'keep', session_id: 'sess-1' }),
        row({ id: 'drop', session_id: null }),
        row({ id: 'keep-2', session_id: 'sess-2' }),
      ]),
    );
    expect(events.map((e) => e.run_id)).toEqual(['keep', 'keep-2']);
  });

  it('returns [] when there are no active runs', () => {
    expect(buildFinalizeSnapshotEvents(stmtsReturning([]))).toEqual([]);
  });

  it('is lenient: a throwing statement collapses to [] (never breaks the handshake)', () => {
    const throwing = {
      getActiveFinalizeRuns: {
        all: () => {
          throw new Error('db gone');
        },
      },
    };
    expect(buildFinalizeSnapshotEvents(throwing)).toEqual([]);
  });

  it('is lenient: missing stmts / accessor yields []', () => {
    expect(buildFinalizeSnapshotEvents(null)).toEqual([]);
    expect(buildFinalizeSnapshotEvents(undefined)).toEqual([]);
    expect(buildFinalizeSnapshotEvents({} as any)).toEqual([]);
  });

  it('is lenient: a non-array statement result yields []', () => {
    expect(
      buildFinalizeSnapshotEvents({ getActiveFinalizeRuns: { all: () => null as any } }),
    ).toEqual([]);
  });
});
