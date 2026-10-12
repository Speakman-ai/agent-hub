import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentReleaseGatesPanel from './EnvironmentReleaseGatesPanel';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    listDeployReleaseGates: vi.fn(),
    createDeployReleaseGate: vi.fn(),
    updateDeployReleaseGate: vi.fn(),
    deleteDeployReleaseGate: vi.fn(),
    listReleaseGateSessionCandidates: vi.fn(),
    getEpics: vi.fn(),
  },
}));

function gate(over: any = {}) {
  return {
    id: 'g1',
    projectId: 'proj-1',
    environmentName: 'prod',
    ref: 'main',
    sessionIds: ['sess-a'],
    epicIds: [],
    ownerUserId: 'u1',
    status: 'armed',
    enabled: true,
    firedDeploymentId: null,
    lastError: null,
    resolvedAt: null,
    progress: {
      sessions: [{ id: 'sess-a', state: 'pending' }],
      epics: [],
      sessionsComplete: 0,
      sessionsTotal: 1,
      epicsComplete: 0,
      epicsTotal: 0,
      blocked: false,
      satisfied: false,
    },
    meta: null,
    createdAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).confirm = vi.fn(() => true);
  // The server validates candidacy now (live, non-merged sessions only); the
  // panel just renders what it returns.
  (api.listReleaseGateSessionCandidates as any).mockResolvedValue({
    projectId: 'proj-1',
    sessions: [{ id: 'sess-a', label: 'Fix auth' }],
  });
  (api.getEpics as any).mockResolvedValue([
    { id: 'epic-1', name: 'Billing', state: 'in_progress' },
    { id: 'epic-done', name: 'Shipped', state: 'done' },
  ]);
});

