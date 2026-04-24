/**
 * Post-scaffold audit routes.
 *
 *   GET  /api/projects/:projectId/audit             — latest persisted report
 *   POST /api/projects/:projectId/audit/refresh     — regenerate sync, persist, return
 *   GET  /api/projects/:projectId/roster/suggest    — keyword-matched track → agent map
 *   POST /api/projects/:projectId/roster            — persist user-chosen roster
 *   GET  /api/projects/:projectId/roster            — read back persisted roster
 *
 * Audit reports and rosters live in dedicated tables so the Act IV
 * landing page can re-render without re-running the audit. Persistence
 * is JSON-blob in SQLite — the report shape is owned by the audit
 * service, not the table schema.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import {
  runAudit,
  suggestTracks,
  type AuditInput,
  type AuditReport,
  type AgentLike,
} from '../audit/audit-service.js';

interface AuditServiceRunner {
  (input: AuditInput): Promise<AuditReport>;
}

let auditRunner: AuditServiceRunner = runAudit;

/** Test hook — swap the audit implementation for a deterministic stub. */
export function setAuditRunner(runner: AuditServiceRunner): void {
  auditRunner = runner;
}

/** Test hook — restore the production runner. */
export function resetAuditRunner(): void {
  auditRunner = runAudit;
}

interface RosterPayload {
  tracks?: Array<{
    id?: string;
    label?: string;
    agentId?: string | null;
    custom?: boolean;
  }>;
}

interface RosterRow {
  tracks_json: string;
  updated_at: string;
}

interface AuditReportRow {
  report_json: string;
  generated_at: string;
}

function readEnrichedAgents(deps: RouteDeps): AgentLike[] {
  try {
    return deps.allAgents().map((a) => ({
      id: a.id,
      name: a.name,
      role: (a as { role?: string | null }).role ?? null,
      tags: (a as { tags?: string[] | null }).tags ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Pull the integration list from the most-recent provisioning job for
 * this project. Falls back to `null` (treated as "unknown") when there
 * is no provisioning history — e.g. projects imported manually.
 */
function lookupIntegrations(deps: RouteDeps, projectId: string): string[] | 'idk' | null {
  try {
    const row = deps.stmts.getLatestProvisioningJobForProject.get(projectId) as
      | { payload_json?: string }
      | undefined;
    if (!row?.payload_json) return null;
    const parsed = JSON.parse(row.payload_json) as { integrations?: string[] | 'idk' | null };
    return parsed.integrations ?? null;
  } catch {
    return null;
  }
}

export default function createAuditRoutes(deps: RouteDeps): Router {
  const router = Router();
  const { stmts } = deps;

  // ─── GET audit ────────────────────────────────────────────────────
  router.get('/api/projects/:projectId/audit', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const row = stmts.getAuditReport.get(projectId) as AuditReportRow | undefined;
    if (!row) {
      return res
        .status(404)
        .json({ error: 'audit not found — POST /audit/refresh to generate one' });
    }
    try {
      const report = JSON.parse(row.report_json) as AuditReport;
      return res.json(report);
    } catch (err: unknown) {
      return res.status(500).json({
        error: `Stored audit report is corrupt: ${(err as Error).message}`,
      });
    }
  });

  // ─── POST audit/refresh ───────────────────────────────────────────
  router.post('/api/projects/:projectId/audit/refresh', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const integrations = lookupIntegrations(deps, projectId);
    const agents = readEnrichedAgents(deps);
    const cwd = project.cwd || project.ahw;

    try {
      const report = await auditRunner({
        projectId,
        cwd,
        integrations,
        agents,
      });
      stmts.upsertAuditReport.run(projectId, JSON.stringify(report));
      return res.status(200).json(report);
    } catch (err: unknown) {
      return res.status(500).json({
        error: `audit failed: ${(err as Error).message}`,
      });
    }
  });

  // ─── GET roster/suggest ───────────────────────────────────────────
  router.get('/api/projects/:projectId/roster/suggest', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const tracks = suggestTracks(readEnrichedAgents(deps));
    return res.json({ tracks });
  });

  // ─── GET roster ───────────────────────────────────────────────────
  router.get('/api/projects/:projectId/roster', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const row = stmts.getProjectRoster.get(projectId) as RosterRow | undefined;
    if (!row) return res.status(404).json({ error: 'roster not set' });
    try {
      const tracks = JSON.parse(row.tracks_json) as RosterPayload['tracks'];
      return res.json({ tracks: tracks ?? [], updatedAt: row.updated_at });
    } catch (err: unknown) {
      return res.status(500).json({
        error: `Stored roster is corrupt: ${(err as Error).message}`,
      });
    }
  });

  // ─── POST roster ──────────────────────────────────────────────────
  router.post('/api/projects/:projectId/roster', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const payload = (req.body ?? {}) as RosterPayload;
    if (!Array.isArray(payload.tracks)) {
      return res.status(400).json({ error: 'invalid payload: tracks[] required' });
    }
    const sanitized = payload.tracks
      .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id.length > 0)
      .map((t) => ({
        id: t.id as string,
        label: typeof t.label === 'string' ? t.label : (t.id as string),
        agentId: typeof t.agentId === 'string' ? t.agentId : null,
        custom: !!t.custom,
      }));
    if (sanitized.length === 0) {
      return res.status(400).json({ error: 'invalid payload: no usable tracks' });
    }
    const json = JSON.stringify(sanitized);
    stmts.upsertProjectRoster.run(projectId, json);
    const row = stmts.getProjectRoster.get(projectId) as RosterRow | undefined;
    return res.status(200).json({
      tracks: sanitized,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    });
  });

  return router;
}
