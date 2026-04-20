/**
 * scripts/lib/dogfood-sla-core.mjs — pure helpers for the W4 dogfood-SLA
 * validation harness. Keep this file ESM-only, zero runtime deps beyond
 * Node, and pure (no process.exit, no argv, no console.log) so it can be
 * unit-tested without spawning subprocesses and re-used from server-side
 * code (e.g. autonomous runs, CI gates).
 *
 * Spec (from kanban card `W4: Dogfood the agent-hub repo itself + 5-min
 * SLA validation`, iteration 2/3):
 *
 *   1. Build-from-scratch on a toy idea must complete end-to-end
 *      wizard-submit → live repo with agents working in < 5 min.
 *   2. PR-env URL must be live within 2 min of PR open.
 *   3. Load test: 10 concurrent PR envs + 5 concurrent scaffolds,
 *      P95 within budget, no catastrophic failures.
 *
 * The harness collects latency samples, computes summary stats
 * (P50/P95/P99/max/pass-rate), and emits a structured report whose
 * exit code encodes pass/fail. Used both as an ops-facing CLI and as
 * the source of truth for the ship sign-off criterion.
 */

/**
 * Nearest-rank percentile with linear interpolation between the two
 * straddling samples. Matches the NIST / Excel PERCENTILE.INC
 * definition so the numbers are reproducible across tools. Callers
 * MUST pass a non-empty array; empty input throws because "P95 of
 * zero samples" has no meaningful answer and silently returning 0
 * would mask a broken harness.
 *
 * @param {number[]} values  unsorted array of latencies in ms
 * @param {number}  p        percentile in (0, 100]
 * @returns {number}
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('percentile: values must be a non-empty array');
  }
  if (typeof p !== 'number' || p <= 0 || p > 100) {
    throw new Error('percentile: p must be in (0, 100]');
  }
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const fraction = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * fraction;
}

/**
 * Aggregate an array of measurement results into a structured summary
 * suitable for both JSON emission and human reporting. A measurement
 * is `{ ok: boolean, elapsedMs: number, error?: string }`. Only
 * successful samples contribute to the percentile stats — failed
 * runs are counted separately so the pass-rate and latency
 * distribution stay semantically distinct (a timeout is not a slow
 * success).
 *
 * The SLA gate fires when **either**:
 *   - passRate < requiredPassRate (default 1.0 — no failures allowed
 *     on the sign-off run), OR
 *   - P95 > budgetMs
 *
 * Both the sign-off criterion (pass/fail) and the individual metrics
 * are surfaced so the caller can render a nuanced report.
 *
 * @param {{ok: boolean, elapsedMs: number, error?: string}[]} results
 * @param {object} opts
 * @param {number} opts.budgetMs
 * @param {number} [opts.requiredPassRate=1.0]
 * @returns {{
 *   count: number,
 *   successes: number,
 *   failures: number,
 *   passRate: number,
 *   budgetMs: number,
 *   requiredPassRate: number,
 *   p50: number | null,
 *   p95: number | null,
 *   p99: number | null,
 *   min: number | null,
 *   max: number | null,
 *   mean: number | null,
 *   slaPassed: boolean,
 *   slaFailReasons: string[],
 * }}
 */
export function summarize(results, { budgetMs, requiredPassRate = 1.0 } = {}) {
  if (!Array.isArray(results)) {
    throw new Error('summarize: results must be an array');
  }
  if (typeof budgetMs !== 'number' || budgetMs <= 0) {
    throw new Error('summarize: budgetMs must be a positive number');
  }
  const count = results.length;
  const okSamples = results.filter((r) => r && r.ok).map((r) => r.elapsedMs);
  const successes = okSamples.length;
  const failures = count - successes;
  const passRate = count === 0 ? 0 : successes / count;

  const slaFailReasons = [];
  let p50 = null;
  let p95 = null;
  let p99 = null;
  let min = null;
  let max = null;
  let mean = null;

  if (successes > 0) {
    p50 = percentile(okSamples, 50);
    p95 = percentile(okSamples, 95);
    p99 = percentile(okSamples, 99);
    min = Math.min(...okSamples);
    max = Math.max(...okSamples);
    mean = okSamples.reduce((a, b) => a + b, 0) / successes;
    if (p95 > budgetMs) {
      slaFailReasons.push(`P95 ${Math.round(p95)}ms exceeds budget ${budgetMs}ms`);
    }
  } else {
    // No successful samples → automatic fail unless the caller is
    // OK with a 0% pass rate (requiredPassRate = 0), which would be
    // a degenerate config but we don't hard-fail on it here.
    slaFailReasons.push('no successful samples');
  }

  if (passRate < requiredPassRate) {
    slaFailReasons.push(
      `pass rate ${(passRate * 100).toFixed(1)}% < required ${(requiredPassRate * 100).toFixed(1)}%`,
    );
  }

  return {
    count,
    successes,
    failures,
    passRate,
    budgetMs,
    requiredPassRate,
    p50,
    p95,
    p99,
    min,
    max,
    mean,
    slaPassed: slaFailReasons.length === 0,
    slaFailReasons,
  };
}

