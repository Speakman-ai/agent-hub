import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ForwardDesignModal, { filterDesignForwardTargets } from './ForwardDesignModal.jsx';

describe('filterDesignForwardTargets', () => {
  const agents = [
    { id: 'x', name: 'Other', projectId: 'p2', active: true, engine: 'claude-code', color: '#000' },
    { id: 'y', name: 'Hub', projectId: 'p1', active: true, engine: 'claude-code', color: '#fff' },
    {
      id: 'z',
      name: 'Inactive',
      projectId: 'p1',
      active: false,
      engine: 'claude-code',
      color: '#999',
    },
  ];

  it('returns all active agents when the design has no linked projects', () => {
    const design = { id: 'd', name: 'D', linkedProjects: [] };
    const out = filterDesignForwardTargets(agents, design);
    expect(out.map((a) => a.id)).toEqual(['x', 'y']);
  });

  it('prefers agents whose project is linked to the design', () => {
    const design = { id: 'd', name: 'D', linkedProjects: [{ id: 'p1', name: 'Hub' }] };
    const out = filterDesignForwardTargets(agents, design);
    expect(out.map((a) => a.id)).toEqual(['y']);
  });

  it('falls back to all active agents when linked projects have no matching agents', () => {
    const design = { id: 'd', name: 'D', linkedProjects: [{ id: 'p99', name: 'Ghost' }] };
    const out = filterDesignForwardTargets(agents, design);
    expect(out.map((a) => a.id)).toEqual(['x', 'y']);
  });
});

describe('<ForwardDesignModal />', () => {
  const design = { id: 'd-1', name: 'Landing', linkedProjects: [] };
  const agents = [
    { id: 'a1', name: 'Dev', engine: 'claude-code', projectId: 'p1', color: '#0f0', active: true },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('submits with selected agent and optional flags', async () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 's1' } }));
    const onForwarded = vi.fn();
    const onClose = vi.fn();

    render(
      <ForwardDesignModal
        design={design}
        agents={agents}
        onClose={onClose}
        onForward={onForward}
        onForwarded={onForwarded}
      />,
    );

    fireEvent.click(screen.getByText('Dev'));
    fireEvent.click(screen.getByLabelText(/include design chat transcript/i));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

    await waitFor(() => {
      expect(onForward).toHaveBeenCalledWith(
        expect.objectContaining({
          targetAgentId: 'a1',
          includeMessages: false,
          includeFiles: true,
        }),
      );
      expect(onForwarded).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});
