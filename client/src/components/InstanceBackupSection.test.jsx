/**
 * Tests for the InstanceBackupSection — manifest rendering, mutually
 * exclusive DB selection, download invocation, and error display.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InstanceBackupSection } from './SettingsPage.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getInstanceBackupManifest: vi.fn(),
    downloadInstanceBackup: vi.fn(),
  },
}));

const SAMPLE_MANIFEST = {
  items: [
    {
      id: 'db.slim',
      label: 'Database — slim',
      description: 'Slim copy',
      estimatedBytes: 200_000_000,
    },
    {
      id: 'db.full',
      label: 'Database — full',
      description: 'Full copy',
      estimatedBytes: 2_500_000_000,
    },
    {
      id: 'config',
      label: 'Config files',
      description: 'config + projects.json',
      estimatedBytes: 30_000,
    },
  ],
};

describe('InstanceBackupSection', () => {
  beforeEach(() => {
    api.getInstanceBackupManifest.mockReset();
    api.downloadInstanceBackup.mockReset();
    // jsdom doesn't implement createObjectURL; stub it.
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:test');
      URL.revokeObjectURL = vi.fn();
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and renders manifest items', async () => {
    api.getInstanceBackupManifest.mockResolvedValue(SAMPLE_MANIFEST);
    render(<InstanceBackupSection />);
    await waitFor(() => {
      expect(screen.getByText('Database — slim')).toBeDefined();
      expect(screen.getByText('Database — full')).toBeDefined();
      expect(screen.getByText('Config files')).toBeDefined();
    });
  });

  it('treats db.slim and db.full as mutually exclusive', async () => {
    api.getInstanceBackupManifest.mockResolvedValue(SAMPLE_MANIFEST);
    render(<InstanceBackupSection />);
    await waitFor(() => screen.getByText('Database — slim'));

    // db.slim is preselected by default → db.full row should be disabled.
    const fullCheckbox = screen
      .getByText('Database — full')
      .closest('label')
      .querySelector('input[type=checkbox]');
    expect(fullCheckbox.disabled).toBe(true);

    // Clear the slim selection by clicking it.
    const slimCheckbox = screen
      .getByText('Database — slim')
      .closest('label')
      .querySelector('input[type=checkbox]');
    fireEvent.click(slimCheckbox);

    // Now db.full should be enabled — pick it.
    await waitFor(() => expect(fullCheckbox.disabled).toBe(false));
    fireEvent.click(fullCheckbox);

    // And the slim row should now be disabled.
    await waitFor(() => expect(slimCheckbox.disabled).toBe(true));
  });

  it('calls downloadInstanceBackup with the selected items', async () => {
    api.getInstanceBackupManifest.mockResolvedValue(SAMPLE_MANIFEST);
    api.downloadInstanceBackup.mockResolvedValue({
      blob: new Blob(['x'], { type: 'application/zip' }),
      filename: 'agent-hub-backup-test.zip',
    });
    render(<InstanceBackupSection />);
    await waitFor(() => screen.getByText('Database — slim'));

    fireEvent.click(screen.getByText('Download backup'));

    await waitFor(() => expect(api.downloadInstanceBackup).toHaveBeenCalledTimes(1));
    const [items] = api.downloadInstanceBackup.mock.calls[0];
    // Default selection is db.slim + config.
    expect([...items].sort()).toEqual(['config', 'db.slim']);
  });

  it('shows an error banner when manifest fetch fails', async () => {
    api.getInstanceBackupManifest.mockRejectedValue(new Error('boom'));
    render(<InstanceBackupSection />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load backup manifest/i)).toBeDefined();
      expect(screen.getByText('boom')).toBeDefined();
    });
  });
});
