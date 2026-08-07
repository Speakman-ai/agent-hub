/**
 * Zod schemas + OpenAPI registrations for the infrastructure setup wizard routes.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'InfraWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for infrastructure wizard routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const InfraSetupProfileSummary = registerComponent(
  'InfraSetupProfileSummary',
  z
    .object({
      name: z.string(),
      type: z.enum(['sso', 'static', 'role']),
      region: z.string().openapi({ description: 'The profile’s default AWS region.' }),
      monitoringCapable: z.boolean().openapi({
        description:
          'Whether this profile can back unattended background collection, i.e. it is not interactive SSO.',
      }),
    })
    .openapi({
      description:
        'A configured project AWS profile, reduced to identity and type. Never carries access keys, secret keys, session tokens or the external ID.',
    }),
);

const InfraSetupScopeSummary = registerComponent(
  'InfraSetupScopeSummary',
  z
    .object({
      profileName: z.string(),
      accountId: z.string().nullable().openapi({
        description:
          'Filled in once `sts:GetCallerIdentity` has run for the profile; null until then.',
      }),
      region: z.string(),
      service: z.string(),
      enabled: z.boolean(),
      hasTagFilter: z.boolean(),
      resourceCount: z.number().int().openapi({
        description:
          'Non-terminated resources inventory holds for the triple. Zero on a fresh scope is expected — inventory sync runs hourly.',
      }),
    })
    .openapi({ description: 'One `infra_scopes` allowlist row.' }),
);

const InfraSetupBlocker = z
  .enum([
    'infra-disabled',
    'no-profiles',
    'only-sso-profiles',
    'no-monitoring-profile',
    'storage-unavailable',
    'no-scope',
  ])
  .openapi({
    description:
      'An unmet precondition. Causes and state co-occur: `only-sso-profiles` is why there is no designation, `no-monitoring-profile` is that there is none.',
  });

const InfraSetupDraft = registerComponent(
  'InfraSetupDraft',
  z
    .object({
      projectId: z.string(),
      infraEnabled: z.boolean(),
      profiles: z.array(InfraSetupProfileSummary),
      designatedMonitoringProfile: z.string().nullable().openapi({
        description:
          'The stored `awsMonitoringProfile` designation, even when it no longer names a usable profile.',
      }),
      monitoringProfile: z.string().nullable().openapi({
        description:
          'The profile background collection would actually run as, or null when the collector would refuse.',
      }),
      monitoringCapableProfiles: z.array(z.string()),
      storageReady: z.boolean().openapi({
        description:
          'Whether `infra.db` is open. False means the scope and alert figures are unknown, not zero.',
      }),
      scopes: z.array(InfraSetupScopeSummary),
      enabledScopeCount: z.number().int(),
      alertRuleCount: z.number().int(),
      enabledAlertRuleCount: z.number().int(),
      blockers: z.array(InfraSetupBlocker),
      notes: z.array(z.string()),
    })
    .openapi({
      description:
        'Hub-local infrastructure monitoring readiness: configured AWS profiles and their types, the monitoring-profile designation, the collection allowlist, alert-rule counts, and the blockers that remain. Computed without calling AWS.',
    }),
);

const InfraSetupDraftResponse = registerComponent(
  'InfraSetupDraftResponse',
  z
    .object({
      projectId: z.string(),
      draft: InfraSetupDraft,
    })
    .openapi({ description: 'Infrastructure monitoring readiness for a project.' }),
);

const InfraWizardStartResponse = registerComponent(
  'InfraWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: InfraSetupDraft,
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned wizard session.' }),
    })
    .openapi({ description: 'Infrastructure setup wizard session spawned successfully.' }),
);

const ApplyTagFilter = z.record(z.string().min(1), z.array(z.string()).min(1)).openapi({
  description: 'Tag key -> accepted values (ORed). Omit or null to match every resource.',
});

const ApplyScopeInput = z.object({
  profileName: z.string().min(1).max(128).openapi({
    description: 'A project AWS profile name. Collection needs one that is not interactive SSO.',
  }),
  region: z.string().min(1).max(128).openapi({ example: 'us-east-2' }),
  service: z
    .string()
    .min(1)
    .max(128)
    .openapi({ description: 'Service key, lowercased on write.', example: 'ec2' }),
  tagFilter: ApplyTagFilter.nullish(),
  enabled: z.boolean().optional().openapi({
    description: 'Defaults to true. A disabled scope is a pause, not a delete.',
  }),
});

/**
 * Body of `POST .../infra/setup-apply`.
 *
 * `scopes` is the complete allowlist, not a patch — the underlying
 * `replaceInfraScopes` deletes any triple absent from the list, which is why the
 * kickoff prompt makes the agent show a before/after when rows already exist.
 */
export const InfraSetupApplyRequestSchema = z
  .object({
    scopes: z.array(ApplyScopeInput).max(200).openapi({
      description:
        'The complete `infra_scopes` allowlist to store. Replaces the existing list; omitted triples are deleted.',
    }),
    monthlyCeilingUsd: z.number().min(0).max(1_000_000).nullable().optional().openapi({
      description:
        'Monthly AWS API spend ceiling. `null` clears it. Omit to leave the current ceiling untouched. Required (here or already stored) when `infraEnabled` is true.',
    }),
    infraEnabled: z.boolean().optional().openapi({
      description:
        'Toggle the per-project Infrastructure module. Omit to leave the current flag untouched. Setting it to true requires an effective spend ceiling — see `monthlyCeilingUsd`.',
    }),
  })
  .openapi({ description: 'Infrastructure collection scope proposed by the wizard session.' });

