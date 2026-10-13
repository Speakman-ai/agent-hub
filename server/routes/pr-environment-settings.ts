/**
 * Project settings for PR environments: every environment with its usage,
 * and the cost controls (cap, idle TTL, max lifetime).
 *
 *   GET /api/projects/:projectId/pr-environments
 *   PUT /api/projects/:projectId/pr-environments/limits
 *
 * Stopping one environment uses the PR route
 * (`POST /pulls/:number/preview/stop`), which works for both PR sources.
 */
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../roles.js';
import { z, registerPath } from '../openapi/registry.js';
import type { Project, RouteDeps } from '../types.js';
import { PrEnvironmentSchema } from './pulls-native.js';
import {
  DEFAULT_PR_ENVIRONMENT_LIMITS,
  PR_ENVIRONMENT_LIMIT_BOUNDS,
  PrEnvironmentLimitsPatchSchema,
  applyPrEnvironmentLimitsPatch,
  enforcedPrEnvironmentLimits,
  resolvePrEnvironmentLimits,
} from '../preview/pr-environment-limits.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});
const ErrorSchema = z.object({ error: z.string() });
const Params = z.object({ projectId: z.string() });

const LimitsSchema = z.object({
  maxConcurrent: z
    .number()
    .int()
    .describe(
      'Live environments (queued, building, ready) the project may hold. Starting one more puts the least recently used to sleep. 0 = no cap.',
    ),
  idleTtlMinutes: z
    .number()
    .int()
    .describe(
      'A ready environment with no requests for this long is put to sleep; the next request wakes it. 0 = never.',
    ),
  maxLifetimeDays: z
    .number()
    .int()
    .describe(
      'An environment whose PR head has not moved (and that was not started manually) for this long is stopped and no longer woken by requests. 0 = never.',
    ),
});

const BoundSchema = z.object({ min: z.number().int(), max: z.number().int() });

const SettingsResponse = z.object({
  projectId: z.string(),
  limits: LimitsSchema.describe('Effective limits (overrides applied over the defaults).'),
  wakeOnRequest: z
    .boolean()
    .describe(
      'Whether a request to a sleeping environment wakes it. Needs wildcard preview ingress (`AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`); without it idle sleep is not enforced.',
    ),
  enforced: LimitsSchema.describe(
    'Limits actually applied: `limits`, with `idleTtlMinutes` 0 when `wakeOnRequest` is false.',
  ),
  overrides: LimitsSchema.partial().describe('Values the project sets; the rest use defaults.'),
  defaults: LimitsSchema,
  bounds: z.object({
    maxConcurrent: BoundSchema,
    idleTtlMinutes: BoundSchema,
    maxLifetimeDays: BoundSchema,
  }),
  environments: z
    .array(PrEnvironmentSchema)
    .describe('Every environment the project has had, most recently updated first.'),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/pr-environments',
  tags: ['Projects'],
  summary: 'List PR environments and their cost controls',
  description:
    'Admin+. Every PR environment of the project (status, age, last request) plus the cap, idle TTL, and max lifetime in effect.',
  request: { params: Params },
  responses: {
    200: { description: 'Environments and limits.', content: jsonContent(SettingsResponse) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorSchema) },
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/pr-environments/limits',
  tags: ['Projects'],
  summary: 'Update PR environment cost controls',
  description:
    'Admin+. Set any of `maxConcurrent`, `idleTtlMinutes`, `maxLifetimeDays`; `null` resets a field to its default, an omitted field is left alone, and `0` turns a control off. The next sweep (within 5 minutes) applies lowered limits to running environments.',
  request: {
    params: Params,
    body: { content: jsonContent(PrEnvironmentLimitsPatchSchema) },
  },
  responses: {
    200: { description: 'Saved.', content: jsonContent(SettingsResponse) },
    400: { description: 'A value is out of bounds.', content: jsonContent(ErrorSchema) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorSchema) },
  },
});

type Deps = Pick<
  RouteDeps,
  'findProject' | 'saveProjects' | 'prEnvironments' | 'presentPrEnvironment' | 'config'
>;

export default function createPrEnvironmentSettingsRoutes(deps: Deps): Router {
  const router = Router();

  function body(project: Project) {
    const environments = deps.prEnvironments ? deps.prEnvironments.list(project.id) : [];
    const limits = resolvePrEnvironmentLimits(project);
    const wakeOnRequest = Boolean(deps.config?.previewSubdomainBase);
    return {
      projectId: project.id,
      limits,
      wakeOnRequest,
      enforced: enforcedPrEnvironmentLimits(limits, wakeOnRequest),
      overrides: project.prEnvironmentLimits ?? {},
      defaults: DEFAULT_PR_ENVIRONMENT_LIMITS,
      bounds: PR_ENVIRONMENT_LIMIT_BOUNDS,
      environments: environments.map((env) =>
        deps.presentPrEnvironment ? deps.presentPrEnvironment(env) : env,
      ),
    };
  }

  router.get(
    '/api/projects/:projectId/pr-environments',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = deps.findProject(String(req.params.projectId)) as Project | null;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(body(project));
    },
  );

  router.put(
    '/api/projects/:projectId/pr-environments/limits',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = deps.findProject(String(req.params.projectId)) as Project | null;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = PrEnvironmentLimitsPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid limits' });
        return;
      }
      const next = applyPrEnvironmentLimitsPatch(project.prEnvironmentLimits, parsed.data);
      if (next) project.prEnvironmentLimits = next;
      else delete project.prEnvironmentLimits;
      deps.saveProjects();
      res.json(body(project));
    },
  );

  return router;
}
