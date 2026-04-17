/**
 * Integration test for `handleHandoff` + `buildHandoffPromptSection`.
 *
 * Uses the real test DB (via ./setup.js) and stubs out the subprocess-
 * spawning dependency (`handleChat`) with a capture. Verifies the end-to-
 * end flow an emitted <handoff> block triggers on the server:
 *
 *   1. Pending handoff row created, with the note and from/to agent ids.
 *   2. New sessions row created for the target agent.
 *   3. Handoff row linked to the target session and flipped to 'delivered'.
 *   4. Target's enriched prompt, built via buildHandoffPromptSection,
 *      contains the HANDOFF FROM section with source transcript + note.
 *   5. The stubbed handleChat is invoked with the right shape (agentId,
 *      sessionId, content=note).
 *   6. Error path: unknown target agent → status flipped to 'failed',
 *      no target session created.
 */
import './setup.js';
import { randomUUID } from 'crypto';
import { getStmts, getDb } from '../db.js';
import {
  initHandoff,
  handleHandoff,
  buildHandoffPromptSection,
  _peekDepsForInternalUse,
} from '../handoff.js';
import type {
  HandoffRow,
  EnrichedAgent,
  Project,
  SessionRow,
  AppConfig,
  ChatMessage,
} from '../types.js';

function makeEnrichedAgent(
  id: string,
  name: string,
  overrides: Partial<EnrichedAgent> = {},
): EnrichedAgent {
  return {
    id,
    name,
    engine: 'claude-code',
    projectId: 'proj-test',
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
    ...overrides,
  } as EnrichedAgent;
}

