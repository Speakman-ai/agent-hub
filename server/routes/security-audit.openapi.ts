/**
 * security-audit.openapi.ts — Zod schemas + OpenAPI path registrations for
 * the dependency security-audit routes. Kept in a companion file so the
 * route module stays focused on handlers (the project convention for
 * larger route files).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = z.object({ error: z.string() });

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);

export const SecurityFindingSchema = registerComponent(
  'SecurityFinding',
  z.object({
    id: z.string(),
    project_id: z.string(),
    ecosystem: z.string(),
    package_name: z.string(),
    package_version: z.string(),
    advisory_id: z.string(),
    severity: SeveritySchema,
    summary: z.string(),
    fixed_version: z.string().nullable(),
    advisory_url: z.string(),
    manifest_path: z.string(),
    status: z.enum(['open', 'fixed', 'dismissed']),
    first_seen_at: z.number(),
    last_seen_at: z.number(),
    scan_ref: z.string().nullable(),
    // NOTE: the internal `last_scan_id` persistence marker is intentionally NOT
    // part of this public DTO — the route maps rows through toFindingDto() to
    // strip it so an implementation detail never becomes API contract.
  }),
);

export const SeverityCountsSchema = z.object({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  unknown: z.number(),
});

export const FindingsListSchema = z.object({
  findings: z.array(SecurityFindingSchema),
  /** Open-finding counts by severity (independent of the `status` filter). */
  openCounts: SeverityCountsSchema,
});

export const AutoPrResultSchema = z
  .object({
    opened: z.array(
      z.object({
        branch: z.string(),
        manifestPath: z.string(),
        packageName: z.string(),
        fromVersions: z.array(z.string()),
        toVersion: z.string(),
        advisoryIds: z.array(z.string()),
        severity: SeveritySchema,
        prNumber: z.number(),
        prUrl: z.string(),
        prCreated: z.boolean(),
        branchUpdated: z.boolean(),
      }),
    ),
    skipped: z.array(
      z.object({
        manifestPath: z.string(),
        packageName: z.string(),
        toVersion: z.string(),
        reason: z.enum(['lockfile_missing', 'lockfile_unchanged', 'error']),
        detail: z.string().optional(),
      }),
    ),
  })
  .nullable();

/**
 * Result of the per-finding Fix action. Shape mirrors {@link AutoPrResultSchema}
 * but is never null (the endpoint either opens/refreshes a bump PR or records a
 * skip reason). Typically a single entry — the finding's package is bumped in
 * one PR alongside any sibling open findings for the same package/manifest.
 */
export const FixFindingResultSchema = z.object({
  opened: z.array(
    z.object({
      branch: z.string(),
      manifestPath: z.string(),
      packageName: z.string(),
      fromVersions: z.array(z.string()),
      toVersion: z.string(),
      advisoryIds: z.array(z.string()),
      severity: SeveritySchema,
      prNumber: z.number(),
      prUrl: z.string(),
      prCreated: z.boolean(),
      branchUpdated: z.boolean(),
    }),
  ),
  skipped: z.array(
    z.object({
      manifestPath: z.string(),
      packageName: z.string(),
      toVersion: z.string(),
      reason: z.enum(['lockfile_missing', 'lockfile_unchanged', 'error']),
      detail: z.string().optional(),
    }),
  ),
});

/**
 * Result of the batch "fix all by severity" action. Identical shape to
 * {@link FixFindingResultSchema} (one rolling bump PR; `opened` carries one
 * entry per bumped package, all sharing the same PR number) — kept as its own
 * named schema so the endpoint documents its own response component.
 */
export const BatchFixResultSchema = z.object({
  opened: z.array(
    z.object({
      branch: z.string(),
      manifestPath: z.string(),
      packageName: z.string(),
      fromVersions: z.array(z.string()),
      toVersion: z.string(),
      advisoryIds: z.array(z.string()),
      severity: SeveritySchema,
      prNumber: z.number(),
      prUrl: z.string(),
      prCreated: z.boolean(),
      branchUpdated: z.boolean(),
    }),
  ),
  skipped: z.array(
    z.object({
      manifestPath: z.string(),
      packageName: z.string(),
      toVersion: z.string(),
      reason: z.enum(['lockfile_missing', 'lockfile_unchanged', 'error']),
      detail: z.string().optional(),
    }),
  ),
});

