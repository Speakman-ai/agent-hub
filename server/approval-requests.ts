/**
 * Agent-declared approvals: the ReAct op `{tool:'approval', op:'request'}`
 * parks the turn until the session owner answers Allow once, Always allow or
 * Deny, the 24h timeout denies it, or the user stops the turn.
 *
 * Rows persist in `approval_requests` (audit trail, inbox, REST). The wait is
 * in memory: an answer is only meaningful while the turn awaiting it is
 * alive, and a Hub restart kills that turn, so startup cancels leftover
 * pending rows (`cancelOrphanedApprovalRequests`).
 *
 * Always allow saves a rule keyed on (browser profile, domain, action); a
 * later matching request resolves at once without asking. A `require` rule
 * on the same key always asks.
 */
import { normalizeBrowserLoginDomain } from './browser-login-handoff.js';
import { getBrowserProfile, getOrCreateBrowserProfile } from './browser-profiles-store.js';
import {
  findApprovalRule,
  getApprovalRequest,
  insertApprovalRequest,
  saveApprovalRule,
  settleApprovalRequest,
  type ApprovalRequest,
  type ApprovalRule,
} from './approvals-store.js';
import { activeServerProfileKey } from './desktop/server-profile-scope.js';

export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_TARGET_MAX_CHARS = 500;
export const APPROVAL_DETAILS_MAX_CHARS = 2000;
export const APPROVAL_REQUESTED_EVENT = 'approval_requested';
export const APPROVAL_RESOLVED_EVENT = 'approval_resolved';
export const APPROVAL_DECISIONS = ['allow_once', 'always_allow', 'deny'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalDecision(v: unknown): v is ApprovalDecision {
  return typeof v === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(v);
}

/** `Send Email` → `send_email`. Null when nothing usable is left. */
export function normalizeApprovalAction(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '_');
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(v) ? v : null;
}

/**
 * The site a request is about: the explicit `domain`, else the host of a
 * `target` that is an http(s) URL. Free-text targets ("email to Bob") have
 * no domain, so no rule can be remembered for them.
 */
export function resolveApprovalDomain(domain: unknown, target: string): string | null {
  if (typeof domain === 'string' && domain.trim()) return normalizeBrowserLoginDomain(domain);
  if (/^https?:\/\//i.test(target.trim())) return normalizeBrowserLoginDomain(target.trim());
  return null;
}

export interface ApprovalContext {
  sessionId: string;
  ownerUserId: string | null;
  agentId: string;
  agentName?: string | null;
  projectId: string | null;
  sessionName?: string | null;
}

export interface ApprovalDeps {
  broadcast?: (data: Record<string, unknown>) => void;
  /** A Stop already landed for this turn. */
  isCancelled?: () => boolean;
  timeoutMs?: number;
  now?: () => number;
}

export interface ApprovalReActInput {
  op: string;
  action?: string;
  target?: string;
  details?: string;
  domain?: string;
}

export interface ApprovalStepOutcome {
  markdown: string;
  hostExit: number;
  hostDetail: string;
  approval?: ApprovalRequest;
}

interface Wake {
  approval: ApprovalRequest;
  rule?: ApprovalRule | null;
  detail?: string;
}

interface Waiter {
  sessionId: string;
  wake: (w: Wake) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Map<string, Waiter>();

function release(id: string, w: Wake): boolean {
  const waiter = waiters.get(id);
  if (!waiter) return false;
  waiters.delete(id);
  clearTimeout(waiter.timer);
  waiter.wake(w);
  return true;
}

export function hasLiveApprovalWaiter(id: string): boolean {
  return waiters.has(id);
}

/** Summary for broadcasts, notifications and REST. */
export function serializeApproval(a: ApprovalRequest) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    agentId: a.agentId,
    projectId: a.projectId,
    action: a.action,
    target: a.target,
    domain: a.domain,
    details: a.details,
    status: a.status,
    resolution: a.resolution,
    ruleId: a.ruleId,
    canRemember: canRemember(a),
    requestedAt: a.requestedAt,
    expiresAt: a.expiresAt,
    resolvedAt: a.resolvedAt,
  };
}

