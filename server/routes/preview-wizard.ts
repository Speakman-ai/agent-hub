/**
 * AI-assisted preview setup wizard routes.
 *
 *   POST /api/projects/:projectId/preview/setup-wizard
 *     Admin+. Spawns a worktree-backed setup session with a
 *     server-precomputed draft (compose-only detect + env scan)
 *     embedded in the kickoff prompt. Returns
 *     `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/preview/setup-compose-bootstrap
 *     Admin+. Writes a starter docker-compose file when the draft is in
 *     `bootstrap_compose` phase (user-approved only).
 *
 *   POST /api/projects/:projectId/preview/setup-apply
 *     Admin+. Persists compose preview and/or devServer config + optional
 *     secrets in one call.
 *
 *   GET /api/projects/:projectId/preview/migrate-devserver-plan
 *     Admin+. Read-only compose→devServer migration plan for the project's
 *     existing compose app-wrapping preview config.
 *
 *   POST /api/projects/:projectId/preview/wizard-complete
 *     User+. Broadcasts `preview_wizard_complete` for the Settings panel.
 */
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectPreviewSetupDraft, type PreviewSetupDraft } from '../preview-setup-draft.js';
import { formatComposeChecklistForPrompt } from '../preview-compose-checklist.js';
import {
  buildPrEnvPatchFromWizardApply,
  type PreviewSetupApplyBody,
} from '../preview-setup-apply.js';
import { applyWizardSecrets, validateWizardSecrets } from '../wizard-secrets-apply.js';
import { migrateComposePreviewToDevServer } from '../preview/migrate-compose-preview.js';
import { isLegacyPreviewComposeConfig } from '../preview/preview-compose-config.js';
import { resolveApplyTarget } from '../finalize/finalize-setup-apply-target.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREVIEW_SETUP_SKILL_SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  'default-skills',
  'preview-setup',
  'scripts',
);

const PREVIEW_CONFIG_RELATIVE_PATH = '.agent-hub/preview.json';
const COMMIT_MESSAGE_TITLE = 'Add preview config via Preview setup wizard';
const COMMIT_AUTHOR_NAME = 'agent-hub-bot';
const COMMIT_AUTHOR_EMAIL = 'agent-hub-bot@localhost';
const GIT_TIMEOUT_MS = 30_000;
const COMPOSE_FILE_NAME_RE = /^(?:docker-)?compose(?:[._-][A-Za-z0-9_-]+)?\.ya?ml$/i;

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

export function isPreviewSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith('[Preview Setup]');
}

const ALLOWED_COMPOSE_ROOT_FILES = new Set([
  'docker-compose.yml',
  'compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
]);

const COMPOSE_PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;

