import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReleaseNotificationSettingsSection from './ReleaseNotificationSettingsSection';
import { api } from '../utils/api';

vi.mock('../utils/api.js', () => ({
  api: {
    getReleaseNotificationSettings: vi.fn(),
    updateReleaseNotificationSettings: vi.fn(),
    resetReleaseNotificationSettings: vi.fn(),
    addReleaseDigestRecipient: vi.fn(),
    updateReleaseDigestRecipient: vi.fn(),
    removeReleaseDigestRecipient: vi.fn(),
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
  releaseDigestRecipients: [],
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

  it('adds release digest recipients and blocks duplicate emails client-side', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce(defaultSettings);
    apiMock.addReleaseDigestRecipient.mockResolvedValueOnce({
      id: 'rec-1',
      projectId: 'proj-1',
      email: 'digest@example.com',
      displayLabel: 'Customer list',
      enabled: true,
      createdBy: 'user-1',
      updatedBy: 'user-1',
      createdAt: 'now',
      updatedAt: 'now',
    });

    render(<ReleaseNotificationSettingsSection projectId="proj-1" />);

    fireEvent.change(await screen.findByLabelText('Release digest recipient email'), {
      target: { value: 'digest@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Release digest recipient label'), {
      target: { value: 'Customer list' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() =>
      expect(api.addReleaseDigestRecipient).toHaveBeenCalledWith('proj-1', {
        email: 'digest@example.com',
        displayLabel: 'Customer list',
      }),
    );
    expect(await screen.findByText('digest@example.com')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Release digest recipient email'), {
      target: { value: ' DIGEST@example.com ' },
    });
    expect(screen.getByText('This recipient is already on the list.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();
  });

  it('toggles disabled release digest recipients', async () => {
    apiMock.getReleaseNotificationSettings.mockResolvedValueOnce({
      ...defaultSettings,
      releaseDigestRecipients: [
        {
          id: 'rec-1',
          projectId: 'proj-1',
          email: 'digest@example.com',
          displayLabel: null,
          enabled: false,
          createdBy: 'user-1',
          updatedBy: 'user-1',
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
    });
    apiMock.updateReleaseDigestRecipient.mockResolvedValueOnce({
      id: 'rec-1',
      projectId: 'proj-1',
      email: 'digest@example.com',
      displayLabel: null,
      enabled: true,
      createdBy: 'user-1',
      updatedBy: 'user-1',
      createdAt: 'now',
      updatedAt: 'now',
    });

    render(<ReleaseNotificationSettingsSection projectId="proj-1" />);

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() =>
      expect(api.updateReleaseDigestRecipient).toHaveBeenCalledWith('proj-1', 'rec-1', {
        enabled: true,
      }),
    );
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
  });
});
