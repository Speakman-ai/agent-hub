import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HandoffCard from './HandoffCard.jsx';

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
});
