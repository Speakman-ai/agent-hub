/**
 * Zod schemas + OpenAPI registrations for the PR captures route group.
 *
 * Two routers are mounted:
 *   - `/api/captures` (global)            — only `GET /status`.
 *   - `/api/projects/:projectId/captures` — full CRUD, scoped to a project.
 *
 * The validators below mirror those in `capture-engine.ts` — anything
 * we'd refuse to shell out to, we refuse to persist.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'CapturesErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for captures routes.' }),
);

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,255}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{7,64}$/i;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

export const PrCaptureComponent = registerComponent(
  'PrCapture',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      pr_number: z.number().int().nullable(),
      pr_url: z.string().nullable(),
      branch: z.string(),
      commit_sha: z.string().nullable(),
      repo_url: z.string(),
      status: z.enum(['queued', 'running', 'done', 'error']).or(z.string()),
      error: z.string().nullable().optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      artifacts: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .openapi({ description: 'A single Playwright PR-capture row.' }),
);

export const CapturesStatusComponent = registerComponent(
  'CapturesStatus',
  z
    .object({
      enabled: z.boolean(),
      playwrightAvailable: z.boolean(),
    })
    .openapi({ description: 'Captures feature flag + Playwright availability.' }),
);

export const CreateCaptureRequestSchema = z.object({
  prNumber: z.union([z.number().int(), z.string()]),
  branch: z.string().min(1, 'branch is required').regex(BRANCH_RE, 'Invalid branch name'),
  commitSha: z.string().regex(COMMIT_SHA_RE, 'Invalid commit SHA').optional().nullable(),
  repoUrl: z
    .string()
    .regex(REPO_URL_RE, 'Invalid repo URL (must be https://github.com/owner/repo)')
    .optional(),
  prUrl: z.string().optional(),
});

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const captureScopeParams = z.object({
  projectId: z.string(),
  id: z.string(),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

// ─── Global router ──────────────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/captures/status',
  tags: ['Captures'],
  summary: 'Captures feature flag + Playwright availability',
  responses: {
    200: { description: 'Status payload.', content: jsonContent(CapturesStatusComponent) },
    500: errorResponse('Internal error.'),
  },
});

// ─── Project-scoped router ──────────────────────────────────────

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/captures',
  tags: ['Captures'],
  summary: 'List captures for a project',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Capture rows.', content: jsonContent(z.array(PrCaptureComponent)) },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/captures',
  tags: ['Captures'],
  summary: 'Create a new capture',
  description:
    'Persists a row immediately and runs Playwright async. The response is the queued row; poll the GET endpoint for status transitions. Refuses if captures are disabled or Playwright is missing.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateCaptureRequestSchema) },
  },
  responses: {
    201: { description: 'Queued capture.', content: jsonContent(PrCaptureComponent) },
    400: errorResponse('Validation failed.'),
    403: errorResponse('Captures are disabled on this server.'),
    404: errorResponse('Project not found.'),
    503: errorResponse('Playwright/Chromium is not available.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/captures/{id}',
  tags: ['Captures'],
  summary: 'Read a single capture (with artifacts)',
  request: { params: captureScopeParams },
  responses: {
    200: { description: 'Capture row + artifacts list.', content: jsonContent(PrCaptureComponent) },
    404: errorResponse('Capture not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/captures/{id}/rerun',
  tags: ['Captures'],
  summary: 'Re-run a capture (clones the original config)',
  request: { params: captureScopeParams },
  responses: {
    201: { description: 'Newly-queued capture.', content: jsonContent(PrCaptureComponent) },
    403: errorResponse('Captures are disabled.'),
    404: errorResponse('Capture not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/captures/{id}/comment',
  tags: ['Captures'],
  summary: 'Post the rendered capture screenshots as a PR comment',
  request: { params: captureScopeParams },
  responses: {
    200: {
      description: 'Posted comment URL.',
      content: jsonContent(z.object({ commentUrl: z.string() })),
    },
    400: errorResponse('Capture not yet completed.'),
    404: errorResponse('Capture not found.'),
    500: errorResponse('Failed to post PR comment.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/captures/{id}',
  tags: ['Captures'],
  summary: 'Delete a capture and its on-disk artifacts',
  request: { params: captureScopeParams },
  responses: {
    204: { description: 'Deleted.' },
    404: errorResponse('Capture not found.'),
    409: errorResponse('Cannot delete while capture is in progress.'),
  },
});
