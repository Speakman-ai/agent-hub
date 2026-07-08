/**
 * parity-store.ts — persistence + recording surface for the Finalize↔GitHub
 * parity harness.
 *
 * The harness records, per commit, the Finalize verdict and the GitHub Actions
 * verdict, derives a {@link DivergenceClass} via `parity-classifier.ts`, and
 * persists one row per (project, commit) in `finalize_github_parity`. Every
 * record also emits a lightweight `finalize_github_parity` counter into the
 * existing `finalize_metrics` event log so the divergence rate shows up on the
 * adoption-metrics endpoint, and a `false_green` observation fires a loud alert
 * — that is the dangerous class the epic exit bar gates on (~0 over 200+ PRs).
 *
 * The table is the durable dataset; the metric is the aggregation/alert
 * surface. Writes are idempotent on (project_id, commit_sha): re-recording the
 * same commit (e.g. after GitHub finishes a slower job) updates the existing
 * row in place rather than appending duplicates. The metric counter is only
 * emitted when the divergence class actually changes, so re-recording an
 * unchanged observation does not inflate the counter.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Stmts } from '../types.js';
import { recordGithubParity, type MetricsDeps } from './metrics.js';
import {
  classifyDivergence,
  isDangerousDivergence,
  isDivergenceClass,
  type DivergenceClass,
  type ParityJob,
  type ParityVerdict,
} from './parity-classifier.js';

// ─── DDL ──────────────────────────────────────────────────────────────

/**
 * One row per (project, commit). `finalize_jobs` / `github_jobs` are JSON
 * arrays of `{ name, state }`. The unique index on (project_id, commit_sha)
 * backs the idempotent upsert. The (project_id, divergence_class) index makes
 * "list all false_green for this project" a single index seek.
 */
export const FINALIZE_PARITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS finalize_github_parity (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pr_number INTEGER,
    commit_sha TEXT NOT NULL,
    run_id TEXT,
    finalize_verdict TEXT NOT NULL,
    finalize_jobs TEXT NOT NULL DEFAULT '[]',
    github_verdict TEXT NOT NULL,
    github_jobs TEXT NOT NULL DEFAULT '[]',
    divergence_class TEXT NOT NULL,
    note TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_finalize_parity_commit
    ON finalize_github_parity(project_id, commit_sha);
  CREATE INDEX IF NOT EXISTS idx_finalize_parity_project_time
    ON finalize_github_parity(project_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_finalize_parity_class
    ON finalize_github_parity(project_id, divergence_class);
`;

// ─── Types ────────────────────────────────────────────────────────────

/** Raw `finalize_github_parity` row as stored (jobs are JSON strings). */
export interface ParityRow {
  id: string;
  project_id: string;
  pr_number: number | null;
  commit_sha: string;
  run_id: string | null;
  finalize_verdict: string;
  finalize_jobs: string;
  github_verdict: string;
  github_jobs: string;
  divergence_class: string;
  note: string | null;
  observed_at: number;
}

/** Decoded parity record — jobs parsed, returned to API callers. */
export interface ParityRecord {
  id: string;
  project_id: string;
  pr_number: number | null;
  commit_sha: string;
  run_id: string | null;
  finalize_verdict: ParityVerdict;
  finalize_jobs: ParityJob[];
  github_verdict: ParityVerdict;
  github_jobs: ParityJob[];
  divergence_class: DivergenceClass;
  note: string | null;
  observed_at: number;
}

export interface ParityObservationInput {
  projectId: string;
  commitSha: string;
  prNumber?: number | null;
  runId?: string | null;
  finalizeVerdict: ParityVerdict;
  finalizeJobs?: ParityJob[];
  githubVerdict: ParityVerdict;
  githubJobs?: ParityJob[];
  note?: string | null;
}

export interface ParityStoreDeps {
  stmts: Pick<
    Stmts,
    | 'upsertFinalizeParity'
    | 'getFinalizeParityByCommit'
    | 'listFinalizeParityInRange'
    | 'insertFinalizeMetric'
  >;
  /** Defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
  /** Defaults to `console.warn`. The false-green alert lands here. */
  log?: (msg: string) => void;
  /** Optional hook fired once per newly-observed `false_green`. */
  onFalseGreen?: (record: ParityRecord) => void;
}

// ─── Record ───────────────────────────────────────────────────────────

/**
 * Record (or update) one parity observation. Derives the divergence class,
 * upserts the row keyed on (project, commit), emits the parity counter metric
 * when the class is new or changed, and fires a loud alert on `false_green`.
 *
 * Returns the persisted {@link ParityRecord} (re-read from the DB so the
 * returned `id` / `observed_at` reflect what is actually stored, including the
 * preserved id when an existing row was updated).
 */
export function recordParity(deps: ParityStoreDeps, input: ParityObservationInput): ParityRecord {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const divergenceClass = classifyDivergence(input.finalizeVerdict, input.githubVerdict);
  const finalizeJobs = input.finalizeJobs ?? [];
  const githubJobs = input.githubJobs ?? [];

  const existing = deps.stmts.getFinalizeParityByCommit.get(input.projectId, input.commitSha) as
    | ParityRow
    | undefined;
  const id = existing?.id ?? uuidv4();
  const observedAt = now();

  deps.stmts.upsertFinalizeParity.run(
    id,
    input.projectId,
    input.prNumber ?? null,
    input.commitSha,
    input.runId ?? null,
    input.finalizeVerdict,
    JSON.stringify(finalizeJobs),
    input.githubVerdict,
    JSON.stringify(githubJobs),
    divergenceClass,
    input.note ?? null,
    observedAt,
  );

  const classChanged = !existing || existing.divergence_class !== divergenceClass;

  // Emit the aggregation/alert counter only when the observation is new or its
  // class flipped — re-recording an unchanged observation must not inflate the
  // false-green rate.
  if (classChanged) {
    const metricsDeps: MetricsDeps = { stmts: deps.stmts, now, log };
    recordGithubParity(metricsDeps, {
      projectId: input.projectId,
      runId: input.runId ?? null,
      divergenceClass,
    });
  }

  const record: ParityRecord = {
    id,
    project_id: input.projectId,
    pr_number: input.prNumber ?? null,
    commit_sha: input.commitSha,
    run_id: input.runId ?? null,
    finalize_verdict: input.finalizeVerdict,
    finalize_jobs: finalizeJobs,
    github_verdict: input.githubVerdict,
    github_jobs: githubJobs,
    divergence_class: divergenceClass,
    note: input.note ?? null,
    observed_at: observedAt,
  };

  if (isDangerousDivergence(divergenceClass) && classChanged) {
    log(
      `[finalize-parity] ALERT false_green project=${input.projectId} ` +
        `commit=${input.commitSha}${input.prNumber != null ? ` pr=#${input.prNumber}` : ''} — ` +
        `Finalize said GREEN but GitHub said RED. This commit would have shipped broken if ` +
        `GitHub were retired as source of truth.`,
    );
    try {
      deps.onFalseGreen?.(record);
    } catch (err) {
      log(
        `[finalize-parity] onFalseGreen hook threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return record;
}

// ─── Read ─────────────────────────────────────────────────────────────

function parseJobs(json: string): ParityJob[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ParityJob[]) : [];
  } catch {
    return [];
  }
}

