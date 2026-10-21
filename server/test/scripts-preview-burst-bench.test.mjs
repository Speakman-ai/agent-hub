import { describe, it, expect, vi } from 'vitest';
import {
  buildReport,
  classifyPreviewState,
  formatBurstReport,
  parseArgs,
  summarizeHostSamples,
  summarizePhase,
} from '../../scripts/lib/preview-burst-bench-core.mjs';
import { main } from '../../scripts/preview-burst-bench.mjs';

describe('classifyPreviewState', () => {
  it('maps the preview/state wire kinds to phases', () => {
    expect(classifyPreviewState(null)).toBe('none');
    expect(classifyPreviewState(undefined)).toBe('none');
    expect(classifyPreviewState({ kind: 'preview_starting' })).toBe('starting');
    expect(classifyPreviewState({ kind: 'preview' })).toBe('ready');
    expect(classifyPreviewState({ kind: 'preview_failed' })).toBe('failed');
    expect(classifyPreviewState({ kind: 'something_new' })).toBe('unknown');
  });
});

describe('summarizePhase', () => {
  it('counts sessions that never reached the phase as missing, not as fast', () => {
    const s = summarizePhase(
      [
        { phases: { previewReadyMs: 1000 } },
        { phases: { previewReadyMs: 3000 } },
        { phases: { previewReadyMs: null } },
      ],
      'previewReadyMs',
    );
    expect(s.count).toBe(2);
    expect(s.missing).toBe(1);
    expect(s.p50).toBe(2000);
    expect(s.max).toBe(3000);
  });

  it('returns nulls when no session reached the phase', () => {
    const s = summarizePhase([{ phases: {} }], 'workspaceReadyMs');
    expect(s).toMatchObject({ count: 0, missing: 1, p50: null, p95: null });
  });
});

describe('summarizeHostSamples', () => {
  it('reports peak load relative to cpu count and the lowest free memory', () => {
    const gb = 1024 ** 3;
    const s = summarizeHostSamples(
      [
        { atMs: 0, load1: 1.0, freeMemBytes: 8 * gb, totalMemBytes: 16 * gb },
        { atMs: 1000, load1: 6.0, freeMemBytes: 2 * gb, totalMemBytes: 16 * gb },
        { atMs: 2000, load1: 3.0, freeMemBytes: 5 * gb, totalMemBytes: 16 * gb },
      ],
      4,
    );
    expect(s.sampled).toBe(true);
    expect(s.peakLoad1).toBe(6);
    expect(s.peakLoadPerCpu).toBe(1.5);
    expect(s.minFreeMemBytes).toBe(2 * gb);
  });

  it('marks an empty sample set as not sampled', () => {
    expect(summarizeHostSamples([], 4).sampled).toBe(false);
  });
});

describe('buildReport / formatBurstReport', () => {
  it('lists failures with their session ids and renders missing counts', () => {
    const report = buildReport({
      results: [
        {
          sessionId: 'a',
          ok: true,
          phases: { workspaceReadyMs: 5000, previewReadyMs: 20000, totalMs: 25100 },
        },
        {
          sessionId: 'b',
          ok: false,
          error: 'preview failed: boom',
          phases: { workspaceReadyMs: 6000, previewReadyMs: null, totalMs: null },
        },
      ],
      hostSamples: [],
      cpuCount: 2,
      sessions: 2,
      startedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ sessionId: 'b', error: 'preview failed: boom' }]);
    const md = formatBurstReport(report);
    expect(md).toContain('## Preview burst: 2 sessions');
    expect(report.phases.total).toMatchObject({
      count: 1,
      missing: 1,
      p50: 25100,
      p95: 25100,
      max: 25100,
    });
    expect(md).toContain('workspace ready: p50 5500ms, p95 5950ms, max 6000ms');
    expect(md).toContain('preview boot: p50 20.0s, p95 20.0s, max 20.0s (1 never reached)');
    expect(md).toContain('total: p50 25.1s, p95 25.1s, max 25.1s (1 never reached)');
    expect(md).toContain('host: not sampled');
    expect(md).toContain('- b: preview failed: boom');
  });
});

describe('parseArgs', () => {
  it('requires --agent', () => {
    expect(parseArgs(['--sessions', '5'])).toEqual({ error: '--agent <agentId> is required' });
  });

  it('applies defaults and parses flags', () => {
    const { options } = parseArgs([
      '--agent',
      'dev',
      '--sessions',
      '3',
      '--keep',
      '--no-host-sample',
      '--json',
    ]);
    expect(options).toMatchObject({
      agent: 'dev',
      sessions: 3,
      keep: true,
      hostSample: false,
      json: true,
      pollIntervalMs: 2000,
      timeoutMs: 600_000,
    });
  });

  it('rejects unknown flags and non-positive numbers', () => {
    expect(parseArgs(['--agent', 'dev', '--bogus'])).toEqual({ error: 'unknown flag: --bogus' });
    expect(parseArgs(['--agent', 'dev', '--sessions', '0']).error).toMatch(/positive number/);
  });
});

