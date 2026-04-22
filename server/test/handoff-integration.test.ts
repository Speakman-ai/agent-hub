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
  buildHandoffSeedingContent,
  recordMalformedHandoff,
  detectHandoffBlock,
  _peekDepsForInternalUse,
} from '../handoff.js';
import type {
  HandoffRow,
  EnrichedAgent,
  KanbanCardRow,
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
    db.prepare('DELETE FROM kanban_cards WHERE id LIKE ?').run(`${testPrefix}%`);
    db.prepare('DELETE FROM kanban_columns WHERE id LIKE ?').run(`${testPrefix}%`);
    db.prepare('DELETE FROM kanban_epics WHERE id LIKE ?').run(`${testPrefix}%`);
    db.prepare('DELETE FROM kanban_boards WHERE id LIKE ?').run(`${testPrefix}%`);
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
      1,
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

    // Target session is announced for sidebar live-sync (same payload shape as
    // kanban assign + POST /api/agents/:id/sessions).
    const created = broadcasts.filter((b) => b.type === 'session_created');
    expect(created).toHaveLength(1);
    expect(created[0].agentId).toBe('agent-backend');
    expect((created[0].session as SessionRow).id).toBe(toSessionId);

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

  it('copies task_state_json from the source session onto the handoff target', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-taskjson`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
    );
    const taskJson = JSON.stringify({
      goal: 'Handoff carry',
      checklist: [{ text: 'Verify copy', done: true }],
    });
    stmts.updateSessionTaskState.run(taskJson, srcSessionId);

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-taskjson',
      { toAgent: 'agent-backend', note: 'Continue with the plan.' },
      sourceAgent,
      project,
    );

    expect(result).not.toBeNull();
    const target = stmts.getSession.get(result!.toSessionId) as SessionRow;
    expect(target.task_state_json).toBe(taskJson);
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
      1,
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
      1,
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

  it('recordMalformedHandoff persists a failed row + broadcasts handoff_error for malformed blocks', () => {
    // Regression for the "handoffs intermittent — widget missing when they
    // fail" bug. A <handoff> block with malformed JSON used to silently
    // drop: no DB row, no broadcast, no UI feedback. Now we expect:
    //   1. A handoffs row exists with status='failed' + explanatory error.
    //   2. A handoff_error broadcast carrying handoffId + reason so the
    //      client can mark/synthesize the widget in failed state.
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-malformed`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
    );

    const raw = '{"toAgent":"hub-backend","note":"oops" INVALID}';
    const detection = detectHandoffBlock(`<handoff>${raw}</handoff>`);
    expect(detection.present).toBe(true);
    expect(detection.reason).toBe('invalid-json');

    const { handoffId, reason } = recordMalformedHandoff({
      stmts,
      broadcast: (data) => broadcasts.push(data),
      sessionId: srcSessionId,
      fromAgentId: 'agent-lead',
      fromAgentName: 'Lead',
      projectId: 'proj-test',
      detection,
    });

    const row = stmts.getHandoffById.get(handoffId) as HandoffRow;
    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
    expect(row.to_agent_id).toBe('(unknown)');
    expect(row.error).toBe(reason);
    expect(row.note).toContain('INVALID'); // raw body was preserved for context

    const errorEvent = broadcasts.find(
      (b) => b.type === 'handoff_error' && b.handoffId === handoffId,
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error).toMatch(/invalid json/i);
    expect(errorEvent!.reason).toBe('invalid-json');
    expect(errorEvent!.fromAgentId).toBe('agent-lead');
    expect(errorEvent!.fromAgentName).toBe('Lead');
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
      1,
    );
    stmts.createSession.run(
      toSessionId,
      'agent-backend',
      'dst',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
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

  // ─── Board/epic/autonomous forwarding ──────────────────────────────────
  //
  // Regression for the bug report "When handoffs happen we need to forward
  // board info". Previously:
  //   - A kanban card owned by the source session kept its `session_id`
  //     pointing at the (now-dead) source, so:
  //       - `<agenthub:close-card>` failed (no card found for target session)
  //       - auto-PR creation couldn't find the card → PR was unlinked
  //       - sidebar rename on target broke (no linked card)
  //   - The autonomous dispatcher saw a dead `session_id` on the card and
  //     could re-dispatch the same card to another agent while the handoff
  //     target was mid-work.
  //
  // `handleHandoff` now re-points card.session_id → toSessionId, updates
  // the assignee, and returns `forwardedCardId` + `autonomousForwarded` so
  // callers/UI/tests can assert the chain.

  function seedBoardWithCard(opts: {
    prefix: string;
    srcSessionId: string;
    autonomous?: boolean;
    cardTitle?: string;
  }): { boardId: string; cardId: string; columnId: string; epicId: string | null } {
    const stmts = getStmts();
    const boardId = `${opts.prefix}-board`;
    const columnId = `${opts.prefix}-col`;
    const cardId = `${opts.prefix}-card`;
    const epicId = opts.autonomous ? `${opts.prefix}-epic` : null;

    stmts.createKanbanBoard.run(boardId, 'proj-test', 'Test Board');
    stmts.createKanbanColumn.run(columnId, boardId, 'In Progress', 2, null);
    if (epicId) {
      stmts.createKanbanEpic.run(epicId, boardId, 'Auto Epic', null, '#fff', 0);
      // Flip autonomous on
      stmts.updateKanbanEpic.run('Auto Epic', null, '#fff', 1, 60, 5, 3, null, null, epicId);
    }
    stmts.createKanbanCard.run(
      cardId,
      columnId,
      boardId,
      opts.cardTitle ?? 'Forward me',
      'desc',
      'medium',
      'Lead',
      null,
      opts.srcSessionId,
      null,
      'system',
      null,
      0,
    );
    if (epicId) {
      stmts.updateKanbanCardEpic.run(epicId, cardId);
    }
    return { boardId, cardId, columnId, epicId };
  }

  it('forwards kanban card link: re-points session_id + assignee to target, broadcasts kanban_update', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-card`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
    );
    const { cardId } = seedBoardWithCard({
      prefix: `${testPrefix}-fwd`,
      srcSessionId,
      cardTitle: 'Ship the handoff fix',
    });

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-card',
      { toAgent: 'agent-backend', note: 'Please implement.' },
      sourceAgent,
      project,
    );
    expect(result).not.toBeNull();
    expect(result!.forwardedCardId).toBe(cardId);
    expect(result!.autonomousForwarded).toBe(false);

    // Card row was re-pointed.
    const updated = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(updated.session_id).toBe(result!.toSessionId);
    expect(updated.assignee).toBe('Backend');
    // Unchanged fields stayed intact.
    expect(updated.title).toBe('Ship the handoff fix');
    expect(updated.priority).toBe('medium');

    // getKanbanCardBySession now resolves the card via the TARGET session id
    // (this is what <agenthub:close-card> and auto-git use).
    const bySession = stmts.getKanbanCardBySession.get(result!.toSessionId) as
      | KanbanCardRow
      | undefined;
    expect(bySession?.id).toBe(cardId);
    // And no longer resolves via the source id.
    expect(stmts.getKanbanCardBySession.get(srcSessionId)).toBeUndefined();

    // Broadcasts: kanban_update + handoff_start both carry forwarding info.
    const kanban = broadcasts.find(
      (b) => b.type === 'kanban_update' && b.reason === 'handoff_forward',
    );
    expect(kanban).toBeDefined();
    expect(kanban!.cardId).toBe(cardId);
    expect(kanban!.fromSessionId).toBe(srcSessionId);
    expect(kanban!.toSessionId).toBe(result!.toSessionId);

    const start = broadcasts.find((b) => b.type === 'handoff_start');
    expect(start!.cardId).toBe(cardId);
    expect(start!.cardTitle).toBe('Ship the handoff fix');
    expect(start!.epicAutonomous).toBe(false);
  });

  it('forwards autonomous-epic flag when the card belongs to an autonomous epic', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-auto`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
    );
    const { cardId, epicId } = seedBoardWithCard({
      prefix: `${testPrefix}-auto`,
      srcSessionId,
      autonomous: true,
    });

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-auto',
      { toAgent: 'agent-backend', note: 'take over, please' },
      sourceAgent,
      project,
    );
    expect(result).not.toBeNull();
    expect(result!.forwardedCardId).toBe(cardId);
    expect(result!.autonomousForwarded).toBe(true);

    const start = broadcasts.find((b) => b.type === 'handoff_start');
    expect(start!.epicId).toBe(epicId);
    expect(start!.epicAutonomous).toBe(true);

    // The seeding content passed to handleChat includes the forwarded
    // context block so the target agent knows which card it owns and that
    // autonomous-mode is active (commit+push, no PR-review pause).
    await new Promise((resolve) => setImmediate(resolve));
    const call = handleChatCalls[handleChatCalls.length - 1];
    expect(call.content).toContain('## Forwarded Context');
    expect(call.content).toContain('Kanban card:');
    expect(call.content).toContain(cardId);
    expect(call.content).toContain('autonomous');
    expect(call.content).toContain('take over, please');
  });

  it('leaves the seeding note untouched when the source session has no linked card', async () => {
    const stmts = getStmts();
    const srcSessionId = `${testPrefix}-src-noCard`;
    stmts.createSession.run(
      srcSessionId,
      'agent-lead',
      'src',
      'claude-code',
      'claude-opus-4-7',
      0,
      0,
      1,
    );

    const result = await handleHandoff(
      srcSessionId,
      'parent-msg-noCard',
      { toAgent: 'agent-backend', note: 'plain handoff note' },
      sourceAgent,
      project,
    );
    expect(result).not.toBeNull();
    expect(result!.forwardedCardId).toBeNull();
    expect(result!.autonomousForwarded).toBe(false);

    await new Promise((resolve) => setImmediate(resolve));
    const call = handleChatCalls[handleChatCalls.length - 1];
    // No forwarded-context header — the target sees just the note.
    expect(call.content).toBe('plain handoff note');
  });
});

