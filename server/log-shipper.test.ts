import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogShipper, initLogShipperFromEnv, _resetLogShipper } from './log-shipper.js';
import { setLogForwarder, type LogEntry } from './server-log.js';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return { ts: '2026-07-20T00:00:00.000Z', level: 'log', message: 'hello', ...over };
}

function okFetch() {
  return vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
}

describe('LogShipper', () => {
  afterEach(async () => {
    await _resetLogShipper();
    setLogForwarder(null);
    vi.restoreAllMocks();
  });

  it('POSTs a JSON batch with Bearer auth and canonical record shape', async () => {
    const fetchImpl = okFetch();
    const shipper = new LogShipper({
      token: 'ahlog_test',
      endpoint: 'https://example.test/api/logs/ingest',
      service: 'agent-hub',
      environment: 'production',
      fetchImpl,
    });
    shipper.enqueue(entry({ level: 'error', message: 'boom' }));
    await shipper.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.test/api/logs/ingest');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer ahlog_test');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(opts.body);
    expect(payload.resource['service.name']).toBe('agent-hub');
    expect(payload.resource['deployment.environment']).toBe('production');
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0]).toMatchObject({
      severityText: 'ERROR',
      body: 'boom',
      timeUnixMillis: Date.parse('2026-07-20T00:00:00.000Z'),
    });
  });

  it('maps console levels to severity text', async () => {
    const fetchImpl = okFetch();
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    shipper.enqueue(entry({ level: 'log' }));
    shipper.enqueue(entry({ level: 'warn' }));
    shipper.enqueue(entry({ level: 'error' }));
    await shipper.flush();
    const sev = JSON.parse(fetchImpl.mock.calls[0][1].body).records.map(
      (r: { severityText: string }) => r.severityText,
    );
    expect(sev).toEqual(['INFO', 'WARN', 'ERROR']);
  });

  it('truncates oversized messages below the 256 KiB per-record cap', async () => {
    const fetchImpl = okFetch();
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    shipper.enqueue(entry({ message: 'x'.repeat(400 * 1024) }));
    await shipper.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body).records[0].body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(body.endsWith('…[truncated]')).toBe(true);
  });

  it('splits into ≤1000-record batches', async () => {
    const fetchImpl = okFetch();
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    for (let i = 0; i < 1500; i++) shipper.enqueue(entry({ message: `m${i}` }));
    await shipper.flush();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetchImpl.mock.calls) {
      expect(JSON.parse(call[1].body).records.length).toBeLessThanOrEqual(1000);
    }
  });

  it('re-queues records on a 5xx and drops them on a 4xx', async () => {
    const fail5xx = vi.fn().mockResolvedValue(new Response('err', { status: 503 }));
    const shipper5 = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl: fail5xx,
    });
    shipper5.enqueue(entry());
    await shipper5.flush();
    // Endpoint recovers: the same record is retried on the next flush.
    const okAgain = okFetch();
    (shipper5 as unknown as { fetchImpl: typeof fetch }).fetchImpl = okAgain;
    await shipper5.flush();
    expect(okAgain).toHaveBeenCalledTimes(1);
    expect(JSON.parse(okAgain.mock.calls[0][1].body).records).toHaveLength(1);

    const fail4xx = vi.fn().mockResolvedValue(new Response('bad token', { status: 401 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const shipper4 = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl: fail4xx,
    });
    shipper4.enqueue(entry());
    await shipper4.flush();
    // Poison-pill dropped, not retried.
    const noRetry = okFetch();
    (shipper4 as unknown as { fetchImpl: typeof fetch }).fetchImpl = noRetry;
    await shipper4.flush();
    expect(noRetry).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('never throws when fetch rejects (fail-safe logging path)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    shipper.enqueue(entry());
    await expect(shipper.flush()).resolves.toBeUndefined();
  });

  // Regression: an unexpected error after takeBatch() dequeues a batch must not
  // silently drop it. post() catches fetch failures itself, but a throw from any
  // future code between dequeue and a successful POST has to requeue.
  it('requeues a dequeued batch when post() throws unexpectedly', async () => {
    const okAgain = okFetch();
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl: okAgain,
    });
    shipper.enqueue(entry({ message: 'keep-me' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const postSpy = vi
      .spyOn(shipper as unknown as { post: (r: unknown[]) => Promise<boolean> }, 'post')
      .mockRejectedValue(new Error('boom'));

    await shipper.flush();
    // Not delivered, but preserved in the queue rather than lost.
    expect(okAgain).not.toHaveBeenCalled();
    expect((shipper as unknown as { queue: unknown[] }).queue).toHaveLength(1);

    // Endpoint path recovers on the next flush — the record is still there.
    postSpy.mockRestore();
    await shipper.flush();
    expect(okAgain).toHaveBeenCalledTimes(1);
    expect(JSON.parse(okAgain.mock.calls[0][1].body).records[0].body).toBe('keep-me');
    expect((shipper as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    stderr.mockRestore();
  });

  // Regression: a record enqueued (with a concurrent flush()) while a drain is
  // already in flight must be delivered by the time the original flush()
  // resolves — not stranded until the next interval / lost on shutdown.
  it('drains records enqueued during an in-flight flush', async () => {
    let releaseFirstPost: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) await gate; // hold the first POST open mid-drain
      return new Response('{}', { status: 200 });
    });
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });

    shipper.enqueue(entry({ message: 'first' }));
    const flushed = shipper.flush(); // starts drain; first POST awaits the gate

    // A late record + a concurrent flush() arrive while the drain is in flight.
    shipper.enqueue(entry({ message: 'late' }));
    void shipper.flush(); // sets flushAgain on the in-flight run

    releaseFirstPost();
    await flushed;

    const bodies = fetchImpl.mock.calls.flatMap((c: unknown[]) =>
      (JSON.parse((c[1] as { body: string }).body).records as Array<{ body: string }>).map(
        (r) => r.body,
      ),
    );
    expect(bodies).toEqual(['first', 'late']);
    expect((shipper as unknown as { queue: unknown[] }).queue).toHaveLength(0);
  });

  // Regression: batches must be budgeted by the *serialized* JSON size, not by
  // raw body length. Escape-heavy messages (every char → 2 bytes when JSON
  // escaped) would blow past the 1 MiB ingest cap under a body.length estimate.
  it('keeps every request under 1 MiB by budgeting serialized JSON size', async () => {
    const fetchImpl = okFetch();
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    // 100 KiB of quotes each → ~200 KiB once JSON-escaped. Raw length would let
    // ~9 fit per request (~1.8 MiB serialized); serialized budgeting must split.
    const N = 12;
    for (let i = 0; i < N; i++) shipper.enqueue(entry({ message: '"'.repeat(100 * 1024) }));
    await shipper.flush();

    const ONE_MIB = 1024 * 1024;
    let delivered = 0;
    for (const call of fetchImpl.mock.calls) {
      const body = call[1].body as string;
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(ONE_MIB);
      delivered += JSON.parse(body).records.length;
    }
    expect(delivered).toBe(N); // nothing dropped
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1); // actually split
  });

  // Regression: a 413 must split-and-retry, never be treated as a permanent
  // drop. Halving the record cap guarantees the batch shrinks to 1 and the loop
  // terminates regardless of why the endpoint rejected the size.
  it('splits and retries on a 413 instead of dropping the batch', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).records.length;
      return n > 1
        ? new Response('too large', { status: 413 })
        : new Response('{}', { status: 200 });
    });
    const shipper = new LogShipper({
      token: 't',
      endpoint: 'https://x.test/i',
      service: 's',
      environment: 'e',
      fetchImpl,
    });
    for (let i = 0; i < 3; i++) shipper.enqueue(entry({ message: `m${i}` }));
    await shipper.flush();

    // All three delivered (as single-record requests); none dropped, queue empty.
    const delivered = fetchImpl.mock.calls
      .map((c) => JSON.parse((c[1] as { body: string }).body).records as Array<{ body: string }>)
      .filter((r) => r.length === 1)
      .flatMap((r) => r.map((x) => x.body));
    expect(delivered.sort()).toEqual(['m0', 'm1', 'm2']);
    expect((shipper as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    expect((shipper as unknown as { droppedRecords: number }).droppedRecords).toBe(0);
  });
});

