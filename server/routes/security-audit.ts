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
import type { AdvisorySource } from '../security-audit/types.js';
import { runSecurityScan, SecurityScanError } from '../security-audit/run.js';
import { openSecurityBumpPrs } from '../security-audit/auto-pr.js';
import { commitFilesToBareBranch } from '../security-audit/git-write.js';
import { resolveNativePrAuthorUserId } from '../native-pr/author-user.js';
import config from '../config.js';
import {
  gitHostRepoPath,
  hostedRepoDefaultBranch,
  hostedRepoExists,
} from '../git-host/repo-store.js';
import { gitRepoFileReader, type RepoFileReader } from '../security-audit/scanner.js';
import { revParse } from '../native-pr/git-read.js';
import type { DependencyFinding, Ecosystem } from '../security-audit/types.js';
import {
  DismissRequestSchema,
  FindingsQuerySchema,
  ScanRequestSchema,
} from './security-audit.openapi.js';

/** Resolved base for writing a bump branch into a project's bare hosted repo. */
interface FixRepoBase {
  repoPath: string;
  baseBranch: string;
  baseSha: string;
}

/**
 * Injectable seam for the per-finding Fix route so it is unit-testable without
 * a real git repo. Production defaults resolve the project's hosted bare repo,
 * read files from the default-branch tip, and commit to a bare branch.
 */
export interface SecurityFixDeps {
  /** Resolve repo path + default branch + tip SHA; `null` when not available. */
  resolveRepo: (project: Project) => Promise<FixRepoBase | null>;
  /** Build a file reader for the bare repo. */
  makeReader: (repoPath: string) => RepoFileReader;
  /** Commit `files` onto `branch` based on `baseSha`; returns the new head. */
  commitFiles: typeof commitFilesToBareBranch;
}

