/**
 * finalize-parity.ts — REST surface for the Finalize↔GitHub parity harness.
 *
 * The harness records, per commit, the Finalize verdict vs the GitHub Actions
 * verdict and a derived divergence class (see
 * `server/finalize/parity-classifier.ts` + `parity-store.ts`). These endpoints
 * are the dogfood surface for the dataset:
 *
 *   - `GET  /api/projects/:projectId/finalize/parity`
 *       List parity records in a time window with a class breakdown summary.
 *       Optional `?class=` filter and `?range=` window (same grammar as the
 *       finalize metrics endpoint).
 *
 *   - `POST /api/projects/:projectId/finalize/parity`
 *       Record (or update, idempotent on commit) one parity observation.
 *       Fires the false-green alert + metric. This is the ingestion entry
 *       point a CI script or webhook calls. Auto-capture from live Finalize
 *       runs (GitHub check-suite webhook) is tracked as a separate card.
 *
 *   - `POST /api/projects/:projectId/finalize/parity/seed`
 *       Seed the project's dataset with the known false-greens (PR#1001).
 *       Idempotent.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import { parseRange } from '../finalize/metrics.js';
import {
  isDivergenceClass,
  type DivergenceClass,
  type ParityJob,
  type ParityVerdict,
} from '../finalize/parity-classifier.js';
import {
  listParityRecords,
  recordParity,
  seedKnownParityObservations,
  summarizeParity,
  type ParityStoreDeps,
} from '../finalize/parity-store.js';

const PARITY_VERDICTS: ReadonlySet<string> = new Set(['green', 'red', 'unknown']);
const PARITY_JOB_STATES: ReadonlySet<string> = new Set(['green', 'red', 'unknown', 'skipped']);

function isVerdict(value: unknown): value is ParityVerdict {
  return typeof value === 'string' && PARITY_VERDICTS.has(value);
}

/** Validate and normalize the `jobs` array from a record request body. */
function parseJobsInput(raw: unknown): ParityJob[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'jobs must be an array of { name, state }' };
  const out: ParityJob[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'each job must be an object { name, state }' };
    }
    const j = item as Record<string, unknown>;
    if (typeof j.name !== 'string') return { error: 'each job needs a string name' };
    if (typeof j.state !== 'string' || !PARITY_JOB_STATES.has(j.state)) {
      return { error: 'each job state must be one of green|red|unknown|skipped' };
    }
    out.push({ name: j.name, state: j.state as ParityJob['state'] });
  }
  return out;
}

export default function createFinalizeParityRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  const storeDeps: ParityStoreDeps = {
    stmts,
    log: (msg: string) => console.warn(msg),
    onFalseGreen: (record) => {
      try {
        deps.broadcast({
          type: 'finalize_parity_alert',
          projectId: record.project_id,
          record: record as unknown as Record<string, unknown>,
        });
      } catch {
        /* broadcast is best-effort — the alert already logged. */
      }
    },
  };

  // ── GET parity records + summary ────────────────────────────────────
  router.get('/api/projects/:projectId/finalize/parity', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const range = parseRange(typeof req.query.range === 'string' ? req.query.range : null);
    if (!range) {
      return res.status(400).json({
        error: 'invalid_range',
        message:
          'range must be `<N><m|h|d>` (e.g. `7d`, `24h`) or `<isoFrom>..<isoTo>` with from < to.',
      });
    }

    let classFilter: DivergenceClass | null = null;
    if (typeof req.query.class === 'string' && req.query.class.trim().length > 0) {
      const c = req.query.class.trim();
      if (!isDivergenceClass(c)) {
        return res.status(400).json({
          error: 'invalid_class',
          message:
            'class must be one of agree_green|agree_red|false_green|false_red|indeterminate.',
        });
      }
      classFilter = c;
    }

    let records;
    try {
      records = listParityRecords(
        { stmts },
        {
          projectId: project.id,
          fromMs: range.fromMs,
          toMs: range.toMs,
          divergenceClass: classFilter,
        },
      );
    } catch (err) {
      console.warn(
        `[finalize-parity] read failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'parity_read_failed' });
    }

    // Summary always reflects the full window (unfiltered), so callers see the
    // false-green count even when filtering the record list to one class.
    const summarySource = classFilter
      ? listParityRecords(
          { stmts },
          { projectId: project.id, fromMs: range.fromMs, toMs: range.toMs },
        )
      : records;

    return res.json({
      project_id: project.id,
      range: {
        from_ms: range.fromMs,
        to_ms: range.toMs,
        from_iso: new Date(range.fromMs).toISOString(),
        to_iso: new Date(range.toMs).toISOString(),
      },
      summary: summarizeParity(summarySource),
      records,
    });
  });

  // ── POST record one observation ─────────────────────────────────────
  router.post('/api/projects/:projectId/finalize/parity', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const commitSha = typeof body.commit_sha === 'string' ? body.commit_sha.trim() : '';
    if (!commitSha) {
      return res.status(400).json({ error: 'commit_sha is required' });
    }
    if (!isVerdict(body.finalize_verdict)) {
      return res.status(400).json({ error: 'finalize_verdict must be green|red|unknown' });
    }
    if (!isVerdict(body.github_verdict)) {
      return res.status(400).json({ error: 'github_verdict must be green|red|unknown' });
    }

    const finalizeJobs = parseJobsInput(body.finalize_jobs);
    if (!Array.isArray(finalizeJobs)) {
      return res.status(400).json({ error: `finalize_jobs: ${finalizeJobs.error}` });
    }
    const githubJobs = parseJobsInput(body.github_jobs);
    if (!Array.isArray(githubJobs)) {
      return res.status(400).json({ error: `github_jobs: ${githubJobs.error}` });
    }

    let prNumber: number | null = null;
    if (body.pr_number != null) {
      const n = Number(body.pr_number);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: 'pr_number must be a positive integer' });
      }
      prNumber = n;
    }

    let record;
    try {
      record = recordParity(storeDeps, {
        projectId: project.id,
        commitSha,
        prNumber,
        runId: typeof body.run_id === 'string' ? body.run_id : null,
        finalizeVerdict: body.finalize_verdict,
        finalizeJobs,
        githubVerdict: body.github_verdict,
        githubJobs,
        note: typeof body.note === 'string' ? body.note : null,
      });
    } catch (err) {
      console.warn(
        `[finalize-parity] write failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'parity_write_failed' });
    }

    return res.status(201).json({ record });
  });

  // ── POST seed known false-greens ────────────────────────────────────
  router.post('/api/projects/:projectId/finalize/parity/seed', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let records;
    try {
      records = seedKnownParityObservations(storeDeps, project.id);
    } catch (err) {
      console.warn(
        `[finalize-parity] seed failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'parity_seed_failed' });
    }

    return res.status(201).json({ project_id: project.id, seeded: records.length, records });
  });

  return router;
}
