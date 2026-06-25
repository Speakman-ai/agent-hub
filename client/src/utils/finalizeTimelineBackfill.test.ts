import { describe, expect, it } from 'vitest';
import {
  finalizeStatusMayHaveChecks,
  hasFinalizeChecksRoundMessage,
  shouldBackfillFinalizeChecksTimeline,
} from './finalizeTimelineBackfill';

function message(kind: string) {
  return {
    id: kind,
    metadata: JSON.stringify({
      kind,
      runId: 'run-1',
      round: 1,
      steps: [{ index: 1, name: 'server tests', state: 'failed', exitCode: 1 }],
    }),
  };
}

describe('finalizeTimelineBackfill', () => {
  it('recognizes statuses where a checks-round summary may already exist', () => {
    expect(finalizeStatusMayHaveChecks('dispatching')).toBe(true);
    expect(finalizeStatusMayHaveChecks('ready_to_push')).toBe(true);
    expect(finalizeStatusMayHaveChecks('checks_passed')).toBe(true);
    expect(finalizeStatusMayHaveChecks('reviewing')).toBe(false);
    expect(finalizeStatusMayHaveChecks(null)).toBe(false);
  });

  it('detects an already-loaded finalize checks-round message', () => {
    expect(hasFinalizeChecksRoundMessage([message('finalize_review_round')])).toBe(false);
    expect(hasFinalizeChecksRoundMessage([message('finalize_checks_round')])).toBe(true);
  });

  it('requests older pages only while a finalize session can be missing checks history', () => {
    expect(
      shouldBackfillFinalizeChecksTimeline({
        messages: [message('finalize_fix_dispatch')],
        finalizeStatus: 'dispatching',
        hasMore: true,
      }),
    ).toBe(true);
    expect(
      shouldBackfillFinalizeChecksTimeline({
        messages: [message('finalize_checks_round')],
        finalizeStatus: 'dispatching',
        hasMore: true,
      }),
    ).toBe(false);
    expect(
      shouldBackfillFinalizeChecksTimeline({
        messages: [message('finalize_fix_dispatch')],
        finalizeStatus: 'reviewing',
        hasMore: true,
      }),
    ).toBe(false);
    expect(
      shouldBackfillFinalizeChecksTimeline({
        messages: [message('finalize_fix_dispatch')],
        finalizeStatus: 'dispatching',
        hasMore: false,
      }),
    ).toBe(false);
    expect(
      shouldBackfillFinalizeChecksTimeline({
        messages: [message('finalize_fix_dispatch')],
        finalizeStatus: 'dispatching',
        hasMore: true,
        olderPagesLoaded: 3,
      }),
    ).toBe(false);
  });
});