/** Reconstruct the rich {@link DependencyFinding} a bump plan needs from a stored row. */
export function findingRowToDependencyFinding(row: SecurityFindingRow): DependencyFinding {
  return {
    dependency: {
      ecosystem: row.ecosystem as Ecosystem,
      name: row.package_name,
      version: row.package_version,
      manifestPath: row.manifest_path,
    },
    advisory: {
      id: row.advisory_id,
      summary: row.summary,
      severity: row.severity,
      aliases: [],
      fixedVersion: row.fixed_version,
      url: row.advisory_url,
    },
  };
}

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
  /** Override the per-finding Fix git collaborators (tests). Defaults to git-backed. */
  fixDeps?: SecurityFixDeps;
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
  const fixDeps: SecurityFixDeps = opts.fixDeps ?? {
    // Resolve the project's bare hosted repo and pin the default-branch tip. The
    // bump branch is cut from this SHA, matching the scan-path auto-PR base.
    resolveRepo: async (project: Project): Promise<FixRepoBase | null> => {
      const dataDir = config.dataDir;
      if (!hostedRepoExists(project.id, dataDir)) return null;
      const repoPath = gitHostRepoPath(project.id, dataDir);
      const defaultBranch = await hostedRepoDefaultBranch(project.id, dataDir);
      if (!defaultBranch) return null;
      const baseSha = await revParse(repoPath, defaultBranch);
      if (!baseSha) return null;
      return { repoPath, baseBranch: defaultBranch, baseSha };
    },
    makeReader: (repoPath: string) => gitRepoFileReader(repoPath),
    commitFiles: commitFilesToBareBranch,
  };

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
      // Opt-in auto-PR: only for Hub-hosted projects that enabled the setting
      // AND when a native PR service is wired. The closure binds the git write
      // + PR open; run.ts invokes it after a successful (non-dry-run) scan,
      // reusing the findings it just computed. Author resolution / git failures
      // are swallowed by run.ts so they never fail the scan.
      const nativePr = deps.nativePr;
      // Auto-PR fires when EITHER the project opted in (securityAutoPr.enabled)
      // OR this request explicitly asked for it (the "Autofix" button passes
      // autoPr:true — an explicit click is its own opt-in). Both still require a
      // Hub-hosted repo and a wired native PR service.
      const autoPrRequested =
        parsed.data.autoPr === true || project.securityAutoPr?.enabled === true;
      const autoPrEnabled = project.gitHost === 'agenthub' && autoPrRequested && !!nativePr;
      const openBumpPrs = autoPrEnabled
        ? async (ctx: {
            project: Project;
            findings: Parameters<typeof openSecurityBumpPrs>[0];
            repoPath: string;
            reader: { readFile(ref: string, p: string): Promise<string | null> };
            baseBranch: string;
            baseSha: string;
          }) => {
            const author = resolveNativePrAuthorUserId({ explicitUserId: createdBy });
            return openSecurityBumpPrs(ctx.findings, {
              readFile: (p) => ctx.reader.readFile(ctx.baseSha, p),
              commitFiles: ({ branch, files, message }) =>
                commitFilesToBareBranch({
                  repoPath: ctx.repoPath,
                  baseSha: ctx.baseSha,
                  branch,
                  files,
                  message,
                }),
              createOrGetOpenPr: ({ headBranch, headSha, title, body }) => {
                const r = nativePr!.createOrGetOpenPr({
                  project: ctx.project,
                  headBranch,
                  baseBranch: ctx.baseBranch,
                  headSha,
                  title,
                  body,
                  author,
                });
                return { prNumber: r.row.number, prUrl: r.prUrl, prCreated: r.created };
              },
            });
          }
        : undefined;
      try {
        const result = await runScan(
          {
            stmts: deps.stmts,
            broadcast: deps.broadcast,
            advisorySource,
            store: store(),
            openBumpPrs,
          },
          { project, ref, generateCard, createdBy },
        );
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
          autoPr: result.autoPr,
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
    async (req: Request, res: Response) => {
      const project = findProjectOr404(req, res);
      if (!project) return;
      const nativePr = deps.nativePr;
      // Native bump PRs only exist for Hub-hosted repos with the native PR
      // service wired. Same gate as the scan-path auto-PR — a mirror/GitHub repo
      // has nowhere to open a native PR.
      if (project.gitHost !== 'agenthub' || !nativePr) {
        return res.status(409).json({
          error: 'Project is not Agent Hub-hosted or native pull requests are unavailable.',
        });
      }
      const finding = store().getFinding(project.id, req.params.id as string);
      if (!finding) return res.status(404).json({ error: 'Finding not found' });
      if (finding.status !== 'open') {
        return res
          .status(409)
          .json({ error: `Finding is ${finding.status}; only open findings can be fixed.` });
      }
      if (finding.ecosystem !== 'npm') {
        return res.status(409).json({
          error: `Automated fix is not supported for ${finding.ecosystem} dependencies yet.`,
        });
      }
      if (!finding.fixed_version) {
        return res.status(409).json({ error: 'No fix has been published for this advisory yet.' });
      }

      const repo = await fixDeps.resolveRepo(project);
      if (!repo) {
        return res
          .status(409)
          .json({ error: 'Hosted repository is unavailable; cannot open a bump PR.' });
      }

      // Bump the WHOLE package group in this manifest, not just the clicked row.
      // A package can be installed at several vulnerable versions at once (direct
      // + transitive copies); openSecurityBumpPrs groups by (manifest, package)
      // onto ONE deterministic branch. Passing only the single clicked finding
      // would leave sibling copies unbumped and risk a later single-finding fix
      // overwriting this branch. So gather every OPEN finding for the same
      // package+manifest.
      //
      // Filter the siblings to the SUPPORTED set up front — npm ecosystem AND a
      // published fixed_version — rather than relying on planSecurityBumps to
      // silently skip the rest. A sibling advisory with fixed_version: null or a
      // non-npm ecosystem is not actionable for this bump, and letting it into
      // the group is misleading (it would just be dropped) and lets an unrelated
      // advisory influence the planner's chosen target. The clicked finding is
      // already validated as npm + fixed (409s above), so it always survives.
      // (The planner still picks the MAX fixed version across the surviving
      // siblings — intended Dependabot semantics: one bump that resolves every
      // vulnerable copy of the package at once.)
      const group = store()
        .listFindings(project.id, { status: 'open' })
        .filter(
          (r) =>
            r.package_name === finding.package_name &&
            r.manifest_path === finding.manifest_path &&
            r.ecosystem === 'npm' &&
            r.fixed_version != null,
        )
        .map(findingRowToDependencyFinding);

      const createdBy = (req as AuthenticatedRequest).authUserId ?? null;
      const author = resolveNativePrAuthorUserId({ explicitUserId: createdBy });
      const reader = fixDeps.makeReader(repo.repoPath);
      try {
        const result = await openSecurityBumpPrs(group, {
          readFile: (p) => reader.readFile(repo.baseSha, p),
          commitFiles: ({ branch, files, message }) =>
            fixDeps.commitFiles({
              repoPath: repo.repoPath,
              baseSha: repo.baseSha,
              branch,
              files,
              message,
            }),
          createOrGetOpenPr: ({ headBranch, headSha, title, body }) => {
            const r = nativePr.createOrGetOpenPr({
              project,
              headBranch,
              baseBranch: repo.baseBranch,
              headSha,
              title,
              body,
              author,
            });
            return { prNumber: r.row.number, prUrl: r.prUrl, prCreated: r.created };
          },
        });
        res.json({ opened: result.opened, skipped: result.skipped });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Fix failed: ${msg.split('\n')[0]}` });
      }
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
