import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_BUDGETS_MS,
  USAGE,
  formatReport,
  parseArgs,
  percentile,
  pollUntil,
  runConcurrent,
  summarize,
} from '../../scripts/lib/dogfood-sla-core.mjs';
import { main } from '../../scripts/dogfood-sla-check.mjs';

/**
 * Contract tests for the W4 dogfood-SLA harness. The actual dogfood
 * run is an ops exercise against staging — these tests lock in the
 * pure-logic primitives (percentile, summarize, runConcurrent,
 * pollUntil) + the CLI argv contract so the harness stays trustworthy
 * as the sign-off gate. See scripts/lib/dogfood-sla-core.mjs for the
 * spec references.
 */

describe('percentile', () => {
  it('returns the single value for a one-element array', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('returns the expected median for an odd-length array', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('linearly interpolates between the two straddling samples', () => {
    // 10 samples: ranks span [0, 9]. P95 = rank 0.95*9 = 8.55 → between
    // sorted[8]=9 and sorted[9]=10 with fraction 0.55 → 9.55.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55, 5);
  });

  it('handles unsorted input by sorting first', () => {
    expect(percentile([10, 1, 5, 3, 8], 50)).toBe(5);
  });

  it('throws on empty input', () => {
    expect(() => percentile([], 50)).toThrow(/non-empty/);
  });

  it('throws on out-of-range p', () => {
    expect(() => percentile([1, 2, 3], 0)).toThrow(/\(0, 100\]/);
    expect(() => percentile([1, 2, 3], 101)).toThrow(/\(0, 100\]/);
  });
});

describe('summarize', () => {
  it('reports per-status counts and pass rate', () => {
    const s = summarize(
      [
        { ok: true, elapsedMs: 100 },
        { ok: true, elapsedMs: 200 },
        { ok: false, elapsedMs: 5000, error: 'boom' },
      ],
      { budgetMs: 300 },
    );
    expect(s.count).toBe(3);
    expect(s.successes).toBe(2);
    expect(s.failures).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('passes SLA when p95 is within budget and pass rate is 100%', () => {
    const s = summarize(
      [
        { ok: true, elapsedMs: 100 },
        { ok: true, elapsedMs: 150 },
        { ok: true, elapsedMs: 200 },
      ],
      { budgetMs: 300 },
    );
    expect(s.slaPassed).toBe(true);
    expect(s.slaFailReasons).toEqual([]);
  });

  it('fails SLA when p95 exceeds the budget', () => {
    const s = summarize(
      [
        { ok: true, elapsedMs: 100 },
        { ok: true, elapsedMs: 200 },
        { ok: true, elapsedMs: 999 },
      ],
      { budgetMs: 500 },
    );
    expect(s.slaPassed).toBe(false);
    expect(s.slaFailReasons[0]).toMatch(/P95/);
  });

  it('fails SLA when pass rate falls below required', () => {
    const s = summarize(
      [
        { ok: true, elapsedMs: 100 },
        { ok: false, elapsedMs: 50, error: 'x' },
      ],
      { budgetMs: 500, requiredPassRate: 1.0 },
    );
    expect(s.slaPassed).toBe(false);
    expect(s.slaFailReasons.some((r) => /pass rate/.test(r))).toBe(true);
  });

  it('only counts successful samples toward percentiles', () => {
    const s = summarize(
      [
        { ok: true, elapsedMs: 100 },
        { ok: false, elapsedMs: 99999, error: 'timeout' },
      ],
      { budgetMs: 500, requiredPassRate: 0.5 },
    );
    expect(s.p95).toBe(100);
    expect(s.max).toBe(100);
    expect(s.min).toBe(100);
  });

  it('reports no-successful-samples as a distinct fail reason', () => {
    const s = summarize([{ ok: false, elapsedMs: 10, error: 'x' }], { budgetMs: 500 });
    expect(s.successes).toBe(0);
    expect(s.slaPassed).toBe(false);
    expect(s.slaFailReasons.some((r) => /no successful samples/.test(r))).toBe(true);
    expect(s.p50).toBeNull();
    expect(s.p95).toBeNull();
  });

  it('validates budgetMs must be a positive number', () => {
    expect(() => summarize([], { budgetMs: 0 })).toThrow(/positive/);
    expect(() => summarize([], {})).toThrow(/positive/);
  });
});

describe('formatReport', () => {
  it('renders PASS and FAIL status markers', () => {
    const pass = formatReport(
      summarize([{ ok: true, elapsedMs: 100 }], { budgetMs: 500 }),
      'Scaffold SLA',
    );
    expect(pass).toContain('[PASS]');
    expect(pass).toContain('Scaffold SLA');

    const fail = formatReport(
      summarize([{ ok: true, elapsedMs: 999 }], { budgetMs: 100 }),
      'Scaffold SLA',
    );
    expect(fail).toContain('[FAIL]');
    expect(fail).toContain('SLA fail reasons');
  });

  it('renders n/a for missing percentiles', () => {
    const report = formatReport(
      summarize([{ ok: false, elapsedMs: 10, error: 'x' }], { budgetMs: 500 }),
      'All-Fail',
    );
    expect(report).toContain('p50: n/a');
    expect(report).toContain('p95: n/a');
  });
});

describe('runConcurrent', () => {
  it('records elapsed-ms for each invocation using the injected clock', async () => {
    let t = 0;
    const now = () => t;
    const results = await runConcurrent({
      count: 3,
      concurrency: 1,
      workFn: async (i) => {
        t += (i + 1) * 10;
      },
      now,
    });
    expect(results).toHaveLength(3);
    expect(results[0].elapsedMs).toBe(10);
    expect(results[1].elapsedMs).toBe(20);
    expect(results[2].elapsedMs).toBe(30);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('records thrown work as { ok: false, error }', async () => {
    const results = await runConcurrent({
      count: 2,
      workFn: async (i) => {
        if (i === 1) throw new Error('nope');
      },
    });
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toBe('nope');
  });

  it('bounds parallelism to the configured concurrency', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const results = await runConcurrent({
      count: 10,
      concurrency: 3,
      workFn: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
      },
    });
    expect(results).toHaveLength(10);
    expect(maxInflight).toBeLessThanOrEqual(3);
  });

  it('calls onProgress after each completion', async () => {
    const events = [];
    await runConcurrent({
      count: 3,
      workFn: async () => {},
      onProgress: (p) => events.push(p.done),
    });
    expect(events).toEqual([1, 2, 3]);
  });

  it('validates count and concurrency', async () => {
    await expect(
      runConcurrent({ count: -1, workFn: async () => {} }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      runConcurrent({ count: 1, workFn: async () => {}, concurrency: 0 }),
    ).rejects.toThrow(/positive/);
  });
});

describe('pollUntil', () => {
  it('returns the first truthy probe value and elapsed ms', async () => {
    let calls = 0;
    let t = 0;
    const result = await pollUntil({
      probeFn: async () => {
        calls++;
        return calls >= 3 ? 'ready' : null;
      },
      intervalMs: 10,
      timeoutMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('ready');
    expect(calls).toBe(3);
  });

  it('times out cleanly when probe never resolves truthy', async () => {
    let t = 0;
    const result = await pollUntil({
      probeFn: async () => null,
      intervalMs: 100,
      timeoutMs: 500,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout after 500ms/);
  });

  it('swallows transient probe errors and keeps polling', async () => {
    let calls = 0;
    let t = 0;
    const result = await pollUntil({
      probeFn: async () => {
        calls++;
        if (calls < 3) throw new Error('502 bad gateway');
        return 'ok';
      },
      intervalMs: 10,
      timeoutMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

describe('parseArgs', () => {
  it('returns help on empty argv or --help', () => {
    expect(parseArgs([])).toEqual({ help: true });
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('requires exactly one mode flag', () => {
    expect(parseArgs(['--foo']).error).toMatch(/one of/);
    expect(parseArgs(['--scaffold', '--pr-env']).error).toMatch(/exactly one/);
  });

  it('parses --scaffold with defaults and value flags', () => {
    const p = parseArgs(['--scaffold', '--template', 'expo', '--budget-ms', '60000']);
    expect(p.mode).toBe('scaffold');
    expect(p.options.template).toBe('expo');
    expect(p.options.budgetMs).toBe(60000);
  });

  it('converts kebab-case flags to camelCase options', () => {
    const p = parseArgs(['--load-test', '--pr-envs', '10', '--pr-env-budget-ms', '99']);
    expect(p.options.prEnvs).toBe(10);
    expect(p.options.prEnvBudgetMs).toBe(99);
  });

  it('rejects unknown flags', () => {
    expect(parseArgs(['--scaffold', '--weird']).error).toMatch(/unknown flag/);
  });

  it('rejects non-numeric values for numeric flags', () => {
    expect(parseArgs(['--pr-env', '--pr', 'abc']).error).toMatch(/non-negative number/);
  });

  it('requires --pr for --pr-env mode', () => {
    expect(parseArgs(['--pr-env']).error).toMatch(/--pr-env requires --pr/);
  });

  it('detects the --json flag without consuming a value', () => {
    const p = parseArgs(['--scaffold', '--json']);
    expect(p.options.json).toBe(true);
  });

  it('returns an error when a flag is missing its value', () => {
    expect(parseArgs(['--scaffold', '--template']).error).toMatch(/requires a value/);
  });
});

describe('DEFAULT_BUDGETS_MS', () => {
  it('encodes the spec budgets (5 min scaffold, 2 min PR env)', () => {
    expect(DEFAULT_BUDGETS_MS.scaffold).toBe(5 * 60 * 1000);
    expect(DEFAULT_BUDGETS_MS.prEnv).toBe(2 * 60 * 1000);
  });

  it('is frozen so callers cannot mutate the source of truth', () => {
    expect(Object.isFrozen(DEFAULT_BUDGETS_MS)).toBe(true);
  });
});

describe('USAGE', () => {
  it('documents all three modes and the common flags', () => {
    for (const needle of ['--scaffold', '--pr-env', '--load-test', '--json', '--help']) {
      expect(USAGE).toContain(needle);
    }
  });
});

describe('main (CLI entry)', () => {
  function mkStream() {
    const chunks = [];
    return { write: (c) => chunks.push(String(c)), read: () => chunks.join('') };
  }

  it('returns 0 and prints usage for --help', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    const code = await main({ argv: ['--help'], stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.read()).toContain('usage: dogfood-sla-check');
  });

  it('returns 2 with usage when argv has no mode', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    const code = await main({ argv: ['--budget-ms', '100'], stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.read()).toMatch(/one of --scaffold/);
  });

  it('returns 3 when the scaffold trigger HTTP call fails', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      ok: false,
      text: async () => '{"error":"boom"}',
    }));
    const code = await main({
      argv: ['--scaffold', '--budget-ms', '1000', '--poll-timeout-ms', '2000'],
      stdout,
      stderr,
      fetchImpl,
      env: { AGENT_HUB_URL: 'http://localhost:3051' },
    });
    expect(code).toBe(3);
    expect(stderr.read()).toMatch(/scaffold trigger failed/);
  });

  it('returns 0 on a successful scaffold that polls to ready within budget', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    let pollCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/scaffold/')) {
        pollCalls++;
        const status = pollCalls >= 2 ? 'ready' : 'pending';
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ status, repoUrl: 'https://x/y' }),
        };
      }
      return {
        status: 201,
        ok: true,
        text: async () => JSON.stringify({ jobId: 'job-1' }),
      };
    });
    let t = 0;
    const code = await main({
      argv: ['--scaffold', '--budget-ms', '10000', '--poll-interval-ms', '10'],
      stdout,
      stderr,
      fetchImpl,
      env: { AGENT_HUB_URL: 'http://localhost:3051' },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(code).toBe(0);
    expect(stdout.read()).toContain('[PASS]');
  });

  it('returns 1 when the measured scaffold exceeds the budget', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    // Probe returns ready immediately, but we advance the clock past
    // the budget inside the work to simulate a slow run.
    let t = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/scaffold/')) {
        t += 1000; // each poll advances 1s; budget is 500ms → fail
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ status: 'ready', repoUrl: 'https://x/y' }),
        };
      }
      return { status: 201, ok: true, text: async () => JSON.stringify({ jobId: 'j' }) };
    });
    const code = await main({
      argv: ['--scaffold', '--budget-ms', '500', '--poll-interval-ms', '10', '--poll-timeout-ms', '100000'],
      stdout,
      stderr,
      fetchImpl,
      env: { AGENT_HUB_URL: 'http://localhost:3051' },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(code).toBe(1);
    expect(stdout.read()).toContain('[FAIL]');
  });

  it('emits JSON when --json is passed', async () => {
    const stdout = mkStream();
    const stderr = mkStream();
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/scaffold/')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ status: 'ready', repoUrl: 'https://x/y' }),
        };
      }
      return { status: 201, ok: true, text: async () => JSON.stringify({ jobId: 'j' }) };
    });
    let t = 0;
    const code = await main({
      argv: ['--scaffold', '--json', '--budget-ms', '10000'],
      stdout,
      stderr,
      fetchImpl,
      env: { AGENT_HUB_URL: 'http://localhost:3051' },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.read());
    expect(parsed.slaPassed).toBe(true);
    expect(parsed.title).toMatch(/Scaffold SLA/);
  });
});
