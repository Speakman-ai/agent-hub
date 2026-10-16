import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetBrowserLoginHandoffsForTests,
  abortBrowserLogin,
  getPendingBrowserLogin,
  normalizeBrowserLoginDomain,
  requestBrowserLogin,
  settleBrowserLogin,
  subscribeBrowserLoginHandoffs,
  type BrowserLoginHandoffEvent,
} from './browser-login-handoff.js';
import { runBrowserReActStep, browserToolStartLabel } from './browser-tools.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  browserToolOpsInFlight,
  __unregisterBrowserSessionForTests,
  DEFAULT_TIMEOUT_MS,
  type BrowserSession,
} from './browser.js';
import { cancelSessionChatRun } from './session-chat-cancel.js';
import {
  __resetReactChainCancelForTests,
  isReactChainCancelRequested,
} from './react-chain-cancel.js';

function makeSession(
  id: string,
  opts: { url?: string; profile?: BrowserSession['profile'] } = {},
): { session: BrowserSession; goto: ReturnType<typeof vi.fn> } {
  let current = opts.url ?? 'https://github.com/login';
  const goto = vi.fn(async (u: string) => {
    current = u;
    return null;
  });
  const page = {
    url: () => current,
    goto,
    title: async () => 'Sign in',
    innerText: async () => 'Sign in to GitHub',
    evaluate: async () => '',
  };
  const session = {
    id,
    stagehand: { context: { activePage: () => page, pages: () => [page] } },
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close: async () => {},
    ...(opts.profile ? { profile: opts.profile } : {}),
  } as unknown as BrowserSession;
  __registerBrowserSessionForTests(session);
  return { session, goto };
}

