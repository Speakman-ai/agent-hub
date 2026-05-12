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
 * - The completion endpoint is intentionally permissive on auth (it
 *   only emits a WS broadcast and reveals nothing) so the skill can
 *   reach it even if the active spawn's API key was scoped down.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { defaultModelForEngine } from '../config.js';
import { defaultSessionUseWorktreeFlag, getProjectMode } from '../project-mode.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

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
function buildKickoffPrompt(projectId: string, projectCwd: string): string {
  return [
    '# Preview Setup Wizard',
    '',
    'You have been spawned to walk the user through configuring the per-session worktree preview for this project.',
    '',
    `**Project id**: \`${projectId}\``,
    `**Project cwd**: \`${projectCwd}\``,
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
  const { findProject, findAgent, stmts, handleChat, broadcast } = deps;
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
      const cwd = (project as { cwd?: string }).cwd;
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
      const model = agentLookup.agent.model || defaultModelForEngine(engine);
      const sessionName = `[Preview Setup] ${project.name || project.id}`;
      // The wizard explicitly never mutates code, so we opt out of
      // worktree isolation. Workflow-mode projects already default to
      // 0 — `defaultSessionUseWorktreeFlag` honours that.
      let useWorktree = defaultSessionUseWorktreeFlag(project);
      if (getProjectMode(project) === 'workflow') useWorktree = 0;
      useWorktree = 0; // Override: wizards never need a worktree.
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

      const prompt = buildKickoffPrompt(project.id, cwd);
      // Fire-and-forget — `handleChat` writes the user message and
      // kicks off the streaming spawn. The HTTP response carries
      // enough to attach the client side.
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
      res.status(201).json({ sessionId, agentId, session });
    },
  );

  // ─── Wizard reports persistence is done ───────────────────────────
  //
  // The skill calls this after PUT-ing `prEnv.preview` + secrets so
  // the open Settings panel knows to refetch. No body — the broadcast
  // payload identifies the project.
  router.post('/api/projects/:projectId/preview/wizard-complete', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    broadcast({
      type: 'preview_wizard_complete',
      projectId: project.id,
    });
    res.json({ ok: true });
  });

  return router;
}
