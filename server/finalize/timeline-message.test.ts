import { describe, it, expect, vi } from 'vitest';
import {
  FINALIZE_TIMELINE_KINDS,
  parseFinalizeTimelineMetadata,
  readFinalizeLoopRound,
  writeFinalizeChecksRoundTimeline,
  writeFinalizeReviewRoundTimeline,
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

  it('readFinalizeLoopRound defaults invalid values to 0', () => {
    expect(readFinalizeLoopRound(null)).toBe(0);
    expect(readFinalizeLoopRound({ loop_round: 3 })).toBe(3);
    expect(readFinalizeLoopRound({ loop_round: 0 })).toBe(0);
  });
});
