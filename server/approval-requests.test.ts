import './test/setup.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_DIR = '';
vi.mock('./config.js', async (orig) => {
  const actual = (await orig()) as { default: Record<string, unknown> };
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, prop) {
        if (prop === 'dataDir') return TMP_DIR;
        return Reflect.get(target, prop);
      },
    }),
  };
});

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const profiles = await import('./browser-profiles-store.js');
const store = await import('./approvals-store.js');
const ap = await import('./approval-requests.js');

let alice: string;
let bob: string;
let events: Record<string, unknown>[];

function ctx(userId: string | null = alice, sessionId = 'sess-1') {
  return { sessionId, ownerUserId: userId, agentId: 'agent-a', projectId: 'proj-1' };
}

const deps = (extra: Partial<Parameters<typeof ap.runApprovalReActStep>[2]> = {}) => ({
  broadcast: (d: Record<string, unknown>) => events.push(d),
  ...extra,
});

const SEND = { op: 'request', action: 'send', target: 'https://mail.example.com/compose' };

/** Start a request and wait until its row is pending. */
async function startPending(
  input: Parameters<typeof ap.runApprovalReActStep>[0] = SEND,
  c = ctx(),
  extra: Partial<Parameters<typeof ap.runApprovalReActStep>[2]> = {},
) {
  const done = ap.runApprovalReActStep(input, c, deps(extra));
  const req = events.find((e) => e.type === ap.APPROVAL_REQUESTED_EVENT);
  expect(req).toBeDefined();
  const id = (req!.approval as { id: string }).id;
  return { id, done };
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'approvals-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  events = [];
});

afterEach(() => {
  ap.__resetApprovalWaitersForTests();
  vi.useRealTimers();
});

describe('normalizers', () => {
  it('normalizes action verbs', () => {
    expect(ap.normalizeApprovalAction(' Send Email ')).toBe('send_email');
    expect(ap.normalizeApprovalAction('')).toBeNull();
    expect(ap.normalizeApprovalAction('!!')).toBeNull();
    expect(ap.normalizeApprovalAction(42)).toBeNull();
  });

  it('takes the domain from the explicit field or an http(s) target only', () => {
    expect(ap.resolveApprovalDomain('Shop.Example.com', 'anything')).toBe('shop.example.com');
    expect(ap.resolveApprovalDomain(undefined, 'https://x.example.org/a?b')).toBe('x.example.org');
    expect(ap.resolveApprovalDomain(undefined, 'email to bob@example.com')).toBeNull();
  });
});

