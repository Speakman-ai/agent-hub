import { describe, it, expect, vi } from 'vitest';
import {
  FINALIZE_TIMELINE_KINDS,
  parseFinalizeTimelineMetadata,
  readFinalizeLoopRound,
  writeFinalizeChecksRoundTimeline,
  writeFinalizeCiAbsentTimeline,
  writeFinalizeFlakeRecoveredTimeline,
  writeFinalizeReviewRoundTimeline,
  writeFinalizeRunTerminalTimeline,
  writeFinalizeTimelineMessage,
} from './timeline-message.js';

describe('timeline-message', () => {
  it('writes metadata with kind and broadcasts message', () => {
    const broadcast = vi.fn();
    const inserted = {
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'system',
      content: 'Review · round 1 · approved',
      metadata: JSON.stringify({ kind: 'finalize_review_round', runId: 'run-1', round: 1 }),
    };
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => inserted) },
    };

    const id = writeFinalizeReviewRoundTimeline(
      { stmts: stmts as never, broadcast, newId: () => 'msg-1' },
      {
        sessionId: 'sess-1',
        runId: 'run-1',
        round: 1,
        verdict: 'approved',
        threads: [
          {
            id: 't1',
            file_path: 'src/a.ts',
            line_start: 1,
            line_end: 2,
            body: 'nit',
          },
        ],
      },
    );

    expect(id).toBe('msg-1');
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.kind).toBe('finalize_review_round');
    expect(metadata.runId).toBe('run-1');
    expect(metadata.round).toBe(1);
    expect(metadata.verdict).toBe('approved');
    expect(metadata.threads).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'message',
      sessionId: 'sess-1',
      message: inserted,
    });
  });

  it('returns null without sessionId', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
    };
    expect(
      writeFinalizeTimelineMessage(
        { stmts: stmts as never, broadcast: vi.fn() },
        {
          sessionId: null,
          kind: 'finalize_run_started',
          content: 'Finalize run started',
          payload: { runId: 'run-1' },
        },
      ),
    ).toBeNull();
    expect(stmts.addMessage.run).not.toHaveBeenCalled();
  });

  it('parseFinalizeTimelineMetadata recognizes all kinds', () => {
    for (const kind of FINALIZE_TIMELINE_KINDS) {
      const meta = parseFinalizeTimelineMetadata(JSON.stringify({ kind, runId: 'r' }));
      expect(meta?.kind).toBe(kind);
    }
  });

  it('writeFinalizeFlakeRecoveredTimeline summarizes laundered flakes', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeFlakeRecoveredTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm1' },
      {
        sessionId: 'sess-1',
        runId: 'run-1',
        round: 3,
        jobs: [
          {
            jobId: 'e2e',
            matrixKey: 'shard-1',
            failureCount: 2,
            failedRounds: [1, 2],
            passedRound: 3,
          },
        ],
      },
    );
    const args = stmts.addMessage.run.mock.calls[0];
    expect(args[3]).toContain('passed only on retry');
    expect(args[3]).toContain('manual push required');
    expect(args[3]).toContain('e2e [shard-1]');
    const metadata = JSON.parse(args[7] as string);
    expect(metadata.kind).toBe('finalize_flake_recovered');
    expect(metadata.jobs[0].failureCount).toBe(2);
  });

  it('writeFinalizeChecksRoundTimeline summarizes failed step', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeChecksRoundTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm2' },
      {
        sessionId: 'sess-1',
        runId: 'run-1',
        round: 2,
        steps: [
          { index: 1, name: 'lint', state: 'passed', exitCode: 0, startedAt: 1, endedAt: 2 },
          { index: 2, name: 'test', state: 'failed', exitCode: 1, startedAt: 3, endedAt: 4 },
        ],
      },
    );
    expect(stmts.addMessage.run.mock.calls[0][3]).toContain('test failed');
  });

  it('writeFinalizeRunTerminalTimeline marks a gated push as pushed without warning', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeRunTerminalTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm3' },
      { sessionId: 'sess-1', runId: 'run-1', status: 'pushed' },
    );
    expect(stmts.addMessage.run.mock.calls[0][3]).toBe('Finalize run pushed');
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.bypassedGates).toBe(false);
  });

  it('writeFinalizeRunTerminalTimeline flags a bypassed push in content and payload', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeRunTerminalTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm4' },
      { sessionId: 'sess-1', runId: 'run-1', status: 'pushed', bypassedGates: true },
    );
    expect(stmts.addMessage.run.mock.calls[0][3]).toBe(
      'Pushed to GitHub without running tests or review',
    );
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.kind).toBe('finalize_run_terminal');
    expect(metadata.status).toBe('pushed');
    expect(metadata.bypassedGates).toBe(true);
  });

  it('writeFinalizeRunTerminalTimeline carries prUrl in the payload on a successful push', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeRunTerminalTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm5' },
      {
        sessionId: 'sess-1',
        runId: 'run-1',
        status: 'pushed',
        prUrl: 'https://github.com/acme/repo/pull/42',
      },
    );
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.prUrl).toBe('https://github.com/acme/repo/pull/42');
  });

  it('writeFinalizeRunTerminalTimeline normalizes a missing/empty prUrl to null', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeRunTerminalTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm6' },
      { sessionId: 'sess-1', runId: 'run-1', status: 'pushed', prUrl: '' },
    );
    const metadata = JSON.parse(stmts.addMessage.run.mock.calls[0][7] as string);
    expect(metadata.prUrl).toBeNull();
  });

  it('writeFinalizeCiAbsentTimeline names the file the user has to add', () => {
    const stmts = {
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn(() => undefined) },
    };
    writeFinalizeCiAbsentTimeline(
      { stmts: stmts as never, broadcast: vi.fn(), newId: () => 'm7' },
      { sessionId: 'sess-1', runId: 'run-1', round: 2 },
    );
    const [, , , content, , , , metadataJson] = stmts.addMessage.run.mock.calls[0];
    // A green run with no checks must not read as "the tests passed".
    expect(String(content)).toMatch(/no ci config/i);
    expect(String(content)).toMatch(/\.agent-hub\/ci\.yaml/);
    const metadata = JSON.parse(String(metadataJson));
    expect(metadata.kind).toBe('finalize_ci_absent');
    expect(metadata.round).toBe(2);
  });

  it('readFinalizeLoopRound defaults invalid values to 0', () => {
    expect(readFinalizeLoopRound(null)).toBe(0);
    expect(readFinalizeLoopRound({ loop_round: 3 })).toBe(3);
    expect(readFinalizeLoopRound({ loop_round: 0 })).toBe(0);
  });
});
