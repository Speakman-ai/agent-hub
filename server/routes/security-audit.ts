/**
 * security-audit.ts — REST surface for the Dependabot-style dependency
 * security audit of Hub-hosted repos.
 *
 *   GET  /api/projects/:id/security-audit/findings        list + severity counts
 *   POST /api/projects/:id/security-audit/scan            scan now (OSV) + card
 *   POST /api/projects/:id/security-audit/findings/:fid/dismiss   suppress
 *
 * The advisory source, store, and scan orchestrator are injectable so the
 * route is testable without hitting OSV or a real git repo (see
 * security-audit.test.ts). Production defaults: OSV over the network and a
 * store bound to the shared sqlite handle.
 */

import { Router, type Request, type Response } from 'express';
import type { RouteDeps, Project } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import { getDb } from '../db.js';
import {
  createSecurityAuditStore,
  type SecurityAuditStore,
  type SecurityFindingRow,
} from '../security-audit/findings-store.js';
import { OsvAdvisorySource } from '../security-audit/osv.js';
import type { AdvisorySource, Severity } from '../security-audit/types.js';
import { runSecurityScan, SecurityScanError } from '../security-audit/run.js';
import {
  dispatchSecurityFixSession,
  selectFixableFindings,
} from '../security-audit/fix-session.js';
import {
  maybeDispatchAutofixAfterScan,
  resolveSecurityFixAutomation,
  NO_FIX_AGENT_ERROR,
} from '../security-audit/autofix.js';
import {
  BatchFixRequestSchema,
  DismissRequestSchema,
  FindingsQuerySchema,
  ScanRequestSchema,
} from './security-audit.openapi.js';

/** Public finding shape: the persisted row minus internal-only columns. */
export type SecurityFindingDto = Omit<SecurityFindingRow, 'last_scan_id'>;

/**
 * Map a persisted finding row to its public DTO, stripping internal persistence
 * markers (`last_scan_id`) so an implementation detail never leaks into the API
 * contract.
 */
export function toFindingDto(row: SecurityFindingRow): SecurityFindingDto {
  // Explicit projection (not a `{ last_scan_id, ...rest }` omit) so an unused
  // binding never trips noUnusedLocals, and so adding a future internal column
  // doesn't silently leak through a spread.
  return {
    id: row.id,
    project_id: row.project_id,
    ecosystem: row.ecosystem,
    package_name: row.package_name,
    package_version: row.package_version,
    advisory_id: row.advisory_id,
    severity: row.severity,
    summary: row.summary,
    fixed_version: row.fixed_version,
    advisory_url: row.advisory_url,
    manifest_path: row.manifest_path,
    status: row.status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    scan_ref: row.scan_ref,
  };
}

export interface SecurityAuditRouteOptions {
  /** Override the store (tests). Defaults to one bound to the shared db. */
  store?: SecurityAuditStore;
  /** Override the advisory source (tests). Defaults to OSV over the network. */
  advisorySource?: AdvisorySource;
  /** Override the scan orchestrator (tests). Defaults to {@link runSecurityScan}. */
  runScan?: typeof runSecurityScan;
  /** Override session dispatch (tests). Defaults to {@link dispatchSecurityFixSession}. */
  dispatchFixSession?: typeof dispatchSecurityFixSession;
}

