/**
 * OpenAPI registration for `POST /api/projects/:projectId/external-pr-review`.
 *
 * Companion to `external-pr-review.ts`. Documents the manual external-PR
 * review trigger wired through §11 of `finalize-code-changes-architecture-v0`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ExternalPrReviewErrorResponse',
  z
    .object({
      error: z.string(),
      hint: z.string().optional(),
      provenance: z.string().optional(),
      via: z.string().optional(),
      activeSessionId: z.string().optional(),
    })
    .openapi({ description: 'Error envelope for the external-PR-review endpoint.' }),
);

const ExternalPrReviewRequest = registerComponent(
  'ExternalPrReviewRequest',
  z
    .object({
      prUrl: z.string().min(1).openapi({
        description:
          "GitHub PR URL of the form https://github.com/owner/repo/pull/N. The repo must match the project's configured githubRepo.",
        example: 'https://github.com/acme/widgets/pull/42',
      }),
    })
    .openapi({
      description:
        "Manual external-PR review request — user pastes a PR URL from the project's repo to spawn a reviewer-only session.",
    }),
);

const ExternalPrReviewScheduled = registerComponent(
  'ExternalPrReviewScheduled',
  z
    .object({
      ok: z.literal(true),
      scheduled: z.literal(true),
      prNumber: z.number().int().positive(),
      repoFullName: z.string(),
    })
    .openapi({
      description:
        'Reviewer dispatch scheduled. A reviewer session will be spawned shortly (debounced ~30s); the session posts a formal review on GitHub via Reviewer App auth and exits.',
    }),
);

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/external-pr-review',
  tags: ['Pull Requests'],
  summary: 'Manually trigger reviewer for an external GitHub PR',
  description: [
    'Spawns a reviewer-only session for an external GitHub PR (one not pushed',
    'by the Finalize orchestrator — contributor, dependabot, or direct push).',
    'The reviewer posts a single formal review back to GitHub via Reviewer App',
    'auth and exits. No fix-dispatch loop runs.',
    '',
    "The PR repo must match the project's configured `githubRepo`. PRs whose",
    'provenance classifies as `internal` (finalize-pushed) are rejected with 409 —',
    'use the per-row "Nudge reviewer" button on the PR list to re-trigger review',
    'on those.',
    '',
    'See `finalize-code-changes-architecture-v0` §11.',
  ].join('\n'),
  request: {
    params: projectIdParams,
    body: { content: jsonContent(ExternalPrReviewRequest) },
  },
  responses: {
    202: {
      description: 'Reviewer dispatch scheduled (debounced).',
      content: jsonContent(ExternalPrReviewScheduled),
    },
    400: errorResponse(
      'Invalid PR URL, missing project githubRepo, cross-repo URL, or no reviewer agent.',
    ),
    404: errorResponse('Project not found or PR not found on GitHub.'),
    409: errorResponse(
      'PR classified as internal, a reviewer session is already running, or a dispatch is already debounced.',
    ),
    502: errorResponse('Upstream GitHub fetch failed.'),
  },
});
