import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  reconcilePendingApprovals,
  withoutApproval,
  type ApprovalWire,
} from '@shared/utils/approvals';
import { api } from '../utils/api';
import { approvalEvents } from '../utils/approvalEvents';

export interface UsePendingApprovals {
  /** Oldest first. */
  pending: ApprovalWire[];
  reload: () => Promise<void>;
  /** Remove one locally after it was answered here. */
  drop: (approvalId: string) => void;
}

/** Scope key for a result set: one session, or every session (`*`). */
function scopeKey(sessionId: string | undefined): string {
  return sessionId ? `session:${sessionId}` : '*';
}

/**
 * The caller's approvals still waiting for an answer, optionally for one
 * session. Reloads on a new request and drops rows the moment the server
 * says they settled, wherever they were answered.
 */
export function usePendingApprovals(
  opts: { sessionId?: string | null; enabled?: boolean } = {},
): UsePendingApprovals {
  const { sessionId, enabled = true } = opts;
  const active = enabled && sessionId !== null;
  const scope = scopeKey(sessionId ?? undefined);
  // Results are tagged with their scope so switching sessions never shows (or
  // lets the user answer) the previous session's approvals while the new list loads.
  const [state, setState] = useState<{ scope: string | null; items: ApprovalWire[] }>({
    scope: null,
    items: [],
  });
  const seq = useRef(0);
  // Ids answered here or resolved over WS; a late list response can't revive them.
  const settled = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!active) {
      setState({ scope, items: [] });
      return;
    }
    try {
      const res = await api.listMyApprovals({
        status: 'pending',
        ...(sessionId ? { sessionId } : {}),
      });
      if (mine === seq.current) {
        setState({ scope, items: reconcilePendingApprovals(res.approvals, settled.current) });
      }
    } catch {
      if (mine === seq.current) setState({ scope, items: [] });
    }
  }, [active, scope, sessionId]);

  const drop = useCallback((approvalId: string) => {
    settled.current.add(approvalId);
    setState((prev) => ({ ...prev, items: withoutApproval(prev.items, approvalId) }));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      approvalEvents.subscribe((data) => {
        // Resolutions are recorded for every session so a late snapshot can't revive them.
        if (data.type === APPROVAL_RESOLVED_EVENT && typeof data.approvalId === 'string') {
          drop(data.approvalId);
        } else if (
          data.type === APPROVAL_REQUESTED_EVENT &&
          (!sessionId || data.sessionId === sessionId)
        ) {
          void reload();
        }
      }),
    [sessionId, reload, drop],
  );

  const pending = active && state.scope === scope ? state.items : [];
  return { pending, reload, drop };
}
