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

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { installContextFetchGuard } = await import('./browser-context-fetch-guard.js');
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const profiles = await import('./browser-profiles-store.js');
const rules = await import('./approvals-store.js');
const ap = await import('./approval-requests.js');
const policy = await import('./browser-domain-policy.js');
const { runBrowserReActStep } = await import('./browser-tools.js');
const browserRegistry = await import('./browser.js');

let alice: string;
let profileId: string;
let events: Record<string, unknown>[];

const ctx = () => ({
  sessionId: 'sess-1',
  ownerUserId: alice,
  agentId: 'agent-a',
  projectId: 'proj-1',
});
const deps = () => ({ broadcast: (d: Record<string, unknown>) => events.push(d) });

function decide(host: string, action = 'click') {
  return policy.decideBrowserDomainGate({ profileId, host, action });
}

function rule(domain: string, action: string, effect: 'allow' | 'require') {
  return rules.saveApprovalRule({ profileId, userId: alice, domain, action, effect });
}

/** The approval the gate just raised (it broadcasts synchronously before parking). */
function raisedApprovalId(): string {
  const ev = events.find((e) => e.type === ap.APPROVAL_REQUESTED_EVENT);
  expect(ev).toBeDefined();
  return (ev!.approval as { id: string }).id;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'domain-policy-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  profileId = profiles.getOrCreateBrowserProfile({
    userId: alice,
    agentId: 'agent-a',
    projectId: 'proj-1',
  }).id;
  events = [];
});

afterEach(() => {
  ap.__resetApprovalWaitersForTests();
});

describe('domain policy store', () => {
  it('normalizes the domain, upserts and deletes', () => {
    expect(
      policy.setBrowserDomainPolicy(profileId, 'https://Shop.Example.com/cart', 'ask'),
    ).toMatchObject({ domain: 'shop.example.com', policy: 'ask' });
    policy.setBrowserDomainPolicy(profileId, 'shop.example.com', 'block');
    expect(policy.listBrowserDomainPolicies(profileId)).toEqual([
      expect.objectContaining({ domain: 'shop.example.com', policy: 'block' }),
    ]);
    expect(policy.setBrowserDomainPolicy(profileId, 'not a host', 'ask')).toBeNull();
    expect(policy.deleteBrowserDomainPolicy(profileId, 'shop.example.com')).toBe(true);
    expect(policy.deleteBrowserDomainPolicy(profileId, 'shop.example.com')).toBe(false);
  });

  it('goes away with its profile', () => {
    policy.setBrowserDomainPolicy(profileId, 'example.com', 'block');
    profiles.deleteBrowserProfile({ userId: alice, agentId: 'agent-a', projectId: 'proj-1' });
    expect(policy.listBrowserDomainPolicies(profileId)).toEqual([]);
  });

  it('covers subdomains and lets the most specific entry win', () => {
    policy.setBrowserDomainPolicy(profileId, 'example.com', 'block');
    policy.setBrowserDomainPolicy(profileId, 'docs.example.com', 'allow');
    expect(policy.resolveBrowserDomainPolicy(profileId, 'mail.example.com')?.policy).toBe('block');
    expect(policy.resolveBrowserDomainPolicy(profileId, 'a.docs.example.com')?.policy).toBe(
      'allow',
    );
    expect(policy.resolveBrowserDomainPolicy(profileId, 'notexample.com')).toBeNull();
  });
});

