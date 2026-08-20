/**
 * Hub assistant — hidden workflow project + sentinel agent, and per-user
 * Hub sessions (session_mode = hub, owned by the caller).
 *
 * The agent is org-scoped (one row). Credentials follow the session owner,
 * so each user's Hub chat uses their own CLI identity. The project is
 * filtered out of GET /api/projects so it never appears as a worker roster.
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  HUB_ASSISTANT_AGENT_ID,
  HUB_ASSISTANT_ROLE,
  HUB_PROJECT_ID,
  HUB_SESSION_MODE,
  HUB_SESSION_NAME,
} from '../shared/utils/hub.js';
import { defaultModelForEngine } from './config.js';
import { resolveEffectiveEngineAndModel } from './effective-model.js';
import { getWorkflowWorkspaceDir } from './project-mode.js';
import {
  findAgent,
  findProject,
  getProjectDataDir,
  getProjects,
  saveProjects,
} from './project-model.js';
import { setSessionOwner } from './session-ownership.js';
import { HUB_SKILL_IDS } from './hub-mode-prompt.js';
import type { Agent, AppConfig, BroadcastFn, Project, SessionRow, Stmts } from './types.js';

/** Retired Hub pane sessions — never treat these as the live Assistant chat. */
const LEGACY_TROUBLESHOOT_SESSION_NAME = 'Troubleshooting';

const HUB_SOUL = `# SOUL.md — Hub

You are this user's Hub assistant. You help them run Agent Hub: what to
focus on next, ticket and epic progress, customer support, configuration,
and kicking off project agents. You do not ship application code.
`;

export { isHubSystemProject } from '../shared/utils/hub.js';

/**
 * Idempotently create the Hub project's on-disk workspace (spawn cwd) and its
 * SOUL.md. Safe to call on every `ensureHubProject`: the project row can outlive
 * its filesystem (data-dir restore, container rebuild, manual cleanup), and any
 * consumer that spawns a CLI in the Hub cwd — daily summary, heartbeats — throws
 * ENOENT ("Working directory does not exist") if the dir is gone. Returns the
 * resolved cwd so a row with an empty/missing cwd can be repaired.
 */
function ensureHubWorkspaceFiles(cwd: string): void {
  const dataDir = getProjectDataDir(HUB_PROJECT_ID);
  mkdirSync(cwd, { recursive: true });
  const soulPath = path.join(dataDir, 'SOUL.md');
  if (!existsSync(soulPath)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(soulPath, HUB_SOUL, 'utf-8');
  }
}

export function ensureHubProject(): Project {
  const dataDir = getProjectDataDir(HUB_PROJECT_ID);
  const existing = findProject(HUB_PROJECT_ID);
  if (existing) {
    let dirty = false;
    if (existing.kind !== 'system') {
      existing.kind = 'system';
      dirty = true;
    }
    if (existing.mode !== 'workflow') {
      existing.mode = 'workflow';
      dirty = true;
    }
    if (!existing.cwd?.trim()) {
      existing.cwd = getWorkflowWorkspaceDir(dataDir);
      dirty = true;
    }
    ensureHubWorkspaceFiles(existing.cwd);
    if (dirty) saveProjects();
    return existing;
  }

  const cwd = getWorkflowWorkspaceDir(dataDir);
  ensureHubWorkspaceFiles(cwd);

  const project: Project = {
    id: HUB_PROJECT_ID,
    name: 'Hub',
    cwd,
    ahw: dataDir,
    color: '#22d3ee',
    mode: 'workflow',
    kind: 'system',
    agents: [],
  };
  getProjects().push(project);
  saveProjects();
  return project;
}

function syncHubAllowedSkills(agent: Agent): boolean {
  const current = Array.isArray(agent.allowedSkills) ? agent.allowedSkills : [];
  const missing = HUB_SKILL_IDS.filter((id) => !current.includes(id));
  if (missing.length === 0 && Array.isArray(agent.allowedSkills)) return false;
  agent.allowedSkills = [...current, ...missing];
  return true;
}

export function ensureHubAssistantAgent(): Agent {
  const project = ensureHubProject();
  const found = findAgent(HUB_ASSISTANT_AGENT_ID);
  if (found?.agent) {
    let dirty = false;
    if (found.agent.role !== HUB_ASSISTANT_ROLE) {
      found.agent.role = HUB_ASSISTANT_ROLE;
      found.agent.isDev = false;
      dirty = true;
    }
    if (syncHubAllowedSkills(found.agent)) dirty = true;
    if (dirty) saveProjects();
    return found.agent;
  }

  const engine = 'claude-code';
  const agent: Agent = {
    id: HUB_ASSISTANT_AGENT_ID,
    name: 'Hub',
    engine,
    role: HUB_ASSISTANT_ROLE,
    isDev: false,
    color: '#22d3ee',
    model: defaultModelForEngine(engine),
    allowedSkills: [...HUB_SKILL_IDS],
  };
  project.agents = project.agents || [];
  project.agents.push(agent);
  saveProjects();
  return agent;
}

function liveNamedHubSession(
  stmts: Stmts,
  userId: string,
  agentId: string,
  name: string,
): SessionRow | null {
  const rows = stmts.getSessions.all(agentId) as SessionRow[];
  return (
    rows.find(
      (row) =>
        row.owner_user_id === userId &&
        row.name === name &&
        (row.session_mode === HUB_SESSION_MODE || !row.session_mode) &&
        !row.deleted_at,
    ) ?? null
  );
}

