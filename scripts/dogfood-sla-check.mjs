#!/usr/bin/env node
/**
 * scripts/dogfood-sla-check.mjs — the W4 ship sign-off harness.
 *
 * Measures the two SLAs that gate the container-pool launch:
 *
 *   1. Scaffold (build-from-scratch): wizard-submit → live repo in < 5 min
 *   2. PR-env: PR open → live URL in < 2 min
 *
 * and the load-test flavor (10 concurrent PR envs + 5 concurrent scaffolds)
 * that validates the pool doesn't collapse under concurrent pressure.
 *
 * Why a runnable CLI and not a Vitest? A dogfood test asserts against real
 * infrastructure — Docker, GitHub App, DNS, nginx — so it is not a unit
 * test, it is an ops tool. CI can invoke it against staging on every merge
 * to catch regressions; humans can invoke it ad-hoc before tagging a
 * release. The pure logic (percentile, summarize, runConcurrent, pollUntil)
 * is unit-tested via server/test/scripts-dogfood-sla.test.mjs — what
 * remains in this file is the HTTP-plumbing glue between those primitives
 * and the Agent Hub API.
 *
 * Auth + base URL follow the same precedence as scripts/ah-api.mjs
 * (AGENT_HUB_URL, AGENT_HUB_API_KEY, config.json). See
 * scripts/lib/ah-api-core.mjs for the resolution rules.
 */

import { pathToFileURL } from 'node:url';
import { callApi, resolveApiKey, resolveBaseUrl } from './lib/ah-api-core.mjs';
import {
  DEFAULT_BUDGETS_MS,
  USAGE,
  formatReport,
  parseArgs,
  pollUntil,
  runConcurrent,
  summarize,
} from './lib/dogfood-sla-core.mjs';

/**
 * Trigger a scaffold build by POSTing to the scaffold dispatch endpoint,
 * then poll the project status until the repo URL is live.
 *
 * The exact API shape is intentionally abstracted behind `callApi` so the
 * harness is robust to ongoing W3/W4 route refactors — if the endpoint
 * path moves, this one function is the blast radius. Returns the elapsed
 * ms for the full wizard-submit → live-repo measurement.
 *
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} opts.baseUrl
 * @param {string|null} opts.apiKey
 * @param {string} [opts.template='next']
 * @param {string} [opts.repoName]
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} opts.timeoutMs
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
async function measureScaffold({
  fetchImpl,
  baseUrl,
  apiKey,
  template = 'next',
  repoName = `dogfood-${Date.now()}`,
  pollIntervalMs = 2000,
  timeoutMs,
  now,
  sleep,
}) {
  // Kick off the scaffold. We accept any 2xx that returns a job/project
  // handle the probe can poll for; the response shape is not pinned
  // here because W3 is still converging on a canonical contract.
  const trigger = await callApi({
    method: 'POST',
    path: '/api/projects/scaffold',
    body: { template, repoName },
    baseUrl,
    apiKey,
    fetchImpl,
  });
  if (!trigger.ok) {
    throw new Error(`scaffold trigger failed: HTTP ${trigger.status} — ${JSON.stringify(trigger.body).slice(0, 200)}`);
  }
  const jobId = trigger.body?.jobId ?? trigger.body?.id ?? trigger.body?.project?.id;
  if (!jobId) {
    throw new Error(`scaffold trigger returned no job id: ${JSON.stringify(trigger.body).slice(0, 200)}`);
  }

  const poll = await pollUntil({
    probeFn: async () => {
      const r = await callApi({
        method: 'GET',
        path: `/api/projects/scaffold/${encodeURIComponent(jobId)}`,
        baseUrl,
        apiKey,
        fetchImpl,
      });
      if (!r.ok) return null;
      const status = r.body?.status;
      if (status === 'ready' || status === 'complete' || status === 'succeeded') {
        return r.body?.repoUrl ?? r.body?.url ?? true;
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(`scaffold job ${jobId} failed: ${r.body?.error ?? 'unknown'}`);
      }
      return null;
    },
    intervalMs: pollIntervalMs,
    timeoutMs,
    now,
    sleep,
  });
  if (!poll.ok) throw new Error(`scaffold ${jobId} ${poll.error}`);
  return poll.elapsedMs;
}

/**
 * Trigger a PR-env allocation and poll the resulting URL until it
 * responds 2xx. The "URL responds 2xx" probe is deliberately strict:
 * nginx reloads and container starts can both 502 for a few seconds,
 * and the SLA only counts as met once a user's browser would see a
 * working page.
 */
async function measurePrEnv({
  fetchImpl,
  baseUrl,
  apiKey,
  repo = 'Speakman-ai/agent-hub',
  pr,
  pollIntervalMs = 2000,
  timeoutMs,
  now,
  sleep,
}) {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error('measurePrEnv: pr must be a positive integer');
  }
  const trigger = await callApi({
    method: 'POST',
    path: `/api/pr/${pr}/env`,
    body: { repo },
    baseUrl,
    apiKey,
    fetchImpl,
  });
  if (!trigger.ok) {
    throw new Error(`pr-env trigger failed: HTTP ${trigger.status} — ${JSON.stringify(trigger.body).slice(0, 200)}`);
  }
  const url = trigger.body?.url;
  if (!url) {
    throw new Error(`pr-env trigger returned no url: ${JSON.stringify(trigger.body).slice(0, 200)}`);
  }

  const httpFetch = fetchImpl ?? fetch;
  const poll = await pollUntil({
    probeFn: async () => {
      try {
        const r = await httpFetch(url, { method: 'GET' });
        return r.ok ? url : null;
      } catch {
        return null;
      }
    },
    intervalMs: pollIntervalMs,
    timeoutMs,
    now,
    sleep,
  });
  if (!poll.ok) throw new Error(`pr-env #${pr} ${poll.error}`);
  return poll.elapsedMs;
}

