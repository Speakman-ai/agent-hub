import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../utils/api.js', () => ({
  api: {
    unstickSessionAutopilot: vi.fn(),
  },
}));

import AutopilotUnstickButton from './AutopilotUnstickButton';
import { api } from '../../utils/api';

describe('AutopilotUnstickButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.unstickSessionAutopilot as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  });

  it('calls the unstick endpoint and onStarted', async () => {
    const onStarted = vi.fn();
    render(<AutopilotUnstickButton sessionId="s1" onStarted={onStarted} />);
    fireEvent.click(screen.getByTestId('autopilot-unstick-button'));
    expect(onStarted).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(api.unstickSessionAutopilot).toHaveBeenCalledWith('s1');
    });
    expect(screen.getByTestId('autopilot-unstick-button')).toHaveTextContent('Unstick');
  });

  it('surfaces API failures', async () => {
    (api.unstickSessionAutopilot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('still busy'),
    );
    const onError = vi.fn();
    render(<AutopilotUnstickButton sessionId="s1" onError={onError} />);
    fireEvent.click(screen.getByTestId('autopilot-unstick-button'));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('still busy');
    });
  });
});
