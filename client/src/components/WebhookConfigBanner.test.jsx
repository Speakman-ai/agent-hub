import { useState } from 'react';
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

  it('surfaces a warning, does NOT call onConfigured, and toasts when GitHub registration fails', async () => {
    // Regression for the review-blocker: the original code called
    // onConfigured(result) unconditionally, which made the parent
    // refetch projects, flip `webhookConfigured` to true (the local
    // row was just created with enabled=1), and unmount the banner
    // before the operator could read the warning. The current
    // contract: skip onConfigured on registration failure (keeps the
    // banner mounted) AND fire showToast so even if some other refetch
    // path unmounts the banner the message survives.
    api.autoConfigureProjectWebhook.mockResolvedValue({
      config: { id: 42 },
      registration: { ok: false, error: 'gh: not authenticated' },
    });
    const onConfigured = vi.fn();
    const showToast = vi.fn();

    render(
      <WebhookConfigBanner
        projectId="agent-hub"
        onConfigured={onConfigured}
        showToast={showToast}
      />,
    );
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-config-banner-warning')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-config-banner-warning')).toHaveTextContent(
      /gh: not authenticated/i,
    );
    // onConfigured must NOT fire — that's what prevents the banner
    // from unmounting before the warning is read.
    expect(onConfigured).not.toHaveBeenCalled();
    // showToast was the belt-and-suspenders surface — it must fire so
    // the message survives even if a sibling refetch (websocket
    // `projects_updated`, manual refresh) destroys the banner anyway.
    expect(showToast).toHaveBeenCalledTimes(1);
    const toastArgs = showToast.mock.calls[0];
    expect(toastArgs[0]).toMatch(/gh: not authenticated/i);
    expect(toastArgs[1]).toMatchObject({ level: 'warning' });
  });

  it('keeps the warning visible even when the parent re-renders the banner under a `webhookConfigured`-aware gate', async () => {
    // Replicates the real KanbanBoard mount/unmount cycle: the parent
    // gates `<WebhookConfigBanner />` on `project.webhookConfigured ===
    // false`, and refetches projects when something happens. The
    // warning surface must survive that refetch in the
    // registration-failed branch. The previous implementation would
    // call onConfigured → parent refetches → flag flips to true →
    // banner unmounts → warning gone. The fixed implementation must
    // leave the warning intact.
    api.autoConfigureProjectWebhook.mockResolvedValue({
      config: { id: 42 },
      registration: { ok: false, error: 'gh: not authenticated' },
    });

    function Harness() {
      // Initial state — banner shows. If the banner were to (wrongly)
      // call onConfigured, this `refresh` would flip
      // `webhookConfigured` to true and unmount the child.
      const [webhookConfigured, setWebhookConfigured] = useState(false);
      const handleConfigured = () => setWebhookConfigured(true);
      if (webhookConfigured) return <div data-testid="harness-empty" />;
      return (
        <WebhookConfigBanner
          projectId="agent-hub"
          onConfigured={handleConfigured}
          showToast={() => {}}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-config-banner-warning')).toBeInTheDocument();
    });
    // Banner is still mounted (no harness-empty placeholder).
    expect(screen.queryByTestId('harness-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('webhook-config-banner-warning')).toHaveTextContent(
      /gh: not authenticated/i,
    );
  });

  it('still surfaces the warning when showToast is not supplied', async () => {
    // The toast pipe is optional — older mounts may not pass it. The
    // inline warning must still appear.
    api.autoConfigureProjectWebhook.mockResolvedValue({
      config: { id: 42 },
      registration: { ok: false, error: 'gh: not authenticated' },
    });
    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={() => {}} />);
    fireEvent.click(screen.getByTestId('webhook-config-banner-action'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-config-banner-warning')).toBeInTheDocument();
    });
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

  it('disables the action button and sets aria-busy while the API call is in flight', async () => {
    let resolve;
    const pending = new Promise((r) => {
      resolve = r;
    });
    api.autoConfigureProjectWebhook.mockReturnValue(pending);

    render(<WebhookConfigBanner projectId="agent-hub" onConfigured={() => {}} />);
    const action = screen.getByTestId('webhook-config-banner-action');
    // Idle state — aria-busy is false so screen readers don't announce
    // the button as in-progress before the operator clicks.
    expect(action).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(action);

    await waitFor(() => {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute('aria-busy', 'true');
      expect(action).toHaveTextContent(/Configuring/i);
    });

    resolve({ config: { id: 1 }, registration: { ok: true } });
    await waitFor(() => {
      expect(action).not.toBeDisabled();
      expect(action).toHaveAttribute('aria-busy', 'false');
    });
  });
});
