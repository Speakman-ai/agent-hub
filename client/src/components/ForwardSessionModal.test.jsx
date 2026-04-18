import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ForwardSessionModal, { filterForwardTargets } from './ForwardSessionModal.jsx';

const source = {
  id: 'src-1',
  name: 'Hub Frontend',
  projectId: 'proj-a',
  active: true,
  engine: 'claude-code',
  color: '#ff0',
};

const siblingA = {
  id: 'sib-a',
  name: 'Hub Backend',
  projectId: 'proj-a',
  active: true,
  engine: 'claude-code',
  color: '#0f0',
};

const siblingB = {
  id: 'sib-b',
  name: 'Hub Lead',
  projectId: 'proj-a',
  active: true,
  engine: 'claude-code',
  color: '#00f',
};

const otherProject = {
  id: 'other-1',
  name: 'Side Project Agent',
  projectId: 'proj-b',
  active: true,
  engine: 'claude-code',
  color: '#f0f',
};

const inactive = {
  id: 'inactive-1',
  name: 'Retired',
  projectId: 'proj-a',
  active: false,
  engine: 'claude-code',
  color: '#888',
};

describe('filterForwardTargets', () => {
  it('returns only agents in the same project, excluding the source', () => {
    const agents = [source, siblingA, siblingB, otherProject, inactive];
    const result = filterForwardTargets(agents, source);
    const ids = result.map((a) => a.id);
    expect(ids).toEqual(['sib-a', 'sib-b']);
  });

  it('excludes inactive agents even if they share the project', () => {
    const result = filterForwardTargets([source, inactive], source);
    expect(result).toEqual([]);
  });

  it('returns an empty list when the source has no projectId', () => {
    const result = filterForwardTargets([source, siblingA], { id: 'x', active: true });
    expect(result).toEqual([]);
  });

  it('returns an empty list when the source agent is missing', () => {
    expect(filterForwardTargets([source, siblingA], null)).toEqual([]);
  });

  it('is a no-op on non-array input', () => {
    expect(filterForwardTargets(null, source)).toEqual([]);
  });
});

describe('<ForwardSessionModal />', () => {
  it('renders only same-project candidates in the picker', () => {
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, siblingA, siblingB, otherProject, inactive]}
        sessionId="session-1"
        onClose={() => {}}
        onForward={() => Promise.resolve({})}
      />,
    );
    expect(screen.getByText('Hub Backend')).toBeTruthy();
    expect(screen.getByText('Hub Lead')).toBeTruthy();
    expect(screen.queryByText('Side Project Agent')).toBeNull();
    expect(screen.queryByText('Retired')).toBeNull();
    // Source agent itself is hidden from the list
    expect(screen.queryByText('Hub Frontend')).toBeNull();
  });

  it('shows an empty-state message when no sibling agents exist', () => {
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, otherProject]}
        sessionId="session-1"
        onClose={() => {}}
        onForward={() => Promise.resolve({})}
      />,
    );
    expect(screen.getByText(/No other agents in this project to forward to/i)).toBeTruthy();
  });

  it('invokes onForward with the selected targetAgentId', async () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 'new' } }));
    const onClose = vi.fn();
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, siblingA, siblingB]}
        sessionId="session-1"
        onClose={onClose}
        onForward={onForward}
      />,
    );
    fireEvent.click(screen.getByText('Hub Backend'));
    fireEvent.click(screen.getByRole('button', { name: /forward/i }));
    // onForward is invoked synchronously on submit
    expect(onForward).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: 'sib-a', autoStart: false }),
    );
  });
});