describe('runApprovalReActStep: answers', () => {
  it('persists a pending row, notifies, and blocks until allow_once', async () => {
    const { id, done } = await startPending();
    const row = store.getApprovalRequest(id)!;
    expect(row).toMatchObject({
      status: 'pending',
      action: 'send',
      domain: 'mail.example.com',
      userId: alice,
    });
    expect(row.expiresAt - row.requestedAt).toBe(ap.APPROVAL_TIMEOUT_MS);

    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    const res = ap.answerApprovalRequest(id, 'allow_once', alice);
    expect(res).toMatchObject({ ok: true, rule: null });
    const out = await done;
    expect(out.hostExit).toBe(0);
    expect(out.hostDetail).toBe('allow_once');
    expect(out.markdown).toContain('allowed `send`');
    expect(store.getApprovalRequest(id)).toMatchObject({
      status: 'allowed',
      resolution: 'allow_once',
      resolvedBy: alice,
    });
    expect(events.map((e) => e.type)).toEqual([
      ap.APPROVAL_REQUESTED_EVENT,
      ap.APPROVAL_RESOLVED_EVENT,
    ]);
    expect(store.listApprovalRulesForUser(alice)).toHaveLength(0);
  });

  it('deny returns a do-not-perform observation', async () => {
    const { id, done } = await startPending();
    expect(ap.answerApprovalRequest(id, 'deny', alice).ok).toBe(true);
    const out = await done;
    expect(out.hostExit).toBe(2);
    expect(out.hostDetail).toBe('deny');
    expect(out.markdown).toContain('denied');
    expect(store.getApprovalRequest(id)).toMatchObject({ status: 'denied', resolution: 'deny' });
  });

  it('always_allow saves a profile + domain + action rule', async () => {
    const { id, done } = await startPending();
    const res = ap.answerApprovalRequest(id, 'always_allow', alice);
    expect(res.ok).toBe(true);
    const out = await done;
    expect(out.hostDetail).toBe('always_allow');
    const rules = store.listApprovalRulesForUser(alice);
    expect(rules).toHaveLength(1);
    const profile = profiles.getBrowserProfile({
      userId: alice,
      agentId: 'agent-a',
      projectId: 'proj-1',
    })!;
    expect(rules[0]).toMatchObject({
      profileId: profile.id,
      domain: 'mail.example.com',
      action: 'send',
      effect: 'allow',
      sourceRequestId: id,
    });
    expect(store.getApprovalRequest(id)!.ruleId).toBe(rules[0]!.id);
  });

  it('always_allow without a domain allows once and saves nothing', async () => {
    const { id, done } = await startPending({
      op: 'request',
      action: 'send',
      target: 'email to Bob',
    });
    expect(ap.answerApprovalRequest(id, 'always_allow', alice).ok).toBe(true);
    const out = await done;
    expect(out.hostExit).toBe(0);
    expect(out.hostDetail).toBe('always_allow:not_saved');
    expect(store.listApprovalRulesForUser(alice)).toHaveLength(0);
  });

  it('settles once: a second answer is not_pending', async () => {
    const { id, done } = await startPending();
    expect(ap.answerApprovalRequest(id, 'deny', alice).ok).toBe(true);
    expect(ap.answerApprovalRequest(id, 'allow_once', alice)).toMatchObject({
      ok: false,
      code: 'not_pending',
    });
    expect((await done).hostDetail).toBe('deny');
  });
});

describe('runApprovalReActStep: rule matching', () => {
  async function remember() {
    const { id, done } = await startPending();
    ap.answerApprovalRequest(id, 'always_allow', alice);
    await done;
    events = [];
  }

  it('auto-allows a later matching request without notifying', async () => {
    await remember();
    const out = await ap.runApprovalReActStep(SEND, ctx(), deps());
    expect(out.hostDetail).toBe('auto_allowed');
    expect(out.hostExit).toBe(0);
    expect(out.approval).toMatchObject({ status: 'allowed', resolution: 'auto_allowed' });
    expect(events).toHaveLength(0);
  });

  it('does not match a different action, domain, or user', async () => {
    await remember();
    const other = [
      { input: { ...SEND, action: 'delete' }, c: ctx() },
      { input: { ...SEND, target: 'https://other.example.com' }, c: ctx() },
      { input: SEND, c: ctx(bob, 'sess-2') },
    ];
    for (const { input, c } of other) {
      events = [];
      const { id, done } = await startPending(input, c);
      expect(store.getApprovalRequest(id)!.status).toBe('pending');
      ap.answerApprovalRequest(id, 'deny', c.ownerUserId);
      await done;
    }
  });

  it('a require rule beats an allow rule', async () => {
    await remember();
    const profile = profiles.getBrowserProfile({
      userId: alice,
      agentId: 'agent-a',
      projectId: 'proj-1',
    })!;
    store.saveApprovalRule({
      profileId: profile.id,
      userId: alice,
      domain: 'mail.example.com',
      action: 'send',
      effect: 'require',
    });
    const { id, done } = await startPending();
    expect(store.getApprovalRequest(id)!.status).toBe('pending');
    ap.answerApprovalRequest(id, 'allow_once', alice);
    expect((await done).hostDetail).toBe('allow_once');
  });

  it('deleting the rule makes the next request ask again', async () => {
    await remember();
    const [rule] = store.listApprovalRulesForUser(alice);
    expect(store.deleteApprovalRuleForUser(bob, rule!.id)).toBe(false);
    expect(store.deleteApprovalRuleForUser(alice, rule!.id)).toBe(true);
    const { id, done } = await startPending();
    expect(store.getApprovalRequest(id)!.status).toBe('pending');
    ap.answerApprovalRequest(id, 'deny', alice);
    await done;
  });
});

