import { describe, it, expect } from 'vitest';
import {
  parseFinalizeTimelineKind,
  parseFinalizeReviewRoundMetadata,
  isFinalizeStepOutputMessage,
} from './finalizeTimeline.js';

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

  it('detects finalize_step_output for suppression', () => {
    expect(isFinalizeStepOutputMessage(JSON.stringify({ kind: 'finalize_step_output' }))).toBe(
      true,
    );
    expect(parseFinalizeTimelineKind(JSON.stringify({ kind: 'pr_created' }))).toBeNull();
  });
});