function canRemember(a: ApprovalRequest): boolean {
  return !!(a.domain && a.userId && a.projectId);
}

/** Stop / autopilot unstick: end every wait in this session without an answer. */
export function abortApprovalsForSession(sessionId: string, detail: string): number {
  let n = 0;
  for (const [id, w] of Array.from(waiters)) {
    if (w.sessionId !== sessionId) continue;
    const settled = settleApprovalRequest(id, { status: 'cancelled', resolution: 'aborted' });
    if (release(id, { approval: settled ?? getApprovalRequest(id)!, detail })) n++;
  }
  return n;
}

export type AnswerApprovalResult =
  | { ok: true; approval: ApprovalRequest; rule: ApprovalRule | null }
  | { ok: false; code: 'not_found' | 'not_pending' | 'expired'; approval?: ApprovalRequest };

/**
 * Apply a human's answer. The caller has already checked the actor may
 * answer this request.
 */
export function answerApprovalRequest(
  id: string,
  decision: ApprovalDecision,
  actorUserId: string | null,
  now: number = Date.now(),
): AnswerApprovalResult {
  const current = getApprovalRequest(id);
  if (!current) return { ok: false, code: 'not_found' };
  if (current.status !== 'pending') return { ok: false, code: 'not_pending', approval: current };
  if (!waiters.has(id)) {
    // Its turn is gone (restart, other process): nothing would act on it.
    const gone = settleApprovalRequest(id, { status: 'cancelled', resolution: 'aborted' }, now);
    return { ok: false, code: 'not_pending', approval: gone ?? current };
  }
  if (current.expiresAt <= now) {
    const expired = settleApprovalRequest(id, { status: 'denied', resolution: 'timeout' }, now);
    if (expired) release(id, { approval: expired });
    return { ok: false, code: 'expired', approval: expired ?? current };
  }

  let rule: ApprovalRule | null = null;
  if (decision === 'always_allow' && canRemember(current)) {
    const profile = getOrCreateBrowserProfile(
      activeServerProfileKey({
        userId: current.userId!,
        agentId: current.agentId,
        projectId: current.projectId!,
      }),
    );
    rule = saveApprovalRule({
      profileId: profile.id,
      userId: current.userId!,
      domain: current.domain!,
      action: current.action,
      sourceRequestId: current.id,
    });
  }
  const settled = settleApprovalRequest(
    id,
    {
      status: decision === 'deny' ? 'denied' : 'allowed',
      resolution: decision,
      resolvedBy: actorUserId,
      ruleId: rule?.id ?? null,
    },
    now,
  );
  if (!settled) {
    return { ok: false, code: 'not_pending', approval: getApprovalRequest(id) ?? current };
  }
  release(id, { approval: settled, rule });
  return { ok: true, approval: settled, rule };
}

function existingProfileId(ctx: ApprovalContext): string | null {
  if (!ctx.ownerUserId || !ctx.projectId) return null;
  try {
    return (
      getBrowserProfile(
        activeServerProfileKey({
          userId: ctx.ownerUserId,
          agentId: ctx.agentId,
          projectId: ctx.projectId,
        }),
      )?.id ?? null
    );
  } catch {
    return null;
  }
}

function describe(a: Pick<ApprovalRequest, 'action' | 'target'>): string {
  return `\`${a.action}\` on ${a.target}`;
}

function body(lines: string[]): string {
  return ['## Approval', '', ...lines].join('\n');
}

