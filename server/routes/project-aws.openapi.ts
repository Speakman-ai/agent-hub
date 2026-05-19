/**
 * Zod schemas + OpenAPI registrations for the per-project AWS SSO routes.
 *
 * Companion to `server/routes/project-aws.ts`. Loaded for its side
 * effects by `server/openapi/generate.ts` to populate the public spec
 * and to satisfy the `check:openapi-coverage` ratchet — the route file
 * has 4 `router.<verb>` handlers and the baseline starts new files at
 * `allowed_unregistered: 0`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Reusable building blocks ─────────────────────────────────────

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
});

const AwsRegion = z
  .string()
  .openapi({ description: 'AWS region code, e.g. `us-east-2`.', example: 'us-east-2' });

const ProjectAwsSsoProfile = registerComponent(
  'ProjectAwsSsoProfile',
  z
    .object({
      sso_account_id: z
        .string()
        .openapi({ description: '12-digit AWS account id.', example: '123456789012' }),
      sso_start_url: z.string().openapi({
        description: 'IAM Identity Center start URL (`https://…`).',
        example: 'https://d-1234567890.awsapps.com/start/',
      }),
      sso_region: AwsRegion,
      sso_role_name: z.string().openapi({ description: 'IAM Identity Center role to assume.' }),
      region: AwsRegion,
      output: z
        .string()
        .optional()
        .openapi({ description: 'AWS CLI default output format; defaults to `json` on render.' }),
    })
    .openapi({
      description:
        "One AWS IAM Identity Center (SSO) profile stanza. Rendered into the per-spawn `AWS_CONFIG_FILE` as a `[profile <name>]` section. Not credentials — SSO tokens still live under the spawning user's `~/.aws/sso/cache`.",
    }),
);

const ProjectAwsSsoProfilesMap = registerComponent(
  'ProjectAwsSsoProfilesMap',
  z.record(z.string(), ProjectAwsSsoProfile).openapi({
    description: 'Map of profile name → profile stanza.',
  }),
);

const ProfilesEnvelope = registerComponent(
  'ProjectAwsProfilesResponse',
  z
    .object({
      profiles: ProjectAwsSsoProfilesMap,
    })
    .openapi({
      description: 'Current AWS SSO profiles configured on the project.',
    }),
);

const PutProfilesBody = registerComponent(
  'ProjectAwsProfilesRequest',
  z
    .object({
      profiles: z.union([ProjectAwsSsoProfilesMap, z.array(z.unknown())]).openapi({
        description:
          'Replacement set of profiles. Accepts either a `{ name: stanza }` map or an array of `{ name, ...stanza }` objects. Pass `{}` to clear all profiles.',
      }),
    })
    .openapi({ description: 'Body for PUT /aws-profiles.' }),
);

const ErrorEnvelope = registerComponent(
  'ProjectAwsErrorResponse',
  z
    .object({
      error: z.string(),
    })
    .openapi({ description: 'Error envelope for project-aws routes.' }),
);

const SsoStatusResponse = registerComponent(
  'ProjectAwsSsoStatusResponse',
  z
    .union([
      z.object({
        profile: z.string(),
        loggedIn: z.literal(true),
        account: z.string().optional(),
        arn: z.string().optional(),
        userId: z.string().optional(),
      }),
      z.object({
        profile: z.string(),
        loggedIn: z.literal(false),
        error: z.string().optional(),
        needsLogin: z.boolean().optional(),
      }),
    ])
    .openapi({
      description:
        '`aws sts get-caller-identity` result for the named profile. `loggedIn: false` with `needsLogin: true` means the cached SSO token is missing or expired and the caller should POST /aws-sso/login.',
    }),
);

const SsoLoginRequest = registerComponent(
  'ProjectAwsSsoLoginRequest',
  z
    .object({
      profile: z.string().openapi({ description: 'Configured profile name to log in.' }),
    })
    .openapi({ description: 'Body for POST /aws-sso/login.' }),
);

const SsoLoginResponse = registerComponent(
  'ProjectAwsSsoLoginResponse',
  z
    .union([
      z.object({
        ok: z.literal(true),
        loginId: z.string().openapi({
          description: 'Server-local id for this login attempt — useful for log correlation.',
        }),
        profile: z.string(),
        loginUrl: z.string().optional().openapi({
          description:
            'IAM Identity Center device-authorization URL the user must open in a browser. Present on the standard happy path where the URL surfaces within ~30 seconds.',
        }),
        completed: z.boolean().optional().openapi({
          description:
            'True when `aws sso login --no-browser` finished entirely server-side (rare — usually the user completes the device flow in a browser before the CLI exits).',
        }),
        output: z.string().optional().openapi({
          description: 'Tail of the CLI stdout/stderr (capped) for diagnostic purposes.',
        }),
      }),
      z.object({
        ok: z.literal(false),
        loginId: z.string(),
        profile: z.string(),
        error: z.string(),
        output: z.string().optional(),
      }),
    ])
    .openapi({
      description:
        'Outcome of the browser-less `aws sso login` spawn. Only one login proc runs per server at a time; if a second request arrives while a previous one is still running the previous proc is killed and a new one is spawned.',
    }),
);

// ─── Path registrations ───────────────────────────────────────────

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

// GET /api/projects/{projectId}/aws-profiles
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/aws-profiles',
  tags: ['Projects'],
  summary: 'List AWS SSO profiles configured on a project',
  description:
    "Returns the project's AWS IAM Identity Center profile map. Not credentials — only the static stanza fields (`sso_account_id`, `sso_start_url`, `sso_region`, `sso_role_name`, `region`). SSO tokens themselves live under the spawning user's `~/.aws/sso/cache` and are never returned.",
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Profile map (may be empty).',
      content: jsonContent(ProfilesEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// PUT /api/projects/{projectId}/aws-profiles
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/aws-profiles',
  tags: ['Projects'],
  summary: 'Replace the AWS SSO profiles configured on a project',
  description:
    "Wholesale replace the project's AWS SSO profile map. Pass an empty map to clear all profiles. After a successful save the server regenerates the on-disk `AWS_CONFIG_FILE` template that future spawns reference.",
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(PutProfilesBody) },
  },
  responses: {
    200: {
      description: 'Profiles saved. Returns the normalized map.',
      content: jsonContent(ProfilesEnvelope),
    },
    400: {
      description:
        'Validation failed — bad profile name, invalid account id / region / URL, or duplicate keys.',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// GET /api/projects/{projectId}/aws-sso/status
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/aws-sso/status',
  tags: ['Projects'],
  summary: 'Check whether the cached SSO token for a profile is still valid',
  description:
    'Runs `aws sts get-caller-identity --profile <name>` against the project\'s rendered `AWS_CONFIG_FILE` and reports whether the cached SSO token can authenticate. Use this from the UI to decide whether to surface a "Log in" CTA, and from agents to decide whether to call `POST /aws-sso/login` before making AWS calls.',
  request: {
    params: ProjectIdParam,
    query: z.object({
      profile: z.string().openapi({ description: 'Configured profile name.' }),
    }),
  },
  responses: {
    200: {
      description:
        'Identity check ran. Inspect `loggedIn` to know whether the token is valid — a 200 is also returned for the "not logged in" case so callers can branch on the body without try/catch.',
      content: jsonContent(SsoStatusResponse),
    },
    400: {
      description: 'Project has no AWS SSO profiles configured, or the profile name is unknown.',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// POST /api/projects/{projectId}/aws-sso/login
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/aws-sso/login',
  tags: ['Projects'],
  summary: 'Start a browser-less AWS SSO device-authorization flow',
  description:
    'Spawns `aws sso login --profile <name> --no-browser` server-side, watches its output for the IAM Identity Center device URL, and returns the URL to the caller. The user then opens that URL in their own browser to complete the device flow; once they do, the cached SSO token at `~/.aws/sso/cache` becomes valid and subsequent `GET /aws-sso/status` calls report `loggedIn: true`.\n\nOnly one login proc runs per server at a time: a second request kills the previous proc before spawning a new one. The 30-second URL-extraction timeout also kills the proc so no orphaned `aws` processes accumulate.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(SsoLoginRequest) },
  },
  responses: {
    200: {
      description:
        'Login proc spawned. On the happy path the response carries `loginUrl`; on rare immediate completion it carries `completed: true`.',
      content: jsonContent(SsoLoginResponse),
    },
    400: {
      description: 'Project has no AWS SSO profiles configured, or the profile name is unknown.',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
    500: {
      description:
        'Login proc failed — exited non-zero, errored on spawn, or timed out without surfacing a device URL.',
      content: jsonContent(SsoLoginResponse),
    },
  },
});
