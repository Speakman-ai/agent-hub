/**
 * Zod schemas + OpenAPI registration for the project PR list route.
 *
 * Companion to `server/routes/pr-list.ts`. Loaded for its side effects by
 * `server/openapi/generate.ts`. The PR *detail* route is still pre-existing
 * migration debt (see `scripts/openapi-coverage-baseline.json`) — its payload
 * folds four upstream GitHub shapes together and deserves its own pass.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const PrSummary = registerComponent(
  'PullRequestSummary',
  z
    .object({
      number: z.number(),
      title: z.string(),
      state: z.string(),
      draft: z.boolean().optional(),
      html_url: z.string().optional(),
      user: z.string().nullable().optional(),
      head: z.string().nullable().optional(),
      base: z.string().nullable().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      merged_at: z.string().nullable().optional(),
      closed_at: z.string().nullable().optional(),
    })
    .passthrough()
    .openapi({
      description:
        'One row of the PR list. Additional fields (labels, review_decision, check_rollup, linked_card, linked_epic, …) vary by backend and are passed through.',
    }),
);

const PrListResponse = registerComponent(
  'PullRequestListResponse',
  z
    .object({
      repo: z.string().openapi({
        description:
          '`owner/repo` for GitHub-backed projects, or the project id for Agent Hub-hosted ones.',
      }),
      state: z.enum(['open', 'closed', 'all']),
      source: z.enum(['agenthub', 'user-oauth']),
      page: z.number().openapi({ description: '1-based page that was served.' }),
      limit: z.number().openapi({ description: 'Page size actually applied (max 100).' }),
      hasMore: z.boolean().openapi({
        description:
          'Whether another page exists. Exact on both backends: Agent Hub-hosted projects over-fetch one row, GitHub-backed projects read `rel="next"` off GitHub’s `Link` header. Only falls back to a "the page came back full" guess if the upstream response carried no headers to read.',
      }),
      pulls: z.array(PrSummary),
    })
    .openapi({ description: 'One page of pull requests, newest activity first.' }),
);

const ErrorResponse = z.object({ error: z.string(), hint: z.string().optional() });

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/pulls',
  tags: ['PR Actions'],
  summary: 'List a project’s pull requests (paginated)',
  description:
    'Returns one page of pull requests for the project, ordered by most recent activity. Agent Hub-hosted projects are served from the native PR table; GitHub-backed projects are proxied through the caller’s connected GitHub account. Page through with `page`; `hasMore` says whether to offer a next page.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      state: z.enum(['open', 'closed', 'all']).optional().openapi({
        description:
          'Which PRs to include. Defaults to `open`; unknown values fall back to `open`.',
      }),
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        description: 'Page size. Defaults to 30, clamped to 100.',
      }),
      page: z.coerce.number().int().min(1).optional().openapi({
        description: '1-based page number. Defaults to 1; invalid values fall back to 1.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'One page of pull requests.',
      content: { 'application/json': { schema: PrListResponse } },
    },
    400: {
      description: 'Project has no `githubRepo` configured (GitHub-backed path only).',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Project not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    412: {
      description: 'Caller has not connected a GitHub account (`code: "github_not_connected"`).',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'GitHub rejected or failed the list request.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