describe('EnvironmentReleaseGatesPanel', () => {
  it('lists gates with progress and status badge', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [gate()] });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('release-gate-row-g1')).toBeTruthy());
    expect(api.listDeployReleaseGates).toHaveBeenCalledWith('proj-1', 'prod');
    const row = screen.getByTestId('release-gate-row-g1');
    expect(within(row).getByText('main')).toBeTruthy();
    expect(within(row).getByText('waiting')).toBeTruthy();
    expect(within(row).getByText('0/1 sessions')).toBeTruthy();
    expect(screen.getByText(/Creating it is the approval/)).toBeTruthy();
  });

  it('shows blocked status when a selection is missing', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({
      gates: [
        gate({
          progress: {
            sessions: [{ id: 'sess-a', state: 'missing' }],
            epics: [],
            sessionsComplete: 0,
            sessionsTotal: 1,
            epicsComplete: 0,
            epicsTotal: 0,
            blocked: true,
            satisfied: false,
          },
        }),
      ],
    });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText('blocked')).toBeTruthy());
  });

  it('shows an empty state when there are no gates', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText(/No release gates yet/)).toBeTruthy());
  });

  it('offers only active sessions and open epics as options', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByTestId('release-gate-session-options')).toBeTruthy());
    const sessions = screen.getByTestId('release-gate-session-options');
    expect(within(sessions).getByText('Fix auth')).toBeTruthy();
    expect(within(sessions).queryByText('Old work')).toBeNull();
    const epics = screen.getByTestId('release-gate-epic-options');
    expect(within(epics).getByText('Billing')).toBeTruthy();
    expect(within(epics).queryByText('Shipped')).toBeNull();
  });

  // Regression: the picker used to be built client-side from raw board cards
  // and listed sessions that no longer existed (purged/corrupt session ids on
  // old cards). It now renders exactly the server-validated candidates and
  // shows the empty state when there are none.
  it('renders only the server-validated candidate sessions', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    (api.listReleaseGateSessionCandidates as any).mockResolvedValue({
      projectId: 'proj-1',
      sessions: [
        { id: 'sess-a', label: 'Fix auth' },
        { id: 'sess-b', label: 'Add search' },
      ],
    });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByTestId('release-gate-session-options')).toBeTruthy());
    expect(api.listReleaseGateSessionCandidates).toHaveBeenCalledWith('proj-1');
    const sessions = screen.getByTestId('release-gate-session-options');
    expect(within(sessions).getByText('Fix auth')).toBeTruthy();
    expect(within(sessions).getByText('Add search')).toBeTruthy();
  });

  it('shows the empty state when the server returns no candidate sessions', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    (api.listReleaseGateSessionCandidates as any).mockResolvedValue({
      projectId: 'proj-1',
      sessions: [],
    });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText('No active sessions on the board.')).toBeTruthy());
  });

  it('creates a gate from the selected sessions/epics', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    (api.createDeployReleaseGate as any).mockResolvedValue({ gate: gate({ id: 'g9' }) });
    const showToast = vi.fn();
    render(
      <EnvironmentReleaseGatesPanel
        projectId="proj-1"
        environmentName="prod"
        showToast={showToast}
      />,
    );

    await waitFor(() => expect(screen.getByText('Fix auth')).toBeTruthy());
    fireEvent.click(screen.getByText('Fix auth'));
    fireEvent.click(screen.getByText('Add release gate'));

    await waitFor(() =>
      expect(api.createDeployReleaseGate).toHaveBeenCalledWith('proj-1', 'prod', {
        ref: null,
        sessionIds: ['sess-a'],
        epicIds: [],
      }),
    );
  });

  it('blocks add when nothing is selected', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [] });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText(/No release gates yet/)).toBeTruthy());
    expect(
      (screen.getByText('Add release gate').closest('button') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('deletes a gate', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [gate()] });
    (api.deleteDeployReleaseGate as any).mockResolvedValue({ removed: true });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByTestId('release-gate-row-g1')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Delete Deploy main/));
    await waitFor(() =>
      expect(api.deleteDeployReleaseGate).toHaveBeenCalledWith('proj-1', 'prod', 'g1'),
    );
  });

  it('edits an armed gate: adds an epic and drops a merged session', async () => {
    const existing = gate({
      sessionIds: ['sess-a', 'sess-merged'],
      epicIds: ['epic-done'],
    });
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [existing] });
    (api.updateDeployReleaseGate as any).mockResolvedValue({
      gate: gate({ sessionIds: ['sess-a'], epicIds: ['epic-done', 'epic-1'] }),
    });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByLabelText(/Edit Deploy main/)).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('release-gate-session-options')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Edit Deploy main/));

    const form = screen.getByTestId('release-gate-form');
    expect(within(form).getByText(/Editing release gate/)).toBeTruthy();
    expect((within(form).getByLabelText('Ref') as HTMLInputElement).value).toBe('main');
    // Selections that are no longer candidates stay visible (and ticked) so
    // they can be removed; the done epic keeps its name.
    const checkbox = (label: string) =>
      within(form).getByText(label).closest('label')!.querySelector('input') as HTMLInputElement;
    expect(checkbox('Fix auth').checked).toBe(true);
    expect(checkbox('sess-merged').checked).toBe(true);
    expect(checkbox('Shipped').checked).toBe(true);
    expect(checkbox('Billing').checked).toBe(false);

    fireEvent.click(checkbox('Billing'));
    fireEvent.click(checkbox('sess-merged'));
    fireEvent.click(within(form).getByText('Save changes'));

    await waitFor(() =>
      expect(api.updateDeployReleaseGate).toHaveBeenCalledWith('proj-1', 'prod', 'g1', {
        ref: 'main',
        sessionIds: ['sess-a'],
        epicIds: ['epic-done', 'epic-1'],
      }),
    );
    await waitFor(() => expect(within(form).getByText('Add release gate')).toBeTruthy());
    expect(api.createDeployReleaseGate).not.toHaveBeenCalled();
  });

  it('cancel leaves edit mode without saving', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [gate()] });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByLabelText(/Edit Deploy main/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Edit Deploy main/));
    fireEvent.click(screen.getByText('Cancel'));
    const form = screen.getByTestId('release-gate-form');
    expect(within(form).queryByText(/Editing release gate/)).toBeNull();
    expect((within(form).getByLabelText('Ref') as HTMLInputElement).value).toBe('');
    expect(api.updateDeployReleaseGate).not.toHaveBeenCalled();
  });

  it('does not offer Edit on a released gate', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({
      gates: [gate({ status: 'fired', firedDeploymentId: 'dep-12345678' })],
    });
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText('released')).toBeTruthy());
    expect(screen.queryByLabelText(/Edit Deploy main/)).toBeNull();
  });

  // Regression: a save's completion resets the draft, so opening another gate's
  // editor while the save was in flight lost that second draft.
  it('locks Edit on every gate until an in-flight save settles', async () => {
    const g1 = gate();
    const g2 = gate({ id: 'g2', ref: 'release/2', createdAt: '2026-08-19T00:00:00Z' });
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [g1, g2] });
    let resolveSave!: (v: any) => void;
    (api.updateDeployReleaseGate as any).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByLabelText(/Edit Deploy release\/2/)).toBeTruthy());
    const editG2 = () => screen.getByLabelText(/Edit Deploy release\/2/) as HTMLButtonElement;

    fireEvent.click(screen.getByLabelText(/Edit Deploy main/));
    const form = screen.getByTestId('release-gate-form');
    fireEvent.click(within(form).getByText('Save changes'));
    await waitFor(() => expect(api.updateDeployReleaseGate).toHaveBeenCalledTimes(1));

    expect(editG2().disabled).toBe(true);
    fireEvent.click(editG2());
    expect((within(form).getByLabelText('Ref') as HTMLInputElement).value).toBe('main');

    resolveSave({ gate: g1 });
    await waitFor(() => expect(editG2().disabled).toBe(false));
    fireEvent.click(editG2());
    expect((within(form).getByLabelText('Ref') as HTMLInputElement).value).toBe('release/2');
    expect(within(form).getByText(/Editing release gate: Deploy release\/2/)).toBeTruthy();
  });

  it('locks Edit while a new gate is being created', async () => {
    (api.listDeployReleaseGates as any).mockResolvedValue({ gates: [gate()] });
    (api.createDeployReleaseGate as any).mockReturnValue(new Promise(() => undefined));
    render(<EnvironmentReleaseGatesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByTestId('release-gate-epic-options')).toBeTruthy());
    const form = screen.getByTestId('release-gate-form');
    fireEvent.click(within(form).getByText('Billing'));
    fireEvent.click(within(form).getByText('Add release gate'));
    await waitFor(() => expect(api.createDeployReleaseGate).toHaveBeenCalled());
    expect((screen.getByLabelText(/Edit Deploy main/) as HTMLButtonElement).disabled).toBe(true);
  });
});
