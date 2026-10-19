import {
  registerOrganizationSpawnPolicy,
  registerOrganizationAccessRevalidator,
} from './organization-spawn-policy.js';
import { revokeApiKeysBySpawnSession } from './api-keys-store.js';
import { removeSpawnCredsFile } from './spawn-creds-file.js';
import { ensurePerUserHome } from './per-user-home.js';
import {
  organizationSessionIdentity,
  recordOrganizationSessionIdentity,
} from './organization-session-identity.js';
/** Organization CLI credentials. Opaque, short-lived and deliberately separate from user API keys.
 * Grants live only in this process: restart revokes them. Every use resolves current authority.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { findAgent, findProjectForServer } from './project-model.js';
import { getUserById } from './users-store.js';
import {
  getBusinessOrganization,
  getBusinessOrganizationRole,
  listBusinessOrganizationProjectIds,
} from './business-organizations-store.js';
import {
  resolveOrganizationCaller,
  visibleOrganizationProject,
} from './business-organizations-access.js';
import type { Project, SessionRow } from './types.js';

export const ORGANIZATION_CAPABILITY_PREFIX = 'ahorg_';
export const ORGANIZATION_CAPABILITY_TTL_MS = 15 * 60 * 1000;
export interface OrganizationCapability {
  serverId: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  expiresAt: number;
  projectIds: string[];
  tools: string[];
  fingerprint: string;
}
const grants = new Map<string, OrganizationCapability>();
const revokedSessions = new Set<string>();
const organizationSessions = new Set<string>();
const contexts = new Map<
  string,
  { serverId: string; sessionId: string; fingerprint: string; epoch: string }
>();
const sessionKey = (sessionId: string, serverId = getActiveOrgId()) =>
  JSON.stringify([serverId, sessionId]);
let onRevocation: (sessionId: string) => void = () => {};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const isOrganizationCapability = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(ORGANIZATION_CAPABILITY_PREFIX);

export function isOrganizationWorkspace(project: Project | null | undefined): boolean {
  // Any organization marker makes this a restricted workspace, even if malformed.
  return Boolean(project && (project.workspaceKind === 'organization' || project.organizationId));
}

function sessionRow(sessionId: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined;
}

export function organizationSessionWorkspace(sessionId: string): Project | null {
  const row = sessionRow(sessionId);
  const project = row ? findAgent(row.agent_id)?.project : null;
  if (isOrganizationWorkspace(project)) {
    organizationSessions.add(sessionKey(sessionId));
    if (project!.serverId && project!.organizationId && row)
      recordOrganizationSessionIdentity(sessionId, {
        server_id: project!.serverId,
        organization_id: project!.organizationId,
        workspace_id: project!.id,
        agent_id: row.agent_id,
      });
    return project!;
  }
  if (organizationSessions.has(sessionKey(sessionId)) || organizationSessionIdentity(sessionId))
    throw new Error('Organization session unavailable');
  return null;
}

function authority(sessionId: string): Omit<OrganizationCapability, 'expiresAt'> {
  const session = sessionRow(sessionId);
  const found = session && findAgent(session.agent_id);
  if (!session || !found || !isOrganizationWorkspace(found.project))
    throw new Error('Organization session unavailable');
  const { project, agent } = found;
  const serverId = getActiveOrgId();
  const organizationId = project.organizationId;
  const userId = session.owner_user_id;
  const scope = agent.organizationScope;
  const user = userId ? getUserById(userId) : null;
  if (
    project.workspaceKind !== 'organization' ||
    project.archivedAt ||
    project.serverId !== serverId ||
    !organizationId ||
    !userId ||
    !user ||
    !scope ||
    scope.enabled !== true ||
    scope.archivedAt ||
    !Array.isArray(scope.tools) ||
    !(scope.projects === 'all-linked' || Array.isArray(scope.projects)) ||
    !getBusinessOrganization(serverId, organizationId) ||
    !getBusinessOrganizationRole(serverId, organizationId, userId)
  ) {
    throw new Error('Organization session unavailable');
  }
  const caller = resolveOrganizationCaller(serverId, userId);
  if (!caller) throw new Error('Organization session unavailable');
  const linked = listBusinessOrganizationProjectIds(serverId, organizationId).sort();
  const projectIds = linked.filter(
    (id) =>
      (scope.projects === 'all-linked' || scope.projects.includes(id)) &&
      visibleOrganizationProject(caller, id),
  );
  const tools = [...new Set(scope.tools)].sort();
  // Bind all links/configuration as well as the effective ACL, so an unlink or scope
  // narrowing cannot leave an old prompt authorized even if another project survives.
  const fingerprint = digest(
    JSON.stringify({
      serverId,
      organizationId,
      userId,
      workspaceId: project.id,
      agentId: agent.id,
      linked,
      userCredentialVersion: user.credential_version,
      serverRole: caller.serverRole,
      organizationRole: getBusinessOrganizationRole(serverId, organizationId, userId),
      projectIds,
      scope,
      computer: agent.computerToolEnabled,
      browser: agent.browserToolsEnabled,
      instructions: agent.systemPrompt,
      name: agent.name,
      model: agent.model,
    }),
  );
  return {
    serverId,
    organizationId,
    userId,
    sessionId,
    workspaceId: project.id,
    agentId: agent.id,
    projectIds,
    tools,
    fingerprint,
  };
}

export function resolveOrganizationSessionAuthority(sessionId: string) {
  const current = authority(sessionId);
  if (revokedSessions.has(sessionKey(sessionId))) throw new Error('Organization context revoked');
  return current;
}

export function setOrganizationRevocationHandler(handler: (sessionId: string) => void): void {
  onRevocation = handler;
}
export function revokeOrganizationSession(sessionId: string, serverId = getActiveOrgId()): void {
  for (const [key, grant] of grants)
    if (grant.sessionId === sessionId && grant.serverId === serverId) grants.delete(key);
  const identity = sessionKey(sessionId, serverId);
  if (revokedSessions.has(identity)) return;
  revokedSessions.add(identity);
  contexts.delete(identity);
  // The next human turn must rebuild context rather than resume the CLI's cached transcript.
  try {
    if (getActiveOrgId() === serverId)
      getDb()
        .prepare(
          'UPDATE sessions SET engine_session_id = NULL, pending_skill_context = NULL WHERE id = ?',
        )
        .run(sessionId);
  } catch {
    /* Storage failures still revoke in-memory credentials and stop the process. */
  }
  try {
    onRevocation(sessionId);
  } catch {
    /* Other grants must still be revoked. */
  }
}

