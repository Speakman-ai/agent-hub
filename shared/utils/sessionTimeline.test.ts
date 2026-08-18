import { describe, it, expect } from 'vitest';
import {
  deriveSessionTimelineMarkers,
  changeSummaryAnchorId,
  checksRoundAnchorId,
  reviewCommentAnchorId,
  truncateTimelineText,
} from './sessionTimeline.js';

function meta(kind: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ kind, ...extra });
}

describe('truncateTimelineText', () => {
  it('collapses whitespace and ellipsizes', () => {
    expect(truncateTimelineText('  hello   world  ', 20)).toBe('hello world');
    expect(truncateTimelineText('abcdefghij', 6)).toBe('abcde…');
  });
});

describe('anchor ids', () => {
  it('prefers a thread id when present', () => {
    expect(reviewCommentAnchorId('m1', { id: 42 }, 'a.ts', 0)).toBe('review-comment:42');
    expect(reviewCommentAnchorId('m1', {}, 'a.ts', 3)).toBe('review-comment:m1:a.ts:3');
  });
});

describe('deriveSessionTimelineMarkers', () => {
  it('emits a change-summary marker from turn_change_summary metadata', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'm-sum',
          role: 'system',
          created_at: '2026-08-18T12:00:00Z',
          metadata: meta('turn_change_summary', {
            summary: 'Adds the timeline sidebar and wires the toggle.',
            filesChanged: 3,
          }),
        },
      ],
    });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: 'change_summary',
      messageId: 'm-sum',
      anchorId: changeSummaryAnchorId('m-sum'),
      subtitle: '3 files changed',
      status: 'neutral',
    });
    expect(markers[0].title).toContain('timeline sidebar');
  });

  it('does not treat in-session shell test commands as timeline tests', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [{ id: 'asst-1', role: 'assistant', created_at: '2026-08-18T12:01:00Z' }],
    });
    expect(markers).toEqual([]);
  });

  it('emits a test-run marker from a finalize checks round', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'chk-1',
          role: 'system',
          created_at: '2026-08-18T12:02:00Z',
          metadata: meta('finalize_checks_round', {
            round: 2,
            steps: [
              { name: 'unit', state: 'passed' },
              { name: 'e2e', state: 'failed' },
            ],
          }),
        },
      ],
    });
    expect(markers).toEqual([
      expect.objectContaining({
        kind: 'test_run',
        anchorId: checksRoundAnchorId('chk-1'),
        title: 'Checks · round 2',
        subtitle: 'e2e failed',
        status: 'fail',
      }),
    ]);
  });

  it('marks a checks round pending while steps are still running', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'chk-pending',
          role: 'system',
          metadata: meta('finalize_checks_round', {
            round: 1,
            steps: [
              { name: 'unit', state: 'passed' },
              { name: 'e2e', state: 'running' },
            ],
          }),
        },
      ],
    });
    expect(markers[0]).toMatchObject({
      kind: 'test_run',
      title: 'Checks · round 1',
      subtitle: '1/2 passed',
      status: 'pending',
    });
  });

  it('emits one review-comment marker per thread', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'rev-1',
          role: 'system',
          metadata: meta('finalize_review_round', {
            round: 1,
            verdict: 'changes_requested',
            threads: [
              {
                id: 'th-a',
                file_path: 'client/src/App.tsx',
                line_start: 10,
                line_end: 12,
                body: 'Extract the timeline toggle.',
              },
              {
                filePath: 'shared/utils/sessionTimeline.ts',
                lineStart: 4,
                body: 'Cover the checks-round case.',
              },
            ],
          }),
        },
      ],
    });
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      kind: 'review_comment',
      anchorId: 'review-comment:th-a',
      subtitle: 'client/src/App.tsx:10-12',
    });
    expect(markers[1]).toMatchObject({
      kind: 'review_comment',
      anchorId: reviewCommentAnchorId('rev-1', {}, 'shared/utils/sessionTimeline.ts', 1),
      subtitle: 'shared/utils/sessionTimeline.ts:4',
    });
    expect(markers[0].title).toContain('timeline toggle');
  });

  it('emits a round-level review marker when there are no findings', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'rev-ok',
          role: 'system',
          metadata: meta('finalize_review_round', { round: 1, verdict: 'approved', threads: [] }),
        },
      ],
    });
    expect(markers).toEqual([
      expect.objectContaining({
        kind: 'review_comment',
        title: 'Review · round 1',
        subtitle: 'Approved',
        status: 'ok',
        anchorId: 'review-comment:rev-ok',
      }),
    ]);
  });

  it('preserves conversation order across kinds', () => {
    const markers = deriveSessionTimelineMarkers({
      messages: [
        {
          id: 'sum',
          role: 'system',
          metadata: meta('turn_change_summary', { summary: 'First change' }),
        },
        {
          id: 'chk',
          role: 'system',
          metadata: meta('finalize_checks_round', {
            round: 1,
            steps: [{ name: 'unit', state: 'passed' }],
          }),
        },
      ],
    });
    expect(markers.map((m) => m.kind)).toEqual(['change_summary', 'test_run']);
    expect(markers[1].messageId).toBe('chk');
  });

  it('returns an empty list when there is nothing to mark', () => {
    expect(deriveSessionTimelineMarkers({})).toEqual([]);
    expect(deriveSessionTimelineMarkers({ messages: [{ id: 'u1', role: 'user' }] })).toEqual([]);
  });
});
