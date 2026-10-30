import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../../utils/api';
import { SESSION_ACTION_TOOLBAR_BUTTON_CLASS } from '../../utils/sessionActionMenu';
import { qaSessionControl, type QaSessionStateWire } from '@shared/utils/qaSessionRequest';

/**
 * "Run QA Tests" on the session action bar: a checkbox before the session's
 * work merges (QA runs once it does), a button after. Either way the QA
 * agent drafts a plan from the session, the plan is approved, and it runs on
 * the project's default QA environment after the configured delay. Links to
 * the plan once it exists.
 */
export default function SessionQaControl({
  sessionId,
  sessionState,
  disabled = false,
  onOpenPlan,
  onError,
}: {
  sessionId: string;
  /** The session's resolved state; a change to `merged` refetches. */
  sessionState?: string | null;
  disabled?: boolean;
  onOpenPlan?: (planId: string) => void;
  onError?: (message: string) => void;
}) {
  // Results are tagged with the session they belong to, so a GET or mutation
  // that resolves after the user switched sessions never shows (or acts on)
  // the previous session's request.
  const [loaded, setLoaded] = useState<{ sessionId: string; data: QaSessionStateWire } | null>(
    null,
  );
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const latest = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const state = loaded?.sessionId === sessionId ? loaded.data : null;
  const pending = pendingFor === sessionId;

  // Every state the control shows comes from this sequenced GET: the last GET
  // started wins, so an older response (including a mutation's) can never
  // overwrite a newer one.
  const load = useCallback((): Promise<void> => {
    const seq = ++latest.current;
    return api
      .getSessionQaRequest(sessionId)
      .then((s) => {
        if (seq === latest.current) setLoaded({ sessionId, data: s });
      })
      .catch(() => {
        if (seq === latest.current) setLoaded(null);
      });
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load, sessionState]);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail as { sessionId?: string; action?: string } | undefined;
      if (
        d?.sessionId === sessionId ||
        d?.action === 'environments_updated' ||
        d?.action === 'settings_updated' ||
        d?.action === 'pr_merged'
      ) {
        load();
      }
    };
    window.addEventListener('qa_update', onUpdate);
    return () => window.removeEventListener('qa_update', onUpdate);
  }, [sessionId, load]);

  if (!state) return null;
  const control = qaSessionControl(state);

  const act = async (fn: () => Promise<QaSessionStateWire>) => {
    const target = sessionId;
    setPendingFor(target);
    try {
      await fn();
      // The mutation's own response is a snapshot from before any follow-up
      // transition (drafting finishing, a launch) landed, so it is not shown;
      // a fresh GET is, ordered with the event-driven ones.
      if (currentSession.current === target) await load();
    } catch (err) {
      if (currentSession.current !== target) return;
      onError?.(err instanceof Error ? err.message : 'Could not update QA tests');
      await load();
    } finally {
      setPendingFor((p) => (p === target ? null : p));
    }
  };

  const unusable = disabled || pending || !control.enabled;
  const statusLine = control.status ? (
    <span
      data-testid="session-qa-status"
      className={`max-w-[14rem] truncate text-[11px] ${
        state.request?.status === 'failed' ? 'text-red-300' : 'text-slate-400'
      }`}
      title={control.status}
    >
      {control.status}
    </span>
  ) : null;
  const planLink = control.planId ? (
    <button
      type="button"
      data-testid="session-qa-plan-link"
      onClick={() => onOpenPlan?.(control.planId!)}
      className="inline-flex items-center gap-1 text-[11px] text-sky-300 underline decoration-dotted hover:text-sky-200"
      title={state.request?.planTitle ?? 'Open the QA plan'}
    >
      View QA test
      <ExternalLink size={11} />
    </button>
  ) : null;

  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="session-qa-control">
      {control.kind === 'checkbox' ? (
        <label
          title={control.title}
          className={`inline-flex items-center gap-1.5 text-xs text-gray-300 ${
            unusable ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
          }`}
        >
          <input
            type="checkbox"
            data-testid="session-qa-checkbox"
            checked={control.checked}
            disabled={unusable}
            onChange={(e) => {
              const armed = e.target.checked;
              void act(() => api.setSessionQaRequestArmed(sessionId, armed));
            }}
            className="h-3.5 w-3.5 accent-teal-500"
          />
          Run QA Tests
        </label>
      ) : (
        <button
          type="button"
          data-testid="session-qa-run-button"
          title={control.title}
          disabled={unusable}
          onClick={() => void act(() => api.runSessionQaRequest(sessionId))}
          className={`${SESSION_ACTION_TOOLBAR_BUTTON_CLASS} border-teal-700/60 bg-teal-950/40 text-teal-100 hover:bg-teal-900/50 disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {pending || control.busy ? (
            <Loader2 size={14} className="animate-spin shrink-0" />
          ) : (
            <ClipboardCheck size={14} className="shrink-0" />
          )}
          Run QA Tests
        </button>
      )}
      {planLink}
      {statusLine}
    </div>
  );
}
