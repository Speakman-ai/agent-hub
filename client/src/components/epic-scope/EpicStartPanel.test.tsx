import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EpicStartPanel from './EpicStartPanel';

const baseEpic = {
  id: 'epic-1',
  scheduled_start_cron: null,
  scheduled_start_timezone: null,
  scheduled_start_enabled: 0,
};

function renderPanel(overrides: Partial<Record<string, any>> = {}) {
  const onRunEpic = overrides.onRunEpic ?? vi.fn().mockResolvedValue({ outcome: 'no_phases' });
  const onSaveSchedule = overrides.onSaveSchedule ?? vi.fn().mockResolvedValue(undefined);
  const onClearSchedule = overrides.onClearSchedule ?? vi.fn().mockResolvedValue(undefined);
  const epic = { ...baseEpic, ...(overrides.epic || {}) };
  render(
    <EpicStartPanel
      epic={epic}
      onRunEpic={onRunEpic}
      onSaveSchedule={onSaveSchedule}
      onClearSchedule={onClearSchedule}
    />,
  );
  return { onRunEpic, onSaveSchedule, onClearSchedule };
}

describe('EpicStartPanel', () => {
  it('runs the epic and shows the "started" outcome with the phase name', async () => {
    const onRunEpic = vi.fn().mockResolvedValue({ outcome: 'started', phaseName: 'Phase 1' });
    renderPanel({ onRunEpic });
    fireEvent.click(screen.getByTestId('epic-start-button'));
    await waitFor(() => expect(onRunEpic).toHaveBeenCalled());
    const outcome = await screen.findByTestId('epic-start-outcome');
    expect(outcome.textContent).toContain('Phase 1');
    expect(outcome.textContent?.toLowerCase()).toContain('started');
  });

  it('surfaces the stopped-at-disabled outcome so the operator knows the sweep halted', async () => {
    const onRunEpic = vi
      .fn()
      .mockResolvedValue({ outcome: 'stopped_disabled', phaseName: 'Phase 2' });
    renderPanel({ onRunEpic });
    fireEvent.click(screen.getByTestId('epic-start-button'));
    const outcome = await screen.findByTestId('epic-start-outcome');
    expect(outcome.textContent).toContain('Phase 2');
    expect(outcome.textContent?.toLowerCase()).toContain('auto-dispatch is off');
  });

  it('saves a schedule with cron + timezone + enabled', async () => {
    const onSaveSchedule = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onSaveSchedule });
    fireEvent.change(screen.getByTestId('epic-schedule-cron'), { target: { value: '0 9 * * 1' } });
    fireEvent.change(screen.getByTestId('epic-schedule-timezone'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.click(screen.getByTestId('epic-schedule-enabled'));
    fireEvent.click(screen.getByTestId('epic-schedule-save'));
    await waitFor(() =>
      expect(onSaveSchedule).toHaveBeenCalledWith({
        cron: '0 9 * * 1',
        timezone: 'America/New_York',
        enabled: true,
      }),
    );
  });

  it('disables Save until a cron is entered', () => {
    renderPanel();
    expect(screen.getByTestId('epic-schedule-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('epic-schedule-cron'), { target: { value: '* * * * *' } });
    expect(screen.getByTestId('epic-schedule-save')).not.toBeDisabled();
  });

  it('seeds the form from an existing schedule and offers Clear', () => {
    const onClearSchedule = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      epic: {
        scheduled_start_cron: '30 8 * * *',
        scheduled_start_timezone: 'Europe/London',
        scheduled_start_enabled: 1,
      },
      onClearSchedule,
    });
    expect((screen.getByTestId('epic-schedule-cron') as HTMLInputElement).value).toBe('30 8 * * *');
    expect((screen.getByTestId('epic-schedule-timezone') as HTMLInputElement).value).toBe(
      'Europe/London',
    );
    expect((screen.getByTestId('epic-schedule-enabled') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('epic-schedule-clear'));
    expect(onClearSchedule).toHaveBeenCalled();
  });
});