describe('decideBrowserDomainGate', () => {
  it('allows sites with no policy and allow-policy sites', () => {
    expect(decide('example.com')).toEqual({ decision: 'allow', reason: 'no_policy' });
    policy.setBrowserDomainPolicy(profileId, 'example.com', 'allow');
    expect(decide('example.com')).toEqual({ decision: 'allow', reason: 'allow_policy' });
  });

  it('blocks block-policy sites and their subdomains', () => {
    policy.setBrowserDomainPolicy(profileId, 'bank.com', 'block');
    expect(decide('www.bank.com')).toEqual({ decision: 'block', policyDomain: 'bank.com' });
  });

  it('asks on ask-policy sites', () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    expect(decide('shop.com', 'type')).toMatchObject({ decision: 'ask', reason: 'ask_policy' });
  });

  it('lets an exact always-allow rule through an ask policy, for that op only', () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    rule('shop.com', 'click', 'allow');
    expect(decide('shop.com', 'click')).toMatchObject({ decision: 'allow', reason: 'allow_rule' });
    expect(decide('shop.com', 'type').decision).toBe('ask');
    // allow rules never spread to subdomains
    expect(decide('www.shop.com', 'click').decision).toBe('ask');
  });

  it('require rule beats always-allow', () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    rule('shop.com', 'click', 'allow');
    rule('shop.com', 'click', 'require');
    expect(decide('shop.com', 'click')).toMatchObject({
      decision: 'ask',
      reason: 'require_rule',
    });
  });

  it('require rule asks even on an allow-policy or unlisted site', () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'allow');
    rule('shop.com', 'type', 'require');
    expect(decide('shop.com', 'type').decision).toBe('ask');
    rule('other.com', 'click', 'require');
    expect(decide('other.com', 'click').decision).toBe('ask');
  });

  it('require rule covers subdomains and "*" covers every op', () => {
    rule('bank.com', '*', 'require');
    expect(decide('login.bank.com', 'click').decision).toBe('ask');
    expect(decide('login.bank.com', 'type').decision).toBe('ask');
  });

  it('block beats a require rule', () => {
    policy.setBrowserDomainPolicy(profileId, 'bank.com', 'block');
    rule('bank.com', 'click', 'require');
    expect(decide('bank.com').decision).toBe('block');
  });
});

describe('agent-declared approvals respect require rules', () => {
  it('a parent-domain require rule stops an exact allow rule from auto-allowing', async () => {
    rule('mail.example.com', 'send', 'allow');
    rule('example.com', 'send', 'require');
    const done = ap.runApprovalReActStep(
      { op: 'request', action: 'send', target: 'https://mail.example.com/compose' },
      ctx(),
      deps(),
    );
    const id = raisedApprovalId();
    ap.answerApprovalRequest(id, 'deny', alice);
    expect((await done).hostDetail).toBe('deny');
  });
});

