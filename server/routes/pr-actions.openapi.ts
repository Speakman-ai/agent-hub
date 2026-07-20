/**
 * Zod schemas + OpenAPI registration for the human PR-action routes.
 *
 * Companion to `server/routes/pr-actions.ts`. Loaded for its side effects by
 * `server/openapi/generate.ts`. Only the new `POST /api/pr/auto-merge` surface
 * is documented here; the older merge/close/status/read-proxy handlers remain
 * pre-existing migration debt (see `scripts/openapi-coverage-baseline.json`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const AutoMergeRequest = registerComponent(
  'PrAutoMergeRequest',
  z
    .object({
      prUrl: z.string().openapi({
        description: 'Full GitHub PR URL (`https://github.com/owner/repo/pull/N`).',
        example: 'https://github.com/acme/webapp/pull/42',
      }),
      enabled: z.boolean().openapi({
        description:
          'true arms GitHub native auto-merge (merge once required checks pass and required reviews approve); false disarms it.',
      }),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']).optional().openapi({
        description: 'Merge strategy GitHub uses when auto-merge fires. Defaults to `squash`.',
      }),
    })
    .openapi({
      description:
        'Arm or disarm GitHub native auto-merge on a PR, using the acting user’s connected GitHub credential.',
    }),
);

const AutoMergeResponse = registerComponent(
  'PrAutoMergeResponse',
  z
    .object({
      ok: z.literal(true),
      enabled: z.boolean(),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']),
      pr: z.string().openapi({ description: 'PR number as a string.' }),
    })
    .openapi({ description: 'Auto-merge toggle result.' }),
);

const ErrorResponse = z.object({ error: z.string() });

registerPath({
  method: 'post',
  path: '/api/pr/auto-merge',
  tags: ['PR Actions'],
  summary: 'Arm or disarm GitHub native auto-merge on a PR',
  description:
    'Enables or disables GitHub’s native auto-merge on a GitHub-hosted PR via the acting user’s OAuth token (GraphQL). Agent Hub-hosted (native) PRs are rejected with 400 — their auto-merge is controlled by the session Finalize automation level.',
  request: {
    body: {
      content: { 'application/json': { schema: AutoMergeRequest } },
    },
  },
  responses: {
    200: {
      description: 'Auto-merge armed or disarmed.',
      content: { 'application/json': { schema: AutoMergeResponse } },
    },
    400: {
      description:
        'Missing/invalid `enabled`, invalid merge method, invalid PR URL, or a native (Agent Hub-hosted) PR.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Caller has not connected a GitHub account.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    422: {
      description:
        'GitHub rejected the mutation (e.g. repo has "Allow auto-merge" disabled, or the PR is already mergeable with nothing to wait on).',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
