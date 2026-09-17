import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    startSessionAutopilot: vi.fn(),
  },
}));

import { api } from '../utils/api';
import AutopilotSetupPrompt from './AutopilotSetupPrompt';

describe('AutopilotSetupPrompt', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.startSessionAutopilot as any).mockResolvedValue({
      id: 'session-1',
      session_mode: 'autopilot',
      finalize_automation: 'push',
      autopilot: {
        durationHours: 4,
        brief: 'Harden preview',
        goal: 'Journeys pass',
        escalation: 'medium',
        branch: 'autopilot/preview',
        startedAt: '2026-09-17T12:00:00.000Z',
        status: 'running',
      },
    });
  });

  it('keeps Start disabled until brief, goal, and a feature branch are filled', () => {
    render(<AutopilotSetupPrompt sessionId="session-1" />);
    expect(screen.getByTestId('autopilot-setup-start')).toBeDisabled();
    fireEvent.change(screen.getByTestId('autopilot-setup-brief'), {
      target: { value: 'Harden preview' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-goal'), {
      target: { value: 'Journeys pass' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-branch'), {
      target: { value: 'autopilot/preview' },
    });
    expect(screen.getByTestId('autopilot-setup-start')).not.toBeDisabled();
  });

  it('refuses reserved default-branch names', () => {
    render(<AutopilotSetupPrompt sessionId="session-1" />);
    fireEvent.change(screen.getByTestId('autopilot-setup-brief'), {
      target: { value: 'Harden preview' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-goal'), {
      target: { value: 'Journeys pass' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-branch'), {
      target: { value: 'main' },
    });
    expect(screen.getByTestId('autopilot-setup-start')).toBeDisabled();
  });

  it('posts the setup card to the session Autopilot endpoint', async () => {
    const onStarted = vi.fn();
    render(<AutopilotSetupPrompt sessionId="session-1" onStarted={onStarted} />);
    fireEvent.change(screen.getByTestId('autopilot-setup-duration'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-brief'), {
      target: { value: 'Harden preview' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-goal'), {
      target: { value: 'Journeys pass' },
    });
    fireEvent.change(screen.getByTestId('autopilot-setup-branch'), {
      target: { value: 'autopilot/preview' },
    });
    fireEvent.click(screen.getByTestId('autopilot-setup-start'));

    await waitFor(() => {
      expect(api.startSessionAutopilot).toHaveBeenCalledWith('session-1', {
        durationHours: 0,
        brief: 'Harden preview',
        goal: 'Journeys pass',
        escalation: 'medium',
        branch: 'autopilot/preview',
      });
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });
});