export function approvalObservation(w: Wake, timeoutMs: number): ApprovalStepOutcome {
  const a = w.approval;
  const what = describe(a);
  switch (a.resolution) {
    case 'allow_once':
      return {
        markdown: body([
          `The human allowed ${what}. Do exactly that action once. Request approval again for any other irreversible action.`,
        ]),
        hostExit: 0,
        hostDetail: 'allow_once',
        approval: a,
      };
    case 'always_allow':
      return {
        markdown: body([
          w.rule
            ? `The human allowed ${what} and saved a rule: \`${a.action}\` on ${a.domain} is allowed from now on without asking. Go ahead.`
            : `The human allowed ${what}. They chose Always allow, but this request has no site to remember it for, so the next one will ask again. Go ahead with this one.`,
        ]),
        hostExit: 0,
        hostDetail: w.rule ? 'always_allow' : 'always_allow:not_saved',
        approval: a,
      };
    case 'auto_allowed':
      return {
        markdown: body([
          `A saved rule allows \`${a.action}\` on ${a.domain}, so ${what} is approved without asking. Go ahead.`,
        ]),
        hostExit: 0,
        hostDetail: 'auto_allowed',
        approval: a,
      };
    case 'deny':
      return {
        markdown: body([
          `The human denied ${what}. Do not perform it, retry it, or find another way to do it. Tell them in chat what you did not do and continue with anything that does not need it.`,
        ]),
        hostExit: 2,
        hostDetail: 'deny',
        approval: a,
      };
    case 'timeout':
      return {
        markdown: body([
          `Nobody answered the approval for ${what} within ${Math.round(timeoutMs / 3_600_000) || 1} hour(s), so it was denied. Do not perform it. Tell the human in chat that the task is waiting on this approval.`,
        ]),
        hostExit: 2,
        hostDetail: 'timeout',
        approval: a,
      };
    default:
      return {
        markdown: body([
          `The approval request for ${what} ended (${w.detail ?? 'cancelled'}) before anyone answered. Do not perform it.`,
        ]),
        hostExit: 1,
        hostDetail: `aborted:${w.detail ?? 'unknown'}`,
        approval: a,
      };
  }
}

/**
 * Whether the agent may go on to the action it asked about. Anything else
 * (denied, timed out, stopped, malformed) must stop the actions queued after
 * the request in the same batch.
 */
export function approvalGranted(outcome: ApprovalStepOutcome): boolean {
  return outcome.hostExit === 0 && outcome.approval?.status === 'allowed';
}

function errorOutcome(text: string, detail: string): ApprovalStepOutcome {
  return { markdown: `## Approval tool error\n${text}`, hostExit: 1, hostDetail: detail };
}

