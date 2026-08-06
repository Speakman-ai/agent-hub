import { z, registerPath, registerComponent } from '../openapi/registry.js';

const SessionIdParam = z.object({
  sessionId: z.string().openapi({ description: 'Chat session id.' }),
});

const ShellIdParam = SessionIdParam.extend({
  shellId: z.string().openapi({ description: 'Background shell id.' }),
});

const BackgroundShell = registerComponent(
  'BackgroundShell',
  z
    .object({
      id: z.string(),
      session_id: z.string(),
      project_id: z.string(),
      command: z.string(),
      label: z.string().nullable(),
      cwd: z.string().nullable(),
      pid: z.number().int().nullable(),
      pid_start_time: z.string().nullable(),
      status: z.enum(['running', 'exited', 'failed', 'stopped']),
      exit_code: z.number().int().nullable(),
      log_path: z.string().nullable(),
      watch: z.number().int().openapi({
        description:
          '1 while the watch loop should wake this shell\u2019s session when it finishes.',
      }),
      watch_resolved_at: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'A Hub-owned background shell — a long-running command that survives across chat turns.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/background-shells',
  summary: 'List background shells for a session',
  tags: ['Sessions'],
  request: { params: SessionIdParam },
  responses: {
    200: {
      description: 'Background shells, newest first.',
      content: {
        'application/json': {
          schema: z.object({ shells: z.array(BackgroundShell) }),
        },
      },
    },
    404: { description: 'Session not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/background-shells',
  summary: 'Start a background shell in the session worktree',
  tags: ['Sessions'],
  request: {
    params: SessionIdParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            command: z.string().openapi({ description: 'Shell command run via `sh -c`.' }),
            label: z
              .string()
              .optional()
              .openapi({ description: 'Optional human label surfaced in the UI.' }),
            watch: z.boolean().optional().openapi({
              description:
                'Wake the session automatically when this shell finishes. Defaults to true; pass false to start an unwatched shell.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Background shell started.',
      content: {
        'application/json': { schema: z.object({ shell: BackgroundShell }) },
      },
    },
    400: { description: 'Missing command or no directory to run in' },
    404: { description: 'Session not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/background-shells/watch/cancel',
  summary: 'Cancel the session watch loop and stop its watched shells',
  tags: ['Sessions'],
  request: { params: SessionIdParam },
  responses: {
    200: {
      description: 'Watch disarmed; any still-running watched shells were stopped.',
      content: {
        'application/json': {
          schema: z.object({
            stopped: z.number().int().openapi({ description: 'How many shells were stopped.' }),
            shells: z.array(BackgroundShell),
          }),
        },
      },
    },
    404: { description: 'Session not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/background-shells/{shellId}',
  summary: 'Get one background shell',
  tags: ['Sessions'],
  request: { params: ShellIdParam },
  responses: {
    200: {
      description: 'Background shell.',
      content: { 'application/json': { schema: z.object({ shell: BackgroundShell }) } },
    },
    404: { description: 'Session or shell not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/background-shells/{shellId}/logs',
  summary: 'Get a background shell log tail',
  tags: ['Sessions'],
  request: {
    params: ShellIdParam,
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({ description: 'Max number of most-recent log lines to return.' }),
    }),
  },
  responses: {
    200: {
      description: 'Log tail (in-memory; empty for shells from a prior Hub process).',
      content: {
        'application/json': {
          schema: z.object({ shell: BackgroundShell, logs: z.array(z.string()) }),
        },
      },
    },
    404: { description: 'Session or shell not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/background-shells/{shellId}/stop',
  summary: 'Stop a background shell',
  tags: ['Sessions'],
  request: { params: ShellIdParam },
  responses: {
    200: {
      description: 'Background shell stopped (or already terminal).',
      content: { 'application/json': { schema: z.object({ shell: BackgroundShell.nullable() }) } },
    },
    404: { description: 'Session or shell not found' },
    503: { description: 'Background shells unavailable on this server' },
  },
});
