import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WebhookConfigBanner from './WebhookConfigBanner.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    autoConfigureProjectWebhook: vi.fn(),
  },
}));

describe('WebhookConfigBanner', () => {
  beforeEach(() => {
    api.autoConfigureProjectWebhook.mockReset();
  });

  it('renders the missing-webhook nudge with a "Configure automatically" action', () => {
    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={() => {}} />);
    expect(screen.getByTestId('webhook-config-banner')).toBeInTheDocument();
    expect(screen.getByText(/PR reviewer is not active/i)).toBeInTheDocument();
    expect(screen.getByTestId('webhook-config-banner-action')).toHaveTextContent(
      /Configure automatically/i,
    );
  });

  it('calls the API + fires onConfigured on the happy path', async () => {
    api.autoConfigureProjectWebhook.mockResolvedValue({
      config: { id: 42 },
      registration: { ok: true, hookId: 12345 },
    });
    const onConfigured = vi.fn();

    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={onConfigured} />);
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));

    await waitFor(() => {
      expect(api.autoConfigureProjectWebhook).toHaveBeenCalledWith('agent-hub');
    });
    await waitFor(() => {
      expect(onConfigured).toHaveBeenCalledTimes(1);
    });
    // No error / warning surfaces on the success path.
    expect(screen.queryByTestId('webhook-config-banner-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('webhook-config-banner-warning')).not.toBeInTheDocument();
  });

  it('surfaces a warning when registration.ok is false but the local row was created', async () => {
    api.autoConfigureProjectWebhook.mockResolvedValue({
      config: { id: 42 },
      registration: { ok: false, error: 'gh: not authenticated' },
    });
    const onConfigured = vi.fn();

    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={onConfigured} />);
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-config-banner-warning')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-config-banner-warning')).toHaveTextContent(
      /gh: not authenticated/i,
    );
    // onConfigured still fires — the local row exists, so the parent
    // should refetch and let the banner drop out.
    expect(onConfigured).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error and does NOT call onConfigured when the API rejects', async () => {
    api.autoConfigureProjectWebhook.mockRejectedValue(new Error('500: server boom'));
    const onConfigured = vi.fn();

    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={onConfigured} />);
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-config-banner-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-config-banner-error')).toHaveTextContent(/server boom/);
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it('disables the action button while the API call is in flight', async () => {
    let resolve;
    const pending = new Promise((r) => {
      resolve = r;
    });
    api.autoConfigureProjectWebhook.mockReturnValue(pending);

    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={() => {}} />);
    const action = screen.getByTestId('webhook-config-banner-action');
    fireEvent.click(action);

    await waitFor(() => {
      expect(action).toBeDisabled();
      expect(action).toHaveTextContent(/Configuring/i);
    });

    resolve({ config: { id: 1 }, registration: { ok: true } });
    await waitFor(() => {
      expect(action).not.toBeDisabled();
    });
  });
});