export default function createSecurityAuditRoutes(
  deps: RouteDeps,
  opts: SecurityAuditRouteOptions = {},
): Router {
  const router = Router();
  // Lazily bind the store so tests that never exercise these routes don't
  // force a db handle; in production getDb() is initialised before mount.
  let boundStore: SecurityAuditStore | null = opts.store ?? null;
  const store = (): SecurityAuditStore => {
    if (!boundStore) boundStore = createSecurityAuditStore(getDb());
    return boundStore;
  };
  const advisorySource: AdvisorySource = opts.advisorySource ?? new OsvAdvisorySource();
  const runScan = opts.runScan ?? runSecurityScan;
  const dispatchFixSession = opts.dispatchFixSession ?? dispatchSecurityFixSession;

  // Dispatch collaborators, shared by the per-finding Fix route, the batch
  // "fix all by severity" route, and the scan-path Autofix so all three
  // converge on the same behavior: hand the findings to an agent session (bump
  // + re-resolve lockfile + tests), which Finalize then turns into a PR — or
  // an auto-merged PR when the project opted into that.
  const dispatchDeps = () => ({
    stmts: deps.stmts,
    config: deps.config,
    findAgent: deps.findAgent,
    handleChat: deps.handleChat,
  });

  const dispatchFix = (
    project: Project,
    findings: SecurityFindingRow[],
    ownerUserId: string | null,
  ) =>
    dispatchFixSession(dispatchDeps(), {
      project,
      findings,
      ownerUserId,
      // Same PR-vs-auto-merge choice the unattended scans honour, so a manual
      // Fix click behaves like the automatic one for the same project.
      automation: resolveSecurityFixAutomation(project),
    });

  // Project ACCESS (view) is enforced upstream by the project-visibility gate
  // mounted at `/api/projects/:projectId` (server/project-visibility-middleware.ts),
  // which 404-masks projects the caller can't view BEFORE this router runs — so a
  // caller cannot list/scan/dismiss findings for a project they can't see. The
  // mutating endpoints below additionally require the Admin role (see
  // requireRole), matching the git-host repo-mutation convention: a mere viewer
  // must not be able to trigger scans/cards or dismiss/suppress security findings.
  const findProjectOr404 = (req: Request, res: Response): Project | null => {
    const project = deps.findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  };

  router.get('/api/projects/:projectId/security-audit/findings', (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    // Validate the status filter against the enum rather than silently ignoring
    // a typo (?status=dismisssed) and returning ALL findings — which would
    // mislead the caller and diverge from the documented schema.
    const parsed = FindingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' });
    }
    const { status } = parsed.data;
    const findings = store()
      .listFindings(project.id, status ? { status } : undefined)
      .map(toFindingDto);
    const openCounts = store().countOpenBySeverity(project.id);
    res.json({ findings, openCounts });
  });

  router.post(
    '/api/projects/:projectId/security-audit/scan',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      // Validate the body against the schema (mutating endpoint): a client typo
      // like { ref: 123 } or { generateCard: "false" } must 400, not silently
      // fall through to a different scan / card-generation behavior.
      const parsed = ScanRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const ref = parsed.data.ref;
      const generateCard = parsed.data.generateCard !== false;
      const createdBy = (req as AuthenticatedRequest).authUserId ?? null;
      // Autofix dispatches an agent session over the open findings AFTER the
      // scan persists them. The gating (hosted-only, explicit click vs. the
      // `securityAutoPr.enabled` opt-in, dry-run and fresh-findings rules) lives
      // in security-audit/autofix.ts so the scheduled and on-push scans behave
      // identically.
      const explicitAutofix = parsed.data.autoPr === true;
      try {
        const result = await runScan(
          {
            stmts: deps.stmts,
            broadcast: deps.broadcast,
            advisorySource,
            store: store(),
          },
          { project, ref, generateCard, createdBy },
        );
        const autofix = maybeDispatchAutofixAfterScan(
          { ...dispatchDeps(), store: store(), dispatch: dispatchFixSession },
          {
            project,
            scan: {
              dryRun: result.dryRun,
              newFindings: result.summary.newFindings.length,
              reopened: result.summary.reopenedFindings.length,
            },
            explicit: explicitAutofix,
            ownerUserId: createdBy,
          },
        );
        const fixSession = autofix.session;
        const fixSessionError = autofix.error;
        res.json({
          ref: result.ref,
          dryRun: result.dryRun,
          scannedManifests: result.scannedManifests,
          failedManifests: result.failedManifests,
          truncated: result.truncated,
          dependencyCount: result.dependencyCount,
          vulnerableFindings: result.vulnerableFindings,
          newFindings: result.summary.newFindings.length,
          reopened: result.summary.reopenedFindings.length,
          updated: result.summary.updated,
          fixed: result.summary.fixed,
          suppressed: result.summary.suppressed,
          cardId: result.cardId,
          fixSession,
          fixSessionError,
        });
      } catch (err: unknown) {
        if (err instanceof SecurityScanError) {
          // bad_ref is a client mistake (typo'd ref) → 400; not-hosted / empty
          // repo are state conflicts → 409.
          const status = err.code === 'bad_ref' ? 400 : 409;
          return res.status(status).json({ error: err.message });
        }
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Scan failed: ${msg.split('\n')[0]}` });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/security-audit/findings/:id/fix',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      // Findings only exist for Hub-hosted repos. A session resolves any
      // ecosystem (npm + pip), so the npm-only / native-PR gates the old bump-PR
      // path needed are gone — the session commits and Finalize opens the PR.
      if (project.gitHost !== 'agenthub') {
        return res.status(409).json({ error: 'Project is not Agent Hub-hosted.' });
      }
      const finding = store().getFinding(project.id, req.params.id as string);
      if (!finding) return res.status(404).json({ error: 'Finding not found' });
      if (finding.status !== 'open') {
        return res
          .status(409)
          .json({ error: `Finding is ${finding.status}; only open findings can be fixed.` });
      }

      // Hand the agent EVERY open finding for the project (not just the clicked
      // row): the session resolves them in one branch → one PR, matching the
      // "all fixes together" model and avoiding a per-package session pile-up.
      const open = selectFixableFindings(store().listFindings(project.id, { status: 'open' }));
      const createdBy = (req as AuthenticatedRequest).authUserId ?? null;
      const dispatched = dispatchFix(project, open, createdBy);
      if (!dispatched) {
        return res.status(409).json({ error: NO_FIX_AGENT_ERROR });
      }
      // 200 when an already-running fix session was reused (idempotency guard),
      // 201 when a new one was started.
      res.status(dispatched.reused ? 200 : 201).json({
        sessionId: dispatched.sessionId,
        agentId: dispatched.agentId,
        findingCount: dispatched.findingCount,
        reused: dispatched.reused,
        session: dispatched.session,
      });
    },
  );

  // Batch "fix all by severity": dispatch a session over EVERY open finding,
  // optionally narrowed to a severity threshold.
  //
  //   {}                      → fix all open findings (any severity)
  //   { minSeverity: 'high' } → fix critical AND high (threshold, not exact)
  //
  // Threshold (vs. exact-severity) semantics are deliberate: you would never
  // want to fix all high while leaving the more-urgent criticals stranded. Same
  // Admin / Hub-hosted gate as the per-finding Fix route.
  router.post(
    '/api/projects/:projectId/security-audit/fix',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      if (project.gitHost !== 'agenthub') {
        return res.status(409).json({ error: 'Project is not Agent Hub-hosted.' });
      }
      const parsed = BatchFixRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const minSeverity = (parsed.data.minSeverity ?? null) as Severity | null;
      const group = selectFixableFindings(store().listFindings(project.id, { status: 'open' }), {
        minSeverity,
      });
      const createdBy = (req as AuthenticatedRequest).authUserId ?? null;
      const dispatched = dispatchFix(project, group, createdBy);
      if (!dispatched) {
        // No agent → 409; no matching finding → 200 with a null session (nothing
        // to do is not an error, mirroring the old empty-`opened` response).
        if (group.length === 0) {
          return res.json({
            sessionId: null,
            agentId: null,
            findingCount: 0,
            reused: false,
            session: null,
          });
        }
        return res.status(409).json({ error: NO_FIX_AGENT_ERROR });
      }
      // 200 when an already-running fix session was reused, 201 when new.
      res.status(dispatched.reused ? 200 : 201).json({
        sessionId: dispatched.sessionId,
        agentId: dispatched.agentId,
        findingCount: dispatched.findingCount,
        reused: dispatched.reused,
        session: dispatched.session,
      });
    },
  );

  router.post(
    '/api/projects/:projectId/security-audit/findings/:id/dismiss',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      const parsed = DismissRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const createdBy = (req as AuthenticatedRequest).authUserId ?? null;
      const updated = store().dismissFinding({
        projectId: project.id,
        id: req.params.id as string,
        reason: parsed.data.reason ?? null,
        createdBy,
        suppress: parsed.data.suppress !== false,
      });
      if (!updated) return res.status(404).json({ error: 'Finding not found' });
      res.json(toFindingDto(updated));
    },
  );

  return router;
}
