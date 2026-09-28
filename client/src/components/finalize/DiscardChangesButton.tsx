import { useCallback, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { api } from '../../utils/api';
import {
  DISCARD_CONFIRM_TITLE,
  discardConfirmMessage,
  summarizeDiscardDiff,
} from '@shared/utils/discardChanges';
import { SESSION_ACTION_MENU_ITEM_CLASS } from '../../utils/sessionActionMenu';

export interface DiscardResult {
  sessionId: string;
  discardedAt: string | null;
}

interface Props {
  sessionId: string | null;
  /** Why the action is unavailable; the button disables and shows it as a tooltip. */
  blockedReason?: string | null;
  variant?: 'default' | 'compact' | 'menu';
  onDiscarded?: (result: DiscardResult) => void;
  onError?: (msg: string) => void;
}

/**
 * Ends an experiment session without Finalize: resets the worktree to its
 * base branch. The confirm dialog loads the diff first so the operator sees
 * what is about to be thrown away.
 */
export default function DiscardChangesButton({
  sessionId,
  blockedReason = null,
  variant = 'default',
  onDiscarded,
  onError,
}: Props) {
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(async () => {
    if (!sessionId || pending || blockedReason) return;
    setPending(true);
    try {
      let summary = null;
      try {
        summary = summarizeDiscardDiff(await api.getSessionChanges(sessionId));
      } catch {
        // The confirm copy says the size is unknown; discarding is still allowed.
      }
      const ok = window.confirm(`${DISCARD_CONFIRM_TITLE}\n\n${discardConfirmMessage(summary)}`);
      if (!ok) return;
      const res: any = await api.discardSessionChanges(sessionId);
      onDiscarded?.({ sessionId, discardedAt: res?.discardedAt ?? null });
    } catch (err: any) {
      onError?.(err?.message || 'Failed to discard changes');
    } finally {
      setPending(false);
    }
  }, [sessionId, pending, blockedReason, onDiscarded, onError]);

  const compact = variant === 'compact';
  const className =
    variant === 'menu'
      ? `${SESSION_ACTION_MENU_ITEM_CLASS} text-red-200`
      : compact
        ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-red-800/60 bg-red-950/30 text-red-200 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed'
        : 'flex w-[150px] min-w-[150px] shrink-0 justify-center items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-red-800/60 bg-red-950/30 text-red-200 hover:bg-red-900/40 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto sm:min-w-0 sm:inline-flex';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!sessionId || pending || !!blockedReason}
      title={
        compact
          ? undefined
          : blockedReason || 'Reset the worktree to its base branch and drop all changes'
      }
      aria-label="Discard changes"
      aria-busy={pending}
      data-testid="discard-changes-button"
      className={className}
    >
      {pending ? (
        <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
      ) : (
        <Trash2 size={compact ? 12 : 14} className="shrink-0" />
      )}
      Discard
    </button>
  );
}
