import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import ChatMessage from './ChatMessage';

// The AskUserQuestion picker sends the answer back as a normal chat message
// whose only payload is an `agenthub:ask:answer` fenced block. The picker
// itself already flips to "Answers submitted", so the message bubble is
// redundant and must be suppressed — including when the answer was queued
// because the turn was still wrapping up (support ticket 94a1653c: users saw
// a confusing empty "Queued" bubble after every answer).
const ANSWER_CONTENT = [
  'Here are my answers:',
  '',
  '```agenthub:ask:answer',
  '{ "askId": "ask-1", "answers": { "Q": "A" }, "annotations": {} }',
  '```',
].join('\n');

describe('ChatMessage ask-answer suppression', () => {
  const base = {
    id: 'msg-ask',
    role: 'user',
    content: ANSWER_CONTENT,
    created_at: new Date().toISOString(),
  };

  it('suppresses a plain ask-answer-only bubble', () => {
    const { container } = render(<ChatMessage message={base} agentColor="#6366f1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('suppresses a queued ask-answer-only bubble (no empty Queued bubble)', () => {
    const { container, queryByText } = render(
      <ChatMessage
        message={{ ...base, queued: true }}
        agentColor="#6366f1"
        onEditQueued={vi.fn()}
        onDequeue={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(queryByText('Queued')).toBeNull();
  });

  it('suppresses a queued ask-answer-only bubble while streaming', () => {
    const { container } = render(
      <ChatMessage
        message={{ ...base, queued: true }}
        agentColor="#6366f1"
        inFlightWhileStreaming
        onInterrupt={vi.fn()}
        onDequeue={vi.fn()}
        onEditInComposer={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does NOT suppress an interrupted ask-answer-only bubble', () => {
    // An interrupt is the user's only visible signal that delivery cut off the
    // running turn — hiding it would strip recovery context. Reviewer feedback
    // on the queued-suppression fix: keep the interrupted bubble.
    const { getByText } = render(
      <ChatMessage message={{ ...base, interrupted: true }} agentColor="#6366f1" />,
    );
    expect(getByText('Interrupted')).toBeInTheDocument();
  });

  it('still renders a queued message that carries real prose', () => {
    const { getByText } = render(
      <ChatMessage
        message={{ ...base, content: 'A real follow-up', queued: true }}
        agentColor="#6366f1"
        onEditQueued={vi.fn()}
        onDequeue={vi.fn()}
      />,
    );
    expect(getByText('A real follow-up')).toBeInTheDocument();
  });
});
