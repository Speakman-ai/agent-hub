import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2, Check, Lock, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { isSessionWorktreeEnabled } from '../utils/sessionDerivedState';

/**
 * Toolbar control to position a session worktree on an EXISTING remote branch
 * (the general form of the resolve-PR head-branch mechanism).
 *
 * The choice is only settable BEFORE the worktree is provisioned — once
 * `worktree_path` is set the branch is locked (One-Session-One-Branch: Finalize
 * keys off the recorded branch). After provisioning this renders a locked chip
 * showing the branch the session is actually on.
 *
 * Selecting a branch calls `PUT /api/sessions/:id/worktree-branch`; the server
 * broadcasts `session-updated`, so the `session` prop refreshes over WebSocket
 * and the label reflects the new choice without a manual refetch.
 */
export default function SessionBranchPicker({
  sessionId,
  session,
  projectId,
  disabled,
  onError,
}: any) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const worktreeEnabled = isSessionWorktreeEnabled(session);
  const provisioned = !!session?.worktree_path;
  const chosen = session?.worktree_checkout_branch || null;
  const lockedBranch = session?.worktree_branch || null;

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!worktreeEnabled) return null;

  async function loadBranches(force = false) {
    setLoading(true);
    setLoadError(null);
    try {
      const res: any = await api.getProjectBranches(projectId, force);
      setBranches(Array.isArray(res?.branches) ? res.branches : []);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load branches');
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }

  function toggleOpen() {
    if (provisioned) return; // locked — nothing to choose
    const next = !open;
    setOpen(next);
    if (next) void loadBranches(false);
  }

  async function choose(branch: string | null) {
    setSaving(true);
    try {
      await api.setSessionWorktreeBranch(sessionId, branch);
      setOpen(false);
    } catch (err: any) {
      onError?.(err?.message || 'Failed to set branch');
    } finally {
      setSaving(false);
    }
  }

  // Label: locked branch after provisioning, else the chosen branch, else a prompt.
  const label = provisioned ? lockedBranch || 'Branch' : chosen || 'Branch';
  const title = provisioned
    ? `Worktree is on ${lockedBranch || 'its branch'} — locked once created`
    : chosen
      ? `Session will start on existing branch ${chosen}`
      : 'Start this session on an existing branch';

  // Branches that can be checked out onto (exclude the default — Finalize can't
  // push to it — and the session's own default branch pattern is never listed).
  const selectable = branches.filter((b: any) => !b.isDefault);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        data-testid="session-branch-picker"
        aria-haspopup={!provisioned}
        aria-expanded={open}
        disabled={disabled}
        onClick={toggleOpen}
        title={title}
        className={`flex w-[150px] min-w-[150px] shrink-0 justify-center items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border sm:w-auto sm:min-w-0 ${
          provisioned
            ? 'bg-gray-900/60 text-gray-400 border-gray-800 cursor-default'
            : chosen
              ? 'bg-emerald-800/60 text-emerald-50 border-emerald-600 hover:bg-emerald-700/60'
              : 'bg-gray-800/70 hover:bg-gray-700/70 text-gray-200 border-gray-700'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {provisioned ? <Lock size={12} /> : <GitBranch size={13} />}
        <span className="truncate max-w-[120px]">{label}</span>
      </button>

      {open && !provisioned && (
        <div className="absolute z-30 bottom-full mb-1 left-0 w-72 max-h-80 overflow-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-1 text-xs">
          <div className="flex items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
            <span>Start session on…</span>
            <button
              type="button"
              onClick={() => void loadBranches(true)}
              title="Refresh branch list"
              className="text-gray-400 hover:text-gray-200"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void choose(null)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800 text-left text-gray-200"
          >
            <span className="w-3">
              {!chosen && <Check size={12} className="text-emerald-400" />}
            </span>
            <span>
              Default <span className="text-gray-500">(new branch off the base)</span>
            </span>
          </button>

          <div className="my-1 border-t border-gray-800" />

          {loading && (
            <div className="flex items-center gap-2 px-2 py-2 text-gray-400">
              <Loader2 size={13} className="animate-spin" /> Loading branches…
            </div>
          )}
          {loadError && !loading && <div className="px-2 py-2 text-rose-300">{loadError}</div>}
          {!loading && !loadError && selectable.length === 0 && (
            <div className="px-2 py-2 text-gray-500">No other branches on origin.</div>
          )}
          {!loading &&
            !loadError &&
            selectable.map((b: any) => (
              <button
                key={b.name}
                type="button"
                disabled={saving}
                onClick={() => void choose(b.name)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800 text-left text-gray-200"
              >
                <span className="w-3">
                  {chosen === b.name && <Check size={12} className="text-emerald-400" />}
                </span>
                <GitBranch size={12} className="text-gray-500 shrink-0" />
                <span className="truncate">{b.name}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
