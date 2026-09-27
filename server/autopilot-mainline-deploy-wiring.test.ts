import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts } from './db.js';
import type { Project } from './types.js';
import { mainlineSessionOwnsEnvironment } from './autopilot-mainline-deploy-wiring.js';
import { setMainlineSlotLandedListener, transitionMainlineSlot } from './session-autopilot-slot.js';
import type { AutopilotSessionConfig } from '../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot, type MainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';

const SHA = 'b'.repeat(40);

function config(
  slot: MainlineSlot,
  status: AutopilotSessionConfig['status'],
): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'b',
    goal: 'g',
    escalation: 'medium',
    branch: 'main',
    startedAt: '2026-09-27T10:00:00.000Z',
    deadlineAt: null,
    status,
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: { deployEnvironment: 'prod', landedCount: 0, slot },
  };
}

let seq = 0;
function seed(cfg: AutopilotSessionConfig, agentId: string): string {
  const stmts = getStmts();
  const id = `ml-wiring-${++seq}-${Date.now()}`;
  stmts.createSession.run(id, agentId, 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', id);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  return id;
}

afterEach(() => {
  getDb().prepare(`DELETE FROM sessions WHERE id LIKE 'ml-wiring-%'`).run();
  setMainlineSlotLandedListener(null);
});

describe('mainlineSessionOwnsEnvironment (push/merge trigger skip)', () => {
  const findAgent = (agentId: string) =>
    agentId === 'agent-owns' ? { project: { id: 'proj-owns' } as Project } : null;

  it('skips an environment a live mainline session owns, and nothing else', () => {
    seed(config(idleMainlineSlot(), 'running'), 'agent-owns');
    expect(mainlineSessionOwnsEnvironment(findAgent, 'proj-owns', 'prod')).toBe(true);
    expect(mainlineSessionOwnsEnvironment(findAgent, 'proj-owns', 'staging')).toBe(false);
    expect(mainlineSessionOwnsEnvironment(findAgent, 'proj-other', 'prod')).toBe(false);
  });

  it('still skips while a stopped session owes a landing', () => {
    seed(
      config(
        {
          ...idleMainlineSlot(),
          phase: 'deploying',
          attemptId: 'a1',
          sha: SHA,
          deploymentId: 'd1',
        },
        'expired',
      ),
      'agent-owns',
    );
    expect(mainlineSessionOwnsEnvironment(findAgent, 'proj-owns', 'prod')).toBe(true);
  });
});

describe('landed listener', () => {
  it('fires when a push lands, so the watcher starts the deploy without waiting for a sweep', () => {
    const listener = vi.fn();
    setMainlineSlotLandedListener(listener);
    const id = seed(
      config({ ...idleMainlineSlot(), phase: 'pushing', attemptId: 'a1', sha: SHA }, 'running'),
      'agent-owns',
    );
    const write = transitionMainlineSlot({
      stmts: getStmts(),
      sessionId: id,
      expect: { phase: 'pushing', attemptId: 'a1' },
      event: { type: 'push_landed' },
    });
    expect(write.wrote).toBe(true);
    expect(listener).toHaveBeenCalledWith(id);
  });
});
