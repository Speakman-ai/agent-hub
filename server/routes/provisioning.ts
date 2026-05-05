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
 * — so phases nobody implements (e.g. git-init in dev) still succeed.
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

function resolveWsBase(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0]!.trim() : req.protocol;
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const host = req.get('host') || `localhost:${process.env.PORT || 3051}`;
  return `${wsProto}://${host}`;
}

export default function createProvisioningRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    broadcast,
    findProject,
    getProjects,
    saveProjects,
    getProjectDataDir,
    ensureProjectRoom,
  } = deps;
  const router = Router();

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
      ensureProjectRoom(project);
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

    return res.status(201).json({ jobId, wsUrl, projectId });
  });

  router.get('/api/provisioning/:jobId', (req: Request, res: Response) => {
    const row = stmts.getProvisioningJob.get(req.params.jobId as string);
    if (!row) return res.status(404).json({ error: 'Job not found' });
    res.json(row);
  });

  return router;
}
