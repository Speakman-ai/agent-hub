import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Mock the mermaid module so we don't need to spin up a real renderer in jsdom.
// The MermaidDiagram component dynamic-imports 'mermaid' on first use; we stub
// `render` to return a deterministic SVG string so we can assert routing.
(vi as any).mock('mermaid', () => {
  const mermaid = {
    initialize: vi.fn(),
    render: vi.fn(async (id: any, source: any) => ({
      svg: `<svg data-testid="rendered-svg" data-id="${id}" data-source="${source}"></svg>`,
    })),
  };
  return { default: mermaid };
});

import { markdownComponents, fencedCodeLanguage } from './MarkdownRenderer';

describe('fencedCodeLanguage', () => {
  it('extracts the language token from a `language-*` class', () => {
    expect(fencedCodeLanguage('language-mermaid')).toBe('mermaid');
    expect(fencedCodeLanguage('language-ts hljs')).toBe('ts');
  });

  it('returns empty string when no language class is set', () => {
    expect(fencedCodeLanguage('')).toBe('');
    expect(fencedCodeLanguage(undefined)).toBe('');
    expect(fencedCodeLanguage('hljs')).toBe('');
  });

  it('lowercases the language token', () => {
    expect(fencedCodeLanguage('language-Mermaid')).toBe('mermaid');
  });
});

describe('MarkdownRenderer mermaid routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ```mermaid fenced blocks via MermaidDiagram, not CodeBlock', async () => {
    const md = '```mermaid\ngraph TD\nA --> B\n```';
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {md}
      </ReactMarkdown>,
    );

    // Wait for the async dynamic import + render to settle.
    await waitFor(() => {
      expect(container!.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy();
    });

    // Routed away from CodeBlock — no copy button, no `<pre>` wrapper.
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(container!.querySelector('pre')).toBeFalsy();

    // The mocked SVG payload should have been injected.
    await waitFor(() => {
      expect(container!.querySelector('[data-testid="rendered-svg"]')).toBeTruthy();
    });
  });

  it('non-mermaid fenced blocks still render through CodeBlock (no regression)', () => {
    const md = '```ts\nconst x = 1;\nconst y = 2;\n```';
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {md}
      </ReactMarkdown>,
    );

    expect(container!.querySelector('[data-testid="mermaid-diagram"]')).toBeFalsy();
    expect(container!.querySelector('pre')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect((container as any).textContent).toContain('const x = 1');
  });

  it('shows a styled error box if mermaid.render rejects', async () => {
    const mermaidModule = await import('mermaid');
    (mermaidModule.default.render as any).mockRejectedValueOnce(
      new Error('Parse error: bad syntax'),
    );

    const md = '```mermaid\nnot-a-real-diagram\n```';
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {md}
      </ReactMarkdown>,
    );

    await waitFor(() => {
      expect(container!.querySelector('[data-testid="mermaid-error"]')).toBeTruthy();
    });
    expect((container as any).textContent).toContain('Parse error: bad syntax');
    // Original source is preserved in the error box so the user can fix it.
    expect((container as any).textContent).toContain('not-a-real-diagram');
  });
});
