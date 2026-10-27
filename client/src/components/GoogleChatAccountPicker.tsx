import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, MessageSquare } from 'lucide-react';
import { api } from '../utils/api';
import {
  chatAccountChoices,
  chatAccountNotice,
  type GoogleChatAccountState,
} from '@shared/utils/googleChatAccount';

/**
 * Picks the one linked Workspace account Google Chat runs as. Chat stays
 * single-account (one push subscription, one sender identity), unlike
 * Calendar and Gmail, so this is an explicit choice that survives changing
 * the default account. Hidden until there is a Chat-capable account to pick.
 */
export default function GoogleChatAccountPicker({ reloadKey }: { reloadKey?: unknown }) {
  const [state, setState] = useState<GoogleChatAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getGoogleChatAccount());
    } catch {
      // Older servers have no Chat account endpoint; the picker stays hidden.
      setState(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  if (!state) return null;
  const choices = chatAccountChoices(state);
  const notice = chatAccountNotice(state);
  if (!choices.length && !notice) return null;

  const choose = async (accountId: string) => {
    if (!accountId || accountId === state.account?.accountId) return;
    const target = choices.find((c) => c.accountId === accountId);
    if (
      state.account &&
      !window.confirm(
        `Move Google Chat to ${target?.email ?? 'this account'}? Notifications from ${state.account.email} stop, and agent replies waiting for approval are discarded.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setState(await api.setGoogleChatAccount(accountId));
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-gray-700 pt-3 space-y-2" data-testid="google-chat-account">
      <label className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
        <MessageSquare size={13} className="text-gray-400" />
        <span>Google Chat account</span>
        <select
          aria-label="Google Chat account"
          value={state.account?.accountId ?? ''}
          disabled={busy || !choices.length}
          onChange={(e) => choose(e.target.value)}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200"
        >
          {!state.account && <option value="">Choose an account…</option>}
          {choices.map((c) => (
            <option key={c.accountId} value={c.accountId}>
              {c.email}
            </option>
          ))}
        </select>
        {busy && <Loader2 size={12} className="animate-spin" />}
      </label>
      <p className="text-[11px] text-gray-500">
        Chat, its notifications, agent replies, and project chat triggers use this one account. Only
        Google Workspace accounts can use Chat.
      </p>
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200"
        >
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