export function issueOrganizationCapability(sessionId: string, userId: string): string {
  const current = authority(sessionId);
  if (!userId || current.userId !== userId) throw new Error('Organization session owner required');
  if (revokedSessions.has(sessionKey(sessionId)))
    throw new Error('Organization context revoked; start a fresh user turn');
  const token = ORGANIZATION_CAPABILITY_PREFIX + randomBytes(32).toString('base64url');
  grants.set(digest(token), { ...current, expiresAt: Date.now() + ORGANIZATION_CAPABILITY_TTL_MS });
  return token;
}

function expireGrant(key: string, grant: OrganizationCapability): void {
  grants.delete(key);
  const hasCurrentCredential = [...grants.values()].some(
    (candidate) =>
      candidate.sessionId === grant.sessionId &&
      candidate.serverId === grant.serverId &&
      candidate.expiresAt > Date.now(),
  );
  if (!hasCurrentCredential) revokeOrganizationSession(grant.sessionId, grant.serverId);
}

export function verifyOrganizationCapability(token: string): OrganizationCapability | null {
  const key = digest(token);
  const grant = grants.get(key);
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) {
    expireGrant(key, grant);
    return null;
  }
  try {
    const current = authority(grant.sessionId);
    if (
      current.fingerprint === grant.fingerprint &&
      !revokedSessions.has(sessionKey(grant.sessionId, grant.serverId))
    )
      return { ...grant, projectIds: [...grant.projectIds], tools: [...grant.tools] };
  } catch {
    /* missing identity, archive, server switch, storage error: deny */
  }
  revokeOrganizationSession(grant.sessionId, grant.serverId);
  return null;
}

