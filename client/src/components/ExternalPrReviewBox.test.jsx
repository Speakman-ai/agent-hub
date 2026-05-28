import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExternalPrReviewBox from './ExternalPrReviewBox.jsx';

vi.mock('../utils/api.js', () => ({
  api: {
    reviewExternalPr: vi.fn(),
  },
}));

const { api } = await import('../utils/api.js');

beforeEach(() => {
  api.reviewExternalPr.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExternalPrReviewBox', () => {
  it('disables submit when the URL field is empty', () => {
    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" />);
    const btn = screen.getByRole('button', { name: /review external pr/i });
    expect(btn).toBeDisabled();
  });

  it('disables submit when no reviewer agent is configured', () => {
    render(<ExternalPrReviewBox projectId="p" reviewerAgentId={null} />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/o/r/pull/1' } });
    const btn = screen.getByRole('button', { name: /review external pr/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/no reviewer agent/i);
  });

  it('disables submit on malformed PR URLs', () => {
    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/o/r/issues/1' } });
    expect(screen.getByRole('button', { name: /review external pr/i })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'not-a-url' } });
    expect(screen.getByRole('button', { name: /review external pr/i })).toBeDisabled();
  });

  it('enables submit on a well-formed PR URL', () => {
    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/o/r/pull/42' } });
    expect(screen.getByRole('button', { name: /review external pr/i })).not.toBeDisabled();
  });

  it('calls api.reviewExternalPr with the trimmed URL and shows a success message', async () => {
    api.reviewExternalPr.mockResolvedValueOnce({
      ok: true,
      scheduled: true,
      prNumber: 17,
      repoFullName: 'o/r',
    });
    const onToast = vi.fn();

    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" onToast={onToast} />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, {
      target: { value: '  https://github.com/o/r/pull/17  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /review external pr/i }));

    await waitFor(() => {
      expect(api.reviewExternalPr).toHaveBeenCalledWith('p', 'https://github.com/o/r/pull/17');
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/pr #17/i);
    });
    expect(onToast).toHaveBeenCalledWith(
      expect.stringMatching(/queued/i),
      'success',
      expect.any(Number),
    );
    // Input cleared on success.
    expect(screen.getByLabelText(/external pr url/i).value).toBe('');
  });

  it('shows the server error and strips the leading status code prefix', async () => {
    api.reviewExternalPr.mockRejectedValueOnce(
      new Error(
        '409: This PR was pushed by the Finalize orchestrator (internal). Use the per-row "Nudge reviewer" button to re-trigger review on internal PRs.',
      ),
    );
    const onToast = vi.fn();

    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" onToast={onToast} />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/o/r/pull/9' } });
    fireEvent.click(screen.getByRole('button', { name: /review external pr/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/finalize orchestrator/i);
      expect(alert.textContent).not.toMatch(/^409:/);
    });
    expect(onToast).toHaveBeenCalledWith(
      expect.stringMatching(/finalize orchestrator/i),
      'error',
      expect.any(Number),
    );
  });

  it('keeps the URL in the input on error so the user can retry', async () => {
    api.reviewExternalPr.mockRejectedValueOnce(new Error('502: socket hangup'));
    render(<ExternalPrReviewBox projectId="p" reviewerAgentId="rev" />);
    const input = screen.getByLabelText(/external pr url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/o/r/pull/8' } });
    fireEvent.click(screen.getByRole('button', { name: /review external pr/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/socket hangup/i);
    });
    expect(screen.getByLabelText(/external pr url/i).value).toBe('https://github.com/o/r/pull/8');
  });
});
