import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth.js';
import { defaultModelForEngine } from '../config.js';
import { getDb } from '../db.js';
import { unscheduleHeartbeat } from '../heartbeat.js';
import { resolveProjectPaths, contextFilePath, ALL_CONTEXT_FILES } from '../project-paths.js';
import { updateMemory, getMemoryData } from '../memory.js';
import { HOOK_EVENTS } from '../hooks.js';
import type { RouteDeps, Agent, Project, HookConfig } from '../types.js';
import { canViewProject } from '../project-visibility.js';
import { isAutonomyLocked, agentAcceptsAutonomousTickets } from '../agent-autonomy.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { getUserPreferencesRow, mergeUserPreferencesJson } from '../user-preferences-store.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { defaultHeartbeatOwnerUserId } from '../heartbeat-ownership.js';
import {
  readCodexModelsCacheForUser,
  resolveSelectableCodexModels,
} from '../codex-model-capability.js';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  BulkEngineRequestSchema,
  UpdateAgentMemoryRequestSchema,
} from './agents.openapi.js';

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `board.ts` / `wiki.ts` / `sessions.ts` so the wire
 * shape of validation failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

type AgentHeartbeatInput = Partial<
  Omit<NonNullable<Agent['heartbeat']>, 'shared'> & {
    shared?: boolean | 0 | 1 | '0' | '1';
  }
>;

function coerceHeartbeatShared(raw: boolean | 0 | 1 | '0' | '1' | undefined): 0 | 1 | undefined {
  if (raw === undefined) return undefined;
  return raw === true || raw === 1 || raw === '1' ? 1 : 0;
}

function heartbeatInputConfiguresRun(input: AgentHeartbeatInput | undefined): boolean {
  return Boolean(
    input &&
    (input.enabled || input.interval?.trim() || input.prompt?.trim() || input.model?.trim()),
  );
}

function normalizeAgentHeartbeat(
  input: AgentHeartbeatInput | undefined,
  existing: Agent['heartbeat'] | undefined,
  ownerUserId: string | null,
): Agent['heartbeat'] {
  const source = input ?? existing ?? { enabled: false, interval: '', prompt: '' };
  const existingOwner =
    typeof existing?.owner_user_id === 'string' && existing.owner_user_id.trim()
      ? existing.owner_user_id.trim()
      : null;
  const nextModel = input?.model !== undefined ? input.model : existing?.model;
  const coercedShared = coerceHeartbeatShared(input?.shared);
  const nextShared = coercedShared !== undefined ? coercedShared : existing?.shared ? 1 : 0;
  const claimsOwnership = heartbeatInputConfiguresRun(input);
  return {
    enabled: source.enabled ?? existing?.enabled ?? false,
    interval: source.interval ?? existing?.interval ?? '',
    prompt: source.prompt ?? existing?.prompt ?? '',
    ...(nextModel ? { model: nextModel } : {}),
    owner_user_id: existingOwner ?? (claimsOwnership ? ownerUserId : null),
    shared: nextShared,
  };
}

function heartbeatOwner(agent: Agent): string | null {
  const owner = agent.heartbeat?.owner_user_id;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

function heartbeatIsConfigured(agent: Agent): boolean {
  const heartbeat = agent.heartbeat;
  return Boolean(
    heartbeat?.enabled ||
    heartbeat?.interval?.trim() ||
    heartbeat?.prompt?.trim() ||
    heartbeat?.model?.trim(),
  );
}

function isOwnerCaller(req: AuthenticatedRequest): boolean {
  return req.authRole === 'Owner' || Boolean(req.authViaApiKey) || Boolean(req.authLocalOrgBypass);
}

function canManageAgentHeartbeat(req: AuthenticatedRequest, agent: Agent): boolean {
  if (isOwnerCaller(req)) return true;
  const callerId = resolveOwnerUserId(req);
  if (!callerId) return false;
  const owner = heartbeatOwner(agent);
  if (!owner && !heartbeatIsConfigured(agent)) return true;
  return owner === callerId;
}

function heartbeatRequestOwner(req: AuthenticatedRequest): string | null {
  return resolveOwnerUserId(req) ?? defaultHeartbeatOwnerUserId();
}

function resolveHeartbeatUpdateOwner(
  req: AuthenticatedRequest,
  agent: Agent,
  input: AgentHeartbeatInput | undefined,
): string | null {
  const owner = heartbeatOwner(agent);
  if (owner) return owner;
  if (!heartbeatInputConfiguresRun(input)) return null;
  return heartbeatRequestOwner(req);
}

/**
 * Translate a Zod-parsed browser-numeric dim (`number | null | undefined`)
 * to the `'delete' | number | undefined` tristate consumed by
 * `applyOptionalAgentNumeric`:
 *
 *   - `undefined` (key omitted)   → `undefined` ("preserve existing value")
 *   - `null`      (explicit clear) → `'delete'`  ("remove the key")
 *   - `number`    (explicit set)   → `Math.floor(value)`
 *
 * The schema has already validated that any explicit value is an integer
 * in the allowed range, so we only need to round-trip Zod's null sentinel
 * back to the legacy `'delete'` token.
 */
function translateDim(v: number | null | undefined): number | 'delete' | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 'delete';
  return Math.floor(v);
}