/** Call before enrichment and queue execution. Only explicit new user turns may clear stale context. */
export function prepareOrganizationTurn(
  sessionId: string,
  freshUserTurn: boolean,
  workspace?: Project,
): void {
  if (isOrganizationWorkspace(workspace)) organizationSessions.add(sessionKey(sessionId));
  if (!organizationSessionWorkspace(sessionId)) return;
  sweepOrganizationCapabilities();
  const current = authority(sessionId);
  const identity = sessionKey(sessionId, current.serverId);
  const hasCurrentContext = contexts.get(identity)?.fingerprint === current.fingerprint;
  if (!hasCurrentContext || revokedSessions.has(sessionKey(sessionId))) {
    if (!freshUserTurn)
      throw new Error('Organization access changed; send a new message to rebuild context');
    getDb()
      .prepare(
        'UPDATE sessions SET engine_session_id = NULL, pending_skill_context = NULL, fork_from_engine_session_id = NULL WHERE id = ?',
      )
      .run(sessionId);
    revokedSessions.delete(sessionKey(sessionId));
  }
  contexts.set(identity, {
    serverId: current.serverId,
    sessionId,
    fingerprint: current.fingerprint,
    epoch: hasCurrentContext ? contexts.get(identity)!.epoch : randomBytes(16).toString('hex'),
  });
}

/** Active grants are watched even while the process makes no API requests. */
export function sweepOrganizationCapabilities(): void {
  // Enrichment may precede token minting. Track its authority separately so a
  // background-shell credential can never certify a stale saved CLI context.
  for (const context of contexts.values()) {
    try {
      if (authority(context.sessionId).fingerprint !== context.fingerprint)
        revokeOrganizationSession(context.sessionId, context.serverId);
    } catch {
      revokeOrganizationSession(context.sessionId, context.serverId);
    }
  }
  for (const [key, grant] of grants) {
    try {
      if (authority(grant.sessionId).fingerprint !== grant.fingerprint)
        revokeOrganizationSession(grant.sessionId, grant.serverId);
      else if (grant.expiresAt <= Date.now()) expireGrant(key, grant);
    } catch {
      revokeOrganizationSession(grant.sessionId, grant.serverId);
    }
  }
}
registerOrganizationAccessRevalidator(sweepOrganizationCapabilities);
const revocationTimer = setInterval(sweepOrganizationCapabilities, 1000);
revocationTimer.unref();

export function renewOrganizationCapability(token: string): string | null {
  const grant = verifyOrganizationCapability(token);
  if (!grant) return null;
  const renewed = issueOrganizationCapability(grant.sessionId, grant.userId);
  grants.delete(digest(token));
  return renewed;
}

export function organizationCapabilityCanReadProject(
  grant: OrganizationCapability,
  projectId: string,
  permission = 'projects:read',
): boolean {
  try {
    const current = authority(grant.sessionId);
    return (
      !revokedSessions.has(sessionKey(grant.sessionId, grant.serverId)) &&
      current.fingerprint === grant.fingerprint &&
      current.projectIds.includes(projectId) &&
      current.tools.includes(permission) &&
      !isOrganizationWorkspace(findProjectForServer(grant.serverId, projectId))
    );
  } catch {
    return false;
  }
}

