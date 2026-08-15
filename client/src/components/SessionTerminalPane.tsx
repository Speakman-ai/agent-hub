import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, RotateCw, Square, SquareTerminal, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { getTerminalWsUrl } from '../utils/connection';
import { subscribeToTerminalCommands } from '../utils/terminalCommandBus';
import { api } from '../utils/api';
import {
  PTY_TAB_ID,
  terminalJobLabel,
  terminalTabsFromJobs,
  type BackgroundShellView,
} from '../utils/backgroundShells';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const defaultWebSocketFactory = (url: string) => new WebSocket(url);

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'exited' | 'error';

function encodeTerminalData(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeTerminalData(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function dimensions(terminal: Terminal) {
  return {
    cols: Math.max(1, terminal.cols || 80),
    rows: Math.max(1, terminal.rows || 24),
  };
}

const JOB_XTERM_THEME = {
  background: '#030712',
  foreground: '#e5e7eb',
  cursor: '#67e8f9',
  selectionBackground: '#164e63',
};

function jobStatusLabel(status: BackgroundShellView['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'exited':
      return 'Exited';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Read-only xterm for one Hub-owned background shell. Snapshot via REST, then
 * live chunks from the parent (WS `background_shell_log`). Never injects into
 * the shared interactive PTY.
 */
function BackgroundShellJobTerminal({
  sessionId,
  shellId,
  logText,
  onSnapshot,
}: {
  sessionId: string;
  shellId: string;
  logText: string;
  onSnapshot: (snapshot: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);
  const snapshotRequestedRef = useRef(false);
  const logTextRef = useRef(logText);
  logTextRef.current = logText;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: JOB_XTERM_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    writtenRef.current = 0;
    const initial = logTextRef.current;
    if (initial) {
      terminal.write(initial);
      writtenRef.current = initial.length;
    }

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        /* pane can be hidden during a layout transition */
      }
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    fit();

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, shellId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (logText.length < writtenRef.current) {
      terminal.reset();
      writtenRef.current = 0;
    }
    const next = logText.slice(writtenRef.current);
    if (next) terminal.write(next);
    writtenRef.current = logText.length;
  }, [logText]);

  useEffect(() => {
    if (logText.length > 0 || snapshotRequestedRef.current) return undefined;
    snapshotRequestedRef.current = true;
    let cancelled = false;
    void api
      .getBackgroundShellLogs(sessionId, shellId, 500)
      .then((body) => {
        if (cancelled) return;
        const lines = body.logs ?? [];
        if (lines.length === 0) return;
        onSnapshot(`${lines.join('\n')}\n`);
      })
      .catch(() => {
        /* live chunks still apply if the snapshot fetch fails */
      });
    return () => {
      cancelled = true;
    };
  }, [logText, onSnapshot, sessionId, shellId]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 p-2"
      data-testid={`background-shell-job-xterm-${shellId}`}
    />
  );
}

/**
 * Shared shell for one Agent Hub session.
 *
 * The server owns echo and the durable terminal buffer. User input is sent to
 * the PTY without writing it locally, so every viewer observes exactly the
 * same echo/order. On every (re)connect, the `attached` frame replaces the
 * local xterm buffer with the server's serialized snapshot before live output
 * resumes.
 *
 * Long-running Hub background shells (`bg.sh`) get extra read-only job tabs
 * beside this PTY — they are a different process, not inject into this shell.
 */
export default function SessionTerminalPane({
  sessionId,
  onClose,
  webSocketFactory = defaultWebSocketFactory,
  jobs = [],
  logsById = {},
  activeTabId = PTY_TAB_ID,
  onActiveTabChange,
  onStopJob,
  onDismissJob,
  onLogSnapshot,
}: {
  sessionId: string;
  onClose?: () => void;
  webSocketFactory?: (url: string) => WebSocket;
  jobs?: BackgroundShellView[];
  logsById?: Record<string, string>;
  activeTabId?: string;
  onActiveTabChange?: (tabId: string) => void;
  onStopJob?: (shellId: string) => void | Promise<void>;
  onDismissJob?: (shellId: string) => void;
  onLogSnapshot?: (shellId: string, snapshot: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const attachedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyShellId, setBusyShellId] = useState<string | null>(null);

  const tabs = terminalTabsFromJobs(jobs);
  const resolvedTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : PTY_TAB_ID;
  const activeJob = jobs.find((job) => job.id === resolvedTabId) ?? null;
  const ptyActive = resolvedTabId === PTY_TAB_ID;

  const sendFrame = useCallback((frame: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  const reportSize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    if (attachedRef.current) sendFrame({ type: 'resize', ...dimensions(terminal) });
  }, [sendFrame]);

  const copyBuffer = useCallback(async () => {
    const serialized = activeJob
      ? (logsById[activeJob.id] ?? '')
      : (serializeAddonRef.current?.serialize() ?? '');
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError('Could not copy the terminal buffer');
    }
  }, [activeJob, logsById]);

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    const socket = socketRef.current;
    socketRef.current = null;
    intentionalCloseRef.current = false;
    socket?.close();
    connectRef.current();
  }, []);

  const selectTab = useCallback(
    (tabId: string) => {
      onActiveTabChange?.(tabId);
    },
    [onActiveTabChange],
  );

  const stopJob = useCallback(
    async (shellId: string) => {
      setBusyShellId(shellId);
      setError('');
      try {
        if (onStopJob) await onStopJob(shellId);
        else await api.stopBackgroundShell(sessionId, shellId);
      } catch {
        setError('Failed to stop the background command');
      } finally {
        setBusyShellId(null);
      }
    },
    [onStopJob, sessionId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    intentionalCloseRef.current = false;
    attachedRef.current = false;
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
    setError('');

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: JOB_XTERM_THEME,
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    const inputDisposable = terminal.onData((data) => {
      // Deliberately no terminal.write(data): PTY echo is the only local echo.
      if (!attachedRef.current) return;
      sendFrame({ type: 'input', encoding: 'base64', data: encodeTerminalData(data) });
    });

    const connect = () => {
      if (intentionalCloseRef.current) return;
      const socket = webSocketFactory(getTerminalWsUrl(sessionId));
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        setStatus(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
        setError('');
        try {
          fitAddon.fit();
        } catch {
          // The pane can be hidden during a responsive-layout transition. The
          // ResizeObserver will fit it once dimensions are available.
        }
        socket.send(JSON.stringify({ type: 'attach', ...dimensions(terminal) }));
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let frame: any;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          setStatus('error');
          setError('The terminal server sent an invalid frame');
          return;
        }

        try {
          if (frame.type === 'attached' && frame.encoding === 'base64') {
            terminal.reset();
            terminal.write(decodeTerminalData(frame.data));
            attachedRef.current = true;
            reconnectAttemptRef.current = 0;
            setStatus('connected');
            setError('');
            return;
          }
          if (frame.type === 'output' && frame.encoding === 'base64') {
            terminal.write(decodeTerminalData(frame.data));
            return;
          }
          if (frame.type === 'detached') {
            attachedRef.current = false;
            return;
          }
          if (frame.type === 'exit') {
            attachedRef.current = false;
            intentionalCloseRef.current = true;
            setStatus('exited');
            terminal.writeln(`\r\n[terminal exited with code ${frame.exitCode}]`);
            return;
          }
          if (frame.type === 'error') {
            setStatus('error');
            setError(frame.message || 'Terminal connection failed');
          }
        } catch {
          setStatus('error');
          setError('The terminal server sent invalid terminal data');
        }
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        attachedRef.current = false;
        if (intentionalCloseRef.current) return;
        setStatus('reconnecting');
        const attempt = reconnectAttemptRef.current;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttemptRef.current = attempt + 1;
        reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
      };

      socket.onerror = () => {
        if (socketRef.current !== socket || intentionalCloseRef.current) return;
        setError('Terminal connection interrupted');
      };
    };
    connectRef.current = connect;

    const resizeObserver = new ResizeObserver(reportSize);
    resizeObserver.observe(container);
    reportSize();
    connect();

    return () => {
      intentionalCloseRef.current = true;
      attachedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'detach' }));
      }
      socket?.close(1000, 'Terminal pane closed');
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
    };
  }, [reportSize, sendFrame, sessionId, webSocketFactory]);

  useEffect(() => {
    if (!ptyActive) return;
    reportSize();
  }, [ptyActive, reportSize]);

  // "Run in terminal" hand-offs from the chat transcript. Subscribing only
  // once attached is what makes the bus's hold-and-replay do its job: input
  // sent before the socket attaches is dropped by the `onData` guard above.
  // `terminal.paste` (rather than a hand-rolled input frame) is deliberate —
  // it applies the same bracketed-paste wrapping and newline transformation a
  // real paste gets, so a multi-line command lands as one editable buffer that
  // the shell does not run until the user presses Enter.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    return subscribeToTerminalCommands(sessionId, (command) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      onActiveTabChange?.(PTY_TAB_ID);
      terminal.focus();
      terminal.paste(command);
    });
  }, [onActiveTabChange, sessionId, status]);

  const statusLabel =
    status === 'connected'
      ? 'Connected'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'exited'
          ? 'Exited'
          : status === 'error'
            ? 'Connection error'
            : 'Connecting…';

  return (
    <aside
      data-testid="session-terminal-pane"
      className="hidden lg:flex w-[600px] shrink-0 flex-col border-l border-gray-800 bg-gray-950"
      aria-label="Session terminal"
    >
      <div className="flex items-center gap-2 border-b border-gray-800 bg-gray-900/70 px-3 py-2">
        <SquareTerminal size={15} className="shrink-0 text-cyan-300" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-gray-100">
            Terminal
            {ptyActive ? (
              <span
                data-testid="session-terminal-status"
                className={`inline-flex items-center gap-1 text-[10px] font-normal ${
                  status === 'connected' ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                {(status === 'connecting' || status === 'reconnecting') && (
                  <Loader2 size={10} className="animate-spin" />
                )}
                {statusLabel}
              </span>
            ) : (
              <span
                data-testid="session-terminal-job-status"
                className={`text-[10px] font-normal ${
                  activeJob?.status === 'running' ? 'text-emerald-300' : 'text-gray-400'
                }`}
              >
                {activeJob ? jobStatusLabel(activeJob.status) : ''}
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-amber-300/90">
            {activeJob
              ? activeJob.command
              : 'Shared — agent may type. Input is echoed by the shared shell.'}
          </div>
        </div>
        {activeJob?.status === 'running' && (
          <button
            type="button"
            onClick={() => void stopJob(activeJob.id)}
            disabled={busyShellId === activeJob.id}
            className="flex items-center gap-1 text-gray-400 hover:text-red-200 disabled:opacity-50"
            title="Stop this command"
            aria-label="Stop background command"
            data-testid={`session-terminal-stop-${activeJob.id}`}
          >
            {busyShellId === activeJob.id ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Square size={14} />
            )}
          </button>
        )}
        {ptyActive && (status === 'error' || status === 'exited') && (
          <button
            type="button"
            onClick={reconnectNow}
            className="text-gray-400 hover:text-cyan-200"
            title="Reconnect terminal"
            aria-label="Reconnect terminal"
          >
            <RotateCw size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={copyBuffer}
          className="text-gray-400 hover:text-cyan-200"
          title="Copy terminal buffer"
          aria-label="Copy terminal buffer"
        >
          <Copy size={14} />
          <span className="sr-only">{copied ? 'Copied' : 'Copy terminal buffer'}</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-100"
          title="Close terminal pane"
          aria-label="Close terminal pane"
          data-testid="session-terminal-pane-close"
        >
          <X size={14} />
        </button>
      </div>
      {jobs.length > 0 && (
        <div
          className="flex items-center gap-1 overflow-x-auto border-b border-gray-800 bg-gray-950 px-2 py-1"
          data-testid="session-terminal-tabs"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab) => {
            const selected = tab.id === resolvedTabId;
            const job = tab.kind === 'job' ? jobs.find((row) => row.id === tab.id) : null;
            return (
              <div
                key={tab.id}
                className={`flex shrink-0 items-center rounded-md ${
                  selected ? 'bg-cyan-950/70 text-cyan-100' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid={`session-terminal-tab-${tab.id}`}
                  onClick={() => selectTab(tab.id)}
                  className="max-w-[9.5rem] truncate px-2 py-1 text-[11px]"
                  title={job?.command ?? tab.label}
                >
                  {tab.label}
                </button>
                {job?.status === 'running' && (
                  <button
                    type="button"
                    onClick={() => void stopJob(job.id)}
                    disabled={busyShellId === job.id}
                    className="pr-1.5 text-gray-500 hover:text-red-200 disabled:opacity-50"
                    title="Stop this command"
                    aria-label={`Stop ${tab.label}`}
                    data-testid={`session-terminal-tab-stop-${job.id}`}
                  >
                    <Square size={10} />
                  </button>
                )}
                {job && job.status !== 'running' && (
                  <button
                    type="button"
                    onClick={() => onDismissJob?.(job.id)}
                    className="pr-1.5 text-gray-500 hover:text-gray-200"
                    title="Dismiss this tab"
                    aria-label={`Dismiss ${tab.label}`}
                    data-testid={`session-terminal-tab-dismiss-${job.id}`}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div
          data-testid="session-terminal-error"
          className="border-b border-red-900/50 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-200"
        >
          {error}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={`absolute inset-0 p-2 ${ptyActive ? '' : 'invisible pointer-events-none'}`}
          data-testid="xterm-container"
        />
        {activeJob && (
          <BackgroundShellJobTerminal
            key={activeJob.id}
            sessionId={sessionId}
            shellId={activeJob.id}
            logText={logsById[activeJob.id] ?? ''}
            onSnapshot={(snapshot) => onLogSnapshot?.(activeJob.id, snapshot)}
          />
        )}
      </div>
    </aside>
  );
}

export const terminalWireEncoding = { encode: encodeTerminalData, decode: decodeTerminalData };
