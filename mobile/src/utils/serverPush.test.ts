import { describe, it, expect, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import {
  answerApprovalOnServer,
  answerPushApproval,
  mayUnregisterServer,
  pushServersFromOrgs,
  pushSource,
  routePushTap,
  UNKNOWN_SERVER_MESSAGE,
  AMBIGUOUS_SERVER_MESSAGE,
  registerPushTokenWithServers,
  unregisterPushTokenFromServer,
  type ServerPushDeps,
} from './serverPush';

const ORGS = [
  { id: 'a', remoteUrl: 'https://one.test/', apiKey: '' },
  { id: 'b', remoteUrl: 'https://two.test', apiKey: 'key-b' },
  { id: 'c', remoteUrl: 'http://three.test:3051', apiKey: '' },
];

function deps(opts: {
  logins?: Record<string, string>;
  fail?: Record<string, number | Error>;
}): ServerPushDeps & { calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  return {
    calls,
    loginTokenFor: async (url) => opts.logins?.[url] ?? null,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const hit = Object.entries(opts.fail ?? {}).find(([prefix]) => url.startsWith(prefix));
      if (hit && hit[1] instanceof Error) throw hit[1];
      const status = hit ? (hit[1] as number) : 200;
      return { ok: status < 400, status };
    },
  };
}

describe('pushServersFromOrgs', () => {
  it('keeps one entry per server origin and skips servers without a URL', () => {
    const servers = pushServersFromOrgs([
      ...ORGS,
      { id: 'dup', remoteUrl: 'https://ONE.test', apiKey: 'x' },
      { id: 'blank', remoteUrl: '' },
      { id: 'bad', remoteUrl: 'not a url' },
    ]);
    expect(servers.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(servers[0].serverUrl).toBe('https://one.test');
  });
});

describe('registerPushTokenWithServers', () => {
  it('registers with every saved server using each server’s own credentials', async () => {
    const d = deps({ logins: { 'https://one.test': 'jwt-one' } });
    const results = await registerPushTokenWithServers(
      'ExpoToken[1]',
      'ios',
      pushServersFromOrgs(ORGS),
      d,
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(d.calls.map((c) => c.url)).toEqual([
      'https://one.test/api/devices',
      'https://two.test/api/devices',
      'http://three.test:3051/api/devices',
    ]);
    expect(d.calls[0].init.headers.Authorization).toBe('Bearer jwt-one');
    expect(d.calls[1].init.headers['X-API-Key']).toBe('key-b');
    expect(d.calls[2].init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(d.calls[1].init.body)).toEqual({
      token: 'ExpoToken[1]',
      platform: 'ios',
      serverUrl: 'https://two.test',
    });
  });

  it('a down or signed-out server does not stop the others', async () => {
    const d = deps({
      fail: { 'https://one.test': 401, 'https://two.test': new Error('offline') },
    });
    const results = await registerPushTokenWithServers(
      'ExpoToken[1]',
      'android',
      pushServersFromOrgs(ORGS),
      d,
    );
    expect(results.map((r) => r.ok)).toEqual([false, false, true]);
    expect(results[0].status).toBe(401);
    expect(results[1].error).toBe('offline');
  });
});

describe('unregisterPushTokenFromServer', () => {
  it('deletes the token on that server only', async () => {
    const d = deps({ logins: { 'https://two.test': 'jwt-two' } });
    const [, two] = pushServersFromOrgs(ORGS);
    await unregisterPushTokenFromServer('Expo Token[1]', two, d);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].url).toBe('https://two.test/api/devices/Expo%20Token%5B1%5D');
    expect(d.calls[0].init.method).toBe('DELETE');
    expect(d.calls[0].init.headers.Authorization).toBe('Bearer jwt-two');
  });
});

