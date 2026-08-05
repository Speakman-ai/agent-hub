import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { markdownComponents } from './MarkdownRenderer';
import { RunInTerminalProvider } from './RunInTerminalContext';

function renderMarkdown(md: string, onRun: ((command: string) => void) | null) {
  return render(
    <RunInTerminalProvider onRun={onRun}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {md}
      </ReactMarkdown>
    </RunInTerminalProvider>,
  );
}

describe('CodeBlock "Run in terminal"', () => {
  it('is absent with no provider — the wiki/kanban/PR views have no terminal', () => {
    render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {'```sh\nnpm test\n```'}
      </ReactMarkdown>,
    );
    expect(screen.queryByTestId('code-block-run-in-terminal')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('is absent when the provider has no handler (workflow project / consult mode)', () => {
    renderMarkdown('```sh\nnpm test\n```', null);
    expect(screen.queryByTestId('code-block-run-in-terminal')).not.toBeInTheDocument();
  });

  it('sends the fence body verbatim, trailing fence newline stripped', () => {
    const onRun = vi.fn();
    renderMarkdown('```sh\nnpm test\n```', onRun);

    fireEvent.click(screen.getByTestId('code-block-run-in-terminal'));

    expect(onRun).toHaveBeenCalledWith('npm test');
  });

  it('appears on an untagged fence — the reported case had no language tag', () => {
    const onRun = vi.fn();
    const command = 'python manage.py shell -c "\nfrom research.models import Plat\nprint(Plat)\n"';
    renderMarkdown(`\`\`\`\n${command}\n\`\`\``, onRun);

    fireEvent.click(screen.getByTestId('code-block-run-in-terminal'));

    // Multi-line commands are handed over whole; the pane pastes them as one
    // buffer rather than executing line by line.
    expect(onRun).toHaveBeenCalledWith(command);
  });

  it('is absent on inline code', () => {
    renderMarkdown('Run `npm test` now.', vi.fn());
    expect(screen.queryByTestId('code-block-run-in-terminal')).not.toBeInTheDocument();
  });

  it('confirms the hand-off, then reverts the label', () => {
    vi.useFakeTimers();
    try {
      renderMarkdown('```sh\nnpm test\n```', vi.fn());

      const button = screen.getByTestId('code-block-run-in-terminal');
      fireEvent.click(button);
      expect(button).toHaveTextContent('✓ Sent');

      act(() => vi.advanceTimersByTime(2_000));
      expect(button).toHaveTextContent('Run in terminal');
    } finally {
      vi.useRealTimers();
    }
  });
});
