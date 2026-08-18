import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import FinalizeReviewRoundBlock from './FinalizeReviewRoundBlock';
import {
  deriveSessionTimelineMarkers,
  TIMELINE_ANCHOR_NAVIGATE_EVENT,
} from '@shared/utils/sessionTimeline';

describe('FinalizeReviewRoundBlock', () => {
  it('renders verdict and grouped threads', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          id: 'rev-1',
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 1,
            verdict: 'changes_requested',
            threads: [
              {
                id: 't1',
                file_path: 'src/foo.ts',
                line_start: 10,
                line_end: 12,
                body: 'Use const here',
              },
            ],
          }),
        }}
      />,
    );

    expect(screen.getByTestId('finalize-review-round-block')).toBeInTheDocument();
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'changes_requested',
    );
    expect(screen.getByText('Use const here')).toBeInTheDocument();
    expect(screen.getByText(/Review · round 1/)).toBeInTheDocument();
    expect(screen.getByTestId('finalize-review-thread')).toHaveAttribute(
      'data-timeline-anchor',
      'review-comment:t1',
    );
  });

  it('labels approved rounds from verdict metadata', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          content: 'Review · changes requested',
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 2,
            verdict: 'approved',
            threads: [],
          }),
        }}
      />,
    );

    const block = screen.getByTestId('finalize-review-round-block');
    expect(block!).toHaveAttribute('aria-label', 'Review · round 2 · approved');
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'approved',
    );
    expect(block!).toHaveTextContent('Approved');
    expect(block!).not.toHaveTextContent('Changes requested');
  });

  it('labels changes-requested rounds from verdict metadata', () => {
    render(
      <FinalizeReviewRoundBlock
        message={{
          metadata: JSON.stringify({
            kind: 'finalize_review_round',
            runId: 'run-1',
            round: 3,
            verdict: 'changes_requested',
            threads: [],
          }),
        }}
      />,
    );

    const block = screen.getByTestId('finalize-review-round-block');
    expect(block!).toHaveAttribute('aria-label', 'Review · round 3 · changes requested');
    expect(screen.getByTestId('finalize-review-verdict')).toHaveAttribute(
      'data-verdict',
      'changes_requested',
    );
    expect(block!).toHaveTextContent('Changes requested');
  });

  // Regression: id-less threads spanning multiple files must render anchors that
  // use the thread's index in the original flat array — the same index the
  // timeline derives its markers from. A group-local index made markers past the
  // first file point at anchors that were never rendered.
  it('renders id-less thread anchors matching the derived timeline markers', () => {
    const message = {
      id: 'rev-flat',
      role: 'system',
      created_at: '2026-08-18T00:00:00Z',
      metadata: JSON.stringify({
        kind: 'finalize_review_round',
        runId: 'run-1',
        round: 1,
        verdict: 'changes_requested',
        threads: [
          { file_path: 'src/a.ts', line_start: 1, body: 'a-first' },
          { file_path: 'src/a.ts', line_start: 2, body: 'a-second' },
          { file_path: 'src/b.ts', line_start: 3, body: 'b-first' },
          { file_path: 'src/b.ts', line_start: 4, body: 'b-second' },
        ],
      }),
    };

    render(<FinalizeReviewRoundBlock message={message} />);

    const markers = deriveSessionTimelineMarkers({ messages: [message] });
    const renderedAnchors = screen
      .getAllByTestId('finalize-review-thread')
      .map((el) => el.getAttribute('data-timeline-anchor'));

    // Every marker the timeline advertises must resolve to a rendered anchor.
    for (const marker of markers) {
      expect(renderedAnchors).toContain(marker.anchorId);
    }
    // And the second file's anchors carry its flat index, not a group-local 0/1.
    expect(renderedAnchors).toContain('review-comment:rev-flat:src/b.ts:2');
    expect(renderedAnchors).toContain('review-comment:rev-flat:src/b.ts:3');
  });

  // Regression: collapsing a file group unmounts its thread anchors, so a
  // timeline jump would silently fail. A navigate event must re-expand the
  // group owning the target anchor.
  it('re-expands a collapsed file group when its anchor is navigated to', () => {
    const message = {
      id: 'rev-collapse',
      role: 'system',
      metadata: JSON.stringify({
        kind: 'finalize_review_round',
        runId: 'run-1',
        round: 1,
        verdict: 'changes_requested',
        threads: [{ file_path: 'src/a.ts', line_start: 1, body: 'collapse-me' }],
      }),
    };

    render(<FinalizeReviewRoundBlock message={message} />);

    const group = screen.getByTestId('finalize-review-file-group');
    const anchorId = 'review-comment:rev-collapse:src/a.ts:0';
    expect(within(group).getByTestId('finalize-review-thread')).toHaveAttribute(
      'data-timeline-anchor',
      anchorId,
    );

    // Collapse the group — the anchor leaves the DOM.
    fireEvent.click(within(group).getByRole('button'));
    expect(within(group).queryByTestId('finalize-review-thread')).toBeNull();

    // Navigating to the anchor re-expands the group.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TIMELINE_ANCHOR_NAVIGATE_EVENT, { detail: { anchorId } }),
      );
    });
    expect(within(group).getByTestId('finalize-review-thread')).toHaveAttribute(
      'data-timeline-anchor',
      anchorId,
    );
  });
});
