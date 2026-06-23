import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import {
  X,
  RefreshCw,
  GripVertical,
  Loader2,
  AlertCircle,
  FilePlus2,
  FileMinus2,
  FilePen,
  FileSymlink,
  Columns2,
  Rows3,
  GitBranch,
} from 'lucide-react';
import { getApiBase, getAuthHeaders } from '../utils/connection';

const MIN_WIDTH = 360;
const MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 720;

function widthKeyFor(sessionId: any) {
  return sessionId ? `changesPaneWidth:${sessionId}` : null;
}
function clampWidth(raw: any) {
  const n = typeof raw === 'number' ? raw : parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

const STATUS_META = {
  added: { Icon: FilePlus2, cls: 'text-emerald-400', label: 'Added' },
  deleted: { Icon: FileMinus2, cls: 'text-red-400', label: 'Deleted' },
  renamed: { Icon: FileSymlink, cls: 'text-sky-400', label: 'Renamed' },
  copied: { Icon: FileSymlink, cls: 'text-sky-400', label: 'Copied' },
  'type-changed': { Icon: FilePen, cls: 'text-amber-400', label: 'Type changed' },
  modified: { Icon: FilePen, cls: 'text-amber-300', label: 'Modified' },
} as Record<string, any>;

function basename(p: any) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: any) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/**
 * SessionChangesPane
 *
 * GitHub/Cursor-style view of every file an agent touched in a session
 * worktree. Reuses the resizable right-pane chrome of SessionPreviewPane;
 * the parent renders this *instead of* the preview pane (the two are
 * mutually exclusive — opening Changes replaces an open preview).
 *
 * Data flow:
 *   GET /api/sessions/:id/changes            → file list + counts
 *   GET /api/sessions/:id/changes/diff?file= → unified diff per file
 *
 * `reloadToken` is bumped by the parent on every `code_changed` WS event
 * for this session so the file list stays live while the agent works.
 */
