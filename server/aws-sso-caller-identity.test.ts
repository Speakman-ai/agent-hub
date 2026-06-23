import './test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { resolveAwsProbeUserId, type AwsProbeContext } from './aws-sso-caller-identity.js';
import { checkAwsSsoStatusAcrossHomes } from './aws-sso-identity.js';
import type { AgentLookup, AppConfig } from './types.js';

/** Minimal Express-request stub: header map + optional auth fields. */
function makeReq(opts: {
  authUserId?: string;
  headers?: Record<string, string>;
  authSpawnSessionId?: string;
}): Request {
  const headers = opts.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    body: undefined,
    get: (name: string) => lower[name.toLowerCase()],
    authUserId: opts.authUserId,
    authSpawnSessionId: opts.authSpawnSessionId,
  } as unknown as Request;
}

interface SessionStub {
  agent_id?: string;
  owner_user_id?: string | null;
}

/**
 * Build a probe context: a session table, an agent→project map, and the
 * project the request is scoped to. `agents` maps agentId → projectId.
 */
function makeCtx(opts: {
  projectId: string;
  sessions?: Record<string, SessionStub>;
  agents?: Record<string, string>;
}): AwsProbeContext {
  const sessions = opts.sessions ?? {};
  const agents = opts.agents ?? {};
  return {
    projectId: opts.projectId,
    stmts: {
      getSession: { get: (id: string) => sessions[id] },
    } as unknown as AwsProbeContext['stmts'],
    findAgent: (agentId: string): AgentLookup | null => {
      const projectId = agents[agentId];
      if (!projectId) return null;
      return { project: { id: projectId }, agent: { id: agentId } } as unknown as AgentLookup;
    },
  };
}

describe('resolveAwsProbeUserId', () => {
  it('prefers authUserId (JWT / per-user key) and ignores any session header', () => {
    const req = makeReq({
      authUserId: 'jwt-user',
      headers: { 'X-Agent-Hub-Session-Id': 'sess-1' },
    });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-1': { agent_id: 'ag-1', owner_user_id: 'someone-else' } },
      agents: { 'ag-1': 'proj-a' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBe('jwt-user');
  });

  it('break-glass + in-project session header → attributes to the session OWNER', () => {
    // The bug: before the fix the route used `authUserId ?? null` and resolved
    // to null here, so the probe ran under the host HOME and missed the
    // per-user token the human logged in with.
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'sess-42' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-42': { agent_id: 'ag-1', owner_user_id: 'owner-abc' } },
      agents: { 'ag-1': 'proj-a' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBe('owner-abc');
  });

  it('break-glass + spawn-creds session id (no header) → session owner', () => {
    const req = makeReq({ authSpawnSessionId: 'sess-7' });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-7': { agent_id: 'ag-2', owner_user_id: 'owner-xyz' } },
      agents: { 'ag-2': 'proj-a' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBe('owner-xyz');
  });

  it('SECURITY: bound authSpawnSessionId WINS over a conflicting header session id', () => {
    // A spawn-authenticated caller (cryptographically bound session) also
    // attaches a raw X-Agent-Hub-Session-Id pointing at a DIFFERENT in-project
    // session it does not own. The bound id must win — the probe must run as
    // the bound session's owner, never the header session's owner. Both
    // sessions are in-project, so project binding alone would not catch this;
    // source precedence is what protects here.
    const req = makeReq({
      authSpawnSessionId: 'bound-sess',
      headers: { 'X-Agent-Hub-Session-Id': 'attacker-sess' },
    });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: {
        'bound-sess': { agent_id: 'ag-bound', owner_user_id: 'bound-owner' },
        'attacker-sess': { agent_id: 'ag-other', owner_user_id: 'victim-owner' },
      },
      agents: { 'ag-bound': 'proj-a', 'ag-other': 'proj-a' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBe('bound-owner');
  });

  it('SECURITY: break-glass + spoofed FOREIGN-project session id → null (host probe)', () => {
    // A break-glass caller supplies a real session id that belongs to a
    // DIFFERENT project (another user's AWS token). Project binding must reject
    // it so we never probe an unrelated user's cached SSO identity.
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'victim-sess' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'victim-sess': { agent_id: 'ag-victim', owner_user_id: 'victim-user' } },
      agents: { 'ag-victim': 'proj-OTHER' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBeNull();
  });

  it('SECURITY: break-glass + session whose agent no longer resolves → null', () => {
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'sess-orphan' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-orphan': { agent_id: 'ag-gone', owner_user_id: 'owner-abc' } },
      agents: {}, // findAgent returns null
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBeNull();
  });

  it('break-glass + session header but session not found → null (host probe)', () => {
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'ghost' } });
    const ctx = makeCtx({ projectId: 'proj-a' });
    expect(resolveAwsProbeUserId(req, ctx)).toBeNull();
  });

  it('break-glass + in-project session whose owner is null → null (host probe)', () => {
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'sess-9' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-9': { agent_id: 'ag-1', owner_user_id: null } },
      agents: { 'ag-1': 'proj-a' },
    });
    expect(resolveAwsProbeUserId(req, ctx)).toBeNull();
  });

  it('pure operator break-glass (no session context) → null', () => {
    const req = makeReq({});
    const ctx = makeCtx({ projectId: 'proj-a' });
    expect(resolveAwsProbeUserId(req, ctx)).toBeNull();
  });
});

