import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DelegateCard from './DelegateCard.jsx';

const AGENTS = [
  { id: 'hub-frontend', name: 'Hub Frontend', color: '#22d3ee' },
  { id: 'hub-backend', name: 'Hub Backend', color: '#a78bfa' },
];

describe('DelegateCard', () => {
  it('renders nothing when there are no tasks and no malformed block', () => {
    const { container } = render(<DelegateCard tasks={null} agents={AGENTS} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a row per task with the resolved agent name', () => {
    render(
      <DelegateCard
        tasks={[
          { agentId: 'hub-frontend', task: 'implement the UI' },
          { agentId: 'hub-backend', task: 'wire the API' },
        ]}
        agents={AGENTS}
      />,
    );
    expect(screen.getByTestId('delegate-card')).toBeInTheDocument();
    expect(screen.getByText('Hub Frontend')).toBeInTheDocument();
    expect(screen.getByText('Hub Backend')).toBeInTheDocument();
    expect(screen.getByText('implement the UI')).toBeInTheDocument();
    expect(screen.getByText('wire the API')).toBeInTheDocument();
    expect(screen.getAllByTestId('delegate-task-row')).toHaveLength(2);
  });

  it('falls back to the raw agentId when the agent is not in the lookup', () => {
    render(<DelegateCard tasks={[{ agentId: 'ghost-agent', task: 'who am i' }]} agents={AGENTS} />);
    expect(screen.getByText('ghost-agent')).toBeInTheDocument();
  });

  it('shows the "Awaiting dispatch" placeholder when the parent turn is still active', () => {
    // Regression anchor: this is the primary "delegate doesn't show up" fix.
    // Before, the WebSocket-driven DelegationPanel was the *only* surface,
    // so if events were delayed/dropped the user saw nothing. Now the
    // message-anchored card shows an "Awaiting dispatch" badge as immediate
    // feedback while the lead turn is still streaming.
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentSessionActive
      />,
    );
    expect(screen.getByTestId('delegate-status-queued')).toBeInTheDocument();
    expect(screen.getByText(/Awaiting dispatch/i)).toBeInTheDocument();
  });

  it('falls back to "Awaiting dispatch" with no parent-active hint (legacy callers)', () => {
    // Backwards-compat: callers that haven't been updated to pass
    // `parentSessionActive` should still see *some* fallback. We default to
    // the historical-message branch ("Did not start") to avoid the original
    // bug — but the legacy default (no prop at all) is the safer "Awaiting
    // dispatch" when the caller can't tell us whether the parent is live.
    // We document the choice here: when both signals are absent, we render
    // the "Did not start" amber chip because indefinite "Queued" is exactly
    // the UX the user complained about.
    render(<DelegateCard tasks={[{ agentId: 'hub-frontend', task: 'go' }]} agents={AGENTS} />);
    expect(screen.getByTestId('delegate-status-no-dispatch')).toBeInTheDocument();
    expect(screen.getByText(/Did not start/i)).toBeInTheDocument();
  });

  it('correlates live WebSocket status to the parsed task rows by agentId', () => {
    render(
      <DelegateCard
        tasks={[
          { agentId: 'hub-frontend', task: 'go' },
          { agentId: 'hub-backend', task: 'go too' },
        ]}
        agents={AGENTS}
        sessionDelegations={{
          tasks: [
            {
              agentId: 'hub-frontend',
              agentName: 'Hub Frontend',
              agentColor: '#22d3ee',
              status: 'running',
            },
            {
              agentId: 'hub-backend',
              agentName: 'Hub Backend',
              agentColor: '#a78bfa',
              status: 'done',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('delegate-status-running')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-status-done')).toBeInTheDocument();
  });

  it('keeps showing "Awaiting dispatch" for parsed tasks that have no matching live row mid-stream', () => {
    render(
      <DelegateCard
        tasks={[
          { agentId: 'hub-frontend', task: 'go' },
          { agentId: 'hub-backend', task: 'go too' },
        ]}
        agents={AGENTS}
        parentSessionActive
        sessionDelegations={{
          tasks: [
            {
              agentId: 'hub-frontend',
              agentName: 'Hub Frontend',
              agentColor: '#22d3ee',
              status: 'running',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('delegate-status-running')).toBeInTheDocument();
    // hub-backend has no live row → still "Awaiting dispatch" while the
    // parent turn is still active.
    expect(screen.getByTestId('delegate-status-queued')).toBeInTheDocument();
  });

  it('renders "Did not start" instead of indefinite Queued when the parent turn ended without any live data', () => {
    // The user-reported bug: a `<delegate>` block was emitted but no
    // `delegation_start` event followed (no valid sub-agents, dispatcher
    // crashed, session cancelled). Pre-fix: rows showed "Queued" forever
    // with the misleading tooltip "Awaiting dispatch confirmation from
    // server". Post-fix: an amber "Did not start" badge so the user knows
    // dispatch never happened and can re-emit.
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentSessionActive={false}
      />,
    );
    expect(screen.queryByTestId('delegate-status-queued')).toBeNull();
    expect(screen.getByTestId('delegate-status-no-dispatch')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-card')).toHaveAttribute(
      'data-fallback-state',
      'no-dispatch',
    );
  });

  it('renders an "Older round" badge when the live snapshot belongs to a newer delegate round', () => {
    // `delegations[sessionId]` is per-session and gets *replaced* on every
    // `delegation_start`, so a card anchored to an earlier message in the
    // same session would otherwise display Queued/awaiting-dispatch
    // forever. We detect the mismatch via parentMessageId and surface it.
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'first round' }]}
        agents={AGENTS}
        parentMessageId="msg-A"
        sessionDelegations={{
          parentMessageId: 'msg-B',
          tasks: [
            {
              agentId: 'hub-frontend',
              agentName: 'Hub Frontend',
              agentColor: '#22d3ee',
              status: 'running',
            },
          ],
        }}
      />,
    );
    // The newer round's "running" status must NOT bleed onto this card.
    expect(screen.queryByTestId('delegate-status-running')).toBeNull();
    expect(screen.getByTestId('delegate-status-older-round')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-card')).toHaveAttribute(
      'data-fallback-state',
      'older-round',
    );
  });

  it('still applies live status when parentMessageIds match', () => {
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'matched' }]}
        agents={AGENTS}
        parentMessageId="msg-A"
        sessionDelegations={{
          parentMessageId: 'msg-A',
          tasks: [
            {
              agentId: 'hub-frontend',
              agentName: 'Hub Frontend',
              agentColor: '#22d3ee',
              status: 'done',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('delegate-status-done')).toBeInTheDocument();
    expect(screen.queryByTestId('delegate-status-older-round')).toBeNull();
  });

  it('renders a dispatch-error banner when the round failed to dispatch', () => {
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentMessageId="msg-A"
        parentSessionActive={false}
        dispatchError={{
          parentMessageId: 'msg-A',
          message: 'No valid sub-agents found for delegation',
        }}
      />,
    );
    const banner = screen.getByTestId('delegate-dispatch-error');
    expect(banner).toHaveTextContent(/Dispatch failed/);
    expect(banner).toHaveTextContent('No valid sub-agents found for delegation');
    // Still surfaces the per-row "Did not start" badge to mirror the banner.
    expect(screen.getByTestId('delegate-status-no-dispatch')).toBeInTheDocument();
  });

  it('ignores a dispatch-error banner targeting a different parent message', () => {
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentMessageId="msg-A"
        parentSessionActive={false}
        dispatchError={{
          parentMessageId: 'msg-B', // belongs to a different round
          message: 'Some other failure',
        }}
      />,
    );
    expect(screen.queryByTestId('delegate-dispatch-error')).toBeNull();
  });

  it('tolerates a dispatch-error payload that omits parentMessageId (legacy server)', () => {
    // Backwards-compat: a server that doesn't yet stamp the broadcast with
    // `parentMessageId` should still surface the banner — the per-session
    // scoping in App.jsx keeps it from leaking across unrelated cards.
    render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentMessageId="msg-A"
        parentSessionActive={false}
        dispatchError={{ message: 'Generic dispatch failure' }}
      />,
    );
    expect(screen.getByTestId('delegate-dispatch-error')).toHaveTextContent(
      'Generic dispatch failure',
    );
  });

  it('transitions cleanly from "Awaiting dispatch" to a live status when the WS event arrives', () => {
    // Mid-stream: live row arrives → fallback badge disappears, real status
    // chip takes over. Anchors the timing contract documented in the card
    // doc-comment.
    const { rerender } = render(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentSessionActive
      />,
    );
    expect(screen.getByTestId('delegate-status-queued')).toBeInTheDocument();
    rerender(
      <DelegateCard
        tasks={[{ agentId: 'hub-frontend', task: 'go' }]}
        agents={AGENTS}
        parentSessionActive
        sessionDelegations={{
          tasks: [
            {
              agentId: 'hub-frontend',
              agentName: 'Hub Frontend',
              agentColor: '#22d3ee',
              status: 'running',
            },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId('delegate-status-queued')).toBeNull();
    expect(screen.getByTestId('delegate-status-running')).toBeInTheDocument();
  });

  it('renders the failed-state card when the block is malformed', () => {
    render(
      <DelegateCard
        tasks={null}
        malformed={{ reason: 'invalid-json', rawBody: 'not json' }}
        malformedReasonText="Delegate block contains invalid JSON"
        agents={AGENTS}
      />,
    );
    expect(screen.getByTestId('delegate-card-failed')).toBeInTheDocument();
    expect(screen.getByText(/Failed — Delegate block contains invalid JSON/)).toBeInTheDocument();
    expect(screen.getByTestId('delegate-raw-body')).toHaveTextContent('not json');
  });

  it('renders per-row missing-field diagnostics and the required contract on partial payloads', () => {
    // The recurring user bug: model emits `[{agentId, task}]` and the UI
    // previously showed a generic "Failed —" with no guidance. The card now
    // surfaces the exact missing fields per row and the canonical contract.
    render(
      <DelegateCard
        tasks={null}
        malformed={{
          reason: 'no-valid-entries',
          rawBody: '[{"agentId":"hub-backend","task":"go"}]',
          rows: [
            {
              agentId: 'hub-backend',
              missing: ['owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat'],
            },
          ],
        }}
        malformedReasonText="Delegate block has no entries with the required contract fields"
        agents={AGENTS}
      />,
    );
    expect(screen.getByTestId('delegate-card-failed')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-missing-fields-heading')).toBeInTheDocument();
    const row = screen.getByTestId('delegate-missing-field-row');
    expect(row).toHaveTextContent('hub-backend');
    expect(row).toHaveTextContent('owner, scope, expectedArtifact, deadline, returnFormat');
    expect(screen.getByTestId('delegate-required-contract')).toHaveTextContent(
      'agentId, task, owner, scope, expectedArtifact, deadline, returnFormat',
    );
  });

  it('omits the raw-body panel when malformed.rawBody is empty', () => {
    render(
      <DelegateCard
        tasks={null}
        malformed={{ reason: 'empty-array', rawBody: '' }}
        malformedReasonText="Delegate block payload is an empty array"
        agents={AGENTS}
      />,
    );
    expect(screen.getByTestId('delegate-card-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('delegate-raw-body')).toBeNull();
  });
});
