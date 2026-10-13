import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Copy, KeyRound, Link2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import {
  DEFAULT_SHARE_LINK_HOURS,
  SHARE_LINK_EXPIRY_OPTIONS,
  SHARE_LIST_RETRY_MS,
  initialShareListState,
  sharePanelKey,
  shareListReducer,
  shouldScheduleShareRetry,
  shareLinkStatusLabel,
  sortShareLinks,
  type PrEnvironmentShareList,
} from '@shared/utils/prEnvironmentShare';

interface Props {
  projectId: string;
  prNumber: number;
  onToast?: (msg: string, kind?: string) => void;
  /**
   * False where the environment panel itself is hidden (e.g. a closed PR whose
   * environment stopped): show only when links exist, so they can still be
   * inspected and revoked without an empty row on every PR.
   */
  showWhenEmpty?: boolean;
}

/**
 * Share links for a PR environment: create (with expiry), copy, revoke, and
 * the optional project password. Renders nothing only when the server says
 * share links cannot exist here (no wildcard ingress, not Hub-hosted). Any
 * other load failure keeps what was already shown, offers Retry, and retries
 * on its own.
 */
export default function PrEnvironmentShareLinks({
  projectId,
  prNumber,
  onToast,
  showWhenEmpty = true,
}: Props) {
  const key = sharePanelKey(projectId, prNumber);
  const [list, dispatch] = useReducer(shareListReducer, initialShareListState);
  const retryArmed = shouldScheduleShareRetry(list);
  const seqRef = useRef(0);
  // The PR currently shown. Async work compares against it when it finishes:
  // a mutation started on another PR must not reload, toast, or reset the form.
  const keyRef = useRef(key);
  keyRef.current = key;
  const [hours, setHours] = useState(DEFAULT_SHARE_LINK_HOURS);
  const [label, setLabel] = useState('');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const busy = busyFor === key;
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    dispatch({ type: 'start', key, seq });
    try {
      const data = (await api.listPrEnvironmentShareLinks(
        projectId,
        prNumber,
      )) as PrEnvironmentShareList;
      dispatch({ type: 'loaded', key, seq, data });
    } catch (error) {
      dispatch({ type: 'failed', key, seq, error });
    }
  }, [key, projectId, prNumber]);

  useEffect(() => {
    dispatch({ type: 'reset', key, seq: ++seqRef.current });
    setLabel('');
    setPassword('');
    setHours(DEFAULT_SHARE_LINK_HOURS);
    void load();
  }, [key, load]);

  // A failed load retries on its own; Retry in the panel does it now.
  useEffect(() => {
    // Armed only once the failed request has settled: a retry never
    // overlaps (and so never discards) a slow request still in flight.
    if (!retryArmed) return undefined;
    const timer = setTimeout(() => void load(), SHARE_LIST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [retryArmed, load]);

  const copy = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        onToast?.('Share link copied', 'success');
      } catch {
        onToast?.('Could not copy the link', 'error');
      }
    },
    [onToast],
  );

  /**
   * Run a mutation for the PR shown now. Its follow-up (form reset, toast,
   * reload) runs only if that PR is still shown when it finishes.
   */
  const mutate = async <T,>(
    work: () => Promise<T>,
    after: (result: T) => void | Promise<void>,
    failure: string,
  ) => {
    const startedFor = key;
    setBusyFor(startedFor);
    try {
      const result = await work();
      if (keyRef.current !== startedFor) return;
      await after(result);
      await load();
    } catch (e: any) {
      if (keyRef.current === startedFor) onToast?.(e?.message || failure, 'error');
    } finally {
      setBusyFor((cur) => (cur === startedFor ? null : cur));
    }
  };

  const create = () =>
    mutate(
      () =>
        api.createPrEnvironmentShareLink(projectId, prNumber, {
          expiresInHours: hours,
          label: label.trim() || undefined,
        }) as Promise<{ link: { url: string | null } }>,
      async (res) => {
        setLabel('');
        if (res.link.url) await copy(res.link.url);
      },
      'Failed to create share link',
    );

  const revoke = (id: string) =>
    mutate(
      () => api.revokePrEnvironmentShareLink(projectId, prNumber, id),
      () => undefined,
      'Failed to revoke share link',
    );

  const savePassword = (next: string | null) =>
    mutate(
      () => api.setPrEnvironmentSharePassword(projectId, next),
      () => {
        setPassword('');
        onToast?.(next ? 'Share password set' : 'Share password removed', 'success');
      },
      'Failed to save the password',
    );

  const retryButton = (
    <button
      type="button"
      data-testid="pr-share-retry"
      onClick={() => void load()}
      disabled={list.inFlight}
      className="flex items-center gap-1 text-xs text-sky-300 hover:text-sky-100 disabled:opacity-50"
    >
      <RefreshCw size={12} />
      Retry
    </button>
  );
  // Until the reset for a new PR lands, the reducer still holds the previous
  // PR's list; never render it (its link ids would hit this PR's routes).
  if (list.key !== key) return null;
  const data = list.data;
  if (list.status === 'unsupported') return null;
  if (!showWhenEmpty && (!data || data.links.length === 0)) return null;
  if (!data) {
    if (list.status !== 'error') return null;
    return (
      <div
        data-testid="pr-share-error"
        className="mt-1.5 flex items-center gap-2 text-xs text-rose-300"
      >
        <span>Share links did not load: {list.error}</span>
        {retryButton}
      </div>
    );
  }
  const links = sortShareLinks(data.links);
  const active = links.filter((l) => l.status === 'active').length;

  return (
    <details data-testid="pr-share-links" className="mt-1.5">
      <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-200">
        Share links{active > 0 ? ` (${active} active)` : ''}
        {data.passwordRequired ? ' · password required' : ''}
      </summary>
      <div className="mt-1.5 space-y-2">
        {list.status === 'error' && (
          <div
            data-testid="pr-share-error"
            className="flex items-center gap-2 text-xs text-rose-300"
          >
            <span>Could not refresh: {list.error}</span>
            {retryButton}
          </div>
        )}
        {data.canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="pr-share-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Who is it for? (optional)"
              maxLength={120}
              className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-xs text-gray-200"
            />
            <select
              data-testid="pr-share-expiry"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-xs text-gray-200"
            >
              {SHARE_LINK_EXPIRY_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  Expires in {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="pr-share-create"
              onClick={create}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs text-sky-300 hover:text-sky-100 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Create and copy link
            </button>
          </div>
        )}

        {links.length === 0 ? (
          <p className="text-xs text-gray-500">
            No share links yet. A share link lets someone without an Agent Hub account open this
            environment.
          </p>
        ) : (
          <ul className="space-y-1">
            {links.map((l) => (
              <li
                key={l.id}
                data-testid="pr-share-link-row"
                className="flex items-center gap-2 text-xs text-gray-300"
              >
                <span className={l.status === 'active' ? 'text-gray-200' : 'text-gray-500'}>
                  {l.label || 'Untitled link'}
                </span>
                <span className="text-gray-500">{shareLinkStatusLabel(l)}</span>
                {l.url && (
                  <button
                    type="button"
                    data-testid="pr-share-copy"
                    onClick={() => copy(l.url!)}
                    className="ml-auto flex items-center gap-1 text-gray-400 hover:text-gray-200"
                  >
                    <Copy size={12} />
                    Copy
                  </button>
                )}
                {l.canRevoke && (
                  <button
                    type="button"
                    data-testid="pr-share-revoke"
                    onClick={() => revoke(l.id)}
                    disabled={busy}
                    className={`${l.url ? '' : 'ml-auto '}flex items-center gap-1 text-rose-300 hover:text-rose-100 disabled:opacity-50`}
                  >
                    <Trash2 size={12} />
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {data.canSetPassword && (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-700/60 pt-2">
            <KeyRound size={13} className="text-gray-400" />
            <span className="text-xs text-gray-400">
              Project password {data.passwordRequired ? 'is set' : 'is off'}
            </span>
            <input
              data-testid="pr-share-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={data.passwordRequired ? 'New password' : 'Require a password'}
              autoComplete="new-password"
              className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-xs text-gray-200"
            />
            <button
              type="button"
              data-testid="pr-share-password-save"
              onClick={() => savePassword(password)}
              disabled={busy || password.length < 4}
              className="text-xs text-sky-300 hover:text-sky-100 disabled:opacity-50"
            >
              Save
            </button>
            {data.passwordRequired && (
              <button
                type="button"
                data-testid="pr-share-password-clear"
                onClick={() => savePassword(null)}
                disabled={busy}
                className="text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
