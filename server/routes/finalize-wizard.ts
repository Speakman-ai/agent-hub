/**
 * Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard.
 *
 * The setup wizard spawns a **normal worktree-backed session** (not a
 * read-only chat surface): the session gets its own dedicated git
 * worktree on a fresh `agent-hub/…` branch, and the agent authors
 * `.agent-hub/ci.yaml`, runs the configured tests locally to prove the
 * pipeline, commits, pushes, and opens a PR for review — exactly like
 * any coding session. The server-precomputed draft is baked into the
 * kickoff prompt so the agent doesn't re-scan.
 *
 *   POST /api/projects/:projectId/finalize/setup-wizard
 *     Admin+. Spawns a worktree-backed session (`use_worktree=1`) loaded
 *     with the `finalize-setup` skill, embedding the project draft.
 *     Returns `{ sessionId, agentId, draft, session, target: null }`.
 *
 *   POST /api/projects/:projectId/finalize/setup-apply
 *     Admin+. Validates the proposed `ci_yaml_content` against the
 *     schema (server/finalize/ci-config.ts), writes it to
 *     `<worktree>/.agent-hub/ci.yaml`, and commits it to the worktree's
 *     branch. Returns `{ ok, file, commit_sha, branch }`.
 *
 *   POST /api/projects/:projectId/finalize/wizard-complete
 *     User+. Broadcasts `finalize_wizard_complete` for the Settings
 *     panel so it can refresh state.
 *
 * Lookup order for the target worktree (apply endpoint):
 *   - Request body `session_id` — the setup session passes its OWN id,
 *     whose worktree was provisioned on the first chat turn. Uses the
 *     persisted worktree when set; otherwise binds the project's primary
 *     git checkout (`project.cwd` + current branch) as a fallback for
 *     resumed sessions without a dedicated clone yet.
 *   - Otherwise the most-recent session for the project that has both a
 *     `worktree_path` and a `worktree_branch`.
 *   - If none of the above resolve (e.g. a bare apply call with no
 *     session_id and no worktree-bearing session anywhere), a dedicated
 *     `[Finalize Config]` session is created and provisioned on the fly
 *     so the generated ci.yaml still has a worktree + branch to commit
 *     to.
 *
 * Tests live in `server/test/finalize-wizard-route.test.ts` and
 * `server/test/finalize-wizard-prompt.test.ts`.
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
import { upsertServerCiConfig } from '../finalize/ci-config-store.js';
import { applyWizardSecrets, type WizardApplySecrets } from '../wizard-secrets-apply.js';
import {
  resolveApplyTarget,
  createAndProvisionCommitTarget,
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
  /**
   * Where the config should live. Defaults to `'committed'` (write + commit
   * `.agent-hub/ci.yaml` into the worktree — the shared, PR-visible flow).
   * `'server'` stores it on the Agent Hub server instead (no file, no commit) —
   * for repos that use Agent Hub without committing Hub-specific CI config.
   */
  storage?: 'committed' | 'server';
  /**
   * Scope for `storage: 'server'`. `'project'` (default) is the shared config;
   * `'personal'` stores an override keyed to the calling user.
   */
  server_scope?: 'project' | 'personal';
}

export type { ResolvedApplyTarget } from '../finalize/finalize-setup-apply-target.js';
export { resolveApplyTarget } from '../finalize/finalize-setup-apply-target.js';

