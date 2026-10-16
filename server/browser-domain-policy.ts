/**
 * Host-enforced domain policy for agent browser ops. Each browser profile
 * can mark sites `allow`, `ask` or `block`:
 *
 *   - block: the agent may not open the site or click / type on it.
 *   - ask:   click / type raise an approval first, unless an always-allow
 *            rule for that exact host and op exists.
 *   - allow: no gate (also the default for sites with no entry).
 *
 * A `require` approval rule beats both `allow` policies and always-allow
 * rules: the op asks every time. This layer runs in the host, so it holds
 * even when the model skips its own `approval` request.
 */
import { normalizeBrowserLoginDomain } from './browser-login-handoff.js';
import { getBrowserProfile } from './browser-profiles-store.js';
import {
  findApprovalRule,
  hasRequireApprovalRule,
  hostWithinDomain,
  type ApprovalRule,
} from './approvals-store.js';
import { hostOfSerializedOrigin } from './browser-page-origin.js';
import {
  requestHostApproval,
  type ApprovalContext,
  type ApprovalDeps,
} from './approval-requests.js';
import { getOrgsDb } from './orgs.js';

export const BROWSER_DOMAIN_POLICIES = ['allow', 'ask', 'block'] as const;
export type BrowserDomainPolicy = (typeof BROWSER_DOMAIN_POLICIES)[number];

/** Ops that change something on the page and so pass through the gate. */
export const GATED_BROWSER_OPS = ['click', 'type'] as const;
export type GatedBrowserOp = (typeof GATED_BROWSER_OPS)[number];

export interface BrowserDomainPolicyEntry {
  domain: string;
  policy: BrowserDomainPolicy;
  createdAt: string;
  updatedAt: string;
}

interface PolicyRow {
  domain: string;
  policy: BrowserDomainPolicy;
  created_at: string;
  updated_at: string;
}

export function isBrowserDomainPolicy(v: unknown): v is BrowserDomainPolicy {
  return typeof v === 'string' && (BROWSER_DOMAIN_POLICIES as readonly string[]).includes(v);
}

export function isGatedBrowserOp(op: string): op is GatedBrowserOp {
  return (GATED_BROWSER_OPS as readonly string[]).includes(op);
}

