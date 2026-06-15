/**
 * AI RUM (real user monitoring) instrumentation wizard routes.
 *
 *   GET /api/projects/:projectId/rum/setup-draft
 *     Admin+. Scans the project's working copy for the signal the
 *     recorder-injection wizard needs before touching code: frontend
 *     framework, injection-target candidates, existing CSP locations, and
 *     whether the rrweb recorder is already wired. Returns
 *     `{ projectId, draft }` — read-only, no session spawn, no file
 *     writes.
 *
 *   POST /api/projects/:projectId/rum/setup-wizard
 *     Admin+. Spawns a worktree-backed `[RUM Setup]` chat session
 *     (`use_worktree=1`) loaded with the `rum-setup` skill, with the
 *     server-precomputed detection draft embedded in the kickoff prompt.
 *     The agent injects the rrweb recorder init into
 *     `draft.plan.targetFile` using `draft.plan.injectionStyle`, extends
 *     any `draft.cspHits` with the ingest connect-src origin, commits, and
 *     lets Finalize Code Changes push + open the PR. Returns
 *     `{ sessionId, agentId, draft, session }`.
 *
 * This is the recorder-injection slice of the broader "Hub as RUM vendor"
 * wizard. The per-project client token and the apply/open-PR step are
 * tracked as separate follow-up slices.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../roles.js';
import { resolveEffectiveModel } from '../effective-model.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { collectRumSetupDraft, type RumSetupDraft } from '../rum-setup-draft.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps, Project, SessionRow } from '../types.js';

/** Derive a bare origin from a configured public URL, if parseable. */
function ingestOriginFromConfig(publicUrl: unknown): string | undefined {
  if (typeof publicUrl !== 'string' || !publicUrl.trim()) return undefined;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return undefined;
  }
}

function pickWizardAgent(project: Project): string | null {
  if (!project.agents || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  return project.agents[0].id;
}

export function isRumSetupWizardSession(session: { name?: string | null }): boolean {
  return typeof session.name === 'string' && session.name.startsWith('[RUM Setup]');
}

export function buildRumKickoffPrompt(
  projectId: string,
  projectCwd: string,
  draft: RumSetupDraft,
  sessionId: string,
): string {
  const draftJson = JSON.stringify(draft, null, 2);
  const target = draft.plan.targetFile ?? '(none detected — pick from entryCandidates)';
  const style = draft.plan.injectionStyle ?? '(undetermined)';
  const cspCount = draft.cspHits.length;
  return [
    '# RUM Setup — recorder injection (required)',
    '',
    'You are a **worktree-backed** setup session: you already sit on a fresh',
    '`agent-hub/…` branch. Inject the rrweb recorder, commit, and let Finalize',
    'Code Changes push and open the PR. **Do not** create a new branch.',
    '',
    'This repo scan detected framework **' +
      draft.framework +
      '**, target file **' +
      target +
      '**, injection style **' +
      style +
      '**, and **' +
      String(cspCount) +
      '** existing CSP location(s) to extend.',
    '',
    '## Bound values',
    '',
    `- **PROJECT_ID**: \`${projectId}\``,
    `- **PROJECT_CWD**: \`${projectCwd}\``,
    `- **YOUR SESSION_ID**: \`${sessionId}\``,
    '- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`**: use these for any wizard API call. If a call returns HTTP 401 or 403, halt and report the auth failure. Never ask the operator to paste a token into chat.',
    '',
    '## Server-provided draft (repo scan — do not re-run scanners)',
    '',
    '```json',
    draftJson,
    '```',
    '',
    'Key fields: `framework`, `plan.targetFile`, `plan.injectionStyle` (`module-init` | `client-component` | `script-tag`), `plan.recommendedConnectSrc` (ingest origin for `connect-src`), `plan.alreadyInstrumented`, `cspHits[]`, `entryCandidates[]`, `typescript`.',
    '',
    '## Required walkthrough order',
    '',
    '1. **Confirm the target** — Summarize framework, `plan.targetFile`, and `plan.injectionStyle`. If `plan.alreadyInstrumented` is true or `plan.targetFile` is null, use a fenced `agenthub:ask` (offer `entryCandidates` as options) before editing.',
    "2. **Inject the recorder** — Edit `plan.targetFile` per `plan.injectionStyle`. For `client-component` (Next app-router Server Component layouts), create a `'use client'` child that starts the recorder in `useEffect` — never inline into the server layout. POST replays to `plan.recommendedConnectSrc` + `/api/replays`.",
    '3. **Extend the CSP** — For every `cspHits` entry, add `plan.recommendedConnectSrc` to its `connect-src` directive (derive from `default-src` if absent). If `cspHits` is empty, note no CSP was found.',
    '4. **Verify + commit** — Type-check/build the target if a script exists, commit the recorder init + CSP edits to THIS session branch, then `<agenthub:close-card>`. Finalize handles push + PR.',
    '',
    '**Ask JSON must use `question` + `header` + `options[].label` + `options[].description`** — not `prompt`, `id`, or `type`.',
    '',
    '<agenthub:skill>',
    JSON.stringify({
      name: 'rum-setup',
      reason: 'framework-specific recorder injection — draft embedded above',
    }),
    '</agenthub:skill>',
  ].join('\n');
}

export default function createRumWizardRoutes(deps: RouteDeps): Router {
  const { findProject, findAgent, stmts, handleChat, broadcast, config } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/rum/setup-draft',
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
      const draft = collectRumSetupDraft(cwd, {
        ingestOrigin: ingestOriginFromConfig(config?.publicUrl),
      });
      res.json({ projectId: project.id, draft });
    },
  );

  router.post(
    '/api/projects/:projectId/rum/setup-wizard',
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

      const draft = collectRumSetupDraft(cwd, {
        ingestOrigin: ingestOriginFromConfig(config?.publicUrl),
      });
      const ownerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const sessionId = uuidv4();
      const engine = agentLookup.agent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: agentLookup.agent.model,
        ownerUserId: ownerUid,
      });
      const sessionName = `[RUM Setup] ${project.name || project.id}`;
      // use_worktree=1: the wizard authors the recorder init and CSP edits
      // on its own branch, then uses Finalize Code Changes for review/push
      // like any normal coding session (mirrors preview/finalize setup).
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

      const prompt = buildRumKickoffPrompt(project.id, cwd, draft, sessionId);
      // Fire-and-forget chat handler — the HTTP response is already in
      // flight. The worktree is provisioned inside handleChat
      // (ensureWorktree) before the agent's first turn runs.
      void handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: prompt,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[rum-wizard] handleChat failed for session ${sessionId}: ${message}`);
      });

      const session = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'rum_wizard_started',
        projectId: project.id,
        sessionId,
        agentId,
      });
      res.status(201).json({ sessionId, agentId, draft, session });
    },
  );

  return router;
}
