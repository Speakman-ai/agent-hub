import { useEffect, useRef, useState } from 'react';
import { GitBranch, GitMerge, Loader2, Check, Lock, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { isSessionWorktreeEnabled } from '../utils/sessionDerivedState';
import {
  sessionActionControlClass,
  sessionActionSubmenuClass,
  type SessionActionControlVariant,
} from '../utils/sessionActionMenu';

/**
 * Toolbar control for the two branches a session cares about:
 *
 * - **Target branch** (`PUT /api/sessions/:id/target-branch`): the branch
 *   Finalize rebases onto and opens the PR against. Changeable until the
 *   session pushes; on a provisioned worktree the server rebases the session
 *   commits onto the new target, or hands the agent the conflicts.
 * - **Working branch** (`PUT /api/sessions/:id/worktree-branch`): position the
 *   worktree on an EXISTING remote branch. Before provisioning it picks the
 *   initial clone; after, only while the session is clean and has no code
 *   changes. Once work begins that section is hidden and the chip shows a lock.
 *
 * The server broadcasts `session-updated`, so the `session` prop refreshes
 * over WebSocket and the label follows without a manual refetch.
 */
export default function SessionBranchPicker({
  sessionId,
  session,
  projectId,
  disabled,
  onError,
  onNotice,
  variant = 'toolbar',
}: {
  variant?: SessionActionControlVariant;
  [key: string]: any;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const worktreeEnabled = isSessionWorktreeEnabled(session);
  const provisioned = !!session?.worktree_path;
  const canSwitchProvisioned = provisioned && !session?.code_changed_at;
  const chosen = session?.worktree_checkout_branch || null;
  const lockedBranch = session?.worktree_branch || null;
  const target = session?.pr_base_branch || null;
  const headLocked = provisioned && !canSwitchProvisioned;

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

  async function chooseTarget(branch: string | null) {
    setSaving(true);
    try {
      const res: any = await api.setSessionTargetBranch(sessionId, branch);
      setOpen(false);
      const notice = retargetNotice(res?.retarget);
      if (notice) onNotice?.(notice.message, notice.level);
    } catch (err: any) {
      onError?.(err?.message || 'Failed to set target branch');
    } finally {
      setSaving(false);
    }
  }

  // Label: locked branch after provisioning, else the chosen branch, else a prompt.
  const label = provisioned ? lockedBranch || 'Branch' : chosen || 'Branch';
  const headTitle =
    provisioned && canSwitchProvisioned
      ? 'Switch this clean session to an existing branch'
      : provisioned
        ? `Worktree is on ${lockedBranch || 'its branch'} - locked after code changes`
        : chosen
          ? `Session will start on existing branch ${chosen}`
          : 'Start this session on an existing branch';
  const title = `${headTitle}. Target: ${target || 'default'}`;

  // Branches that can be checked out onto (exclude the default — Finalize can't
  // push to it — and the session's own default branch pattern is never listed).
  const selectable = branches.filter((b: any) => !b.isDefault);

  const isMenu = variant === 'menu';

  return (
    <div className={isMenu ? 'relative w-full' : 'relative shrink-0'} ref={rootRef}>
      <button
        type="button"
        data-testid="session-branch-picker"
        aria-haspopup
        aria-expanded={open}
        disabled={disabled}
        onClick={toggleOpen}
        title={title}
        className={sessionActionControlClass(
          variant,
          `${
            headLocked
              ? isMenu
                ? 'text-gray-400 cursor-default'
                : 'bg-gray-900/60 text-gray-400 border-gray-800 cursor-default'
              : provisioned
                ? isMenu
                  ? ''
                  : 'bg-gray-800/70 hover:bg-gray-700/70 text-gray-200 border-gray-700'
                : chosen
                  ? isMenu
                    ? 'text-emerald-200'
                    : 'bg-emerald-800/60 text-emerald-50 border-emerald-600 hover:bg-emerald-700/60'
                  : isMenu
                    ? ''
                    : 'bg-gray-800/70 hover:bg-gray-700/70 text-gray-200 border-gray-700'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`,
        )}
      >
        {headLocked ? <Lock size={12} /> : <GitBranch size={13} />}
        <span className="truncate max-w-[120px]">{label}</span>
        {target && (
          <span
            data-testid="session-branch-picker-target"
            className="truncate max-w-[110px] text-sky-300"
          >
            → {target}
          </span>
        )}
      </button>

      {open && (
        <div
          className={sessionActionSubmenuClass(
            variant,
            'absolute z-30 bottom-full mb-1 left-0 w-72 max-h-80 overflow-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-1 text-xs',
          )}
        >
          <div className="flex items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
            <span>Target branch</span>
            <button
              type="button"
              onClick={() => void loadBranches(true)}
              title="Refresh branch list"
              className="text-gray-400 hover:text-gray-200"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {loading && (
            <div className="flex items-center gap-2 px-2 py-2 text-gray-400">
              <Loader2 size={13} className="animate-spin" /> Loading branches…
            </div>
          )}
          {loadError && !loading && <div className="px-2 py-2 text-rose-300">{loadError}</div>}

          {!loading && !loadError && (
            <div data-testid="session-branch-picker-target-list">
              <button
                type="button"
                disabled={saving}
                onClick={() => void chooseTarget(null)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800 text-left text-gray-200"
              >
                <span className="w-3">
                  {!target && <Check size={12} className="text-emerald-400" />}
                </span>
                <span>
                  Default <span className="text-gray-500">(card, epic, or repo default)</span>
                </span>
              </button>
              {branches.map((b: any) => (
                <button
                  key={b.name}
                  type="button"
                  disabled={saving}
                  onClick={() => void chooseTarget(b.name)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800 text-left text-gray-200"
                >
                  <span className="w-3">
                    {target === b.name && <Check size={12} className="text-emerald-400" />}
                  </span>
                  <GitMerge size={12} className="text-gray-500 shrink-0" />
                  <span className="truncate">{b.name}</span>
                  {b.isDefault && <span className="text-gray-500 shrink-0">default</span>}
                </button>
              ))}
            </div>
          )}

          {!headLocked && (
            <div data-testid="session-branch-picker-head-list">
              <div className="my-1 border-t border-gray-800" />
              <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
                {provisioned ? 'Switch session to…' : 'Start session on…'}
              </div>

              {!provisioned && (
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
                    New branch <span className="text-gray-500">(off the target)</span>
                  </span>
                </button>
              )}

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
                      {(provisioned ? lockedBranch : chosen) === b.name && (
                        <Check size={12} className="text-emerald-400" />
                      )}
                    </span>
                    <GitBranch size={12} className="text-gray-500 shrink-0" />
                    <span className="truncate">{b.name}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Toast copy for a `PUT /target-branch` outcome; null when nothing moved. */
export function retargetNotice(
  retarget: any,
): { message: string; level: 'success' | 'info' } | null {
  if (!retarget) return null;
  const to = retarget.toBranch || 'the default branch';
  switch (retarget.kind) {
    case 'rebased':
      return {
        message: retarget.flattened
          ? `Target set to ${to}. Merge commits were combined into one commit with the same content and rebased; the original history is kept at ${retarget.flattened.backupRef}.`
          : `Target set to ${to}. Rebased ${retarget.commits ?? 0} commit(s).`,
        level: 'success',
      };
    case 'conflict':
      return {
        message: retarget.agentDispatched
          ? `Target set to ${to}. Rebase conflicts in ${retarget.files?.length ?? 0} file(s); the agent is resolving them.`
          : `Target set to ${to}. Rebase conflicts in ${retarget.files?.length ?? 0} file(s); rebase manually.`,
        level: 'info',
      };
    case 'unsafe':
      return {
        message: retarget.agentDispatched
          ? `Target set to ${to}. Not rebased automatically (${retarget.reason}); the agent will move the commits.`
          : `Target set to ${to}. Not rebased automatically (${retarget.reason}); move the commits manually.`,
        level: 'info',
      };
    case 'dirty':
      return {
        message: retarget.agentDispatched
          ? `Target set to ${to}. Uncommitted changes, so the agent will commit and rebase.`
          : `Target set to ${to}. Commit your changes, then rebase onto it.`,
        level: 'info',
      };
    case 'stored':
      return { message: `Session will branch from ${to}.`, level: 'info' };
    default:
      return null;
  }
}
