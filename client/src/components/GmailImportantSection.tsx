import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Sparkles, Star, X } from 'lucide-react';
import { api } from '../utils/api';
import {
  GMAIL_IMPORTANCE_AUTO_SCAN_OPTIONS,
  createGmailImportanceSync,
  GMAIL_IMPORTANCE_WINDOW_OPTIONS,
  importanceStatusLine,
  senderName,
  type GmailImportanceAutoScan,
  type GmailImportanceState,
  type GmailImportanceSync,
  type GmailImportanceWindowDays,
  type GmailImportantThread,
} from '@shared/utils/gmailImportance';

const NO_PINS: GmailImportantThread[] = [];

/**
 * AI-picked important threads pinned above the Gmail inbox list. Owns its own
 * state; reports the pinned threads up so the parent can drop them from the
 * regular list.
 */
export default function GmailImportantSection({
  account,
  accountLabel,
  onOpenThread,
  onPinnedChange,
}: {
  /** Linked account whose mailbox this section rates; omitted means the default. */
  account?: string;
  /** Shown next to the title when several mailboxes each have a section. */
  accountLabel?: string;
  onOpenThread: (threadId: string) => void;
  onPinnedChange?: (threads: GmailImportantThread[]) => void;
}) {
  const scope = account ? { account } : {};
  const [state, setState] = useState<GmailImportanceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onPinnedChangeRef = useRef(onPinnedChange);
  onPinnedChangeRef.current = onPinnedChange;
  // Every fetch, scan, and settings response goes through one scheduler that
  // always books the next fetch (fast while scanning, slow while idle), so
  // automated scans and transient failures never leave the pane stale.
  const syncRef = useRef<GmailImportanceSync | null>(null);
  // Threads being dismissed, hidden right away so the click feels instant.
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());
  const loadFailedRef = useRef(false);

  useEffect(() => {
    const sync = createGmailImportanceSync({
      load: () => api.getGmailImportance(scope),
      onState: (next) => {
        // A recovered fetch clears its own failure, not a scan/settings error.
        if (loadFailedRef.current) {
          loadFailedRef.current = false;
          setError(null);
        }
        setState(next);
      },
      onError: (message) => {
        loadFailedRef.current = true;
        setError(message);
      },
    });
    syncRef.current = sync;
    sync.start();
    return () => {
      sync.stop();
      syncRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scope` derives from `account`
  }, [account]);

  // The parent hides exactly the pins this section is showing, derived from
  // what renders rather than pushed on fetch success. No state yet, a failed
  // load, the feature off, or the section unmounting all mean nothing is
  // shown here, so nothing may be hidden from the regular list either.
  const displayedPins = useMemo(
    () =>
      state?.settings.enabled ? state.threads.filter((t) => !dismissing.has(t.threadId)) : NO_PINS,
    [state, dismissing],
  );
  useEffect(() => {
    onPinnedChangeRef.current?.(displayedPins);
  }, [displayedPins]);
  useEffect(() => () => onPinnedChangeRef.current?.(NO_PINS), []);

  const accept = (next: GmailImportanceState) => syncRef.current?.accept(next);
  const refresh = () => syncRef.current?.refresh();

  const dismiss = async (threadId: string) => {
    setError(null);
    setDismissing((prev) => new Set(prev).add(threadId));
    try {
      accept(await api.dismissGmailImportantThread(threadId, scope));
    } catch (err: any) {
      // 404: a scan already dropped the verdict, so it is gone either way.
      if (err.status === 404) await refresh();
      else setError(err.message || 'Failed to remove thread');
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  };

  const scan = async (windowDays?: GmailImportanceWindowDays) => {
    setError(null);
    try {
      accept(await api.startGmailImportanceScan(windowDays ? { windowDays } : {}, scope));
    } catch (err: any) {
      // 409 means a scan is already going; just pick up its state.
      if (err.status === 409) await refresh();
      else setError(err.message || 'Failed to start scan');
    }
  };

  const save = async (
    patch: Partial<{
      enabled: boolean;
      windowDays: GmailImportanceWindowDays;
      autoScan: GmailImportanceAutoScan;
    }>,
  ) => {
    // The window is locked while a scan runs: the running scan covers the old
    // window, and switching under it would leave the new range unrated.
    if (patch.windowDays !== undefined && state?.running) return;
    setSaving(true);
    setError(null);
    try {
      const next: GmailImportanceState = await api.updateGmailImportanceSettings(patch, scope);
      accept(next);
      // First enable, or a new window: rate what is in it now. Cached verdicts
      // keep this cheap, since only unrated threads reach the model.
      const turnedOn = patch.enabled === true && !next.settings.lastScanAt;
      if ((turnedOn || patch.windowDays !== undefined) && !next.running) {
        await scan(next.settings.windowDays);
      }
    } catch (err: any) {
      // 409: a scan started elsewhere (another client or the auto-scan) before
      // this pane saw it. Pull its state so the window picker locks.
      if (err.status === 409) await refresh();
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Errors render outside the enabled branch and before state loads: a failed
  // enable leaves enabled=false, and a failed first load leaves no state, and
  // both must still say why.
  const errorBox = error ? (
    <div
      role="alert"
      className="mx-4 mb-2 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200"
    >
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
      {error}
    </div>
  ) : null;

  if (!state) {
    return errorBox ? (
      <section
        className="mb-4 rounded-lg border border-amber-500/20 bg-gray-900 pt-2"
        aria-label={accountLabel ? `Important mail for ${accountLabel}` : 'Important mail'}
      >
        {errorBox}
      </section>
    ) : null;
  }
  const { settings, running } = state;
  const threads = displayedPins;

  return (
    <section
      className="mb-4 rounded-lg border border-amber-500/20 bg-gray-900"
      aria-label={accountLabel ? `Important mail for ${accountLabel}` : 'Important mail'}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles size={15} className="flex-shrink-0 text-amber-300" />
          <h3 className="text-sm font-semibold text-white">Important</h3>
          {accountLabel && (
            <span className="truncate text-xs text-gray-400" title={accountLabel}>
              {accountLabel}
            </span>
          )}
          {settings.enabled && threads.length > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-200">
              {threads.length}
            </span>
          )}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            role="switch"
            aria-label="Show important mail first"
            checked={settings.enabled}
            disabled={saving}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="h-4 w-4 accent-amber-500"
          />
          Show important first
        </label>
      </div>

      {errorBox}
      {!settings.enabled ? (
        <p className="border-t border-gray-800 px-4 py-3 text-xs text-gray-400">
          Your AI engine reads sender, subject, and preview of recent inbox mail and pins what needs
          your attention here. It runs on your own AI subscription.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 px-4 py-2 text-xs">
            <div
              className="inline-flex overflow-hidden rounded border border-gray-700"
              role="group"
            >
              {GMAIL_IMPORTANCE_WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={settings.windowDays === opt.value}
                  disabled={saving || running}
                  onClick={() =>
                    settings.windowDays !== opt.value && save({ windowDays: opt.value })
                  }
                  className={`px-2.5 py-1 ${
                    settings.windowDays === opt.value
                      ? 'bg-amber-500/20 text-amber-100'
                      : 'text-gray-400 hover:bg-gray-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-1.5 text-gray-400">
              Auto-scan
              <select
                aria-label="Automated scan"
                value={settings.autoScan}
                disabled={saving}
                onChange={(e) => save({ autoScan: e.target.value as GmailImportanceAutoScan })}
                className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200"
              >
                {GMAIL_IMPORTANCE_AUTO_SCAN_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => scan()}
              disabled={running || saving}
              className="ml-auto inline-flex items-center gap-1.5 rounded border border-gray-700 px-2.5 py-1 text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Scan now
            </button>
          </div>
          <p
            className={`px-4 pb-2 text-xs ${
              settings.lastScanStatus === 'error' && !running ? 'text-red-300' : 'text-gray-500'
            }`}
          >
            {importanceStatusLine(state)}
            {settings.lastScanFailover && !running && (
              <span className="ml-1 text-amber-300">{settings.lastScanFailover}.</span>
            )}
          </p>
          {threads.length > 0 ? (
            <ul className="border-t border-gray-800">
              {threads.map((t) => (
                <li
                  key={t.threadId}
                  className="group relative border-b border-gray-800 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => onOpenThread(t.threadId)}
                    className="flex w-full items-start gap-3 py-3 pl-4 pr-10 text-left hover:bg-gray-800/50"
                  >
                    <Star size={15} className="mt-0.5 flex-shrink-0 text-amber-300" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-100">
                          {senderName(t.from)}
                        </span>
                        {t.lastMessageAt && (
                          <span className="ml-auto flex-shrink-0 text-xs text-gray-500">
                            {new Date(t.lastMessageAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-sm text-gray-300">
                        {t.subject || '(no subject)'}
                      </p>
                      {t.reason && <p className="mt-0.5 text-xs text-amber-200/80">{t.reason}</p>}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(t.threadId)}
                    aria-label={`Remove ${t.subject || 'thread'} from important`}
                    title="Remove from important"
                    className="absolute right-2 top-2.5 rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-gray-200"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            settings.lastScanAt &&
            !running && (
              <p className="border-t border-gray-800 px-4 py-3 text-xs text-gray-500">
                Nothing important in the last{' '}
                {settings.windowDays === 1 ? 'day' : `${settings.windowDays} days`}.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
