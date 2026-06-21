import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectDefaultAutomationSection from './ProjectDefaultAutomationSection.jsx';

vi.mock('../../utils/api.js', () => ({
  api: {
    getProjectUserSettings: vi.fn(),
    updateProjectUserSettings: vi.fn(),
  },
}));

import { api } from '../../utils/api.js';

describe('ProjectDefaultAutomationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and reflects the stored default level', async () => {
    api.getProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: 'push',
    });
    render(<ProjectDefaultAutomationSection projectId="proj-1" />);

    await waitFor(() => {
      const pushRadio = screen.getByDisplayValue('push');
      expect(pushRadio).toBeChecked();
    });
    expect(api.getProjectUserSettings).toHaveBeenCalledWith('proj-1');
  });

  it('selects "No preference" when no default is stored', async () => {
    api.getProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: null,
    });
    render(<ProjectDefaultAutomationSection projectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('__none__')).toBeChecked();
    });
  });

  it('persists a chosen level via PUT', async () => {
    api.getProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: null,
    });
    api.updateProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: 'merge',
    });
    render(<ProjectDefaultAutomationSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByDisplayValue('__none__')).toBeChecked());
    fireEvent.click(screen.getByDisplayValue('merge'));

    await waitFor(() => {
      expect(api.updateProjectUserSettings).toHaveBeenCalledWith('proj-1', {
        defaultFinalizeAutomation: 'merge',
      });
    });
    expect(screen.getByDisplayValue('merge')).toBeChecked();
  });

  it('clears the preference by selecting "No preference"', async () => {
    api.getProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: 'review',
    });
    api.updateProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: null,
    });
    render(<ProjectDefaultAutomationSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByDisplayValue('review')).toBeChecked());
    fireEvent.click(screen.getByDisplayValue('__none__'));

    await waitFor(() => {
      expect(api.updateProjectUserSettings).toHaveBeenCalledWith('proj-1', {
        defaultFinalizeAutomation: null,
      });
    });
  });

  it('reverts the selection when the save fails', async () => {
    api.getProjectUserSettings.mockResolvedValueOnce({
      projectId: 'proj-1',
      defaultFinalizeAutomation: 'manual',
    });
    api.updateProjectUserSettings.mockRejectedValueOnce(new Error('boom'));
    render(<ProjectDefaultAutomationSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByDisplayValue('manual')).toBeChecked());
    fireEvent.click(screen.getByDisplayValue('push'));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('manual')).toBeChecked();
  });
});