/**
 * Apply a Zod-parsed browser-numeric dim to the agent record.
 *
 * `value` is the `'delete' | number | undefined` tristate produced by
 * `translateDim` from the schema's `number | null | undefined`:
 *   - `undefined`  — key was omitted; preserve the existing value.
 *   - `'delete'`   — caller sent `null`; remove the key from the record.
 *   - `number`     — caller sent a numeric value; store it.
 */
function applyOptionalAgentNumeric(
  agent: Agent,
  key: 'browserViewportWidth' | 'browserViewportHeight' | 'browserPageLoadTimeoutMs',
  value: number | 'delete' | undefined,
) {
  if (value === undefined) return;
  if (value === 'delete') delete (agent as Record<string, unknown>)[key];
  else (agent as Record<string, unknown>)[key] = value;
}

export default function createAgentRoutes(deps: RouteDeps): Router {
  const { stmts, findProject, findAgent, getEnrichedAgent, allAgents, saveProjects } = deps;

  /**
   * Agent-scoped equivalent of the `/api/projects/:projectId` visibility
   * gate: look up the agent, then refuse to admit the caller when they
   * cannot view the agent's project. Returns the lookup tuple on success,
   * or `null` after writing a 404 to `res` — handlers can early-return
   * without re-checking auth themselves.
   *
   * We mask the "private project, you can't see this agent" case as
   * `'Agent not found'` (same shape and status as a genuinely missing
   * agent) so the endpoint never leaks the existence of agents that live
   * inside a private project the caller cannot enter.
   */
  function findAgentVisible(
    req: Request,
    res: Response,
    agentId: string,
  ): { project: Project; agent: Agent } | null {
    const found = findAgent(agentId);
    if (!found) {
      res.status(404).json({ error: 'Agent not found' });
      return null;
    }
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(found.project, caller)) {
      res.status(404).json({ error: 'Agent not found' });
      return null;
    }
    return found;
  }

  const router = Router();

  router.post('/api/agents/bulk-engine', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const userId = authedReq.authUserId?.trim();
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const parsed = parseBody(BulkEngineRequestSchema, req, res);
    if (!parsed) return;
    const { engine, model } = parsed;
    const engines = Object.keys(deps.config.engineValidModels);
    if (!engines.includes(engine)) {
      return res.status(400).json({
        error: `Invalid or missing engine. Must be one of: ${engines.join(', ')}`,
      });
    }
    const staticAllowed = deps.config.engineValidModels[engine] || [];
    let allowed = staticAllowed;
    if (engine === 'codex-cli') {
      const codexCache = readCodexModelsCacheForUser(userId, deps.config.dataDir);
      allowed = resolveSelectableCodexModels(staticAllowed, codexCache);
    }
    const configuredDefault = defaultModelForEngine(engine);
    let resolved = allowed.includes(configuredDefault)
      ? configuredDefault
      : allowed[0] || configuredDefault;
    if (model && allowed.includes(model)) {
      resolved = model;
    }
    // Per-user bulk switch: writes the caller's own engine + model overrides
    // for every agent they can see — never the shared `agents` row.
    const caller = resolveVisibilityCaller(req);
    const agentIds: string[] = [];
    for (const p of deps.getProjects()) {
      if (!canViewProject(p, caller)) continue;
      for (const a of p.agents) {
        agentIds.push(a.id);
      }
    }
    const currentPrefs = getUserPreferencesRow(userId);
    const nextEngineOverrides = { ...(currentPrefs.agentEngineOverrides ?? {}) };
    const nextModelOverrides = { ...(currentPrefs.agentModelOverrides ?? {}) };
    for (const agentId of agentIds) {
      nextEngineOverrides[agentId] = { engine };
      nextModelOverrides[agentId] = resolved;
    }
    mergeUserPreferencesJson(userId, {
      agentEngineOverrides: nextEngineOverrides,
      agentModelOverrides: nextModelOverrides,
    });
    res.json({ updated: agentIds.length, engine, model: resolved });
  });

  router.get('/api/agents', (req: Request, res: Response) => {
    // Filter to agents whose project the caller can view. `allAgents()`
    // already enriches each row with `projectId`, but we filter at the
    // project level for the canonical visibility check (a project's
    // `visibility` / `ownerUserId` live on the parent record, not the
    // agent). Under bypass identities (local-bundled server, global
    // x-api-key break-glass, no-auth-configured dev) `canViewProject`
    // returns true for every project, so the list shape is unchanged
    // for those callers.
    const caller = resolveVisibilityCaller(req);
    const visibleProjectIds = new Set(
      deps
        .getProjects()
        .filter((p) => canViewProject(p, caller))
        .map((p) => p.id),
    );
    const enriched = allAgents()
      .filter((a) => visibleProjectIds.has(a.projectId))
      .map((a) => {
        const sessions = stmts.getSessions.all(a.id) as Array<{ id: string; updated_at: string }>;
        let lastActivity: string | null = null;
        let lastMessage: { role: string; content: string; created_at: string } | null = null;
        if (sessions.length > 0) {
          lastActivity = sessions[0].updated_at;
          const msg = stmts.getLastMessage.get(sessions[0].id) as
            | {
                role: string;
                content: string;
                created_at: string;
              }
            | undefined;
          if (msg) {
            lastMessage = {
              role: msg.role,
              content: msg.content.substring(0, 100),
              created_at: msg.created_at,
            };
          }
        }
        return { ...a, lastActivity, lastMessage };
      });
    res.json(enriched);
  });

  router.patch('/api/agents/:agentId', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;

    const parsed = parseBody(UpdateAgentRequestSchema, req, res);
    if (!parsed) return;

    // Model picks are per-user now (`/api/auth/me/agent-model-overrides`); the
    // shared agent row no longer stores a model. Reject an explicit `model`
    // with a clear 400 instead of silently dropping it and returning 200 —
    // otherwise a client believes its shared-model write succeeded when the
    // row is unchanged. (`model` stays in the request schema on purpose so we
    // can detect and reject it here rather than have Zod strip it silently.)
    if (parsed.model !== undefined) {
      return res.status(400).json({
        error:
          'model is per-user and cannot be set via PATCH /api/agents/:agentId. ' +
          'Use PUT /api/auth/me/agent-model-overrides/:agentId instead.',
      });
    }

    // The "Dev" flag is derived from role for locked agents (default Dev roles
    // dev/lead are always on; out-of-band roles docs/reviewer always
    // off). Reject a contradictory `isDev` with a 400 — checked BEFORE any
    // mutation below — so a client never believes an impossible change took
    // effect. A write that matches the role-fixed value is accepted as a
    // harmless no-op. See `agentAcceptsAutonomousTickets` for the contract.
    //
    // Validate against the POST-PATCH role: this same request can mutate
    // `role` in the `allowed` loop below, so e.g. `{ role: 'reviewer', isDev:
    // true }` or `{ role: 'dev', isDev: false }` must be judged against the
    // candidate role, not the current one — otherwise the guard is bypassed.
    if (parsed.isDev !== undefined) {
      const nextRole = parsed.role !== undefined ? parsed.role : agent.role;
      const candidate = { role: nextRole, isDev: parsed.isDev };
      if (
        isAutonomyLocked(candidate) &&
        parsed.isDev !== agentAcceptsAutonomousTickets(candidate)
      ) {
        return res.status(400).json({
          error:
            `isDev cannot be changed for agent '${agent.id}': role ` +
            `'${nextRole}' fixes autonomous-ticket eligibility to ` +
            `${agentAcceptsAutonomousTickets(candidate)}.`,
        });
      }
    }

    if (
      parsed.heartbeat !== undefined &&
      !canManageAgentHeartbeat(req as AuthenticatedRequest, agent)
    ) {
      return res
        .status(403)
        .json({ error: 'Only the heartbeat owner or an org Owner can update it.' });
    }

    const allowed = [
      'name',
      'engine',
      'systemPrompt',
      'color',
      'avatar',
      'active',
      'reviewer',
      'role',
      'canReview',
    ] as const;
    for (const key of allowed) {
      if ((parsed as Record<string, unknown>)[key] !== undefined) {
        (agent as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key];
      }
    }
    if (parsed.heartbeat !== undefined) {
      agent.heartbeat = normalizeAgentHeartbeat(
        parsed.heartbeat,
        agent.heartbeat,
        resolveHeartbeatUpdateOwner(req as AuthenticatedRequest, agent, parsed.heartbeat),
      );
    }
    // Model picks are per-user (`/api/auth/me/agent-model-overrides`); ignore
    // any `model` field here so a settings save can't rewrite the shared row.
    if (parsed.browserToolsEnabled !== undefined) {
      agent.browserToolsEnabled = parsed.browserToolsEnabled;
    }
    // "Dev" flag (accepts autonomous tickets). The `allowed` loop above may
    // have just changed `role`, so `isAutonomyLocked(agent)` now reflects the
    // POST-PATCH role. Contradictions were already rejected with a 400; here
    // we persist the value only for togglable (unlocked) agents, and drop any
    // lingering raw `isDev` when the resulting role locks eligibility (it is
    // role-derived for locked agents, so the field would only be dead — and
    // potentially contradictory — weight on the row).
    if (isAutonomyLocked(agent)) {
      delete (agent as Record<string, unknown>).isDev;
    } else if (parsed.isDev !== undefined) {
      agent.isDev = parsed.isDev;
    }
    // Skill allowlist: `null` clears the restriction (back to all skills),
    // an array restricts to those ids, `undefined` preserves the current value.
    if (parsed.allowedSkills !== undefined) {
      if (parsed.allowedSkills === null) {
        delete (agent as Record<string, unknown>).allowedSkills;
      } else {
        agent.allowedSkills = parsed.allowedSkills;
      }
    }
    applyOptionalAgentNumeric(
      agent,
      'browserViewportWidth',
      translateDim(parsed.browserViewportWidth),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserViewportHeight',
      translateDim(parsed.browserViewportHeight),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserPageLoadTimeoutMs',
      translateDim(parsed.browserPageLoadTimeoutMs),
    );
    saveProjects();
    res.json(getEnrichedAgent(agent.id));
  });

  router.post('/api/agents', (req: Request, res: Response) => {
    const parsed = parseBody(CreateAgentRequestSchema, req, res);
    if (!parsed) return;

    const {
      id,
      projectId,
      name,
      engine,
      model,
      systemPrompt,
      color,
      heartbeat,
      role,
      browserToolsEnabled,
    } = parsed;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Visibility scope: refuse to add an agent to a project the caller
    // cannot view. Mask as 'Project not found' to keep parity with the
    // `/api/projects/:projectId` gate — we don't want this endpoint to
    // become an enumeration oracle for private projects.
    const caller = resolveVisibilityCaller(req);
    if (!canViewProject(project, caller)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (findAgent(id)) {
      return res.status(409).json({ error: 'Agent id already exists' });
    }
    const agentEngine = engine || 'claude-code';
    let defaultAgentModel = defaultModelForEngine(agentEngine);
    if (agentEngine === 'codex-cli') {
      const userId = (req as AuthenticatedRequest).authUserId?.trim();
      const staticAllowed = deps.config.engineValidModels[agentEngine] || [];
      const allowed = resolveSelectableCodexModels(
        staticAllowed,
        readCodexModelsCacheForUser(userId, deps.config.dataDir),
      );
      if (allowed.length > 0 && !allowed.includes(defaultAgentModel)) {
        defaultAgentModel = allowed[0];
      }
    }
    // The schema is partial — fields like `interval` / `prompt` on the
    // heartbeat config are optional. Build a fully-populated record so
    // downstream readers (heartbeat scheduler, settings UI) don't have to
    // gate every field.
    const heartbeatConfig: Agent['heartbeat'] = normalizeAgentHeartbeat(
      heartbeat,
      undefined,
      heartbeatInputConfiguresRun(heartbeat)
        ? heartbeatRequestOwner(req as AuthenticatedRequest)
        : null,
    );
    const agent: Agent = {
      id,
      name: name || id,
      engine: agentEngine,
      model: model || defaultAgentModel,
      systemPrompt: systemPrompt || '',
      color: color || project.color || '#6b7280',
      heartbeat: heartbeatConfig,
    };
    if (role) agent.role = role;
    // "Dev" flag (accepts autonomous tickets). Locked roles (dev/lead,
    // docs/reviewer) derive eligibility from their role: reject a
    // contradictory `isDev` with a 400 (before the agent is persisted),
    // accept a matching one as a no-op, and store it for togglable agents.
    if (typeof parsed.isDev === 'boolean') {
      if (isAutonomyLocked(agent)) {
        if (parsed.isDev !== agentAcceptsAutonomousTickets(agent)) {
          return res.status(400).json({
            error:
              `isDev cannot be set for agent '${agent.id}': its role ` +
              `'${agent.role}' fixes autonomous-ticket eligibility to ` +
              `${agentAcceptsAutonomousTickets(agent)}.`,
          });
        }
      } else {
        agent.isDev = parsed.isDev;
      }
    }
    if (browserToolsEnabled !== undefined) {
      agent.browserToolsEnabled = browserToolsEnabled;
    }
    if (Array.isArray(parsed.allowedSkills)) {
      agent.allowedSkills = parsed.allowedSkills;
    }
    applyOptionalAgentNumeric(
      agent,
      'browserViewportWidth',
      translateDim(parsed.browserViewportWidth),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserViewportHeight',
      translateDim(parsed.browserViewportHeight),
    );
    applyOptionalAgentNumeric(
      agent,
      'browserPageLoadTimeoutMs',
      translateDim(parsed.browserPageLoadTimeoutMs),
    );
    mkdirSync(path.join(project.ahw, 'agents', agent.id), { recursive: true });
    project.agents.push(agent);
    saveProjects();
    res.status(201).json(getEnrichedAgent(agent.id));
  });

  // Hard-delete an agent. Agents are stored in projects.json (not a DB table)
  // so there are no FK cascades from an "agents" row — we have to wipe every
  // child store keyed by agent_id explicitly. Sessions cascade their own
  // children (messages, skill invocations, background tasks, message_queue,
  // checkpoints). The on-disk workspace
  // directory at <project.ahw>/agents/<agentId>/ is also removed so a
  // re-created agent with the same id starts clean.
  router.delete('/api/agents/:agentId', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    const agentId = agent.id;

    // 1. Stop in-memory heartbeat task + drop heartbeat_state row.
    try {
      unscheduleHeartbeat(agentId);
    } catch (e) {
      console.error(`[agents] unscheduleHeartbeat(${agentId}) failed:`, e);
    }

    // 2. Atomically wipe every child row keyed by this agent.
    try {
      getDb().transaction(() => {
        // sessions cascade messages/skill_invocations/background_tasks/
        // message_queue/checkpoints via FK ON DELETE CASCADE
        stmts.deleteSessionsByAgent.run(agentId);
        stmts.deleteHeartbeatLogsByAgent.run(agentId);
        stmts.deleteSlackMessagesByAgent.run(agentId);
        stmts.deleteSessionAgentsByAgent.run(agentId);
        stmts.deleteActiveTasksByAgent.run(agentId);
        stmts.deleteAgentSkillOverridesByAgent.run(agentId);
      })();
    } catch (e) {
      console.error(`[agents] hard-delete DB cleanup failed for ${agentId}:`, e);
      return res.status(500).json({ error: 'Failed to clean up agent data' });
    }

    // 3. Remove the agent from projects.json.
    project.agents = project.agents.filter((a) => a.id !== agentId);
    saveProjects();

    // 4. Refresh the project room so the participant list drops the agent.

    // 5. Best-effort: remove the on-disk agent workspace. Failure here
    //    shouldn't block the delete — log and continue.
    try {
      const agentDir = path.join(project.ahw, 'agents', agentId);
      if (existsSync(agentDir)) {
        rmSync(agentDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[agents] failed to remove workspace for ${agentId}:`, e);
    }

    res.status(204).end();
  });

  // ─── Hooks configuration ────────────────────────────────────────────

  router.get('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    res.json({
      hooks: agent.hooks || {},
      supportedEvents: HOOK_EVENTS,
    });
  });

  router.put('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;

    const { hooks } = req.body as { hooks?: Record<string, HookConfig[]> };
    if (!hooks || typeof hooks !== 'object') {
      return res.status(400).json({ error: 'hooks object is required' });
    }

    for (const event of Object.keys(hooks)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        return res.status(400).json({ error: `Unknown hook event: ${event}` });
      }
      if (!Array.isArray(hooks[event])) {
        return res.status(400).json({ error: `hooks.${event} must be an array` });
      }
      for (const entry of hooks[event]) {
        if (typeof entry.matcher !== 'string' && entry.matcher !== undefined) {
          return res.status(400).json({ error: `hooks.${event}[].matcher must be a string` });
        }
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
          return res
            .status(400)
            .json({ error: `hooks.${event}[].hooks must be a non-empty array` });
        }
        for (const h of entry.hooks) {
          if (!h.command || typeof h.command !== 'string') {
            return res
              .status(400)
              .json({ error: `hooks.${event}[].hooks[].command must be a non-empty string` });
          }
          if (h.type && h.type !== 'command') {
            return res
              .status(400)
              .json({ error: `hooks.${event}[].hooks[].type must be "command" if specified` });
          }
        }
      }
    }

    agent.hooks = hooks;
    saveProjects();
    res.json({ hooks: agent.hooks, supportedEvents: HOOK_EVENTS });
  });

  router.delete('/api/agents/:agentId/hooks', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { agent } = found;
    delete agent.hooks;
    saveProjects();
    res.json({ hooks: {}, supportedEvents: HOOK_EVENTS });
  });

  // ─── Context endpoints ─────────────────────────────────────────────

  router.get('/api/agents/:agentId/context', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    if (!project.ahw) return res.json({});

    const paths = resolveProjectPaths(project, agent);
    const result: Record<string, string | null> = {};
    for (const filename of ALL_CONTEXT_FILES) {
      const filePath = contextFilePath(paths, filename);
      if (filePath && existsSync(filePath)) {
        try {
          result[filename] = readFileSync(filePath, 'utf-8');
        } catch {
          result[filename] = null;
        }
      }
    }
    res.json(result);
  });

  router.put('/api/agents/:agentId/context/:filename', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    const { project, agent } = found;
    if (!project.ahw) return res.status(400).json({ error: 'No workspace configured' });
    if (!ALL_CONTEXT_FILES.includes(req.params.filename as string)) {
      return res.status(400).json({ error: 'Invalid context file' });
    }

    const paths = resolveProjectPaths(project, agent);
    const filePath = contextFilePath(paths, req.params.filename as string);
    if (!filePath) return res.status(400).json({ error: 'Cannot resolve file path' });
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, (req.body as { content: string }).content, 'utf-8');
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Memory API ────────────────────────────────────────────────────

  router.get('/api/agents/:agentId/memory', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    res.json(getMemoryData(found.project.ahw));
  });

  router.put('/api/agents/:agentId/memory', (req: Request, res: Response) => {
    const found = findAgentVisible(req, res, req.params.agentId as string);
    if (!found) return;
    if (!found.project.ahw) return res.status(400).json({ error: 'No workspace configured' });

    const parsed = parseBody(UpdateAgentMemoryRequestSchema, req, res);
    if (!parsed) return;

    updateMemory(found.project.ahw, parsed.content);
    res.json({ ok: true });
  });

  return router;
}