export const ScanResultSchema = z.object({
  ref: z.string(),
  dryRun: z.boolean().openapi({
    description:
      'True when the scanned ref is not the default-branch tip: the scan ran for visibility but persisted nothing (no findings, no sweep, no card). new/updated/fixed/suppressed/cardId are all empty in this case.',
  }),
  scannedManifests: z.array(z.string()),
  failedManifests: z.array(z.string()).openapi({
    description: 'Lockfiles matched but unreadable/unparsable this scan (findings preserved).',
  }),
  truncated: z.boolean().openapi({
    description: 'True when more lockfiles existed than the per-scan cap; overflow not scanned.',
  }),
  dependencyCount: z.number(),
  vulnerableFindings: z.number().openapi({
    description: 'Vulnerable dependency occurrences detected this scan (persisted or not).',
  }),
  newFindings: z.number(),
  reopened: z
    .number()
    .openapi({ description: 'Previously-fixed findings that reappeared this scan (regressions).' }),
  updated: z.number(),
  fixed: z.number(),
  suppressed: z.number(),
  cardId: z.string().nullable(),
  autoPr: AutoPrResultSchema.openapi({
    description:
      'Auto-PR generation result when the project opted in (securityAutoPr.enabled) and the repo is Hub-hosted: native bump PRs opened/refreshed and bumps skipped (with reason). null when auto-PR was not requested or this was a dry run.',
  }),
});

// `.strict()` on the mutating bodies: a typo'd key (e.g. `supress`,
// `generateCards`) is REJECTED with 400 rather than silently stripped, which
// would otherwise fall through to a side-effecting default (still suppress /
// still create a card).
export const DismissRequestSchema = z
  .object({
    reason: z.string().max(500).optional(),
    /** When true (default), also suppress the advisory on future re-scans. */
    suppress: z.boolean().optional(),
  })
  .strict();

export const FindingsQuerySchema = z.object({
  status: z.enum(['open', 'fixed', 'dismissed']).optional(),
});

// Severity threshold a batch fix may target. Excludes `unknown` — there is no
// "fix everything at or above unknown"; the unscoped fix-all (omit minSeverity)
// is what sweeps unknown-severity findings in too.
export const FixThresholdSchema = z.enum(['critical', 'high', 'medium', 'low']);

export const BatchFixRequestSchema = z
  .object({
    minSeverity: FixThresholdSchema.optional().openapi({
      description:
        'Only fix findings at or above this severity (threshold, not exact): ' +
        '`high` fixes critical AND high. Omit to fix every fixable finding ' +
        'regardless of severity.',
    }),
  })
  .strict();