/** Run one `approval` ReAct action. Resolves when the request settles. */
export async function runApprovalReActStep(
  input: ApprovalReActInput,
  ctx: ApprovalContext,
  deps: ApprovalDeps = {},
): Promise<ApprovalStepOutcome> {
  if (input.op !== 'request') {
    return errorOutcome('Unsupported approval op; use "request".', 'bad_op');
  }
  const action = normalizeApprovalAction(input.action);
  if (!action) {
    return errorOutcome(
      'approval request needs `action`: a short verb such as "send", "submit", "delete", "purchase" or "publish".',
      'bad_action',
    );
  }
  const target = (input.target ?? '').trim().slice(0, APPROVAL_TARGET_MAX_CHARS);
  if (!target) {
    return errorOutcome(
      'approval request needs `target`: what the action affects, e.g. a URL, a recipient or a record.',
      'bad_target',
    );
  }
  if (input.domain?.trim() && !normalizeBrowserLoginDomain(input.domain)) {
    return errorOutcome('approval request `domain` is not a valid hostname.', 'bad_domain');
  }
  if (deps.isCancelled?.()) {
    return {
      markdown: body([
        `Approval for \`${action}\` on ${target} was not requested: the user stopped this turn. Do not perform it.`,
      ]),
      hostExit: 1,
      hostDetail: 'cancelled_before_request',
    };
  }

  const now = deps.now?.() ?? Date.now();
  const timeoutMs = Math.max(1, deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  const domain = resolveApprovalDomain(input.domain, target);
  const profileId = domain ? existingProfileId(ctx) : null;
  const details = (input.details ?? '').trim().slice(0, APPROVAL_DETAILS_MAX_CHARS);
  const base = {
    sessionId: ctx.sessionId,
    userId: ctx.ownerUserId,
    agentId: ctx.agentId,
    projectId: ctx.projectId,
    profileId,
    action,
    target,
    domain,
    details,
    requestedAt: now,
    expiresAt: now + timeoutMs,
  };

  const rule = profileId && domain ? findApprovalRule({ profileId, domain, action }) : null;
  if (rule?.effect === 'allow') {
    const approval = insertApprovalRequest({ ...base, autoAllowedByRuleId: rule.id });
    return approvalObservation({ approval, rule }, timeoutMs);
  }

  const approval = insertApprovalRequest(base);
  return approvalObservation(await waitForAnswer(approval, ctx, deps, timeoutMs), timeoutMs);
}

/** Park until a pending request settles, broadcasting it open and closed. */
async function waitForAnswer(
  approval: ApprovalRequest,
  ctx: ApprovalContext,
  deps: ApprovalDeps,
  timeoutMs: number,
): Promise<Wake> {
  const settled = new Promise<Wake>((resolve) => {
    const timer = setTimeout(() => {
      const timedOut = settleApprovalRequest(approval.id, {
        status: 'denied',
        resolution: 'timeout',
      });
      release(approval.id, { approval: timedOut ?? getApprovalRequest(approval.id)! });
    }, timeoutMs);
    timer.unref?.();
    waiters.set(approval.id, { sessionId: ctx.sessionId, wake: resolve, timer });
  });

  try {
    deps.broadcast?.({
      type: APPROVAL_REQUESTED_EVENT,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      agentName: ctx.agentName ?? undefined,
      projectId: ctx.projectId ?? undefined,
      sessionName: ctx.sessionName ?? undefined,
      ownerUserId: ctx.ownerUserId ?? undefined,
      approval: serializeApproval(approval),
    });
  } catch (err) {
    console.warn(`[approval] request broadcast failed: ${String(err)}`);
  }

  const wake = await settled;
  try {
    deps.broadcast?.({
      type: APPROVAL_RESOLVED_EVENT,
      sessionId: ctx.sessionId,
      ownerUserId: ctx.ownerUserId ?? undefined,
      approvalId: wake.approval.id,
      status: wake.approval.status,
      resolution: wake.approval.resolution,
    });
  } catch (err) {
    console.warn(`[approval] resolve broadcast failed: ${String(err)}`);
  }
  return wake;
}

export interface HostApprovalInput {
  /** Null when the owner has no browser profile yet (nothing to key a rule on). */
  profileId: string | null;
  /** Browser or computer op being gated, e.g. `click`. */
  action: string;
  /** Page URL or desktop target the op would act on. */
  target: string;
  /** Null makes the request unrememberable: Always allow saves no rule. */
  domain: string | null;
  details: string;
}

/**
 * Raise an approval on the agent's behalf: a domain policy gate found a
 * mutating op that needs a human's yes. Same lifecycle as an agent-declared
 * request (notification, 24h timeout, Stop). Resolves with the settled row.
 */
export async function requestHostApproval(
  input: HostApprovalInput,
  ctx: ApprovalContext,
  deps: ApprovalDeps = {},
): Promise<ApprovalRequest> {
  const now = deps.now?.() ?? Date.now();
  const timeoutMs = Math.max(1, deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  const approval = insertApprovalRequest({
    sessionId: ctx.sessionId,
    userId: ctx.ownerUserId,
    agentId: ctx.agentId,
    projectId: ctx.projectId,
    profileId: input.profileId,
    action: input.action,
    target: input.target.slice(0, APPROVAL_TARGET_MAX_CHARS),
    domain: input.domain,
    details: input.details.slice(0, APPROVAL_DETAILS_MAX_CHARS),
    requestedAt: now,
    expiresAt: now + timeoutMs,
  });
  return (await waitForAnswer(approval, ctx, deps, timeoutMs)).approval;
}

/** Test-only. */
export function __resetApprovalWaitersForTests(): void {
  for (const [id, w] of Array.from(waiters)) {
    clearTimeout(w.timer);
    waiters.delete(id);
  }
}
