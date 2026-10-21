/**
 * scripts/lib/preview-burst-bench-core.mjs — pure helpers for the
 * session-preview burst benchmark. ESM-only, no deps beyond Node, no
 * process.exit / argv / console so it is unit-testable and importable
 * from server-side code.
 *
 * The benchmark answers one question: what happens on this Hub when N
 * sessions open and start their dev-server preview at the same time?
 * It is the baseline for the preview-offload work (moving session dev
 * servers onto the runner fleet) and the comparison tool afterwards.
 *
 * Per session the harness records three durations:
 *
 *   workspaceReadyMs  burst start -> session created, worktree provisioned,
 *                     dependencies installed (the clone + install cost)
 *   previewReadyMs    preview/start issued -> `GET /preview/state` reports
 *                     `ready` (the dev-server boot alone)
 *   totalMs           burst start -> preview ready (what the user waited)
 */

import { percentile } from './dogfood-sla-core.mjs';

/**
 * Collapse the preview-state wire event into one of four phases. The
 * snapshot event is `{ event: null }` while nothing is registered yet
 * (the start route returns before the runtime row is written), then
 * `preview_starting`, then `preview` (ready) or `preview_failed`.
 *
 * @param {{kind?: string} | null | undefined} event
 * @returns {'none' | 'starting' | 'ready' | 'failed' | 'unknown'}
 */
