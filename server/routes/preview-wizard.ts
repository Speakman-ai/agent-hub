/**
 * AI-assisted preview setup wizard routes.
 *
 *   POST /api/projects/:projectId/preview/setup-wizard
 *     Admin+. Spawns a one-shot session with a server-precomputed draft
 *     (compose-only detect + env scan) embedded in the kickoff
 *     prompt. Returns `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/preview/setup-compose-bootstrap
 *     Admin+. Writes a starter docker-compose file when the draft is in
 *     `bootstrap_compose` phase (user-approved only).
 *
 *   POST /api/projects/:projectId/preview/setup-apply
 *     Admin+. Persists compose preview config + optional secrets in one call.
 *
 *   POST /api/projects/:projectId/preview/wizard-complete
 *     User+. Broadcasts `preview_wizard_complete` for the Settings panel.
 */
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
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
import {
  listRawPreviewSecretRows,
  parseDotEnv,
  replacePreviewSecrets,
  replacePreviewSecretsMixed,
  PreviewSecretValidationError,
} from '../preview/preview-secrets-store.js';
import type { PreviewSecretInput } from '../preview/preview-secrets-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREVIEW_SETUP_SKILL_SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  'default-skills',
  'preview-setup',
  'scripts',
);

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
    '4. **Compose preview checklist** — Walk `draft.composeChecklist` with the user (section above). Fix every **FAIL** in `compose.preview.yml` before build; explain **WARN** and **CHECK** items (bind mounts relative to worktree, `${AGENTHUB_HOST_PORT}` / `FRONTEND_PORT`, health on entry URL).',
    '5. **Compose details** — `agenthub:ask` for entry port, health path, env file, idle TTL, capture routes (use draft defaults as option labels).',
    '6. **Environment variables** — For each key in `draft.envVars` (especially `required: true`), ask in **plain prose** for values. Do not echo secrets back. Then include in `setup-apply` `secrets.env` as dotenv lines.',
    '7. **Persist** — `POST .../preview/setup-apply` with `preview.compose` only (health on `preview.compose.healthPath`).',
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
      const useWorktree = 0;
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

      const prompt = buildKickoffPrompt(project.id, cwd, PREVIEW_SETUP_SKILL_SCRIPTS_DIR, draft);
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
      const body = (req.body ?? {}) as {
        file?: string;
        content?: string;
        overwrite?: boolean;
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
      const target = path.join(cwd, file);
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
      const draft = collectPreviewSetupDraft(cwd);
      res.json({ ok: true, file, draft });
    },
  );

  router.post(
    '/api/projects/:projectId/preview/setup-apply',
    requireRole('Admin'),
    (req: Request, res: Response) => {
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
      (project as Record<string, unknown>).prEnv = prEnvResult.prEnv;
      saveProjects();

      let secretsImported = 0;
      if (body.secrets && typeof body.secrets.env === 'string') {
        try {
          const rawMode = body.secrets.mode;
          if (rawMode !== undefined && rawMode !== 'merge' && rawMode !== 'replace') {
            res.status(400).json({ error: 'secrets.mode must be "merge" or "replace"' });
            return;
          }
          const mode = rawMode === 'replace' ? 'replace' : 'merge';
          const defaultKind = body.secrets.defaultKind === 'plain' ? 'plain' : 'secret';
          const parsed = parseDotEnv(body.secrets.env);
          const inputs: PreviewSecretInput[] = parsed.map((p) => ({
            ...p,
            kind: p.kind ?? defaultKind,
          }));
          const actorUserId = (req as AuthenticatedRequest).authUserId ?? null;
          if (mode === 'merge') {
            const existingRaw = listRawPreviewSecretRows(project.id);
            replacePreviewSecretsMixed(project.id, inputs, existingRaw, actorUserId);
          } else {
            replacePreviewSecrets(project.id, inputs, actorUserId);
          }
          secretsImported = inputs.length;
        } catch (err) {
          if (err instanceof PreviewSecretValidationError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          throw err;
        }
      }

      res.json({ ok: true, secretsImported });
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
