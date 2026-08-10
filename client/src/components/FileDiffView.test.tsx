import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileDiffView from './FileDiffView';

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
        defaultOpen
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
    render(<FileDiffView patch={PATCH} defaultOpen comments={[]} onAddComment={onAddComment} />);

    // '+const b = 2;' is new-file line 2.
    fireEvent.click(screen.getByTestId('diff-line-comment-src/app.js-new-2' as any) as any);
    const composer = screen.getByTestId('inline-comment-composer');
    fireEvent.change(composer.querySelector('textarea' as any), {
      target: { value: 'tighten this' },
    });
    fireEvent.click(screen.getByTestId('inline-comment-submit' as any) as any);

    await waitFor(() =>
      expect(onAddComment!).toHaveBeenCalledWith({
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
    render(<FileDiffView patch={PATCH} defaultOpen comments={[]} onAddComment={vi.fn()} />);
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
        defaultOpen
        comments={[comment]}
        onAddComment={vi.fn()}
        onDeleteComment={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-comment-delete-c9' as any) as any);
    expect(onDelete!).toHaveBeenCalledWith(expect.objectContaining({ id: 'c9' }));

    rerender(<FileDiffView patch={PATCH} defaultOpen comments={[comment]} />);
    expect(screen.queryByTestId('inline-comment-delete-c9')).toBeNull();
  });

  it('renders plain (non-commentable) when onAddComment is absent — Repository page mode', () => {
    render(<FileDiffView patch={PATCH} defaultOpen />);
    expect(screen.queryByTestId('diff-line-comment-src/app.js-new-2')).toBeNull();
    expect(screen.getByText('+const b = 2;')).toBeInTheDocument();
  });

  it('keeps every file section collapsed by default', () => {
    render(<FileDiffView patch={PATCH} />);
    expect(screen.queryByText('+const b = 2;')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('commit-file-src/app.js' as any) as any);
    expect(screen.getByText('+const b = 2;')).toBeInTheDocument();
  });
});

describe('FileDiffView resolved comment threads', () => {
  const thread = (over: any = {}) => ({
    id: 'c1',
    user: 'ryan',
    file_path: 'src/app.js',
    line: 2,
    side: 'new',
    body: 'why 2?',
    created_at: '2026-06-10T00:00:00Z',
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    ...over,
  });

  it('collapses a resolved thread to a summary row and expands it on Show', () => {
    render(
      <FileDiffView
        patch={PATCH}
        defaultOpen
        comments={[thread({ resolved: true, resolved_by: 'kevin' })]}
        onAddComment={vi.fn()}
        onSetResolved={vi.fn()}
      />,
    );
    const summary = screen.getByTestId('inline-comment-thread-resolved-src/app.js-new-2');
    expect(summary).toHaveTextContent('@kevin marked this conversation as resolved');
    expect(summary).toHaveTextContent('1 comment');
    expect(screen.queryByTestId('inline-comment-c1')).toBeNull();
    // File header advertises the resolved thread alongside the comment count.
    expect(screen.getByTestId('diff-file-resolved-count-src/app.js')).toHaveTextContent(
      '1 resolved',
    );

    fireEvent.click(
      screen.getByTestId('inline-comment-thread-show-src/app.js-new-2' as any) as any,
    );
    expect(screen.getByTestId('inline-comment-c1')).toHaveTextContent('why 2?');
  });

  it('resolves an open thread with its anchor and collapses it', async () => {
    const onSetResolved = vi.fn(async () => {});
    const { rerender } = render(
      <FileDiffView
        patch={PATCH}
        defaultOpen
        comments={[thread()]}
        onAddComment={vi.fn()}
        onSetResolved={onSetResolved}
      />,
    );
    expect(screen.getByTestId('inline-comment-c1')).toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId('inline-comment-thread-toggle-src/app.js-new-2' as any) as any,
    );
    await waitFor(() =>
      expect(onSetResolved!).toHaveBeenCalledWith({
        filePath: 'src/app.js',
        line: 2,
        side: 'new',
        resolved: true,
      }),
    );

    // The refetched detail comes back resolved — the thread collapses.
    rerender(
      <FileDiffView
        patch={PATCH}
        defaultOpen
        comments={[thread({ resolved: true, resolved_by: 'ryan' })]}
        onAddComment={vi.fn()}
        onSetResolved={onSetResolved}
      />,
    );
    expect(screen.queryByTestId('inline-comment-c1')).toBeNull();
    expect(
      screen.getByTestId('inline-comment-thread-resolved-src/app.js-new-2'),
    ).toBeInTheDocument();
  });

  it('unresolves from the expanded thread', async () => {
    const onSetResolved = vi.fn(async () => {});
    render(
      <FileDiffView
        patch={PATCH}
        defaultOpen
        comments={[thread({ resolved: true, resolved_by: 'kevin' })]}
        onAddComment={vi.fn()}
        onSetResolved={onSetResolved}
      />,
    );
    fireEvent.click(
      screen.getByTestId('inline-comment-thread-show-src/app.js-new-2' as any) as any,
    );
    fireEvent.click(
      screen.getByTestId('inline-comment-thread-toggle-src/app.js-new-2' as any) as any,
    );
    await waitFor(() =>
      expect(onSetResolved!).toHaveBeenCalledWith({
        filePath: 'src/app.js',
        line: 2,
        side: 'new',
        resolved: false,
      }),
    );
  });

  it('groups every comment on one anchor into a single thread', () => {
    render(
      <FileDiffView
        patch={PATCH}
        defaultOpen
        comments={[
          thread({ resolved: true, resolved_by: 'kevin' }),
          thread({ id: 'c2', body: 'agreed', resolved: true, resolved_by: 'kevin' }),
        ]}
        onAddComment={vi.fn()}
        onSetResolved={vi.fn()}
      />,
    );
    expect(screen.getByTestId('inline-comment-thread-resolved-src/app.js-new-2')).toHaveTextContent(
      '2 comments',
    );
  });

  it('hides the resolve control when no handler is provided', () => {
    render(<FileDiffView patch={PATCH} defaultOpen comments={[thread()]} onAddComment={vi.fn()} />);
    expect(screen.getByTestId('inline-comment-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-comment-thread-toggle-src/app.js-new-2')).toBeNull();
  });
});