registerComponent('InfraSetupApplyRequest', InfraSetupApplyRequestSchema);

const InfraSetupApplyResponse = registerComponent(
  'InfraSetupApplyResponse',
  z
    .object({
      ok: z.literal(true),
      infraEnabled: z.boolean(),
      monthlyCeilingUsd: z.number().nullable(),
      scopes: z.array(z.unknown()).openapi({ description: 'The stored allowlist, re-read.' }),
      projection: z
        .unknown()
        .openapi({ description: 'Projected monthly API cost for the enabled scopes.' }),
    })
    .openapi({ description: 'The allowlist as stored, not an echo of the request.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/setup-draft',
  tags: ['Infrastructure'],
  summary: 'Report a project’s infrastructure monitoring readiness',
  description: [
    'Admin+. Returns the Hub-local draft the infrastructure setup wizard starts from:',
    'configured AWS profiles with their types (`sso` / `static` / `role`), whether a',
    'monitoring profile is designated and still resolves, whether the module is enabled,',
    'the existing `infra_scopes` allowlist, alert-rule counts, and the `blockers[]` that',
    'stand between the project and unattended collection.',
    '',
    '**Calls AWS zero times.** The draft must work for a project whose only profiles are',
    'interactive SSO — the case that cannot monitor anything and the most common reason to',
    'open the wizard — so it never depends on credentials resolving. The live account probe',
    'happens inside the spawned wizard session under describe-only rules instead.',
    '',
    'Read-only: no session is spawned, no files are written, and no credential material',
    '(access key, secret key, session token, external ID) appears in the response.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Readiness draft computed.',
      content: jsonContent(InfraSetupDraftResponse),
    },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/infra/setup-wizard',
  tags: ['Infrastructure'],
  summary: 'Spawn the guided infrastructure setup session',
  description: [
    'Admin+. Creates an `[Infra Setup]` worktree-backed session, seeds it with the',
    'Hub-local readiness draft, and starts the agent turn fire-and-forget. Returns as',
    'soon as the session row exists — the walkthrough itself runs asynchronously over',
    'the chat WebSocket.',
    '',
    'The session probes the live AWS account **describe-only** (never `GetMetricData`,',
    'never paginated `ListMetrics`, never an SSO login) and ends by calling',
    '`setup-apply` with a proposed collection allowlist. It writes configuration, not',
    'repository files, so there is nothing to commit and no PR to open.',
    '',
    'The draft is embedded in the kickoff prompt inside explicit',
    '`-----BEGIN UNTRUSTED AWS PROBE-----` markers, and the same fence binds every',
    'string the agent later reads out of the account. AWS resource names, bucket names',
    'and tag values are third-party-controlled input; none of them are interpolated',
    'into the prompt’s authoritative text.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: {
      content: jsonContent(
        z.object({}).openapi({ description: 'No body fields; send an empty object.' }),
      ),
    },
  },
  responses: {
    201: { description: 'Wizard session spawned.', content: jsonContent(InfraWizardStartResponse) },
    400: errorResponse(
      'Project has no agents to host the wizard, or no `cwd` configured. The session is worktree-backed, so it needs a checkout to branch from; refusing here avoids a session that is created but can never start.',
    ),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/infra/setup-apply',
  tags: ['Infrastructure'],
  summary: 'Persist the collection allowlist proposed by the wizard',
  description: [
    'Admin+. Stores the `infra_scopes` allowlist the wizard session agreed with the',
    'operator, plus an optional monthly spend ceiling and the module toggle. This is',
    'configuration persistence — it writes `infra.db` and `projects.json`, never repo',
    'files.',
    '',
    '`scopes` is the **complete** list, not a patch: any (profile, region, service)',
    'triple absent from it is deleted. Surviving triples keep their id, creation time',
    'and resolved account id.',
    '',
    'Writes are ordered ceiling → allowlist → module flag, so a rejected allowlist',
    'still leaves a lowered cap applied and collection is only enabled once both the',
    'scope it would poll and the ceiling that stops it are in place.',
    '',
    'Setting `infraEnabled` to true is refused with 400 unless a ceiling is in effect —',
    'either sent in the same request or stored by an earlier apply. `GetMetricData` is',
    'billed per 1,000 metrics with no free tier, so enabling collection with no cap',
    'would leave the collector nothing to degrade against. The ceiling is never',
    'defaulted on the operator’s behalf.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(InfraSetupApplyRequestSchema) },
  },
  responses: {
    200: {
      description: 'Allowlist stored.',
      content: jsonContent(InfraSetupApplyResponse),
    },
    400: errorResponse('Request body failed validation, or a scope row was rejected.'),
    404: errorResponse('Project not found.'),
    503: errorResponse('Infrastructure store is unavailable.'),
  },
});