export function buildKickoffPrompt(
  projectId: string,
  projectCwd: string,
  _skillScriptsDir: string,
  draft: PreviewSetupDraft,
  sessionId: string,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  const mono = draft.isMonorepo ? 'yes' : 'no';
  const serviceCount =
    draft.detected?.compose.services?.length ??
    draft.composeCandidates?.[0]?.services?.length ??
    draft.bootstrap?.services?.length ??
    0;
  return [
    '# Preview Setup — guided walkthrough (required)',
    '',
    'You are the **default** setup path for this project. Walk the user through preview configuration **interactively** — do not tell them to use Settings forms. This repo scan says **monorepo: ' +
      mono +
      '** with **' +
      String(serviceCount) +
      '+** compose service(s) in the draft.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **YOUR SESSION_ID** (pass this to setup-apply and setup-compose-bootstrap): \`${sessionId}\``,
    '- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`**: use these for every wizard API call. Send `-H "X-API-Key: $AGENT_HUB_API_KEY"` on `setup-compose-bootstrap`, `setup-apply`, `preview/build`, and `wizard-complete`. If any wizard call returns HTTP 401 or 403, halt and report the auth failure. Never ask the operator to paste a token into chat.',
    '',
    '## Server-provided draft (repo scan — do not re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `composeCandidates[]` (every compose file + services/ports), `isMonorepo`, `readme`, `envVars`, `scriptHints`, `phase`, `composeChecklist`.',
    '',
    formatComposeChecklistForPrompt(draft.composeChecklist ?? []),
    '',
    '## Required walkthrough order',
    '',
    '1. **Read README** — `Read` `<PROJECT_CWD>/README.md` (or path in `draft.readme.readmePath`). Summarize how the team runs the app locally and any docker/compose notes. Quote `draft.readme.setupExcerpt` if set.',
    '2. **Monorepo / multi-service** — When `draft.isMonorepo` or `composeCandidates[].services.length > 2`:',
    '   - List **every** service name (and port if known) from `composeCandidates` or `draft.detected.compose.services`.',
    '   - Explain which service is the **browser entry** (UI) vs API/worker/DB — previews iframe the **entry** service only.',
    '   - Use a fenced `agenthub:ask` so the user picks **compose file** (if multiple in `composeCandidates`) and **entry service** (one option per service, with short descriptions).',
    '3. **Bootstrap** — If `draft.phase === "bootstrap_compose"`: propose `draft.bootstrap.composeYaml`, get approval, `POST .../preview/setup-compose-bootstrap`, then continue.',
    '4. **Compose preview checklist** — Walk `draft.composeChecklist` with the user (section above). Fix every **FAIL** in `compose.preview.yml` before build; explain remaining **WARN** items (relative bind paths, `${AGENTHUB_HOST_PORT}` / `FRONTEND_PORT`, host port mapping, file-watching polling).',
    '5. **Compose details** — `agenthub:ask` for entry port, health path, env file, idle TTL, capture routes (use draft defaults as option labels).',
    '6. **Environment variables** — For each key in `draft.envVars` (especially `required: true`), ask in **plain prose** for values. Do not echo secrets back. Then include in `setup-apply` `secrets.env` as dotenv lines.',
    '7. **Persist** — `POST .../preview/setup-apply` with `session_id: "<YOUR SESSION_ID above>"` and `preview.compose` only (health on `preview.compose.healthPath`). This writes `.agent-hub/preview.json` and commits it into this setup session worktree so Run Tests, Reviewer, and Push to GitHub can operate on the setup branch.',
    '8. **Validate** — `POST .../preview/build` with the same compose + secrets (or `POST .../preview/test` if build unavailable) and report pass/fail.',
    '9. **`POST .../preview/wizard-complete`** then `<agenthub:close-card>`.',
    '',
    'Use **multiple** `agenthub:ask` rounds if needed (monorepos need separate file vs service questions). Only **triple-backtick** fenced blocks render as pickers.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type` (those render as raw code).',
    '',
    '**Never** use script/`startScript`/`processes[]` preview mode.',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'preview-setup',
      reason: 'guided monorepo-aware walkthrough — draft embedded above',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

function previewSnapshotContent(project: Project, prEnv: unknown): string {
  return `${JSON.stringify(
    {
      version: 1,
      projectId: project.id,
      prEnv,
    },
    null,
    2,
  )}\n`;
}

function composeFilePathFromPrEnv(prEnv: unknown): string | null {
  if (!prEnv || typeof prEnv !== 'object') return null;
  const preview = (prEnv as { preview?: unknown }).preview;
  if (!preview || typeof preview !== 'object') return null;
  const compose = (preview as { compose?: unknown }).compose;
  if (!compose || typeof compose !== 'object') return null;
  const file = (compose as { file?: unknown }).file;
  if (typeof file !== 'string') return null;
  const trimmed = file.trim();
  if (!trimmed || path.isAbsolute(trimmed) || COMPOSE_PATH_TRAVERSAL_RE.test(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (!COMPOSE_FILE_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

type PreviousFileState = { exists: true; content: Buffer } | { exists: false };

async function readPreviousFileState(absFile: string): Promise<PreviousFileState> {
  try {
    return { exists: true, content: await fs.readFile(absFile) };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { exists: false };
    }
    throw err;
  }
}

async function restoreFileState(absFile: string, previous: PreviousFileState): Promise<void> {
  if (previous.exists) {
    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, previous.content);
    return;
  }
  await fs.rm(absFile, { force: true });
}

async function restorePreviewSnapshotAfterCommitFailure(args: {
  absFile: string;
  previousFile: PreviousFileState;
  commitPaths: string[];
  worktreePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    await execFileAsync('git', ['reset', '--quiet', 'HEAD', '--', ...args.commitPaths], {
      cwd: args.worktreePath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
      env: args.env,
    });
  } catch {
    try {
      await execFileAsync(
        'git',
        ['rm', '--cached', '--ignore-unmatch', '--quiet', '--', ...args.commitPaths],
        {
          cwd: args.worktreePath,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 * 1024 * 1024,
          env: args.env,
        },
      );
    } catch {
      // Non-git workspaces fail here; restoring the generated snapshot is enough.
    }
  }

  await restoreFileState(args.absFile, args.previousFile);
  if (!args.previousFile.exists) {
    try {
      await fs.rmdir(path.dirname(args.absFile));
    } catch {
      // The directory may contain unrelated files or may not exist.
    }
  }
}

async function existingPreviewCommitPaths(worktreePath: string, prEnv: unknown): Promise<string[]> {
  const paths = [PREVIEW_CONFIG_RELATIVE_PATH];
  const composeFile = composeFilePathFromPrEnv(prEnv);
  if (!composeFile || composeFile === PREVIEW_CONFIG_RELATIVE_PATH) return paths;
  try {
    const stat = await fs.stat(path.join(worktreePath, composeFile));
    if (stat.isFile()) paths.push(composeFile);
  } catch {
    // Missing compose files remain a config/runtime validation concern.
    // Do not fail setup-apply here because existing projects may reference
    // files generated elsewhere or not yet checked into the worktree.
  }
  return paths;
}

type PreviewCommitTargetResult =
  | { ok: true; skipped: true }
  | {
      ok: true;
      skipped: false;
      target: { id: string; worktree_path: string; worktree_branch: string };
    }
  | { ok: false; statusCode: number; error: string; message?: string };

async function resolvePreviewCommitTarget(args: {
  project: Project;
  sessionId: string | undefined;
  stmts: RouteDeps['stmts'];
  provisionSessionWorkspace: RouteDeps['provisionSessionWorkspace'];
}): Promise<PreviewCommitTargetResult> {
  if (!args.sessionId) return { ok: true, skipped: true };

  const target = await resolveApplyTarget(
    { stmts: args.stmts, provisionSessionWorkspace: args.provisionSessionWorkspace },
    args.project,
    args.sessionId,
  );
  if (!target) {
    return {
      ok: false,
      statusCode: 400,
      error: 'no_worktree',
      message:
        'No active worktree could be resolved for the preview setup session. Pass the setup session_id, or ensure the setup session workspace first.',
    };
  }

  try {
    const stat = await fs.stat(target.worktree_path);
    if (!stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'worktree_path is not a directory' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: 400,
      error: 'worktree_missing',
      message: `Worktree path is unreadable: ${message}`,
    };
  }

  return { ok: true, skipped: false, target };
}

async function commitPreviewConfigSnapshot(args: {
  project: Project;
  prEnv: unknown;
  commitTarget: PreviewCommitTargetResult;
}): Promise<
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; file: string; commitSha: string; branch: string; sessionId: string }
  | { ok: false; statusCode: number; error: string; message?: string }
> {
  if (!args.commitTarget.ok) return args.commitTarget;
  if (args.commitTarget.skipped) return { ok: true, skipped: true };

  const { target } = args.commitTarget;

  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
  };

  const absFile = path.join(target.worktree_path, PREVIEW_CONFIG_RELATIVE_PATH);
  let previousPreviewFile: PreviousFileState;
  try {
    previousPreviewFile = await readPreviousFileState(absFile);
    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, previewSnapshotContent(args.project, args.prEnv), 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: 500, error: 'write_failed', message };
  }

  const commitPaths = await existingPreviewCommitPaths(target.worktree_path, args.prEnv);

  try {
    await execFileAsync('git', ['add', '--', ...commitPaths], {
      cwd: target.worktree_path,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
      env: commitEnv,
    });
    await execFileAsync(
      'git',
      ['commit', '--allow-empty', '-o', '-m', COMMIT_MESSAGE_TITLE, '--', ...commitPaths],
      {
        cwd: target.worktree_path,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1 * 1024 * 1024,
        env: commitEnv,
      },
    );
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: target.worktree_path,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
      env: commitEnv,
    });
    return {
      ok: true,
      skipped: false,
      file: PREVIEW_CONFIG_RELATIVE_PATH,
      commitSha: stdout.trim(),
      branch: target.worktree_branch,
      sessionId: target.id,
    };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    try {
      await restorePreviewSnapshotAfterCommitFailure({
        absFile,
        previousFile: previousPreviewFile,
        commitPaths,
        worktreePath: target.worktree_path,
        env: commitEnv,
      });
    } catch (cleanupErr) {
      const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      message = `${message}; cleanup failed: ${cleanupMessage}`;
    }
    return { ok: false, statusCode: 500, error: 'commit_failed', message };
  }
}