/**
 * Render a summary as a human-readable markdown block. The format is
 * stable and grep-friendly: each metric on its own line, prefixed by
 * an emoji-free ASCII status marker so the report survives plain-text
 * pipelines (CI logs, email, Slack code blocks).
 *
 * @param {ReturnType<typeof summarize>} summary
 * @param {string} title  e.g. "Scaffold SLA (5 min)"
 * @returns {string}
 */
export function formatReport(summary, title) {
  const statusLabel = summary.slaPassed ? 'PASS' : 'FAIL';
  const ms = (v) => (v == null ? 'n/a' : `${Math.round(v)}ms`);
  const lines = [
    `## ${title} — [${statusLabel}]`,
    ``,
    `- samples: ${summary.count} (${summary.successes} ok / ${summary.failures} failed)`,
    `- pass rate: ${(summary.passRate * 100).toFixed(1)}% (required ${(summary.requiredPassRate * 100).toFixed(1)}%)`,
    `- budget: ${summary.budgetMs}ms`,
    `- p50: ${ms(summary.p50)}`,
    `- p95: ${ms(summary.p95)}`,
    `- p99: ${ms(summary.p99)}`,
    `- min: ${ms(summary.min)}`,
    `- max: ${ms(summary.max)}`,
    `- mean: ${ms(summary.mean)}`,
  ];
  if (!summary.slaPassed) {
    lines.push(``, `### SLA fail reasons`);
    for (const reason of summary.slaFailReasons) {
      lines.push(`- ${reason}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run `count` invocations of `workFn` with bounded parallelism and
 * collect per-invocation latency + outcome. Bounded parallelism matters
 * because the dogfood load test has hard pool caps (12 concurrent PR
 * envs per §4 of the design) and we don't want the harness itself to
 * be the limiter if the pool is supposed to absorb 10.
 *
 * `workFn(i)` must return a Promise. Thrown/rejected work is recorded
 * as `{ ok: false, elapsedMs, error }` — never swallowed — so the
 * caller can distinguish infra failures from slow successes in the
 * summary.
 *
 * The clock is injected (`now`) so tests can drive deterministic
 * elapsed-ms values without `await new Promise(setTimeout)`.
 *
 * @param {object} opts
 * @param {number} opts.count
 * @param {(i: number) => Promise<unknown>} opts.workFn
 * @param {number} [opts.concurrency]  defaults to count (all at once)
 * @param {(progress: {done: number, total: number, lastResult: object}) => void} [opts.onProgress]
 * @param {() => number} [opts.now]    defaults to performance.now
 * @returns {Promise<{ok: boolean, elapsedMs: number, error?: string}[]>}
 */
export async function runConcurrent({
  count,
  workFn,
  concurrency,
  onProgress,
  now = () => performance.now(),
}) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('runConcurrent: count must be a non-negative integer');
  }
  if (typeof workFn !== 'function') {
    throw new Error('runConcurrent: workFn must be a function');
  }
  const maxParallel = concurrency ?? count;
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error('runConcurrent: concurrency must be a positive integer');
  }

  const results = new Array(count);
  let nextIndex = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= count) return;
      const start = now();
      let result;
      try {
        await workFn(i);
        result = { ok: true, elapsedMs: now() - start };
      } catch (err) {
        result = {
          ok: false,
          elapsedMs: now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      results[i] = result;
      done++;
      if (onProgress) {
        onProgress({ done, total: count, lastResult: result });
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(maxParallel, count);
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * CLI argv parser. Supports three modes:
 *
 *   dogfood-sla-check --scaffold         [--repo-name NAME] [--template T] [--budget-ms N]
 *   dogfood-sla-check --pr-env --pr N    [--repo owner/name] [--budget-ms N]
 *   dogfood-sla-check --load-test        [--pr-envs 10] [--scaffolds 5]
 *                                         [--pr-env-budget-ms N] [--scaffold-budget-ms N]
 *                                         [--concurrency N]
 *
 * Common flags:
 *   --json            emit machine-readable JSON on stdout (default: markdown)
 *   --poll-interval-ms N   how often to poll when waiting for readiness (default 2000)
 *   --poll-timeout-ms N    hard cap on a single measurement (default = budget × 2)
 *   --help            print USAGE and exit 0
 *
 * Returns `{mode, options}` on success or `{error}` on usage failure.
 * Never calls process.exit.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { help: true };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const modeFlags = ['--scaffold', '--pr-env', '--load-test'];
  const modes = argv.filter((a) => modeFlags.includes(a));
  if (modes.length === 0) {
    return { error: 'one of --scaffold, --pr-env, --load-test is required' };
  }
  if (modes.length > 1) {
    return { error: `exactly one mode flag allowed, got ${modes.join(', ')}` };
  }
  const mode = modes[0].replace(/^--/, '');

  const options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (modeFlags.includes(a)) continue;
    if (a === '--json') {
      options.json = true;
      continue;
    }
    // Every remaining recognized flag takes a value.
    const known = [
      '--repo-name',
      '--template',
      '--repo',
      '--pr',
      '--budget-ms',
      '--pr-envs',
      '--scaffolds',
      '--pr-env-budget-ms',
      '--scaffold-budget-ms',
      '--concurrency',
      '--poll-interval-ms',
      '--poll-timeout-ms',
    ];
    if (!known.includes(a)) {
      return { error: `unknown flag: ${a}` };
    }
    const value = argv[++i];
    if (value === undefined) {
      return { error: `flag ${a} requires a value` };
    }
    const numericFlags = [
      '--pr',
      '--budget-ms',
      '--pr-envs',
      '--scaffolds',
      '--pr-env-budget-ms',
      '--scaffold-budget-ms',
      '--concurrency',
      '--poll-interval-ms',
      '--poll-timeout-ms',
    ];
    if (numericFlags.includes(a)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `flag ${a} requires a non-negative number, got ${value}` };
      }
      options[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = n;
    } else {
      options[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }

  // Mode-specific validation.
  if (mode === 'pr-env' && options.pr === undefined) {
    return { error: '--pr-env requires --pr <number>' };
  }

  return { mode, options };
}

export const USAGE = `usage: dogfood-sla-check <mode> [options]

modes:
  --scaffold                      measure a single scaffold build against the 5-min SLA
  --pr-env --pr <n>               measure a single PR env against the 2-min SLA
  --load-test                     run the concurrent load test (10 PR envs + 5 scaffolds)

scaffold options:
  --template <id>                 scaffold template (default: next)
  --repo-name <name>              target repo name (default: dogfood-<timestamp>)
  --budget-ms <n>                 SLA budget in ms (default: 300000)

pr-env options:
  --repo <owner/name>             target repo (default: Speakman-ai/agent-hub)
  --pr <number>                   PR number to trigger an env for (required)
  --budget-ms <n>                 SLA budget in ms (default: 120000)

load-test options:
  --pr-envs <n>                   concurrent PR envs to allocate (default: 10)
  --scaffolds <n>                 concurrent scaffolds (default: 5)
  --pr-env-budget-ms <n>          default: 120000
  --scaffold-budget-ms <n>        default: 300000
  --concurrency <n>               cap on in-flight requests (default: no cap)

common:
  --poll-interval-ms <n>          default: 2000
  --poll-timeout-ms <n>           default: budget × 2
  --json                          emit JSON to stdout instead of markdown
  --help                          print this message

exit codes:
  0  all measured modes passed the SLA
  1  at least one SLA miss
  2  usage error
  3  transport / infrastructure error (harness itself couldn't run)
`;

/**
 * Default SLA budgets — exported so the server-side cron equivalent and
 * the CLI share a single source of truth. Spec §1, §2 of the design
 * document.
 */
export const DEFAULT_BUDGETS_MS = Object.freeze({
  scaffold: 5 * 60 * 1000,
  prEnv: 2 * 60 * 1000,
});

/**
 * Poll `probeFn` at `intervalMs` until it returns truthy or
 * `timeoutMs` elapses. Returns `{ ok, elapsedMs, value?, error? }`.
 * Callers are responsible for interpreting truthy values — e.g. the
 * scaffold probe returns the repo URL, the PR-env probe returns the
 * live URL. The clock is injected for test determinism.
 *
 * Rationale for polling vs. WS subscribe: polling is stateless and
 * survives reconnects, and the infrastructure we're validating must
 * expose a readable status endpoint anyway (that's the W4 observability
 * card). Keeping the harness simple keeps it trustworthy as the
 * sign-off gate.
 *
 * @param {object} opts
 * @param {() => Promise<unknown>} opts.probeFn
 * @param {number} opts.intervalMs
 * @param {number} opts.timeoutMs
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  defaults to setTimeout
 */
export async function pollUntil({
  probeFn,
  intervalMs,
  timeoutMs,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const start = now();
  while (true) {
    const elapsedMs = now() - start;
    if (elapsedMs > timeoutMs) {
      return { ok: false, elapsedMs, error: `timeout after ${timeoutMs}ms` };
    }
    try {
      const value = await probeFn();
      if (value) {
        return { ok: true, elapsedMs: now() - start, value };
      }
    } catch {
      // Transient errors during polling are recorded but don't abort —
      // the pool + scaffold both go through several transient states
      // (container starting, nginx reloading) that probe as 404/503
      // before the URL goes live. We only give up on timeout.
    }
    await sleep(intervalMs);
  }
}
