import { describe, expect, it } from 'vitest';
import { buildQaRunSeed, resolveQaTarget, type QaActivePreview } from './qa-run-kickoff.js';

const SID = '0b7e6a52-1c1d-4f3e-9a7b-2f6c3e8d9a10';
const FOREIGN = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const IDLE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PROJECT_SESSIONS = new Set([SID, IDLE, 'host-a', 'host-b', 'lan-host']);
const isProjectSession = (id: string) => PROJECT_SESSIONS.has(id);
const BASE = 'preview.hub.example.com';
const HUB = 'https://hub.example.com';

const preview = (
  session_id: string,
  port: number,
  url = `http://localhost:${port}`,
  status = 'ready',
): QaActivePreview => ({ session_id, status, port, url });

// Primary internal port of each running preview; absent = not running.
const PRIMARY_PORTS: Record<string, number> = { [SID]: 3050, 'host-a': 5173 };

const resolve = (target: string, activePreviews: QaActivePreview[] = []) =>
  resolveQaTarget(target, {
    previewSubdomainBase: BASE,
    hubPublicUrl: HUB,
    activePreviews,
    isProjectSession,
    primaryInternalPort: (id) => PRIMARY_PORTS[id] ?? null,
  });

describe('resolveQaTarget', () => {
  it.each(['https://example.com', 'https://staging.acme.io/checkout', 'http://8.8.8.8/'])(
    'routes public %s to browser',
    (url) => {
      expect(resolve(url, [preview('host-a', 443)]).tool).toBe('browser');
    },
  );

  it('falls back to browser for an unparseable target', () => {
    expect(resolve('not a url').tool).toBe('browser');
  });

  it('names the session from a preview subdomain or this Hub proxy path', () => {
    expect(resolve(`https://3050--${SID}.${BASE}/login`)).toMatchObject({
      tool: 'preview',
      previewSessionId: SID,
    });
    expect(resolve(`${HUB}/api/sessions/host-a/preview/proxy/`)).toMatchObject({
      tool: 'preview',
      previewSessionId: 'host-a',
    });
  });

  it("accepts a port-prefixed subdomain only for the preview's primary port", () => {
    expect(resolve(`https://3050--${SID}.${BASE}/login`)).toMatchObject({
      tool: 'preview',
      previewSessionId: SID,
      route: '/login',
    });
    const other = resolve(`https://8080--${SID}.${BASE}/login`);
    expect(other.tool).toBe('unreachable');
    expect(other.reason).toMatch(/port 8080 .* drives its primary port 3050/);
    // No running preview: the requested port cannot be checked.
    expect(resolve(`https://3050--${IDLE}.${BASE}/`)).toMatchObject({ tool: 'unreachable' });
    // The bare form is the primary endpoint by definition, running or not.
    expect(resolve(`https://${IDLE}.${BASE}/`)).toMatchObject({
      tool: 'preview',
      previewSessionId: IDLE,
    });
  });

  it('applies the same primary-port rule to the /p/<port> proxy sub-mount', () => {
    expect(resolve(`${HUB}/api/sessions/host-a/preview/proxy/p/5173/app#/x`)).toMatchObject({
      tool: 'preview',
      previewSessionId: 'host-a',
      route: '/app#/x',
    });
    expect(resolve(`${HUB}/api/sessions/host-a/preview/proxy/p/9000/app`)).toMatchObject({
      tool: 'unreachable',
    });
    expect(resolve(`${HUB}/api/sessions/host-a/preview/proxy/p/99999/`).tool).toBe('unreachable');
  });

  it('treats the proxy path on another public host as a public URL', () => {
    expect(resolve('https://example.com/api/sessions/host-a/preview/proxy/')).toEqual({
      tool: 'browser',
      reason: 'the target is a public URL',
    });
  });

  it('refuses a named session outside the project', () => {
    expect(resolve(`https://${FOREIGN}.${BASE}/`).tool).toBe('unreachable');
    expect(resolve(`${HUB}/api/sessions/${FOREIGN}/preview/proxy/`).tool).toBe('unreachable');
  });

  it('matches a loopback alias to the preview bound on that host port', () => {
    const previews = [preview('host-a', 3050), preview('host-b', 5173)];
    for (const target of [
      'http://localhost:3050/login',
      'http://127.0.0.1:3050',
      'http://[::1]:3050/',
      'http://0.0.0.0:3050',
    ]) {
      expect(resolve(target, previews)).toMatchObject({
        tool: 'preview',
        previewSessionId: 'host-a',
      });
    }
    // A preview whose URL is a proxied origin still binds its host port.
    expect(
      resolve('http://localhost:4100', [preview('host-b', 4100, `https://${SID}.${BASE}`)]),
    ).toMatchObject({ tool: 'preview', previewSessionId: 'host-b' });
  });

  it('refuses a private host that only shares a port with an unrelated preview', () => {
    expect(resolve('http://192.168.1.10:3050', [preview('host-a', 3050)])).toMatchObject({
      tool: 'unreachable',
    });
    expect(resolve('http://devbox:3050/', [preview('host-a', 3050)]).tool).toBe('unreachable');
  });

  it('matches a private host only on an exact preview origin', () => {
    expect(
      resolve('http://192.168.1.10:3050/app', [
        preview('host-a', 3050),
        preview('lan-host', 3050, 'http://192.168.1.10:3050'),
      ]),
    ).toMatchObject({ tool: 'preview', previewSessionId: 'lan-host' });
  });

  it('refuses ambiguous loopback matches instead of picking one', () => {
    const r = resolve('http://localhost:3050', [
      preview('host-a', 3050),
      preview('host-b', 3050, 'http://localhost:3050', 'starting'),
    ]);
    expect(r.tool).toBe('unreachable');
    expect(r.reason).toMatch(/ambiguous/);
  });

  it('ignores stopped previews and previews from other projects', () => {
    expect(
      resolve('http://localhost:3050', [preview('host-a', 3050, undefined, 'stopped')]).tool,
    ).toBe('unreachable');
    // Another project's preview neither matches nor makes the match ambiguous.
    expect(
      resolve('http://localhost:3050', [preview(FOREIGN, 3050), preview('host-a', 3050)]),
    ).toMatchObject({ tool: 'preview', previewSessionId: 'host-a' });
    expect(resolve('http://localhost:9999', [preview('host-a', 3050)]).tool).toBe('unreachable');
  });
});

