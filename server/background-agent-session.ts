/**
 * "Run as session" for custom background agents.
 *
 * A custom background agent normally runs its prompt as a headless one-shot
 * spawn. With `runAsSession` on, each run instead opens a real chat session
 * (visible in the sidebar, resumable by a human) under a project agent, in a
 * chosen session mode, with a set of skills preloaded into the first turn.
 *
 * `handleChat` lives in chat.ts, which heartbeat.ts must not import (cycle), so
 * the deps are late-bound from index.ts via `initBackgroundAgentSessionHook`,
 * the same pattern the wiki-doc dispatcher uses.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  Agent,
  AppConfig,
  BackgroundCustomAgentConfig,
  BroadcastFn,
  ChatMessage,
  Project,
  SessionRow,
  Stmts,
} from './types.js';
import { setSessionOwner } from './session-ownership.js';
import { broadcastSessionCreated } from './session-checkpoint-rewind.js';
import { resolveEffectiveEngineAndModel } from './effective-model.js';
import { getProjectMode, defaultSessionUseWorktreeFlag } from './project-mode.js';
import { isWorkflowProject } from './project-mode-guards.js';
import { loadSkillByName } from './skill-invoke.js';
import { resolveWorkspaceSkillsDir } from './project-paths.js';

/**
 * Session control values a background session may start in. Mirrors the
 * client's session-control picker minus Design (needs a ready worktree before
 * the mode can be entered) and VM (needs Firecracker on the host).
 */
export const BACKGROUND_SESSION_MODES = [
  'manual',
  'review',
  'push',
  'merge',
  'consult',
  'scoping',
  'skill-builder',
  'autopilot',
] as const;

export type BackgroundSessionMode = (typeof BACKGROUND_SESSION_MODES)[number];

export const DEFAULT_BACKGROUND_SESSION_MODE: BackgroundSessionMode = 'manual';

const WORKFLOW_BACKGROUND_SESSION_MODES = new Set<BackgroundSessionMode>([
  'consult',
  'scoping',
  'skill-builder',
]);

/** Roles that never host an ad-hoc background session. */
const INELIGIBLE_SESSION_ROLES = new Set(['reviewer', 'docs', 'hub-assistant', 'skill-builder']);

export const MAX_BACKGROUND_SESSION_SKILLS = 20;

export function isBackgroundSessionMode(value: unknown): value is BackgroundSessionMode {
  return (
    typeof value === 'string' && (BACKGROUND_SESSION_MODES as readonly string[]).includes(value)
  );
}

/** Modes offered for a project: workflow projects have no build/ship levels. */
export function backgroundSessionModesForProject(
  project: Project | null | undefined,
): BackgroundSessionMode[] {
  if (isWorkflowProject(project)) {
    return BACKGROUND_SESSION_MODES.filter((m) => WORKFLOW_BACKGROUND_SESSION_MODES.has(m));
  }
  return [...BACKGROUND_SESSION_MODES];
}

/** Mode used when none is configured: workflow projects have no Build levels. */
export function defaultBackgroundSessionModeForProject(
  project: Project | null | undefined,
): BackgroundSessionMode {
  return isWorkflowProject(project) ? 'consult' : DEFAULT_BACKGROUND_SESSION_MODE;
}

/**
 * Split a control value into the two session columns it drives. Finalize
 * levels run in `chat` mode; autopilot pins `push` like the session-create
 * route does.
 */
export function resolveBackgroundSessionControl(
  value: string | null | undefined,
  project?: Project | null,
): {
  sessionMode: string;
  finalizeAutomation: 'manual' | 'review' | 'push' | 'merge';
} {
  const v = isBackgroundSessionMode(value)
    ? value
    : defaultBackgroundSessionModeForProject(project);
  switch (v) {
    case 'manual':
    case 'review':
    case 'push':
    case 'merge':
      return { sessionMode: 'chat', finalizeAutomation: v };
    case 'autopilot':
      return { sessionMode: 'autopilot', finalizeAutomation: 'push' };
    default:
      return { sessionMode: v, finalizeAutomation: 'manual' };
  }
}

export function isEligibleBackgroundSessionAgent(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return !INELIGIBLE_SESSION_ROLES.has((agent.role ?? '').trim().toLowerCase());
}

/** The configured agent when eligible, else the project's first eligible agent. */
export function pickBackgroundSessionAgent(
  project: Project,
  agentId: string | null | undefined,
): Agent | null {
  const agents = project.agents ?? [];
  if (agentId) {
    const match = agents.find((a) => a.id === agentId);
    return isEligibleBackgroundSessionAgent(match) ? (match as Agent) : null;
  }
  return agents.find((a) => isEligibleBackgroundSessionAgent(a)) ?? null;
}

