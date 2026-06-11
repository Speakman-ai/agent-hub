/**
 * New-project provisioning endpoint.
 *
 *   POST /api/projects/provision
 *     body:  payload from client/src/utils/adaptiveQuestionnaire.toProvisioningPayload()
 *     201:   { jobId, wsUrl, projectId? }
 *     400:   { error } — payload validation failed
 *
 * The orchestrator (server/provisioning/orchestrator.ts) runs phases
 * asynchronously and emits events over a ring buffer; the client opens
 * the returned `wsUrl` (an absolute ws://host/api/provisioning/:jobId/events
 * URL) to replay + live-tail them. A project row is optimistically
 * created with `mode='dev'` so the user has a landing target even if
 * later phases fail.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import type { RouteDeps, Project } from '../types.js';
import {
  startProvisioningJob,
  stubExecutor,
  subscribeToJob,
  type ProvisioningExecutor,
  type ProvisioningPayload,
} from '../provisioning/orchestrator.js';
import { createTemplateExecutor } from '../provisioning/template-executor.js';
import { createGithubExecutor } from '../provisioning/github.js';
import { detectPreviewDefaults } from '../scaffolding/detect-preview-defaults.js';
import { bootstrapHostedGit } from '../provisioning/hosted-git-bootstrap.js';
import { kickoffInitialBuild } from '../provisioning/initial-build.js';
import {
  resolveTemplateId,
  isKnownTemplateId,
  KNOWN_TEMPLATE_IDS,
} from '../provisioning/stack-defaults.js';
import { getTemplate } from '../provisioning/templates.js';
import type { AuthenticatedRequest } from '../auth.js';
import { z, registerPath } from '../openapi/registry.js';

registerPath({
  method: 'post',
  path: '/api/projects/provision/suggest',
  tags: ['Projects'],
  summary: 'AI-suggest a project name / app type / stack from a description',
  description:
    'Fills "idk" questionnaire answers using the requesting user\'s connected Claude account. Already-chosen appType/stack are echoed back unchanged; suggestions are clamped to known option ids.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            description: z.string().min(1),
            appType: z.string().optional(),
            stack: z.string().optional(),
            model: z.string().optional().openapi({ description: 'Claude model id override.' }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Suggested values (null when the model produced none for a field).',
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().nullable(),
            appType: z.string().nullable(),
            stack: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: 'Missing description or no connected Claude account.' },
    502: { description: 'Model invocation failed.' },
  },
});

/**
 * Injectable executor resolver — tests swap in fakes via this hook.
 *
 * The `deps` argument is passed at route-construction time so the
 * factory can build an executor that knows how to resolve workspace
 * paths. Tests that just want the stub can ignore it.
 *
 * Production composes two executors: the template executor handles
 * copy/setup/lint/test phases, and the github executor handles
 * mint-token/gh-create/gh-push. Each executor delegates unknown
 * phases to its `fallback`, and the outermost fallback is the stub
 * — so phases nobody implements (e.g. validate) still succeed.
 */
export function defaultExecutorFactory(deps: RouteDeps): ProvisioningExecutor {
  // E2E / deterministic-happy-path hook. Setting
  // `AGENT_HUB_PROVISIONING_STUB=1` swaps the real template + github
  // executors for the built-in stub (see orchestrator.ts), which emits
  // plausible success messages for every phase without touching disk,
  // spawning commands, or calling the GitHub CLI. The stub is the same
  // deterministic fake used throughout the orchestrator Vitest suite, so
  // behaviour stays consistent across unit + E2E tests. Production never
  // sets this flag.
  if (process.env.AGENT_HUB_PROVISIONING_STUB === '1') {
    return stubExecutor;
  }
  const resolveWorkspace = (projectId: string | null): string => {
    if (!projectId) throw new Error('provisioning executor requires a projectId');
    return path.join(deps.getProjectDataDir(projectId), 'workspace');
  };
  const templates = createTemplateExecutor({ resolveWorkspace });
  return createGithubExecutor({
    resolveWorkspace,
    fallback: templates,
  });
}

let executorFactory: (deps: RouteDeps) => ProvisioningExecutor = defaultExecutorFactory;

/** Test hook: override the executor returned for new jobs. */
export function setProvisioningExecutorFactory(
  factory: (deps: RouteDeps) => ProvisioningExecutor,
): void {
  executorFactory = factory;
}

