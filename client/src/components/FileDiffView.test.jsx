import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileDiffView from './FileDiffView.jsx';

const PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  '-const c = 3;',
].join('\n');

describe('FileDiffView inline comments', () => {
  it('renders existing comments under their anchored line with a count badge', () => {
    render(
      <FileDiffView
        patch={PATCH}
        comments={[
          {
            id: 'c1',
            user: 'ryan',
            file_path: 'src/app.js',
            line: 2,
            side: 'new',
            body: 'why 2?',
            created_at: '2026-06-10T00:00:00Z',
          },
        ]}
        onAddComment={vi.fn()}
      />,
    );
    expect(screen.getByTestId('inline-comment-c1')).toHaveTextContent('why 2?');
    expect(screen.getByTestId('inline-comment-c1')).toHaveTextContent('@ryan');
    // File header shows the comment count.
    expect(screen.getByTestId('commit-file-src/app.js')).toHaveTextContent('1');
  });

  it('opens the composer on a line and submits with the right anchor', async () => {
    const onAddComment = vi.fn(async () => {});
    render(<FileDiffView patch={PATCH} comments={[]} onAddComment={onAddComment} />);

    // '+const b = 2;' is new-file line 2.
    fireEvent.click(screen.getByTestId('diff-line-comment-src/app.js-new-2'));
    const composer = screen.getByTestId('inline-comment-composer');
    fireEvent.change(composer.querySelector('textarea'), {
      target: { value: 'tighten this' },
    });
    fireEvent.click(screen.getByTestId('inline-comment-submit'));

    await waitFor(() =>
      expect(onAddComment).toHaveBeenCalledWith({
        filePath: 'src/app.js',
        line: 2,
        side: 'new',
        body: 'tighten this',
      }),
    );
    // Composer closes after a successful submit.
    expect(screen.queryByTestId('inline-comment-composer')).toBeNull();
  });

  it('anchors deletions to the old side', () => {
    render(<FileDiffView patch={PATCH} comments={[]} onAddComment={vi.fn()} />);
    // '-const c = 3;' is old-file line 2.
    expect(screen.getByTestId('diff-line-comment-src/app.js-old-2')).toBeInTheDocument();
  });

  it('delete button fires onDeleteComment; hidden without the handler', () => {
    const comment = {
      id: 'c9',
      user: 'kevin',
      file_path: 'src/app.js',
      line: 1,
      side: 'new',
      body: 'old note',
      created_at: '2026-06-10T00:00:00Z',
    };
    const onDelete = vi.fn();
    const { rerender } = render(
      <FileDiffView
        patch={PATCH}
        comments={[comment]}
        onAddComment={vi.fn()}
        onDeleteComment={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-comment-delete-c9'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'c9' }));

    rerender(<FileDiffView patch={PATCH} comments={[comment]} />);
    expect(screen.queryByTestId('inline-comment-delete-c9')).toBeNull();
  });

  it('renders plain (non-commentable) when onAddComment is absent — Repository page mode', () => {
    render(<FileDiffView patch={PATCH} />);
    expect(screen.queryByTestId('diff-line-comment-src/app.js-new-2')).toBeNull();
    expect(screen.getByText('+const b = 2;')).toBeInTheDocument();
  });
});
