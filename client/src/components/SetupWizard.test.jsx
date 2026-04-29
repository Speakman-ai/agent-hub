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

// The wizard renders the same Step 2 heading regardless of build, but the
// Connection Mode section only appears on Electron now (web has no use for
// a Local/Remote toggle — the page's origin *is* the server URL). Tests
// that need the toggle must set `window.electronAPI.isElectron = true`
// *before* calling this helper; web-only tests can advance without it.
async function advanceToOrgStep() {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(screen.getByText(/Create Your Organization/i)).toBeInTheDocument());
}

describe('SetupWizard — remote mode (Electron only)', () => {
  it('saves connection config and navigates without touching local orgs', async () => {
    testConnection.mockResolvedValue({ ok: true, message: 'Connected' });
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };

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
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };

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
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };
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
    // Run as Electron so the toggle is rendered — this test is asserting
    // the local-mode branch still works end-to-end, not the web hiding.
    window.electronAPI = { isElectron: true };

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

describe('SetupWizard — web build hides the Connection Mode toggle', () => {
  // The web client is *served by* the Agent Hub server it talks to, so a
  // Local/Remote toggle is incoherent here: there is no other server it
  // could sensibly point at. Hiding the toggle prevents users from
  // flipping a meaningful-only-on-Electron knob, and (by extension)
  // prevents them from accidentally creating an org with mode='remote'
  // that doesn't match the page origin.

  it('does not render the Connection Mode toggle when window.electronAPI is absent', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    expect(screen.queryByText(/Connection Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remote$/i })).not.toBeInTheDocument();
    // The Org Name field and Continue button must still be there — the
    // wizard stays usable, we're just dropping a meaningless choice.
    expect(screen.getByPlaceholderText('Personal')).toBeInTheDocument();
  });

  it('still creates a local org on Continue (default behavior)', async () => {
    createOrg.mockResolvedValue({ id: 'org-web' });

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(createOrg).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg).toHaveBeenCalledWith('org-web');
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });
});
