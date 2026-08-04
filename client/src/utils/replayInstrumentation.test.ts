import { describe, it, expect, vi } from 'vitest';
import {
  installReplayInstrumentation,
  redactSensitiveText,
  redactUrlForReplay,
  formatConsoleArgs,
  formatStack,
  TelemetryRateLimiter,
  REPLAY_CONSOLE_TAG,
  REPLAY_NETWORK_TAG,
  RRWEB_CUSTOM_EVENT_TYPE,
  MAX_URL_CHARS,
} from './replayInstrumentation';

/** Minimal window stand-in: listener registry + patchable fetch/XHR slots. */
function makeWin(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(e: any) => void>>();
  return {
    location: { href: 'https://app.example.com/dashboard' },
    addEventListener(type: string, fn: (e: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, event: any) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    ...extra,
  } as any;
}

function collector() {
  const events: any[] = [];
  return {
    events,
    emit: (e: any) => events.push(e),
    byTag: (tag: string) => events.filter((e) => e.data.tag === tag).map((e) => e.data.payload),
  };
}

describe('redactSensitiveText', () => {
  it('masks bearer tokens, JWTs, and vendor API keys', () => {
    const out = redactSensitiveText(
      'Authorization: Bearer abc123def456ghi789 failed; jwt=eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM key sk-livedeadbeefcafe',
    );
    expect(out).not.toContain('abc123def456ghi789');
    expect(out).not.toContain('eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM');
    expect(out).not.toContain('sk-livedeadbeefcafe');
    expect(out).toContain('[redacted]');
  });

  it('masks assignment-style secrets and email addresses', () => {
    const out = redactSensitiveText('login failed for jane.doe@customer.io password=hunter2xyz');
    expect(out).not.toContain('jane.doe@customer.io');
    expect(out).not.toContain('hunter2xyz');
    expect(out).toContain('[email]');
  });

  it('leaves ordinary diagnostic text intact', () => {
    const msg = "TypeError: Cannot read properties of undefined (reading 'id')";
    expect(redactSensitiveText(msg)).toBe(msg);
  });

  it('is stable across repeated calls (global regex lastIndex is reset)', () => {
    const input = 'a@b.com and c@d.com';
    expect(redactSensitiveText(input)).toBe(redactSensitiveText(input));
  });

  // Regression: the assignment matcher required a word boundary before `token`,
  // which `_` is not — so `access_token=…` sailed through verbatim in console
  // messages and exception stacks even though the URL-query rule masked it.
  it.each([
    'access_token=abc123short',
    'refresh_token: xyz789tiny',
    'X-Auth-Token=qq11ww22',
    'api_key = "kkkk1111"',
    'session_id=sess_88',
    'accessToken: "abc123short"',
    'apiKey=kkkk1111',
  ])('masks the value in %s', (input) => {
    const out = redactSensitiveText(`request failed — ${input} rejected`);
    expect(out).toContain('[redacted]');
    for (const secret of ['abc123short', 'xyz789tiny', 'qq11ww22', 'kkkk1111', 'sess_88']) {
      expect(out).not.toContain(secret);
    }
  });

  it('masks query secrets inside a URL embedded in a console message', () => {
    const out = redactSensitiveText(
      'GET https://api.example.com/v1/me?access_token=leakme123&page=2 failed',
    );
    expect(out).not.toContain('leakme123');
    expect(out).toContain('access_token=[redacted]');
    // Non-sensitive params still survive — the message stays diagnostic.
    expect(out).toContain('page=2');
  });

  it('masks query secrets inside a stack frame and keeps the line:col suffix', () => {
    const out = redactSensitiveText(
      'at fetchUser (https://app.example.com/assets/app.js?token=deadbeef01:1421:19)',
    );
    expect(out).not.toContain('deadbeef01');
    expect(out).toContain('token=[redacted]');
    // The frame position is the most useful part of the line — it must survive.
    expect(out).toContain(':1421:19');
    expect(out).toContain('/assets/app.js');
  });

  it('strips credentials from a URL embedded in free text', () => {
    const out = redactSensitiveText('retrying https://admin:hunter2pass@api.example.com/sync now');
    expect(out).not.toContain('hunter2pass');
    expect(out).toContain('https://api.example.com/sync');
  });

  it('does not mangle ordinary assignments that merely contain a key word', () => {
    expect(redactSensitiveText('monkey=banana')).toBe('monkey=banana');
    expect(redactSensitiveText('keyboard=qwerty')).toBe('keyboard=qwerty');
    expect(redactSensitiveText('count=42')).toBe('count=42');
  });

  it('leaves a plain URL with no secrets alone', () => {
    const msg = 'POST https://api.example.com/v1/orders returned 500';
    expect(redactSensitiveText(msg)).toBe(msg);
  });

  // Regression: the value matcher stopped at whitespace and punctuation, so a
  // quoted value containing either failed to match AT ALL and shipped verbatim.
  it.each([
    ['password="my secret passphrase"', 'my secret passphrase'],
    ["token='a,b;c d'", 'a,b;c d'],
    ['api_key: "key with spaces"', 'key with spaces'],
    ['{"access_token": "tok en, with punctuation"}', 'tok en, with punctuation'],
    ['apiKey="camel quoted value"', 'camel quoted value'],
  ])('consumes the whole quoted value in %s', (input, secret) => {
    const out = redactSensitiveText(`config ${input} loaded`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    // The trailing context survives — only the value was replaced.
    expect(out).toContain('loaded');
  });

  it('preserves the quote style around a masked value', () => {
    expect(redactSensitiveText('password="my secret"')).toBe('password="[redacted]"');
    expect(redactSensitiveText("password='my secret'")).toBe("password='[redacted]'");
    expect(redactSensitiveText('password=mysecret')).toBe('password=[redacted]');
  });

  it('masks an escaped quote inside the value without stopping early', () => {
    const out = redactSensitiveText('password="say \\"hi\\" now" done');
    expect(out).not.toContain('hi');
    expect(out).toContain('done');
  });

  it('masks to end of line when the quote is never closed', () => {
    const out = redactSensitiveText('password="unterminated secret value');
    expect(out).not.toContain('unterminated secret value');
    expect(out).toContain('[redacted]');
  });

  it('is idempotent over quoted and bare values', () => {
    for (const input of ['password="my secret"', 'token=abc123xyz', "api_key='a b c'"]) {
      const once = redactSensitiveText(input);
      expect(redactSensitiveText(once)).toBe(once);
    }
  });
});

describe('redactUrlForReplay', () => {
  it('keeps origin and path', () => {
    expect(redactUrlForReplay('https://api.example.com/v1/orders/42')).toBe(
      'https://api.example.com/v1/orders/42',
    );
  });

  it('keeps query keys but masks sensitive values', () => {
    const out = redactUrlForReplay('https://api.example.com/v1/me?access_token=supersecret&page=2');
    expect(out).toContain('access_token=[redacted]');
    expect(out).toContain('page=2');
    expect(out).not.toContain('supersecret');
  });

  it('masks long or punctuated query values it cannot vouch for', () => {
    const out = redactUrlForReplay('https://api.example.com/s?q=find%20my%20order%20please');
    expect(out).toBe('https://api.example.com/s?q=…');
  });

  it('strips embedded credentials and the fragment', () => {
    const out = redactUrlForReplay('https://user:pa55word@api.example.com/v1/x#section');
    expect(out).toBe('https://api.example.com/v1/x');
    expect(out).not.toContain('pa55word');
  });

  it('resolves relative URLs against the supplied base', () => {
    expect(redactUrlForReplay('/api/session', 'https://app.example.com/dashboard')).toBe(
      'https://app.example.com/api/session',
    );
  });

  it('falls back to a redacted, truncated string for unparseable input', () => {
    const out = redactUrlForReplay(`not a url ${'x'.repeat(1000)}`);
    expect(out.length).toBeLessThanOrEqual(MAX_URL_CHARS);
  });
});

describe('formatConsoleArgs / formatStack', () => {
  it('renders errors, objects, and primitives on one redacted line', () => {
    const out = formatConsoleArgs(['save failed', new TypeError('boom'), { id: 7 }, null]);
    expect(out).toBe('save failed TypeError: boom {"id":7} null');
  });

  it('flattens newlines so one message cannot forge extra log lines', () => {
    expect(formatConsoleArgs(['line1\nline2'])).toBe('line1 ⏎ line2');
  });

  it('survives circular objects', () => {
    const circular: any = {};
    circular.self = circular;
    expect(formatConsoleArgs([circular])).toBe('[unserializable]');
  });

  it('truncates to the requested budget', () => {
    expect(formatConsoleArgs([Array(200).fill('word').join(' ')], 50)).toHaveLength(50);
  });

  it('masks an unbroken long blob rather than shipping it verbatim', () => {
    // Over-eager by design: an opaque 500-char run is far likelier to be a
    // token or serialized payload than a useful diagnostic string.
    expect(formatConsoleArgs(['y'.repeat(500)])).toBe('[redacted]');
  });

  it('keeps only the head frames of a stack', () => {
    const stack = ['Error: boom', ' at a (f.js:1:1)', ' at b (f.js:2:2)', ' at c (f.js:3:3)'].join(
      '\n',
    );
    const out = formatStack(stack, 2);
    expect(out).toBe('Error: boom | at a (f.js:1:1) | at b (f.js:2:2)');
  });
});

describe('TelemetryRateLimiter', () => {
  it('bounds events per window and refills on the next window', () => {
    const limiter = new TelemetryRateLimiter(2, 1000, 100);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(10)).toBe(true);
    expect(limiter.allow(20)).toBe(false);
    expect(limiter.allow(1100)).toBe(true);
  });

  it('enforces a hard per-page ceiling across windows', () => {
    const limiter = new TelemetryRateLimiter(10, 1000, 3);
    for (let i = 0; i < 3; i++) expect(limiter.allow(i * 5000)).toBe(true);
    expect(limiter.allow(999999)).toBe(false);
    expect(limiter.emitted).toBe(3);
  });
});

describe('installReplayInstrumentation — console capture', () => {
  it('emits an rrweb custom event per console error and still calls through', () => {
    const sink = collector();
    const original = vi.fn();
    const consoleObj: any = { error: original };
    const uninstall = installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win: makeWin(),
      now: () => 1234,
      captureNetwork: false,
    });

    consoleObj.error('save failed', new TypeError('boom'));

    expect(original).toHaveBeenCalledWith('save failed', new TypeError('boom'));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: RRWEB_CUSTOM_EVENT_TYPE,
      timestamp: 1234,
      data: { tag: REPLAY_CONSOLE_TAG },
    });
    expect(sink.byTag(REPLAY_CONSOLE_TAG)[0]).toMatchObject({
      level: 'error',
      message: 'save failed TypeError: boom',
    });
    uninstall();
    expect(consoleObj.error).toBe(original);
  });

  it('redacts secrets out of console arguments', () => {
    const sink = collector();
    const consoleObj: any = { error: vi.fn() };
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win: makeWin(),
      captureNetwork: false,
    });
    consoleObj.error('auth failed for admin@corp.com token=abcd1234efgh5678');
    const [payload] = sink.byTag(REPLAY_CONSOLE_TAG);
    expect(payload.message).not.toContain('admin@corp.com');
    expect(payload.message).not.toContain('abcd1234efgh5678');
  });

  it('does not capture console.log by default', () => {
    const sink = collector();
    const consoleObj: any = { error: vi.fn(), log: vi.fn() };
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win: makeWin(),
      captureNetwork: false,
    });
    consoleObj.log('chatty');
    expect(sink.events).toHaveLength(0);
  });

  it('captures uncaught errors and unhandled rejections with a stack head', () => {
    const sink = collector();
    const win = makeWin();
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: {},
      win,
      captureNetwork: false,
    });

    win.dispatch('error', {
      message: 'Uncaught TypeError: x is not a function',
      filename: 'https://app.example.com/app.js',
      lineno: 42,
      colno: 7,
      error: { stack: 'TypeError: x is not a function\n at handleClick (app.js:42:7)' },
    });
    win.dispatch('unhandledrejection', { reason: new Error('save rejected') });

    const payloads = sink.byTag(REPLAY_CONSOLE_TAG);
    expect(payloads[0]).toMatchObject({ level: 'exception' });
    expect(payloads[0].message).toContain('Uncaught TypeError');
    expect(payloads[0].message).toContain('app.js:42:7');
    expect(payloads[0].stack).toContain('handleClick');
    expect(payloads[1]).toMatchObject({
      level: 'unhandledrejection',
      message: 'Error: save rejected',
    });
  });

  it('never lets a capture failure break the console call', () => {
    const original = vi.fn();
    const consoleObj: any = { error: original };
    installReplayInstrumentation({
      emit: () => {
        throw new Error('emit exploded');
      },
      consoleObj,
      win: makeWin(),
      captureNetwork: false,
    });
    expect(() => consoleObj.error('still works')).not.toThrow();
    expect(original).toHaveBeenCalled();
  });

  // Regression: only fetch/XHR carried a patch marker, so a second install
  // double-wrapped console.error and registered duplicate window listeners —
  // duplicate telemetry, and the shared rate limit burned twice as fast.
  it('does not stack console wrappers on a second install', () => {
    const first = collector();
    const second = collector();
    const original = vi.fn();
    const consoleObj: any = { error: original };
    const win = makeWin();
    const uninstallA = installReplayInstrumentation({
      emit: first.emit,
      consoleObj,
      win,
      captureNetwork: false,
    });
    const patchedOnce = consoleObj.error;
    const uninstallB = installReplayInstrumentation({
      emit: second.emit,
      consoleObj,
      win,
      captureNetwork: false,
    });

    // One wrapper, shared by both owners — not a wrapper around a wrapper.
    expect(consoleObj.error).toBe(patchedOnce);
    consoleObj.error('once please');
    expect(original).toHaveBeenCalledTimes(1);
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);

    uninstallA();
    uninstallB();
    expect(consoleObj.error).toBe(original);
  });

  it('does not stack window listeners on a second install', () => {
    const first = collector();
    const second = collector();
    const win = makeWin();
    const uninstallA = installReplayInstrumentation({
      emit: first.emit,
      consoleObj: {},
      win,
      captureNetwork: false,
    });
    const uninstallB = installReplayInstrumentation({
      emit: second.emit,
      consoleObj: {},
      win,
      captureNetwork: false,
    });

    expect(win.listenerCount('error')).toBe(1);
    win.dispatch('error', { message: 'boom' });
    // One listener, one event per attached owner.
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);

    uninstallA();
    uninstallB();
    expect(win.listenerCount('error')).toBe(0);
  });

  // Regression: the second install used to be dropped entirely — its emitter
  // was discarded, so overlapping recorders silently received nothing, and
  // stopping the first one removed the patches from under the second.
  it('delivers telemetry to BOTH owners when two installs overlap', () => {
    const first = collector();
    const second = collector();
    const consoleObj: any = { error: vi.fn() };
    const win = makeWin();

    const detachFirst = installReplayInstrumentation({
      emit: first.emit,
      consoleObj,
      win,
      captureNetwork: false,
    });
    const detachSecond = installReplayInstrumentation({
      emit: second.emit,
      consoleObj,
      win,
      captureNetwork: false,
    });

    consoleObj.error('shared event');
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);

    // Detaching the first owner must not silence the second.
    detachFirst();
    consoleObj.error('second owner still listening');
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(2);

    detachSecond();
    consoleObj.error('nobody home');
    expect(second.events).toHaveLength(2);
  });

  it('keeps the window-listener and network surfaces alive for the second owner', () => {
    const first = collector();
    const second = collector();
    const win = makeWin({
      fetch: vi.fn(async () => ({ status: 200, url: 'https://api.example.com/x' })),
    });

    const detachFirst = installReplayInstrumentation({ emit: first.emit, consoleObj: {}, win });
    installReplayInstrumentation({ emit: second.emit, consoleObj: {}, win });

    expect(win.listenerCount('error')).toBe(1);
    detachFirst();
    // Patches stay in place while the second owner is still attached.
    expect(win.listenerCount('error')).toBe(1);

    win.dispatch('error', { message: 'after first detach' });
    expect(second.byTag(REPLAY_CONSOLE_TAG)).toHaveLength(1);
    expect(first.events).toHaveLength(0);
  });

  it('restores the originals only when the last owner detaches', () => {
    const originalFetch = vi.fn();
    const originalError = vi.fn();
    const consoleObj: any = { error: originalError };
    const win = makeWin({ fetch: originalFetch });

    const detachA = installReplayInstrumentation({ emit: () => {}, consoleObj, win });
    const detachB = installReplayInstrumentation({ emit: () => {}, consoleObj, win });

    detachA();
    expect(consoleObj.error).not.toBe(originalError);
    expect(win.fetch).not.toBe(originalFetch);

    detachB();
    expect(consoleObj.error).toBe(originalError);
    expect(win.fetch).toBe(originalFetch);
    expect(win.listenerCount('error')).toBe(0);
  });

  it('rate-limits each owner independently', () => {
    const busy = collector();
    const quiet = collector();
    const consoleObj: any = { error: vi.fn() };
    const win = makeWin();

    installReplayInstrumentation({
      emit: busy.emit,
      consoleObj,
      win,
      now: () => 0,
      captureNetwork: false,
      limiter: new TelemetryRateLimiter(1, 1000, 100),
    });
    installReplayInstrumentation({
      emit: quiet.emit,
      consoleObj,
      win,
      now: () => 0,
      captureNetwork: false,
      limiter: new TelemetryRateLimiter(5, 1000, 100),
    });

    for (let i = 0; i < 4; i++) consoleObj.error('burst', i);
    expect(busy.events).toHaveLength(1);
    expect(quiet.events).toHaveLength(4);
  });

  // Regression: the first owner's `levels` froze the shared console surface, so
  // an error-only owner followed by a warn-only owner meant `console.warn` was
  // never patched and the second owner captured nothing.
  it('widens the shared console surface to the union of every owner levels', () => {
    const errorOwner = collector();
    const warnOwner = collector();
    const consoleObj: any = { error: vi.fn(), warn: vi.fn() };
    const win = makeWin();

    installReplayInstrumentation({
      emit: errorOwner.emit,
      consoleObj,
      win,
      levels: ['error'],
      captureNetwork: false,
    });
    installReplayInstrumentation({
      emit: warnOwner.emit,
      consoleObj,
      win,
      levels: ['warn'],
      captureNetwork: false,
    });

    consoleObj.warn('late-arriving level');
    // The second owner's level got patched even though the first never asked.
    expect(warnOwner.byTag(REPLAY_CONSOLE_TAG)[0]).toMatchObject({
      level: 'warn',
      message: 'late-arriving level',
    });
  });

  it('does not deliver a level an owner never requested', () => {
    const errorOwner = collector();
    const warnOwner = collector();
    const consoleObj: any = { error: vi.fn(), warn: vi.fn() };
    const win = makeWin();

    installReplayInstrumentation({
      emit: errorOwner.emit,
      consoleObj,
      win,
      levels: ['error'],
      captureNetwork: false,
    });
    installReplayInstrumentation({
      emit: warnOwner.emit,
      consoleObj,
      win,
      levels: ['warn'],
      captureNetwork: false,
    });

    consoleObj.warn('warn only');
    consoleObj.error('error only');

    // Widening for one owner must not start leaking that level to the other.
    expect(errorOwner.byTag(REPLAY_CONSOLE_TAG).map((p: any) => p.level)).toEqual(['error']);
    expect(warnOwner.byTag(REPLAY_CONSOLE_TAG).map((p: any) => p.level)).toEqual(['warn']);
  });

  it('does not spend an owner rate budget on levels it filtered out', () => {
    const errorOwner = collector();
    const consoleObj: any = { error: vi.fn(), warn: vi.fn() };
    const win = makeWin();

    installReplayInstrumentation({
      emit: errorOwner.emit,
      consoleObj,
      win,
      now: () => 0,
      levels: ['error'],
      captureNetwork: false,
      limiter: new TelemetryRateLimiter(1, 1000, 100),
    });
    installReplayInstrumentation({
      emit: () => {},
      consoleObj,
      win,
      levels: ['warn'],
      captureNetwork: false,
    });

    consoleObj.warn('not mine');
    consoleObj.error('mine');
    expect(errorOwner.byTag(REPLAY_CONSOLE_TAG)).toHaveLength(1);
    expect(errorOwner.byTag(REPLAY_CONSOLE_TAG)[0].message).toBe('mine');
  });

  it('still delivers uncaught errors to an owner that requested no console levels', () => {
    const sink = collector();
    const win = makeWin();
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: { error: vi.fn() },
      win,
      levels: [],
      captureNetwork: false,
    });

    win.dispatch('error', { message: 'window level, not a console method' });
    // `exception` is not a console method, so a console-level filter must not
    // swallow it.
    expect(sink.byTag(REPLAY_CONSOLE_TAG)[0]).toMatchObject({ level: 'exception' });
  });

  it('detaching twice is harmless', () => {
    const sink = collector();
    const originalError = vi.fn();
    const consoleObj: any = { error: originalError };
    const detach = installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win: makeWin(),
      captureNetwork: false,
    });
    detach();
    detach();
    expect(consoleObj.error).toBe(originalError);
  });

  it('re-installs cleanly after an uninstall (stop/start cycle)', () => {
    const sink = collector();
    const original = vi.fn();
    const consoleObj: any = { error: original };
    const win = makeWin();

    installReplayInstrumentation({ emit: sink.emit, consoleObj, win, captureNetwork: false })();
    expect(consoleObj.error).toBe(original);

    const uninstall = installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win,
      captureNetwork: false,
    });
    consoleObj.error('after restart');
    expect(sink.events).toHaveLength(1);
    expect(win.listenerCount('error')).toBe(1);
    uninstall();
  });

  it('removes its window listeners on uninstall', () => {
    const win = makeWin();
    const uninstall = installReplayInstrumentation({
      emit: () => {},
      consoleObj: {},
      win,
      captureNetwork: false,
    });
    expect(win.listenerCount('error')).toBe(1);
    uninstall();
    expect(win.listenerCount('error')).toBe(0);
  });
});

