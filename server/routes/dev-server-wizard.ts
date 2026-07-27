/**
 * AI-assisted Dev Server setup wizard routes.
 *
 *   GET /api/projects/:projectId/dev-server/setup-draft
 *     Admin+. Read-only repo scan (start-command candidates, package
 *     manager, monorepo layout, framework/port guesses, existing config).
 *     Returns `{ projectId, draft }` — no session spawn, no writes.
 *
 *   POST /api/projects/:projectId/dev-server/setup-wizard
 *     Admin+. Spawns a worktree-backed `[Dev Server Setup]` chat session
 *     loaded with the `dev-server-setup` skill, the draft embedded in the
 *     kickoff prompt. Returns `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/dev-server/setup-apply
 *     Admin+. Persists the authored `prEnv.devServer` config (+ optional
 *     secret values) to the project record. Unlike preview/rum setup this
 *     touches no repo file — dev-server config lives in `projects.json` — so
 *     there is no git commit step. Returns `{ ok, secretsImported }`.
 *
 *   POST /api/projects/:projectId/dev-server/wizard-complete
 *     User+. Broadcasts `dev_server_wizard_complete` for the Settings panel.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectDevServerSetupDraft, type DevServerSetupDraft } from '../dev-server-setup-draft.js';
import { buildPrEnvPatchFromWizardApply } from '../preview-setup-apply.js';
import { applyWizardSecrets, validateWizardSecrets } from '../wizard-secrets-apply.js';
import type { PreviewSetupApplySecrets } from '../preview-setup-apply.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

interface DevServerApplyBody {
  /** The authored `prEnv.devServer` block (validated by parseDevServerConfig). */
  devServer?: Record<string, unknown>;
  /** Optional dotenv payload of freshly-typed secret values to store. */
  secrets?: PreviewSetupApplySecrets;
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

export function isDevServerSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith('[Dev Server Setup]');
}

