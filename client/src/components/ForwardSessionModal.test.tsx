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
  it('lists cross-project agents: source first, then same-project, then other projects', () => {
    const agents = [source, siblingA, siblingB, otherProject, inactive];
    const result = filterForwardTargets(agents, source);
    const ids = result.map((a: any) => a.id);
    // Source pinned first (self-forward), then same-project siblings, then
    // agents in other projects (cross-project forwarding). Inactive dropped.
    expect(ids!).toEqual(['src-1', 'sib-a', 'sib-b', 'other-1']);
  });

  it('includes an other-project agent even when no siblings exist', () => {
    const result = filterForwardTargets([source, otherProject, inactive], source);
    // Source first, then the cross-project agent.
    expect(result!.map((a: any) => a.id)).toEqual(['src-1', 'other-1']);
  });

  it('excludes inactive agents even if they share the project', () => {
    const result = filterForwardTargets([source, inactive], source);
    // Source itself is active and still in the result
    expect(result!.map((a: any) => a.id)).toEqual(['src-1']);
  });

  it('still lists agents when the source has no projectId (all treated as cross-project)', () => {
    const result = filterForwardTargets([source, siblingA], { id: 'x', active: true });
    // No projectId match and source not in the list, so every active agent
    // falls into the other-projects bucket.
    expect(result!.map((a: any) => a.id)).toEqual(['src-1', 'sib-a']);
  });

  it('lists every active agent (sorted) when there is no source agent', () => {
    // No source (e.g. forwarding a standalone thread entry) → all active
    // agents, grouped by project name then agent name. These fixtures carry
    // no projectName, so ordering collapses to agent name.
    const result = filterForwardTargets([source, siblingA, inactive], null);
    expect(result!.map((a: any) => a.id)).toEqual(['sib-a', 'src-1']);
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
  it('renders candidates including other-project agents and the source agent', () => {
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
    // Cross-project agents now appear in the picker.
    expect(screen.getByText('Side Project Agent')).toBeTruthy();
    expect(screen.queryByText('Retired')).toBeNull();
    // Source agent IS shown so users can fork into a new session on
    // the same agent (self-forward).
    expect(screen.getByText('Hub Frontend')).toBeTruthy();
    // …and is tagged so it's obvious it's the current agent.
    expect(screen.getByText(/this agent/i)).toBeTruthy();
  });

  it('shows an empty-state message when there are no agents to forward to', () => {
    render(
      <ForwardSessionModal
        sourceAgent={source}
        // Only inactive agents exist → no eligible candidates.
        agents={[inactive]}
        sessionId="session-1"
        onClose={() => {}}
        onForward={() => Promise.resolve({})}
      />,
    );
    expect(screen.getByText(/No agents available to forward to/i)).toBeTruthy();
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

  it('supports source-less forwarding (thread entry) with a custom title and ready gate', async () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 'fwd' } }));
    render(
      <ForwardSessionModal
        sourceAgent={null}
        agents={[source, siblingA]}
        ready={true}
        title="Forward message"
        sourceLabel="from Nightly cron"
        onClose={() => {}}
        onForward={onForward}
      />,
    );
    // Custom title + source label render; no "this agent" self tag exists.
    expect(screen.getByText('Forward message')).toBeTruthy();
    expect(screen.getByText('from Nightly cron')).toBeTruthy();
    expect(screen.queryByText(/this agent/i)).toBeNull();
    // Submit is enabled via `ready` even without a sessionId.
    fireEvent.click(screen.getByText('Hub Backend' as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /forward/i } as any) as any);
    expect(onForward!).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: 'sib-a' }));
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

  // ─── Model override ────────────────────────────────────────────

  const modelConfig = {
    engineValidModels: {
      'claude-code': ['claude-opus-5', 'claude-haiku-4-6'],
      'codex-cli': ['gpt-5.4', 'gpt-5.2'],
    },
    engineDefaultModels: { 'claude-code': 'claude-opus-5', 'codex-cli': 'gpt-5.4' },
  };

  const codexAgent = {
    id: 'cdx-1',
    name: 'Codex Agent',
    projectId: 'proj-a',
    active: true,
    engine: 'codex-cli',
    color: '#0aa',
    model: 'gpt-5.4',
  };

  it('does not render a model picker without modelConfig', () => {
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, siblingA]}
        sessionId="session-1"
        onClose={() => {}}
        onForward={() => Promise.resolve({})}
      />,
    );
    fireEvent.click(screen.getByText('Hub Backend' as any) as any);
    expect(screen.queryByTestId('forward-model-select')).toBeNull();
  });

  it('shows a model picker once an agent is selected and forwards the chosen model', () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 'fwd' } }));
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, { ...siblingA, model: 'claude-opus-5' }]}
        sessionId="session-1"
        modelConfig={modelConfig}
        onClose={() => {}}
        onForward={onForward}
      />,
    );
    // No agent selected yet → no picker.
    expect(screen.queryByTestId('forward-model-select')).toBeNull();

    fireEvent.click(screen.getByText('Hub Backend' as any) as any);
    const select = screen.getByTestId('forward-model-select') as HTMLSelectElement;
    // Defaults to the target agent's own model.
    expect(select.value).toBe('claude-opus-5');

    // Override to a different valid model, then submit.
    fireEvent.change(select, { target: { value: 'claude-haiku-4-6' } } as any);
    fireEvent.click(screen.getByRole('button', { name: /forward/i } as any) as any);
    expect(onForward!).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: 'sib-a', model: 'claude-haiku-4-6' }),
    );
  });

  it('does not carry a prior target’s model after switching agents (no stale-effect race)', () => {
    const onForward = vi.fn(() => Promise.resolve({ session: { id: 'fwd' } }));
    render(
      <ForwardSessionModal
        sourceAgent={source}
        agents={[source, { ...siblingA, model: 'claude-opus-5' }, codexAgent]}
        sessionId="session-1"
        modelConfig={modelConfig}
        onClose={() => {}}
        onForward={onForward}
      />,
    );

    // Pick a claude-code target and override its model.
    fireEvent.click(screen.getByText('Hub Backend' as any) as any);
    const select = screen.getByTestId('forward-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-haiku-4-6' } } as any);
    expect(select.value).toBe('claude-haiku-4-6');

    // Switch to a codex target. The rendered selection must synchronously
    // become the codex default — the prior (now engine-foreign) haiku choice
    // must NOT survive, even without any effect having run.
    fireEvent.click(screen.getByText('Codex Agent' as any) as any);
    const codexSelect = screen.getByTestId('forward-model-select') as HTMLSelectElement;
    expect(codexSelect.value).toBe('gpt-5.4');

    // Forwarding immediately sends the codex default, never the stale haiku id.
    fireEvent.click(screen.getByRole('button', { name: /forward/i } as any) as any);
    expect(onForward!).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentId: 'cdx-1', model: 'gpt-5.4' }),
    );
  });
});