describe('resolveAwsProbeUserId → checkAwsSsoStatusAcrossHomes (regression)', () => {
  const cfg = { dataDir: '/data' } as AppConfig;
  const PER_USER_HOME = '/data/per-user-creds/owner-abc/home';

  // Probe runner that only authenticates under the session owner's per-user
  // HOME — i.e. the human logged in via the web AWS module, token sits there.
  const runOwnerOnly = vi.fn(async (env: NodeJS.ProcessEnv) => {
    if (env.HOME === PER_USER_HOME) {
      return {
        ok: true as const,
        account: '111122223333',
        arn: 'arn:aws:iam::111122223333:user/me',
      };
    }
    return { ok: false as const, error: 'Token does not exist', needsLogin: false };
  });

  const buildEnv = (userId: string | null): NodeJS.ProcessEnv =>
    userId === 'owner-abc' ? { HOME: PER_USER_HOME } : { HOME: '/data/host-creds/home' };

  it('break-glass agent request now SEES the owner per-user token (was loggedIn:false)', async () => {
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'sess-42' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'sess-42': { agent_id: 'ag-1', owner_user_id: 'owner-abc' } },
      agents: { 'ag-1': 'proj-a' },
    });

    const userId = resolveAwsProbeUserId(req, ctx);
    expect(userId).toBe('owner-abc');

    const out = await checkAwsSsoStatusAcrossHomes(
      { userId, configPath: '/tmp/aws-config', profile: 'agenthub', run: runOwnerOnly, buildEnv },
      cfg,
    );
    expect(out.ok).toBe(true);
    expect(out.homeSource).toBe('caller');
    expect(out.account).toBe('111122223333');
  });

  it('spoofed foreign-project session → userId null → logged-out under host HOME', async () => {
    const req = makeReq({ headers: { 'X-Agent-Hub-Session-Id': 'victim-sess' } });
    const ctx = makeCtx({
      projectId: 'proj-a',
      sessions: { 'victim-sess': { agent_id: 'ag-victim', owner_user_id: 'owner-abc' } },
      agents: { 'ag-victim': 'proj-OTHER' },
    });

    const userId = resolveAwsProbeUserId(req, ctx);
    expect(userId).toBeNull();

    const out = await checkAwsSsoStatusAcrossHomes(
      { userId, configPath: '/tmp/aws-config', profile: 'agenthub', run: runOwnerOnly, buildEnv },
      cfg,
    );
    // Even though owner-abc IS logged in, the spoofed foreign-project id never
    // reaches their HOME — the probe stays on the host HOME and reports false.
    expect(out.ok).toBe(false);
    expect(out.homeSource).toBe('host');
  });
});
