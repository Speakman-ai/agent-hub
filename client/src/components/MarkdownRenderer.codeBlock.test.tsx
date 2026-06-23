import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { markdownComponents, markdownComponentsCompact } from './MarkdownRenderer';

describe('MarkdownRenderer fenced code blocks', () => {
  it('renders inline backticks as inline code, not CodeBlock', () => {
    const md = 'Use `npm test` here.';
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {md}
      </ReactMarkdown>,
    );
    expect(container!.querySelector('pre')).toBeFalsy();
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    const codes = container.querySelectorAll('code');
    expect(codes.length).toBe(1);
    expect(codes[0].textContent).toBe('npm test');
  });

  it('uses CodeBlock (pre + copy) for single-line fenced code — no inner newline', () => {
    const md = '```ts\nconst x = 1\n```';
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {md}
      </ReactMarkdown>,
    );
    expect(container!.querySelector('pre')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect((container as any).textContent).toContain('const x = 1');
  });

  it('markdownComponentsCompact wraps fenced code in pre even for one line', () => {
    const md = '```diff\n- a\n+ b\n```';
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponentsCompact}
      >
        {md}
      </ReactMarkdown>,
    );
    const pres = container.querySelectorAll('pre');
    expect(pres.length).toBeGreaterThanOrEqual(1);
  });
});
