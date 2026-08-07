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