describe('pushSource', () => {
  it('names the saved server a tagged push came from when it is not the active one', () => {
    const source = pushSource({ hubServerUrl: 'https://two.test' }, ORGS, 'https://one.test');
    expect(source).toMatchObject({ kind: 'other', server: { id: 'b' } });
  });

  it('a push tagged with the active server is active', () => {
    expect(pushSource({ hubServerUrl: 'https://one.test/' }, ORGS, 'https://one.test')).toEqual({
      kind: 'active',
    });
  });

  it('marks a push from a server that is not saved, or a garbled tag, as unknown', () => {
    expect(pushSource({ hubServerUrl: 'https://gone.test' }, ORGS, 'https://one.test')).toEqual({
      kind: 'unknown',
    });
    expect(pushSource({ hubServerUrl: 'nonsense' }, ORGS, 'https://one.test')).toEqual({
      kind: 'unknown',
    });
  });

  it('an untagged push is ambiguous whatever is saved or active', () => {
    for (const orgs of [ORGS, ORGS.slice(0, 1), []]) {
      expect(pushSource({ sessionId: 's1' }, orgs, 'https://one.test')).toEqual({
        kind: 'ambiguous',
      });
    }
    expect(pushSource(null, ORGS, 'https://one.test')).toEqual({ kind: 'ambiguous' });
  });
});

/** Answer and tap for one notification; records anything sent anywhere. */
async function actOn(data: unknown, orgs: any[], activeServerUrl: string) {
  const answerOnActive = vi.fn().mockResolvedValue({});
  const routeOnActive = vi.fn();
  let current = activeServerUrl;
  const urlOf = (id: string) => orgs.find((o) => o.id === id)?.remoteUrl;
  const switchTo = vi.fn(async (id: string) => {
    current = urlOf(id);
    return true;
  });
  const d = deps({ logins: { 'https://one.test': 'jwt-one', 'https://two.test': 'jwt-two' } });
  const answered = await answerPushApproval({
    data,
    orgs,
    activeServerUrl,
    approvalId: 'ap-x',
    decision: 'allow_once',
    answerOnActive,
    deps: d,
  }).then(
    () => 'answered',
    (err: Error) => err.message,
  );
  const tapped = await routePushTap({
    data,
    orgs,
    activeServerUrl,
    routeOnActive,
    switchTo,
    currentServerUrl: () => current,
  });
  return {
    answered,
    tapped,
    answeredOnActive: answerOnActive.mock.calls.length,
    routed: routeOnActive.mock.calls.length,
    switchedTo: switchTo.mock.calls.map((c) => c[0]),
    sent: d.calls.map((c) => c.url),
  };
}

const NOTHING_SENT = { answeredOnActive: 0, routed: 0, switchedTo: [], sent: [] };

describe('notifications delivered before an upgrade (untagged)', () => {
  // Untagged approval A sent before A started tagging. A has since upgraded;
  // B is saved and still on an older version. Nothing about current
  // capabilities says who sent it.
  const untagged = { type: 'approval_requested', approvalId: 'ap-x', sessionId: 's-a' };
  const twoServers = ORGS.slice(0, 2);

  it('is neither answered nor opened, with A active', async () => {
    expect(await actOn(untagged, twoServers, 'https://one.test')).toEqual({
      answered: AMBIGUOUS_SERVER_MESSAGE,
      tapped: 'ambiguous',
      ...NOTHING_SENT,
    });
  });

  it('is not handed to the older server B either, with B active', async () => {
    expect(await actOn(untagged, twoServers, 'https://two.test')).toEqual({
      answered: AMBIGUOUS_SERVER_MESSAGE,
      tapped: 'ambiguous',
      ...NOTHING_SENT,
    });
  });

  it('is not attributed even when only one server is saved', async () => {
    expect(await actOn(untagged, ORGS.slice(0, 1), 'https://one.test')).toEqual({
      answered: AMBIGUOUS_SERVER_MESSAGE,
      tapped: 'ambiguous',
      ...NOTHING_SENT,
    });
  });

  it('a tagged notification from the same servers still works', async () => {
    const tagged = { ...untagged, hubServerUrl: 'https://two.test' };
    const result = await actOn(tagged, twoServers, 'https://one.test');
    expect(result).toMatchObject({ answered: 'answered', tapped: 'switched', switchedTo: ['b'] });
    expect(result.sent).toEqual(['https://two.test/api/me/approvals/ap-x/answer']);
    expect(result.answeredOnActive).toBe(0);
  });
});