describe('createBrowserDomainGate', () => {
  const gate = () => policy.createBrowserDomainGate(ctx(), deps())!;

  it('is absent for sessions with no owner or project', () => {
    expect(policy.createBrowserDomainGate({ ...ctx(), ownerUserId: null })).toBeUndefined();
    expect(policy.createBrowserDomainGate({ ...ctx(), projectId: null })).toBeUndefined();
  });

  it('lets everything through when the profile does not exist yet', async () => {
    const g = policy.createBrowserDomainGate({ ...ctx(), agentId: 'agent-new' })!;
    policy.setBrowserDomainPolicy(profileId, 'bank.com', 'block');
    expect(await g({ op: 'click', url: 'https://bank.com/' })).toMatchObject({ proceed: true });
  });

  it('refuses navigate, click and type on a blocked site and halts the batch', async () => {
    policy.setBrowserDomainPolicy(profileId, 'bank.com', 'block');
    for (const op of ['navigate', 'click', 'type']) {
      const r = await gate()({ op, url: 'https://www.bank.com/pay', target: '#go' });
      expect(r).toMatchObject({ proceed: false, hostDetail: 'blocked_domain' });
      if (!r.proceed) {
        expect(r.markdown).toContain('blocked');
        expect(r.halt).toContain('www.bank.com');
      }
    }
    expect(events).toEqual([]);
  });

  it('does not ask for navigate on an ask site, and ignores pages with no host', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    expect(await gate()({ op: 'navigate', url: 'https://shop.com/' })).toMatchObject({
      proceed: true,
    });
    expect(await gate()({ op: 'click', url: 'about:blank' })).toMatchObject({ proceed: true });
    expect(events).toEqual([]);
  });

  it('raises an approval on an ask site and proceeds on allow once', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const pending = gate()({
      op: 'type',
      url: 'https://shop.com/checkout',
      target: '#card',
      text: 'hi',
    });
    const id = raisedApprovalId();
    const row = rules.getApprovalRequest(id)!;
    expect(row).toMatchObject({
      action: 'type',
      domain: 'shop.com',
      profileId,
      target: 'https://shop.com/checkout',
      status: 'pending',
    });
    expect(row.details).toContain('"hi"');
    ap.answerApprovalRequest(id, 'allow_once', alice);
    const r = await pending;
    expect(r).toMatchObject({ proceed: true, host: 'shop.com' });
    if (r.proceed) expect(r.notice).toContain('allow_once');
  });

  it('refuses and halts when the human denies', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const pending = gate()({ op: 'click', url: 'https://shop.com/buy', target: '#buy' });
    ap.answerApprovalRequest(raisedApprovalId(), 'deny', alice);
    const r = await pending;
    expect(r).toMatchObject({ proceed: false, hostDetail: 'approval_deny' });
    if (!r.proceed) expect(r.markdown).toContain('denied');
  });

  it('times out to a refusal', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const g = policy.createBrowserDomainGate(ctx(), { ...deps(), timeoutMs: 5 })!;
    const r = await g({ op: 'click', url: 'https://shop.com/buy' });
    expect(r).toMatchObject({ proceed: false, hostDetail: 'approval_timeout' });
  });

  it('always allow remembers the op so the next one runs without asking', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const first = gate()({ op: 'click', url: 'https://shop.com/a' });
    ap.answerApprovalRequest(raisedApprovalId(), 'always_allow', alice);
    expect(await first).toMatchObject({ proceed: true });
    events = [];
    expect(await gate()({ op: 'click', url: 'https://shop.com/b' })).toMatchObject({
      proceed: true,
    });
    expect(events).toEqual([]);
  });

  it('keeps asking under a require rule even after always allow', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    rule('shop.com', 'click', 'require');
    const first = gate()({ op: 'click', url: 'https://shop.com/a' });
    ap.answerApprovalRequest(raisedApprovalId(), 'always_allow', alice);
    expect(await first).toMatchObject({ proceed: true });
    events = [];
    const second = gate()({ op: 'click', url: 'https://shop.com/b' });
    const id = raisedApprovalId();
    ap.answerApprovalRequest(id, 'deny', alice);
    expect(await second).toMatchObject({ proceed: false });
  });

  it('does not raise an approval after Stop', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const g = policy.createBrowserDomainGate(ctx(), { ...deps(), isCancelled: () => true })!;
    expect(await g({ op: 'click', url: 'https://shop.com/' })).toMatchObject({
      proceed: false,
      hostDetail: 'cancelled_before_request',
    });
    expect(events).toEqual([]);
  });

  it('blockedBy reports the policy domain for blocked URLs only', () => {
    policy.setBrowserDomainPolicy(profileId, 'bank.com', 'block');
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const g = gate();
    expect(g.blockedBy!('https://login.bank.com/x')).toBe('bank.com');
    expect(g.blockedBy!('https://shop.com/')).toBeNull();
    expect(g.blockedBy!('about:blank')).toBeNull();
  });

  it('refuses an approved op when the site was blocked while the approval was pending', async () => {
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');
    const pending = gate()({ op: 'click', url: 'https://shop.com/buy', target: '#buy' });
    const id = raisedApprovalId();
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'block');
    ap.answerApprovalRequest(id, 'allow_once', alice);
    expect(await pending).toMatchObject({ proceed: false, hostDetail: 'blocked_domain' });
  });
});

describe('runBrowserReActStep with the real gate', () => {
  afterEach(() => browserRegistry.__resetBrowserRegistryForTests());

  it('does not click when Ask becomes Block before the pending approval is allowed', async () => {
    let url = 'https://shop.com/buy';
    const click = vi.fn(async () => {});
    const page = {
      url: () => url,
      goto: vi.fn(async (u: string) => {
        url = u;
      }),
      locator: () => ({ click, fill: vi.fn(async () => {}) }),
      waitForLoadState: vi.fn(async () => {}),
      getByText: vi.fn(() => ({ first: () => ({ click, fill: vi.fn(async () => {}) }) })),
    };
    browserRegistry.__registerBrowserSessionForTests({
      id: 'sess-1',
      stagehand: { context: { activePage: () => page, pages: () => [page] }, act: vi.fn() },
      createdAt: Date.now(),
      timeoutMs: browserRegistry.DEFAULT_TIMEOUT_MS,
      close: async () => {},
    } as unknown as Parameters<typeof browserRegistry.__registerBrowserSessionForTests>[0]);
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'ask');

    const step = runBrowserReActStep(
      'sess-1',
      { op: 'click', target: '#buy' },
      {},
      undefined,
      {},
      policy.createBrowserDomainGate(ctx(), deps()),
    );
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    policy.setBrowserDomainPolicy(profileId, 'shop.com', 'block');
    ap.answerApprovalRequest(raisedApprovalId(), 'allow_once', alice);

    const r = await step;
    expect(click).not.toHaveBeenCalled();
    expect(r).toMatchObject({ hostExit: 2, hostDetail: 'blocked_domain' });
    expect(r.haltRemaining).toBeTruthy();
  });
});

