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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { RouteDeps, Agent, Project } from '../types.js';
import { defaultModelForEngine } from '../config.js';
import {
  runAudit,
  suggestTracks,
  type AuditInput,
  type AuditReport,
  type AgentLike,
} from '../audit/audit-service.js';

// ─── AGENTS.md roster section markers ─────────────────────────────
// Keep idempotent across re-runs: the block between these markers is
// rewritten on every POST /roster. Callers may freely edit prose outside
// the block.
const ROSTER_MARKER_START = '<!-- agent-hub-roster:start -->';
const ROSTER_MARKER_END = '<!-- agent-hub-roster:end -->';

interface ResolvedTrack {
  id: string;
  label: string;
  agentId: string;
  custom: boolean;
}

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

/**
 * Format the roster as a markdown block fenced by
 * {@link ROSTER_MARKER_START}/{@link ROSTER_MARKER_END}. Called from the
 * POST /roster handler and exported for tests.
 */
export function formatRosterSection(tracks: ResolvedTrack[]): string {
  const lines = [
    ROSTER_MARKER_START,
    '## Agent Roster',
    '',
    '_This section is managed by Agent Hub — edits between the markers will be overwritten on the next roster save._',
    '',
  ];
  if (tracks.length === 0) {
    lines.push('_No agents assigned._');
  } else {
    for (const t of tracks) {
      const custom = t.custom ? ' _(new)_' : '';
      lines.push(`- **${t.label}** (\`${t.agentId}\`) — role: ${t.label}${custom}`);
    }
  }
  lines.push('', ROSTER_MARKER_END);
  return lines.join('\n') + '\n';
}

/**
 * Idempotently write the roster section into the project workspace
 * AGENTS.md. Creates the file if missing. If markers exist, the block
 * between them is replaced; otherwise the block is appended.
 */
function writeRosterToAgentsMd(project: Project, tracks: ResolvedTrack[]): void {
  const workspace = project.ahw || project.cwd;
  if (!workspace) return;
  mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'AGENTS.md');
  const section = formatRosterSection(tracks);

  let existing = '';
  if (existsSync(target)) {
    try {
      existing = readFileSync(target, 'utf-8');
    } catch {
      existing = '';
    }
  }

  let next: string;
  if (!existing) {
    next = `# ${project.name} — Agents\n\n${section}`;
  } else {
    const startIdx = existing.indexOf(ROSTER_MARKER_START);
    const endIdx = existing.indexOf(ROSTER_MARKER_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + ROSTER_MARKER_END.length);
      next = `${before}${section}${after}`;
    } else {
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      next = `${existing}${sep}${section}`;
    }
  }
  writeFileSync(target, next, 'utf-8');
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
  // Accepts `{ tracks: [{ id, label, agentId?, custom? }] }`. Each track
  // must have **either** a non-empty `agentId` XOR `custom: true` — not
  // both, not neither. When `custom: true`, a fresh agent row is created
  // (id `<projectId>-<trackId>`, role = label, engine = default) and
  // linked to the project. AGENTS.md in the project workspace is
  // rewritten (between markers) to reflect the confirmed roster.
  router.post('/api/projects/:projectId/roster', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const project = deps.findProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const payload = (req.body ?? {}) as RosterPayload;
    if (!Array.isArray(payload.tracks)) {
      return res.status(400).json({ error: 'invalid payload: tracks[] required' });
    }
    if (payload.tracks.length === 0) {
      return res.status(400).json({ error: 'invalid payload: no usable tracks' });
    }

    // ─── Validate every track has `agentId` XOR `custom:true` ────────
    const resolved: ResolvedTrack[] = [];
    for (let i = 0; i < payload.tracks.length; i++) {
      const t = payload.tracks[i];
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || t.id.length === 0) {
        return res.status(400).json({
          error: `invalid track at index ${i}: id must be a non-empty string`,
        });
      }
      const hasAgentId = typeof t.agentId === 'string' && t.agentId.length > 0;
      const isCustom = t.custom === true;
      if (hasAgentId === isCustom) {
        // Either both set or neither set — violates XOR contract.
        return res.status(400).json({
          error: `invalid track "${t.id}": must have either agentId OR custom:true (exactly one)`,
        });
      }
      const label = typeof t.label === 'string' && t.label.length > 0 ? t.label : t.id;
      if (hasAgentId) {
        // Non-custom track: verify the agent exists.
        const found = deps.findAgent(t.agentId as string);
        if (!found) {
          return res.status(400).json({
            error: `unknown agentId "${t.agentId}" for track "${t.id}"`,
          });
        }
        resolved.push({
          id: t.id,
          label,
          agentId: t.agentId as string,
          custom: false,
        });
      } else {
        // Custom track — defer id generation until after all validation
        // so we don't half-create agents on a later-track failure.
        resolved.push({
          id: t.id,
          label,
          agentId: '',
          custom: true,
        });
      }
    }

    // ─── Create agents for custom tracks ────────────────────────────
    // Idempotent: re-running with the same custom track reuses the
    // existing agent row rather than colliding. We only push a new
    // Agent onto the project when one with the resolved id does not
    // already exist.
    const defaultEngine = 'claude-code';
    let agentsChanged = false;
    for (const track of resolved) {
      if (!track.custom) continue;
      const candidateId = `${project.id}-${track.id}`;
      track.agentId = candidateId;
      const existing = deps.findAgent(candidateId);
      if (existing) {
        // Refresh human-readable metadata — label may have been edited.
        existing.agent.role = track.label;
        if (!existing.agent.name) existing.agent.name = track.label;
        continue;
      }
      const engine = defaultEngine;
      const agent: Agent = {
        id: candidateId,
        name: track.label,
        engine,
        model: defaultModelForEngine(engine),
        role: track.label,
        color: project.color || '#6b7280',
        systemPrompt: `You are the ${track.label} agent for the ${project.name} project.`,
        heartbeat: { enabled: false, interval: '', prompt: '' },
      };
      // Mirror the POST /api/agents convention: each agent gets a
      // per-project data subdir. Failure here is non-fatal — the DB
      // row is the source of truth; the filesystem scaffolding is a
      // convenience for context files.
      try {
        if (project.ahw) {
          mkdirSync(path.join(project.ahw, 'agents', candidateId), { recursive: true });
        }
      } catch {
        /* ignore */
      }
      project.agents.push(agent);
      agentsChanged = true;
    }
    if (agentsChanged) {
      deps.saveProjects();
      try {
        deps.ensureProjectRoom(project);
      } catch {
        /* non-fatal */
      }
    }

    // ─── Persist the roster JSON blob ───────────────────────────────
    const sanitized = resolved.map((r) => ({
      id: r.id,
      label: r.label,
      agentId: r.agentId,
      custom: r.custom,
    }));
    stmts.upsertProjectRoster.run(projectId, JSON.stringify(sanitized));
    const row = stmts.getProjectRoster.get(projectId) as RosterRow | undefined;

    // ─── Write AGENTS.md — idempotent between markers ───────────────
    try {
      writeRosterToAgentsMd(project, sanitized);
    } catch (err: unknown) {
      // Non-fatal — the roster row is persisted; surface the error
      // via a header so the client can show a warning without 500-ing.
      res.setHeader('x-roster-agents-md-warning', (err as Error).message);
    }

    return res.status(200).json({
      tracks: sanitized,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    });
  });

  return router;
}