export default function createPreviewWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config, saveProjects } = deps;
  const router = Router();

  router.post(
    '/api/projects/:projectId/preview/setup-wizard',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const agentId = pickWizardAgent(project);
      if (!agentId) {
        res.status(400).json({ error: 'Project has no agents to host the wizard session' });
        return;
      }
      const agentLookup = findAgent(agentId);
      if (!agentLookup) {
        res.status(500).json({ error: 'Wizard agent could not be resolved' });
        return;
      }

      const draft = collectPreviewSetupDraft(cwd);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const wizOwnerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: wizOwnerUid,
      });
      const sessionName = `[Preview Setup] ${project.name || project.id}`;
      // Preview setup edits repo files such as compose YAML. Run the wizard
      // like Finalize setup so the session has its own branch and can be
      // finalized instead of mutating the primary checkout directly.
      const useWorktree = 1;
      const askMode = 0;
      stmts.createSession.run(
        sessionId,
        agentId,
        sessionName,
        engine,
        model,
        useWorktree,
        askMode,
        1,
      );
      setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));

      const prompt = buildKickoffPrompt(
        project.id,
        cwd,
        PREVIEW_SETUP_SKILL_SCRIPTS_DIR,
        draft,
        sessionId,
      );
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'preview_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, draft, session });
    },
  );

  router.post(
    '/api/projects/:projectId/preview/setup-compose-bootstrap',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const body = (req.body ?? {}) as {
        file?: string;
        content?: string;
        overwrite?: boolean;
        session_id?: string;
      };
      const file = (body.file || 'docker-compose.yml').trim();
      if (!ALLOWED_COMPOSE_ROOT_FILES.has(file)) {
        res.status(400).json({
          error:
            'file must be one of docker-compose.yml, compose.yml, docker-compose.yaml, compose.yaml at the project root',
        });
        return;
      }
      if (COMPOSE_PATH_TRAVERSAL_RE.test(file) || file.startsWith('/')) {
        res.status(400).json({ error: 'compose file path must be a relative root filename' });
        return;
      }
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) {
        res.status(400).json({ error: 'content must be a non-empty compose YAML string' });
        return;
      }
      let writeRoot = cwd;
      if (body.session_id) {
        const target = await resolveApplyTarget(
          { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
          project,
          body.session_id,
        );
        if (!target) {
          res.status(400).json({
            error:
              'No active worktree could be resolved for the preview setup session. Pass the setup session_id, or ensure the setup session workspace first.',
          });
          return;
        }
        writeRoot = target.worktree_path;
      }
      const target = path.join(writeRoot, file);
      if (existsSync(target) && !body.overwrite) {
        res.status(409).json({
          error: `${file} already exists — pass overwrite:true after the user confirms replacing it`,
        });
        return;
      }
      try {
        writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to write compose file: ${message}` });
        return;
      }
      const draft = collectPreviewSetupDraft(writeRoot);
      res.json({ ok: true, file, draft });
    },
  );

  router.post(
    '/api/projects/:projectId/preview/setup-apply',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = (req.body ?? {}) as PreviewSetupApplyBody;
      const prEnvResult = buildPrEnvPatchFromWizardApply(project, body);
      if (!prEnvResult.ok) {
        res.status(400).json({ error: prEnvResult.error });
        return;
      }

      const commitTarget = await resolvePreviewCommitTarget({
        project,
        sessionId: body.session_id,
        stmts,
        provisionSessionWorkspace: deps.provisionSessionWorkspace,
      });
      if (!commitTarget.ok) {
        res
          .status(commitTarget.statusCode)
          .json({ error: commitTarget.error, message: commitTarget.message });
        return;
      }

      const secretsValidation = validateWizardSecrets(body.secrets);
      if (!secretsValidation.ok) {
        res.status(secretsValidation.statusCode).json({ error: secretsValidation.error });
        return;
      }

      const commitResult = await commitPreviewConfigSnapshot({
        project,
        prEnv: prEnvResult.prEnv,
        commitTarget,
      });
      if (!commitResult.ok) {
        res
          .status(commitResult.statusCode)
          .json({ error: commitResult.error, message: commitResult.message });
        return;
      }

      const secretsResult = applyWizardSecrets(
        project.id,
        body.secrets,
        (req as AuthenticatedRequest).authUserId ?? null,
      );
      if (!secretsResult.ok) {
        res.status(secretsResult.statusCode).json({ error: secretsResult.error });
        return;
      }

      (project as Record<string, unknown>).prEnv = prEnvResult.prEnv;
      saveProjects();

      res.json({
        ok: true,
        secretsImported: secretsResult.secretsImported,
        ...(commitResult.skipped
          ? {}
          : {
              file: commitResult.file,
              commit_sha: commitResult.commitSha,
              branch: commitResult.branch,
              session_id: commitResult.sessionId,
            }),
      });
    },
  );

  router.get(
    '/api/projects/:projectId/preview/migrate-devserver-plan',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const compose = project.prEnv?.preview?.compose;
      if (!isLegacyPreviewComposeConfig(compose)) {
        res.status(400).json({
          error:
            'Project has no compose app-wrapping preview config to migrate (prEnv.preview.compose.entryService is unset).',
        });
        return;
      }
      const appDevCommand =
        typeof req.query.appDevCommand === 'string' && req.query.appDevCommand.trim()
          ? req.query.appDevCommand.trim()
          : undefined;
      const services =
        typeof req.query.services === 'string' && req.query.services.trim()
          ? req.query.services
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
      try {
        const plan = migrateComposePreviewToDevServer(compose, { appDevCommand, services });
        res.json({ ok: true, ...plan });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/preview/wizard-complete',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (project) {
        broadcast({
          type: 'preview_wizard_complete',
          projectId: project.id,
        });
      }
      res.json({ ok: true });
    },
  );

  return router;
}
