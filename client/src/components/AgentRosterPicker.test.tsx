import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentRosterPicker from './AgentRosterPicker';

const agents = [
  { id: 'hub-lead', name: 'Hub Lead' },
  { id: 'hub-backend', name: 'Hub Backend' },
  { id: 'hub-frontend', name: 'Hub Frontend' },
];

function baseRoster() {
  return [
    {
      trackId: 'architect',
      label: 'Architect',
      rationale: 'Owns high-level design.',
      agentId: 'hub-lead',
      custom: false,
    },
    {
      trackId: 'backend',
      label: 'Backend',
      rationale: 'Server / API.',
      agentId: null,
      custom: false,
    },
  ];
}

describe('AgentRosterPicker — createAgents mode', () => {
  it('renders name inputs instead of an agent dropdown', () => {
    render(
      <AgentRosterPicker
        roster={[
          {
            trackId: 'backend',
            label: 'Backend',
            rationale: 'API work',
            agentName: 'Scrabble Backend',
            custom: true,
          },
        ]}
        createAgents
        projectName="Scrabble"
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('roster-agent-name-backend')).toBeInTheDocument();
    expect(screen.queryByTestId('roster-agent-backend')).not.toBeInTheDocument();
    expect((screen.getByTestId('roster-agent-name-backend') as any).value).toBe('Scrabble Backend');
  });

  it('fires onChange when an agent name is edited', () => {
    const onChange = vi.fn();
    render(
      <AgentRosterPicker
        roster={[
          {
            trackId: 'qa',
            label: 'QA',
            rationale: 'Tests',
            agentName: 'Scrabble QA',
            custom: true,
          },
        ]}
        createAgents
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('roster-agent-name-qa' as any), {
      target: { value: 'Scrabble Test Lead' },
    });
    expect((onChange as any).mock.calls[0][0][0].agentName).toBe('Scrabble Test Lead');
  });
});

describe('AgentRosterPicker — assign existing agents', () => {
  it('renders one row per track with label + rationale', () => {
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={() => {}} />);
    expect(screen.getByTestId('roster-row-architect')).toBeInTheDocument();
    expect(screen.getByTestId('roster-row-backend')).toBeInTheDocument();
    expect(screen.getByText('Owns high-level design.')).toBeInTheDocument();
  });

  it('preselects the suggested agent for each row', () => {
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={() => {}} />);
    expect((screen.getByTestId('roster-agent-architect') as any).value).toBe('hub-lead');
    expect((screen.getByTestId('roster-agent-backend') as any).value).toBe('');
  });

  it('fires onChange with the updated roster when a row is reassigned', () => {
    const onChange = vi.fn();
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('roster-agent-backend' as any), {
      target: { value: 'hub-backend' },
    });
    expect(onChange!).toHaveBeenCalledTimes(1);
    const next = (onChange as any).mock.calls[0][0];
    expect(next.find((r: any) => r.trackId === 'backend').agentId).toBe('hub-backend');
    // Architect row unchanged.
    expect(next.find((r: any) => r.trackId === 'architect').agentId).toBe('hub-lead');
  });

  it('clearing the select assigns null', () => {
    const onChange = vi.fn();
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('roster-agent-architect' as any), {
      target: { value: '' },
    });
    const next = (onChange as any).mock.calls[0][0];
    expect(next.find((r: any) => r.trackId === 'architect').agentId).toBeNull();
  });

  it('adds a custom track via the Add button', () => {
    const onChange = vi.fn();
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('roster-custom-label' as any), {
      target: { value: 'Docs' },
    });
    fireEvent.click(screen.getByTestId('roster-custom-add' as any) as any);
    expect(onChange!).toHaveBeenCalledTimes(1);
    const next = (onChange as any).mock.calls[0][0];
    expect(next!).toHaveLength(3);
    expect(next[2].label).toBe('Docs');
    expect(next[2].custom).toBe(true);
  });

  it('adds a custom track via Enter key', () => {
    const onChange = vi.fn();
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={onChange} />);
    const input = screen.getByTestId('roster-custom-label');
    fireEvent.change(input, { target: { value: 'QA Lead' } } as any);
    fireEvent.keyDown(input, { key: 'Enter' } as any);
    expect(onChange!).toHaveBeenCalledTimes(1);
    expect((onChange as any).mock.calls[0][0][2].label).toBe('QA Lead');
  });

  it('disables Add when label is empty or whitespace', () => {
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={() => {}} />);
    const btn = screen.getByTestId('roster-custom-add');
    expect(btn!).toBeDisabled();
    fireEvent.change(screen.getByTestId('roster-custom-label' as any), {
      target: { value: '   ' },
    });
    expect(btn!).toBeDisabled();
  });

  it('custom rows expose a remove button that fires onChange', () => {
    const onChange = vi.fn();
    const roster = [
      ...baseRoster(),
      {
        trackId: 'custom-1',
        label: 'Docs',
        rationale: 'Custom track',
        agentId: null,
        custom: true,
      },
    ];
    render(<AgentRosterPicker roster={roster} agents={agents} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('roster-remove-custom-1' as any) as any);
    const next = (onChange as any).mock.calls[0][0];
    expect(next.find((r: any) => r.trackId === 'custom-1')).toBeUndefined();
    expect(next!).toHaveLength(2);
  });

  it('non-custom rows do not render a remove button', () => {
    render(<AgentRosterPicker roster={baseRoster()} agents={agents} onChange={() => {}} />);
    expect(screen.queryByTestId('roster-remove-architect')).not.toBeInTheDocument();
  });

  it('renders empty state when roster is empty', () => {
    render(<AgentRosterPicker roster={[]} agents={agents} onChange={() => {}} />);
    expect(screen.getByTestId('roster-empty')).toBeInTheDocument();
  });

  it('disables inputs when disabled=true', () => {
    render(
      <AgentRosterPicker roster={baseRoster()} agents={agents} onChange={() => {}} disabled />,
    );
    expect(screen.getByTestId('roster-agent-architect')).toBeDisabled();
    expect(screen.getByTestId('roster-custom-label')).toBeDisabled();
    expect(screen.getByTestId('roster-custom-add')).toBeDisabled();
  });
});
