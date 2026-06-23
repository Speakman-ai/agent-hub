import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HandoffCard from './HandoffCard';

const AGENTS = [
  { id: 'hub-frontend', name: 'Hub Frontend', color: '#22d3ee' },
  { id: 'hub-backend', name: 'Hub Backend', color: '#a78bfa' },
];

describe('HandoffCard', () => {
  it('renders the from→to agents using the agents lookup', () => {
    render(
      <HandoffCard
        toAgentId="hub-backend"
        note="please ship the fix"
        fromAgent={{ name: 'Hub Frontend', color: '#22d3ee' }}
        agents={AGENTS}
      />,
    );
    expect(screen.getByText('Handoff')).toBeInTheDocument();
    expect(screen.getByText('Hub Frontend')).toBeInTheDocument();
    expect(screen.getByText('Hub Backend')).toBeInTheDocument();
  });

  it('falls back to the raw agent id when the agent is not in the lookup', () => {
    render(
      <HandoffCard
        toAgentId="ghost-agent"
        note="..."
        fromAgent={{ name: 'Hub Frontend', color: '#22d3ee' }}
        agents={AGENTS}
      />,
    );
    expect(screen.getByText('ghost-agent')).toBeInTheDocument();
  });

  it('renders the note as markdown (not raw text)', () => {
    render(
      <HandoffCard
        toAgentId="hub-backend"
        note={'Done discovery.\n\n- bullet **one**\n- bullet *two*'}
        agents={AGENTS}
      />,
    );
    const note = screen.getByTestId('handoff-note');
    // Markdown should produce list items + a strong tag.
    expect(note.querySelectorAll('li').length).toBe(2);
    expect(note.querySelector('strong')).not.toBeNull();
  });

  it('omits the from-agent chip when fromAgent is not provided', () => {
    render(<HandoffCard toAgentId="hub-backend" note="x" agents={AGENTS} />);
    // Only the to-agent (Hub Backend) chip should appear.
    expect(screen.queryByText('Hub Frontend')).not.toBeInTheDocument();
    expect(screen.getByText('Hub Backend')).toBeInTheDocument();
  });

  it('renders an "Open session" button when the handoff row has a to_session_id', () => {
    const onOpen = vi.fn();
    render(
      <HandoffCard
        toAgentId="hub-backend"
        note="do the thing"
        agents={AGENTS}
        handoff={{
          id: 'h1',
          to_agent_id: 'hub-backend',
          to_session_id: 'sess-abc',
          status: 'delivered',
        }}
        onOpenSession={onOpen}
      />,
    );
    const btn = screen.getByTestId('handoff-open-session');
    expect(btn!).toBeInTheDocument();
    fireEvent.click(btn as any);
    expect(onOpen!).toHaveBeenCalledWith('hub-backend', 'sess-abc');
  });

  it("uses the handoff row's resolved to_agent_id instead of the raw block id", () => {
    // Simulates the server fuzzy-resolving "agent-hub-backend" → "hub-backend".
    render(
      <HandoffCard
        toAgentId="agent-hub-backend"
        note="x"
        agents={AGENTS}
        handoff={{
          id: 'h1',
          to_agent_id: 'hub-backend',
          to_session_id: 'sess-xyz',
          status: 'delivered',
        }}
        onOpenSession={() => {}}
      />,
    );
    // Should show "Hub Backend" (resolved), not the raw "agent-hub-backend".
    expect(screen.getByText('Hub Backend')).toBeInTheDocument();
    expect(screen.queryByText('agent-hub-backend')).not.toBeInTheDocument();
  });

  it('does not render the link when onOpenSession is missing', () => {
    render(
      <HandoffCard
        toAgentId="hub-backend"
        note="x"
        agents={AGENTS}
        handoff={{
          id: 'h1',
          to_agent_id: 'hub-backend',
          to_session_id: 'sess-abc',
          status: 'delivered',
        }}
      />,
    );
    expect(screen.queryByTestId('handoff-open-session')).not.toBeInTheDocument();
  });

  it('renders a "Failed" badge when the handoff row has status=failed', () => {
    render(
      <HandoffCard
        toAgentId="hub-backend"
        note="x"
        agents={AGENTS}
        handoff={{
          id: 'h1',
          to_agent_id: 'hub-backend',
          to_session_id: null,
          status: 'failed',
          error: 'Unknown target agent: agent-hub-backend',
        }}
        onOpenSession={() => {}}
      />,
    );
    expect(screen.getByTestId('handoff-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('handoff-open-session')).not.toBeInTheDocument();
  });

  it('renders for a malformed block — falls back to "(unknown)" target and shows the failure reason', () => {
    // Regression for the "handoffs intermittent — widget missing when they
    // fail" bug: SessionTail now synthesizes a failed handoff row when a
    // <handoff> block fails to parse client-side. HandoffCard must still
    // render correctly with '(unknown)' as the toAgentId so the user sees
    // *something* explaining the failure.
    render(
      <HandoffCard
        toAgentId="(unknown)"
        note='{"toAgent":"x" INVALID}'
        agents={AGENTS}
        handoff={{
          id: null,
          to_agent_id: null,
          to_session_id: null,
          status: 'failed',
          error: 'Handoff block contains invalid JSON',
        }}
      />,
    );
    expect(screen.getByTestId('handoff-card')).toBeInTheDocument();
    const failed = screen.getByTestId('handoff-failed');
    expect(failed!).toBeInTheDocument();
    expect((failed as any).textContent).toMatch(/invalid json/i);
  });
});