/** Test hook: restore the default (template-backed) executor. */
export function resetProvisioningExecutorFactory(): void {
  executorFactory = defaultExecutorFactory;
}

/** Produce a project id from a requested name, falling back to a random uuid-ish slug. */
function slugify(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length >= 3 && cleaned.length <= 64) return cleaned;
  return '';
}

function uniqueProjectId(base: string, isTaken: (id: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Absurdly unlikely, but be explicit rather than looping forever.
  return `${base}-${uuidv4().slice(0, 8)}`;
}

/** Extract a project id from the provisioning payload. */
function deriveProjectId(payload: ProvisioningPayload, isTaken: (id: string) => boolean): string {
  if (typeof payload.name === 'string' && payload.name !== 'idk') {
    const fromName = slugify(payload.name);
    if (fromName) return uniqueProjectId(fromName, isTaken);
  }
  const fromDesc = slugify((payload.description || payload.prompt || '').slice(0, 48));
  if (fromDesc) return uniqueProjectId(fromDesc, isTaken);
  return `new-project-${uuidv4().slice(0, 8)}`;
}

interface PreviewDetectionDeps {
  jobId: string;
  projectId: string;
  workspaceDir: string;
  project: Project;
  saveProjects: () => void;
  broadcast: (msg: Record<string, unknown>) => void;
}

/**
 * Subscribe to a provisioning job's event stream and, the first time
 * the `copy-template` phase reports `ok`, run the preview detector
 * against the project workspace and write the detected defaults onto
 * `project.prEnv.preview`.
 *
 * Pulled out of the route handler so the test suite can drive it with
 * a synthetic job and confirm the project mutation independently of
 * the rest of the provisioning happy path.
 */
export function subscribePreviewDetection(deps: PreviewDetectionDeps): () => void {
  const { jobId, projectId, workspaceDir, project, saveProjects, broadcast } = deps;
  let applied = false;

  const unsubscribe = subscribeToJob(jobId, (ev) => {
    if (applied) return;
    if (ev.type !== 'phase') return;
    if (ev.phase !== 'copy-template') return;
    if (ev.status !== 'ok') return;
    applied = true;

    let detected;
    try {
      detected = detectPreviewDefaults(workspaceDir);
    } catch {
      detected = null;
    }
    if (!detected) {
      // Unknown stack — leave preview unset; the wizard will surface
      // empty fields in the final review step. Broadcast a zero-detection
      // signal so any UI panel watching for the result can clear its
      // pending spinner.
      broadcast({
        type: 'preview-defaults-detected',
        projectId,
        jobId,
        detected: null,
      });
      return;
    }

    // Merge detected defaults into the project. Enable both the parent
    // prEnv block and preview.  Pre-fill startScript and internalPort from
    // the detection result so the persisted shape satisfies
    // validatePrEnvProjectConfig (requires non-empty startScript and
    // internalPort ∈ [1, 65535] when enabled=true).  Any existing
    // user-configured values spread over those defaults below.
    const existingPrEnv = project.prEnv ?? {};
    project.prEnv = {
      startScript: detected.startScript,
      internalPort: detected.port,
      ...existingPrEnv,
      enabled: true,
      preview: {
        enabled: true,
        startScript: detected.startScript,
        port: detected.port,
        captureRoutes: detected.captureRoutes,
        idleTTL: detected.idleTTL,
      },
    };

    try {
      saveProjects();
    } catch {
      /* best-effort: detection is a UX nicety, not a correctness gate. */
    }

    broadcast({
      type: 'preview-defaults-detected',
      projectId,
      jobId,
      detected: {
        stack: detected.stack,
        startScript: detected.startScript,
        port: detected.port,
        captureRoutes: detected.captureRoutes,
        idleTTL: detected.idleTTL,
      },
    });
  });

  return unsubscribe ?? (() => {});
}

/** Valid answers the AI suggestion may return (clamped server-side). */
const SUGGEST_APP_TYPES = ['web-app', 'api', 'cli', 'mobile', 'desktop', 'ml', 'library'];

type SuggestGenerator = (
  prompt: string,
  systemPrompt: string,
  model: string | null,
) => Promise<string>;

let suggestGeneratorOverride: SuggestGenerator | null = null;
export function __setSuggestGeneratorForTests(fn: SuggestGenerator | null): void {
  suggestGeneratorOverride = fn;
}

async function runSuggestGenerator(
  prompt: string,
  systemPrompt: string,
  model: string | null,
  userId: string | null,
): Promise<string> {
  if (suggestGeneratorOverride) return suggestGeneratorOverride(prompt, systemPrompt, model);
  const [{ runClaude }, { resolveSessionCliSpawnEnv }, { default: config }, os] = await Promise.all(
    [
      import('../heartbeat.js'),
      import('../per-user-cli-spawn.js'),
      import('../config.js'),
      import('os'),
    ],
  );
  const spawnEnv = resolveSessionCliSpawnEnv({
    cfg: config,
    ownerId: userId,
    credsOwnerId: userId,
    sessionId: null,
    engine: 'claude-code',
  });
  return runClaude(prompt, os.tmpdir(), systemPrompt, { timeoutMs: 60_000, model, spawnEnv });
}

/** Parse the model's JSON (tolerates fenced/prose-wrapped output). */
export function parseSuggestResponse(raw: string): {
  name: string | null;
  appType: string | null;
  stack: string | null;
} {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { name: null, appType: null, stack: null };
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const name =
      typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim().slice(0, 60)
        : null;
    const appType =
      typeof parsed.appType === 'string' && SUGGEST_APP_TYPES.includes(parsed.appType)
        ? parsed.appType
        : null;
    const stack =
      typeof parsed.stack === 'string' && isKnownTemplateId(parsed.stack) ? parsed.stack : null;
    return { name, appType, stack };
  } catch {
    return { name: null, appType: null, stack: null };
  }
}