export default function SessionChangesPane({
  sessionId,
  reloadToken = 0,
  onClose,
  onSummary,
}: any) {
  // Hold the latest onSummary in a ref so loadSummary (and thus the fetch
  // effect) does NOT depend on the parent's callback identity. The parent
  // passes an inline arrow that's a new function every render; without this
  // indirection each successful summary would re-create loadSummary, refire
  // the effect, and refetch /changes in an endless loop while the pane is open.
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;

  // Latest session / refresh generation, mirrored into refs so async
  // diff-fetch callbacks can compare the values captured at request start
  // against the current ones and discard stale results (the pane is not
  // keyed by session in App.jsx, so a late response for the previous
  // session/file must never write into the shared diff cache).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const reloadTokenRef = useRef(reloadToken);
  reloadTokenRef.current = reloadToken;

  // Monotonic load token. Each summary fetch captures the token at start;
  // any in-flight request whose token is no longer current (the session or
  // reloadToken changed, or the user hit refresh) must NOT apply its result.
  // The pane is not keyed by session in App.jsx, so without this an older
  // session's response could overwrite the new session's list and badge.
  const loadSeqRef = useRef(0);

  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [diffCache, setDiffCache] = useState<Record<string, any>>({});
  const [diffLoading, setDiffLoading] = useState(false);
  const [mode, setMode] = useState<any>(() => {
    try {
      return window.localStorage.getItem('changesPaneMode') === 'unified'
        ? DiffModeEnum.Unified
        : DiffModeEnum.Split;
    } catch {
      return DiffModeEnum.Split;
    }
  });

  const apiBase = getApiBase();

  // ── Resizable width (persisted per session) ──────────────────────
  const wKey = widthKeyFor(sessionId);
  const [width, setWidth] = useState<any>(() => {
    if (!wKey) return DEFAULT_WIDTH;
    try {
      return clampWidth(window.localStorage.getItem(wKey));
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<any>(null);
  useEffect(() => {
    if (!wKey) return;
    try {
      window.localStorage.setItem(wKey, String(width));
    } catch {
      /* storage unavailable */
    }
  }, [wKey, width]);
  const endResize = useCallback(() => {
    dragRef.current = null;
    setIsResizing(false);
  }, []);
  const onResizeDown = useCallback(
    (e: any) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      setIsResizing(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported in jsdom */
      }
    },
    [width],
  );
  const onResizeMove = useCallback((e: any) => {
    if (!dragRef.current) return;
    const { startX, startWidth } = dragRef.current;
    setWidth(clampWidth(startWidth + (startX - e.clientX)));
  }, []);
  useEffect(() => {
    if (!isResizing) return undefined;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [isResizing]);

  // ── Fetch the change summary ─────────────────────────────────────
  const loadSummary = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++loadSeqRef.current;
    // Capture the session + refresh generation at request start and compare
    // against the live refs (updated during render). `loadSeqRef` alone is
    // insufficient: it only advances when the *next* load effect runs, so a
    // slow previous-session response could resolve in the render→effect gap —
    // after sessionIdRef already points at the new session but before the new
    // load bumps the seq — and clobber the new session's summary/badge.
    const startSession = sessionId;
    const startReload = reloadToken;
    const isStale = () =>
      seq !== loadSeqRef.current ||
      sessionIdRef.current !== startSession ||
      reloadTokenRef.current !== startReload;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/sessions/${sessionId}/changes`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      // Drop a response that a newer load (session/reloadToken change, or a
      // manual refresh) has superseded — otherwise it would clobber the
      // current session's state and badge the wrong session.
      if (isStale()) return;
      setSummary(body);
      if (typeof onSummaryRef.current === 'function') onSummaryRef.current(body);
      // Reset the per-file cache on refresh — the diffs may have moved.
      setDiffCache({});
      setSelected((prev: any) => {
        const files = Array.isArray(body.files) ? body.files : [];
        if (prev && files.some((f: any) => f.path === prev)) return prev;
        return files.length > 0 ? files[0].path : null;
      });
    } catch (err: any) {
      if (isStale()) return;
      setError(err instanceof Error ? err.message : String(err));
      setSummary(null);
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [apiBase, sessionId, reloadToken]);

  useEffect(() => {
    // loadSummary's identity already changes with sessionId/reloadToken, so
    // depending on it alone covers a `code_changed` WS refresh too.
    loadSummary();
  }, [loadSummary]);

  const selectedFile = useMemo(
    () => summary?.files?.find((f: any) => f.path === selected) ?? null,
    [summary, selected],
  );

  // ── Fetch the selected file's diff (cached) ──────────────────────
  useEffect(() => {
    if (!sessionId || !selectedFile) return;
    const path = selectedFile.path;
    if (diffCache[path]) return;
    let cancelled = false;
    const controller = new AbortController();
    // Capture the generation this request belongs to. A response is stale —
    // and must NOT be written to the shared cache or stop the spinner — if
    // the session or refresh token has advanced by the time it resolves.
    const startSession = sessionId;
    const startReload = reloadToken;
    const isStale = () =>
      cancelled || sessionIdRef.current !== startSession || reloadTokenRef.current !== startReload;
    setDiffLoading(true);
    // The server derives tracked-vs-untracked itself and rejects any path not
    // in the session's change set, so we only send the file path.
    const qs = new URLSearchParams({ file: path });
    fetch(`${apiBase}/sessions/${sessionId}/changes/diff?${qs.toString()}`, {
      headers: getAuthHeaders(),
      signal: controller.signal,
    })
      .then((r: any) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body: any) => {
        if (isStale()) return;
        setDiffCache((prev: any) => ({ ...prev, [path]: body }));
      })
      .catch((err: any) => {
        if (isStale() || err?.name === 'AbortError') return;
        setDiffCache((prev: any) => ({
          ...prev,
          [path]: { error: err instanceof Error ? err.message : String(err) },
        }));
      })
      .finally(() => {
        if (!isStale()) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase, sessionId, reloadToken, selectedFile, diffCache]);

  const toggleMode = useCallback(() => {
    setMode((m: any) => {
      const next = m === DiffModeEnum.Split ? DiffModeEnum.Unified : DiffModeEnum.Split;
      try {
        window.localStorage.setItem(
          'changesPaneMode',
          next === DiffModeEnum.Unified ? 'unified' : 'split',
        );
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  const files = useMemo(() => summary?.files ?? [], [summary]);
  const totals = useMemo(
    () =>
      files.reduce(
        (acc: any, f: any) => {
          acc.additions += f.additions || 0;
          acc.deletions += f.deletions || 0;
          return acc;
        },
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  const currentDiff = selectedFile ? diffCache[selectedFile.path] : null;

  const diffData = useMemo(() => {
    if (!selectedFile || !currentDiff || currentDiff.error) return null;
    if (currentDiff.binary || currentDiff.tooLarge || !currentDiff.unifiedDiff) return null;
    const newName = selectedFile.path;
    const oldName = selectedFile.oldPath || selectedFile.path;
    return {
      oldFile: { fileName: oldName },
      newFile: { fileName: newName },
      hunks: [currentDiff.unifiedDiff],
    };
  }, [selectedFile, currentDiff]);

  return (
    <aside
      data-testid="session-changes-pane"
      className={`hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative ${
        isResizing ? 'select-none' : ''
      }`}
      style={{ width: `${width}px` }}
      aria-label="Session changes"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes pane"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        title="Drag to resize changes"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className={`absolute top-0 left-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors ${
          isResizing ? 'bg-sky-500/50' : 'bg-gray-800/80 hover:bg-sky-500/35'
        }`}
        data-testid="session-changes-pane-resize-handle"
      >
        <GripVertical size={14} className="text-gray-500" aria-hidden />
      </div>

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/60">
        <GitBranch size={14} className="text-sky-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-gray-100 truncate">
            Changes
            {files.length > 0 && (
              <span className="ml-1 text-gray-400 font-normal">
                · {files.length} file{files.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {summary?.branch && (
            <div className="text-[10px] font-mono text-gray-500 truncate" title={summary.branch}>
              {summary.branch}
              {summary.baseBranch ? ` ← ${summary.baseBranch}` : ''}
            </div>
          )}
        </div>
        {files.length > 0 && (
          <span className="text-[10px] font-mono shrink-0">
            <span className="text-emerald-400">+{totals.additions}</span>{' '}
            <span className="text-red-400">−{totals.deletions}</span>
          </span>
        )}
        <button
          type="button"
          onClick={toggleMode}
          title={mode === DiffModeEnum.Split ? 'Unified view' : 'Split view'}
          aria-label="Toggle split/unified view"
          data-testid="session-changes-pane-mode"
          className="text-gray-400 hover:text-gray-100"
        >
          {mode === DiffModeEnum.Split ? <Rows3 size={14} /> : <Columns2 size={14} />}
        </button>
        <button
          type="button"
          onClick={loadSummary}
          title="Refresh changes"
          aria-label="Refresh changes"
          data-testid="session-changes-pane-refresh"
          className="text-gray-400 hover:text-gray-100"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close pane"
          aria-label="Close changes pane"
          data-testid="session-changes-pane-close"
          className="text-gray-400 hover:text-gray-100 ml-0.5"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body: file list + diff */}
      <div className="flex-1 min-h-0 flex flex-col">
        {error && (
          <div
            className="flex items-center gap-2 px-3 py-2 text-xs text-red-200 bg-red-950/40 border-b border-red-900/50"
            data-testid="session-changes-pane-error"
          >
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            Failed to load changes: {error}
          </div>
        )}

        {!error && !loading && files.length === 0 && (
          <div
            className="flex flex-col items-center justify-center flex-1 p-6 text-center text-gray-400"
            data-testid="session-changes-pane-empty"
          >
            <GitBranch size={26} className="text-gray-600 mb-2" />
            <p className="text-sm font-medium text-gray-200 mb-1">No changes yet</p>
            <p className="text-xs text-gray-500 max-w-xs">
              Files the agent creates or edits in this session&rsquo;s worktree will show up here as
              a diff against the base branch.
            </p>
          </div>
        )}

        {files.length > 0 && (
          <>
            {/* File list */}
            <div
              className="shrink-0 max-h-[34%] overflow-y-auto border-b border-gray-800 bg-gray-900/30"
              data-testid="session-changes-pane-filelist"
            >
              {summary.truncated && (
                <div className="px-3 py-1.5 text-[10px] text-amber-300/80 bg-amber-950/30">
                  Showing the first {files.length} files (list truncated).
                </div>
              )}
              {files.map((f: any) => {
                const meta = STATUS_META[f.status] || STATUS_META.modified;
                const { Icon } = meta;
                const active = f.path === selected;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelected(f.path)}
                    title={f.path}
                    data-testid="session-changes-pane-file"
                    data-active={active ? 'true' : 'false'}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs border-l-2 ${
                      active
                        ? 'bg-gray-800/70 border-sky-500'
                        : 'border-transparent hover:bg-gray-800/40'
                    }`}
                  >
                    <Icon size={13} className={`${meta.cls} shrink-0`} aria-label={meta.label} />
                    <span className="flex-1 min-w-0 truncate">
                      <span className="text-gray-200">{basename(f.path)}</span>
                      {dirname(f.path) && <span className="text-gray-500"> {dirname(f.path)}</span>}
                    </span>
                    {f.binary ? (
                      <span className="text-[10px] text-gray-500 font-mono shrink-0">bin</span>
                    ) : (
                      <span className="text-[10px] font-mono shrink-0 whitespace-nowrap">
                        <span className="text-emerald-400">+{f.additions}</span>{' '}
                        <span className="text-red-400">−{f.deletions}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Diff body */}
            <div
              className="flex-1 min-h-0 overflow-auto bg-gray-950"
              data-testid="session-changes-pane-diff"
            >
              {diffLoading && !currentDiff && (
                <div className="flex items-center justify-center h-full text-sky-200">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              )}
              {currentDiff?.error && (
                <div className="p-4 text-xs text-red-200">
                  Failed to load diff: {currentDiff.error}
                </div>
              )}
              {currentDiff?.binary && (
                <div className="p-6 text-center text-xs text-gray-400">
                  Binary file — no text diff to display.
                </div>
              )}
              {currentDiff?.tooLarge && (
                <div className="p-6 text-center text-xs text-amber-300/80">
                  Diff is too large to render inline.
                </div>
              )}
              {diffData && (
                <DiffView
                  data={diffData}
                  diffViewMode={mode}
                  diffViewTheme="dark"
                  diffViewHighlight
                  diffViewWrap={false}
                  diffViewFontSize={12}
                />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
