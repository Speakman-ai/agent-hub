/**
 * Initial-build kickoff: seeds the dev agent, creates the baseline card,
 * and dispatches a worktree session that auto-ships at session end.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { Project, RouteDeps } from '../types.js';

let kickoffInitialBuild: typeof import('./initial-build.js').kickoffInitialBuild;
let stmts: import('../types.js').Stmts;
let config: import('../types.js').AppConfig;
let getProjectDataDir: (id: string) => string;

beforeAll(async () => {
  const helpers = await import('../test/helpers.js');
  await helpers.getRequest();
  ({ kickoffInitialBuild } = await import('./initial-build.js'));
  stmts = (await import('../db.js')).stmts!;
  config = (await import('../config.js')).default;
  const pm = await import('../project-model.js');
  getProjectDataDir = pm.getProjectDataDir;
});

describe('kickoffInitialBuild', () => {
  it('seeds agent + card + dispatched session with the description as prompt', async () => {
    const helpers = await import('../test/helpers.js');
    const request = await helpers.getRequest();
    const id = `init-build-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    const { findProject, saveProjects } = await import('../project-model.js');
    const project = findProject(id) as Project;

    const handleChat = vi.fn();
    const broadcast = vi.fn();
    kickoffInitialBuild({
      project,
      description: 'a realtime scoreboard with rooms and live updates',
      force: true, // bypass the test-env guard; handleChat is mocked
      deps: {
        stmts,
        config,
        findAgent: () => null,
        saveProjects,
        broadcast,
        handleChat: handleChat as unknown as RouteDeps['handleChat'],
        getProjectDataDir,
      },
    });

    // Agent seeded onto the project roster.
    const agent = project.agents.find((a) => a.id === `${id}-dev`);
    expect(agent).toBeTruthy();
    expect(agent!.role).toBe('dev');

    // Card created in To Do, linked to the session, autonomous-dispatched.
    const { getOrCreateBoard } = await import('../routes/board.js');
    const board = getOrCreateBoard(stmts, id)!;
    const cards = stmts.getKanbanCards.all(board.board.id) as Array<{
      title: string;
      description: string;
      session_id: string | null;
      dispatched_by_autonomous: number;
    }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Build the initial version');
    expect(cards[0].description).toContain('realtime scoreboard');
    expect(cards[0].session_id).toBeTruthy();
    // NOT autonomous-dispatched: the contract pauses for human Finalize.
    expect(cards[0].dispatched_by_autonomous).toBe(0);

    // Session exists with NO auto-ship automation (pause-for-verify).
    const session = stmts.getSession.get(cards[0].session_id) as {
      agent_id: string;
      finalize_automation: string | null;
    };
    expect(session.agent_id).toBe(`${id}-dev`);
    expect(session.finalize_automation).toBe('manual'); // DB default — no auto-ship
    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { content: string; sessionId: string };
    expect(msg.content).toContain('realtime scoreboard');
    expect(msg.content).toContain('Build the initial version');
    // The four-phase contract: implement → CI → preview → pause.
    expect(msg.content).toContain('Phase 2 — CI');
    expect(msg.content).toContain('dev-server/setup-apply');
    expect(msg.content).toContain('Phase 4 — Pause for verification');
    expect(msg.content).toContain('Finalize Code Changes');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'initial_build_started', projectId: id }),
    );
  });

  it('is inert under the test-env guard without force', async () => {
    const helpers = await import('../test/helpers.js');
    const request = await helpers.getRequest();
    const id = `init-guard-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    const { findProject, saveProjects } = await import('../project-model.js');
    const project = findProject(id) as Project;
    const handleChat = vi.fn();
    kickoffInitialBuild({
      project,
      description: 'anything',
      deps: {
        stmts,
        config,
        findAgent: () => null,
        saveProjects,
        broadcast: vi.fn(),
        handleChat: handleChat as unknown as RouteDeps['handleChat'],
        getProjectDataDir,
      },
    });
    expect(handleChat).not.toHaveBeenCalled();
    expect(project.agents).toHaveLength(0);
  });
});
