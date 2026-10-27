/**
 * Zod schemas + OpenAPI registrations for QA environments
 * (`server/routes/qa-environments.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { QA_ENV_LIMITS } from '../qa-environments.js';

const AccountInput = z.object({
  id: z.string().optional().openapi({
    description: 'Existing account id to keep (and its password). Omit for a new account.',
  }),
  label: z.string().trim().min(1, 'Account label is required').max(QA_ENV_LIMITS.label),
  username: z.string().max(QA_ENV_LIMITS.username).optional(),
  password: z.string().max(QA_ENV_LIMITS.password).optional().openapi({
    description: 'New password. Omit or send the mask (••••••••) to keep it; send "" to clear it.',
  }),
  notes: z.string().max(QA_ENV_LIMITS.accountNotes).optional(),
});

const EnvironmentFields = {
  name: z.string().trim().min(1, 'name is required').max(QA_ENV_LIMITS.name),
  baseUrl: z.string().max(QA_ENV_LIMITS.baseUrl).optional().openapi({
    description: 'http(s) URL of the server under test. "" for none.',
  }),
  notes: z.string().max(QA_ENV_LIMITS.notes).optional().openapi({
    description: 'Free-form notes about the server (version, seed data, quirks, feature flags).',
  }),
  accounts: z.array(AccountInput).max(QA_ENV_LIMITS.accounts).optional().openapi({
    description: 'Full replacement list of test accounts, in display order.',
  }),
};

export const CreateQaEnvironmentRequestSchema = z.object(EnvironmentFields);
export const UpdateQaEnvironmentRequestSchema = z.object(EnvironmentFields).partial();

const AccountComponent = registerComponent(
  'QaEnvironmentAccount',
  z
    .object({
      id: z.string().openapi({
        description: 'Stable id; QA sessions type `{{qa-password:<id>}}` to enter its password.',
      }),
      label: z.string(),
      username: z.string(),
      password: z.string().openapi({ description: 'The mask when a password is saved, else "".' }),
      hasPassword: z.boolean(),
      notes: z.string(),
    })
    .openapi({ description: 'A test account. The password is never returned.' }),
);

export const QaEnvironmentComponent = registerComponent(
  'QaEnvironment',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      notes: z.string(),
      accounts: z.array(AccountComponent),
      position: z.number().int(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        'A server QA plans test against, with its test accounts. Listed in every QA run and authoring seed.',
    }),
);

const ErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.object({ path: z.array(z.any()), message: z.string() })).optional(),
});
const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = (description: string) => ({ description, content: json(ErrorResponse) });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: json(schema),
});

const TAGS = ['QA'];
const BASE = '/api/projects/{projectId}/qa/environments';
const projectParams = z.object({ projectId: z.string() });
const envParams = projectParams.extend({ environmentId: z.string() });
const EnvEnvelope = z.object({ environment: QaEnvironmentComponent });
const invalid = err('Validation failed.');
const notFound = err('Project or environment not found.');
const forbidden = err('Requires the Admin role.');
const conflict = err('Another environment in this project has that name.');

registerPath({
  method: 'get',
  path: BASE,
  tags: TAGS,
  summary: "List the project's QA environments",
  request: { params: projectParams },
  responses: {
    200: ok(
      'Environments in display order.',
      z.object({ environments: z.array(QaEnvironmentComponent) }),
    ),
    404: notFound,
  },
});

registerPath({
  method: 'post',
  path: BASE,
  tags: TAGS,
  summary: 'Create a QA environment',
  request: { params: projectParams, body: { content: json(CreateQaEnvironmentRequestSchema) } },
  responses: {
    201: ok('Created environment.', EnvEnvelope),
    400: invalid,
    403: forbidden,
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'patch',
  path: `${BASE}/{environmentId}`,
  tags: TAGS,
  summary: 'Update a QA environment',
  request: { params: envParams, body: { content: json(UpdateQaEnvironmentRequestSchema) } },
  responses: {
    200: ok('Updated environment.', EnvEnvelope),
    400: invalid,
    403: forbidden,
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'delete',
  path: `${BASE}/{environmentId}`,
  tags: TAGS,
  summary: 'Delete a QA environment and its test accounts',
  request: { params: envParams },
  responses: {
    200: ok('Deleted.', z.object({ ok: z.literal(true) })),
    403: forbidden,
    404: notFound,
  },
});
