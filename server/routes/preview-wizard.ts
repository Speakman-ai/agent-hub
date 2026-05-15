/**
 * AI-assisted preview setup wizard routes.
 *
 *   POST /api/projects/:projectId/preview/setup-wizard
 *     Admin+. Spawns a one-shot session against the project's lead
 *     agent with the `preview-setup` default skill instructions baked
 *     into the kickoff prompt. Returns `{ sessionId, agentId }` so the
 *     client can attach to the standard chat stream via
 *     `useSessionStream(sessionId)`.
 *
 *   POST /api/projects/:projectId/preview/wizard-complete
 *     The wizard skill's last step. Broadcasts a
 *     `preview_wizard_complete` WebSocket event so the open Settings →
 *     Preview panel can refetch the project record. No body; pure
 *     side-effect.
 *
 * Design notes:
 *
 * - The wizard reuses the existing session/message machinery so the
 *   user-facing UX is identical to any other chat. No new schema, no
 *   new transport.
 * - `use_worktree=0` because the wizard reads the project checkout but
 *   never mutates code. `ask_mode=0` so the agent can run the scanner
 *   helpers and call the local API to persist config.
 * - The completion endpoint requires User-level auth to prevent existence
 *   oracles and broadcast spam from unauthenticated callers.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute path to the bundled preview-setup skill's scripts directory.
// We surface this in the kickoff prompt so the agent can shell out to
// the env-usage / package-script scanners without needing an env-var
// injection path through the spawn allowlist. Exported for tests.
export const PREVIEW_SETUP_SKILL_SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  'default-skills',
  'preview-setup',
  'scripts',
);

/**
 * Choose the agent the wizard session should attach to. Prefer the
 * project's first agent (conventionally the lead). Returns null when
 * the project has no agents at all — caller surfaces a 400.
 */
function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  // The "lead" agent is the first one in the canonical roster. We
  // could prefer role=lead explicitly, but `Agent` doesn't have a
  // role field in `Project.agents` — falling back to position is fine.
  return project.agents[0].id;
}

/**
 * Compose the kickoff prompt the wizard agent receives as the first
 * user message. The prompt deliberately tells the agent which skill to
 * load via the `<agenthub:skill>` block so the SKILL.md body is
 * injected on the next turn — same protocol as any other skill load.
 */
// Exported for tests so the prompt-contract regression in
// `preview-wizard-prompt.test.ts` can assert the bound values land
// verbatim in the kickoff message body.
export function buildKickoffPrompt(
  projectId: string,
  projectCwd: string,
  skillScriptsDir: string,
): string {
  return [
    '# Preview Setup Wizard',
    '',
    'You have been spawned to walk the user through configuring the per-session worktree preview for this project.',
    '',
    '## Bound values (substitute these verbatim wherever SKILL.md references them)',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **SKILL_SCRIPTS_DIR**: \`${skillScriptsDir}\``,
    '',
    'Use these literal values directly in every curl URL and shell invocation in the skill body. **Do not** rely on shell env vars named `$PREVIEW_WIZARD_PROJECT_ID`, `$PREVIEW_WIZARD_CWD`, or `$AGENT_HUB_SKILL_DIR` — they are NOT set in your spawn environment.',
    '',
    'Load the `preview-setup` skill and follow its instructions. The skill explains the full step-by-step flow (static detector → env-usage scan → `agenthub:ask` block → persist → optional verification → broadcast completion).',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'preview-setup',
      reason: 'one-shot wizard kickoff — full instructions live in the skill body',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createPreviewWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  // ─── Spawn the wizard session ─────────────────────────────────────
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
        // Defensive — would mean projects.json is internally inconsistent.
        res.status(500).json({ error: 'Wizard agent could not be resolved' });
        return;
      }

      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const wizOwnerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: wizOwnerUid,
      });
      const sessionName = `[Preview Setup] ${project.name || project.id}`;
      // The wizard explicitly never mutates code — it only reads the
      // project checkout. So we always opt out of worktree isolation,
      // regardless of project mode or default flag.
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

      const prompt = buildKickoffPrompt(project.id, cwd, PREVIEW_SETUP_SKILL_SCRIPTS_DIR);
      // Fire-and-forget — `handleChat` writes the user message and
      // kicks off the streaming spawn. The HTTP response carries
      // enough to attach the client side.
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
        // Intentionally no `extraEnv`: the kickoff prompt surfaces
        // PROJECT_ID / PROJECT_CWD / SKILL_SCRIPTS_DIR as literal
        // "bound values" and SKILL.md references them via
        // `<PROJECT_ID>` placeholders. The `EXTRA_ENV_ALLOWLIST` is
        // also locked to `DEV_HUB_API_KEY` only, so spawning any
        // other keys here would be dropped at merge time anyway.
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'preview_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, session });
    },
  );

  // ─── Wizard reports persistence is done ───────────────────────────
  //
  // The skill calls this after PUT-ing `prEnv.preview` + secrets so
  // the open Settings panel knows to refetch. No body — the broadcast
  // payload identifies the project.
  //
  // Gated behind `requireRole('User')` so anonymous callers can't
  // (a) probe project-id existence via the 404/200 split, or
  // (b) spam refetches across every connected browser. The wizard
  // session inherits the spawning user's identity / API key so the
  // gate is transparent to legitimate callers.
  //
  // We deliberately do NOT distinguish "unknown project" from
  // "known project" in the response — both return `{ ok: true }` —
  // so the route reveals nothing beyond "you're authenticated". The
  // broadcast only fires when the project exists.
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
