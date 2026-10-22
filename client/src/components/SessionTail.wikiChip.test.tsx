import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionTail from './SessionTail';

const consulted = JSON.stringify({
  wikiRag: {
    status: 'consulted',
    retrieved: 2,
    query: 'graph rag',
    pages: [
      {
        title: 'Wiki Hybrid Semantic Search',
        slug: 'wiki-hybrid',
        category: 'architecture',
        score: 0.5,
      },
      { title: 'Code RAG', slug: 'code-rag', category: 'architecture', score: 0.4 },
    ],
  },
});

const textEvents = [
  { event: { type: 'assistant_text', text: 'Here is the answer.' }, timestamp: 1 },
];

function renderTail(props: any) {
  return render(
    <SessionTail
      message={{
        id: 'asst-1',
        role: 'assistant',
        content: 'Here is the answer.',
        engine: 'claude-code',
      }}
      agentColor="#6366f1"
      {...props}
    />,
  );
}

describe('SessionTail wiki-RAG chip', () => {
  it('shows the consulted chip under a finished timeline turn', () => {
    renderTail({
      events: textEvents,
      streaming: false,
      message: {
        id: 'asst-1',
        role: 'assistant',
        content: 'Here is the answer.',
        metadata: consulted,
      },
    });
    expect(screen.getByText(/Consulted wiki · 2 pages/)).toBeInTheDocument();
  });

  it('shows the chip on the stored-bubble fallback (no events)', () => {
    renderTail({
      events: [],
      streaming: false,
      message: { id: 'asst-2', role: 'assistant', content: 'Stored reply.', metadata: consulted },
    });
    expect(screen.getByText('Stored reply.')).toBeInTheDocument();
    expect(screen.getByText(/Consulted wiki · 2 pages/)).toBeInTheDocument();
  });

  it('shows the no-match variant', () => {
    renderTail({
      events: textEvents,
      streaming: false,
      message: {
        id: 'asst-3',
        role: 'assistant',
        content: 'x',
        metadata: { wikiRag: { status: 'no_match', retrieved: 0, pages: [], query: 'q' } },
      },
    });
    expect(screen.getByText(/Wiki checked · no strong match/)).toBeInTheDocument();
  });

  it('hides the chip while streaming', () => {
    renderTail({
      events: textEvents,
      streaming: true,
      message: { id: 'asst-4', role: 'assistant', content: '', metadata: consulted },
    });
    expect(screen.queryByText(/Consulted wiki/)).not.toBeInTheDocument();
  });

  it('renders nothing extra when metadata has no wikiRag', () => {
    renderTail({ events: textEvents, streaming: false });
    expect(screen.queryByText(/Consulted wiki|Wiki checked/)).not.toBeInTheDocument();
  });
});
