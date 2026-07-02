import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentSchedulesPanel from './EnvironmentSchedulesPanel';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    listDeploySchedules: vi.fn(),
    createDeploySchedule: vi.fn(),
    updateDeploySchedule: vi.fn(),
    deleteDeploySchedule: vi.fn(),
  },
}));

function schedule(over: any = {}) {
  return {
    id: 's1',
    projectId: 'proj-1',
    environmentName: 'prod',
    ref: 'main',
    cron: '0 9 * * *',
    timezone: null,
    ownerUserId: 'u1',
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

describe('EnvironmentSchedulesPanel', () => {
  it('lists an environment schedules', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({
      schedules: [schedule(), schedule({ id: 's2', ref: 'release/2.1', cron: '30 2 * * *' })],
    });
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('schedule-row-s1')).toBeTruthy());
    expect(api.listDeploySchedules).toHaveBeenCalledWith('proj-1', 'prod');
    expect(within(screen.getByTestId('schedule-row-s1')).getByText('main')).toBeTruthy();
    expect(within(screen.getByTestId('schedule-row-s2')).getByText('release/2.1')).toBeTruthy();
  });

  it('shows an empty state when there are no schedules', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({ schedules: [] });
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeTruthy());
  });

  it('creates a schedule from the add form', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({ schedules: [] });
    (api.createDeploySchedule as any).mockResolvedValue({
      schedule: schedule({ id: 's9', ref: 'develop' }),
    });
    const showToast = vi.fn();
    render(
      <EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" showToast={showToast} />,
    );

    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Ref'), { target: { value: 'develop' } });
    fireEvent.click(screen.getByText('Add schedule'));

    await waitFor(() =>
      expect(api.createDeploySchedule).toHaveBeenCalledWith('proj-1', 'prod', {
        ref: 'develop',
        cron: '0 9 * * *',
        timezone: null,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('schedule-row-s9')).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith('Schedule added to prod', 'success');
  });

  it('disables the add button for a whitespace-only ref', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({ schedules: [] });
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Ref'), { target: { value: '   ' } });
    const addButton = screen.getByText('Add schedule').closest('button');
    expect(addButton?.disabled).toBe(true);
    fireEvent.click(addButton as HTMLButtonElement);
    expect(api.createDeploySchedule).not.toHaveBeenCalled();
  });

  it('toggles a schedule enabled state via PATCH', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({
      schedules: [schedule({ enabled: true })],
    });
    (api.updateDeploySchedule as any).mockResolvedValue({ schedule: schedule({ enabled: false }) });
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('schedule-row-s1')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('schedule-row-s1')).getByText('Disable'));

    await waitFor(() =>
      expect(api.updateDeploySchedule).toHaveBeenCalledWith('proj-1', 'prod', 's1', {
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('schedule-row-s1')).getByText('Enable')).toBeTruthy(),
    );
  });

  it('deletes a schedule after confirmation', async () => {
    (api.listDeploySchedules as any).mockResolvedValue({ schedules: [schedule()] });
    (api.deleteDeploySchedule as any).mockResolvedValue({ removed: true });
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('schedule-row-s1')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('schedule-row-s1')).getByLabelText(/Delete/));

    await waitFor(() =>
      expect(api.deleteDeploySchedule).toHaveBeenCalledWith('proj-1', 'prod', 's1'),
    );
    await waitFor(() => expect(screen.queryByTestId('schedule-row-s1')).toBeNull());
  });

  it('surfaces a load error', async () => {
    (api.listDeploySchedules as any).mockRejectedValue(new Error('boom'));
    render(<EnvironmentSchedulesPanel projectId="proj-1" environmentName="prod" />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
