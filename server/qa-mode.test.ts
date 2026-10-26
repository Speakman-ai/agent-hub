import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { agentAcceptsAutonomousTickets, isAutonomyLockedOff } from './agent-autonomy.js';
import {
  isEligibleBackgroundSessionAgent,
  pickBackgroundSessionAgent,
} from './background-agent-session.js';
import { pickAgentForCard, pickMainDevAgent } from './routing.js';
import {
  SESSION_MODES,
  isQaModeActive,
  isNonShippingSessionBehavior,
  isShippingCompatibleSessionMode,
  isSkillBuilderEligibleAgent,
  resolveCliWorkspaceAccess,
  validateQaSessionMode,
} from './session-mode.js';
import { sessionBlocksFinalize, validateSessionModeForProject } from './project-mode-guards.js';
import { requiredSkillIdsForSession } from './design-mode-prompt.js';
import { buildQaModePreamble, QA_SKILL_ID } from './qa-mode-prompt.js';
import { backfillQaAgents, QA_AGENT_BACKFILL_MARKER } from './migrations/backfill-qa-agents.js';
import type { Agent, Project } from './types.js';

const qaAgent: Agent = { id: 'p-qa', name: 'QA', engine: 'claude-code', role: 'qa', isDev: true };
const devAgent: Agent = { id: 'p-dev', name: 'Dev', engine: 'claude-code', role: 'dev' };

function project(agents: Agent[], mode?: 'workflow'): Project {
  return { id: 'p', name: 'P', cwd: '/tmp', agents, ...(mode ? { mode } : {}) } as Project;
}

describe('QA agent is out of band', () => {
  it('never accepts autonomous tickets, even with isDev set', () => {
    expect(isAutonomyLockedOff(qaAgent)).toBe(true);
    expect(agentAcceptsAutonomousTickets(qaAgent)).toBe(false);
  });

  it('autonomous dispatch never routes a card to the QA agent, even one labeled qa', () => {
    // autonomous.ts filters the roster through agentAcceptsAutonomousTickets
    // before pickAgentForCard runs.
    const assignable = [qaAgent, devAgent].filter((a) => agentAcceptsAutonomousTickets(a));
    const picked = pickAgentForCard({
      card: { labels: 'qa' },
      assignableAgents: assignable,
      lead: null,
      ctx: {
        slotsByAgentId: new Map([
          [qaAgent.id, 1],
          [devAgent.id, 1],
        ]),
      },
    });
    expect(picked?.id).toBe(devAgent.id);
  });

  it('is not eligible to host background agent sessions', () => {
    expect(isEligibleBackgroundSessionAgent(qaAgent)).toBe(false);
    expect(pickBackgroundSessionAgent(project([qaAgent, devAgent]), qaAgent.id)).toBeNull();
    expect(pickBackgroundSessionAgent(project([qaAgent, devAgent]), null)?.id).toBe(devAgent.id);
    expect(pickBackgroundSessionAgent(project([qaAgent]), null)).toBeNull();
  });

  it('is never picked as the main dev agent', () => {
    const qaOnly = { ...qaAgent, role: 'qa' };
    const other = { ...devAgent, role: 'sub' };
    expect(pickMainDevAgent(project([qaOnly, other]))?.id).toBe(other.id);
    expect(pickMainDevAgent(project([qaOnly]))).toBeNull();
  });

  it('cannot run Skill Builder mode', () => {
    expect(isSkillBuilderEligibleAgent(qaAgent)).toBe(false);
  });
});

describe('qa session mode', () => {
  const qaSession = { session_mode: 'qa' };

  it('is a known, non-shipping mode', () => {
    expect(SESSION_MODES).toContain('qa');
    expect(isQaModeActive(qaSession)).toBe(true);
    expect(isShippingCompatibleSessionMode('qa')).toBe(false);
    expect(isNonShippingSessionBehavior(qaSession)).toBe(true);
  });

  it('blocks Finalize on dev and workflow projects', () => {
    expect(sessionBlocksFinalize(project([qaAgent]), qaSession)).toBe(true);
    expect(validateSessionModeForProject(project([qaAgent], 'workflow'), 'qa')).toBeNull();
  });

  it('blocks native code edits even with a worktree', () => {
    expect(
      resolveCliWorkspaceAccess({ session: qaSession, workflowProject: false, hasWorktree: true }),
    ).toEqual({ readOnly: false, blockCodeMutationTools: true });
  });

  it('binds qa mode and the qa role to each other', () => {
    expect(validateQaSessionMode(qaAgent, 'qa')).toBeNull();
    expect(validateQaSessionMode(devAgent, 'chat')).toBeNull();
    expect(validateQaSessionMode(devAgent, 'qa')?.error).toBe('qa_mode_requires_qa_agent');
    expect(validateQaSessionMode(qaAgent, 'chat')?.error).toBe('qa_agent_requires_qa_mode');
    expect(validateQaSessionMode(qaAgent, 'consult')?.error).toBe('qa_agent_requires_qa_mode');
  });

  it('force-loads the QA skill and has a read-only preamble', () => {
    expect(requiredSkillIdsForSession(qaSession)).toEqual(['agent-hub', QA_SKILL_ID]);
    const preamble = buildQaModePreamble({ project: { id: 'p', name: 'P' } });
    expect(preamble).toContain('## QA mode');
    expect(preamble).toContain('/api/projects/p/qa/plans');
    expect(preamble).toMatch(/read-only on code/);
    expect(
      buildQaModePreamble({ project: { id: 'p', name: 'P' }, browserToolsEnabled: false }),
    ).toContain('turned **off**');
  });
});

describe('backfillQaAgents', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'qa-backfill-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds once, then respects later deletions via the marker', () => {
    const ensure = vi.fn();
    const first = backfillQaAgents({ dataDir, ensureQaAgents: ensure });
    expect(first.ran).toBe(true);
    expect(first.markerPath).toBe(path.join(dataDir, QA_AGENT_BACKFILL_MARKER));
    expect(existsSync(first.markerPath)).toBe(true);

    const second = backfillQaAgents({ dataDir, ensureQaAgents: ensure });
    expect(second.ran).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('leaves no marker when seeding throws, so the next boot retries', () => {
    expect(() =>
      backfillQaAgents({
        dataDir,
        ensureQaAgents: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow('boom');
    expect(existsSync(path.join(dataDir, QA_AGENT_BACKFILL_MARKER))).toBe(false);
  });
});
