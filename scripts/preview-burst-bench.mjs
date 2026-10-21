#!/usr/bin/env node
/**
 * scripts/preview-burst-bench.mjs — measure what a burst of simultaneous
 * session previews does to this Hub.
 *
 * For each of N sessions, concurrently:
 *   1. POST /api/agents/:agentId/sessions            create the session
 *   2. POST /api/sessions/:id/workspace/ensure        clone + install (blocks)
 *   3. POST /api/sessions/:id/preview/start           boot the dev server
 *   4. GET  /api/sessions/:id/preview/state           poll until ready/failed
 *   5. DELETE /api/sessions/:id                       unless --keep
 *
 * While that runs, sample the local host's load average and free memory.
 * Those numbers only describe the Hub when the script runs on the Hub
 * host; pass --no-host-sample elsewhere.
 *
 * Why a CLI and not a Vitest: it drives real clones, installs and dev
 * servers against a live Hub. The pure parts (report, parser, state
 * classifier) are unit-tested in server/test/scripts-preview-burst-bench.test.mjs
 * together with this file's `main`, using an injected fetch.
 */

import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { callApi, resolveApiKey, resolveBaseUrl } from './lib/ah-api-core.mjs';
import { pollUntil, runConcurrent } from './lib/dogfood-sla-core.mjs';
import {
  USAGE,
  buildReport,
  classifyPreviewState,
  formatBurstReport,
  parseArgs,
} from './lib/preview-burst-bench-core.mjs';

/** Caps for the requests that run outside a session's budget. */
const CLEANUP_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;

