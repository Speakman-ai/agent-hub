/**
 * A forward card an epic manager posts starts that card's worker, through the
 * same dispatch path a press or Auto start uses. The card id comes from the
 * manager's own message, never from the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getStmts } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import type { Project, SessionRow } from './types.js';
import { sessionForwardDispatchKey } from '../shared/utils/sessionForwardDispatchKey.js';
import { extractForwardBlocks } from '../shared/utils/extractForwardBlocks.js';

const mocks = vi.hoisted(() => ({ background: vi.fn() }));
vi.mock('./background-agent-session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./background-agent-session.js')>();
  return { ...real, dispatchBackgroundAgentSession: mocks.background };
});

const { dispatchProjectSession } = await import('./routes/session-dispatch.js');
const { setEpicWorkerStarter, resolveEpicForwardTarget } =
  await import('./epic-worker-dispatch.js');

const OWNER = 'owner-1';
const project = {
  id: 'shop',
  name: 'Shop',
  agents: [{ id: 'dev-1', name: 'Dev', role: 'dev', engine: 'claude-code' }],
} as unknown as Project;

function forwardBlock(fields: Record<string, string>): string {
  return ['Starting the ready card.', '```agenthub:forward', JSON.stringify(fields), '```'].join(
    '\n',
  );
}

function seed(opts: { managed?: boolean; cardId?: 'own' | 'foreign' | 'none' } = {}) {
  const stmts = getStmts();
  const db = getDb();
  const projectId = `p-${uuidv4()}`;
  const { board } = getOrCreateBoard(stmts, projectId);
  const todo = (stmts.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>).find(
    (c) => c.name === 'To Do',
  )!;
  const epicId = uuidv4();
  stmts.createKanbanEpic.run(epicId, board.id, 'Checkout', null, '#123456', 0, null);
  const card = (epic: string | null) => {
    const id = uuidv4();
    stmts.createKanbanCard.run(
      id,
      todo.id,
      board.id,
      'Pay',
      null,
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );
    db.prepare('UPDATE kanban_cards SET epic_id = ? WHERE id = ?').run(epic, id);
    return id;
  };
  const ownCard = card(epicId);
  const foreignCard = card(null);
  const managerId = uuidv4();
  stmts.createSession.run(managerId, 'dev-1', 'Epic: Checkout', 'claude-code', 'm', 0, 0, 1);
  stmts.updateSessionMode.run('orchestrate', managerId);
  db.prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(OWNER, managerId);
  if (opts.managed !== false) stmts.setEpicManagerSession.run(managerId, epicId);
  const which = opts.cardId ?? 'own';
  const fields: Record<string, string> = {
    projectId: 'shop',
    agentId: 'dev-1',
    name: 'Pay',
    prompt: 'Build the payment form.',
    mode: 'merge',
  };
  if (which === 'own') fields.cardId = ownCard;
  if (which === 'foreign') fields.cardId = foreignCard;
  const messageId = uuidv4();
  const content = forwardBlock(fields);
  stmts.addMessage.run(
    messageId,
    managerId,
    'assistant',
    content,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );
  const forward = extractForwardBlocks(content).forwards[0];
  const key = sessionForwardDispatchKey({
    sessionId: managerId,
    messageId,
    forwardId: forward.forwardId,
    occurrence: 0,
  })!;
  const manager = stmts.getSession.get(managerId) as SessionRow;
  return { stmts, manager, key, ownCard, epicId };
}

const starter = vi.fn();

beforeEach(() => {
  starter.mockReset();
  mocks.background.mockReset();
  setEpicWorkerStarter(starter);
});

describe('epic manager forward → worker', () => {
  it('extracts cardId from a forward block', () => {
    const block = forwardBlock({ projectId: 'p', agentId: 'a', prompt: 'x', cardId: 'card-9' });
    expect(extractForwardBlocks(block).forwards[0].cardId).toBe('card-9');
    const bad = forwardBlock({ projectId: 'p', agentId: 'a', prompt: 'x', cardId: 'no spaces!' });
    expect(extractForwardBlocks(bad).forwards[0].cardId).toBeUndefined();
  });

  it('starts the card the manager named, parented to the manager, once per key', () => {
    const { stmts, manager, key, ownCard } = seed();
    starter.mockReturnValue({
      status: 'started',
      sessionId: 'worker-1',
      agentId: 'dev-1',
      name: 'Pay',
      mode: 'merge',
      turn: Promise.resolve(),
    });
    const body = { prompt: 'Build the payment form.', agentId: 'dev-1', idempotencyKey: key };
    const first = dispatchProjectSession(
      { stmts },
      { project, body, ownerUserId: OWNER, callingSession: manager },
    );

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ sessionId: 'worker-1', mode: 'merge' });
    expect(starter).toHaveBeenCalledWith({
      projectId: 'shop',
      cardId: ownCard,
      agentId: 'dev-1',
      prompt: 'Build the payment form.',
      ownerUserId: OWNER,
      parentSessionId: manager.id,
    });
    expect(mocks.background).not.toHaveBeenCalled();

    // A press racing the countdown gets the same worker, not a second one.
    const again = dispatchProjectSession(
      { stmts },
      { project, body, ownerUserId: OWNER, callingSession: manager },
    );
    expect(again.status).toBe(200);
    expect(again.body.sessionId).toBe('worker-1');
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('a refused start answers 409 and frees the key for a later retry', () => {
    const { stmts, manager, key } = seed();
    starter.mockReturnValueOnce({ status: 'refused', code: 'cap', error: 'at cap' });
    const body = { prompt: 'Build the payment form.', agentId: 'dev-1', idempotencyKey: key };
    const refused = dispatchProjectSession(
      { stmts },
      { project, body, ownerUserId: OWNER, callingSession: manager },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('epic_card_cap');
    expect(stmts.getSessionDispatchKey.get(OWNER, key)).toBeUndefined();
  });

  it('refuses a manager forward whose cardId is not on its epic, without a generic dispatch', () => {
    const { stmts, manager, key } = seed({ cardId: 'foreign' });
    expect(resolveEpicForwardTarget(stmts, manager, key).kind).toBe('invalid');
    const result = dispatchProjectSession(
      { stmts },
      {
        project,
        body: { prompt: 'Build the payment form.', agentId: 'dev-1', idempotencyKey: key },
        ownerUserId: OWNER,
        callingSession: manager,
      },
    );
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('epic_forward_invalid');
    expect(mocks.background).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
    expect(stmts.getSessionDispatchKey.get(OWNER, key)).toBeUndefined();
  });

  it('refuses a manager forward that names no card', () => {
    const { stmts, manager, key } = seed({ cardId: 'none' });
    const result = dispatchProjectSession(
      { stmts },
      {
        project,
        body: { prompt: 'Build the payment form.', agentId: 'dev-1', idempotencyKey: key },
        ownerUserId: OWNER,
        callingSession: manager,
      },
    );
    expect(result).toMatchObject({ status: 409, body: { code: 'epic_forward_invalid' } });
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it('refuses a plain dispatch from an epic manager (no forward key)', () => {
    const { stmts, manager } = seed();
    const result = dispatchProjectSession(
      { stmts },
      {
        project,
        body: { prompt: 'Do something else.', agentId: 'dev-1' },
        ownerUserId: OWNER,
        callingSession: manager,
      },
    );
    expect(result).toMatchObject({ status: 409, body: { code: 'epic_forward_invalid' } });
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it('is an ordinary Orchestrate forward when the chat manages no epic', () => {
    const { stmts, manager, key } = seed({ managed: false });
    expect(resolveEpicForwardTarget(stmts, manager, key).kind).toBe('none');
    mocks.background.mockReturnValue({
      sessionId: 'plain',
      agentId: 'dev-1',
      mode: 'merge',
      skippedSkills: [],
    });
    const result = dispatchProjectSession(
      { stmts },
      {
        project,
        body: { prompt: 'Build the payment form.', agentId: 'dev-1', idempotencyKey: key },
        ownerUserId: OWNER,
        callingSession: manager,
      },
    );
    expect(result.status).toBe(201);
    expect(starter).not.toHaveBeenCalled();
  });
});
