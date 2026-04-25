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

  it('shows "Queued" status when no live delegation data is available', () => {
    // Regression anchor: this is the primary "delegate doesn't show up" fix.
    // Before, the WebSocket-driven DelegationPanel was the *only* surface,
    // so if events were delayed/dropped the user saw nothing. Now the
    // message-anchored card shows a Queued badge as immediate feedback.
    render(<DelegateCard tasks={[{ agentId: 'hub-frontend', task: 'go' }]} agents={AGENTS} />);
    expect(screen.getByTestId('delegate-status-queued')).toBeInTheDocument();
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

  it('keeps showing Queued for parsed tasks that have no matching live row', () => {
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
          ],
        }}
      />,
    );
    expect(screen.getByTestId('delegate-status-running')).toBeInTheDocument();
    // hub-backend has no live row → still Queued
    expect(screen.getByTestId('delegate-status-queued')).toBeInTheDocument();
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