describe('main (CLI entry)', () => {
  function mkStream() {
    const chunks = [];
    return { write: (c) => chunks.push(String(c)), read: () => chunks.join('') };
  }
  const json = (status, body) => ({
    status,
    ok: status < 400,
    text: async () => JSON.stringify(body),
  });
  const env = { AGENT_HUB_URL: 'http://localhost:3051', AGENT_HUB_API_KEY: 'k' };
  const noHost = {
    sampleHost: () => ({ load1: 1, freeMemBytes: 1, totalMemBytes: 2 }),
    cpuCount: 2,
  };

  /**
   * A fake Hub: sessions become ready after `readyAfterPolls` state polls;
   * session ids listed in `failing` report preview_failed instead.
   * `onCreate(init)` / `onEnsure(init)` / `onStart(init)` run before the
   * create-session, workspace/ensure and preview/start responses, so a test can make a step slow (advance the
   * fake clock) or hang until aborted.
   */
  function fakeHub({ readyAfterPolls = 2, failing = new Set(), onCreate, onEnsure, onStart } = {}) {
    let nextId = 0;
    const polls = new Map();
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u.replace('http://localhost:3051', '')}`);
      if (u.endsWith('/api/health')) return json(200, { status: 'ok' });
      if (method === 'POST' && u.endsWith('/sessions')) {
        if (onCreate) await onCreate(init);
        return json(200, { id: `s${++nextId}` });
      }
      if (u.endsWith('/workspace/ensure')) {
        if (onEnsure) await onEnsure(init);
        return json(200, { ok: true, skipped: false });
      }
      if (u.endsWith('/preview/start')) {
        if (onStart) await onStart(init);
        return json(200, { ok: true, started: true });
      }
      if (u.endsWith('/preview/state')) {
        const id = u.match(/sessions\/([^/]+)\//)[1];
        const n = (polls.get(id) ?? 0) + 1;
        polls.set(id, n);
        if (failing.has(id))
          return json(200, { event: { kind: 'preview_failed', logTail: ['EADDRINUSE'] } });
        if (n >= readyAfterPolls) return json(200, { event: { kind: 'preview' } });
        return json(200, { event: n === 1 ? null : { kind: 'preview_starting' } });
      }
      if (method === 'DELETE') return json(200, { ok: true, archived: true });
      return json(404, { error: `unexpected ${method} ${u}` });
    });
    return { fetchImpl, calls };
  }

  it('prints usage for --help and exits 0', async () => {
    const stdout = mkStream();
    const code = await main({ argv: ['--help'], stdout, stderr: mkStream() });
    expect(code).toBe(0);
    expect(stdout.read()).toContain('usage: preview-burst-bench');
  });

  it('exits 2 on a usage error', async () => {
    const stderr = mkStream();
    const code = await main({ argv: ['--sessions', '2'], stdout: mkStream(), stderr });
    expect(code).toBe(2);
    expect(stderr.read()).toMatch(/--agent <agentId> is required/);
  });

  it('exits 3 when the Hub is unreachable', async () => {
    const stderr = mkStream();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '1'],
      stdout: mkStream(),
      stderr,
      fetchImpl,
      env,
      ...noHost,
    });
    expect(code).toBe(3);
    expect(stderr.read()).toMatch(/cannot reach Agent Hub/);
  });

  it('runs every session concurrently, polls to ready, cleans up and exits 0', async () => {
    const hub = fakeHub({ readyAfterPolls: 3 });
    const stdout = mkStream();
    let t = 0;
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '3', '--poll-interval-ms', '10', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      ...noHost,
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout.read());
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.phases.previewReady.count).toBe(3);
    expect(report.phases.total.count).toBe(3);
    // Boot time is measured from preview/start; total from the burst start,
    // so total is never shorter than the boot.
    expect(report.phases.total.p50).toBeGreaterThanOrEqual(report.phases.previewReady.p50);
    expect(report.host.sampled).toBe(true);
    // Every session was created, ensured, started and archived.
    expect(hub.calls.filter((c) => c.endsWith('/workspace/ensure'))).toHaveLength(3);
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(3);
  });

  it('stops a session whose provisioning overran the budget before issuing preview/start', async () => {
    let t = 0;
    // workspace/ensure takes 800ms of fake time against a 500ms budget.
    const hub = fakeHub({
      onEnsure: () => {
        t += 800;
      },
    });
    const stdout = mkStream();
    const code = await main({
      argv: [
        '--agent',
        'dev',
        '--sessions',
        '1',
        '--poll-interval-ms',
        '10',
        '--timeout-ms',
        '500',
        '--json',
      ],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0].error).toBe('preview/start skipped: 500ms budget exhausted');
    // The late workspace timing is still recorded; it is the number that explains the miss.
    expect(report.phases.workspaceReady.count).toBe(1);
    expect(hub.calls.some((c) => c.endsWith('/preview/start'))).toBe(false);
    expect(hub.calls.some((c) => c.endsWith('/preview/state'))).toBe(false);
    // The session is still archived.
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
  });

  it('archives a session whose creation response landed after the budget', async () => {
    let t = 0;
    const hub = fakeHub({
      onCreate: () => {
        t += 800;
      },
    });
    const stdout = mkStream();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '1', '--timeout-ms', '500', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      now: () => t,
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0]).toEqual({
      sessionId: 's1',
      error: 'workspace/ensure skipped: 500ms budget exhausted',
    });
    expect(hub.calls.some((c) => c.endsWith('/workspace/ensure'))).toBe(false);
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/sessions/s1']);
  });

  it('does not poll preview/state when preview/start answered after the budget', async () => {
    let t = 0;
    const hub = fakeHub({
      onStart: () => {
        t += 800;
      },
    });
    const stdout = mkStream();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '1', '--timeout-ms', '500', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      now: () => t,
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0].error).toBe('preview/state skipped: 500ms budget exhausted');
    expect(hub.calls.some((c) => c.endsWith('/preview/state'))).toBe(false);
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/sessions/s1']);
  });

  it('issues no requests at all for a session whose budget is already exhausted', async () => {
    let t = 1000;
    const hub = fakeHub();
    const stdout = mkStream();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '1', '--timeout-ms', '500', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      // Clock jumps past the budget between the burst start and the first step.
      now: () => (t += 600),
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0].error).toBe('create session skipped: 500ms budget exhausted');
    expect(hub.calls.filter((c) => !c.endsWith('/api/health'))).toHaveLength(0);
  });

  it('passes the remaining budget to each request as an abort signal', async () => {
    const hub = fakeHub();
    const code = await main({
      argv: [
        '--agent',
        'dev',
        '--sessions',
        '1',
        '--poll-interval-ms',
        '1',
        '--timeout-ms',
        '5000',
      ],
      stdout: mkStream(),
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      ...noHost,
    });
    expect(code).toBe(0);
    const ensureCall = hub.fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/workspace/ensure'),
    );
    expect(ensureCall[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung provisioning request at the deadline and still archives the session', async () => {
    // Real clock: workspace/ensure never answers, it only rejects when the
    // request's abort signal fires at the remaining budget.
    const hub = fakeHub({
      onEnsure: (init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });
    const stdout = mkStream();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '1', '--timeout-ms', '150', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0].error).toMatch(/aborted due to timeout/i);
    expect(hub.calls.some((c) => c.endsWith('/preview/start'))).toBe(false);
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
  });

  it('keeps sessions with --keep', async () => {
    const hub = fakeHub();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '2', '--poll-interval-ms', '1', '--keep'],
      stdout: mkStream(),
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      ...noHost,
    });
    expect(code).toBe(0);
    expect(hub.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('reports a failed preview with its log tail, still cleans up, and exits 1', async () => {
    const hub = fakeHub({ failing: new Set(['s2']) });
    const stdout = mkStream();
    const code = await main({
      argv: ['--agent', 'dev', '--sessions', '2', '--poll-interval-ms', '1', '--json'],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failed).toBe(1);
    expect(report.failures[0]).toMatchObject({ sessionId: 's2' });
    expect(report.failures[0].error).toMatch(/preview failed: EADDRINUSE/);
    expect(hub.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
  });

  it('times out a session that never becomes ready, measured from the burst start', async () => {
    const hub = fakeHub({ readyAfterPolls: Number.POSITIVE_INFINITY });
    const stdout = mkStream();
    let t = 0;
    const code = await main({
      argv: [
        '--agent',
        'dev',
        '--sessions',
        '1',
        '--poll-interval-ms',
        '100',
        '--timeout-ms',
        '500',
        '--json',
      ],
      stdout,
      stderr: mkStream(),
      fetchImpl: hub.fetchImpl,
      env,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      ...noHost,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout.read());
    expect(report.failures[0].error).toMatch(/preview not ready \((starting|none)\): timeout/);
  });
});
