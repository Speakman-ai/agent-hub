/**
 * Chat-side hooks for the `request_login` handoff: tell clients a sign-in is
 * waiting (which also drives the owner's notification through the broadcast
 * fan-out) and when it ends, and honour a Stop that landed first.
 */

import type { BrowserLoginHandoffDeps } from './browser-tools.js';
import { isReactChainCancelRequested } from './react-chain-cancel.js';

export const BROWSER_LOGIN_REQUESTED_EVENT = 'browser_login_requested';
export const BROWSER_LOGIN_RESOLVED_EVENT = 'browser_login_resolved';

export interface BrowserLoginBroadcastContext {
  broadcast: (data: Record<string, unknown>) => void;
  sessionId: string;
  agentId: string;
  agentName?: string | null;
  projectId: string | null;
  sessionName: string | null;
  ownerUserId: string | null;
  timeoutMs?: number;
}

export function browserLoginHandoffDeps(
  ctx: BrowserLoginBroadcastContext,
): BrowserLoginHandoffDeps {
  return {
    timeoutMs: ctx.timeoutMs,
    isCancelled: () => isReactChainCancelRequested(ctx.sessionId),
    onRequested: (request) => {
      ctx.broadcast({
        type: BROWSER_LOGIN_REQUESTED_EVENT,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        agentName: ctx.agentName ?? undefined,
        projectId: ctx.projectId ?? undefined,
        sessionName: ctx.sessionName ?? undefined,
        ownerUserId: ctx.ownerUserId ?? undefined,
        request,
      });
    },
    onResolved: (request, resolution) => {
      ctx.broadcast({
        type: BROWSER_LOGIN_RESOLVED_EVENT,
        sessionId: ctx.sessionId,
        requestId: request.requestId,
        domain: request.domain,
        outcome: resolution.outcome,
      });
    },
  };
}
