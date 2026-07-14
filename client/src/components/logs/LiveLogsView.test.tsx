import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { api } from '../../utils/api';
import LiveLogsView from './LiveLogsView';
import type { SocketLike } from '../../hooks/useLogTail';
import { SEVERITY_NUMBER } from '../../utils/logStream';

vi.mock('../../utils/connection', () => ({ getWsUrl: () => 'ws://test/ws' }));
vi.mock('../../utils/api', () => ({
  api: { queryLogs: vi.fn().mockResolvedValue({ records: [], nextCursor: null }) },
}));

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function record(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'p1',
    sourceId: 'src-a',
    timeUnixNano: id * 1_000_000,
    observedTimeUnixNano: null,
    severityNumber: SEVERITY_NUMBER.INFO,
    severityText: null,
    body: `line ${id}`,
    serviceName: 'checkout',
    environment: 'prod',
    traceId: null,
    spanId: null,
    fingerprint: null,
    resourceJson: null,
    attributesJson: null,
    scopeJson: null,
    byteSize: 1,
    ingestedAt: 0,
    ...over,
  };
}

const tailOptions = { createSocket: () => new FakeSocket(), reconnectBaseMs: 1_000_000 };

function renderLive() {
  const utils = render(<LiveLogsView projectId="p1" tailOptions={tailOptions} />);
  const sock = FakeSocket.instances[FakeSocket.instances.length - 1];
  act(() => sock.open());
  return { ...utils, sock };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.clearAllMocks();
});

describe('LiveLogsView', () => {
  it('shows an empty state before any records arrive', () => {
    renderLive();
    expect(screen.getByText(/No logs yet/i)).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('renders streamed records newest-first', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1, { body: 'first' }), record(2, { body: 'second' })],
        cursor: 2,
        dropped: 0,
      }),
    );
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('filters the visible tail by minimum severity', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [
          record(1, { body: 'info line', severityNumber: SEVERITY_NUMBER.INFO }),
          record(2, { body: 'error line', severityNumber: SEVERITY_NUMBER.ERROR }),
        ],
        cursor: 2,
        dropped: 0,
      }),
    );
    expect(screen.getByText('info line')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Minimum severity'), {
      target: { value: String(SEVERITY_NUMBER.ERROR) },
    });
    expect(screen.queryByText('info line')).not.toBeInTheDocument();
    expect(screen.getByText('error line')).toBeInTheDocument();
  });

  it('filters by free-text search', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1, { body: 'db timeout' }), record(2, { body: 'user login' })],
        cursor: 2,
        dropped: 0,
      }),
    );
    fireEvent.change(screen.getByLabelText('Search log text'), { target: { value: 'timeout' } });
    expect(screen.getByText('db timeout')).toBeInTheDocument();
    expect(screen.queryByText('user login')).not.toBeInTheDocument();
  });

  it('surfaces a dropped-count warning', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1)],
        cursor: 1,
        dropped: 5,
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/5 records were dropped/i);
  });

  it('renders untrusted log text as text, never as HTML', () => {
    const { sock } = renderLive();
    const payload = '<img src=x onerror="window.__pwned=1"> <b>bold</b>';
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1, { body: payload })],
        cursor: 1,
        dropped: 0,
      }),
    );
    // The literal markup is present as text…
    expect(screen.getByText(/onerror=/)).toBeInTheDocument();
    // …and no real elements were injected from the log body.
    const stream = screen.getByText(/onerror=/);
    expect(within(stream).queryByRole('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it('handles a high-volume burst without crashing and keeps newest visible', () => {
    const { sock } = renderLive();
    const big = Array.from({ length: 1500 }, (_, i) => record(i + 1, { body: `evt ${i + 1}` }));
    act(() =>
      sock.emit({ type: 'logs_tail', projectId: 'p1', records: big, cursor: 1500, dropped: 0 }),
    );
    // Bounded tail keeps the newest record and evicts the oldest.
    expect(screen.getByText('evt 1500')).toBeInTheDocument();
    expect(screen.queryByText('evt 1')).not.toBeInTheDocument();
  });

  it('resets older-history paging when a filter changes', async () => {
    (api.queryLogs as any).mockResolvedValue({ records: [], nextCursor: null });
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(10, { body: 'newest' })],
        cursor: 10,
        dropped: 0,
      }),
    );
    // Exhaust older history for the current (empty) filter.
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() =>
      expect(screen.getByText(/Beginning of retained history/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();

    // Changing a filter must clear the exhausted flag so history can be
    // re-paged for the new filter.
    fireEvent.change(screen.getByLabelText('Search log text'), { target: { value: 'newest' } });
    expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();
    expect(screen.queryByText(/Beginning of retained history/i)).not.toBeInTheDocument();
  });

  it('drops an in-flight older-history response when the filter changes', async () => {
    let resolveOlder: () => void = () => {};
    (api.queryLogs as any).mockImplementation(
      () =>
        new Promise((r) => {
          resolveOlder = () => r({ records: [record(1, { body: 'F1-old' })], nextCursor: null });
        }),
    );
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(10, { body: 'live' })],
        cursor: 10,
        dropped: 0,
      }),
    );
    // Start an older-history request for the current filter, then change a facet.
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    fireEvent.change(screen.getByLabelText('Minimum severity'), {
      target: { value: String(SEVERITY_NUMBER.ERROR) },
    });

    // The stale response (nextCursor null) must NOT mark the new filter exhausted.
    await act(async () => {
      resolveOlder();
    });
    expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();
    expect(screen.queryByText(/Beginning of retained history/i)).not.toBeInTheDocument();
  });

  it('lets the user dismiss the dropped-records notice', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1)],
        cursor: 1,
        dropped: 3,
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/3 records were dropped/i);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss dropped-records notice/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pauses and resumes the live stream', () => {
    const { sock } = renderLive();
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1)],
        cursor: 1,
        dropped: 0,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Pause/i }));
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(2, { body: 'while-paused' })],
        cursor: 2,
        dropped: 0,
      }),
    );
    expect(screen.queryByText('while-paused')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /new log/i }));
    expect(screen.getByText('while-paused')).toBeInTheDocument();
  });
});