export const ScanRequestSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: 'Branch/commit. Defaults to default branch.' }),
    generateCard: z
      .boolean()
      .optional()
      .openapi({ description: 'Open a card for new findings (default true).' }),
    autoPr: z
      .boolean()
      .optional()
      .openapi({
        description:
          'Force-open Dependabot-style bump PRs for fixable findings, even when the ' +
          'project has not set securityAutoPr.enabled. An explicit Autofix click is its ' +
          'own opt-in. Still requires gitHost: agenthub and a wired native PR service; ' +
          'ignored otherwise.',
      }),
  })
  .strict();

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/security-audit/findings',
  tags: ['Projects'],
  summary: 'List dependency vulnerability findings for a project',
  description:
    'Returns persisted dependency-audit findings (optionally filtered by status) plus open-finding counts by severity. Findings come from the most recent scans; statuses are open / fixed / dismissed.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: FindingsQuerySchema,
  },
  responses: {
    200: { description: 'Findings + severity counts.', content: jsonContent(FindingsListSchema) },
    400: { description: 'Invalid status filter.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/security-audit/scan',
  tags: ['Projects'],
  summary: 'Run a dependency security scan now',
  description:
    'Scans the Hub-hosted repo (default branch unless `ref` is given): parses npm lockfiles (`package-lock.json`, `npm-shrinkwrap.json`) and Python/PyPI lockfiles (`requirements.txt`, `poetry.lock`, `Pipfile.lock`), queries the OSV advisory database, persists findings with de-dupe, and opens a kanban card for genuinely new findings. Persistence is restricted to the default-branch tip — scanning any other `ref` is a read-only dry run (`dryRun: true`, nothing written). Requires gitHost: agenthub and the Admin role.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: {
      required: false,
      content: jsonContent(ScanRequestSchema),
    },
  },
  responses: {
    200: { description: 'Scan summary.', content: jsonContent(ScanResultSchema) },
    400: {
      description: 'Invalid request body, or the requested ref does not resolve.',
      content: jsonContent(ErrorResponse),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    409: {
      description: 'Project is not Hub-hosted or repo is empty.',
      content: jsonContent(ErrorResponse),
    },
    500: { description: 'Scan failed.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/security-audit/findings/{id}/fix',
  tags: ['Projects'],
  summary: 'Open a Dependabot-style bump PR for a single finding',
  description:
    "Opens (or refreshes) one native Hub pull request that bumps the finding's package to its fixed version in the manifest the finding belongs to. Every open finding for the same package+manifest is bumped together in the single PR (so sibling vulnerable versions are not stranded). Requires gitHost: agenthub, a wired native PR service, the Admin role, and a published fixed version; npm lockfiles only (other ecosystems such as pip are detection-only and return 409 here until automated write-back ships). Idempotent: clicking again refreshes the existing bump branch/PR rather than opening a duplicate.",
  request: {
    params: z.object({ projectId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: 'Bump PR opened/refreshed, or skipped with a reason.',
      content: jsonContent(FixFindingResultSchema),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project or finding.', content: jsonContent(ErrorResponse) },
    409: {
      description:
        'Project is not Hub-hosted, native PRs are unavailable, the finding is not open, has no published fix, or is not an npm dependency.',
      content: jsonContent(ErrorResponse),
    },
    500: { description: 'Fix failed.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/security-audit/fix',
  tags: ['Projects'],
  summary: 'Open a Dependabot-style bump PR for all fixable findings, optionally by severity',
  description:
    'Opens (or refreshes) the single rolling native bump PR carrying every open fixable npm finding for the project. Pass `minSeverity` to narrow to a severity threshold (`high` = critical AND high); omit it to fix every fixable finding. All bumps share one rolling branch, so each call sets the PR contents to its scope. Requires gitHost: agenthub, a wired native PR service, and the Admin role. Idempotent.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { required: false, content: jsonContent(BatchFixRequestSchema) },
  },
  responses: {
    200: {
      description: 'Bump PR opened/refreshed, or skips with reasons (empty when nothing matched).',
      content: jsonContent(BatchFixResultSchema),
    },
    400: {
      description: 'Invalid request body (e.g. an unknown key or bad minSeverity).',
      content: jsonContent(ErrorResponse),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    409: {
      description: 'Project is not Hub-hosted, native PRs are unavailable, or the repo is empty.',
      content: jsonContent(ErrorResponse),
    },
    500: { description: 'Fix failed.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/security-audit/findings/{id}/dismiss',
  tags: ['Projects'],
  summary: 'Dismiss (and optionally suppress) a dependency finding',
  description:
    'Marks a finding dismissed. When `suppress` is true (default) a suppression is recorded so the advisory stays dismissed on future re-scans and is excluded from card generation. Requires the Admin role.',
  request: {
    params: z.object({ projectId: z.string(), id: z.string() }),
    body: { required: false, content: jsonContent(DismissRequestSchema) },
  },
  responses: {
    200: { description: 'Updated finding.', content: jsonContent(SecurityFindingSchema) },
    400: {
      description: 'Invalid request body (e.g. an unknown key).',
      content: jsonContent(ErrorResponse),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project or finding.', content: jsonContent(ErrorResponse) },
  },
});