/** Exact method/path allowlist. New endpoints do not inherit organization CLI authority. */
export function organizationCapabilityAllows(
  grant: OrganizationCapability,
  method: string,
  pathname: string,
): boolean {
  let parts: string[];
  try {
    parts = pathname.split('/').slice(1).map(decodeURIComponent);
    if (
      parts.some(
        (part) =>
          !part || part.includes('/') || part.includes('\\') || part === '.' || part === '..',
      )
    )
      return false;
  } catch {
    return false;
  }
  if (parts[0] !== 'api') return false;
  const [, resource, id, ...tail] = parts;
  const suffix = tail.join('/');
  const read = method === 'GET' || method === 'HEAD';
  if (resource === 'sessions' && id === grant.sessionId) {
    if (suffix === 'organization-memory' && grant.tools.includes('projects:read'))
      return read || method === 'POST';
    if (method === 'POST' && suffix === 'organization-capability/renew') return true;
    // Retained transcripts can contain projects removed from the current scope.
    // Only normal user authentication may read that history; a fresh capability cannot.
    if (read && ['', 'progress'].includes(suffix)) return true;
    // Artifacts have no project provenance. Keep uploads available, but never
    // expose retained metadata or bytes to capabilities after scope changes.
    if (grant.tools.includes('artifacts') && suffix === 'artifacts' && method === 'POST')
      return true;
    if (
      grant.tools.includes('credentials') &&
      /^credential-requests\/[^/]+(?:\/consume)?$/.test(suffix)
    )
      return read || (method === 'POST' && suffix.endsWith('/consume'));
    return false;
  }
  // Management endpoints return group-wide counts and unrestricted linked-project lists.
  // Organization CLI discovery is provided by its dedicated capability context endpoint.
  if (
    resource === 'organizations' &&
    id === grant.organizationId &&
    suffix === 'capability-context'
  )
    return read;
  if (resource === 'projects' && id && method === 'POST' && suffix === 'sessions/dispatch')
    return organizationCapabilityCanReadProject(grant, id, 'dispatch');
  if (resource === 'projects' && id && organizationCapabilityCanReadProject(grant, id)) {
    return read && /^(?:board(?:\/(?:cards|epics|phases))?|wiki(?:\/[^/]+)?)$/.test(suffix);
  }
  return false;
}

/** Host actions run without HTTP, so they must independently enforce the same current scope. */
export function organizationSessionAllowsTool(sessionId: string, tool: string): boolean {
  try {
    if (!organizationSessionWorkspace(sessionId)) return true;
    sweepOrganizationCapabilities();
    if (revokedSessions.has(sessionKey(sessionId))) return false;
    const current = authority(sessionId);
    const permission: Record<string, string> = {
      wiki: 'projects:read',
      skill: 'skills',
      web: 'web',
      browser: 'browser',
      computer: 'computer',
      approval: 'approvals',
    };
    return Boolean(permission[tool] && current.tools.includes(permission[tool]));
  } catch {
    return false;
  }
}

/** Final sanitation, after other environment builders. No host/integration credentials in org CLIs. */
export function sanitizeOrganizationSpawnEnv(env: NodeJS.ProcessEnv): void {
  const token = env.AGENT_HUB_API_KEY;
  const grant = token && verifyOrganizationCapability(token);
  if (!grant || env.AGENT_HUB_SESSION_ID !== grant.sessionId)
    throw new Error('Organization spawn capability missing or revoked');
  // An allowlist also excludes secrets with innocuous names (DATABASE_URL,
  // proxy URLs, SDK credential-file pointers), which a secret-name regex misses.
  const keep = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'TMPDIR',
    'NODE_ENV',
    'NO_COLOR',
    'FORCE_COLOR',
    'PYTHON',
    'npm_config_python',
    'CODEX_HOME',
    'GEMINI_CLI_TRUST_WORKSPACE',
    'MUSE_NO_AUTO_UPDATE',
    'PROJECT_ID',
    'AGENT_HUB_API_KEY',
    'AGENT_HUB_URL',
    'AGENT_HUB_SESSION_ID',
    'AGENT_HUB_SKILLS_DIR',
    'AGENT_HUB_CREDENTIAL_SCOPE',
    'AGENT_HUB_REAL_GIT',
    'AGENT_HUB_REAL_GH',
    'AGENT_HUB_REVIEWER_LOCK',
    'AGENT_HUB_REVIEWER_ROLE_LOCK',
    'AGENT_HUB_PROTECT_SESSION_BRANCH',
    'AGENT_HUB_FINALIZE_CI_CONFIGURED',
    'AGENT_HUB_SESSION_SETUP_STATUS',
    'AGENT_HUB_SESSION_SETUP_PATH',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CURSOR_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'XAI_API_KEY',
  ]);
  for (const name of Object.keys(env)) if (!keep.has(name)) delete env[name];
  env.AGENT_HUB_CREDENTIAL_SCOPE = 'organization';
  // Provider credentials were resolved for the initiating user by buildSpawnEnv.
  // A title/template/role never changes this policy.
}

