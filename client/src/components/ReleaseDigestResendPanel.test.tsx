import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReleaseDigestResendPanel from './ReleaseDigestResendPanel';
import { api } from '../utils/api';

vi.mock('../utils/api.js', () => ({
  api: {
    generateReleaseDigest: vi.fn(),
    resendReleaseDigest: vi.fn(),
  },
}));

const apiMock = api as any;

describe('ReleaseDigestResendPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('generates a digest, lets the operator edit it, and sends the edited text', async () => {
    apiMock.generateReleaseDigest.mockResolvedValueOnce({
      digestMarkdown: '### Admin Updates\n\nGenerated text.',
      subject: 'Release digest for production 1.0.322',
    });
    const released = [{ id: 'n-2', status: 'pending' }];
    apiMock.resendReleaseDigest.mockResolvedValueOnce({
      queued: [{ id: 'n-2' }],
      releaseNotifications: released,
    });
    const onQueued = vi.fn();
    const showToast = vi.fn();

    render(
      <ReleaseDigestResendPanel
        projectId="proj-1"
        deploymentId="dep-1"
        onQueued={onQueued}
        showToast={showToast}
      />,
    );

    fireEvent.click(screen.getByTestId('release-digest-resend-open'));
    const body = await screen.findByDisplayValue(/Generated text\./);
    expect(api.generateReleaseDigest).toHaveBeenCalledWith('proj-1', 'dep-1');
    expect(screen.getByLabelText('Release digest subject')).toHaveValue(
      'Release digest for production 1.0.322',
    );

    fireEvent.change(body, { target: { value: '### Admin Updates\n\nEdited text.' } });
    fireEvent.click(screen.getByRole('button', { name: /send to recipients/i }));

    await waitFor(() =>
      expect(api.resendReleaseDigest).toHaveBeenCalledWith('proj-1', 'dep-1', {
        digestMarkdown: '### Admin Updates\n\nEdited text.',
        subject: 'Release digest for production 1.0.322',
      }),
    );
    expect(onQueued).toHaveBeenCalledWith(released);
    expect(showToast).toHaveBeenCalledWith('Release digest queued for 1 recipient', 'success');
  });

  it('does not send when the operator cancels the confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    apiMock.generateReleaseDigest.mockResolvedValueOnce({ digestMarkdown: 'Text', subject: 'S' });

    render(<ReleaseDigestResendPanel projectId="proj-1" deploymentId="dep-1" />);

    fireEvent.click(screen.getByTestId('release-digest-resend-open'));
    await screen.findByDisplayValue('Text');
    fireEvent.click(screen.getByRole('button', { name: /send to recipients/i }));
    expect(api.resendReleaseDigest).not.toHaveBeenCalled();
  });

  it('shows a generation failure and keeps send disabled with no text', async () => {
    apiMock.generateReleaseDigest.mockRejectedValueOnce(new Error('claude exited 1'));

    render(<ReleaseDigestResendPanel projectId="proj-1" deploymentId="dep-1" />);

    fireEvent.click(screen.getByTestId('release-digest-resend-open'));
    expect(await screen.findByText('claude exited 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send to recipients/i })).toBeDisabled();
  });
});