describe('policy lookup failures fail closed (real gate, broken store)', () => {
  afterEach(() => browserRegistry.__resetBrowserRegistryForTests());

  /** A real lookup failure: the policy table is gone, so every query throws. */
  function breakPolicyStore() {
    getOrgsDb().exec('DROP TABLE browser_profile_domain_policies');
  }

  function fakeSession(id: string, startUrl: string, context: Record<string, unknown> = {}) {
    const state = { url: startUrl };
    const click = vi.fn(async () => {});
    const page = {
      url: () => state.url,
      goto: vi.fn(async (u: string) => {
        state.url = u;
      }),
      locator: () => ({ click, fill: vi.fn(async () => {}) }),
      waitForLoadState: vi.fn(async () => {}),
      innerText: vi.fn(async () => 'secret balance'),
      evaluate: vi.fn(async () => 'secret balance'),
      title: vi.fn(async () => 'Shop'),
      getByText: vi.fn(() => ({ first: () => ({ click, fill: vi.fn(async () => {}) }) })),
    };
    Object.assign(context, { activePage: () => page, pages: () => [page] });
    browserRegistry.__registerBrowserSessionForTests({
      id,
      stagehand: { context, act: vi.fn() },
      createdAt: Date.now(),
      timeoutMs: browserRegistry.DEFAULT_TIMEOUT_MS,
      close: async () => {},
    } as unknown as Parameters<typeof browserRegistry.__registerBrowserSessionForTests>[0]);
    return { state, click };
  }

  it('blockedBy reports the policy as unavailable instead of "not blocked"', () => {
    breakPolicyStore();
    const g = policy.createBrowserDomainGate(ctx(), deps())!;
    expect(g.blockedBy!('https://shop.com/')).toBe(policy.BROWSER_POLICY_UNAVAILABLE);
    expect(g.blockedBy!('about:blank')).toBeNull();
  });

  it('the gate refuses click when the policy cannot be read', async () => {
    breakPolicyStore();
    const r = await policy.createBrowserDomainGate(ctx(), deps())!({
      op: 'click',
      url: 'https://shop.com/buy',
    });
    expect(r).toMatchObject({ proceed: false, hostDetail: 'policy_unavailable' });
    expect(events).toEqual([]);
  });

  it('refuses a read-only op and leaves the page without reading it', async () => {
    const { state } = fakeSession('sess-ro', 'https://shop.com/account');
    breakPolicyStore();
    const r = await runBrowserReActStep(
      'sess-ro',
      { op: 'read_page' },
      {},
      undefined,
      {},
      policy.createBrowserDomainGate({ ...ctx(), sessionId: 'sess-ro' }, deps()),
    );
    expect(r).toMatchObject({ hostExit: 2, hostDetail: 'blocked_domain' });
    expect(r.markdown).toContain('could not be read');
    expect(r.markdown).not.toContain('secret balance');
    expect(state.url).toBe('about:blank');
  });

  it('does not click, and the standing deny fails document requests', async () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const send = vi.fn(async () => ({}));
    const context: Record<string, unknown> = {};
    await installContextFetchGuard(
      context,
      {
        send,
        on: (evt, h) => void handlers.set(evt, h),
        off: (evt) => void handlers.delete(evt),
      },
      { blockAdsTrackers: false },
    );
    const { click } = fakeSession('sess-click', 'https://shop.com/cart', context);
    const gate = policy.createBrowserDomainGate({ ...ctx(), sessionId: 'sess-click' }, deps());
    // Installs the deny while the store still works.
    await runBrowserReActStep(
      'sess-click',
      { op: 'scroll', direction: 'down' },
      {},
      undefined,
      {},
      gate,
    );
    breakPolicyStore();

    handlers.get('Fetch.requestPaused')!({
      requestId: 'redirect',
      resourceType: 'Document',
      request: { url: 'https://shop.com/next' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'redirect',
      errorReason: 'BlockedByClient',
    });

    const r = await runBrowserReActStep(
      'sess-click',
      { op: 'click', target: '#buy' },
      {},
      undefined,
      {},
      gate,
    );
    expect(click).not.toHaveBeenCalled();
    expect(r.hostExit).toBe(2);
  });
});
