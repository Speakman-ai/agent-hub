import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowserReActStep } from './browser-tools.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from './browser.js';
import { installContextFetchGuard } from './browser-context-fetch-guard.js';
import type { BrowserDomainGate, BrowserGateResult } from './browser-domain-policy.js';

interface FakePage {
  current: string;
  /** Where the next click / goto / goBack / goForward lands, when set. */
  clickLandsOn?: string;
  gotoLandsOn?: string;
  backLandsOn?: string;
  /** Runs inside the click, e.g. to simulate the link's document request. */
  onClick?: () => void;
}

function register(
  id: string,
  state: FakePage,
  context: Record<string, unknown> = {},
  close: () => Promise<void> = async () => {},
) {
  const click = vi.fn(async () => {
    state.onClick?.();
    if (state.clickLandsOn) state.current = state.clickLandsOn;
  });
  const goto = vi.fn(async (url: string) => {
    state.current = url === 'about:blank' ? url : (state.gotoLandsOn ?? url);
  });
  const page = {
    url: () => state.current,
    goto,
    goBack: vi.fn(async () => {
      if (state.backLandsOn) state.current = state.backLandsOn;
    }),
    locator: () => ({ click, fill: vi.fn(async () => {}) }),
    waitForLoadState: vi.fn(async () => {}),
    innerText: vi.fn(async () => 'secret balance'),
    title: vi.fn(async () => 'Bank'),
    evaluate: vi.fn(async () => 'secret balance'),
    getByText: vi.fn(() => ({ first: () => ({ click, fill: vi.fn(async () => {}) }) })),
  };
  Object.assign(context, { activePage: () => page, pages: () => [page] });
  __registerBrowserSessionForTests({
    id,
    stagehand: { context, act: vi.fn() },
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close,
  } as unknown as Parameters<typeof __registerBrowserSessionForTests>[0]);
  return { click, goto };
}

/** A gate that allows everything and blocks bank.com through `blockedBy`. */
function bankBlockingGate(
  impl: (req: Parameters<BrowserDomainGate>[0]) => Promise<BrowserGateResult> = async () => ({
    proceed: true,
    host: null,
  }),
): BrowserDomainGate {
  return Object.assign(vi.fn(impl), {
    blockedBy: (url: string) => {
      try {
        return new URL(url).hostname.endsWith('bank.com') ? 'bank.com' : null;
      } catch {
        return null;
      }
    },
  });
}

const CLICK = { op: 'click', target: '#buy' };

beforeEach(() => __resetBrowserRegistryForTests());