function toEntry(r: PolicyRow): BrowserDomainPolicyEntry {
  return { domain: r.domain, policy: r.policy, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listBrowserDomainPolicies(profileId: string): BrowserDomainPolicyEntry[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT domain, policy, created_at, updated_at FROM browser_profile_domain_policies
        WHERE profile_id = ? ORDER BY domain`,
    )
    .all(profileId) as PolicyRow[];
  return rows.map(toEntry);
}

/** Upsert. Returns null when `domain` is not a usable hostname. */
export function setBrowserDomainPolicy(
  profileId: string,
  domain: string,
  policy: BrowserDomainPolicy,
): BrowserDomainPolicyEntry | null {
  const host = normalizeBrowserLoginDomain(domain);
  if (!host) return null;
  const db = getOrgsDb();
  db.prepare(
    `INSERT INTO browser_profile_domain_policies (profile_id, domain, policy)
     VALUES (?, ?, ?)
     ON CONFLICT(profile_id, domain)
       DO UPDATE SET policy = excluded.policy, updated_at = datetime('now')`,
  ).run(profileId, host, policy);
  const row = db
    .prepare(
      `SELECT domain, policy, created_at, updated_at FROM browser_profile_domain_policies
        WHERE profile_id = ? AND domain = ?`,
    )
    .get(profileId, host) as PolicyRow;
  return toEntry(row);
}

export function deleteBrowserDomainPolicy(profileId: string, domain: string): boolean {
  const host = normalizeBrowserLoginDomain(domain);
  if (!host) return false;
  return (
    getOrgsDb()
      .prepare(`DELETE FROM browser_profile_domain_policies WHERE profile_id = ? AND domain = ?`)
      .run(profileId, host).changes === 1
  );
}

/** The most specific entry covering `host`, or null when none does. */
export function resolveBrowserDomainPolicy(
  profileId: string,
  host: string,
): BrowserDomainPolicyEntry | null {
  let best: BrowserDomainPolicyEntry | null = null;
  for (const entry of listBrowserDomainPolicies(profileId)) {
    if (!hostWithinDomain(host, entry.domain)) continue;
    if (!best || entry.domain.length > best.domain.length) best = entry;
  }
  return best;
}

export type BrowserGateDecision =
  | { decision: 'allow'; reason: 'no_policy' | 'allow_policy' | 'allow_rule'; rule?: ApprovalRule }
  | { decision: 'block'; policyDomain: string }
  | {
      decision: 'ask';
      reason: 'ask_policy' | 'require_rule';
      policyDomain: string | null;
      rule?: ApprovalRule;
    };

/**
 * What the host does with `action` on `host` for this profile. Order:
 * block policy, then require rule, then ask policy (an exact always-allow
 * rule lets it through), then allow.
 */
export function decideBrowserDomainGate(input: {
  profileId: string;
  host: string;
  action: string;
}): BrowserGateDecision {
  const entry = resolveBrowserDomainPolicy(input.profileId, input.host);
  if (entry?.policy === 'block') return { decision: 'block', policyDomain: entry.domain };
  const rule = findApprovalRule({
    profileId: input.profileId,
    domain: input.host,
    action: input.action,
  });
  if (rule?.effect === 'require') {
    return { decision: 'ask', reason: 'require_rule', policyDomain: entry?.domain ?? null, rule };
  }
  if (entry?.policy === 'ask') {
    if (rule?.effect === 'allow') return { decision: 'allow', reason: 'allow_rule', rule };
    return { decision: 'ask', reason: 'ask_policy', policyDomain: entry.domain };
  }
  return { decision: 'allow', reason: entry ? 'allow_policy' : 'no_policy' };
}

/** What `runBrowserReActStep` hands the gate before running an op. */
export interface BrowserGateRequest {
  op: string;
  /** Page the op acts on (click / type), or the destination (navigate). */
  url: string | null;
  target?: string;
  text?: string;
  /**
   * click / type on a page whose URL names no site (about:blank, data:,
   * blob:): the main frame's effective origin as the browser reports it,
   * `"null"` when opaque, null or absent when it could not be read.
   */
  pageOrigin?: string | null;
}

export type BrowserGateResult =
  | { proceed: true; host: string | null; notice?: string }
  | { proceed: false; markdown: string; hostDetail: string; summary: string; halt: string };

export type BrowserDomainGate = ((req: BrowserGateRequest) => Promise<BrowserGateResult>) & {
  /**
   * The policy domain that blocks `url`, or null. Used for the request-time
   * document deny and the after-op page check, which catch redirects, link
   * clicks and history moves the explicit-URL check cannot see.
   */
  blockedBy?: (url: string) => string | null;
};

const TYPED_TEXT_PREVIEW_CHARS = 120;

/**
 * What `blockedBy` returns when the policy cannot be read. Enforcement fails
 * closed: an unreadable policy is treated as a block, never as "allowed".
 */
export const BROWSER_POLICY_UNAVAILABLE = '*policy-unavailable*';

/** Why a site counts as blocked, for observations. */
export function describeBrowserBlock(by: string): string {
  return by === BROWSER_POLICY_UNAVAILABLE
    ? "the human's browser profile policy could not be read, so the site is treated as blocked"
    : `blocked by the human's browser profile policy (rule on ${by})`;
}

function describeOp(req: BrowserGateRequest): string {
  const target = (req.target ?? '').trim().slice(0, 200) || 'the page';
  if (req.op === 'type') {
    const text = (req.text ?? '').slice(0, TYPED_TEXT_PREVIEW_CHARS);
    const more = (req.text ?? '').length > TYPED_TEXT_PREVIEW_CHARS ? '…' : '';
    return `Type "${text}${more}" into ${target}`;
  }
  return `Click ${target}`;
}

function refusal(
  op: string,
  host: string,
  lines: string[],
  hostDetail: string,
  summary: string,
): BrowserGateResult {
  return {
    proceed: false,
    markdown: [`## Browser: ${op} refused`, '', ...lines].join('\n'),
    hostDetail,
    summary,
    halt: `browser ${op} on ${host} was refused by the domain policy (${hostDetail})`,
  };
}

/**
 * True when some site would not be plainly allowed for `action`: the profile
 * has an ask or block policy, or a require rule covering the action. A page
 * whose site cannot be named only needs a human when this holds.
 */
function profileRestrictsAction(profileId: string, action: string): boolean {
  return (
    listBrowserDomainPolicies(profileId).some((e) => e.policy !== 'allow') ||
    hasRequireApprovalRule(profileId, action)
  );
}

/** Pages whose URL carries no site, so the site must come from the document's origin. */
function urlNamesNoSite(url: string): boolean {
  return !/^https?:/i.test(url.trim());
}

/**
 * Build the gate for one chat turn. Returns undefined when the session has
 * no owner or project: there is no profile, so there is no policy to apply.
 */
export function createBrowserDomainGate(
  ctx: ApprovalContext,
  deps: ApprovalDeps = {},
): BrowserDomainGate | undefined {
  if (!ctx.ownerUserId || !ctx.projectId) return undefined;
  const key = { userId: ctx.ownerUserId, agentId: ctx.agentId, projectId: ctx.projectId };

  const blockedBy = (url: string): string | null => {
    const host = normalizeBrowserLoginDomain(url);
    if (!host) return null;
    try {
      const profileId = getBrowserProfile(key)?.id;
      if (!profileId) return null;
      const entry = resolveBrowserDomainPolicy(profileId, host);
      return entry?.policy === 'block' ? entry.domain : null;
    } catch (err) {
      console.warn(
        `[browser-policy] block lookup failed, treating ${host} as blocked: ${String(err)}`,
      );
      return BROWSER_POLICY_UNAVAILABLE;
    }
  };

  const gate = async (req: BrowserGateRequest): Promise<BrowserGateResult> => {
    const gated = isGatedBrowserOp(req.op);
    const urlHost = req.url ? normalizeBrowserLoginDomain(req.url) : null;
    // about:blank popups and srcdoc frames inherit their creator's origin;
    // data: documents are opaque. Act on them as the creator's site, or ask.
    const fromOrigin =
      !urlHost && gated && req.url && urlNamesNoSite(req.url)
        ? normalizeBrowserLoginDomain(hostOfSerializedOrigin(req.pageOrigin) ?? '')
        : null;
    const host = urlHost ?? fromOrigin;
    if (!host) {
      if (gated && req.url && urlNamesNoSite(req.url)) return unknownOriginGate(req);
      return { proceed: true, host: null };
    }
    const viaOrigin = fromOrigin ? ` (the page ${req.url} belongs to ${host})` : '';
    let profileId: string | null;
    let verdict: BrowserGateDecision;
    try {
      profileId = getBrowserProfile(key)?.id ?? null;
      if (!profileId) return { proceed: true, host };
      verdict = decideBrowserDomainGate({ profileId, host, action: req.op });
    } catch (err) {
      console.warn(`[browser-policy] policy lookup failed, refusing ${req.op}: ${String(err)}`);
      return refusal(
        req.op,
        host,
        [
          `\`${req.op}\` on ${host} was not performed: ${describeBrowserBlock(BROWSER_POLICY_UNAVAILABLE)}. Do not retry it or reach the site another way. Tell the human in chat what you could not do.`,
        ],
        'policy_unavailable',
        `Policy unavailable: ${host}`,
      );
    }

    if (verdict.decision === 'block') {
      return refusal(
        req.op,
        host,
        [
          `${host}${viaOrigin} is ${describeBrowserBlock(verdict.policyDomain)}. Do not open it, act on it, or reach it another way. Tell the human in chat what you could not do.`,
        ],
        'blocked_domain',
        `Blocked: ${host}`,
      );
    }
    if (verdict.decision === 'allow' || !gated) return { proceed: true, host };

    if (deps.isCancelled?.()) {
      return refusal(
        req.op,
        host,
        [`The user stopped this turn before \`${req.op}\` on ${host} could be approved.`],
        'cancelled_before_request',
        'Stopped',
      );
    }
    const why =
      verdict.reason === 'require_rule'
        ? `A require-approval rule on ${verdict.rule?.domain ?? host} applies.`
        : `The browser profile policy for ${verdict.policyDomain} is "ask".`;
    const approval = await requestHostApproval(
      {
        profileId,
        action: req.op,
        target: req.url!,
        domain: host,
        details: `${describeOp(req)}${viaOrigin}. ${why}`,
      },
      ctx,
      deps,
    );
    if (approval.status === 'allowed') {
      // The wait can be long: the human may have blocked the site meanwhile.
      const nowBlockedBy = blockedBy(`https://${host}/`);
      if (nowBlockedBy) {
        return refusal(
          req.op,
          host,
          [
            `\`${req.op}\` on ${host} was approved, but the site is now ${describeBrowserBlock(nowBlockedBy)}, so it was not performed. Do not open, act on, or reach it another way. Tell the human in chat what you could not do.`,
          ],
          'blocked_domain',
          `Blocked: ${host}`,
        );
      }
      return {
        proceed: true,
        host,
        notice: `Host approval: the human allowed \`${req.op}\` on ${host} (${approval.resolution}).`,
      };
    }
    const outcome =
      approval.resolution === 'deny'
        ? 'the human denied it'
        : approval.resolution === 'timeout'
          ? 'nobody answered within 24 hours, so it was denied'
          : 'the request ended before anyone answered';
    return refusal(
      req.op,
      host,
      [
        `\`${req.op}\` on ${host} needs the human's approval (${why}) and ${outcome}. It was not performed. Do not retry it or find another way to do it. Tell the human in chat what you did not do.`,
      ],
      `approval_${approval.resolution ?? 'unknown'}`,
      `Not approved: ${req.op} on ${host}`,
    );
  };
  /**
   * click / type on a document whose site the host cannot name. If the
   * profile would allow the op everywhere, nothing is lost by proceeding;
   * otherwise the page might belong to an ask or block site, so ask. The
   * approval carries no domain, so it can never be saved as a rule.
   */
  const unknownOriginGate = async (req: BrowserGateRequest): Promise<BrowserGateResult> => {
    const page = req.url!.slice(0, 200);
    const where = `a page with no site the host can identify (${page})`;
    let profileId: string | null;
    try {
      profileId = getBrowserProfile(key)?.id ?? null;
      if (!profileId || !profileRestrictsAction(profileId, req.op)) {
        return { proceed: true, host: null };
      }
    } catch (err) {
      console.warn(`[browser-policy] policy lookup failed, refusing ${req.op}: ${String(err)}`);
      return refusal(
        req.op,
        where,
        [
          `\`${req.op}\` on ${where} was not performed: ${describeBrowserBlock(BROWSER_POLICY_UNAVAILABLE)}. Do not retry it or reach the site another way. Tell the human in chat what you could not do.`,
        ],
        'policy_unavailable',
        'Policy unavailable',
      );
    }
    if (deps.isCancelled?.()) {
      return refusal(
        req.op,
        where,
        [`The user stopped this turn before \`${req.op}\` on ${where} could be approved.`],
        'cancelled_before_request',
        'Stopped',
      );
    }
    const why =
      'Its origin is inherited from the site that opened it, or opaque, and could not be resolved, so the browser profile policy cannot be checked.';
    const approval = await requestHostApproval(
      {
        profileId,
        action: req.op,
        target: req.url!,
        domain: null,
        details: `${describeOp(req)} on ${where}. ${why}`,
      },
      ctx,
      deps,
    );
    if (approval.status === 'allowed') {
      return {
        proceed: true,
        host: null,
        notice: `Host approval: the human allowed \`${req.op}\` on ${where} (${approval.resolution}).`,
      };
    }
    const outcome =
      approval.resolution === 'deny'
        ? 'the human denied it'
        : approval.resolution === 'timeout'
          ? 'nobody answered within 24 hours, so it was denied'
          : 'the request ended before anyone answered';
    return refusal(
      req.op,
      where,
      [
        `\`${req.op}\` on ${where} needs the human's approval (${why}) and ${outcome}. It was not performed. Do not retry it or find another way to do it. Tell the human in chat what you did not do.`,
      ],
      `approval_${approval.resolution ?? 'unknown'}`,
      `Not approved: ${req.op} on an unidentified page`,
    );
  };

  return Object.assign(gate, { blockedBy });
}