/**
 * CLI entry. Exported for tests — invoke with injected stdio + fetch.
 *
 * @param {object} opts
 * @param {string[]} opts.argv
 * @param {{ write(chunk: string): unknown }} opts.stdout
 * @param {{ write(chunk: string): unknown }} opts.stderr
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<number>}  exit code
 */
export async function main({ argv, stdout, stderr, fetchImpl, env = process.env, now, sleep }) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const baseUrl = resolveBaseUrl(env);
  const apiKey = resolveApiKey(env);
  const { mode, options } = parsed;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  try {
    if (mode === 'scaffold') {
      const budgetMs = options.budgetMs ?? DEFAULT_BUDGETS_MS.scaffold;
      const timeoutMs = options.pollTimeoutMs ?? budgetMs * 2;
      const elapsedMs = await measureScaffold({
        fetchImpl,
        baseUrl,
        apiKey,
        template: options.template,
        repoName: options.repoName,
        pollIntervalMs,
        timeoutMs,
        now,
        sleep,
      });
      const summary = summarize([{ ok: true, elapsedMs }], { budgetMs });
      emit(stdout, summary, 'Scaffold SLA (5 min)', options.json);
      return summary.slaPassed ? 0 : 1;
    }

    if (mode === 'pr-env') {
      const budgetMs = options.budgetMs ?? DEFAULT_BUDGETS_MS.prEnv;
      const timeoutMs = options.pollTimeoutMs ?? budgetMs * 2;
      const elapsedMs = await measurePrEnv({
        fetchImpl,
        baseUrl,
        apiKey,
        repo: options.repo,
        pr: options.pr,
        pollIntervalMs,
        timeoutMs,
        now,
        sleep,
      });
      const summary = summarize([{ ok: true, elapsedMs }], { budgetMs });
      emit(stdout, summary, `PR-env SLA (2 min) PR #${options.pr}`, options.json);
      return summary.slaPassed ? 0 : 1;
    }

    if (mode === 'load-test') {
      const prEnvs = options.prEnvs ?? 10;
      const scaffolds = options.scaffolds ?? 5;
      const prEnvBudget = options.prEnvBudgetMs ?? DEFAULT_BUDGETS_MS.prEnv;
      const scaffoldBudget = options.scaffoldBudgetMs ?? DEFAULT_BUDGETS_MS.scaffold;
      const concurrency = options.concurrency;

      stderr.write(`load-test: ${prEnvs} PR envs + ${scaffolds} scaffolds\n`);

      const prEnvResults = await runConcurrent({
        count: prEnvs,
        concurrency,
        workFn: async (i) =>
          measurePrEnv({
            fetchImpl,
            baseUrl,
            apiKey,
            repo: options.repo,
            // Load test uses a synthetic PR number per slot — real
            // deployments stamp this via a --pr-range flag or a
            // webhook-fed list of open PRs.
            pr: (options.pr ?? 1) + i,
            pollIntervalMs,
            timeoutMs: options.pollTimeoutMs ?? prEnvBudget * 2,
            now,
            sleep,
          }),
        now,
      });
      const scaffoldResults = await runConcurrent({
        count: scaffolds,
        concurrency,
        workFn: async (i) =>
          measureScaffold({
            fetchImpl,
            baseUrl,
            apiKey,
            template: options.template,
            repoName: `${options.repoName ?? 'dogfood'}-load-${i}-${Date.now()}`,
            pollIntervalMs,
            timeoutMs: options.pollTimeoutMs ?? scaffoldBudget * 2,
            now,
            sleep,
          }),
        now,
      });

      const prSummary = summarize(prEnvResults, { budgetMs: prEnvBudget });
      const scSummary = summarize(scaffoldResults, { budgetMs: scaffoldBudget });
      emit(stdout, prSummary, `Load: ${prEnvs} concurrent PR envs`, options.json);
      stdout.write('\n');
      emit(stdout, scSummary, `Load: ${scaffolds} concurrent scaffolds`, options.json);
      return prSummary.slaPassed && scSummary.slaPassed ? 0 : 1;
    }

    // parseArgs should have caught this; defence in depth.
    stderr.write(`unknown mode: ${mode}\n`);
    return 2;
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

function emit(stdout, summary, title, asJson) {
  if (asJson) {
    stdout.write(JSON.stringify({ title, ...summary }, null, 2));
    stdout.write('\n');
  } else {
    stdout.write(formatReport(summary, title));
    stdout.write('\n');
  }
}

// Invoked-directly check: only run main() when this file is the entry
// point, not when it's imported by a test. pathToFileURL handles
// Windows drive-letter paths correctly (see ah-api.mjs for the
// rationale on pathToFileURL over manual file:// construction).
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
      process.exit(3);
    });
}
