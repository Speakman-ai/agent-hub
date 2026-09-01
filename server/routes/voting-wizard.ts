/**
 * Voting integration scaffolder — spawn a seeded session in a target app.
 *
 *   POST /api/projects/:projectId/voting/setup-wizard
 *     User+. Spawns a worktree-backed `[Voting Setup]` session on a chosen
 *     agent of the target project, seeded with the versioned voting
 *     integration task pack as the first user message. The agent inspects
 *     the target repo, asks (via `agenthub:ask`) where the voting page
 *     should live, and generates the UI wired to this project's public
 *     voting API. Returns `{ sessionId, agentId, session }`.
 *
 * The launcher on the Customer Support Voting tab collects the target
 * project + agent (and an optional page-name hint) and deep-links into
 * the spawned session. This is a normal coding session, not a one-shot
 * codegen template: the pack is the contract, the agent matches the
 * app's existing styling.
 *
 * Success means the session is *usable*: the agent is startable (active,
 * not a reviewer, in the target project) AND the task-pack first turn has
 * been accepted by `handleChat` (persisted or queued). A dropped kickoff
 * deletes the row before 201 so a retry cannot stack empty `[Voting Setup]`
 * sessions.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { abandonUnseededSession, kickoffSeededTurn } from '../seeded-session-kickoff.js';
import { resolveVotingScaffolderFirstTurnPrompt } from '../voting-integration/scaffolder-session.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { AppConfig, RouteDeps, SessionRow } from '../types.js';

interface VotingWizardBody {
  agentId?: unknown;
  pageNameHint?: unknown;
}

/**
 * Bake a Hub base URL into the task pack only when it is a real public
 * http(s) origin. Loopback would teach the generated UI a URL that only
 * works on the Hub box, so we omit it and let the agent read the app's
 * own config instead.
 */
export function publicHubApiBase(config: AppConfig | null | undefined): string | null {
  const raw = typeof config?.publicUrl === 'string' ? config.publicUrl.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;
  } catch {
    return null;
  }
}

export default function createVotingWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  router.post(
    '/api/projects/:projectId/voting/setup-wizard',
    requireRole('User'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      if (!project.cwd || typeof project.cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }

      const body = (req.body ?? {}) as VotingWizardBody;
      const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
      if (!agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      const pageNameHint = typeof body.pageNameHint === 'string' ? body.pageNameHint : undefined;

      const agentLookup = findAgent(agentId);
      if (!agentLookup) {
        res.status(400).json({ error: 'Agent not found' });
        return;
      }
      if (agentLookup.project.id !== project.id) {
        res.status(400).json({ error: 'Agent does not belong to the target project' });
        return;
      }
      if (agentLookup.agent.active === false) {
        res.status(400).json({ error: 'Agent is inactive' });
        return;
      }
      if (agentLookup.agent.role === 'reviewer') {
        res.status(400).json({
          error:
            'Reviewer agent sessions are spawned by the GitHub webhook; they cannot be started manually.',
        });
        return;
      }

      let resolved;
      try {
        resolved = resolveVotingScaffolderFirstTurnPrompt({
          targetProjectId: project.id,
          pageNameHint,
          apiBaseUrl: publicHubApiBase(config),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }

      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
        agentId,
      });
      // use_worktree=1: the scaffolder authors the voting page on its own
      // branch, then uses Finalize Code Changes like any coding session.
      stmts.createSession.run(sessionId, agentId, resolved.name, engine, model, 1, 0, 1);
      setSessionOwner(sessionId, ownerUid);

      try {
        await kickoffSeededTurn({
          handleChat,
          agentId,
          sessionId,
          content: resolved.prompt,
          onBackgroundError: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[voting-wizard] handleChat failed for session ${sessionId}: ${message}`);
          },
        });
      } catch (err: unknown) {
        abandonUnseededSession(stmts, sessionId);
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to seed the voting setup session: ${message}` });
        return;
      }

      const session = stmts.getSession.get(sessionId) as SessionRow;
      if (!session) {
        res.status(500).json({ error: 'Failed to seed the voting setup session' });
        return;
      }
      broadcast({
        type: 'session_created',
        agentId,
        session,
      });
      res.status(201).json({ sessionId, agentId, session });
    },
  );

  return router;
}