describe('runApprovalReActStep: timeout, stop, validation', () => {
  it('denies after the timeout and tells the agent', async () => {
    vi.useFakeTimers();
    const { id, done } = await startPending(SEND, ctx(), { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const out = await done;
    expect(out.hostExit).toBe(2);
    expect(out.hostDetail).toBe('timeout');
    expect(out.markdown).toContain('Do not perform it');
    expect(store.getApprovalRequest(id)).toMatchObject({ status: 'denied', resolution: 'timeout' });
    expect(ap.answerApprovalRequest(id, 'allow_once', alice)).toMatchObject({
      ok: false,
      code: 'not_pending',
    });
  });

  it('defaults to a 24h timeout', () => {
    expect(ap.APPROVAL_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('Stop releases the wait as aborted', async () => {
    const { id, done } = await startPending();
    expect(ap.abortApprovalsForSession('other-session', 'stopped')).toBe(0);
    expect(ap.abortApprovalsForSession('sess-1', 'stopped')).toBe(1);
    const out = await done;
    expect(out.hostExit).toBe(1);
    expect(out.hostDetail).toBe('aborted:stopped');
    expect(store.getApprovalRequest(id)).toMatchObject({
      status: 'cancelled',
      resolution: 'aborted',
    });
  });

  it('does not open a request when the turn was already stopped', async () => {
    const out = await ap.runApprovalReActStep(SEND, ctx(), deps({ isCancelled: () => true }));
    expect(out.hostDetail).toBe('cancelled_before_request');
    expect(events).toHaveLength(0);
    expect(store.listApprovalRequestsForUser(alice)).toHaveLength(0);
  });

  it('rejects missing action, missing target, and a bad domain', async () => {
    const bad = [
      [{ op: 'request', target: 'x' }, 'bad_action'],
      [{ op: 'request', action: 'send', target: '  ' }, 'bad_target'],
      [{ op: 'request', action: 'send', target: 'x', domain: 'not a host' }, 'bad_domain'],
      [{ op: 'grant', action: 'send', target: 'x' }, 'bad_op'],
    ] as const;
    for (const [input, detail] of bad) {
      const out = await ap.runApprovalReActStep(input, ctx(), deps());
      expect(out).toMatchObject({ hostExit: 1, hostDetail: detail });
    }
  });

  it('an answer for a request with no live turn cancels it', () => {
    const now = Date.now();
    const row = store.insertApprovalRequest({
      sessionId: 'gone',
      userId: alice,
      agentId: 'agent-a',
      projectId: 'proj-1',
      profileId: null,
      action: 'send',
      target: 'x',
      domain: null,
      details: '',
      requestedAt: now,
      expiresAt: now + 1000,
    });
    expect(ap.answerApprovalRequest(row.id, 'allow_once', alice)).toMatchObject({
      ok: false,
      code: 'not_pending',
    });
    expect(store.getApprovalRequest(row.id)!.status).toBe('cancelled');
  });

  it('startup sweep cancels orphaned pending rows', () => {
    const now = Date.now();
    store.insertApprovalRequest({
      sessionId: 's',
      userId: alice,
      agentId: 'agent-a',
      projectId: 'proj-1',
      profileId: null,
      action: 'send',
      target: 'x',
      domain: null,
      details: '',
      requestedAt: now,
      expiresAt: now + 1000,
    });
    expect(store.cancelOrphanedApprovalRequests()).toBe(1);
    expect(store.listApprovalRequestsForUser(alice, { status: 'pending' })).toHaveLength(0);
  });
});

describe('approvalGranted', () => {
  it('is true only for allowed outcomes', async () => {
    const allowed = startPending();
    const a = await allowed;
    ap.answerApprovalRequest(a.id, 'allow_once', alice);
    expect(ap.approvalGranted(await a.done)).toBe(true);

    events = [];
    const d = await startPending();
    ap.answerApprovalRequest(d.id, 'deny', alice);
    expect(ap.approvalGranted(await d.done)).toBe(false);

    const bad = await ap.runApprovalReActStep({ op: 'request', target: 'x' }, ctx(), deps());
    expect(ap.approvalGranted(bad)).toBe(false);
  });
});