/** Resolve once the step has opened its request. */
async function waitForPending(sessionId: string) {
  for (let i = 0; i < 50; i++) {
    const p = getPendingBrowserLogin(sessionId);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('request_login never opened');
}

beforeEach(() => {
  __resetBrowserRegistryForTests();
  __resetBrowserLoginHandoffsForTests();
  __resetReactChainCancelForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetBrowserLoginHandoffsForTests();
});

describe('normalizeBrowserLoginDomain', () => {
  it('reduces URLs and bare hosts to a lowercase hostname', () => {
    expect(normalizeBrowserLoginDomain('GitHub.com')).toBe('github.com');
    expect(normalizeBrowserLoginDomain('https://accounts.google.com/signin?x=1')).toBe(
      'accounts.google.com',
    );
    expect(normalizeBrowserLoginDomain('example.com/login')).toBe('example.com');
  });

  it('rejects empty, single-label and junk input', () => {
    expect(normalizeBrowserLoginDomain('')).toBeNull();
    expect(normalizeBrowserLoginDomain('localhost')).toBeNull();
    expect(normalizeBrowserLoginDomain('not a domain')).toBeNull();
    expect(normalizeBrowserLoginDomain(42)).toBeNull();
  });
});

describe('browser login handoff registry', () => {
  it('settles with the human answer and emits requested/resolved events', async () => {
    const events: BrowserLoginHandoffEvent[] = [];
    subscribeBrowserLoginHandoffs((ev) => events.push(ev));
    const { request, settled } = requestBrowserLogin('s1', { domain: 'github.com', reason: 'x' });
    expect(getPendingBrowserLogin('s1')?.requestId).toBe(request.requestId);

    expect(settleBrowserLogin('s1', { outcome: 'done' }, request.requestId)).toBe(true);
    await expect(settled).resolves.toEqual({ outcome: 'done' });
    expect(getPendingBrowserLogin('s1')).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['requested', 'resolved']);
  });

  it('ignores a Done for a stale request id', () => {
    const { request } = requestBrowserLogin('s1', { domain: 'github.com' });
    expect(settleBrowserLogin('s1', { outcome: 'done' }, 'other-id')).toBe(false);
    expect(getPendingBrowserLogin('s1')?.requestId).toBe(request.requestId);
  });

  it('times out when nobody answers', async () => {
    vi.useFakeTimers();
    const { settled } = requestBrowserLogin('s1', { domain: 'github.com' }, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(settled).resolves.toEqual({ outcome: 'timeout' });
    expect(getPendingBrowserLogin('s1')).toBeNull();
  });

  it('a new request supersedes the open one', async () => {
    const first = requestBrowserLogin('s1', { domain: 'a.com' });
    const second = requestBrowserLogin('s1', { domain: 'b.com' });
    await expect(first.settled).resolves.toEqual({ outcome: 'aborted', detail: 'superseded' });
    expect(getPendingBrowserLogin('s1')?.requestId).toBe(second.request.requestId);
  });
});

describe('runBrowserReActStep request_login', () => {
  it('pauses the turn until Done, saves the profile and resumes with an observation', async () => {
    const save = vi.fn(async () => true);
    makeSession('login-done', {
      profile: { writable: true, takeNotice: () => null, save },
    });
    const onRequested = vi.fn();
    const onResolved = vi.fn();
    let finished = false;
    const step = runBrowserReActStep(
      'login-done',
      { op: 'request_login', domain: 'github.com', reason: 'Read your notifications' },
      {},
      undefined,
      { onRequested, onResolved },
    ).then((r) => {
      finished = true;
      return r;
    });

    const pending = await waitForPending('login-done');
    expect(pending.domain).toBe('github.com');
    expect(pending.reason).toBe('Read your notifications');
    expect(onRequested).toHaveBeenCalledWith(pending);
    // Paused, and not counted as an agent step, so the human may drive the pane.
    expect(finished).toBe(false);
    expect(browserToolOpsInFlight('login-done')).toBe(0);

    settleBrowserLogin('login-done', { outcome: 'done' }, pending.requestId);
    const r = await step;
    expect(r.hostExit).toBe(0);
    expect(r.hostDetail).toBe('done:saved');
    expect(save).toHaveBeenCalledTimes(1);
    expect(r.markdown).toContain('finished signing in to github.com');
    expect(r.markdown).toContain('saved to the browser profile');
    expect(r.markdown).toContain('Surface: web');
    expect(onResolved).toHaveBeenCalledWith(pending, { outcome: 'done' });
  });

  it('reports a read-only profile without saving', async () => {
    const save = vi.fn(async () => true);
    makeSession('login-ro', { profile: { writable: false, takeNotice: () => null, save } });
    const step = runBrowserReActStep('login-ro', { op: 'request_login', domain: 'github.com' });
    const pending = await waitForPending('login-ro');
    settleBrowserLogin('login-ro', { outcome: 'done' }, pending.requestId);
    const r = await step;
    expect(save).not.toHaveBeenCalled();
    expect(r.hostDetail).toBe('done:read_only');
    expect(r.markdown).toContain('read-only');
  });

  it('returns a cancel observation that tells the agent not to ask in chat', async () => {
    makeSession('login-cancel');
    const step = runBrowserReActStep('login-cancel', { op: 'request_login', domain: 'github.com' });
    const pending = await waitForPending('login-cancel');
    settleBrowserLogin('login-cancel', { outcome: 'cancelled' }, pending.requestId);
    const r = await step;
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('cancelled');
    expect(r.markdown).toContain('cancelled sign-in to github.com');
    expect(r.markdown).toMatch(/agenthub:credential-request card, not in plain chat/);
  });

  it('times out and resumes the turn', async () => {
    makeSession('login-timeout');
    const r = await runBrowserReActStep(
      'login-timeout',
      { op: 'request_login', domain: 'github.com' },
      {},
      undefined,
      { timeoutMs: 20 },
    );
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('timeout');
    expect(r.markdown).toContain('Nobody completed sign-in to github.com');
    expect(getPendingBrowserLogin('login-timeout')).toBeNull();
  });

  it('Stop releases a parked turn', async () => {
    makeSession('login-stop');
    const step = runBrowserReActStep('login-stop', { op: 'request_login', domain: 'github.com' });
    await waitForPending('login-stop');
    cancelSessionChatRun({ sessionId: 'login-stop', activeProcesses: new Map() });
    const r = await step;
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('aborted:stopped');
  });

  it('closing the browser releases a parked turn', async () => {
    makeSession('login-close');
    const step = runBrowserReActStep('login-close', { op: 'request_login', domain: 'github.com' });
    await waitForPending('login-close');
    __unregisterBrowserSessionForTests('login-close');
    const r = await step;
    expect(r.hostDetail).toBe('aborted:browser_closed');
    expect(r.markdown).toContain('browser closed');
  });

  it('opens the site when the page is blank', async () => {
    const { goto } = makeSession('login-blank', { url: 'about:blank' });
    const step = runBrowserReActStep('login-blank', { op: 'request_login', domain: 'github.com' });
    const pending = await waitForPending('login-blank');
    expect(goto).toHaveBeenCalledWith('https://github.com/', expect.anything());
    settleBrowserLogin('login-blank', { outcome: 'done' }, pending.requestId);
    await step;
  });

  it('opens the agent-supplied sign-in URL when it names the same site', async () => {
    const { goto } = makeSession('login-url', { url: 'about:blank' });
    const step = runBrowserReActStep('login-url', {
      op: 'request_login',
      domain: 'github.com',
      url: 'https://github.com/login?return_to=%2Fsettings',
    });
    const pending = await waitForPending('login-url');
    expect(goto).toHaveBeenCalledWith(
      'https://github.com/login?return_to=%2Fsettings',
      expect.anything(),
    );
    settleBrowserLogin('login-url', { outcome: 'done' }, pending.requestId);
    await step;
  });

  it('does not ask the human to sign in when the site fails to load', async () => {
    // A DNS failure leaves Chromium on about:blank; the human must not be
    // handed an empty pane with a "sign in" banner.
    const { goto } = makeSession('login-dns', { url: 'about:blank' });
    goto.mockImplementationOnce(async () => {
      throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://qualia.io/');
    });
    const onRequested = vi.fn();
    const r = await runBrowserReActStep(
      'login-dns',
      { op: 'request_login', domain: 'qualia.io' },
      {},
      undefined,
      { onRequested },
    );
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('landing_failed');
    expect(r.markdown).toContain('ERR_NAME_NOT_RESOLVED');
    expect(r.markdown).toContain('The human was not asked to sign in');
    expect(onRequested).not.toHaveBeenCalled();
    expect(getPendingBrowserLogin('login-dns')).toBeNull();
  });

  it('treats a Chromium error page as blank and refuses the sign-in', async () => {
    const { goto } = makeSession('login-err-page', { url: 'chrome-error://chromewebdata/' });
    goto.mockImplementationOnce(async () => {
      throw new Error('page.goto: Timeout 30000ms exceeded.');
    });
    const r = await runBrowserReActStep('login-err-page', {
      op: 'request_login',
      domain: 'qualia.io',
    });
    expect(goto).toHaveBeenCalledWith('https://qualia.io/', expect.anything());
    expect(r.hostDetail).toBe('landing_failed');
    expect(getPendingBrowserLogin('login-err-page')).toBeNull();
  });

  it('honours a Stop that lands while the initial navigation is pending', async () => {
    const { goto } = makeSession('login-nav-stop', { url: 'about:blank' });
    let finishNavigation!: () => void;
    goto.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishNavigation = () => resolve(null);
        }),
    );
    const step = runBrowserReActStep(
      'login-nav-stop',
      { op: 'request_login', domain: 'github.com' },
      {},
      undefined,
      { isCancelled: () => isReactChainCancelRequested('login-nav-stop') },
    );
    await vi.waitFor(() => expect(goto).toHaveBeenCalled());
    // Nothing is pending yet, so Stop has no request to abort.
    cancelSessionChatRun({ sessionId: 'login-nav-stop', activeProcesses: new Map() });
    finishNavigation();
    const r = await step;
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('cancelled_before_request');
    expect(getPendingBrowserLogin('login-nav-stop')).toBeNull();
  });

  it('rejects a missing domain without opening a request', async () => {
    makeSession('login-bad');
    const r = await runBrowserReActStep('login-bad', { op: 'request_login' });
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('bad_domain');
    expect(getPendingBrowserLogin('login-bad')).toBeNull();
  });

  it('does not open a request after the user already pressed Stop', async () => {
    makeSession('login-pre-stop');
    const r = await runBrowserReActStep(
      'login-pre-stop',
      { op: 'request_login', domain: 'github.com' },
      {},
      undefined,
      { isCancelled: () => true },
    );
    expect(r.hostDetail).toBe('cancelled_before_request');
    expect(getPendingBrowserLogin('login-pre-stop')).toBeNull();
  });

  it('labels the activity row for the human', () => {
    expect(browserToolStartLabel({ op: 'request_login', domain: 'https://github.com/x' })).toBe(
      'Waiting for you to sign in to github.com…',
    );
  });

  it('a manual abort is a no-op when nothing is pending', () => {
    expect(abortBrowserLogin('nobody', 'stopped')).toBe(false);
  });
});
