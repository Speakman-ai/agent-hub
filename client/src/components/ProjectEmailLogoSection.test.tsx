import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ProjectEmailLogoSection from './ProjectEmailLogoSection';
import { api } from '../utils/api';
import { hasRole, isLocalBundledDeployment } from '../utils/auth';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectEmailLogo: vi.fn(),
    updateProjectEmailLogo: vi.fn(),
    deleteProjectEmailLogo: vi.fn(),
    fetchProjectEmailLogoObjectUrl: vi.fn(),
  },
}));

(vi as any).mock('../utils/auth.js', () => ({
  hasRole: vi.fn(() => true),
  isLocalBundledDeployment: vi.fn(() => false),
}));

const LOGO = {
  filename: 'email-logo.png',
  contentType: 'image/png',
  size: 123,
  updatedAt: '2026-08-25T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:fake');
  (globalThis.URL as any).revokeObjectURL = vi.fn();
  (hasRole as any).mockReturnValue(true);
  (isLocalBundledDeployment as any).mockReturnValue(false);
  (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: null });
  (api.fetchProjectEmailLogoObjectUrl as any).mockResolvedValue('blob:fake');
});

describe('ProjectEmailLogoSection', () => {
  it('shows the default-logo placeholder and an Upload button when none is set', async () => {
    render(<ProjectEmailLogoSection projectId="p1" />);
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p1'));
    expect(screen.getByText('Default logo')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Upload/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/i })).toBeNull();
  });

  it('renders an existing logo preview and a Remove button', async () => {
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: LOGO });
    render(<ProjectEmailLogoSection projectId="p1" />);
    const img = (await screen.findByAltText('Project email logo')) as HTMLImageElement;
    expect(img.src).toContain('blob:fake');
    expect(screen.getByRole('button', { name: /Replace/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remove/i })).toBeTruthy();
  });

  it('removes the logo via the API', async () => {
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: LOGO });
    (api.deleteProjectEmailLogo as any).mockResolvedValue({ ok: true, emailLogo: null });
    render(<ProjectEmailLogoSection projectId="p1" />);
    const removeBtn = await screen.findByRole('button', { name: /Remove/i });
    fireEvent.click(removeBtn);
    await waitFor(() => expect(api.deleteProjectEmailLogo).toHaveBeenCalledWith('p1'));
  });

  it('discards a stale preview when the project changes mid-fetch', async () => {
    let resolveStale: (url: string) => void = () => {};
    const stalePreview = new Promise<string>((resolve) => {
      resolveStale = resolve;
    });
    (api.getProjectEmailLogo as any).mockImplementation((id: string) =>
      Promise.resolve({ emailLogo: id === 'p1' ? LOGO : null }),
    );
    (api.fetchProjectEmailLogoObjectUrl as any).mockImplementation((id: string) =>
      id === 'p1' ? stalePreview : Promise.resolve(null),
    );

    const { rerender } = render(<ProjectEmailLogoSection projectId="p1" />);
    // p1's preview fetch has started (but not resolved).
    await waitFor(() => expect(api.fetchProjectEmailLogoObjectUrl).toHaveBeenCalledWith('p1'));

    // Switch to p2 before p1's preview resolves.
    rerender(<ProjectEmailLogoSection projectId="p2" />);
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p2'));

    // The late p1 result must be revoked, not rendered as p2's logo.
    resolveStale('blob:stale-p1');
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale-p1'));
    expect(screen.queryByAltText('Project email logo')).toBeNull();
  });

  it('ignores upload metadata + toast when the project changes mid-upload', async () => {
    const showToast = vi.fn();
    let resolveUpload: (v: any) => void = () => {};
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: null });
    (api.updateProjectEmailLogo as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { container, rerender } = render(
      <ProjectEmailLogoSection projectId="p1" showToast={showToast} />,
    );
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p1'));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(api.updateProjectEmailLogo).toHaveBeenCalledWith('p1', expect.any(String)),
    );

    // Switch projects before the upload resolves.
    rerender(<ProjectEmailLogoSection projectId="p2" showToast={showToast} />);
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p2'));

    // The stale upload result must not set p1's metadata or toast in p2.
    resolveUpload({ emailLogo: LOGO });
    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Project email logo')).toBeNull();
  });

  it('clears the prior project logo synchronously while the new metadata request is pending', async () => {
    let resolveP2: (v: any) => void = () => {};
    (api.getProjectEmailLogo as any).mockImplementation((id: string) =>
      id === 'p1'
        ? Promise.resolve({ emailLogo: LOGO })
        : new Promise((resolve) => {
            resolveP2 = resolve;
          }),
    );
    (api.fetchProjectEmailLogoObjectUrl as any).mockResolvedValue('blob:fake');

    const { rerender } = render(<ProjectEmailLogoSection projectId="p1" />);
    // p1's logo + Remove control are visible.
    await screen.findByAltText('Project email logo');
    expect(screen.getByRole('button', { name: /Remove/i })).toBeTruthy();

    // Switch to p2 whose metadata request never resolves — p1's logo/controls
    // must disappear immediately (not linger until p2 resolves).
    rerender(<ProjectEmailLogoSection projectId="p2" />);
    expect(screen.queryByAltText('Project email logo')).toBeNull();
    expect(screen.getByText('Default logo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/i })).toBeNull();

    resolveP2({ emailLogo: null });
  });

  it('drops a stale upload across an A→B→A switch even though identity matches again', async () => {
    const showToast = vi.fn();
    let resolveUpload: (v: any) => void = () => {};
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: null });
    (api.updateProjectEmailLogo as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { container, rerender } = render(
      <ProjectEmailLogoSection projectId="p1" showToast={showToast} />,
    );
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p1'));

    // Start an upload for p1 (stays pending).
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'l.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(api.updateProjectEmailLogo).toHaveBeenCalledTimes(1));

    // Navigate p1 → p2 → p1 while the upload is in flight (identity is p1 again).
    rerender(<ProjectEmailLogoSection projectId="p2" showToast={showToast} />);
    rerender(<ProjectEmailLogoSection projectId="p1" showToast={showToast} />);
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p2'));

    // The stale p1 upload resolves. Identity matches p1 again, but its captured
    // generation is stale — it must not render its logo/controls or toast.
    resolveUpload({ emailLogo: LOGO });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Remove/i })).toBeNull();
    expect(screen.queryByAltText('Project email logo')).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps the latest preview when same-project requests resolve out of order', async () => {
    let resolveInitial: (u: string) => void = () => {};
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: LOGO });
    (api.updateProjectEmailLogo as any).mockResolvedValue({ emailLogo: LOGO });
    (api.fetchProjectEmailLogoObjectUrl as any)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve('blob:upload'));

    const { container } = render(<ProjectEmailLogoSection projectId="p1" showToast={vi.fn()} />);
    // The initial preview fetch has started but not resolved.
    await waitFor(() => expect(api.fetchProjectEmailLogoObjectUrl).toHaveBeenCalledTimes(1));

    // Upload a replacement while the initial preview is still pending.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'l.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(api.fetchProjectEmailLogoObjectUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const img = screen.getByAltText('Project email logo') as HTMLImageElement;
      expect(img.src).toContain('blob:upload');
    });

    // The stale initial preview resolves LAST — it must be revoked, not shown.
    resolveInitial('blob:initial');
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:initial'));
    const img = screen.getByAltText('Project email logo') as HTMLImageElement;
    expect(img.src).toContain('blob:upload');
  });

  it('never PUTs to a stale project when the FileReader resolves after a switch', async () => {
    // A FileReader that only resolves when we fire its onload, so we can switch
    // projects while the read is pending.
    const instances: Array<{ onload: (() => void) | null; result: string }> = [];
    class DeferredFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result = 'data:image/png;base64,AAA';
      readAsDataURL() {
        instances.push(this);
      }
    }
    const OrigFileReader = (globalThis as any).FileReader;
    (globalThis as any).FileReader = DeferredFileReader as any;
    try {
      (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: null });
      const { container, rerender } = render(
        <ProjectEmailLogoSection projectId="p1" showToast={vi.fn()} />,
      );
      await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p1'));

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'l.png', { type: 'image/png' })] },
      });
      // The FileReader read has started but not resolved.
      await waitFor(() => expect(instances.length).toBe(1));

      // Switch projects while the FileReader is pending.
      rerender(<ProjectEmailLogoSection projectId="p2" showToast={vi.fn()} />);
      await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalledWith('p2'));

      // Resolve the FileReader now — the upload PUT must never be issued for the
      // stale p1 project.
      await act(async () => {
        instances[0].onload?.();
        await Promise.resolve();
      });
      expect(api.updateProjectEmailLogo).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).FileReader = OrigFileReader;
    }
  });

  it('revokes the preview object URL on unmount (no blob leak)', async () => {
    (api.getProjectEmailLogo as any).mockResolvedValue({ emailLogo: LOGO });
    const { unmount } = render(<ProjectEmailLogoSection projectId="p1" />);
    await screen.findByAltText('Project email logo');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('hides edit controls and shows a role note for non-admins', async () => {
    (hasRole as any).mockReturnValue(false);
    (isLocalBundledDeployment as any).mockReturnValue(false);
    render(<ProjectEmailLogoSection projectId="p1" />);
    await waitFor(() => expect(api.getProjectEmailLogo).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull();
    expect(screen.getByText(/Admin role required/i)).toBeTruthy();
  });
});
