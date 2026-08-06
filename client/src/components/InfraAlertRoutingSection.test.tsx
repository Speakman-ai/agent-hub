import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfraAlertRoutingSection from './InfraAlertRoutingSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getInfraAlertRouting: vi.fn(),
    updateInfraAlertRouting: vi.fn(),
  },
}));

const getInfraAlertRoutingMock = vi.mocked(api.getInfraAlertRouting);
const updateInfraAlertRoutingMock = vi.mocked(api.updateInfraAlertRouting);

describe('InfraAlertRoutingSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the previous project routing when the new project request fails', async () => {
    getInfraAlertRoutingMock
      .mockResolvedValueOnce({
        routing: [
          {
            severity: 'critical',
            channels: { in_app: true, push: true, email: true },
          },
        ],
      } as any)
      .mockRejectedValueOnce(new Error('routing unavailable'));

    const { rerender } = render(<InfraAlertRoutingSection projectId="project-a" />);
    await waitFor(() => expect(getInfraAlertRoutingMock).toHaveBeenCalledWith('project-a'));
    expect(screen.getAllByRole('button', { name: 'In-app' })[0]).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    rerender(<InfraAlertRoutingSection projectId="project-b" />);
    await waitFor(() => expect(screen.getByText('routing unavailable')).toBeInTheDocument());

    for (const button of screen.getAllByRole('button', { name: 'In-app' })) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('ignores a save response from the previous project', async () => {
    let resolveSave!: (value: unknown) => void;
    getInfraAlertRoutingMock
      .mockResolvedValueOnce({
        routing: [
          {
            severity: 'critical',
            channels: { in_app: true, push: true, email: true },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        routing: [
          {
            severity: 'critical',
            channels: { in_app: false, push: false, email: false },
          },
        ],
      } as any);
    updateInfraAlertRoutingMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }) as any,
    );

    const { rerender } = render(<InfraAlertRoutingSection projectId="project-a" />);
    await waitFor(() => expect(getInfraAlertRoutingMock).toHaveBeenCalledWith('project-a'));
    fireEvent.click(screen.getAllByRole('button', { name: 'In-app' })[0]);
    await waitFor(() =>
      expect(updateInfraAlertRoutingMock).toHaveBeenCalledWith('project-a', expect.anything()),
    );

    rerender(<InfraAlertRoutingSection projectId="project-b" />);
    await waitFor(() => expect(getInfraAlertRoutingMock).toHaveBeenCalledWith('project-b'));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'In-app' })[0]).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );

    resolveSave({
      routing: [
        {
          severity: 'critical',
          channels: { in_app: true, push: true, email: true },
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'In-app' })[0]).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
  });
});