function toVerdict(v: string): ParityVerdict {
  return v === 'green' || v === 'red' ? v : 'unknown';
}

export function decodeParityRow(row: ParityRow): ParityRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    pr_number: row.pr_number,
    commit_sha: row.commit_sha,
    run_id: row.run_id,
    finalize_verdict: toVerdict(row.finalize_verdict),
    finalize_jobs: parseJobs(row.finalize_jobs),
    github_verdict: toVerdict(row.github_verdict),
    github_jobs: parseJobs(row.github_jobs),
    divergence_class: isDivergenceClass(row.divergence_class)
      ? row.divergence_class
      : 'indeterminate',
    note: row.note,
    observed_at: row.observed_at,
  };
}

/**
 * List parity records for a project in a `[fromMs, toMs)` window, newest first.
 * Optionally filter to a single divergence class.
 */
export function listParityRecords(
  deps: Pick<ParityStoreDeps, 'stmts'>,
  args: {
    projectId: string;
    fromMs: number;
    toMs: number;
    divergenceClass?: DivergenceClass | null;
  },
): ParityRecord[] {
  const rows = deps.stmts.listFinalizeParityInRange.all(
    args.projectId,
    args.fromMs,
    args.toMs,
  ) as ParityRow[];
  const records = rows.map(decodeParityRow);
  if (args.divergenceClass) {
    return records.filter((r) => r.divergence_class === args.divergenceClass);
  }
  return records;
}

export interface ParitySummary {
  total: number;
  agree_green: number;
  agree_red: number;
  false_green: number;
  false_red: number;
  indeterminate: number;
}

/** Count records by divergence class. Pure. */
export function summarizeParity(records: ReadonlyArray<ParityRecord>): ParitySummary {
  const summary: ParitySummary = {
    total: records.length,
    agree_green: 0,
    agree_red: 0,
    false_green: 0,
    false_red: 0,
    indeterminate: 0,
  };
  for (const r of records) {
    summary[r.divergence_class] += 1;
  }
  return summary;
}

// ─── Seed ─────────────────────────────────────────────────────────────

/**
 * Known parity observations to seed a fresh dataset with. The first entry is
 * PR webapp#1001 (commit 6ad87ec) — the documented false-green that
 * motivated this harness: Finalize green (0 failing jobs), GitHub red (3
 * failing jobs).
 */
export const KNOWN_PARITY_SEEDS: ReadonlyArray<Omit<ParityObservationInput, 'projectId'>> = [
  {
    commitSha: '6ad87ec',
    prNumber: 1001,
    finalizeVerdict: 'green',
    finalizeJobs: [
      { name: 'backend', state: 'green' },
      { name: 'frontend', state: 'green' },
      { name: 'e2e', state: 'green' },
    ],
    githubVerdict: 'red',
    githubJobs: [
      { name: 'backend', state: 'red' },
      { name: 'frontend', state: 'red' },
      { name: 'e2e', state: 'red' },
    ],
    note: 'Seed: PR webapp#1001 — first known false_green (Finalize 0 vs GitHub 3 failing).',
  },
];

/**
 * Seed a project's parity dataset with {@link KNOWN_PARITY_SEEDS}. Idempotent:
 * the upsert keys on (project, commit), so re-running is a no-op for unchanged
 * seeds. Returns the persisted records.
 */
export function seedKnownParityObservations(
  deps: ParityStoreDeps,
  projectId: string,
): ParityRecord[] {
  return KNOWN_PARITY_SEEDS.map((seed) => recordParity(deps, { ...seed, projectId }));
}
