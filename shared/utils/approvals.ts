/**
 * Pure helpers for answering agent approval requests, shared by web and
 * mobile (session banner, bell rows, push actions, Settings → Approvals) and
 * by the server's push builder for the notification category id.
 */

export type ApprovalDecision = 'allow_once' | 'always_allow' | 'deny';
export type ApprovalStatusWire = 'pending' | 'allowed' | 'denied' | 'cancelled';

/** Shape of `serializeApproval` from `GET /api/me/approvals`. */
export interface ApprovalWire {
  id: string;
  sessionId: string;
  agentId: string;
  projectId: string | null;
  action: string;
  target: string;
  domain: string | null;
  details: string;
  status: ApprovalStatusWire;
  resolution: string | null;
  ruleId: string | null;
  canRemember: boolean;
  requestedAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

/** Shape of one row from `GET /api/me/approval-rules`. */
export interface ApprovalRuleWire {
  id: string;
  profileId: string;
  userId: string;
  domain: string;
  action: string;
  effect: 'allow' | 'require';
  sourceRequestId: string | null;
  createdAt: string;
}

/** WS broadcast types the approval surfaces react to. */
export const APPROVAL_REQUESTED_EVENT = 'approval_requested';
export const APPROVAL_RESOLVED_EVENT = 'approval_resolved';
export const APPROVAL_WS_EVENTS: ReadonlySet<string> = new Set([
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
]);

/**
 * Notification category id registered on the device for actionable approval
 * pushes, and sent as Expo `categoryId`. Underscores only: Expo warns that
 * colons and hyphens can break categories.
 */
export const APPROVAL_PUSH_CATEGORY = 'approval_requested';

/**
 * Push action buttons. Always allow needs a domain and a visible target to be
 * a sensible one-tap choice, so the lock screen only offers the two answers
 * that are safe for every request.
 */
export const APPROVAL_PUSH_ACTIONS: ReadonlyArray<{
  identifier: Extract<ApprovalDecision, 'allow_once' | 'deny'>;
  buttonTitle: string;
  destructive: boolean;
}> = [
  { identifier: 'allow_once', buttonTitle: 'Allow once', destructive: false },
  { identifier: 'deny', buttonTitle: 'Deny', destructive: true },
];

/** Expo `categoryId` for a catalog notification category, if it has actions. */
export function pushCategoryIdFor(category: string | null | undefined): string | undefined {
  return category === 'approval_requested' ? APPROVAL_PUSH_CATEGORY : undefined;
}

/** The decision a push action button maps to, or null for a plain tap. */
export function pushActionDecision(actionIdentifier: unknown): 'allow_once' | 'deny' | null {
  return actionIdentifier === 'allow_once' || actionIdentifier === 'deny' ? actionIdentifier : null;
}

/** Approval id carried by a bell row or push payload, if it is an approval. */
export function approvalIdFromNotification(n: {
  category?: unknown;
  data?: unknown;
}): string | null {
  const data = (n.data && typeof n.data === 'object' ? n.data : {}) as Record<string, unknown>;
  const isApproval = n.category === 'approval_requested' || data.type === 'approval_requested';
  if (!isApproval) return null;
  if (typeof data.approvalId === 'string' && data.approvalId) return data.approvalId;
  // Foreground banners carry the raw broadcast, which nests the approval.
  const nested = data.approval as { id?: unknown } | undefined;
  return typeof nested?.id === 'string' && nested.id ? nested.id : null;
}

/** Ids of the approvals in `list` that are still waiting for an answer. */
export function pendingApprovalIds(list: readonly ApprovalWire[]): Set<string> {
  return new Set(list.filter((a) => a.status === 'pending').map((a) => a.id));
}

/** Drop one approval from a pending list (answered here or resolved elsewhere). */
export function withoutApproval(list: readonly ApprovalWire[], id: string): ApprovalWire[] {
  return list.filter((a) => a.id !== id);
}

/**
 * Reconcile a fetched pending list with ids already known to be settled. An
 * approval never returns to pending once answered, so a list response that
 * was in flight when the answer (or `approval_resolved`) landed must not
 * bring it back.
 */
export function reconcilePendingApprovals(
  list: readonly ApprovalWire[],
  settled: ReadonlySet<string>,
): ApprovalWire[] {
  return sortPendingApprovals(list).filter((a) => !settled.has(a.id));
}

/** Oldest first: the agent is blocked on the earliest request. */
export function sortPendingApprovals(list: readonly ApprovalWire[]): ApprovalWire[] {
  return list.filter((a) => a.status === 'pending').sort((a, b) => a.requestedAt - b.requestedAt);
}

/** "expires in 3h", "expires in 12m", "expires in under a minute". */
export function formatApprovalExpiry(expiresAt: number, now: number = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'expires in under a minute';
  if (minutes < 60) return `expires in ${minutes}m`;
  return `expires in ${Math.floor(minutes / 60)}h`;
}

/** Short headline for a request: "send email to ann@example.com". */
export function describeApproval(a: Pick<ApprovalWire, 'action' | 'target'>): string {
  const target = a.target.length > 140 ? `${a.target.slice(0, 137)}...` : a.target;
  return target ? `${a.action} ${target}` : a.action;
}

/** Confirmation copy after a decision lands. */
export function decisionResultLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allow_once':
      return 'Allowed once';
    case 'always_allow':
      return 'Always allowed';
    case 'deny':
      return 'Denied';
  }
}

/**
 * Error copy for a failed answer. The server answers 409 when the request was
 * already answered, timed out, or the turn was stopped.
 */
export function answerErrorMessage(err: unknown): string {
  const e = err as { status?: unknown; message?: unknown } | null;
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (e?.status === 409 || /already answered|no longer waiting|expired/i.test(msg)) {
    return msg || 'This approval is no longer waiting for an answer.';
  }
  return msg || 'Could not send your answer.';
}

export interface ApprovalRuleGroup {
  profileId: string;
  label: string;
  rules: ApprovalRuleWire[];
}

/**
 * Group remembered rules by browser profile for Settings. Profiles are looked
 * up for a readable "Agent · Project" label; an unknown profile falls back to
 * a generic label rather than hiding its rules.
 */
export function groupApprovalRules(
  rules: readonly ApprovalRuleWire[],
  profiles: ReadonlyArray<{ id: string; agentName: string; projectName: string }>,
): ApprovalRuleGroup[] {
  const names = new Map(profiles.map((p) => [p.id, `${p.agentName} · ${p.projectName}`]));
  const groups = new Map<string, ApprovalRuleGroup>();
  for (const r of rules) {
    let g = groups.get(r.profileId);
    if (!g) {
      g = { profileId: r.profileId, label: names.get(r.profileId) ?? 'Browser profile', rules: [] };
      groups.set(r.profileId, g);
    }
    g.rules.push(r);
  }
  for (const g of groups.values()) {
    g.rules.sort((a, b) => a.domain.localeCompare(b.domain) || a.action.localeCompare(b.action));
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** "Always allow" / "Always ask" for a rule's effect. */
export function ruleEffectLabel(effect: ApprovalRuleWire['effect']): string {
  return effect === 'require' ? 'Always ask' : 'Always allow';
}