describe('runBrowserReActStep domain gate', () => {
  it('passes the current page URL to the gate for click', async () => {
    const { click } = register('g-pass', { current: 'https://shop.com/cart' });
    const gate = vi.fn<BrowserDomainGate>(async () => ({ proceed: true, host: 'shop.com' }));
    const r = await runBrowserReActStep('g-pass', CLICK, {}, undefined, {}, gate);
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'click', url: 'https://shop.com/cart', target: '#buy' }),
    );
    expect(r.hostExit).toBe(0);
    expect(click).toHaveBeenCalled();
  });

  it('does not run a refused op and asks the batch to halt', async () => {
    const { click } = register('g-block', { current: 'https://shop.com/' });
    const gate: BrowserDomainGate = async () => ({
      proceed: false,
      markdown: '## Browser: click refused\n\nblocked',
      hostDetail: 'blocked_domain',
      summary: 'Blocked: shop.com',
      halt: 'browser click on shop.com was refused',
    });
    const r = await runBrowserReActStep('g-block', CLICK, {}, undefined, {}, gate);
    expect(click).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      hostExit: 2,
      hostDetail: 'blocked_domain',
      haltRemaining: 'browser click on shop.com was refused',
    });
  });

  it('prefixes the approval notice when the human allowed the op', async () => {
    const { click } = register('g-ok', { current: 'https://shop.com/cart' });
    const gate: BrowserDomainGate = async () => ({
      proceed: true,
      host: 'shop.com',
      notice: 'Host approval: allowed',
    });
    const r = await runBrowserReActStep('g-ok', CLICK, {}, undefined, {}, gate);
    expect(click).toHaveBeenCalled();
    expect(r.markdown.startsWith('Host approval: allowed')).toBe(true);
  });

  it('refuses when the page moved to another page on the same site during approval', async () => {
    const state: FakePage = { current: 'https://shop.com/order/1' };
    const { click } = register('g-moved', state);
    const gate: BrowserDomainGate = async () => {
      state.current = 'https://shop.com/order/2';
      return { proceed: true, host: 'shop.com', notice: 'Host approval: allowed' };
    };
    const r = await runBrowserReActStep('g-moved', CLICK, {}, undefined, {}, gate);
    expect(click).not.toHaveBeenCalled();
    expect(r.hostDetail).toBe('page_changed_during_approval');
    expect(r.markdown).toContain('https://shop.com/order/1');
  });

  it('does not consult the gate for read-only ops', async () => {
    register('g-read', { current: 'https://shop.com/' });
    const gate = vi.fn<BrowserDomainGate>();
    await runBrowserReActStep(
      'g-read',
      { op: 'scroll', direction: 'down' },
      {},
      undefined,
      {},
      gate,
    );
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('gate failures', () => {
  it('refuses the op and halts the batch when the gate throws', async () => {
    const { click } = register('g-throw', { current: 'https://shop.com/cart' });
    const gate: BrowserDomainGate = async () => {
      throw new Error('approval insert failed');
    };
    const r = await runBrowserReActStep('g-throw', CLICK, {}, undefined, {}, gate);
    expect(click).not.toHaveBeenCalled();
    expect(r).toMatchObject({ hostExit: 2, hostDetail: 'policy_unavailable' });
    expect(r.haltRemaining).toBeTruthy();
  });
});

describe('blocked sites reached without an explicit URL', () => {
  it('refuses a navigate that redirects onto a blocked site and leaves the page', async () => {
    const state: FakePage = {
      current: 'about:blank',
      gotoLandsOn: 'https://www.bank.com/home',
    };
    const { goto } = register('b-redirect', state);
    const r = await runBrowserReActStep(
      'b-redirect',
      { op: 'navigate', url: 'https://short.link/x' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    expect(r).toMatchObject({ hostExit: 2, hostDetail: 'blocked_domain' });
    expect(r.haltRemaining).toContain('www.bank.com');
    expect(goto).toHaveBeenLastCalledWith('about:blank');
    expect(state.current).toBe('about:blank');
  });

  it('refuses a click whose link lands on a blocked site', async () => {
    const state: FakePage = {
      current: 'https://news.com/',
      clickLandsOn: 'https://bank.com/login',
    };
    register('b-click', state);
    const r = await runBrowserReActStep('b-click', CLICK, {}, undefined, {}, bankBlockingGate());
    expect(r.hostDetail).toBe('blocked_domain');
    expect(state.current).toBe('about:blank');
  });

  it('refuses back / forward onto a blocked site', async () => {
    const state: FakePage = { current: 'https://news.com/', backLandsOn: 'https://bank.com/' };
    register('b-back', state);
    const r = await runBrowserReActStep(
      'b-back',
      { op: 'back' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    expect(r.hostDetail).toBe('blocked_domain');
    expect(state.current).toBe('about:blank');
  });

  it('refuses read-only ops on a page already on a blocked site, without reading it', async () => {
    const state: FakePage = { current: 'https://bank.com/accounts' };
    register('b-read', state);
    const r = await runBrowserReActStep(
      'b-read',
      { op: 'read_page' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    expect(r.hostDetail).toBe('blocked_domain');
    expect(r.markdown).not.toContain('secret balance');
    expect(state.current).toBe('about:blank');
  });

  it('installs a request-time document deny on the context Fetch guard', async () => {
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
    register('b-fetch', { current: 'https://news.com/' }, context);
    await runBrowserReActStep(
      'b-fetch',
      { op: 'scroll', direction: 'down' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    handlers.get('Fetch.requestPaused')!({
      requestId: 'link',
      resourceType: 'Document',
      request: { url: 'https://login.bank.com/' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'link',
      errorReason: 'BlockedByClient',
    });
  });

  it('still closes a session whose current page is blocked', async () => {
    const state: FakePage = { current: 'https://bank.com/accounts' };
    const close = vi.fn(async () => {});
    register('b-close', state, {}, close);
    const r = await runBrowserReActStep(
      'b-close',
      { op: 'close' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    expect(r).toMatchObject({ hostExit: 0, hostDetail: 'close' });
    expect(r.haltRemaining).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('re-installs the deny on a browser replaced while the approval was pending', async () => {
    const first = await guardedContext();
    register('b-swap', { current: 'https://shop.com/cart' }, first.context);
    const second = await guardedContext();
    const replacement: FakePage = { current: 'https://shop.com/cart' };
    // The approved click follows a link to the blocked site: its document
    // request must already be failed by the replacement context's guard.
    replacement.onClick = () => second.paused('click-link', 'https://bank.com/pay');
    const gate = bankBlockingGate(async () => {
      register('b-swap', replacement, second.context);
      return { proceed: true, host: 'shop.com', notice: 'Host approval: allowed' };
    });

    const r = await runBrowserReActStep('b-swap', CLICK, {}, undefined, {}, gate);

    expect(r.hostExit).toBe(0);
    expect(second.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'click-link',
      errorReason: 'BlockedByClient',
    });
  });

  it('refuses request_login for a blocked site without opening it', async () => {
    const state: FakePage = { current: 'about:blank' };
    const { goto } = register('b-login', state);
    const r = await runBrowserReActStep(
      'b-login',
      { op: 'request_login', domain: 'login.bank.com' },
      {},
      undefined,
      {},
      bankBlockingGate(),
    );
    expect(r).toMatchObject({ hostExit: 2, hostDetail: 'blocked_domain' });
    expect(r.haltRemaining).toContain('login.bank.com');
    expect(goto).not.toHaveBeenCalled();
  });

  it('installs the deny before request_login hands the page to the human', async () => {
    const guarded = await guardedContext();
    register('b-login-deny', { current: 'https://news.com/' }, guarded.context);
    await runBrowserReActStep(
      'b-login-deny',
      { op: 'request_login', domain: 'github.com' },
      {},
      undefined,
      { timeoutMs: 1 },
      bankBlockingGate(),
    );
    guarded.paused('human-nav', 'https://bank.com/');
    expect(guarded.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'human-nav',
      errorReason: 'BlockedByClient',
    });
  });
});

async function guardedContext() {
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
  const paused = (requestId: string, url: string) =>
    handlers.get('Fetch.requestPaused')!({
      requestId,
      resourceType: 'Document',
      request: { url },
    });
  return { context, send, paused };
}
