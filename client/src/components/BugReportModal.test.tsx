import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BugReportModal from './BugReportModal';
import {
  BUG_REPORT_ENDPOINT,
  BUG_REPORT_PROJECT_ID,
  MAX_BUG_REPORT_ATTACHMENTS,
} from '../utils/bugReport';

const replayMocks = vi.hoisted(() => ({
  flushSessionReplayRefWithReason: vi.fn(),
}));

vi.mock('../utils/sessionReplay', () => ({
  flushSessionReplayRefWithReason: replayMocks.flushSessionReplayRefWithReason,
}));

const captureMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/bugReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/bugReport')>()),
  captureScreenshot: captureMock,
}));

// Polyfill a no-op Object URL API in jsdom for the preview image.
beforeEach(() => {
  replayMocks.flushSessionReplayRefWithReason.mockReset();
  replayMocks.flushSessionReplayRefWithReason.mockResolvedValue({
    ref: null,
    reason: 'recorder-not-initialized',
  });
  if (!('createObjectURL' in (URL as any))) (URL as any).createObjectURL = () => 'blob:mock';
  if (!('revokeObjectURL' in (URL as any))) (URL as any).revokeObjectURL = () => {};
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeBlob() {
  return new Blob(['fake-png-bytes'], { type: 'image/png' });
}

describe('BugReportModal', () => {
  it('disables submit when title is empty', () => {
    render(
      <BugReportModal
        isOpen
        onClose={() => {}}
        initialScreenshotBlob={makeBlob()}
        projectId="proj-1"
        agentId="agent-1"
      />,
    );

    const submitBtn = screen.getByRole('button', { name: /submit bug report/i });
    expect(submitBtn!).toBeDisabled();
  });

  it('enables submit once a title is entered and POSTs FormData to the hard-coded endpoint', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'sess-42', status: 'dispatched' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BugReportModal
        isOpen
        onClose={onClose}
        initialScreenshotBlob={makeBlob()}
        projectId="proj-1"
        agentId="agent-1"
        onToast={onToast}
      />,
    );

    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.change(titleInput, { target: { value: 'Login button does nothing' } } as any);

    const descInput = screen.getByLabelText(/description/i);
    fireEvent.change(descInput, { target: { value: 'Click does not fire.' } } as any);

    const submitBtn = screen.getByRole('button', { name: /submit bug report/i });
    expect(submitBtn!).not.toBeDisabled();

    fireEvent.click(submitBtn as any);

    await waitFor(() => expect(fetchMock!).toHaveBeenCalledTimes(1));

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url!).toBe(BUG_REPORT_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.mode).toBe('cors');
    expect(init.body).toBeInstanceOf(FormData);

    const fd = init.body;
    expect(fd.get('title')).toBe('Login button does nothing');
    expect(fd.get('description')).toBe('Click does not fire.');
    expect(fd.get('severity')).toBe('medium');
    // The intake target project is fixed to BUG_REPORT_PROJECT_ID — the
    // modal's `projectId` prop ("proj-1" above) MUST be overridden so reports
    // always flow to the central agent-hub project.
    expect(fd.get('currentProjectId')).toBe(BUG_REPORT_PROJECT_ID);
    expect(fd.get('currentProjectId')).not.toBe('proj-1');
    expect(fd.get('currentAgentId')).toBe('agent-1');
    const screenshot = fd.get('screenshot');
    expect(screenshot!).toBeInstanceOf(Blob);
    expect(screenshot.type).toBe('image/png');

    await waitFor(() => expect(onClose!).toHaveBeenCalled());
    expect(onToast!).toHaveBeenCalledWith(expect.stringContaining('Bug reported'), 'info');
  });

  it('retries a failed replay upload and submits the retry ref', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'sess-42', status: 'dispatched' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    replayMocks.flushSessionReplayRefWithReason
      .mockResolvedValueOnce({ ref: null, reason: 'upload-failed' })
      .mockResolvedValueOnce({ ref: '/uploads/replay-retry.json', reason: null });

    render(
      <BugReportModal
        isOpen
        onClose={() => {}}
        initialScreenshotBlob={makeBlob()}
        projectId="proj-1"
        agentId="agent-1"
      />,
    );

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Replay should attach' },
    } as any);
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }) as any);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(replayMocks.flushSessionReplayRefWithReason).toHaveBeenCalledTimes(2);
    expect(replayMocks.flushSessionReplayRefWithReason).toHaveBeenNthCalledWith(
      1,
      { trigger: 'bug-report' },
      30_000,
    );
    expect(replayMocks.flushSessionReplayRefWithReason).toHaveBeenNthCalledWith(
      2,
      { trigger: 'bug-report', retry: true },
      30_000,
    );

    const fd = fetchMock.mock.calls[0][1].body;
    expect(fd.get('replayRef')).toBe('/uploads/replay-retry.json');
    expect(fd.get('replayMissReason')).toBeNull();
  });

  it('submits the bug report with a miss reason when replay upload fails twice', async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'sess-42', status: 'dispatched' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    replayMocks.flushSessionReplayRefWithReason.mockResolvedValue({
      ref: null,
      reason: 'upload-failed',
    });

    render(
      <BugReportModal
        isOpen
        onClose={onClose}
        initialScreenshotBlob={makeBlob()}
        projectId="proj-1"
        agentId="agent-1"
      />,
    );

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Replay should not be lost' },
    } as any);
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }) as any);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(replayMocks.flushSessionReplayRefWithReason).toHaveBeenCalledTimes(2);
    const fd = fetchMock.mock.calls[0][1].body;
    expect(fd.get('replayRef')).toBeNull();
    expect(fd.get('replayMissReason')).toBe('upload-failed');
    expect(screen.queryByText(/session replay upload failed/i)).not.toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('submits the bug report with a miss reason when replay flush throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'sess-42', status: 'dispatched' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    replayMocks.flushSessionReplayRefWithReason.mockRejectedValue(new Error('network failed'));

    render(
      <BugReportModal
        isOpen
        onClose={() => {}}
        initialScreenshotBlob={makeBlob()}
        projectId="proj-1"
        agentId="agent-1"
      />,
    );

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Replay upload exception should not block' },
    } as any);
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }) as any);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const fd = fetchMock.mock.calls[0][1].body;
    expect(fd.get('replayRef')).toBeNull();
    expect(fd.get('replayMissReason')).toBe('upload-failed');
  });

  it('includes the selected severity in FormData', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 's1', status: 'dispatched' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BugReportModal
        isOpen
        onClose={() => {}}
        initialScreenshotBlob={makeBlob()}
        projectId="p"
        agentId="a"
      />,
    );

    fireEvent.change(screen.getByLabelText(/title/i as any), {
      target: { value: 'Crash on launch' },
    });
    fireEvent.change(screen.getByLabelText(/^severity$/i as any), {
      target: { value: 'critical' },
    });

    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i } as any) as any);

    await waitFor(() => expect(fetchMock!).toHaveBeenCalledTimes(1));
    const fd = (fetchMock as any).mock.calls[0][1].body;
    expect(fd.get('severity')).toBe('critical');
  });

  it('submits the initial screenshot miss reason when no screenshot is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'received' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BugReportModal
        isOpen
        onClose={() => {}}
        initialScreenshotBlob={null}
        initialScreenshotMissReason="initial-capture-failed"
        projectId="p"
        agentId="a"
      />,
    );

    fireEvent.change(screen.getByLabelText(/title/i as any), {
      target: { value: 'Screenshot missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i } as any) as any);

    await waitFor(() => expect(fetchMock!).toHaveBeenCalledTimes(1));
    const fd = (fetchMock as any).mock.calls[0][1].body;
    expect(fd.get('screenshot')).toBeNull();
    expect(fd.get('screenshotMissReason')).toBe('initial-capture-failed');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <BugReportModal isOpen={false} onClose={() => {}} initialScreenshotBlob={null} />,
    );
    expect(container!.firstChild).toBeNull();
  });

  it('shows inline error when submit fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('intake rejected', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<BugReportModal isOpen onClose={() => {}} initialScreenshotBlob={makeBlob()} />);

    fireEvent.change(screen.getByLabelText(/title/i as any), {
      target: { value: 'Something broke' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i } as any) as any);

    await waitFor(() => {
      expect(screen.getByText(/intake rejected/i)).toBeInTheDocument();
    });
  });

  describe('attachments', () => {
    function okFetch() {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ticketId: 't1', status: 'received' }), { status: 201 }),
        );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    function renderModal() {
      render(<BugReportModal isOpen onClose={() => {}} initialScreenshotBlob={makeBlob()} />);
      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Broken upload' } });
    }

    async function submitAndGetForm(fetchMock: any): Promise<FormData> {
      fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      return fetchMock.mock.calls[0][1].body as FormData;
    }

    it('limits the file picker to the types the intake accepts', () => {
      renderModal();
      const accept = screen.getByTestId('bug-report-file-input').getAttribute('accept') || '';
      expect(accept).toContain('application/pdf');
      expect(accept).toContain('image/png');
    });

    it('submits multiple dropped files, including a PDF and a PNG', async () => {
      const fetchMock = okFetch();
      renderModal();
      const pdf = new File(['%PDF-1.4'], 'spec.pdf', { type: 'application/pdf' });
      const png = new File(['png'], 'error.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('bug-report-dropzone'), {
        dataTransfer: { files: [pdf, png] },
      });
      expect(screen.getByText('spec.pdf')).toBeInTheDocument();
      expect(screen.getByText('error.png')).toBeInTheDocument();

      const fd = await submitAndGetForm(fetchMock);
      expect((fd.getAll('attachment') as File[]).map((f) => f.name)).toEqual([
        'spec.pdf',
        'error.png',
      ]);
    });

    it('attaches an image pasted into the dialog', async () => {
      const fetchMock = okFetch();
      renderModal();
      const img = new File(['png'], 'image.png', { type: 'image/png' });
      fireEvent.paste(screen.getByLabelText(/description/i), { clipboardData: { files: [img] } });
      const fd = await submitAndGetForm(fetchMock);
      const [att] = fd.getAll('attachment') as File[];
      expect(att!.name).toMatch(/^pasted-\d+-1\.png$/);
      expect(att!.type).toBe('image/png');
    });

    it('adds extra screenshots as attachments without replacing the primary one', async () => {
      const fetchMock = okFetch();
      captureMock.mockResolvedValue(new Blob(['second'], { type: 'image/png' }));
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /add screenshot/i }));
      await screen.findByText('screenshot-2.png');

      const fd = await submitAndGetForm(fetchMock);
      expect(fd.get('screenshot')).toBeInstanceOf(Blob);
      expect((fd.getAll('attachment') as File[]).map((f) => f.name)).toEqual(['screenshot-2.png']);
    });

    it('tells the reporter when files past the cap are not added', () => {
      renderModal();
      const many = Array.from(
        { length: MAX_BUG_REPORT_ATTACHMENTS + 2 },
        (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }),
      );
      fireEvent.drop(screen.getByTestId('bug-report-dropzone'), { dataTransfer: { files: many } });
      expect(screen.getAllByRole('button', { name: /^remove /i })).toHaveLength(
        MAX_BUG_REPORT_ATTACHMENTS,
      );
      expect(screen.getByText(/2 not added/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /attach files/i })).toBeDisabled();
    });

    it('ignores files pasted or dropped while a submit is pending', async () => {
      let resolveFetch: (r: Response) => void = () => {};
      const fetchMock = vi.fn(() => new Promise<Response>((r) => (resolveFetch = r)));
      vi.stubGlobal('fetch', fetchMock);
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const late = new File(['%PDF-1.4'], 'late.pdf', { type: 'application/pdf' });
      fireEvent.drop(screen.getByTestId('bug-report-dropzone'), {
        dataTransfer: { files: [late] },
      });
      fireEvent.paste(screen.getByLabelText(/description/i), {
        clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })] },
      });
      expect(screen.queryByText('late.pdf')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('button', { name: /^remove /i })).toHaveLength(0);

      resolveFetch(new Response(JSON.stringify({ ticketId: 't1' }), { status: 201 }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /submit bug report/i })).toBeInTheDocument(),
      );
    });
  });
});
