import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionTail from './SessionTail';

const TEXT =
  'One finding is wrong.\n\n<agenthub:review-dispute>{"disputes":[{"file_path":"backend/dxf.mjs",' +
  '"line_start":1015,"line_end":1025,"reason":"This is a required fix, not drift."}]}' +
  '</agenthub:review-dispute>';

describe('SessionTail — review dispute block', () => {
  it('renders the dispute as a card instead of raw tag text', () => {
    const { container } = render(
      <SessionTail
        message={{ id: 'm-dispute', role: 'assistant', content: TEXT }}
        events={[{ seq: 1, event: { type: 'assistant_text', text: TEXT } }]}
        agentColor="#6366f1"
        agentName="Ada"
      />,
    );
    expect(screen.getByTestId('review-dispute-card')).toBeTruthy();
    expect(screen.getByText('Disputed 1 review finding')).toBeTruthy();
    expect(screen.getByText('backend/dxf.mjs:1015-1025')).toBeTruthy();
    expect(screen.getByText('This is a required fix, not drift.')).toBeTruthy();
    expect(screen.getByText('One finding is wrong.')).toBeTruthy();
    expect(container.textContent).not.toContain('agenthub:review-dispute');
    expect(container.textContent).not.toContain('"disputes"');
  });

  it('renders the card for a stored message with no events', () => {
    const { container } = render(
      <SessionTail
        message={{ id: 'm-dispute-stored', role: 'assistant', content: TEXT }}
        events={[]}
        agentColor="#6366f1"
        agentName="Ada"
      />,
    );
    expect(screen.getByTestId('review-dispute-card')).toBeTruthy();
    expect(container.textContent).not.toContain('agenthub:review-dispute');
  });
});
