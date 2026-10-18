import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    listPrEnvironmentShareLinks: vi.fn(),
    createPrEnvironmentShareLink: vi.fn(),
    revokePrEnvironmentShareLink: vi.fn(),
    setPrEnvironmentSharePassword: vi.fn(),
    generatePrEnvironmentSharePassword: vi.fn(),
  },
}));

import { api } from '../utils/api';
import PrEnvironmentShareLinks from './PrEnvironmentShareLinks';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const future = new Date(Date.now() + 3 * 86400_000).toISOString();
const link = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  projectId: 'demo',
  prNumber: 7,
  label: 'QA vendor',
  url: 'https://pr-7--demo.preview.example.com/?share=ahs_x',
  status: 'active',
  createdBy: 'u1',
  createdAt: new Date().toISOString(),
  expiresAt: future,
  revokedAt: null,
  canRevoke: true,
  ...over,
});

describe('PrEnvironmentShareLinks', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocked)) fn.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('reveals and copies the generated guard password, hiding it again after a PR switch', async () => {
    const password = 'generated-guard-password';
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [],
      passwordRequired: true,
      generatedPassword: password,
      canManage: true,
      canSetPassword: true,
    });
    const view = render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText('Agent Hub URL guard password');
    expect(screen.queryByText(password)).toBeNull();
    fireEvent.click(screen.getByText('Reveal password'));
    expect(screen.getByText(password)).toBeTruthy();
    fireEvent.click(screen.getByText('Copy password'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(password));
    fireEvent.click(screen.getByText('Hide password'));
    expect(screen.queryByText(password)).toBeNull();
    fireEvent.click(screen.getByText('Reveal password'));
    view.rerender(<PrEnvironmentShareLinks projectId="demo" prNumber={8} />);
    await screen.findByText('Reveal password');
    expect(screen.queryByText(password)).toBeNull();
  });

  it('generates a revealable replacement for a custom password', async () => {
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [],
      passwordRequired: true,
      generatedPassword: null,
      canManage: true,
      canSetPassword: true,
    });
    mocked.generatePrEnvironmentSharePassword.mockImplementation(async () => {
      mocked.listPrEnvironmentShareLinks.mockResolvedValue({
        links: [],
        passwordRequired: true,
        generatedPassword: 'replacement-password',
        canManage: true,
        canSetPassword: true,
      });
      return { passwordRequired: true };
    });
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    fireEvent.click(await screen.findByText('Generate new password'));
    await screen.findByText('Reveal password');
    expect(mocked.generatePrEnvironmentSharePassword).toHaveBeenCalledWith('demo');
    fireEvent.click(screen.getByText('Reveal password'));
    expect(screen.getByText('replacement-password')).toBeTruthy();
  });

  it('renders nothing without wildcard ingress', async () => {
    mocked.listPrEnvironmentShareLinks.mockRejectedValue(
      Object.assign(new Error('needs ingress'), {
        status: 400,
        code: 'pr_env_ingress_not_configured',
      }),
    );
    const { container } = render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await waitFor(() => expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('lists links and lets a manager create, copy, and revoke', async () => {
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [
        link(),
        link({ id: 'l2', label: null, url: null, status: 'revoked', canRevoke: false }),
      ],
      passwordRequired: false,
      canManage: true,
      canSetPassword: false,
    });
    mocked.createPrEnvironmentShareLink.mockResolvedValue({ link: link({ id: 'l3' }) });
    mocked.revokePrEnvironmentShareLink.mockResolvedValue({ link: link({ status: 'revoked' }) });
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText('Share links (1 active)');
    expect(screen.getAllByTestId('pr-share-link-row')).toHaveLength(2);
    expect(screen.getByText('revoked')).toBeTruthy();
    expect(screen.getAllByTestId('pr-share-revoke')).toHaveLength(1);
    expect(screen.queryByTestId('pr-share-password')).toBeNull();

    fireEvent.change(screen.getByTestId('pr-share-label'), { target: { value: 'Client' } });
    fireEvent.change(screen.getByTestId('pr-share-expiry'), { target: { value: '24' } });
    fireEvent.click(screen.getByTestId('pr-share-create'));
    await waitFor(() =>
      expect(mocked.createPrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, {
        expiresInHours: 24,
        label: 'Client',
      }),
    );
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link().url));

    fireEvent.click(screen.getByTestId('pr-share-revoke'));
    await waitFor(() =>
      expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, 'l1'),
    );
  });

  it('hides management for members who cannot manage, and shows the password for admins', async () => {
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [link({ canRevoke: false })],
      passwordRequired: true,
      canManage: false,
      canSetPassword: true,
    });
    mocked.setPrEnvironmentSharePassword.mockResolvedValue({ passwordRequired: false });
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText(/password required/);
    expect(screen.queryByTestId('pr-share-create')).toBeNull();
    expect(screen.queryByTestId('pr-share-revoke')).toBeNull();
    fireEvent.click(screen.getByTestId('pr-share-password-clear'));
    await waitFor(() =>
      expect(mocked.setPrEnvironmentSharePassword).toHaveBeenCalledWith('demo', null),
    );
  });

  it('shows Revoke on a link the caller created even without manage rights', async () => {
    mocked.listPrEnvironmentShareLinks.mockResolvedValue({
      links: [link({ id: 'mine', canRevoke: true }), link({ id: 'theirs', canRevoke: false })],
      passwordRequired: false,
      canManage: false,
      canSetPassword: false,
    });
    mocked.revokePrEnvironmentShareLink.mockResolvedValue({});
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText('Share links (2 active)');
    expect(screen.queryByTestId('pr-share-create')).toBeNull();
    const buttons = screen.getAllByTestId('pr-share-revoke');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalledWith('demo', 7, 'mine'),
    );
  });

  it('a transient failure shows an error with Retry, and Retry recovers', async () => {
    mocked.listPrEnvironmentShareLinks
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 502'), { status: 502 }))
      .mockResolvedValue({
        links: [link()],
        passwordRequired: false,
        canManage: false,
        canSetPassword: false,
      });
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    expect((await screen.findByTestId('pr-share-error')).textContent).toContain('HTTP 502');
    fireEvent.click(screen.getByTestId('pr-share-retry'));
    await screen.findByText('Share links (1 active)');
    expect(screen.queryByTestId('pr-share-error')).toBeNull();
  });

  it('retries a failed load on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listPrEnvironmentShareLinks
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue({
          links: [],
          passwordRequired: false,
          canManage: false,
          canSetPassword: false,
        });
      render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
      await screen.findByTestId('pr-share-error');
      await vi.advanceTimersByTimeAsync(15_000);
      await screen.findByText('Share links');
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the loaded list when a refresh fails', async () => {
    mocked.listPrEnvironmentShareLinks
      .mockResolvedValueOnce({
        links: [link()],
        passwordRequired: false,
        canManage: true,
        canSetPassword: false,
      })
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { status: 503 }));
    mocked.revokePrEnvironmentShareLink.mockResolvedValue({});
    render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText('Share links (1 active)');
    fireEvent.click(screen.getByTestId('pr-share-revoke'));
    expect((await screen.findByTestId('pr-share-error')).textContent).toContain('HTTP 503');
    expect(screen.getAllByTestId('pr-share-link-row')).toHaveLength(1);
  });

  it('a mutation that finishes after a PR switch does not touch the new PR', async () => {
    let finishRevoke: (v: unknown) => void = () => {};
    mocked.revokePrEnvironmentShareLink.mockImplementation(
      () => new Promise((resolve) => (finishRevoke = resolve)),
    );
    mocked.listPrEnvironmentShareLinks.mockImplementation(async (_p: string, n: number) => ({
      links: [link({ id: n === 7 ? 'a-link' : 'b-link', label: n === 7 ? 'From A' : 'From B' })],
      passwordRequired: false,
      canManage: true,
      canSetPassword: false,
    }));
    const { rerender } = render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
    await screen.findByText('From A');
    fireEvent.click(screen.getByTestId('pr-share-revoke'));
    await waitFor(() => expect(mocked.revokePrEnvironmentShareLink).toHaveBeenCalled());

    rerender(<PrEnvironmentShareLinks projectId="demo" prNumber={8} />);
    await screen.findByText('From B');
    expect(screen.queryByText('From A')).toBeNull();
    // B is not stuck behind A's pending mutation.
    expect((screen.getByTestId('pr-share-revoke') as HTMLButtonElement).disabled).toBe(false);

    mocked.listPrEnvironmentShareLinks.mockClear();
    finishRevoke({});
    await new Promise((r) => setTimeout(r, 20));
    // A's completion did not reload A into the panel now showing B.
    expect(mocked.listPrEnvironmentShareLinks).not.toHaveBeenCalled();
    expect(screen.getByText('From B')).toBeTruthy();
    expect(screen.queryByText('From A')).toBeNull();

    fireEvent.click(screen.getByTestId('pr-share-revoke'));
    await waitFor(() =>
      expect(mocked.revokePrEnvironmentShareLink).toHaveBeenLastCalledWith('demo', 8, 'b-link'),
    );
  });

  it('a retry slower than the retry interval is not overlapped or discarded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finishRetry: (v: unknown) => void = () => {};
      mocked.listPrEnvironmentShareLinks
        .mockResolvedValueOnce({
          links: [link({ label: 'Old list' })],
          passwordRequired: false,
          canManage: true,
          canSetPassword: false,
        })
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { status: 503 }))
        .mockImplementationOnce(() => new Promise((resolve) => (finishRetry = resolve)));
      mocked.revokePrEnvironmentShareLink.mockResolvedValue({});
      render(<PrEnvironmentShareLinks projectId="demo" prNumber={7} />);
      await screen.findByText('Old list');
      // A mutation's refresh fails: the old list stays, with the error.
      fireEvent.click(screen.getByTestId('pr-share-revoke'));
      await screen.findByTestId('pr-share-error');
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(2);

      // The automatic retry starts and takes 40 s to answer.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
      expect((screen.getByTestId('pr-share-retry') as HTMLButtonElement).disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      // No second retry was started on top of the pending one.
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Old list')).toBeTruthy();

      finishRetry({
        links: [link({ label: 'Fresh list' })],
        passwordRequired: false,
        canManage: true,
        canSetPassword: false,
      });
      await screen.findByText('Fresh list');
      expect(screen.queryByTestId('pr-share-error')).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocked.listPrEnvironmentShareLinks).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
