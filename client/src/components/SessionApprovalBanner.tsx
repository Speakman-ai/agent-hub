import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  describeApproval,
  formatApprovalExpiry,
  reconcilePendingApprovals,
  withoutApproval,
  type ApprovalWire,
} from '@shared/utils/approvals';
import { formatPolicyDomain } from '@shared/utils/desktopAppPolicy';
import { api } from '../utils/api';
import ApprovalActions, { APPROVAL_WS_EVENT } from './ApprovalActions';

/**
 * Pending approvals for one session, shown above the composer. The agent's
 * turn is parked until each one is answered, so this stays visible until the
 * server says it settled (answered here, from the bell, from a phone, or by
 * timeout / Stop).
 */
export default function SessionApprovalBanner({ sessionId }: { sessionId: string }) {
  // Results are tagged with their session so a switch never shows (or lets
  // the user answer) the previous session's approvals while the new list loads.
  const [state, setState] = useState<{ sessionId: string | null; items: ApprovalWire[] }>({
    sessionId: null,
    items: [],
  });
  const seq = useRef(0);
  // Ids answered here or resolved over WS; a late list response can't revive them.
  const settled = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api.listMyApprovals({ status: 'pending', sessionId });
      if (mine === seq.current) {
        setState({ sessionId, items: reconcilePendingApprovals(res.approvals, settled.current) });
      }
    } catch {
      // Agent callers and signed-out views get 401/403; there is nothing to answer.
      if (mine === seq.current) setState({ sessionId, items: [] });
    }
  }, [sessionId]);

  const settle = useCallback((id: string) => {
    settled.current.add(id);
    setState((prev) => ({ ...prev, items: withoutApproval(prev.items, id) }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onEvent = (e: Event) => {
      const data = (e as CustomEvent).detail as Record<string, unknown> | null;
      if (!data) return;
      // Resolutions are recorded for every session so a late snapshot can't revive them.
      if (data.type === APPROVAL_RESOLVED_EVENT && typeof data.approvalId === 'string') {
        settle(data.approvalId);
      } else if (data.type === APPROVAL_REQUESTED_EVENT && data.sessionId === sessionId) {
        void load();
      }
    };
    window.addEventListener(APPROVAL_WS_EVENT, onEvent);
    return () => window.removeEventListener(APPROVAL_WS_EVENT, onEvent);
  }, [sessionId, load, settle]);

  const pending = state.sessionId === sessionId ? state.items : [];
  if (pending.length === 0) return null;

  return (
    <div className="mx-3 mb-2 space-y-2" data-testid="session-approval-banner">
      {pending.map((a) => (
        <div
          key={a.id}
          role="alert"
          className="rounded-md border border-amber-600/50 bg-amber-950/40 px-3 py-2.5 text-sm"
          data-testid="session-approval"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-amber-100">Approval needed:</span>
                <span className="break-words text-amber-50">{describeApproval(a)}</span>
                <span className="text-[11px] text-amber-300/70">
                  {formatApprovalExpiry(a.expiresAt)}
                </span>
              </div>
              {a.domain && (
                <p className="text-xs text-amber-200/80">on {formatPolicyDomain(a.domain)}</p>
              )}
              {a.details && (
                <p className="whitespace-pre-wrap break-words text-xs text-amber-100/80">
                  {a.details}
                </p>
              )}
              <ApprovalActions approval={a} onSettled={settle} testIdPrefix="session-approval" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
