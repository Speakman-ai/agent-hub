/**
 * Session background shells — long-running shell commands the Hub owns so
 * they can be monitored and stopped across chat turns.
 *
 * Motivation: an agent's native `run_in_background` Bash shell dies with the
 * per-turn CLI process (see `background-shells/background-shell-runtime.ts`).
 * These routes expose the Hub-owned runtime instead, so `start` in one turn
 * and `logs` / `status` / `stop` in a later turn all work.
 *
 * All routes are session-scoped and gated by `userOwnsSession` — the
 * `x-api-key` break-glass an agent uses counts as owner (see
 * session-ownership.ts). Agents drive these via the bundled `bg.sh` wrapper;
 * the web/mobile Background shells panel reads the same surface.
 */
import { Router, Request, Response } from 'express';
import { accessSync, constants, statSync } from 'fs';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import type { BackgroundShellRuntime } from '../background-shells/background-shell-runtime.js';

export interface BackgroundShellRouteDeps extends RouteDeps {
  getBackgroundShellRuntime?: () => BackgroundShellRuntime | null;
}

const MAX_COMMAND_LEN = 8_000;
const MAX_LABEL_LEN = 200;

function isAccessibleDirectory(candidate: string): boolean {
  try {
    return (
      statSync(candidate).isDirectory() &&
      accessSync(candidate, constants.R_OK | constants.X_OK) === undefined
    );
  } catch {
    return false;
  }
}

export default function createBackgroundShellRoutes(deps: BackgroundShellRouteDeps): Router {
  const { stmts, findAgent, getBackgroundShellRuntime } = deps;
  const router = Router();

  /** Resolve the runtime or send a 503 — it's optional in some boot modes. */
  const runtimeOr503 = (res: Response): BackgroundShellRuntime | null => {
    const runtime = getBackgroundShellRuntime?.() ?? null;
    if (!runtime) {
      res.status(503).json({ error: 'Background shells are not available on this server' });
      return null;
    }
    return runtime;
  };

  /** Owns-session guard + session lookup. Sends the 404 itself on failure. */
  const requireOwnedSession = (req: Request, res: Response): SessionRow | null => {
    const sessionId = req.params.sessionId as string;
    if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return session;
  };

  // ─── List ──────────────────────────────────────────────────────────────
  router.get('/api/sessions/:sessionId/background-shells', (req: Request, res: Response) => {
    const session = requireOwnedSession(req, res);
    if (!session) return;
    const runtime = runtimeOr503(res);
    if (!runtime) return;
    res.json({ shells: runtime.list(session.id) });
  });

  // ─── Start ─────────────────────────────────────────────────────────────
  router.post('/api/sessions/:sessionId/background-shells', (req: Request, res: Response) => {
    const session = requireOwnedSession(req, res);
    if (!session) return;
    const runtime = runtimeOr503(res);
    if (!runtime) return;

    const body = (req.body ?? {}) as { command?: unknown; label?: unknown };
    // Validate on the trimmed form (reject blank/whitespace-only), but run the
    // ORIGINAL string — the bg.sh wrapper shell-quotes argv, so leading/trailing
    // whitespace can be a meaningful part of a quoted first/last argument.
    const command = typeof body.command === 'string' ? body.command : '';
    if (!command.trim()) {
      return res.status(400).json({ error: 'command is required' });
    }
    if (command.length > MAX_COMMAND_LEN) {
      return res.status(400).json({ error: `command exceeds ${MAX_COMMAND_LEN} characters` });
    }
    const label = typeof body.label === 'string' ? body.label.slice(0, MAX_LABEL_LEN) : null;

    // A background shell runs in the session worktree so it sees the same
    // checkout the agent edits. Fall back to the project cwd for
    // worktree-less sessions; refuse if we can't resolve an accessible directory.
    const project = findAgent(session.agent_id)?.project ?? null;
    const cwd = session.worktree_path || project?.cwd || null;
    if (!cwd || !isAccessibleDirectory(cwd)) {
      return res
        .status(400)
        .json({ error: 'Session has no accessible worktree or project directory to run in' });
    }

    const shell = runtime.start({
      sessionId: session.id,
      projectId: project?.id ?? 'unknown',
      command,
      cwd,
      label,
    });
    res.status(201).json({ shell });
  });

  // ─── Get one ───────────────────────────────────────────────────────────
  router.get(
    '/api/sessions/:sessionId/background-shells/:shellId',
    (req: Request, res: Response) => {
      const session = requireOwnedSession(req, res);
      if (!session) return;
      const runtime = runtimeOr503(res);
      if (!runtime) return;
      const shell = runtime.getById(req.params.shellId as string);
      if (!shell || shell.session_id !== session.id) {
        return res.status(404).json({ error: 'Background shell not found' });
      }
      res.json({ shell });
    },
  );

  // ─── Logs ──────────────────────────────────────────────────────────────
  router.get(
    '/api/sessions/:sessionId/background-shells/:shellId/logs',
    (req: Request, res: Response) => {
      const session = requireOwnedSession(req, res);
      if (!session) return;
      const runtime = runtimeOr503(res);
      if (!runtime) return;
      const shell = runtime.getById(req.params.shellId as string);
      if (!shell || shell.session_id !== session.id) {
        return res.status(404).json({ error: 'Background shell not found' });
      }
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
      res.json({
        shell,
        logs: runtime.getLogTail(shell.id, limit),
      });
    },
  );

  // ─── Stop ──────────────────────────────────────────────────────────────
  router.post(
    '/api/sessions/:sessionId/background-shells/:shellId/stop',
    async (req: Request, res: Response) => {
      const session = requireOwnedSession(req, res);
      if (!session) return;
      const runtime = runtimeOr503(res);
      if (!runtime) return;
      const existing = runtime.getById(req.params.shellId as string);
      if (!existing || existing.session_id !== session.id) {
        return res.status(404).json({ error: 'Background shell not found' });
      }
      const shell = await runtime.stop(existing.id);
      res.json({ shell });
    },
  );

  return router;
}
