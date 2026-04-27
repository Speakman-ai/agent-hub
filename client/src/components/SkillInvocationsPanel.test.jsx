import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SkillInvocationsPanel from './SkillInvocationsPanel.jsx';

describe('SkillInvocationsPanel', () => {
  it('renders empty state', () => {
    render(<SkillInvocationsPanel invocations={[]} />);
    expect(screen.getByText('No skills loaded in this session yet.')).toBeInTheDocument();
  });

  it('renders rows for loaded/not-found/malformed statuses', () => {
    const rows = [
      {
        id: '1',
        skill_id: 'kanban',
        source: 'project',
        status: 'loaded',
        reason: 'need board APIs',
        injected_bytes: 4096,
        created_at: '2026-04-21T17:00:00Z',
      },
      {
        id: '2',
        skill_id: 'missing-skill',
        source: null,
        status: 'not-found',
        reason: null,
        injected_bytes: 0,
        created_at: '2026-04-21T16:59:00Z',
      },
      {
        id: '3',
        skill_id: '(malformed)',
        source: null,
        status: 'malformed',
        reason: null,
        injected_bytes: 0,
        created_at: '2026-04-21T16:58:00Z',
      },
    ];

    render(<SkillInvocationsPanel invocations={rows} />);

    expect(screen.getByText('kanban')).toBeInTheDocument();
    expect(screen.getByText('missing-skill')).toBeInTheDocument();
    expect(screen.getByText('(malformed)')).toBeInTheDocument();

    expect(screen.getByTestId('skill-status-loaded')).toBeInTheDocument();
    expect(screen.getByTestId('skill-status-not-found')).toBeInTheDocument();
    expect(screen.getByTestId('skill-status-malformed')).toBeInTheDocument();
  });

  it('applies status pill classes by status', () => {
    const rows = [
      {
        id: '1',
        skill_id: 'ok',
        source: 'project',
        status: 'loaded',
        injected_bytes: 100,
        created_at: '2026-04-21T17:00:00Z',
      },
      {
        id: '2',
        skill_id: 'missing',
        source: null,
        status: 'not-found',
        injected_bytes: 0,
        created_at: '2026-04-21T16:00:00Z',
      },
      {
        id: '3',
        skill_id: 'bad',
        source: null,
        status: 'malformed',
        injected_bytes: 0,
        created_at: '2026-04-21T15:00:00Z',
      },
    ];

    render(<SkillInvocationsPanel invocations={rows} />);

    expect(screen.getByTestId('skill-status-loaded').className).toContain('text-emerald-300');
    expect(screen.getByTestId('skill-status-not-found').className).toContain('text-amber-300');
    expect(screen.getByTestId('skill-status-malformed').className).toContain('text-red-300');
  });

  it('dedupes repeated invocations of the same skill, keeping the most recent row', () => {
    // Simulates an agent loading the same skill multiple times across turns
    // (e.g., hot-reload). The sidebar must collapse to one entry per skill_id.
    const rows = [
      {
        id: '1',
        skill_id: 'kanban',
        source: 'project',
        status: 'not-found',
        injected_bytes: 0,
        created_at: '2026-04-21T16:55:00Z',
      },
      {
        id: '2',
        skill_id: 'kanban',
        source: 'project',
        status: 'loaded',
        injected_bytes: 4096,
        created_at: '2026-04-21T17:05:00Z',
      },
      {
        id: '3',
        skill_id: 'kanban',
        source: 'project',
        status: 'loaded',
        injected_bytes: 4096,
        created_at: '2026-04-21T17:00:00Z',
      },
      {
        id: '4',
        skill_id: 'wiki-search',
        source: 'default',
        status: 'loaded',
        injected_bytes: 2048,
        created_at: '2026-04-21T17:02:00Z',
      },
    ];

    render(<SkillInvocationsPanel invocations={rows} />);

    // Exactly one entry per skill_id.
    expect(screen.getAllByText('kanban')).toHaveLength(1);
    expect(screen.getAllByText('wiki-search')).toHaveLength(1);
    // Most recent kanban row wins (id=2 -> status 'loaded'), so the 'not-found'
    // pill from the older invocation is gone.
    expect(screen.queryByTestId('skill-status-not-found')).toBeNull();
    expect(screen.getAllByTestId('skill-status-loaded')).toHaveLength(2);
  });
});