export interface BackgroundAgentSessionDeps {
  stmts: Stmts;
  config: AppConfig;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  broadcast: BroadcastFn;
}

let hook: BackgroundAgentSessionDeps | null = null;

export function initBackgroundAgentSessionHook(deps: BackgroundAgentSessionDeps): void {
  hook = deps;
}

export function resetBackgroundAgentSessionHook(): void {
  hook = null;
}

export class BackgroundSessionDispatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BackgroundSessionDispatchResult {
  sessionId: string;
  agentId: string;
  /** Skills that failed to load (missing / not allowed); the run still starts. */
  skippedSkills: string[];
}

export function backgroundSessionName(agentName: string): string {
  return `[Background] ${agentName}`;
}

/**
 * Create the session, apply mode + Finalize level + owner, stage the skill
 * injections for the first turn, and kick the prompt off. Returns once the
 * session row exists; the turn itself streams in the background, so a first
 * turn that fails to start is reported later through `onKickoffError`.
 */
export function dispatchBackgroundAgentSession(
  project: Project,
  cfg: BackgroundCustomAgentConfig,
  opts: { onKickoffError?: (message: string) => void } = {},
): BackgroundSessionDispatchResult {
  const deps = hook;
  if (!deps) {
    throw new BackgroundSessionDispatchError('no_hook', 'Session dispatch is not initialised');
  }
  const agent = pickBackgroundSessionAgent(project, cfg.sessionAgentId);
  if (!agent) {
    throw new BackgroundSessionDispatchError(
      'no_session_agent',
      cfg.sessionAgentId
        ? `Agent "${cfg.sessionAgentId}" cannot host a background session`
        : 'This project has no agent that can host a background session',
    );
  }
  const control = isBackgroundSessionMode(cfg.sessionMode)
    ? cfg.sessionMode
    : defaultBackgroundSessionModeForProject(project);
  if (!backgroundSessionModesForProject(project).includes(control)) {
    throw new BackgroundSessionDispatchError(
      'mode_not_allowed',
      `Mode "${control}" is not available on this project`,
    );
  }
  const { sessionMode, finalizeAutomation } = resolveBackgroundSessionControl(control, project);
  const ownerUserId = cfg.ownerUserId ?? null;

  const { engine, model } = resolveEffectiveEngineAndModel(deps.config, {
    agentId: agent.id,
    agentEngine: agent.engine || 'claude-code',
    agentModel: agent.model ?? null,
    ownerUserId,
    explicitEngine: cfg.engine ?? undefined,
    explicitModel: cfg.model ?? undefined,
    projectMode: getProjectMode(project),
  });

  const sessionId = uuidv4();
  const { stmts } = deps;
  stmts.createSession.run(
    sessionId,
    agent.id,
    backgroundSessionName(cfg.name),
    engine,
    model,
    defaultSessionUseWorktreeFlag(project),
    0,
    1,
  );
  setSessionOwner(sessionId, ownerUserId);
  if (sessionMode !== 'chat') stmts.updateSessionMode.run(sessionMode, sessionId);
  stmts.updateSessionFinalizeAutomation.run(finalizeAutomation, sessionId);

  const skippedSkills: string[] = [];
  const injections: string[] = [];
  const skills = (cfg.skills ?? []).slice(0, MAX_BACKGROUND_SESSION_SKILLS);
  if (skills.length > 0) {
    const skillsDir = resolveWorkspaceSkillsDir(project, agent);
    for (const name of skills) {
      const injection = loadSkillByName({
        name,
        reason: `default skill for background agent "${cfg.name}"`,
        paths: { skillsDir },
        sessionId,
        stmts,
        broadcast: deps.broadcast,
        allowedSkills: agent.allowedSkills ?? null,
      });
      if (!injection.trim() || injection.includes('## Skill Load Error')) {
        skippedSkills.push(name);
      } else {
        injections.push(injection);
      }
    }
  }
  if (injections.length > 0) {
    stmts.updateSessionPendingSkillContext.run(injections.join('\n\n'), sessionId);
  }

  void deps
    .handleChat(null, {
      type: 'chat',
      agentId: agent.id,
      sessionId,
      content: cfg.prompt,
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Background Agent] session ${sessionId} kickoff failed: ${msg}`);
      opts.onKickoffError?.(msg);
    });

  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (session) broadcastSessionCreated(deps.broadcast, agent.id, session, stmts, project);
  return { sessionId, agentId: agent.id, skippedSkills };
}
