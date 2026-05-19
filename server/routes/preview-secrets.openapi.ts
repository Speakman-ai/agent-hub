/**
 * Zod schemas + OpenAPI registrations for the per-project preview-secrets routes.
 *
 * Companion to `server/routes/preview-secrets.ts`. Loaded for its side
 * effects by `server/openapi/generate.ts` to populate the public spec.
 * Covers all 4 logical surfaces (GET, PUT, DELETE :key, POST import) —
 * each registered against the modern `/secrets` path. The legacy
 * `/preview/secrets` aliases stay live for old scripts but are
 * intentionally omitted from the public spec; `x-internal: true` was
 * considered but the simpler "modern path only" stance is cleaner for
 * doc readers and the legacy aliases share the same shape.
 *
 * Coverage note: the route file uses a `for (path of paths)` loop to
 * mount each verb against both paths, so the static analyzer in
 * `server/openapi-coverage.ts` counts 3 source-level `router.<verb>`
 * sites (GET, PUT, POST). The new DELETE verb adds a 4th. The 4
 * registrations below match.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Reusable building blocks ─────────────────────────────────────

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug (e.g. `agent-hub`).' }),
});

const KeyParam = ProjectIdParam.extend({
  key: z.string().openapi({
    description:
      'Env var name. Must match `/^[A-Za-z_][A-Za-z0-9_]*$/` and cannot be in the reserved namespace (`AGENT_HUB_*`, `NODE_*`, `PATH`, `HOME`).',
    example: 'STRIPE_KEY',
  }),
});

const SecretKind = z.enum(['plain', 'secret']).openapi({
  description:
    '`plain` values are returned in clear on GET. `secret` values are masked on GET (return the `••••••••` sentinel) and only decrypted at spawn time inside `loadProjectEnvForSpawn`.',
});

const PreviewSecretRow = registerComponent(
  'PreviewSecretRow',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      key: z.string(),
      kind: SecretKind,
      value: z.string().openapi({
        description:
          'Decrypted value for `plain` kind; the `••••••••` MASK sentinel for `secret` kind. Never the plaintext of a secret-kind row.',
      }),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'One per-project secret row as returned by GET / PUT. `secret`-kind rows mask the value field; the only path that decrypts a secret is the spawn-time `loadProjectEnvForSpawn` (no caller-facing read).',
    }),
);

const PreviewSecretInput = z
  .object({
    key: z.string().openapi({
      description: 'Env var name. Same validation rules as the URL `:key` param.',
    }),
    value: z.string().openapi({
      description:
        'New plaintext value, OR the MASK sentinel (`••••••••`) for an existing `secret`-kind row to preserve its ciphertext without re-sending the plaintext.',
    }),
    kind: SecretKind.optional().openapi({
      description: 'Defaults to `secret` when omitted.',
    }),
  })
  .openapi({
    description: 'One entry in a bulk-replace PUT body.',
  });

const SecretsListEnvelope = registerComponent(
  'PreviewSecretsListResponse',
  z
    .object({
      secrets: z.array(PreviewSecretRow),
    })
    .openapi({
      description:
        'Current secrets for the project, sorted by key. `secret`-kind values are masked.',
    }),
);

const PutSecretsRequest = registerComponent(
  'PreviewSecretsPutRequest',
  z
    .object({
      secrets: z.array(PreviewSecretInput).openapi({
        description:
          'Full replacement set. Keys not present in the array are removed. Send the MASK sentinel for an existing secret-kind row to preserve its current ciphertext.',
      }),
    })
    .openapi({ description: 'Body for PUT /secrets.' }),
);

const ImportRequest = registerComponent(
  'PreviewSecretsImportRequest',
  z
    .object({
      env: z.string().openapi({
        description:
          '`.env`-style blob. Supports `KEY=value`, quoted values, `export KEY=value`, comments and blank lines. Multi-line values and shell-expansion are NOT supported.',
      }),
      mode: z.enum(['replace', 'merge']).optional().openapi({
        description:
          '`replace` (default) — wipe existing keys and install the parsed set. `merge` — keep existing keys, parsed entries win on conflict.',
      }),
      defaultKind: SecretKind.optional().openapi({
        description: 'Kind to assign to each parsed entry; defaults to `secret`.',
      }),
    })
    .openapi({ description: 'Body for POST /secrets/import.' }),
);

const ImportResponse = registerComponent(
  'PreviewSecretsImportResponse',
  z
    .object({
      imported: z
        .number()
        .int()
        .openapi({ description: 'Count of parsed entries that made it into the write.' }),
      mode: z.enum(['replace', 'merge']),
      secrets: z.array(PreviewSecretRow),
    })
    .openapi({
      description: 'Outcome of the import. `secrets` reflects the post-import state.',
    }),
);

const ErrorEnvelope = registerComponent(
  'PreviewSecretsErrorResponse',
  z
    .object({
      error: z.string(),
    })
    .openapi({ description: 'Error envelope for preview-secrets routes.' }),
);

// ─── Path registrations ───────────────────────────────────────────

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

// GET /api/projects/{projectId}/secrets
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/secrets',
  tags: ['Projects'],
  summary: 'List per-project secrets',
  description:
    "Returns the project's full secret list, sorted by key. `secret`-kind values are masked with the `••••••••` sentinel — this endpoint never returns secret plaintexts. Admin+ role is required (PUT/DELETE/import require Owner).",
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Current secret list (may be empty).',
      content: jsonContent(SecretsListEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// PUT /api/projects/{projectId}/secrets
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/secrets',
  tags: ['Projects'],
  summary: 'Bulk-replace per-project secrets',
  description:
    "Wholesale replace the project's secret set. Keys absent from the request body are removed; secret-kind entries can carry the MASK sentinel to preserve the existing ciphertext without re-sending the plaintext. `updated_at` is bumped only on rows whose value actually changes.",
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(PutSecretsRequest) },
  },
  responses: {
    200: {
      description: 'Replacement applied. Returns the post-write secret list.',
      content: jsonContent(SecretsListEnvelope),
    },
    400: {
      description:
        'Validation failed — bad key, reserved-namespace collision, oversize value, duplicate keys in the batch, or MASK sentinel sent for a key that does not yet exist.',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// DELETE /api/projects/{projectId}/secrets/{key}
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/secrets/{key}',
  tags: ['Projects'],
  summary: 'Delete a single per-project secret',
  description:
    'Removes one (project, key) entry without disturbing the rest of the set. Returns 204 on success and appends a `delete` row to the project secret audit log. 404 if the key does not exist — the caller may treat this as idempotent.',
  request: { params: KeyParam },
  responses: {
    204: {
      description: 'Deleted. No response body.',
    },
    400: {
      description: 'Key failed validation (bad identifier or reserved namespace).',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, the caller cannot see it, or the key has no row.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});

// POST /api/projects/{projectId}/secrets/import
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/secrets/import',
  tags: ['Projects'],
  summary: 'Import secrets from a `.env`-style blob',
  description:
    'Parses the supplied env blob and writes the result either as a wholesale replace (default) or a merge. Reserved keys (`AGENT_HUB_*`, `NODE_*`, `PATH`, `HOME`) are dropped at parse time. Multi-line values are not supported — encode newlines (`\\n` escape, base64) before importing.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(ImportRequest) },
  },
  responses: {
    200: {
      description: 'Import succeeded. Returns the parsed count and the post-import state.',
      content: jsonContent(ImportResponse),
    },
    400: {
      description: 'Body missing/invalid, or a parsed key failed validation.',
      content: jsonContent(ErrorEnvelope),
    },
    404: {
      description: 'Project not found, or the caller cannot see it.',
      content: jsonContent(ErrorEnvelope),
    },
  },
});