export function classifyPreviewState(event) {
  if (!event) return 'none';
  switch (event.kind) {
    case 'preview_starting':
      return 'starting';
    case 'preview':
      return 'ready';
    case 'preview_failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * Compute the percentile block for one phase from the per-session
 * results. Only sessions that reached the phase contribute; the count
 * of sessions that did not is returned as `missing` so a fast p95 over
 * two survivors is never mistaken for a healthy run.
 *
 * @param {Array<{phases: Record<string, number | null>}>} results
 * @param {string} phase
 */
export function summarizePhase(results, phase) {
  const samples = results
    .map((r) => r?.phases?.[phase])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (samples.length === 0) {
    return { phase, count: 0, missing: results.length, p50: null, p95: null, min: null, max: null };
  }
  return {
    phase,
    count: samples.length,
    missing: results.length - samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

/**
 * Reduce host samples (`{atMs, load1, freeMemBytes, totalMemBytes}`)
 * to the numbers that matter for capacity: peak 1-minute load, lowest
 * free memory, and the load relative to the core count, which is what
 * tells you whether the box was saturated rather than merely busy.
 *
 * @param {Array<{atMs: number, load1: number, freeMemBytes: number, totalMemBytes: number}>} samples
 * @param {number} cpuCount
 */
export function summarizeHostSamples(samples, cpuCount) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      sampled: false,
      cpuCount,
      peakLoad1: null,
      peakLoadPerCpu: null,
      minFreeMemBytes: null,
      totalMemBytes: null,
    };
  }
  const peakLoad1 = Math.max(...samples.map((s) => s.load1));
  const minFreeMemBytes = Math.min(...samples.map((s) => s.freeMemBytes));
  const totalMemBytes = samples[0].totalMemBytes;
  return {
    sampled: true,
    cpuCount,
    samples: samples.length,
    peakLoad1,
    peakLoadPerCpu: cpuCount > 0 ? peakLoad1 / cpuCount : null,
    minFreeMemBytes,
    totalMemBytes,
  };
}

/**
 * Build the full report object from per-session results and host
 * samples. `results` entries are
 * `{ sessionId, ok, error?, phases: {workspaceReadyMs, previewReadyMs, totalMs} }`.
 */
export function buildReport({ results, hostSamples, cpuCount, sessions, startedAt }) {
  const failures = results.filter((r) => !r.ok);
  return {
    sessions,
    startedAt,
    succeeded: results.length - failures.length,
    failed: failures.length,
    failures: failures.map((f) => ({
      sessionId: f.sessionId ?? null,
      error: f.error ?? 'unknown',
    })),
    phases: {
      workspaceReady: summarizePhase(results, 'workspaceReadyMs'),
      previewReady: summarizePhase(results, 'previewReadyMs'),
      total: summarizePhase(results, 'totalMs'),
    },
    host: summarizeHostSamples(hostSamples, cpuCount),
  };
}

function fmtMs(v) {
  if (v == null) return 'n/a';
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function fmtGb(bytes) {
  if (bytes == null) return 'n/a';
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Markdown rendering of {@link buildReport}. Plain ASCII so it pastes
 * into a card comment or a wiki page unchanged.
 */
export function formatBurstReport(report) {
  const lines = [
    `## Preview burst: ${report.sessions} sessions`,
    ``,
    `- succeeded: ${report.succeeded} / ${report.sessions}`,
    `- failed: ${report.failed}`,
  ];
  for (const [label, s] of [
    ['workspace ready', report.phases.workspaceReady],
    ['preview boot', report.phases.previewReady],
    ['total', report.phases.total],
  ]) {
    lines.push(
      `- ${label}: p50 ${fmtMs(s.p50)}, p95 ${fmtMs(s.p95)}, max ${fmtMs(s.max)}` +
        (s.missing > 0 ? ` (${s.missing} never reached)` : ''),
    );
  }
  const h = report.host;
  if (h.sampled) {
    lines.push(
      `- host: peak load1 ${h.peakLoad1.toFixed(2)} on ${h.cpuCount} cpus (${h.peakLoadPerCpu.toFixed(2)}/cpu), ` +
        `min free mem ${fmtGb(h.minFreeMemBytes)} of ${fmtGb(h.totalMemBytes)}`,
    );
  } else {
    lines.push(`- host: not sampled`);
  }
  if (report.failures.length > 0) {
    lines.push(``, `### Failures`);
    for (const f of report.failures) {
      lines.push(`- ${f.sessionId ?? '(no session)'}: ${f.error}`);
    }
  }
  return lines.join('\n');
}

export const USAGE = `usage: preview-burst-bench --agent <agentId> [options]

Starts N sessions on <agentId> at once, provisions each worktree, starts
each session's dev-server preview and waits for every preview to report
ready. Prints per-phase p50/p95/max and the Hub host's peak load.

options:
  --agent <id>              agent to open sessions on (required)
  --sessions <n>            how many sessions to start at once (default: 10)
  --poll-interval-ms <n>    preview/state poll interval (default: 2000)
  --timeout-ms <n>          per-session cap from burst start (default: 600000)
  --host-sample-ms <n>      host load/mem sample interval (default: 1000)
  --no-host-sample          skip host sampling (when not running on the Hub host)
  --keep                    leave the sessions and previews running afterwards
  --json                    emit JSON instead of markdown
  --help                    print this message

exit codes:
  0  every session's preview became ready
  1  at least one session failed or timed out
  2  usage error
  3  the harness itself could not run (transport error)
`;

/**
 * Argv parser. Returns `{help}`, `{error}` or `{options}`; never exits.
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { help: true };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const options = {
    sessions: 10,
    pollIntervalMs: 2000,
    timeoutMs: 600_000,
    hostSampleMs: 1000,
    hostSample: true,
    keep: false,
    json: false,
  };
  const numeric = {
    '--sessions': 'sessions',
    '--poll-interval-ms': 'pollIntervalMs',
    '--timeout-ms': 'timeoutMs',
    '--host-sample-ms': 'hostSampleMs',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') options.json = true;
    else if (a === '--keep') options.keep = true;
    else if (a === '--no-host-sample') options.hostSample = false;
    else if (a === '--agent') {
      const v = argv[++i];
      if (!v) return { error: '--agent requires a value' };
      options.agent = v;
    } else if (a in numeric) {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isFinite(n) || n <= 0) {
        return { error: `${a} requires a positive number` };
      }
      options[numeric[a]] = n;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }
  if (!options.agent) return { error: '--agent <agentId> is required' };
  if (!Number.isInteger(options.sessions)) return { error: '--sessions must be an integer' };
  return { options };
}