registerOrganizationSpawnPolicy({
  matches: (sessionId) => Boolean(organizationSessionWorkspace(sessionId)),
  apply: (env, sessionId, userId, cfg) => {
    if (!userId) throw new Error('Organization session owner required');
    const token = issueOrganizationCapability(sessionId, userId);
    // Never leave a legacy unrestricted per-session key available to wrapper fallback.
    revokeApiKeysBySpawnSession(sessionId);
    removeSpawnCredsFile(sessionId, cfg.dataDir);
    env.AGENT_HUB_API_KEY = token;
    env.AGENT_HUB_SESSION_ID = sessionId;
    env.HOME = ensurePerUserHome(userId, cfg.dataDir); // fail closed on isolation errors
    sanitizeOrganizationSpawnEnv(env);
  },
});

/** Bounded context only. Shared workspace memory and old transcripts may contain revoked project data. */
export function organizationSessionPrompt(sessionId: string): string {
  const current = authority(sessionId);
  if (
    revokedSessions.has(sessionKey(sessionId)) ||
    contexts.get(sessionKey(sessionId))?.fingerprint !== current.fingerprint
  )
    throw new Error('Organization context revoked');
  return `\n\nOrganization: ${current.organizationId}; Server: ${current.serverId}; session: ${current.sessionId}.
Use ah-api.sh with the injected capability. Discover authorized projects and agent IDs at GET /api/organizations/${current.organizationId}/capability-context?limit=25&offset=0.
Configured tools: ${current.tools.join(', ') || 'none'}. Project membership and tools are checked for every request.
Read linked-project wiki/board resources on demand. Dispatch requires an explicit project and agent, using POST /api/projects/<projectId>/sessions/dispatch with {"agentId":"<id>","prompt":"<task>"}; automation overrides are forbidden.
Your capability expires after 15 minutes. Before expiry, POST /api/sessions/${current.sessionId}/organization-capability/renew and replace AGENT_HUB_API_KEY with the returned token. Do not print tokens. If access is revoked, stop and request a fresh user turn.
Host actions use <agenthub:react>{"actions":[{"tool":"<configured-tool>","op":"<operation>"}]}</agenthub:react>. Only configured tools are permitted.
Save private project-derived memory with POST /api/sessions/${current.sessionId}/organization-memory using {"projectId":"<authorized project>","sourceRecord":"<source record>","content":"<brief note>"}. Read it with GET at the same path. Each read rechecks current project access. Never save project-derived information into shared organization instructions.
Use only deliberately shared organization instructions and newly authorized tool results. Historical transcripts remain available to their owner but are not automatically injected into a fresh CLI context.`;
}

/** Simulate process restart in integration tests; never callable by an agent endpoint. */
export function resetOrganizationCapabilitiesForTests(): void {
  if (!process.env.VITEST) throw new Error('Test-only capability reset');
  grants.clear();
  contexts.clear();
  revokedSessions.clear();
  organizationSessions.clear();
}

/** A new authorization context gets a new cwd even after unlink-and-relink or restart. */
export function organizationContextEpoch(sessionId: string): string {
  const current = resolveOrganizationSessionAuthority(sessionId);
  const context = contexts.get(sessionKey(sessionId));
  if (!context || context.fingerprint !== current.fingerprint)
    throw new Error('Organization context revoked');
  return context.epoch;
}