// ─── Pure function tests ────────────────────────────────────────────────

describe('buildHandoffSeedingContent', () => {
  const baseCard = {
    id: 'card-1',
    column_id: 'col-1',
    board_id: 'board-1',
    title: 'Fix the bug',
    description: null,
    priority: 'medium',
    assignee: 'Lead',
    labels: null,
    session_id: 'target-session',
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    position: 0,
    epic_id: null,
    documented: 0,
    autonomous_iterations: 0,
    dispatched_by_autonomous: 0,
    created_at: '',
    updated_at: '',
  } as unknown as import('../types.js').KanbanCardRow;

  it('returns the note unchanged when no card is forwarded', () => {
    const out = buildHandoffSeedingContent('do the thing', null, null);
    expect(out).toBe('do the thing');
  });

  it('prepends a Forwarded Context block naming the card', () => {
    const out = buildHandoffSeedingContent('do the thing', baseCard, null);
    expect(out).toContain('## Forwarded Context');
    expect(out).toContain('card-1');
    expect(out).toContain('Fix the bug');
    expect(out.endsWith('do the thing')).toBe(true);
  });

  it('mentions manual mode when the epic is not autonomous', () => {
    const epic = {
      id: 'e',
      board_id: 'b',
      name: 'Manual Epic',
      description: null,
      color: '#fff',
      autonomous: 0,
      autonomous_interval: 0,
      autonomous_max_concurrent: 0,
      autonomous_max_iterations: 0,
      position: 0,
      created_at: '',
      updated_at: '',
    } as import('../types.js').KanbanEpicRow;
    const out = buildHandoffSeedingContent('n', baseCard, epic);
    expect(out).toContain('Manual Epic');
    expect(out).toContain('manual mode');
    expect(out).not.toContain('Autonomous mode is active');
  });

  it('flags autonomous mode + PR-workflow guidance when the epic is autonomous', () => {
    const epic = {
      id: 'e',
      board_id: 'b',
      name: 'Auto Epic',
      description: null,
      color: '#fff',
      autonomous: 1,
      autonomous_interval: 60,
      autonomous_max_concurrent: 5,
      autonomous_max_iterations: 3,
      position: 0,
      created_at: '',
      updated_at: '',
    } as import('../types.js').KanbanEpicRow;
    const out = buildHandoffSeedingContent('n', baseCard, epic);
    expect(out).toContain('Auto Epic');
    expect(out).toContain('autonomous mode');
    expect(out).toContain('Autonomous mode is active');
    expect(out).toMatch(/commit \+ push/);
  });
});