function describeFailure(label, r) {
  return `${label}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
}

/**
 * Run one session end to end. Resolves to the per-session result; never
 * throws, so one failure does not hide the others' timings.
 */
async function runSession({
  api,
  agentId,
  index,
  t0,
  now,
  sleep,
  pollIntervalMs,
  timeoutMs,
  keep,
}) {
  const phases = { workspaceReadyMs: null, previewReadyMs: null, totalMs: null };
  let sessionId = null;
  const fail = (error) => ({ sessionId, ok: false, error, phases });
  // One deadline per session, measured from the burst start, shared by every
  // step. The budget is enforced only *before* a request: a step is skipped
  // once the budget is gone and each request is aborted at the remaining
  // budget. A response that lands late is still returned so the caller can
  // record its side effects (the created session id, the workspace timing)
  // before the next step's gate stops the session.
  const remaining = () => timeoutMs - (now() - t0);
  const gate = (label) => {
    if (remaining() <= 0) throw new Error(`${label} skipped: ${timeoutMs}ms budget exhausted`);
  };
  const step = (label, method, path, body) => {
    gate(label);
    return api(method, path, body, remaining());
  };
  try {
    const created = await step(
      'create session',
      'POST',
      `/api/agents/${encodeURIComponent(agentId)}/sessions`,
      { name: `preview-burst-bench ${index + 1}` },
    );
    if (!created.ok || !created.body?.id) return fail(describeFailure('create session', created));
    sessionId = created.body.id;

    const ensured = await step(
      'workspace/ensure',
      'POST',
      `/api/sessions/${sessionId}/workspace/ensure`,
    );
    if (!ensured.ok) return fail(describeFailure('workspace/ensure', ensured));
    phases.workspaceReadyMs = now() - t0;

    const startIssuedAt = now();
    const started = await step(
      'preview/start',
      'POST',
      `/api/sessions/${sessionId}/preview/start`,
      {
        reason: 'preview-burst-bench',
      },
    );
    if (!started.ok) return fail(describeFailure('preview/start', started));

    let lastState = 'none';
    // pollUntil swallows probe errors, so a failed preview is returned as a
    // truthy terminal value rather than thrown; otherwise the poll would run
    // to the timeout on a preview that died in its first second.
    // Same gate as the steps: a preview/start that answered late must not
    // start a poll loop (even a zero-budget one issues a request).
    gate('preview/state');
    const poll = await pollUntil({
      probeFn: async () => {
        const r = await api(
          'GET',
          `/api/sessions/${sessionId}/preview/state`,
          undefined,
          remaining(),
        );
        if (!r.ok) throw new Error(describeFailure('preview/state', r));
        lastState = classifyPreviewState(r.body?.event);
        if (lastState === 'ready') return { ready: true };
        if (lastState === 'failed') {
          const tail = (r.body.event.logTail ?? []).slice(-5).join(' | ');
          return { failed: true, error: `preview failed${tail ? `: ${tail}` : ''}` };
        }
        return null;
      },
      intervalMs: pollIntervalMs,
      timeoutMs: Math.max(0, remaining()),
      now,
      sleep,
    });
    if (!poll.ok) return fail(`preview not ready (${lastState}): ${poll.error}`);
    if (poll.value.failed) return fail(poll.value.error);
    const readyAt = now();
    phases.previewReadyMs = readyAt - startIssuedAt;
    phases.totalMs = readyAt - t0;
    return { sessionId, ok: true, phases };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (sessionId && !keep) {
      try {
        // Outside the session budget on purpose: an expired session must still
        // be archived. Bounded so a hung Hub cannot hold the harness forever.
        await api('DELETE', `/api/sessions/${sessionId}`, undefined, CLEANUP_TIMEOUT_MS);
      } catch {
        // Cleanup is best-effort; the report already has what we came for.
      }
    }
  }
}

/**
 * CLI entry. Exported for tests with injected stdio, fetch, clock and host sampler.
 *
 * @returns {Promise<number>} exit code
 */
export async function main({
  argv,
  stdout,
  stderr,
  fetchImpl,
  env = process.env,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sampleHost = () => ({
    load1: os.loadavg()[0],
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
  }),
  cpuCount = os.cpus().length,
}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const baseUrl = resolveBaseUrl(env);
  const apiKey = resolveApiKey(env);
  const baseFetch = fetchImpl ?? fetch;
  // `deadlineMs` aborts the request when the session's remaining budget runs
  // out, so a hung provisioning call cannot hold a slot past --timeout-ms.
  const api = (method, path, body, deadlineMs) =>
    callApi({
      method,
      path,
      body,
      baseUrl,
      apiKey,
      fetchImpl:
        deadlineMs === undefined
          ? baseFetch
          : (url, init) =>
              baseFetch(url, {
                ...init,
                signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs))),
              }),
    });

  const probe = await api('GET', '/api/health', undefined, HEALTH_TIMEOUT_MS).catch((err) => ({
    ok: false,
    status: 0,
    body: String(err),
  }));
  if (!probe.ok) {
    stderr.write(`cannot reach Agent Hub at ${baseUrl}: ${describeFailure('health', probe)}\n`);
    return 3;
  }

  const hostSamples = [];
  let sampler = null;
  if (o.hostSample) {
    const take = () => {
      try {
        hostSamples.push({ atMs: now(), ...sampleHost() });
      } catch {
        // A failed sample is not a failed benchmark.
      }
    };
    take();
    sampler = setInterval(take, o.hostSampleMs);
    sampler.unref?.();
  }

  stderr.write(`preview-burst-bench: ${o.sessions} sessions on agent ${o.agent} via ${baseUrl}\n`);
  const startedAt = new Date().toISOString();
  const t0 = now();
  const results = [];
  try {
    await runConcurrent({
      count: o.sessions,
      workFn: async (i) => {
        const r = await runSession({
          api,
          agentId: o.agent,
          index: i,
          t0,
          now,
          sleep,
          pollIntervalMs: o.pollIntervalMs,
          timeoutMs: o.timeoutMs,
          keep: o.keep,
        });
        results[i] = r;
        stderr.write(
          `  [${i + 1}/${o.sessions}] ${r.ok ? 'ready' : 'FAILED'} ` +
            `${r.ok ? `${Math.round(r.phases.totalMs)}ms` : r.error}\n`,
        );
      },
      now,
    });
  } finally {
    if (sampler) clearInterval(sampler);
  }

  const report = buildReport({ results, hostSamples, cpuCount, sessions: o.sessions, startedAt });
  stdout.write(o.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatBurstReport(report)}\n`);
  return report.failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`preview-burst-bench: ${err instanceof Error ? err.stack : err}\n`);
      process.exit(3);
    });
}
