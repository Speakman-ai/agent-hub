import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const PreviewIdParam = ProjectIdParam.extend({
  previewId: z.string().openapi({ description: 'Worktree preview group id.' }),
});

const ProjectPreviewInstance = registerComponent(
  'ProjectPreviewInstance',
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      sessionName: z.string().nullable(),
      status: z.enum(['starting', 'ready', 'failed']),
      kind: z.enum(['compose', 'spawn', 'dev-server']),
      composeProjectName: z.string().nullable(),
      port: z.number().nullable(),
      url: z.string().nullable(),
      worktreePath: z.string().nullable(),
      startedAt: z.string(),
      lastActiveAt: z.string(),
    })
    .openapi({ description: 'Active worktree preview group for a chat session.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/previews',
  summary: 'List active worktree previews for a project',
  tags: ['Preview'],
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Active preview groups (starting, ready, or failed).',
      content: {
        'application/json': {
          schema: z.object({
            projectId: z.string(),
            previews: z.array(ProjectPreviewInstance),
          }),
        },
      },
    },
    404: { description: 'Project not found' },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/previews/purge',
  summary: 'Stop all active worktree previews for a project',
  tags: ['Preview'],
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Purge result',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            stopped: z.number().int(),
            failed: z.array(z.object({ id: z.string(), error: z.string() })),
          }),
        },
      },
    },
    404: { description: 'Project not found' },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/previews/{previewId}/stop',
  summary: 'Stop one worktree preview group',
  tags: ['Preview'],
  request: { params: PreviewIdParam },
  responses: {
    200: {
      description: 'Preview stopped',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), stopped: z.boolean() }),
        },
      },
    },
    404: { description: 'Project or preview not found' },
  },
});
