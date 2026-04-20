import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
  saveConnectionConfig: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../utils/orgs.js', () => ({
  createOrg: vi.fn(),
  switchOrg: vi.fn(),
  getActiveOrg: vi.fn(),
  updateOrg: vi.fn(),
}));

import SetupWizard from './SetupWizard.jsx';
import { saveConnectionConfig, testConnection } from '../utils/connection.js';
import { createOrg, switchOrg, updateOrg, getActiveOrg } from '../utils/orgs.js';

beforeEach(() => {
  saveConnectionConfig.mockReset();
  testConnection.mockReset();
  createOrg.mockReset();
  switchOrg.mockReset();
  updateOrg.mockReset();
  getActiveOrg.mockReset();
  getActiveOrg.mockReturnValue(null);
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

async function advanceToOrgStep() {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(screen.getByText(/Connection Mode/i)).toBeInTheDocument());
}

describe('SetupWizard — remote mode', () => {
  it('saves connection config and navigates without touching local orgs', async () => {
    testConnection.mockResolvedValue({ ok: true, message: 'Connected' });
    window.electronAPI = { navigateToOrg: vi.fn() };

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    // Pick Remote
    fireEvent.click(screen.getByRole('button', { name: /remote/i }));

    // Fill URL
    fireEvent.change(screen.getByPlaceholderText(/my-server\.example\.com/i), {
      target: { value: 'https://hub.example.com/' },
    });

    // Click Continue — component will run its own testConnection internally
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(saveConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteUrl: 'https://hub.example.com',
        apiKey: '',
      });
    });
    expect(window.electronAPI.navigateToOrg).toHaveBeenCalled();
    // Critically: no local org was created or updated.
    expect(createOrg).not.toHaveBeenCalled();
    expect(updateOrg).not.toHaveBeenCalled();
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it('blocks progression when remote test fails', async () => {
    testConnection.mockResolvedValue({ ok: false, message: 'refused' });
    window.electronAPI = { navigateToOrg: vi.fn() };

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    fireEvent.click(screen.getByRole('button', { name: /remote/i }));
    fireEvent.change(screen.getByPlaceholderText(/my-server\.example\.com/i), {
      target: { value: 'https://bad.example.com' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    // Still on step 2 (org step), config not saved, navigation not triggered.
    expect(saveConnectionConfig).not.toHaveBeenCalled();
    expect(window.electronAPI.navigateToOrg).not.toHaveBeenCalled();
    expect(await screen.findByText(/connection test failed/i)).toBeInTheDocument();
  });

  it('requires a URL before continuing in remote mode', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    fireEvent.click(screen.getByRole('button', { name: /remote/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(testConnection).not.toHaveBeenCalled();
    expect(saveConnectionConfig).not.toHaveBeenCalled();
    expect(await screen.findByText(/enter a server url/i)).toBeInTheDocument();
  });
});

describe('SetupWizard — local mode (regression)', () => {
  it('creates a local org and advances to step 3', async () => {
    createOrg.mockResolvedValue({ id: 'org-new' });

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    // Default mode is local — just click Continue.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(createOrg).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg).toHaveBeenCalledWith('org-new');
    // Critically: no connection config was rewritten for the local path.
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });
});
