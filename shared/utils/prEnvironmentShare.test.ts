import { describe, expect, it } from 'vitest';
import {
  classifyShareListError,
  initialShareListState,
  resolvePrEnvironmentOpenUrl,
  sharePanelKey,
  shouldScheduleShareRetry,
  shareListReducer,
  type ShareListAction,
  shareLinkStatusLabel,
  sortShareLinks,
  type PrEnvironmentShareLink,
} from './prEnvironmentShare';

const link = (over: Partial<PrEnvironmentShareLink>): PrEnvironmentShareLink => ({
  id: 'l',
  projectId: 'p',
  prNumber: 1,
  label: null,
  url: 'https://x/?share=t',
  status: 'active',
  createdBy: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
  revokedAt: null,
  canRevoke: false,
  ...over,
});

describe('shareLinkStatusLabel', () => {
  const now = new Date('2026-10-01T00:00:00.000Z').getTime();
  it('counts down to expiry', () => {
    expect(shareLinkStatusLabel(link({}), now)).toBe('expires in 7 days');
    expect(shareLinkStatusLabel(link({ expiresAt: '2026-10-01T05:00:00.000Z' }), now)).toBe(
      'expires in 5 h',
    );
    expect(shareLinkStatusLabel(link({ expiresAt: '2026-10-01T00:10:00.000Z' }), now)).toBe(
      'expires in 10 min',
    );
  });
  it('reports revoked and expired', () => {
    expect(shareLinkStatusLabel(link({ status: 'revoked' }), now)).toBe('revoked');
    expect(shareLinkStatusLabel(link({ status: 'expired' }), now)).toBe('expired');
    // Expired since the list was fetched.
    expect(shareLinkStatusLabel(link({ expiresAt: '2026-09-30T00:00:00.000Z' }), now)).toBe(
      'expired',
    );
  });
});

describe('sortShareLinks', () => {
  it('puts active links first, newest first within each group', () => {
    const sorted = sortShareLinks([
      link({ id: 'old-revoked', status: 'revoked', createdAt: '2026-10-03T00:00:00.000Z' }),
      link({ id: 'old-active', createdAt: '2026-10-01T00:00:00.000Z' }),
      link({ id: 'new-active', createdAt: '2026-10-02T00:00:00.000Z' }),
    ]);
    expect(sorted.map((l) => l.id)).toEqual(['new-active', 'old-active', 'old-revoked']);
  });
});