function makeProject(id: string): Project {
  return {
    id,
    name: 'Test Project',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as unknown as Project;
}

describe('handleHandoff — end-to-end', () => {
  const testPrefix = `handoff-int-${randomUUID().slice(0, 8)}`;
  const project = makeProject('proj-test');
  const sourceAgent = makeEnrichedAgent('agent-lead', 'Lead');
  const targetAgent = makeEnrichedAgent('agent-backend', 'Backend');

  // Captured handleChat invocations for assertion.
  let handleChatCalls: ChatMessage[] = [];
  const stubHandleChat = async (_ws: unknown, msg: ChatMessage): Promise<void> => {
    handleChatCalls.push(msg);
  };

  // Lookup maps used by deps.
  const agents: Record<string, EnrichedAgent> = {
    'agent-lead': sourceAgent,
    'agent-backend': targetAgent,
  };
  const agentLookup: Record<string, { project: Project; agent: EnrichedAgent }> = {
    'agent-lead': { project, agent: sourceAgent },
    'agent-backend': { project, agent: targetAgent },
  };

  const broadcasts: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    initHandoff({
      stmts: getStmts(),
      broadcast: (data: Record<string, unknown>) => broadcasts.push(data),
      getEnrichedAgent: (id: string) => agents[id] ?? null,
      findAgent: (id: string) => agentLookup[id] ?? null,
      getActiveProcesses: () => new Map(),
      getClaudeBin: () => '/usr/bin/true',
      getDefaultModel: () => 'claude-opus-4-7',
      getConfig: () => ({ conferenceTimeoutMs: 1000 }) as AppConfig,
      getHandleChat: () => stubHandleChat,
    });
    // Sanity — deps wired.
    expect(_peekDepsForInternalUse()).not.toBeNull();
  });

  beforeEach(() => {
    handleChatCalls = [];
    broadcasts.length = 0;
  });

  afterAll(() => {
    const db = getDb();
    db.prepare('DELETE FROM handoffs WHERE from_session_id LIKE ?').run(`${testPrefix}%`);
    db.prepare('DELETE FROM messages WHERE session_id LIKE ?').run(`${testPrefix}%`);
    db.prepare('DELETE FROM sessions WHERE id LIKE ?').run(`${testPrefix}%`);
  });

  it('creates pending→delivered handoff row, spawns target session, and invokes handleChat with the note', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-happy`;

    // Seed source session + a tiny transcript so the prompt builder has
    // something to inject on the target side.
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
    );
    stmts.addMessage.run(
      randomUUID(),
      srcSessionId,
      'user',
      'Please plan the webhook fix.',
      null,
      null,
      null,
      null,
    );
    stmts.addMessage.run(
      randomUUID(),
      srcSessionId,
      'assistant',
      'Line 234 needs fast-ack before the SQLite write.',
      'claude-code',
      'claude-opus-4-7',
      null,
      null,
    );

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-1',
      { toAgent: 'agent-backend', note: 'Implement the fast-ack fix.' },
      sourceAgent,
      project,
    );

    expect(result).not.toBeNull();
    const { handoffId, toSessionId, toAgentId, toAgentName } = result!;
    expect(toAgentId).toBe('agent-backend');
    expect(toAgentName).toBe('Backend');

    // Handoff row: delivered, linked, note preserved.
    const row = stmts.getHandoffById.get(handoffId) as HandoffRow;
    expect(row.status).toBe('delivered');
    expect(row.to_session_id).toBe(toSessionId);
    expect(row.from_session_id).toBe(srcSessionId);
    expect(row.note).toBe('Implement the fast-ack fix.');
    expect(row.delivered_at).not.toBeNull();
    expect(row.error).toBeNull();

    // Target session exists with correct agent_id.
    const targetSession = stmts.getSession.get(toSessionId) as SessionRow;
    expect(targetSession).toBeDefined();
    expect(targetSession.agent_id).toBe('agent-backend');

    // handleChat got invoked with the right shape (fire-and-forget, so
    // flush microtasks before asserting).
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleChatCalls).toHaveLength(1);
    expect(handleChatCalls[0].agentId).toBe('agent-backend');
    expect(handleChatCalls[0].sessionId).toBe(toSessionId);
    expect(handleChatCalls[0].content).toBe('Implement the fast-ack fix.');

    // A handoff_start event was broadcast.
    const starts = broadcasts.filter((b) => b.type === 'handoff_start');
    expect(starts).toHaveLength(1);
    expect(starts[0].toAgentId).toBe('agent-backend');
    expect(starts[0].fromAgentName).toBe('Lead');

    // Prompt builder pulls the transcript and note for the target session.
    const section = buildHandoffPromptSection(toSessionId, {
      stmts,
      getEnrichedAgent: (id: string) => agents[id] ?? null,
    });
    expect(section).toContain('## HANDOFF FROM Lead');
    expect(section).toContain('> Implement the fast-ack fix.');
    expect(section).toContain('Please plan the webhook fix.');
    expect(section).toContain('Line 234 needs fast-ack before the SQLite write.');
    expect(section).toContain('Previous session transcript (2 turns)');
  });

  it('marks the handoff failed and does not create a target session when the target agent is unknown', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-unknown`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
    );

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-2',
      { toAgent: 'agent-ghost', note: 'hi' },
      sourceAgent,
      project,
    );

    expect(result).toBeNull();

    const rows = stmts.getHandoffsFromSession.all(srcSessionId) as HandoffRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('Unknown target agent');
    expect(rows[0].to_session_id).toBeNull();

    // handleChat must NOT be called when handoff fails.
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleChatCalls).toHaveLength(0);

    // A handoff_error broadcast was emitted.
    const errors = broadcasts.filter((b) => b.type === 'handoff_error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(String(errors[0].error)).toContain('Unknown target agent');
  });

  it('buildHandoffPromptSection returns empty string when the session has no incoming handoff', () => {
    const section = buildHandoffPromptSection('some-random-session-id-no-handoff', {
      stmts: getStmts(),
      getEnrichedAgent: (id: string) => agents[id] ?? null,
    });
    expect(section).toBe('');
  });

  it('fuzzy-resolves an "agent-hub-backend"-style target to the real agent id and delivers', async () => {
    // Regression: previously the lead agent's AGENTS.md uses
    // `agent-hub-backend` as a label, while the canonical id is
    // `hub-backend`. That mismatch quietly stranded every handoff until
    // resolveTargetAgentId was introduced.
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-fuzzy`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
    );

    // Simulate the source project exposing both agents so the resolver
    // has a universe to search across. The requested id
    // "agent-hub-backend" progressively strips the "agent-" / "hub-"
    // prefix to land on the canonical id "agent-backend" via a unique
    // "-backend" suffix match.
    const projectWithAgents = {
      ...project,
      agents: [
        { id: 'agent-lead', name: 'Lead' },
        { id: 'agent-backend', name: 'Backend' },
      ],
    } as unknown as Project;

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-fuzzy',
      { toAgent: 'agent-hub-backend', note: 'please ship' },
      sourceAgent,
      projectWithAgents,
    );

    expect(result).not.toBeNull();
    expect(result!.toAgentId).toBe('agent-backend');
    const row = stmts.getHandoffById.get(result!.handoffId) as HandoffRow;
    // Persisted id is the *resolved* one, so UI correlation works.
    expect(row.to_agent_id).toBe('agent-backend');
    expect(row.status).toBe('delivered');
  });

  it('buildHandoffPromptSection returns empty for a pending (not yet delivered) handoff', () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-pending`;
    const toSessionId = `${testPrefix}-dst-pending`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
    );
    stmts.createSession.run(
      toSessionId,
      'agent-backend',
      'dst',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
    );
    const handoffId = randomUUID();
    stmts.createHandoff.run(
      handoffId,
      srcSessionId,
      'agent-lead',
      'agent-backend',
      'proj-test',
      'still pending',
    );
    stmts.setHandoffToSession.run(toSessionId, handoffId);
    // status stays 'pending'

    const section = buildHandoffPromptSection(toSessionId, {
      stmts,
      getEnrichedAgent: (id: string) => agents[id] ?? null,
    });
    expect(section).toBe('');
  });
});
