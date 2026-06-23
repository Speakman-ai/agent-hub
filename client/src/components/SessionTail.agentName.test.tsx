import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionTail from './SessionTail';

function renderTail(props: any) {
  return render(
    <SessionTail
      message={{ id: 'asst-1', role: 'assistant', content: 'Hi', engine: 'claude-code' }}
      events={[]}
      agentColor="#6366f1"
      streaming
      {...props}
    />,
  );
}

describe('SessionTail header agent name', () => {
  it('renders the agentName prop instead of the literal "Assistant"', () => {
    renderTail({ agentName: 'Agent Hub Dev' });
    expect(screen.getByText('Agent Hub Dev')).toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
  });

  it('prefers message.agent_name over the agentName prop', () => {
    renderTail({
      message: {
        id: 'asst-2',
        role: 'assistant',
        content: 'Hi',
        engine: 'claude-code',
        agent_name: 'Reviewer',
      },
      agentName: 'Agent Hub Dev',
    });
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('Agent Hub Dev')).not.toBeInTheDocument();
  });

  it('falls back to "Assistant" when no name is known', () => {
    renderTail({});
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });
});

describe('SessionTail stored assistant bubble header agent name', () => {
  const verdictJson = JSON.stringify({ verdict: 'approved', threads: [] });
  // Stored bubble renders only when there's prose before a trailing verdict.
  const proseContent = ['Review complete. Ready to ship.', '', verdictJson].join('\n');

  function renderStored(props: any) {
    return render(
      <SessionTail
        message={{
          id: 'm-stored',
          role: 'assistant',
          content: proseContent,
          engine: 'codex-cli',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
        {...props}
      />,
    );
  }

  it('uses fromAgent (the message-anchored agent) before the active-agent fallback', () => {
    // Mislabel risk: a handoff message without agent_name should show the
    // agent that produced it (fromAgent), not the parent/active agent name.
    renderStored({ fromAgent: { name: 'Reviewer' }, agentName: 'Agent Hub Dev' });
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('Agent Hub Dev')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
  });

  it('prefers message.agent_name over fromAgent', () => {
    renderStored({
      message: {
        id: 'm-stored-named',
        role: 'assistant',
        content: proseContent,
        engine: 'codex-cli',
        created_at: '2026-01-01T00:00:00Z',
        agent_name: 'Docs',
      },
      fromAgent: { name: 'Reviewer' },
      agentName: 'Agent Hub Dev',
    });
    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
  });
});
