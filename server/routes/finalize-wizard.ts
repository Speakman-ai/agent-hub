/**
 * Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard.
 *
 * Mirrors the preview-setup-wizard pattern: spawn a one-shot session
 * with the server-precomputed draft baked into the kickoff prompt, let
 * the user iterate via `agenthub:ask`, then commit the final YAML to
 * the worktree in one shot.
 *
 *   POST /api/projects/:projectId/finalize/setup-wizard
 *     Admin+. Spawns a wizard session loaded with the `finalize-setup`
 *     skill, embedding the project draft. Returns
 *     `{ sessionId, agentId, draft, session }`.
 *
 *   POST /api/projects/:projectId/finalize/setup-apply
 *     Admin+. Validates the proposed `ci_yaml_content` against the v1
 *     schema (server/finalize/ci-config.ts), writes it to
 *     `<worktree>/.agent-hub/ci.yaml`, and commits it to the worktree's
 *     branch. Returns `{ ok, file, commit_sha, branch }`.
 *
 *   POST /api/projects/:projectId/finalize/wizard-complete
 *     User+. Broadcasts `finalize_wizard_complete` for the Settings
 *     panel so it can refresh state.
 *
 * Lookup order for the target worktree (apply endpoint):
 *   - Request body `session_id` (when the chat session knows its own id)
 *     → use persisted worktree when set; otherwise bind the project's primary
 *       git checkout (`project.cwd` + current branch) for resumed sessions
 *       that chat in the main repo without a dedicated worktree clone yet.
 *   - Otherwise the most-recent session for the project that has both a
 *     `worktree_path` and a `worktree_branch`.
 *
 * Tests live in `server/routes/finalize-wizard.test.ts`.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectFinalizeSetupDraft, type FinalizeSetupDraft } from '../finalize-setup-draft.js';
import { parseCiConfig } from '../finalize/ci-config.js';
import { applyWizardSecrets, type WizardApplySecrets } from '../wizard-secrets-apply.js';
import {
  pickSessionWithWorktreeForHint,
  resolveApplyTarget,
  type ResolvedApplyTarget,
} from '../finalize/finalize-setup-apply-target.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { Project, RouteDeps, SessionRow } from '../types.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FINALIZE_SETUP_SKILL_SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  'default-skills',
  'finalize-setup',
  'scripts',
);

export const FINALIZE_CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';

const SESSION_NAME_PREFIX = '[Finalize Setup]';
const COMMIT_MESSAGE_TITLE = 'Add .agent-hub/ci.yaml via Finalize setup wizard';
const COMMIT_AUTHOR_NAME = 'agent-hub-bot';
const COMMIT_AUTHOR_EMAIL = 'agent-hub-bot@local';

const GIT_TIMEOUT_MS = 30_000;

export function isFinalizeSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith(SESSION_NAME_PREFIX);
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

interface ApplyBody {
  ci_yaml_content?: string;
  /**
   * Optional explicit session id whose worktree should receive the file.
   * When the session has no persisted worktree yet, setup-apply binds
   * the project's primary git checkout (`project.cwd` + current branch).
   */
  session_id?: string;
  /** Optional project secrets to persist alongside the ci.yaml commit. */
  secrets?: WizardApplySecrets;
}

export type { ResolvedApplyTarget } from '../finalize/finalize-setup-apply-target.js';
export { resolveApplyTarget } from '../finalize/finalize-setup-apply-target.js';

