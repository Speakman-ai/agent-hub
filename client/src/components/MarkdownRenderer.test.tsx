import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  MarkdownContent,
  markdownComponents,
  markdownComponentsKanbanCardSnippet,
} from './MarkdownRenderer';

// Remote mode: server lives on a different origin than the web app, so
// server-relative /uploads refs must be prefixed with the server base.
(vi as any).mock('../utils/connection.js', () => ({
  getServerBase: () => 'https://hub.example.com',
}));

describe('MarkdownRenderer — server-hosted image resolution', () => {
  // Regression guard for converted support-ticket cards: the ticket → card
  // conversion embeds the screenshot as `![screenshot](/uploads/...)`, and the
  // card detail view renders the description with the default components. The
  // img handler must resolve the /uploads ref against the server origin so the
  // screenshot is fetchable in remote mode (not the web-app origin).
  it('resolves a /uploads screenshot ref in the default (card detail) components', () => {
    const { container } = render(
      <MarkdownContent
        content={'![screenshot](/uploads/support-screenshot-abc.png)'}
        components={markdownComponents}
      />,
    );
    const img = container.querySelector('img');
    expect(img!).toBeTruthy();
    expect(img.getAttribute('src')).toBe(
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );
  });

  it('resolves a /uploads screenshot ref in the kanban card snippet components', () => {
    const { container } = render(
      <MarkdownContent
        content={'![screenshot](/uploads/support-screenshot-abc.png)'}
        components={markdownComponentsKanbanCardSnippet}
        rehypePlugins={[]}
      />,
    );
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe(
      'https://hub.example.com/uploads/support-screenshot-abc.png',
    );
  });
});
