import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
}));

vi.mock('../utils/api.js', () => ({
  api: {
    getSupportedIntegrations: vi.fn(),
    listUserIntegrations: vi.fn(),
    getUserIntegration: vi.fn(),
    connectUserIntegration: vi.fn(),
    disconnectUserIntegration: vi.fn(),
  },
}));

import IntegrationsSettingsPage from './IntegrationsSettingsPage.jsx';
import { api } from '../utils/api.js';

const SUPPORTED = [
  { id: 'slack', label: 'Slack', description: 'Slack desc', category: 'communication' },
  { id: 'github', label: 'GitHub', description: 'GitHub desc', category: 'developer' },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getSupportedIntegrations.mockResolvedValue({
    integrations: SUPPORTED,
    providerReady: true,
  });
  api.listUserIntegrations.mockResolvedValue({ integrations: [] });
  api.getUserIntegration.mockResolvedValue(null);
  api.connectUserIntegration.mockResolvedValue({
    authUrl: 'https://nango.test/auth',
    connectionId: 'conn-1',
  });
  api.disconnectUserIntegration.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntegrationsSettingsPage', () => {
  it('renders the SUPPORTED catalogue and a Connect button per row', async () => {
    render(<IntegrationsSettingsPage userId="u1" />);
    await waitFor(() => expect(api.getSupportedIntegrations).toHaveBeenCalled());
    expect(await screen.findByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByTestId('connect-slack')).toBeInTheDocument();
    expect(screen.getByTestId('connect-github')).toBeInTheDocument();
  });

  it('shows the popup-blocked banner when window.open returns null', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);

    render(<IntegrationsSettingsPage userId="u1" />);
    await screen.findByTestId('connect-slack');
    fireEvent.click(screen.getByTestId('connect-slack'));

    await waitFor(() => expect(api.connectUserIntegration).toHaveBeenCalledWith('u1', 'slack'));
    expect(await screen.findByText(/Popup blocked/)).toBeInTheDocument();
  });

  it('flips to Active when the postMessage success arrives without a hard refresh', async () => {
    const popup = { closed: false, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => popup),
    );

    // Track call count: first two calls (initial mount for Slack + GitHub
    // rows) report no row → null; once Connect is clicked we flip to
    // CONNECTED.
    let connectClicked = false;
    api.getUserIntegration.mockImplementation(async () => {
      if (!connectClicked) return null;
      return { app: 'slack', status: 'CONNECTED' };
    });
    api.connectUserIntegration.mockImplementation(async () => {
      connectClicked = true;
      return { authUrl: 'https://nango.test/auth', connectionId: 'conn-1' };
    });

    render(<IntegrationsSettingsPage userId="u1" />);
    await screen.findByTestId('connect-slack');
    fireEvent.click(screen.getByTestId('connect-slack'));

    await waitFor(() => expect(api.connectUserIntegration).toHaveBeenCalledWith('u1', 'slack'));

    // The popup posts a success message → page refetches and renders Active.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'agent-hub:integration:result', app: 'slack', status: 'success' },
        }),
      );
    });

    await waitFor(() => expect(screen.getByTestId('disconnect-slack')).toBeInTheDocument());
  });

  it('disconnects on Disconnect click', async () => {
    api.listUserIntegrations.mockResolvedValue({
      integrations: [{ app: 'slack', status: 'CONNECTED' }],
    });
    api.getUserIntegration.mockResolvedValue({ app: 'slack', status: 'CONNECTED' });

    render(<IntegrationsSettingsPage userId="u1" />);
    await screen.findByTestId('disconnect-slack');
    fireEvent.click(screen.getByTestId('disconnect-slack'));
    await waitFor(() => expect(api.disconnectUserIntegration).toHaveBeenCalledWith('u1', 'slack'));
  });

  it('renders the provider-unavailable banner when providerReady=false', async () => {
    api.getSupportedIntegrations.mockResolvedValue({
      integrations: SUPPORTED,
      providerReady: false,
    });
    render(<IntegrationsSettingsPage userId="u1" />);
    expect(await screen.findByText(/integration provider isn't configured/i)).toBeInTheDocument();
    // Connect buttons are disabled
    const btn = screen.getByTestId('connect-slack');
    expect(btn).toBeDisabled();
  });
});