describe('notifications delivered before their server was removed', () => {
  const remaining = ORGS.filter((o) => o.id !== 'b');

  it('a tagged one is neither answered nor opened anywhere', async () => {
    const data = {
      type: 'approval_requested',
      approvalId: 'ap-x',
      hubServerUrl: 'https://two.test',
    };
    expect(await actOn(data, remaining, 'https://one.test')).toEqual({
      answered: UNKNOWN_SERVER_MESSAGE,
      tapped: 'unknown',
      ...NOTHING_SENT,
    });
  });

  it('an untagged one, with a single server left, is not given to that server', async () => {
    const data = { type: 'approval_requested', approvalId: 'ap-x' };
    expect(await actOn(data, ORGS.slice(0, 1), 'https://one.test')).toEqual({
      answered: AMBIGUOUS_SERVER_MESSAGE,
      tapped: 'ambiguous',
      ...NOTHING_SENT,
    });
  });
});

describe('mayUnregisterServer', () => {
  const shared = [
    { id: 'x', remoteUrl: 'https://shared.test' },
    { id: 'y', remoteUrl: 'https://SHARED.test/' },
    { id: 'z', remoteUrl: 'https://solo.test' },
  ];

  it('keeps the registration while another saved entry uses the same server', () => {
    expect(mayUnregisterServer(shared, 'x', 'https://shared.test')).toBe(false);
    expect(mayUnregisterServer(shared, 'y', 'https://shared.test/')).toBe(false);
  });

  it('allows unregistering when the entry is the only one for its server', () => {
    expect(mayUnregisterServer(shared, 'z', 'https://solo.test')).toBe(true);
    expect(mayUnregisterServer([shared[0]], 'x', 'https://shared.test')).toBe(true);
  });

  it('never unregisters an entry without a usable URL', () => {
    expect(mayUnregisterServer(shared, 'z', '')).toBe(false);
  });
});

