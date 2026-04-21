import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SkillInvocationsPanel, { formatInjectedBytes } from './SkillInvocationsPanel.jsx';

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
});

describe('formatInjectedBytes', () => {
  it('formats byte sizes', () => {
    expect(formatInjectedBytes(0)).toBe('');
    expect(formatInjectedBytes(512)).toBe('512 B');
    expect(formatInjectedBytes(4096)).toBe('4.0 KB');
    expect(formatInjectedBytes(2_000_000)).toBe('1.9 MB');
  });
});