export function buildKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: FinalizeSetupDraft,
  sessionId: string,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  return [
    '# Finalize Setup — guided walkthrough (required)',
    '',
    'You are the **default** authoring path for `.agent-hub/ci.yaml`, and you run as a **normal worktree-backed session**. You are already checked out in your own dedicated git worktree on a fresh `agent-hub/…` branch (a clone of the project). Everything you do here — editing files, committing, running tests, pushing — happens in that worktree, exactly like any coding session. Walk the user through Finalize configuration **interactively** (do not tell them to read schema docs), then **prove the config by running it locally and ship it through a normal PR review**.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD** (where the draft below was scanned from): \`${projectCwd}\``,
    `- **YOUR SESSION_ID** (pass this to setup-apply): \`${sessionId}\``,
    '',
    '> Your worktree + branch are provisioned automatically on this first turn — you are already inside them. Author, commit, test, and push from here. Do **not** ask the user for a `session_id` and do **not** tell them to start a different/card-linked session: **this session IS the working session**, and its worktree is where the config lands.',
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
    '4. **Pipeline proposal** — show the YAML verbatim in a fenced ```yaml block and ask: use as-is, edit, or add a custom job/step.',
    '   - `version: 2` is the only schema the parser accepts: a `jobs:` mapping where each job declares `runs-on:` and a `steps:` list. Jobs run as **independent concurrent runners on the DinD fleet** (`runs-on: ubuntu-24.04`), exactly like GitHub fans a workflow out. Map **one job per GitHub job**, and mirror a GitHub `matrix` with `matrix.include` (each row becomes its own concurrent instance). **Do NOT group, serialize, or drop jobs to "save" runners — full fan-out is the goal.** Use `needs:` only to reproduce a real GitHub `needs:` edge; otherwise leave jobs independent so they all start at once.',
    '   - `runs-on: host` runs the job on the Hub box instead of a container. Use it for a lightweight gate that needs no Docker; note that host jobs share the session worktree, so gates that install deps into the same directory need a `needs:` edge onto a single install job rather than running concurrently.',
    "   - Container-job reminders: each job runs on its own runner with a fresh worktree and **no `node_modules` sharing between jobs**, so every job installs its own deps (mirror each GitHub job's install scope). Steps have **no `if:`** — branch inside the `run` script off the injected `FINALIZE_MATRIX_*` env vars (a `matrix.include` key `foo` becomes `$FINALIZE_MATRIX_FOO`). Reference project secrets via `${VAR}` in a job/step `env:` block.",
    '   - Constraints: `on:` must be `finalize`/`manual`; `timeout_minutes` in `[1, 240]`. Full schema: `references/ci-yaml-schema.md`.',
    '5. **Env vars / secrets** — call out `draft.envVars` entries the steps will read. For each missing value, `agenthub:ask` whether to collect it now (bundle into `setup-apply` as `secrets`) or skip. Persist via `setup-apply` `{ "secrets": { "mode": "merge", "env": "KEY=value\\n", "defaultKind": "secret" } }` — same as preview wizard. Users can also edit secrets in Settings → Finalize → Project secrets.',
    '6. **Confirm with the user** — restate the proposed pipeline in plain prose and `agenthub:ask` a simple **Apply** / **Cancel**. **Never make the user pick or supply a `session_id`** — you already own the worktree.',
    '7. **Commit** — `POST .../finalize/setup-apply` with `{ "ci_yaml_content": "<the final YAML>", "session_id": "<YOUR SESSION_ID above>", "secrets": { ... } }` (secrets optional). This validates the schema and commits `.agent-hub/ci.yaml` into **this session\'s own worktree**. On 400 `ci_config_invalid`, fix the error code/path and retry — do not work around the validation.',
    '8. **Verify in your worktree** — actually run the steps you just configured (the `run:` commands from the ci.yaml — e.g. install, lint, tests) right here in the worktree to prove the pipeline is green **before** you push. This local proof is the whole point of working in a worktree. If anything fails, fix the config (or the repo), re-apply via setup-apply, and re-run until clean.',
    '9. **Push + open a PR** — push your branch and open a pull request (`gh pr create`) describing the new Finalize runner config so it goes through normal review like any change. Report the PR URL back to the user.',
    '10. **`POST .../finalize/wizard-complete`**, then `<agenthub:close-card>`.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type`.',
    '',
    '**Never** propose `shell:`, `uses:`, or `with:` — the parser rejects them. `env:` (top/job/step) and `matrix.include` (job-level) are first-class, and are how you get GHA-parity concurrency.',
    '',
    '## CI replacement mode (user scope wins)',
    '',
    'Finalize is designed to **replace GitHub Actions CI** as the pre-push gate — including heavy steps (Docker, AWS, E2E, permissions sync). When the user says Finalize replaces CI, run all workflows, or asks you to stop downgrading scope:',
    '',
    '- Propose **one job per CI gate workflow** in `draft.githubWorkflows` (lint, `*.ci.yml`, e2e, permissions, smoke-test). Exclude deploy/release/terraform workflows only.',
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

      // Scan from the project root — the proposed YAML is identical
      // regardless of branch. The wizard session itself gets a real
      // worktree (below) so it can commit, test, and push like any
      // normal session.
      const draft = collectFinalizeSetupDraft(cwd);
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
        agentId,
      });
      const sessionName = `${SESSION_NAME_PREFIX} ${project.name || project.id}`;
      // use_worktree=1: the setup session runs like a normal coding
      // session. `ensureWorktree` provisions a dedicated clone on a fresh
      // `agent-hub/…` branch on the first chat turn, so the agent authors
      // `.agent-hub/ci.yaml`, runs the configured tests locally to prove
      // the pipeline, then pushes its branch and opens a PR for review —
      // exactly the flow the user expects for "set up the runner". The
      // commit lands in THIS session's own worktree (the agent passes its
      // own session_id to setup-apply).
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

      const prompt = buildKickoffPrompt(project.id, cwd, draft, sessionId);
      // Fire-and-forget chat handler — mirror the bug-reports / board
      // pattern: never let a downstream rejection escape as an
      // UnhandledPromiseRejection. The wizard route's HTTP response is
      // already in flight. The worktree is provisioned inside handleChat
      // (ensureWorktree) before the agent's first turn runs.
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
        // The setup session owns its own worktree; there is no separate
        // commit target to surface. Kept for response-shape stability.
        target: null,
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
      // Validate upstream of the disk write so a malformed file never lands
      // on the branch.
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

      // Server-storage branch: persist the validated config on the Hub instead
      // of committing a file into the repo. No worktree/commit required. The
      // config resolver still prefers any committed `.agent-hub/ci.yaml` at run
      // time — this is the fallback for repos that don't commit CI config.
      //
      // Validate `storage` strictly (like `server_scope` below): an unknown
      // value must 400, not silently fall through to the committed/commit path.
      // `storage: 'server'` is explicitly the no-commit mode, so a typo like
      // `'serverr'` writing + committing a file would be a surprising side effect.
      const rawStorage = body.storage;
      if (rawStorage !== undefined && rawStorage !== 'committed' && rawStorage !== 'server') {
        res.status(400).json({ error: "storage must be 'committed' or 'server'" });
        return;
      }
      const storage = rawStorage ?? 'committed';
      if (storage === 'server') {
        const rawScope = body.server_scope;
        if (rawScope !== undefined && rawScope !== 'project' && rawScope !== 'personal') {
          res.status(400).json({ error: "server_scope must be 'project' or 'personal'" });
          return;
        }
        const scope = rawScope ?? 'project';
        const uid = resolveOwnerUserId(req as AuthenticatedRequest);
        if (scope === 'personal' && !uid) {
          res.status(400).json({
            error: 'no_user',
            message: 'A personal server config requires an authenticated user.',
          });
          return;
        }
        let secretsImportedServer = 0;
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
          secretsImportedServer = secretsResult.secretsImported;
        }
        try {
          upsertServerCiConfig(stmts, {
            projectId: project.id,
            ownerUserId: scope === 'personal' ? uid : null,
            yamlText: content,
            updatedBy: uid,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: 'ci_config_store_failed', message });
          return;
        }
        res.json({
          ok: true,
          storage: 'server',
          server_scope: scope,
          secrets_imported: secretsImportedServer,
        });
        return;
      }

      let target = await resolveApplyTarget(
        { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
        project,
        body.session_id,
      );
      // No existing worktree-bearing session (the common case when the
      // wizard is launched from Settings rather than a card session).
      // Provision a dedicated `[Finalize Config]` worktree on a fresh
      // branch so the generated ci.yaml has somewhere to land — without
      // this the apply 400s with `no_worktree` and the config can never
      // be committed.
      if (!target) {
        const agentId = pickWizardAgent(project);
        const agentLookup = agentId ? findAgent(agentId) : null;
        if (agentId && agentLookup) {
          const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
          const engine = agentLookup.agent.engine || 'claude-code';
          const model = resolveEffectiveModel(config, engine, {
            agentModel: agentLookup.agent.model,
            ownerUserId: ownerUid,
            agentId,
          });
          target = await createAndProvisionCommitTarget(
            { stmts, provisionSessionWorkspace: deps.provisionSessionWorkspace },
            {
              agentId,
              name: `[Finalize Config] ${project.name || project.id}`,
              engine,
              model,
            },
            (sid) => setSessionOwner(sid, ownerUid),
          );
        }
      }
      if (!target) {
        res.status(400).json({
          error: 'no_worktree',
          message:
            'No session with an active worktree was found and a dedicated config worktree could not be provisioned (is the project cwd a git repo?). Pass `session_id` for the card session you are working in, or start a card-linked session first.',
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