export function buildDevServerKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: DevServerSetupDraft,
  sessionId: string,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  const recommended =
    draft.startCommandCandidates.find((c) => c.recommended)?.command ?? 'npm run dev';
  const mono = draft.isMonorepo ? 'yes' : 'no';
  const primaryPort = draft.portGuesses[0]?.internalPort;
  return [
    '# Dev Server Setup — guided walkthrough (required)',
    '',
    'You configure how Agent Hub boots this project as a **managed long-lived',
    'process** for session previews. The config you author lands in',
    '`prEnv.devServer` (start command, port map, env, secret references, health',
    'path, monorepo cwd). This is a **worktree-backed** session on a fresh',
    '`agent-hub/…` branch — do not create another branch.',
    '',
    'Repo scan says **monorepo: ' +
      mono +
      '**, recommended start command **`' +
      recommended +
      '`**' +
      (primaryPort ? ', likely primary port **' + String(primaryPort) + '**' : '') +
      '.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **YOUR SESSION_ID**: \`${sessionId}\``,
    '- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`**: use these for every wizard API call. Send `-H "X-API-Key: $AGENT_HUB_API_KEY"` on `setup-apply` and `wizard-complete`. On HTTP 401/403 halt and report the auth failure — never ask the operator to paste a token into chat.',
    '',
    '## Server-provided draft (repo scan — do not re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `startCommandCandidates[]` (each with `command`/`script`/`raw`), `packageManager`, `isMonorepo`, `monorepoDirs[]`, `frameworks[]`, `portGuesses[]`, `healthPathGuess`, `existing` (current config — EDIT it, do not clobber), `readme`.',
    '',
    '## Required walkthrough order',
    '',
    '1. **Read README** — `Read` `<PROJECT_CWD>/' +
      (draft.readme.path ?? 'README.md') +
      '` and summarize how the team runs the app locally. Quote `draft.readme.excerpt` if useful.',
    '2. **Start command** — Confirm the `startCommand` with a fenced `agenthub:ask` (offer `startCommandCandidates[].command` as options, recommended first). For a monorepo, decide whether the command runs from the repo root or a subdir in `monorepoDirs` — set `cwd` accordingly (worktree-relative, no leading `/` or `..`).',
    '3. **Ports** — Ask for each internal port the app listens on and a short label (e.g. `web`, `api`). Use `portGuesses` as defaults. Mark exactly one **primary** (keeps the `/preview/proxy/` mount; extras get `/preview/proxy/p/<port>/`).',
    '4. **Health path** — Ask for the readiness path on the primary port (default `' +
      draft.healthPathGuess +
      '`). Optional; must start with `/`.',
    '5. **Environment** — Scan for `process.env` / `import.meta.env` usage as needed. For each variable, ask in **plain prose** whether it is non-secret (`env`) or a secret (`secretKeys`). Never echo secret values back. Reserved keys (`PORT`, `AGENT_HUB_*`, `NODE_*`, `PATH`, `HOME`) are injected by the server — do not add them.',
    '6. **Persist** — `POST $AGENT_HUB_URL/api/projects/' +
      projectId +
      '/dev-server/setup-apply` with `{ "devServer": { … }, "secrets": { "env": "<dotenv lines for secret values>" } }`. `devServer.env` holds non-secret values; `devServer.secretKeys` lists secret NAMES only; the plaintext secret values go in `secrets.env` as `KEY=value` dotenv lines (stored encrypted, never in the config). On HTTP 400 fix the reported `prEnv.devServer.<path>` error and retry.',
    '7. **Verify (optional)** — Tell the user they can click **Start preview** on this session to boot the dev server and confirm it comes up on the mapped port.',
    '8. **`POST $AGENT_HUB_URL/api/projects/' +
      projectId +
      '/dev-server/wizard-complete`** then `<agenthub:close-card>`.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type` (those render as raw code).',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'dev-server-setup',
      reason: 'guided prEnv.devServer walkthrough — draft embedded above',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createDevServerWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config, saveProjects } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/dev-server/setup-draft',
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
      const draft = collectDevServerSetupDraft(cwd, {
        existing: project.prEnv?.devServer ?? null,
      });
      res.json({ projectId: project.id, draft });
    },
  );

  router.post(
    '/api/projects/:projectId/dev-server/setup-wizard',
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

      const draft = collectDevServerSetupDraft(cwd, {
        existing: project.prEnv?.devServer ?? null,
      });
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
        agentId,
      });
      const sessionName = `[Dev Server Setup] ${project.name || project.id}`;
      // use_worktree=1: consistent with the sibling setup wizards, and it lets
      // the user click Start preview on this session to boot the dev server and
      // verify the config live. The apply itself writes projects.json, not the
      // repo, so there is no commit to Finalize.
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
      setSessionOwner(sessionId, ownerUid);

      const prompt = buildDevServerKickoffPrompt(project.id, cwd, draft, sessionId);
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dev-server-wizard] handleChat failed for session ${sessionId}: ${message}`);
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'dev_server_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, draft, session });
    },
  );

  router.post(
    '/api/projects/:projectId/dev-server/setup-apply',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = (req.body ?? {}) as DevServerApplyBody;
      if (!body.devServer || typeof body.devServer !== 'object' || Array.isArray(body.devServer)) {
        res.status(400).json({ error: 'devServer must be an object' });
        return;
      }

      const prEnvResult = buildPrEnvPatchFromWizardApply(project, {
        devServer: body.devServer,
        enabled: true,
      });
      if (!prEnvResult.ok) {
        res.status(400).json({ error: prEnvResult.error });
        return;
      }

      const secretsValidation = validateWizardSecrets(body.secrets);
      if (!secretsValidation.ok) {
        res.status(secretsValidation.statusCode).json({ error: secretsValidation.error });
        return;
      }

      // Store secret values first so the config never references a secret the
      // store lacks (mirrors the manual DevServerSection save ordering).
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

      res.json({ ok: true, secretsImported: secretsResult.secretsImported });
    },
  );

  router.post(
    '/api/projects/:projectId/dev-server/wizard-complete',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (project) {
        broadcast({
          type: 'dev_server_wizard_complete',
          projectId: project.id,
        });
      }
      res.json({ ok: true });
    },
  );

  return router;
}