describe('shareListReducer', () => {
  const list = (n: number) => ({
    links: Array.from({ length: n }, (_, i) => link({ id: `l${i}` })),
    passwordRequired: false,
    canManage: true,
    canSetPassword: false,
  });
  const A = sharePanelKey('demo', 7);
  const B = sharePanelKey('demo', 8);
  let n = 0;
  const reset = (key = A): ShareListAction => ({ type: 'reset', key, seq: ++n });
  const start = (key = A): ShareListAction => ({ type: 'start', key, seq: ++n });
  const shown = (key = A) =>
    [reset(key), start(key)].reduce(shareListReducer, initialShareListState);

  it('hides only for the tagged unsupported codes', () => {
    let s = shown();
    s = shareListReducer(s, {
      type: 'failed',
      key: A,
      seq: s.seq,
      error: Object.assign(new Error('x'), { code: 'pr_env_ingress_not_configured' }),
    });
    expect(s.status).toBe('unsupported');
    expect(classifyShareListError({ code: 'pr_env_not_hosted' })).toBe('unsupported');
    expect(classifyShareListError(Object.assign(new Error('boom'), { status: 500 }))).toBe(
      'transient',
    );
    expect(classifyShareListError(new TypeError('Failed to fetch'))).toBe('transient');
  });

  it('keeps loaded data through a transient failure and recovers on the next load', () => {
    let s = shown();
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(2) });
    s = shareListReducer(s, start());
    expect(s.status).toBe('ready');
    s = shareListReducer(s, { type: 'failed', key: A, seq: s.seq, error: new Error('HTTP 502') });
    expect(s).toMatchObject({ status: 'error', error: 'HTTP 502' });
    expect(s.data?.links).toHaveLength(2);
    s = shareListReducer(s, start());
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(3) });
    expect(s).toMatchObject({ status: 'ready', error: null });
    expect(s.data?.links).toHaveLength(3);
  });

  it('a first-load failure is an error, not hidden', () => {
    let s = shown();
    s = shareListReducer(s, { type: 'failed', key: A, seq: s.seq, error: new Error('offline') });
    expect(s).toMatchObject({ status: 'error', data: null, error: 'offline' });
  });

  it('drops responses for an older request on the same PR', () => {
    let s = shown();
    const old = s.seq;
    s = shareListReducer(s, start());
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(1) });
    s = shareListReducer(s, { type: 'loaded', key: A, seq: old, data: list(5) });
    expect(s.data?.links).toHaveLength(1);
    s = shareListReducer(s, { type: 'failed', key: A, seq: old, error: new Error('late') });
    expect(s.status).toBe('ready');
  });

  it('arms the retry only after a failed request settles', () => {
    let s = shown();
    expect(s.inFlight).toBe(true);
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(1) });
    s = shareListReducer(s, start());
    s = shareListReducer(s, { type: 'failed', key: A, seq: s.seq, error: new Error('HTTP 502') });
    expect(shouldScheduleShareRetry(s)).toBe(true);
    // The retry starts: still showing the error and the old data, but no
    // further retry may be armed until this one settles.
    s = shareListReducer(s, start());
    expect(s).toMatchObject({ status: 'error', inFlight: true });
    expect(s.data?.links).toHaveLength(1);
    expect(shouldScheduleShareRetry(s)).toBe(false);
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(4) });
    expect(s).toMatchObject({ status: 'ready', inFlight: false });
    expect(s.data?.links).toHaveLength(4);
    expect(shouldScheduleShareRetry(s)).toBe(false);
  });

  it("a mutation reload for the previous PR never replaces the current PR's list", () => {
    // Shown: PR A. A mutation on A is in flight; the user switches to B and B loads.
    let s = shown(A);
    s = shareListReducer(s, { type: 'loaded', key: A, seq: s.seq, data: list(1) });
    s = shareListReducer(s, reset(B));
    s = shareListReducer(s, start(B));
    s = shareListReducer(s, { type: 'loaded', key: B, seq: s.seq, data: list(2) });
    // A's mutation now finishes and reloads A with a NEWER sequence number.
    const lateStart = start(A);
    s = shareListReducer(s, lateStart);
    s = shareListReducer(s, { type: 'loaded', key: A, seq: lateStart.seq, data: list(9) });
    s = shareListReducer(s, { type: 'failed', key: A, seq: lateStart.seq, error: new Error('x') });
    expect(s).toMatchObject({ key: B, status: 'ready' });
    expect(s.data?.links).toHaveLength(2);
  });
});

describe('resolvePrEnvironmentOpenUrl', () => {
  const plain = 'https://pr-7--demo.preview.example.com/';
  it('uses the ticket URL', async () => {
    expect(
      await resolvePrEnvironmentOpenUrl(async () => ({ url: `${plain}?share=aht_x` }), plain),
    ).toEqual({
      url: `${plain}?share=aht_x`,
    });
  });
  it('falls back to the plain URL only when access links do not apply', async () => {
    const unsupported = Object.assign(new Error('needs ingress'), {
      code: 'pr_env_ingress_not_configured',
    });
    expect(await resolvePrEnvironmentOpenUrl(() => Promise.reject(unsupported), plain)).toEqual({
      url: plain,
    });
  });
  it('reports a transient failure instead of opening the access page', async () => {
    expect(
      await resolvePrEnvironmentOpenUrl(
        () => Promise.reject(Object.assign(new Error('HTTP 503'), { status: 503 })),
        plain,
      ),
    ).toEqual({ error: 'HTTP 503' });
    expect(await resolvePrEnvironmentOpenUrl(async () => ({}), plain)).toHaveProperty('error');
  });
});
