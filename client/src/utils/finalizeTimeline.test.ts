import { describe, it, expect } from 'vitest';
import {
  parseFinalizeTimelineKind,
  parseFinalizeReviewRoundMetadata,
  parseFinalizeTerminalMetadata,
  isFinalizeStepOutputMessage,
  parseRawReviewVerdictContent,
  extractReviewVerdictContent,
} from './finalizeTimeline';

describe('finalizeTimeline utils', () => {
  it('parses review round metadata', () => {
    const meta = parseFinalizeReviewRoundMetadata(
      JSON.stringify({
        kind: 'finalize_review_round',
        runId: 'run-1',
        round: 2,
        verdict: 'changes_requested',
        threads: [{ id: 't1', file_path: 'a.ts', body: 'fix me' }],
      }),
    );
    expect(meta?.runId).toBe('run-1');
    expect(meta?.round).toBe(2);
    expect(meta?.threads).toHaveLength(1);
  });

  it('parses terminal metadata with bypassedGates flag', () => {
    const bypassed = parseFinalizeTerminalMetadata(
      JSON.stringify({ kind: 'finalize_run_terminal', status: 'pushed', bypassedGates: true }),
    );
    expect(bypassed?.status).toBe('pushed');
    expect(bypassed?.bypassedGates).toBe(true);

    const gated = parseFinalizeTerminalMetadata(
      JSON.stringify({ kind: 'finalize_run_terminal', status: 'pushed' }),
    );
    expect(gated?.bypassedGates).toBe(false);
  });

  it('detects finalize_step_output for suppression', () => {
    expect(isFinalizeStepOutputMessage(JSON.stringify({ kind: 'finalize_step_output' }))).toBe(
      true,
    );
    expect(parseFinalizeTimelineKind(JSON.stringify({ kind: 'pr_created' }))).toBeNull();
  });

  it('parses a raw reviewer verdict JSON message for legacy timeline rows', () => {
    const meta = parseRawReviewVerdictContent(
      JSON.stringify({
        verdict: 'changes_requested',
        threads: [{ file_path: 'client/App.jsx', line_start: 1, body: 'Fix this.' }],
      }),
    );

    expect(meta!).toMatchObject({
      kind: 'finalize_review_round',
      verdict: 'changes_requested',
      threads: [{ file_path: 'client/App.jsx', line_start: 1, body: 'Fix this.' }],
    });
  });

  it('ignores prose that merely mentions verdict JSON', () => {
    expect(parseRawReviewVerdictContent('Earlier: {"verdict":"approved"}')).toBeNull();
  });

  it('extracts a tagged review verdict block while preserving prose', () => {
    const extracted = extractReviewVerdictContent(
      [
        'The implementation looks good after the last fix.',
        '',
        '<agenthub:review-verdict>',
        '{"verdict":"approved","threads":[]}',
        '</agenthub:review-verdict>',
      ].join('\n'),
    );

    expect(extracted.prose).toBe('The implementation looks good after the last fix.');
    expect(extracted.verdict).toMatchObject({
      kind: 'finalize_review_round',
      verdict: 'approved',
      threads: [],
    });
  });

  it('extracts trailing review verdict JSON while preserving prose', () => {
    const extracted = extractReviewVerdictContent(
      [
        'One issue remains in the renderer.',
        '',
        JSON.stringify({
          verdict: 'changes_requested',
          threads: [{ file_path: 'client/App.jsx', line_start: 1, body: 'Fix this.' }],
        }),
      ].join('\n'),
    );

    expect(extracted.prose).toBe('One issue remains in the renderer.');
    expect(extracted.verdict).toMatchObject({
      kind: 'finalize_review_round',
      verdict: 'changes_requested',
      threads: [{ file_path: 'client/App.jsx', line_start: 1, body: 'Fix this.' }],
    });
  });
});
