import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ForwardSessionModal, { filterForwardTargets } from './ForwardSessionModal';

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
  it('returns same-project agents with the source pinned at the top', () => {
    const agents = [source, siblingA, siblingB, otherProject, inactive];
    const result = filterForwardTargets(agents, source);
    const ids = result.map((a: any) => a.id);
    // Source agent is included (self-forward) and comes first so the
    // "fork this conversation" option is discoverable.
    expect(ids!).toEqual(['src-1', 'sib-a', 'sib-b']);
  });

  it('returns only the source agent when no siblings exist (self-forward only)', () => {
    const result = filterForwardTargets([source, otherProject, inactive], source);
    expect(result!.map((a: any) => a.id)).toEqual(['src-1']);
  });

  it('excludes inactive agents even if they share the project', () => {
    const result = filterForwardTargets([source, inactive], source);
    // Source itself is active and still in the result
    expect(result!.map((a: any) => a.id)).toEqual(['src-1']);
  });

  it('returns an empty list when the source has no projectId', () => {
    const result = filterForwardTargets([source, siblingA], { id: 'x', active: true });
    expect(result!).toEqual([]);
  });

  it('returns an empty list when the source agent is missing', () => {
    expect(filterForwardTargets([source, siblingA], null)).toEqual([]);
  });

  it('is a no-op on non-array input', () => {
    expect(filterForwardTargets(null, source)).toEqual([]);
  });

  it('does not include source when source is inactive', () => {
    const inactiveSource = { ...source, active: false };
    const result = filterForwardTargets([inactiveSource, siblingA], inactiveSource);
    // Inactive source is filtered out by the active-only rule; only
    // siblings remain.
    expect(result!.map((a: any) => a.id)).toEqual(['sib-a']);
  });
});

describe('<ForwardSessionModal />', () => {
  it('renders same-project candidates including the source agent', () => {
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
    // Source agent IS now shown so users can fork into a new session on
    // the same agent (self-forward).
    expect(screen.getByText('Hub Frontend')).toBeTruthy();
    // …and is tagged so it's obvious it's the current agent.
    expect(screen.getByText(/this agent/i)).toBeTruthy();
  });

  it('shows an empty-state message when no agents exist in the project', () => {
    render(
      <ForwardSessionModal
        // Source with no projectId triggers the empty branch — this is
        // the only path that still produces an empty candidate list now
        // that self-forward is allowed.
        sourceAgent={{ id: 'no-proj', name: 'Stray', active: true }}
        agents={[source, otherProject]}
        sessionId="session-1"
        onClose={() => {}}
        onForward={() => Promise.resolve({})}
      />,
    );
    expect(screen.getByText(/No agents in this project to forward to/i)).toBeTruthy();
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
    fireEvent.click(screen.getByText('Hub Backend' as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /forward/i } as any) as any);
    // onForward is invoked synchronously on submit
    expect(onForward!).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: 'sib-a', autoStart: false }),
    );
  });

  it('forwards to the current agent (self-forward) when source is selected', async () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 'fwd-self' } }));
    const onClose = vi.fn();
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, siblingA]}
        sessionId="session-1"
        onClose={onClose}
        onForward={onForward}
      />,
    );
    // The source row is rendered as a candidate now — clicking it should
    // pass the source's own id through as targetAgentId.
    fireEvent.click(screen.getByText('Hub Frontend' as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /forward/i } as any) as any);
    expect(onForward!).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: 'src-1', autoStart: false }),
    );
  });
});
