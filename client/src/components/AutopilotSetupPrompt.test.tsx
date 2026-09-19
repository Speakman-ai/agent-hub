import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    startSessionAutopilot: vi.fn(),
    uploadFile: vi.fn(),
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

const attachment = {
  id: 'upload-1',
  filename: 'upload-1.png',
  originalName: 'reference.png',
  contentType: 'image/png',
  url: '/uploads/upload-1.png',
};

function fillSetup() {
  fireEvent.change(screen.getByTestId('autopilot-setup-brief'), {
    target: { value: 'Match the reference' },
  });
  fireEvent.change(screen.getByTestId('autopilot-setup-goal'), {
    target: { value: 'Preview matches' },
  });
  fireEvent.change(screen.getByTestId('autopilot-setup-branch'), {
    target: { value: 'autopilot/reference' },
  });
}

describe('Autopilot brief attachments', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uploads selected files before starting and sends their references', async () => {
    let finishUpload!: (value: typeof attachment) => void;
    vi.mocked(api.uploadFile).mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    render(<AutopilotSetupPrompt sessionId="session-1" />);
    fillSetup();
    const file = new File(['reference'], 'reference.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
    expect(screen.getByText('reference.png')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('autopilot-setup-start'));
    expect(api.uploadFile).toHaveBeenCalledWith(file);
    expect(api.startSessionAutopilot).not.toHaveBeenCalled();
    expect(screen.getByTestId('autopilot-setup-start')).toBeDisabled();
    finishUpload(attachment);
    await waitFor(() =>
      expect(api.startSessionAutopilot).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ images: [attachment] }),
      ),
    );
  });

  it('accepts pasted and dropped files and removes them before submission', async () => {
    render(<AutopilotSetupPrompt sessionId="session-1" />);
    fillSetup();
    const file = new File(['reference'], 'reference.png', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('autopilot-setup-brief'), {
      clipboardData: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference.png' }));
    fireEvent.drop(screen.getByTestId('autopilot-setup-prompt'), {
      dataTransfer: { files: [new File(['spec'], 'spec.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));
    fireEvent.click(screen.getByTestId('autopilot-setup-start'));
    await waitFor(() => expect(api.startSessionAutopilot).toHaveBeenCalled());
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps the form and attachments when uploading fails, allowing retry', async () => {
    vi.mocked(api.uploadFile)
      .mockRejectedValueOnce(new Error('Upload failed'))
      .mockResolvedValueOnce(attachment);
    render(<AutopilotSetupPrompt sessionId="session-1" />);
    fillSetup();
    fireEvent.change(screen.getByLabelText('Attach files'), {
      target: { files: [new File(['reference'], 'reference.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByTestId('autopilot-setup-start'));
    await waitFor(() => expect(screen.getByText('Upload failed')).toBeInTheDocument());
    expect(api.startSessionAutopilot).not.toHaveBeenCalled();
    expect(screen.getByText('reference.png')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('autopilot-setup-start'));
    await waitFor(() =>
      expect(api.startSessionAutopilot).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ images: [attachment] }),
      ),
    );
  });
});
