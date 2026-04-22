import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BugReportModal from './BugReportModal.jsx';
import { BUG_REPORT_ENDPOINT } from '../utils/bugReport.js';

// Polyfill a no-op Object URL API in jsdom for the preview image.
beforeEach(() => {
  if (!('createObjectURL' in URL)) URL.createObjectURL = () => 'blob:mock';
  if (!('revokeObjectURL' in URL)) URL.revokeObjectURL = () => {};
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
    expect(submitBtn).toBeDisabled();
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
    fireEvent.change(titleInput, { target: { value: 'Login button does nothing' } });

    const descInput = screen.getByLabelText(/description/i);
    fireEvent.change(descInput, { target: { value: 'Click does not fire.' } });

    const submitBtn = screen.getByRole('button', { name: /submit bug report/i });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(BUG_REPORT_ENDPOINT);
    expect(url).toBe('http://3.22.232.193/api/bug-reports');
    expect(init.method).toBe('POST');
    expect(init.mode).toBe('cors');
    expect(init.body).toBeInstanceOf(FormData);

    const fd = init.body;
    expect(fd.get('title')).toBe('Login button does nothing');
    expect(fd.get('description')).toBe('Click does not fire.');
    expect(fd.get('severity')).toBe('medium');
    expect(fd.get('currentProjectId')).toBe('proj-1');
    expect(fd.get('currentAgentId')).toBe('agent-1');
    const screenshot = fd.get('screenshot');
    expect(screenshot).toBeInstanceOf(Blob);
    expect(screenshot.type).toBe('image/png');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Bug reported'), 'info');
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

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Crash on launch' } });
    fireEvent.change(screen.getByLabelText(/^severity$/i), { target: { value: 'critical' } });

    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const fd = fetchMock.mock.calls[0][1].body;
    expect(fd.get('severity')).toBe('critical');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <BugReportModal isOpen={false} onClose={() => {}} initialScreenshotBlob={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows inline error when submit fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('intake rejected', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<BugReportModal isOpen onClose={() => {}} initialScreenshotBlob={makeBlob()} />);

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Something broke' } });
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }));

    await waitFor(() => {
      expect(screen.getByText(/intake rejected/i)).toBeInTheDocument();
    });
  });
});
