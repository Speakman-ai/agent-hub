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

/**
 * Compact summary of the session dispatched by the scan-path Autofix. `null`
 * when autofix was not requested, the repo is not Hub-hosted, the scan was a
 * dry run, there were no open findings, or dispatch failed (the failure reason
 * is reported separately in `fixSessionError`).
 */
export const FixSessionSummarySchema = z
  .object({
    sessionId: z.string(),
    agentId: z.string(),
    findingCount: z.number(),
    reused: z.boolean().openapi({
      description:
        'True when an already-running security-fix session was reused instead of starting a new one (idempotency guard).',
    }),
  })
  .nullable();

/**
 * Result of the per-finding Fix / batch "fix all" actions. Both dispatch an
 * agent session to resolve the open findings (bump + re-resolve lockfile +
 * tests); Finalize opens the PR at session end. `sessionId`/`agentId`/`session`
 * are null only for the batch route when no finding matched the threshold
 * (nothing to do — 200, not an error). `session` is the created session row.
 */
export const FixSessionResultSchema = z.object({
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  findingCount: z.number(),
  reused: z.boolean().openapi({
    description:
      'True when an already-running security-fix session was reused (200) instead of a new one being started (201).',
  }),
  session: z.record(z.string(), z.unknown()).nullable(),
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
  fixSession: FixSessionSummarySchema.openapi({
    description:
      'Set when Autofix was requested (securityAutoPr.enabled or autoPr:true) on a Hub-hosted repo and the persisted scan found open findings: the agent session dispatched to resolve them. null when autofix was not requested, this was a dry run, there were no open findings, or dispatch failed (see fixSessionError).',
  }),
  fixSessionError: z.string().nullable().openapi({
    description:
      'Set when Autofix wanted to dispatch (open findings exist) but could not — currently only "no eligible agent on the roster". Distinguishes a configuration problem from a legitimate no-op (no open findings), where it is null.',
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
          'Dispatch an agent session to resolve fixable findings after the scan, even ' +
          'when the project has not set securityAutoPr.enabled. An explicit Autofix click ' +
          'is its own opt-in. Requires gitHost: agenthub; ignored otherwise.',
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
    'Scans the Hub-hosted repo (default branch unless `ref` is given): parses npm lockfiles (`package-lock.json`, `npm-shrinkwrap.json`) and Python/PyPI lockfiles (`requirements.txt` plus common `*requirements*.txt` variants, `poetry.lock`, `Pipfile.lock`), queries the OSV advisory database, persists findings with de-dupe, and opens a kanban card for genuinely new findings. Persistence is restricted to the default-branch tip — scanning any other `ref` is a read-only dry run (`dryRun: true`, nothing written). Requires gitHost: agenthub and the Admin role.',
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
  summary: 'Dispatch an agent session to resolve a finding',
  description:
    "Dispatches an agent session to resolve the project's open dependency findings (not just the clicked row — the session fixes them all in one branch → one PR). The agent bumps each package to its fixed version, re-resolves the lockfile with the real package manager, and runs the tests; Finalize opens the PR at session end. Works for any ecosystem (npm + pip). Idempotent: if a security-fix session is already running for the project, the existing one is returned (200, reused:true) instead of starting a duplicate. Requires gitHost: agenthub, the Admin role, an open finding, and an eligible agent on the roster.",
  request: {
    params: z.object({ projectId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: 'An already-running fix session was reused (reused:true).',
      content: jsonContent(FixSessionResultSchema),
    },
    201: {
      description: 'A new session was dispatched to resolve the findings.',
      content: jsonContent(FixSessionResultSchema),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project or finding.', content: jsonContent(ErrorResponse) },
    409: {
      description:
        'Project is not Hub-hosted, the finding is not open, or no eligible agent is available.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/security-audit/fix',
  tags: ['Projects'],
  summary: 'Dispatch an agent session to resolve all findings, optionally by severity',
  description:
    'Dispatches an agent session to resolve every open finding for the project, optionally narrowed to a severity threshold (`high` = critical AND high; omit to include all). The agent bumps + re-resolves lockfiles + runs tests; Finalize opens the PR. Idempotent: an already-running fix session is reused (200, reused:true) rather than duplicated. Requires gitHost: agenthub and the Admin role. Returns 201 with a newly-dispatched session, or 200 when a session was reused or no finding matched the threshold (null session).',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { required: false, content: jsonContent(BatchFixRequestSchema) },
  },
  responses: {
    200: {
      description:
        'An already-running session was reused (reused:true), or no finding matched the threshold (null session).',
      content: jsonContent(FixSessionResultSchema),
    },
    201: {
      description: 'A new session was dispatched to resolve the findings.',
      content: jsonContent(FixSessionResultSchema),
    },
    400: {
      description: 'Invalid request body (e.g. an unknown key or bad minSeverity).',
      content: jsonContent(ErrorResponse),
    },
    403: { description: 'Caller lacks the Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    409: {
      description: 'Project is not Hub-hosted, or no eligible agent is available.',
      content: jsonContent(ErrorResponse),
    },
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