export function buildKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: FinalizeSetupDraft,
  target: ResolvedApplyTarget | null,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  const targetLine = target
    ? `\`session ${target.sessionId}\` → branch \`${target.branch}\` at \`${target.worktreePath}\``
    : "(no worktree-bearing session found yet — pass `session_id` on setup-apply to bind this card session's checkout, or start a card-linked session first)";
  return [
    '# Finalize Setup — guided walkthrough (required)',
    '',
    'You are the **default** authoring path for `.agent-hub/ci.yaml`. Walk the user through Finalize configuration **interactively** — do not tell them to read schema docs. The repo scan below is the starting point.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **RESOLVED COMMIT TARGET (at wizard spawn time)**: ${targetLine}`,
    '',
    "> **Heads up — re-resolution at apply time.** Server picks the project's most-recent worktree-bearing session at the moment of `setup-apply`. If a fresher session has appeared between spawn and apply, the file will land THERE, not on the target shown above. **Always echo back the `branch` from the apply response and ask the user to confirm it matches what they expected — then post `finalize/wizard-complete`. If it does not match, do NOT post wizard-complete; halt and tell the user, so they can revert and re-run.**",
    '',
    '## Server-provided draft (do NOT re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `stack`, `packageManager`, `isMonorepo`, `subprojects[]`, `existingCi` + `existingCiContent`, `npmScripts`, `makefileTargets`, `githubWorkflows`, `envVars`, **`proposedCiYaml`** (pre-built, parses cleanly).',
    '',
    '## Required walkthrough order',
    '',
    '1. **Summarise the repo** — read `README.md` if useful, then state primary stack + package manager + what CI already runs (from `draft.githubWorkflows`).',
    '2. **Existing config** — when `draft.existingCi === true`, show `draft.existingCiContent` and ask whether to overwrite, edit in place, or abort. Do not silently overwrite.',
    '3. **Monorepo / sub-projects** — when `draft.isMonorepo`, list every entry in `draft.subprojects[]` and ask whether to run all or pick one.',
    '4. **Step proposal** — show `draft.proposedCiYaml` verbatim in a fenced ```yaml block. Ask: use as-is, edit steps, or add a custom step. Respect the v1 schema constraints: `version: 1`, `on:` of `finalize`/`manual`, `name`+`run` per step only, `timeout_minutes` in `[1, 60]`.',
    '5. **Env vars / secrets** — call out `draft.envVars` entries the steps will read. v1 ci.yaml has no `env:` field. For each missing value, `agenthub:ask` whether to collect it now (bundle into `setup-apply` as `secrets`) or skip. Persist via `setup-apply` `{ "secrets": { "mode": "merge", "env": "KEY=value\\n", "defaultKind": "secret" } }` — same as preview wizard. Users can also edit secrets in Settings → Finalize → Project secrets.',
    '6. **Confirm target branch** — before posting setup-apply, restate the resolved commit target ABOVE to the user in plain prose ("This will land on branch `X` in session `Y`") and use a fenced `agenthub:ask` with at least two options: **Apply** / **Pick a different session**. If the user picks the second, ask them for the explicit `session_id` (or pause the wizard so they can start the right session and re-run). Do not call setup-apply without that confirmation.',
    '7. **Persist** — `POST .../finalize/setup-apply` with `{ "ci_yaml_content": "<the final YAML>", "session_id": "<id confirmed in step 6>", "secrets": { "mode": "merge", "env": "KEY=value\\n", "defaultKind": "secret" } }` (secrets optional). Server validates ci.yaml against the v1 parser; on 400 with `ci_config_invalid`, fix the error code/path and retry. The response includes `branch`, `session_id`, and `secrets_imported` — echo both back to the user as a second sanity check, then post wizard-complete.',
    '8. **`POST .../finalize/wizard-complete`**, then `<agenthub:close-card>`.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type`.',
    '',
    '**Never** propose `shell:`, `env:`, `uses:`, `with:`, or `matrix:` on a step — the v1 parser rejects them.',
    '',
    '## CI replacement mode (user scope wins)',
    '',
    'Finalize is designed to **replace GitHub Actions CI** as the pre-push gate — including heavy steps (Docker, AWS, E2E, permissions sync). When the user says Finalize replaces CI, run all workflows, or asks you to stop downgrading scope:',
    '',
    '- Propose **one step per CI gate workflow** in `draft.githubWorkflows` (lint, `*.ci.yml`, e2e, permissions, smoke-test). Exclude deploy/release/terraform workflows only.',
    '- Prefer root gate scripts (`./lint`, `./run_api_tests`, `./run_e2e_tests`) and `run:` lines from workflow files. The server pre-builds this in `draft.proposedCiYaml`.',
    '- List runner prerequisites (Docker, `.env`, AWS creds, Settings → Secrets) as a **checklist**, not a reason to drop steps.',
    "- **Never** refuse, argue feasibility, or shrink the pipeline because a step is complex or needs cloud infra. The user's explicit scope wins.",
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'finalize-setup',
      reason: 'guided ci.yaml setup — draft + cheat sheet bundled',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createFinalizeWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  // ───────────────────────────────────────────────────────────────
  // GET /api/projects/:projectId/finalize/environment-draft
  // ───────────────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/finalize/environment-draft',
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
      const draft = collectFinalizeSetupDraft(cwd);
      res.json({ draft, projectId: project.id });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/setup-wizard
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/setup-wizard',
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

      // Use the project root for the scan. The worktree (target of
      // setup-apply) is decided at apply time — the wizard does NOT need
      // a worktree to introspect; the proposed YAML is identical
      // regardless of which branch ends up receiving the commit.
      const draft = collectFinalizeSetupDraft(cwd);
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
      });
      const sessionName = `${SESSION_NAME_PREFIX} ${project.name || project.id}`;
      // use_worktree=0 by design — do NOT change this without re-reading
      // the apply route. The wizard session is a read-only chat surface
      // that collects user input and proposes YAML; the actual file
      // write + git commit happen in the `setup-apply` endpoint, which
      // targets a DIFFERENT session's worktree (the originating
      // card-linked session, resolved at apply time). Setting
      // use_worktree=1 would clone the project into a throwaway
      // worktree for the wizard itself — the commit would land on the
      // wrong branch and never reach the originating session's PR.
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
      setSessionOwner(sessionId, ownerUid);

      // Resolve the apply target NOW and pass it both into the kickoff
      // prompt (so the agent surfaces it to the user) and into the
      // response payload (so the Settings UI can show it before the
      // commit lands). This is the wizard's best guess — `setup-apply`
      // re-resolves at request time, so a fresher session that appears
      // between spawn and apply will displace this target. The skill
      // walkthrough is responsible for echoing the `branch` returned by
      // apply back to the user as a confirmation step.
      const resolvedTarget = pickSessionWithWorktreeForHint(stmts, project);
      const resolvedTargetPayload: ResolvedApplyTarget | null = resolvedTarget
        ? {
            sessionId: resolvedTarget.id,
            branch: resolvedTarget.worktree_branch,
            worktreePath: resolvedTarget.worktree_path,
          }
        : null;
      const prompt = buildKickoffPrompt(project.id, cwd, draft, resolvedTargetPayload);
      // Fire-and-forget chat handler — mirror the bug-reports / board
      // pattern: never let a downstream rejection escape as an
      // UnhandledPromiseRejection. The wizard route's HTTP response is
      // already in flight.
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[finalize-wizard] handleChat failed for session ${sessionId}: ${message}`);
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'finalize_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({
        sessionId,
        agentId,
        draft,
        session,
        target: resolvedTargetPayload,
      });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/setup-apply
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/setup-apply',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = (req.body ?? {}) as ApplyBody;
      const content = typeof body.ci_yaml_content === 'string' ? body.ci_yaml_content : '';
      if (!content.trim()) {
        res.status(400).json({ error: 'ci_yaml_content must be a non-empty string' });
        return;
      }
      // v1 validation upstream of the disk write — a malformed file
      // never lands on the branch.
      const parsed = parseCiConfig(content);
      if (!parsed.ok) {
        res.status(400).json({
          error: 'ci_config_invalid',
          code: parsed.error.code,
          message: parsed.error.message,
          path: parsed.error.path ?? null,
        });
        return;
      }
      const target = await resolveApplyTarget(
        { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
        project,
        body.session_id,
      );
      if (!target) {
        res.status(400).json({
          error: 'no_worktree',
          message:
            'No session with an active worktree was found for this project. Pass `session_id` for the card session you are working in (setup-apply can bind its checkout), or start a card-linked session first.',
        });
        return;
      }

      let secretsImported = 0;
      if (body.secrets) {
        const secretsResult = applyWizardSecrets(
          project.id,
          body.secrets,
          (req as AuthenticatedRequest).authUserId ?? null,
        );
        if (!secretsResult.ok) {
          res.status(secretsResult.statusCode).json({ error: secretsResult.error });
          return;
        }
        secretsImported = secretsResult.secretsImported;
      }

      // Defensive: ensure the worktree path is inside the configured
      // workspaces root or the project cwd. We don't enforce a hard
      // policy here (the worktree column is server-managed), but a
      // missing directory is a real error we should surface.
      try {
        const stat = await fs.stat(target.worktree_path);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: 'worktree_path is not a directory' });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          error: 'worktree_missing',
          message: `Worktree path is unreadable: ${message}`,
        });
        return;
      }

      const absFile = path.join(target.worktree_path, FINALIZE_CI_CONFIG_RELATIVE_PATH);
      try {
        await fs.mkdir(path.dirname(absFile), { recursive: true });
        const toWrite = content.endsWith('\n') ? content : `${content}\n`;
        await fs.writeFile(absFile, toWrite, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'write_failed', message });
        return;
      }

      // Stage + commit in the worktree.
      //
      // CRITICAL: the wizard runs in its own `[Finalize Setup]` session
      // and commits into a DIFFERENT session's worktree (the originating
      // session that owns the branch). That session's index is routinely
      // pre-populated with unrelated staged work. Plain `git commit -m
      // ...` with no pathspec would sweep every staged file into the
      // "Add ci.yaml" commit under a misleading message — reviewer
      // confirmed the repro in PR #1179.
      //
      // Fix: `git commit -o -m ... -- <pathspec>`. The `-o`/`--only` flag
      // tells git to commit ONLY the listed paths regardless of what
      // else is in the index; pre-staged files stay staged on the same
      // index for the next legitimate commit. The `git add` above is
      // still needed because `-o` rejects an unstaged file.
      //
      // Author identity is a local fallback — push-time signing is
      // unchanged.
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
      };
      try {
        await execFileAsync('git', ['add', '--', FINALIZE_CI_CONFIG_RELATIVE_PATH], {
          cwd: target.worktree_path,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 * 1024 * 1024,
          env: commitEnv,
        });
        await execFileAsync(
          'git',
          [
            'commit',
            '--allow-empty',
            '-o',
            '-m',
            COMMIT_MESSAGE_TITLE,
            '--',
            FINALIZE_CI_CONFIG_RELATIVE_PATH,
          ],
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
        const commitSha = stdout.trim();
        res.json({
          ok: true,
          file: FINALIZE_CI_CONFIG_RELATIVE_PATH,
          commit_sha: commitSha,
          branch: target.worktree_branch,
          session_id: target.id,
          secrets_imported: secretsImported,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'commit_failed', message });
      }
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/wizard-complete
  // ───────────────────────────────────────────────────────────────
  //
  // Broadcast consumer (one): `FinalizeSettingsSection.jsx` in the web
  // client listens for `agenthub:finalize_wizard_complete` and calls
  // `onProjectsChange()` to refetch the project list. Unlike the
  // preview-wizard's analogous broadcast — which fires because
  // setup-apply mutated `projects.json` and the panel needs the new
  // shape — this broadcast fires because a git commit landed on the
  // originating session's worktree. The panel uses the refetch to
  // refresh any project-state cached on the client (PR status, latest
  // session timestamps) that the new ci.yaml + commit might have
  // updated. No server-side config was mutated by the wizard itself.
  router.post(
    '/api/projects/:projectId/finalize/wizard-complete',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (project) {
        broadcast({
          type: 'finalize_wizard_complete',
          projectId: project.id,
        });
      }
      res.json({ ok: true });
    },
  );

  return router;
}
