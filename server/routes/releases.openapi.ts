import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ReleaseListEntry = z.object({
  version: z.string(),
  tag: z.string(),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  summary: z.string(),
});

const ReleaseNoteItem = z.object({
  text: z.string(),
  hash: z.string().nullable(),
});

const ReleaseNoteSection = z.object({
  title: z.string(),
  items: z.array(ReleaseNoteItem),
});

export const UserFacingReleaseComponent = registerComponent(
  'UserFacingRelease',
  z
    .object({
      version: z.string(),
      tag: z.string(),
      publishedAt: z.string().nullable(),
      url: z.string().nullable(),
      summary: z.string(),
      sections: z.array(ReleaseNoteSection),
    })
    .openapi({ description: 'Single release with user-facing changelog sections.' }),
);

export const ReleasesListResponseComponent = registerComponent(
  'ReleasesListResponse',
  z
    .object({
      repo: z.string(),
      source: z.enum(['github', 'git']),
      currentVersion: z.string(),
      selected: UserFacingReleaseComponent.nullable(),
      releases: z.array(ReleaseListEntry),
    })
    .openapi({ description: 'Release history for the Agent Hub repo.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'get',
  path: '/api/releases',
  tags: ['Health'],
  summary: 'List Agent Hub releases with user-facing summaries',
  description:
    'Fetches GitHub releases for the configured repo (default Speakman-ai/agent-hub), falling back to local git tags when the API is unavailable.',
  request: {
    query: z.object({
      version: z.string().optional().openapi({ description: 'Prefer this version in `selected`.' }),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      refresh: z
        .enum(['1', 'true'])
        .optional()
        .openapi({ description: 'Bypass the in-memory cache.' }),
    }),
  },
  responses: {
    200: {
      description: 'Release list.',
      content: jsonContent(ReleasesListResponseComponent),
    },
    500: {
      description: 'Upstream or parsing failure.',
      content: jsonContent(z.object({ error: z.string() })),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/releases/{version}',
  tags: ['Health'],
  summary: 'Get one release with full user-facing changelog',
  request: {
    params: z.object({
      version: z.string().openapi({ description: 'Semver or tag (e.g. 1.30.0 or v1.30.0).' }),
    }),
  },
  responses: {
    200: {
      description: 'Release detail.',
      content: jsonContent(
        z.object({
          repo: z.string(),
          release: UserFacingReleaseComponent,
        }),
      ),
    },
    404: {
      description: 'Unknown version.',
      content: jsonContent(z.object({ error: z.string() })),
    },
    500: {
      description: 'Upstream or parsing failure.',
      content: jsonContent(z.object({ error: z.string() })),
    },
  },
});
