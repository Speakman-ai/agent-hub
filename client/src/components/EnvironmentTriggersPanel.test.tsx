import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentTriggersPanel from './EnvironmentTriggersPanel';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    listDeployTriggers: vi.fn(),
    createDeployTrigger: vi.fn(),
    updateDeployTrigger: vi.fn(),
    deleteDeployTrigger: vi.fn(),
  },
}));

function trigger(over: any = {}) {
  return {
    id: 't1',
    projectId: 'proj-1',
    environmentName: 'prod',
    event: 'push',
    branchPattern: 'main',
    enabled: true,
    meta: null,
    createdAt: '2026-07-02',
    updatedAt: '2026-07-02',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).confirm = vi.fn(() => true);
});

describe('EnvironmentTriggersPanel', () => {
  it('lists an environment triggers', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({
      triggers: [trigger(), trigger({ id: 't2', event: 'merge', branchPattern: 'release/*' })],
    });
    render(<EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('trigger-row-t1')).toBeTruthy());
    expect(api.listDeployTriggers).toHaveBeenCalledWith('proj-1', 'prod');
    expect(within(screen.getByTestId('trigger-row-t1')).getByText('main')).toBeTruthy();
    expect(within(screen.getByTestId('trigger-row-t2')).getByText('release/*')).toBeTruthy();
  });

  it('shows an empty state when there are no triggers', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({ triggers: [] });
    render(<EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText(/No triggers yet/)).toBeTruthy());
  });

  it('creates a trigger from the add form', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({ triggers: [] });
    (api.createDeployTrigger as any).mockResolvedValue({
      trigger: trigger({ id: 't9', branchPattern: 'feature/*' }),
    });
    const showToast = vi.fn();
    render(
      <EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" showToast={showToast} />,
    );

    await waitFor(() => expect(screen.getByText(/No triggers yet/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Branch pattern'), {
      target: { value: 'feature/*' },
    });
    fireEvent.click(screen.getByText('Add trigger'));

    await waitFor(() =>
      expect(api.createDeployTrigger).toHaveBeenCalledWith('proj-1', 'prod', {
        event: 'push',
        branchPattern: 'feature/*',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('trigger-row-t9')).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith('Trigger added to prod', 'success');
  });

  it('blocks a whitespace-only branch pattern submitted via Enter', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({ triggers: [] });
    const showToast = vi.fn();
    render(
      <EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" showToast={showToast} />,
    );
    await waitFor(() => expect(screen.getByText(/No triggers yet/)).toBeTruthy());
    // The Add button is disabled for whitespace-only input; the Enter path still
    // runs so the client-side validation guard is exercised.
    const input = screen.getByLabelText('Branch pattern');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Branch pattern is required.', 'error'),
    );
    expect(api.createDeployTrigger).not.toHaveBeenCalled();
  });

  it('toggles a trigger enabled state via PATCH', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({ triggers: [trigger({ enabled: true })] });
    (api.updateDeployTrigger as any).mockResolvedValue({
      trigger: trigger({ enabled: false }),
    });
    render(<EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('trigger-row-t1')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('trigger-row-t1')).getByText('Disable'));

    await waitFor(() =>
      expect(api.updateDeployTrigger).toHaveBeenCalledWith('proj-1', 'prod', 't1', {
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('trigger-row-t1')).getByText('Enable')).toBeTruthy(),
    );
  });

  it('deletes a trigger after confirmation', async () => {
    (api.listDeployTriggers as any).mockResolvedValue({ triggers: [trigger()] });
    (api.deleteDeployTrigger as any).mockResolvedValue({ removed: true });
    render(<EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('trigger-row-t1')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('trigger-row-t1')).getByLabelText(/Delete/));

    await waitFor(() =>
      expect(api.deleteDeployTrigger).toHaveBeenCalledWith('proj-1', 'prod', 't1'),
    );
    await waitFor(() => expect(screen.queryByTestId('trigger-row-t1')).toBeNull());
  });

  it('surfaces a load error', async () => {
    (api.listDeployTriggers as any).mockRejectedValue(new Error('boom'));
    render(<EnvironmentTriggersPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