describe('initLogShipperFromEnv', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    delete process.env.AHLOG_TOKEN;
  });
  afterEach(async () => {
    await _resetLogShipper();
    setLogForwarder(null);
    process.env = { ...orig };
  });

  it('is a no-op without AHLOG_TOKEN', () => {
    expect(initLogShipperFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('warns at boot (not silently) when AHLOG_TOKEN is missing, so an empty Logs module is diagnosable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(initLogShipperFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/self log-shipping DISABLED: AHLOG_TOKEN not set/);
  });

  it('logs the enabled endpoint at boot without ever logging the token', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const shipper = initLogShipperFromEnv({
      AHLOG_TOKEN: 'ahlog_secret_value',
      AGENT_HUB_PORT: '4100',
    } as NodeJS.ProcessEnv);
    expect(shipper).not.toBeNull();
    const enabledLine = log.mock.calls.map((c) => String(c[0])).find((m) => /ENABLED/.test(m));
    expect(enabledLine).toBeDefined();
    expect(enabledLine).toContain('http://127.0.0.1:4100/api/logs/ingest');
    // The secret token must never appear in any boot log line.
    expect(enabledLine).not.toContain('ahlog_secret_value');
  });

  it('starts a shipper when AHLOG_TOKEN is set and forwards captured entries', () => {
    const shipper = initLogShipperFromEnv({ AHLOG_TOKEN: 'ahlog_abc' } as NodeJS.ProcessEnv);
    expect(shipper).not.toBeNull();
    // The seam is now wired: a captured entry reaches the shipper's queue.
    const spy = vi.spyOn(shipper as LogShipper, 'flush').mockResolvedValue();
    for (let i = 0; i < 250; i++) shipper!.enqueue(entry({ message: `m${i}` }));
    expect(spy).toHaveBeenCalled();
  });

  // Guards the deploy contract: the Terraform env-file wiring
  // (ops/terraform/locals-agent-hub.tf) emits exactly these env var names, so a
  // code-side rename here would silently break self log-shipping in prod.
  it('reads AHLOG_ENDPOINT / AHLOG_SERVICE / AHLOG_ENVIRONMENT overrides from env', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const shipper = initLogShipperFromEnv({
      AHLOG_TOKEN: 'ahlog_env',
      AHLOG_ENDPOINT: 'https://custom.test/api/logs/ingest',
      AHLOG_SERVICE: 'custom-svc',
      AHLOG_ENVIRONMENT: 'staging',
    } as NodeJS.ProcessEnv);
    expect(shipper).not.toBeNull();
    shipper!.enqueue(entry());
    await shipper!.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://custom.test/api/logs/ingest');
    expect(opts.headers.Authorization).toBe('Bearer ahlog_env');
    const payload = JSON.parse(opts.body);
    expect(payload.resource['service.name']).toBe('custom-svc');
    expect(payload.resource['deployment.environment']).toBe('staging');
    vi.unstubAllGlobals();
  });

  // Hygiene guard: with no AHLOG_ENDPOINT the shipper posts to the server's own
  // loopback ingest route on AGENT_HUB_PORT — never a hardcoded external/dev-hub
  // hostname (public-repo-hygiene / no-internal-provenance gates).
  it('defaults the endpoint to the loopback ingest route on AGENT_HUB_PORT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const shipper = initLogShipperFromEnv({
      AHLOG_TOKEN: 'ahlog_x',
      AGENT_HUB_PORT: '4000',
    } as NodeJS.ProcessEnv);
    shipper!.enqueue(entry());
    await shipper!.flush();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4000/api/logs/ingest');
    vi.unstubAllGlobals();
  });

  it('falls back to port 3051 for the loopback default when AGENT_HUB_PORT is unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const shipper = initLogShipperFromEnv({ AHLOG_TOKEN: 'ahlog_x' } as NodeJS.ProcessEnv);
    shipper!.enqueue(entry());
    await shipper!.flush();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3051/api/logs/ingest');
    vi.unstubAllGlobals();
  });
});
