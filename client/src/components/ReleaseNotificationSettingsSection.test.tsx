import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReleaseNotificationSettingsSection from './ReleaseNotificationSettingsSection';
import { api } from '../utils/api';

vi.mock('../utils/api.js', () => ({
  api: {
    getReleaseNotificationSettings: vi.fn(),
    updateReleaseNotificationSettings: vi.fn(),
    resetReleaseNotificationSettings: vi.fn(),
  },
}));

const apiMock = api as any;

const defaultSettings = {
  projectId: 'proj-1',
  releaseDigestPrompt: 'Default prompt',
  defaultReleaseDigestPrompt: 'Default prompt',
  isDefault: true,
  promptMaxLength: 4000,
  factBoundedSystemTemplate: 'Ground every claim in release facts.',
  updatedBy: null,
  updatedAt: null,
};

describe('ReleaseNotificationSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads release notification settings', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce(defaultSettings);

    render(<ReleaseNotificationSettingsSection projectId="proj-1" />);

    expect(await screen.findByDisplayValue('Default prompt')).toBeInTheDocument();
    expect(api.getReleaseNotificationSettings).toHaveBeenCalledWith('proj-1');
    expect(screen.getByText(/using default/i)).toBeInTheDocument();
  });

  it('saves a custom prompt', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce(defaultSettings);
    apiMock.updateReleaseNotificationSettings.mockResolvedValueOnce({
      ...defaultSettings,
      releaseDigestPrompt: 'Group fixes first.',
      isDefault: false,
    });
    const showToast = vi.fn();

    render(<ReleaseNotificationSettingsSection projectId="proj-1" showToast={showToast} />);

    const input = await screen.findByLabelText('Release digest prompt');
    fireEvent.change(input, { target: { value: 'Group fixes first.' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(api.updateReleaseNotificationSettings).toHaveBeenCalledWith('proj-1', {
        releaseDigestPrompt: 'Group fixes first.',
      }),
    );
    expect(showToast).toHaveBeenCalledWith('Release digest prompt saved', 'success');
  });

  it('blocks saving an empty prompt', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce(defaultSettings);

    render(<ReleaseNotificationSettingsSection projectId="proj-1" />);

    const input = await screen.findByLabelText('Release digest prompt');
    fireEvent.change(input, { target: { value: '   ' } });

    expect(screen.getByText('Prompt is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(api.updateReleaseNotificationSettings).not.toHaveBeenCalled();
  });

  it('resets a custom prompt to the default', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce({
      ...defaultSettings,
      releaseDigestPrompt: 'Custom prompt',
      isDefault: false,
    });
    apiMock.resetReleaseNotificationSettings.mockResolvedValueOnce(defaultSettings);

    render(<ReleaseNotificationSettingsSection projectId="proj-1" />);

    expect(await screen.findByDisplayValue('Custom prompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await waitFor(() =>
      expect(api.resetReleaseNotificationSettings).toHaveBeenCalledWith('proj-1'),
    );
    expect(await screen.findByDisplayValue('Default prompt')).toBeInTheDocument();
  });
});