describe('resolveQaTarget route', () => {
  const route = (target: string, previews: QaActivePreview[] = []) => {
    const r = resolve(target, previews);
    return r.tool === 'preview' ? r.route : `<${r.tool}>`;
  };

  it('keeps path, query, and fragment for every preview match', () => {
    expect(route('http://localhost:3050/#/checkout', [preview('host-a', 3050)])).toBe(
      '/#/checkout',
    );
    expect(route('http://localhost:3050/app?x=1#/cart/2', [preview('host-a', 3050)])).toBe(
      '/app?x=1#/cart/2',
    );
    expect(route('http://localhost:3050', [preview('host-a', 3050)])).toBe('/');
    expect(route(`https://${SID}.${BASE}/shop#/pay`)).toBe('/shop#/pay');
    expect(
      route('http://192.168.1.10:3050/a?b=c#d', [
        preview('lan-host', 3050, 'http://192.168.1.10:3050'),
      ]),
    ).toBe('/a?b=c#d');
  });

  it('strips the proxy mount from a Hub-proxied target and keeps the rest', () => {
    expect(route(`${HUB}/api/sessions/host-a/preview/proxy/settings?tab=2#/x`)).toBe(
      '/settings?tab=2#/x',
    );
    expect(route(`${HUB}/api/sessions/host-a/preview/proxy`)).toBe('/');
    expect(route(`${HUB}/api/sessions/host-a/preview/proxy/#/checkout`)).toBe('/#/checkout');
  });
});

describe('buildQaRunSeed', () => {
  const project = { id: 'proj', name: 'Proj' };
  const plan = { id: 'plan-1', title: 'Checkout', goal: 'Buy a thing', target_url: 'https://x.io' };
  const cases = [
    { id: 'c-1', title: 'Login', steps: '1. Open /login', expected: 'Dashboard' },
    { id: 'c-2', title: 'Pay', steps: '', expected: '' },
  ];

  it('carries ids, target, scope, every case, and the browser tool for public targets', () => {
    const seed = buildQaRunSeed({
      project,
      plan,
      run: { id: 'run-1', iteration: 3, scope: 'full' },
      cases,
      routing: { tool: 'browser', reason: 'the target is a public URL' },
    });
    expect(seed).toContain('[QA run #3] Checkout');
    expect(seed).toContain('`run-1`');
    expect(seed).toContain('`plan-1`');
    expect(seed).toContain('https://x.io');
    expect(seed).toContain('Scope: **full**. All 2 case(s)');
    expect(seed).toContain('`c-1`');
    expect(seed).toContain('1. Open /login');
    expect(seed).toContain('#### 2. Pay');
    expect(seed).toContain('the `browser` ReAct tool');
    expect(seed).not.toContain('the `preview` ReAct tool');
    expect(seed).toContain('qa.sh result post plan-1 run-1');
    expect(seed).toContain('do not call `qa.sh run begin`');
  });

  it('names the preview session and route for a preview target and the failed_only scope', () => {
    const seed = buildQaRunSeed({
      project,
      plan: { ...plan, target_url: 'http://localhost:3050/login?x=1' },
      run: { id: 'run-2', iteration: 2, scope: 'failed_only' },
      cases: [cases[1]],
      routing: {
        tool: 'preview',
        reason: 'the target is a loopback host',
        previewSessionId: 'target-sess',
        route: '/login?x=1',
      },
    });
    expect(seed).toContain('the `preview` ReAct tool, because the target is a loopback host');
    expect(seed).toContain("drives session `target-sess`'s preview");
    expect(seed).toContain('`/login?x=1`');
    expect(seed).toContain('You cannot start or stop that preview');
    expect(seed).toContain('Scope: **failed_only**. Only the 1 case(s)');
    expect(seed).not.toContain('`c-1`');
  });
});