describe('answerApprovalOnServer', () => {
  it('posts the decision to the server the push came from', async () => {
    const d = deps({ logins: { 'https://two.test': 'jwt-two' } });
    const [, two] = pushServersFromOrgs(ORGS);
    await answerApprovalOnServer(two, 'ap 1', 'allow_once', d);
    expect(d.calls[0].url).toBe('https://two.test/api/me/approvals/ap%201/answer');
    expect(JSON.parse(d.calls[0].init.body)).toEqual({ decision: 'allow_once' });
  });

  it('throws with the status so a 409 still counts as settled', async () => {
    const d = deps({ fail: { 'https://two.test': 409 } });
    const [, two] = pushServersFromOrgs(ORGS);
    await expect(answerApprovalOnServer(two, 'ap1', 'deny', d)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('request timeout', () => {
  it('gives up on a server that accepts the request and never answers, and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const started = Date.now();
    const [result] = await registerPushTokenWithServers(
      'T',
      'ios',
      pushServersFromOrgs(ORGS.slice(0, 1)),
      {
        timeoutMs: 20,
        loginTokenFor: async () => null,
        fetch: (_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: 'timed out after 20ms' });
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a stalled approval answer fails instead of hanging', async () => {
    const [server] = pushServersFromOrgs(ORGS.slice(0, 1));
    await expect(
      answerApprovalOnServer(server, 'ap1', 'deny', {
        timeoutMs: 20,
        loginTokenFor: async () => null,
        fetch: () => new Promise(() => {}),
      }),
    ).rejects.toThrow('timed out after 20ms');
  });
});

describe('the active server was just deleted (active URL still points at it)', () => {
  // one.test's entry is gone, but the connection hasn't switched yet.
  const remaining = ORGS.filter((o) => o.id !== 'a');
  const data = { type: 'approval_requested', approvalId: 'ap-x', hubServerUrl: 'https://one.test' };

  it('is unknown, not active', () => {
    expect(pushSource(data, remaining, 'https://one.test')).toEqual({ kind: 'unknown' });
    expect(pushSource(data, [], 'https://one.test')).toEqual({ kind: 'unknown' });
  });

  it('is neither answered nor opened, even on the still-connected server', async () => {
    expect(await actOn(data, remaining, 'https://one.test')).toEqual({
      answered: UNKNOWN_SERVER_MESSAGE,
      tapped: 'unknown',
      ...NOTHING_SENT,
    });
  });
});

describe('a tap superseded by another switch while switching', () => {
  const THREE = ORGS; // one.test (active), two.test, three.test
  const tapFromTwo = {
    type: 'session_completed',
    sessionId: 's-two',
    hubServerUrl: 'https://two.test',
  };

  it('does not route two.test’s ids when a newer switch to three.test took over', async () => {
    let current = 'https://one.test';
    let release!: () => void;
    const routeOnActive = vi.fn();
    // Switch to two.test hangs; meanwhile the user switches to three.test,
    // which makes this switch stale.
    const switchTo = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            current = 'https://three.test:3051'.replace(':3051', '');
            resolve(false);
          };
        }),
    );
    const tap = routePushTap({
      data: tapFromTwo,
      orgs: THREE,
      activeServerUrl: current,
      routeOnActive,
      switchTo,
      currentServerUrl: () => current,
    });
    await Promise.resolve();
    release();
    expect(await tap).toBe('superseded');
    expect(routeOnActive).not.toHaveBeenCalled();
  });

  it('does not route when the switch reports current but another server became active right after', async () => {
    let current = 'https://one.test';
    const routeOnActive = vi.fn();
    const switchTo = vi.fn(async () => {
      current = 'https://two.test';
      // A manual switch lands before the tap's continuation runs.
      current = 'http://three.test:3051';
      return true;
    });
    expect(
      await routePushTap({
        data: tapFromTwo,
        orgs: THREE,
        activeServerUrl: 'https://one.test',
        routeOnActive,
        switchTo,
        currentServerUrl: () => current,
      }),
    ).toBe('superseded');
    expect(routeOnActive).not.toHaveBeenCalled();
  });

  it('routes when its switch completed and is still current', async () => {
    let current = 'https://one.test';
    const routeOnActive = vi.fn();
    const outcome = await routePushTap({
      data: tapFromTwo,
      orgs: THREE,
      activeServerUrl: current,
      routeOnActive,
      switchTo: async () => {
        current = 'https://two.test';
        return true;
      },
      currentServerUrl: () => current,
    });
    expect(outcome).toBe('switched');
    expect(routeOnActive).toHaveBeenCalledWith(tapFromTwo);
  });
});

describe('two taps racing through the real org switcher', () => {
  it('only the latest tap routes', async () => {
    const { createOrgSwitcher } = await import('./orgSwitch');
    let current = 'https://one.test';
    const gates: Array<() => void> = [];
    const switchToOrg = createOrgSwitcher({
      switchOrg: (orgId) =>
        new Promise<void>((resolve) =>
          gates.push(() => {
            current = ORGS.find((o) => o.id === orgId)!.remoteUrl.replace(/\/+$/, '');
            resolve();
          }),
        ),
      onConnectionChanged: () => {},
      loadData: async () => {},
    });
    const routed: string[] = [];
    const tap = (hub: string, sessionId: string) =>
      routePushTap({
        data: { type: 'session_completed', sessionId, hubServerUrl: hub },
        orgs: ORGS,
        activeServerUrl: 'https://one.test',
        routeOnActive: (d: any) => routed.push(d.sessionId),
        switchTo: switchToOrg,
        currentServerUrl: () => current,
      });
    const first = tap('https://two.test', 's-two');
    const second = tap('http://three.test:3051', 's-three');
    await Promise.resolve();
    gates[0](); // two.test's switch completes, but it is no longer the latest
    gates[1]();
    expect(await first).toBe('superseded');
    expect(await second).toBe('switched');
    expect(routed).toEqual(['s-three']);
  });
});