function liveHubSessionForUser(stmts: Stmts, userId: string, agentId: string): SessionRow | null {
  const named = liveNamedHubSession(stmts, userId, agentId, HUB_SESSION_NAME);
  if (named) return named;
  const rows = stmts.getSessions.all(agentId) as SessionRow[];
  return (
    rows.find(
      (row) =>
        row.owner_user_id === userId &&
        row.name !== LEGACY_TROUBLESHOOT_SESSION_NAME &&
        (row.session_mode === HUB_SESSION_MODE || !row.session_mode) &&
        !row.deleted_at,
    ) ?? null
  );
}

export function resolveHubEngineAndModel(
  cfg: AppConfig | undefined,
  userId: string,
): { engine: string; model: string } {
  const agent = ensureHubAssistantAgent();
  const engine = agent.engine || 'claude-code';
  if (!cfg) {
    return {
      engine,
      model: agent.model || defaultModelForEngine(engine) || 'claude-opus-5',
    };
  }
  const resolved = resolveEffectiveEngineAndModel(cfg, {
    agentId: agent.id,
    agentEngine: engine,
    agentModel: agent.model,
    ownerUserId: userId,
  });
  return { engine: resolved.engine, model: resolved.model };
}

function createHubOwnedSession(
  stmts: Stmts,
  agent: Agent,
  userId: string,
  name: string,
  cfg?: AppConfig,
): SessionRow {
  const id = uuidv4();
  const resolved = resolveHubEngineAndModel(cfg, userId);
  const engine = resolved.engine || agent.engine || 'claude-code';
  const model = resolved.model || agent.model || defaultModelForEngine(engine) || 'claude-opus-5';
  stmts.createSession.run(id, agent.id, name, engine, model, 0, 0, 1);
  stmts.updateSessionMode.run(HUB_SESSION_MODE, id);
  setSessionOwner(id, userId);
  return stmts.getSession.get(id) as SessionRow;
}

/** Keep a live Hub session on the caller's Hub engine/model pick. */
function alignSessionToHubPick(
  stmts: Stmts,
  session: SessionRow,
  cfg: AppConfig | undefined,
  userId: string,
): SessionRow {
  const resolved = resolveHubEngineAndModel(cfg, userId);
  if (session.engine !== resolved.engine) {
    stmts.updateSessionEngine.run(resolved.engine, session.id);
    session.engine = resolved.engine;
  }
  if ((session.model || '') !== resolved.model) {
    stmts.updateSessionModel.run(resolved.model, session.id);
    session.model = resolved.model;
  }
  return session;
}

export interface HubSessionArgs {
  stmts: Stmts;
  userId: string;
  config?: AppConfig;
}

export function getOrCreateHubSession(args: HubSessionArgs): {
  agent: Agent;
  session: SessionRow;
  created: boolean;
} {
  const agent = ensureHubAssistantAgent();
  const existing = liveHubSessionForUser(args.stmts, args.userId, agent.id);
  if (existing) {
    if (existing.session_mode !== HUB_SESSION_MODE) {
      args.stmts.updateSessionMode.run(HUB_SESSION_MODE, existing.id);
      existing.session_mode = HUB_SESSION_MODE;
    }
    return {
      agent,
      session: alignSessionToHubPick(args.stmts, existing, args.config, args.userId),
      created: false,
    };
  }
  return {
    agent,
    session: createHubOwnedSession(args.stmts, agent, args.userId, HUB_SESSION_NAME, args.config),
    created: true,
  };
}

export function liveHubSessionsForUser(stmts: Stmts, userId: string): SessionRow[] {
  const agent = ensureHubAssistantAgent();
  const rows = stmts.getSessions.all(agent.id) as SessionRow[];
  return rows.filter(
    (row) =>
      row.owner_user_id === userId &&
      !row.deleted_at &&
      (row.session_mode === HUB_SESSION_MODE || !row.session_mode),
  );
}

export function applyHubEngineAndModelToLiveSessions(args: {
  stmts: Stmts;
  userId: string;
  engine: string;
  model: string;
}): string[] {
  const ids: string[] = [];
  for (const row of liveHubSessionsForUser(args.stmts, args.userId)) {
    args.stmts.updateSessionEngine.run(args.engine, row.id);
    args.stmts.updateSessionModel.run(args.model, row.id);
    ids.push(row.id);
  }
  return ids;
}

export function clearHubChatSession(
  args: HubSessionArgs & {
    activeProcesses?: Map<string, { kill: (signal?: NodeJS.Signals) => void }>;
    broadcast?: BroadcastFn;
  },
): { agent: Agent; session: SessionRow; clearedSessionId: string | null } {
  const existing = liveHubSessionForUser(args.stmts, args.userId, ensureHubAssistantAgent().id);
  if (!existing) {
    const created = getOrCreateHubSession(args);
    return { agent: created.agent, session: created.session, clearedSessionId: null };
  }
  const proc = args.activeProcesses?.get(existing.id);
  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
    args.activeProcesses?.delete(existing.id);
  }
  args.stmts.softDeleteSession.run(existing.id);
  try {
    args.broadcast?.({ type: 'session_deleted', sessionId: existing.id });
  } catch {
    /* best-effort */
  }
  const next = getOrCreateHubSession(args);
  return { agent: next.agent, session: next.session, clearedSessionId: existing.id };
}
