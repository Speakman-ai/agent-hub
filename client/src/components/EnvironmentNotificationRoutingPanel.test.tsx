import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentNotificationRoutingPanel from './EnvironmentNotificationRoutingPanel';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    getNotificationRouting: vi.fn(),
    updateNotificationRouting: vi.fn(),
  },
}));

function routing(over: any = {}) {
  return {
    environmentName: 'prod',
    isProduction: true,
    ticketReleaseEnabled: true,
    releaseDigestEnabled: true,
    isDefault: true,
    updatedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EnvironmentNotificationRoutingPanel', () => {
  it('loads and reflects the resolved routing for the environment', async () => {
    (api.getNotificationRouting as any).mockResolvedValue({ routing: routing() });
    render(<EnvironmentNotificationRoutingPanel projectId="proj-1" environmentName="prod" />);

    await waitFor(() => expect(screen.getByTestId('env-notification-routing-prod')).toBeTruthy());
    expect(api.getNotificationRouting).toHaveBeenCalledWith('proj-1', 'prod');
    expect((screen.getByLabelText(/reporter/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/release digest/i) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('default (prod)')).toBeTruthy();
  });

  it('shows the non-prod default (nothing) and disables Save until changed', async () => {
    (api.getNotificationRouting as any).mockResolvedValue({
      routing: routing({
        environmentName: 'staging',
        isProduction: false,
        ticketReleaseEnabled: false,
        releaseDigestEnabled: false,
      }),
    });
    render(<EnvironmentNotificationRoutingPanel projectId="proj-1" environmentName="staging" />);

    await waitFor(() => expect(screen.getByText('default (off)')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Sends nothing/)).toBeTruthy();
  });

  it('saves the edited routing selection', async () => {
    (api.getNotificationRouting as any).mockResolvedValue({
      routing: routing({
        environmentName: 'staging',
        isProduction: false,
        ticketReleaseEnabled: false,
        releaseDigestEnabled: false,
      }),
    });
    (api.updateNotificationRouting as any).mockResolvedValue({
      routing: routing({
        environmentName: 'staging',
        isProduction: false,
        ticketReleaseEnabled: true,
        releaseDigestEnabled: false,
        isDefault: false,
        updatedAt: '2026-07-02',
      }),
    });
    const showToast = vi.fn();
    render(
      <EnvironmentNotificationRoutingPanel
        projectId="proj-1"
        environmentName="staging"
        showToast={showToast}
      />,
    );

    await waitFor(() => expect(screen.getByText('default (off)')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/reporter/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.updateNotificationRouting).toHaveBeenCalledWith('proj-1', 'staging', {
        ticketReleaseEnabled: true,
        releaseDigestEnabled: false,
      }),
    );
    await waitFor(() => expect(screen.getByText('custom')).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('saved'), 'success');
  });
});