describe('installReplayInstrumentation — network capture', () => {
  it('records method, redacted url, status, and duration for fetch', async () => {
    const sink = collector();
    let clock = 0;
    const originalFetch = vi.fn(async () => ({ status: 500, url: 'https://api.example.com/save' }));
    const win = makeWin({ fetch: originalFetch });
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: {},
      win,
      now: () => clock,
      captureConsole: false,
    });

    clock = 100;
    const p = win.fetch('/save?access_token=leakme', { method: 'POST' });
    clock = 350;
    await p;

    expect(originalFetch).toHaveBeenCalled();
    expect(sink.byTag(REPLAY_NETWORK_TAG)[0]).toEqual({
      kind: 'fetch',
      method: 'POST',
      url: 'https://api.example.com/save',
      status: 500,
      durationMs: 250,
    });
  });

  it('records rejected fetches with status 0 and rethrows', async () => {
    const sink = collector();
    const originalFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const win = makeWin({ fetch: originalFetch });
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: {},
      win,
      now: () => 0,
      captureConsole: false,
    });

    await expect(win.fetch('/api/orders')).rejects.toThrow('Failed to fetch');
    expect(sink.byTag(REPLAY_NETWORK_TAG)[0]).toMatchObject({
      status: 0,
      url: 'https://app.example.com/api/orders',
      error: 'TypeError: Failed to fetch',
    });
  });

  it('never captures request or response bodies', async () => {
    const sink = collector();
    const win = makeWin({
      fetch: vi.fn(async () => ({ status: 200, url: 'https://api.example.com/login' })),
    });
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: {},
      win,
      captureConsole: false,
    });
    await win.fetch('/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'hunter2' }),
      headers: { Authorization: 'Bearer abc123def456' },
    });
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc123def456');
  });

  it('captures XHR outcomes on loadend', () => {
    const sink = collector();
    let clock = 0;
    class FakeXHR {
      status = 0;
      private handlers: Record<string, Array<() => void>> = {};
      open(_method: string, _url: string) {}
      send() {}
      addEventListener(type: string, fn: () => void) {
        (this.handlers[type] ??= []).push(fn);
      }
      finish(status: number) {
        this.status = status;
        for (const fn of this.handlers.loadend ?? []) fn();
      }
    }
    const win = makeWin({ XMLHttpRequest: FakeXHR });
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj: {},
      win,
      now: () => clock,
      captureConsole: false,
    });

    const xhr = new FakeXHR() as any;
    clock = 10;
    xhr.open('GET', '/api/profile');
    xhr.send();
    clock = 40;
    xhr.finish(404);

    expect(sink.byTag(REPLAY_NETWORK_TAG)[0]).toEqual({
      kind: 'xhr',
      method: 'GET',
      url: 'https://app.example.com/api/profile',
      status: 404,
      durationMs: 30,
    });
  });

  it('restores fetch and XHR on uninstall', () => {
    const originalFetch = vi.fn();
    const originalOpen = function () {};
    const FakeXHR = function () {} as unknown as { prototype: any };
    FakeXHR.prototype = { open: originalOpen, send: function () {} };
    const win = makeWin({ fetch: originalFetch, XMLHttpRequest: FakeXHR });
    const uninstall = installReplayInstrumentation({
      emit: () => {},
      consoleObj: {},
      win,
      captureConsole: false,
    });
    expect(win.fetch).not.toBe(originalFetch);
    uninstall();
    expect(win.fetch).toBe(originalFetch);
    expect((FakeXHR as any).prototype.open).toBe(originalOpen);
  });

  it('drops telemetry once the rate limit is exhausted', () => {
    const sink = collector();
    const consoleObj: any = { error: vi.fn() };
    installReplayInstrumentation({
      emit: sink.emit,
      consoleObj,
      win: makeWin(),
      now: () => 0,
      captureNetwork: false,
      limiter: new TelemetryRateLimiter(2, 1000, 100),
    });
    for (let i = 0; i < 10; i++) consoleObj.error('loop', i);
    expect(sink.events).toHaveLength(2);
    // …but the app's own console still received every call.
    expect(consoleObj.error).toBeDefined();
  });
});
