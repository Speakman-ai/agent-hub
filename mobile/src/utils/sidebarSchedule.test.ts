import { describe, expect, it } from 'vitest';
import {
  isSidebarSessionActionable,
  projectCanFullyCollapse,
  projectHostsScheduledTasks,
} from './sidebarSchedule';

describe('projectCanFullyCollapse', () => {
  it('collapses a multi-agent project and a workflow project', () => {
    expect(projectCanFullyCollapse(2, false)).toBe(true);
    expect(projectCanFullyCollapse(1, true)).toBe(true);
  });

  it('leaves a single-agent project expanded', () => {
    expect(projectCanFullyCollapse(1, false)).toBe(false);
  });
});

describe('projectHostsScheduledTasks', () => {
  it('keeps crons on an expanded project', () => {
    expect(
      projectHostsScheduledTasks({ activeAgentCount: 2, workflow: false, collapsed: false }),
    ).toBe(true);
  });

  it('moves crons off a collapsed multi-agent project', () => {
    expect(
      projectHostsScheduledTasks({ activeAgentCount: 2, workflow: false, collapsed: true }),
    ).toBe(false);
  });

  it('keeps crons on a single-agent project even if a collapse flag is set', () => {
    expect(
      projectHostsScheduledTasks({ activeAgentCount: 1, workflow: false, collapsed: true }),
    ).toBe(true);
  });
});

describe('isSidebarSessionActionable', () => {
  const session = { id: 's1' };

  it('is actionable while running, ready for a PR, or ready to push', () => {
    expect(isSidebarSessionActionable(session, { activeTaskSessionIds: { s1: true } })).toBe(true);
    expect(isSidebarSessionActionable(session, { changesReadyBySession: { s1: {} } })).toBe(true);
    expect(
      isSidebarSessionActionable(session, { finalizeStatusBySession: { s1: 'ready_to_push' } }),
    ).toBe(true);
  });

  it('is quiet for an idle session', () => {
    expect(
      isSidebarSessionActionable(session, { finalizeStatusBySession: { s1: 'running' } }),
    ).toBe(false);
  });
});