function resolveWsBase(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0]!.trim() : req.protocol;
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const host = req.get('host') || `localhost:${process.env.PORT || 3051}`;
  return `${wsProto}://${host}`;
}

export default function createProvisioningRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, findProject, getProjects, saveProjects, getProjectDataDir } = deps;
  const router = Router();

  // AI-fill for "idk" questionnaire answers: given the project
  // description (plus any concrete answers), suggest a name, app type,
  // and stack. Runs the requesting user's connected Claude account; the
  // wizard shows the suggestions as editable values before provisioning.
  router.post('/api/projects/provision/suggest', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) return res.status(400).json({ error: 'description is required' });
    const knownAppType =
      typeof body.appType === 'string' && body.appType !== 'idk' ? body.appType : null;
    const knownStack = typeof body.stack === 'string' && body.stack !== 'idk' ? body.stack : null;
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;

    const systemPrompt =
      'You name and classify software projects. Respond with ONLY a JSON object, no prose:\n' +
      `{"name": "<short memorable project name, 2-4 words>", "appType": <one of ${JSON.stringify(
        SUGGEST_APP_TYPES,
      )}>, "stack": <one of ${JSON.stringify([...KNOWN_TEMPLATE_IDS])}>}`;
    const prompt =
      `Project description: ${description.slice(0, 2000)}\n` +
      (knownAppType ? `App type (already chosen, echo it back): ${knownAppType}\n` : '') +
      (knownStack ? `Stack (already chosen, echo it back): ${knownStack}\n` : '');

    const userId = (req as AuthenticatedRequest).authUserId ?? null;
    try {
      const raw = await runSuggestGenerator(prompt, systemPrompt, model, userId);
      const suggested = parseSuggestResponse(raw);
      if (!suggested.name && !suggested.appType && !suggested.stack) {
        return res.status(502).json({ error: 'Model returned no usable suggestion' });
      }
      return res.json({
        name: suggested.name,
        appType: knownAppType ?? suggested.appType,
        stack: knownStack ?? suggested.stack,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'EngineAuthRequiredError') {
        return res.status(400).json({
          error:
            'Your Claude account is not connected — add it under Settings → Account, then try again.',
        });
      }
      return res.status(502).json({ error: `Suggestion failed: ${msg.split('\n')[0]}` });
    }
  });

  router.post('/api/projects/provision', (req: Request, res: Response) => {
    const payload = (req.body ?? {}) as ProvisioningPayload;

    // The questionnaire's first step is the required "what are you building"
    // description. `prompt` is accepted as a back-compat alias.
    const rawDescription =
      typeof payload.description === 'string'
        ? payload.description
        : typeof payload.prompt === 'string'
          ? payload.prompt
          : '';
    if (!rawDescription.trim()) {
      return res.status(400).json({ error: 'description is required (non-empty string)' });
    }

    // Optimistically create the project row so the user has a landing target.
    const isTaken = (id: string) => !!findProject(id);
    const projectId = deriveProjectId(payload, isTaken);
    const displayName =
      typeof payload.name === 'string' && payload.name !== 'idk' && payload.name.trim()
        ? payload.name.trim()
        : projectId;

    const projects = getProjects();
    const dataDir = getProjectDataDir(projectId);
    try {
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
      mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
      mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    } catch (err: unknown) {
      return res.status(500).json({
        error: `Failed to create project workspace: ${(err as Error).message}`,
      });
    }

    const project: Project = {
      id: projectId,
      name: displayName,
      // cwd gets populated once the scaffold writes the repo tree. Until
      // then we point at the project data dir so project-level API calls
      // (kanban, wiki) work immediately.
      cwd: dataDir,
      ahw: dataDir,
      color: '#6b7280',
      mode: 'dev',
      agents: [],
    };
    projects.push(project);
    try {
      saveProjects();
    } catch (err: unknown) {
      // Roll back the in-memory push and clean up the on-disk scaffold.
      projects.pop();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return res.status(500).json({
        error: `Failed to persist project: ${(err as Error).message}`,
      });
    }

    try {
    } catch {
      /* best-effort — projects without a room still work. */
    }

    broadcast({ type: 'projects_updated', reason: 'provisioning-started' });

    const jobId = uuidv4();
    const wsUrl = `${resolveWsBase(req)}/api/provisioning/${jobId}/events`;

    startProvisioningJob({
      jobId,
      payload,
      projectId,
      executor: executorFactory(deps),
      stmts,
    });

    // Subscribe to the job so we can auto-bake `prEnv.preview` defaults
    // into the project as soon as the template tree lands on disk. The
    // detection helper inspects `<workspace>/package.json` and falls
    // back to `<workspace>/apps/*/package.json` for monorepos. When it
    // returns null (unknown stack), the project keeps an unset preview
    // block and the wizard surfaces empty fields.
    //
    // Failures here are swallowed: if detection or projects.json save
    // fails we don't want to wedge the provisioning job that already
    // succeeded. Worst case the user configures the preview manually.
    subscribePreviewDetection({
      jobId,
      projectId,
      workspaceDir: path.join(dataDir, 'workspace'),
      project,
      saveProjects,
      broadcast,
    });

    // Agent Hub-originating dev projects are Hub-native out of the box:
    // when the scaffold finishes, seed a starter ci.yaml from the
    // template manifest, commit the tree, enable CI-on-push and Agent Hub
    // git hosting. GitHub (when the wizard's integration ran) becomes the
    // mirror; otherwise it can be linked later. Skipped entirely when the
    // job errors out.
    const requestingUserId = (req as AuthenticatedRequest).authUserId ?? null;
    let manifest: { setup: string[]; test: string; lint: string } | null = null;
    try {
      manifest = getTemplate(resolveTemplateId(payload.appType, payload.stack)).manifest;
    } catch {
      manifest = null; // unknown stack — placeholder ci.yaml
    }
    // The wizard's hosting question: anything but an explicit false opts
    // the new project into Hub hosting (the recommended default).
    const hostOnAgentHub = (payload as { hostOnAgentHub?: unknown }).hostOnAgentHub !== false;
    let completed = false;
    subscribeToJob(jobId, (ev) => {
      if (completed || ev.type !== 'done') return;
      // `partial` means the LOCAL scaffold succeeded and only an optional
      // gh-* phase failed — the local project is fully usable. Only a
      // fatal (non-partial) failure skips post-scaffold work.
      const d = ev as { error?: unknown; partial?: boolean };
      if (d.error && !d.partial) return;
      completed = true;
      void (async () => {
        if (hostOnAgentHub) {
          await bootstrapHostedGit({
            project,
            workspaceDir: path.join(dataDir, 'workspace'),
            manifest,
            saveProjects,
            broadcast,
            requestingUserId,
          });
        }
        // The description is the BASELINE: dispatch the first build
        // session so the user lands on a project that's being built,
        // not just an empty scaffold. Hosting (when enabled) is set up
        // first so the session worktree clones from the hosted repo.
        kickoffInitialBuild({
          project,
          description: rawDescription,
          deps,
          requestingUserId,
        });
      })();
    });

    return res.status(201).json({ jobId, wsUrl, projectId });
  });

  router.get('/api/provisioning/:jobId', (req: Request, res: Response) => {
    const row = stmts.getProvisioningJob.get(req.params.jobId as string);
    if (!row) return res.status(404).json({ error: 'Job not found' });
    res.json(row);
  });

  return router;
}
