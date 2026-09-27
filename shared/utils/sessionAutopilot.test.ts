import { describe, it, expect } from 'vitest';
import {
  validateAutopilotSetupInput,
  parseAutopilotSessionConfig,
  needsAutopilotSetup,
  isReservedAutopilotBranch,
  deadlineAtFromDuration,
  autopilotDeadlineReached,
  buildAutopilotKickoffMessage,
  buildAutopilotVerifyContinueMessage,
  buildAutopilotUnstickContinueMessage,
  formatAutopilotPrCommittedLabel,
  autopilotEscalationInstruction,
  autopilotStopNoticeContent,
  serializeAutopilotSessionConfig,
  autopilotShipCounter,
  formatAutopilotMainlinePushLabel,
  autopilotStartRequestBody,
} from './sessionAutopilot';

const valid = {
  durationHours: 4,
  brief: 'Harden the 3D print UI',
  goal: 'Baseline journeys pass on preview',
  escalation: 'medium' as const,
  branch: 'autopilot/print-ui',
};

describe('validateAutopilotSetupInput', () => {
  it('accepts a complete setup', () => {
    const result = validateAutopilotSetupInput(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.branch).toBe('autopilot/print-ui');
  });

  it('accepts duration 0 as no limit', () => {
    const result = validateAutopilotSetupInput({ ...valid, durationHours: 0 });
    expect(result.ok).toBe(true);
  });

  it('rejects duration outside 0–72', () => {
    expect(validateAutopilotSetupInput({ ...valid, durationHours: 73 }).ok).toBe(false);
    expect(validateAutopilotSetupInput({ ...valid, durationHours: -1 }).ok).toBe(false);
    expect(validateAutopilotSetupInput({ ...valid, durationHours: 1.5 }).ok).toBe(false);
  });

  it('rejects main/master and the repo default branch', () => {
    expect(validateAutopilotSetupInput({ ...valid, branch: 'main' }).ok).toBe(false);
    expect(validateAutopilotSetupInput({ ...valid, branch: 'master' }).ok).toBe(false);
    expect(
      validateAutopilotSetupInput({ ...valid, branch: 'trunk' }, { defaultBranch: 'trunk' }).ok,
    ).toBe(false);
  });

  it('rejects empty brief, goal, and branch', () => {
    const result = validateAutopilotSetupInput({
      durationHours: 1,
      brief: '  ',
      goal: '',
      escalation: 'none',
      branch: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual(['branch', 'brief', 'goal']);
    }
  });

  it('strips refs/heads/ from the branch name', () => {
    const result = validateAutopilotSetupInput({ ...valid, branch: 'refs/heads/autopilot/x' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.branch).toBe('autopilot/x');
  });
});

describe('isReservedAutopilotBranch', () => {
  it('treats production aliases as reserved', () => {
    expect(isReservedAutopilotBranch('prod')).toBe(true);
    expect(isReservedAutopilotBranch('autopilot/ok')).toBe(false);
  });
});

describe('parseAutopilotSessionConfig / needsAutopilotSetup', () => {
  it('reads a config stored before targets existed as branch-target', () => {
    const legacy = JSON.stringify({
      ...valid,
      startedAt: '2026-09-17T12:00:00.000Z',
      deadlineAt: null,
      status: 'running',
      cycle: 3,
      lastPushSha: 'abc1234',
    });
    const cfg = parseAutopilotSessionConfig(legacy)!;
    expect(cfg.target).toBe('branch');
    expect(cfg.mainline).toBeNull();
    const again = parseAutopilotSessionConfig(serializeAutopilotSessionConfig(cfg));
    expect(again).toEqual(cfg);
  });

  it('ignores a stray mainline block on a branch-target config', () => {
    const cfg = parseAutopilotSessionConfig({
      ...valid,
      target: 'branch',
      mainline: { deployEnvironment: 'prod' },
    })!;
    expect(cfg.mainline).toBeNull();
    expect(JSON.parse(serializeAutopilotSessionConfig(cfg)).mainline).toBeUndefined();
  });

  it('round-trips a mainline config with its slot', () => {
    const slot = {
      phase: 'deploying',
      attemptId: 'att-1',
      sha: 'b'.repeat(40),
      deploymentId: 'dep-1',
      outcome: null,
      escalatedAt: null,
      enteredAt: '2026-09-27T12:00:00.000Z',
    };
    const cfg = parseAutopilotSessionConfig({
      ...valid,
      status: 'running',
      target: 'mainline',
      mainline: { deployEnvironment: 'prod', landedCount: 4, slot },
    })!;
    expect(cfg.target).toBe('mainline');
    expect(cfg.mainline).toEqual({ deployEnvironment: 'prod', landedCount: 4, slot });
    expect(parseAutopilotSessionConfig(serializeAutopilotSessionConfig(cfg))).toEqual(cfg);
  });

  it('refuses a mainline config without a deploy environment', () => {
    expect(
      parseAutopilotSessionConfig({ ...valid, target: 'mainline', mainline: { slot: {} } }),
    ).toBeNull();
    expect(parseAutopilotSessionConfig({ ...valid, target: 'mainline' })).toBeNull();
  });

  it('parses a stored JSON blob', () => {
    const cfg = parseAutopilotSessionConfig(
      JSON.stringify({
        ...valid,
        startedAt: '2026-09-17T12:00:00.000Z',
        status: 'running',
        cycle: 2,
      }),
    );
    expect(cfg?.status).toBe('running');
    expect(cfg?.cycle).toBe(2);
  });

  it('formats the Autopilot committed-PR counter', () => {
    expect(formatAutopilotPrCommittedLabel(0)).toBe('0 PRs committed');
    expect(formatAutopilotPrCommittedLabel(1)).toBe('1 PR committed');
    expect(formatAutopilotPrCommittedLabel(2)).toBe('2 PRs committed');
    expect(formatAutopilotPrCommittedLabel(-1)).toBe('0 PRs committed');
  });

  it('needs setup when mode is autopilot and nothing has started', () => {
    expect(needsAutopilotSetup({ session_mode: 'chat' })).toBe(false);
    expect(needsAutopilotSetup({ session_mode: 'autopilot' })).toBe(true);
    expect(
      needsAutopilotSetup({
        session_mode: 'autopilot',
        autopilot: { ...valid, startedAt: '2026-09-17T12:00:00.000Z', status: 'running' },
      }),
    ).toBe(false);
  });
});

describe('deadline helpers', () => {
  it('returns null deadline for duration 0', () => {
    expect(deadlineAtFromDuration('2026-09-17T00:00:00.000Z', 0)).toBeNull();
  });

  it('computes a deadline and detects expiry', () => {
    const deadline = deadlineAtFromDuration('2026-09-17T00:00:00.000Z', 2);
    expect(deadline).toBe('2026-09-17T02:00:00.000Z');
    expect(
      autopilotDeadlineReached(
        { deadlineAt: deadline } as any,
        Date.parse('2026-09-17T01:59:00.000Z'),
      ),
    ).toBe(false);
    expect(
      autopilotDeadlineReached(
        { deadlineAt: deadline } as any,
        Date.parse('2026-09-17T02:00:00.000Z'),
      ),
    ).toBe(true);
  });
});

describe('kickoff / continue copy', () => {
  it('mentions the named branch and no-merge rule', () => {
    const cfg = parseAutopilotSessionConfig({
      ...valid,
      startedAt: '2026-09-17T12:00:00.000Z',
      status: 'running',
    })!;
    expect(buildAutopilotKickoffMessage(cfg)).toContain('autopilot/print-ui');
    expect(buildAutopilotKickoffMessage(cfg)).toContain('never merge');
    const cont = buildAutopilotVerifyContinueMessage({
      cfg,
      sha: 'abcdef1234567890',
      branch: cfg.branch,
      prUrl: 'https://hub.example/pulls/1',
    });
    expect(cont).toContain('preview');
    expect(cont.toLowerCase()).toContain('do not merge');
  });

  it('unstick continue copy picks up from the worktree instead of restarting', () => {
    const cfg = parseAutopilotSessionConfig({
      ...valid,
      startedAt: '2026-09-17T12:00:00.000Z',
      status: 'running',
    })!;
    const text = buildAutopilotUnstickContinueMessage(cfg);
    expect(text).toContain('unstuck');
    expect(text).toContain('autopilot/print-ui');
    expect(text).toContain(cfg.goal);
    expect(text.toLowerCase()).toContain('do not restart');
  });
});

describe('autopilotEscalationInstruction', () => {
  it('produces a distinct instruction for each sensitivity', () => {
    const none = autopilotEscalationInstruction('none');
    const low = autopilotEscalationInstruction('low');
    const medium = autopilotEscalationInstruction('medium');
    const high = autopilotEscalationInstruction('high');
    const all = [none, low, medium, high];
    // Every level must be worded differently — the bug was collapsing them.
    expect(new Set(all).size).toBe(4);
    expect(none.toLowerCase()).toContain('do not stop');
    expect(high.toLowerCase()).toContain('non-trivial');
    expect(medium.toLowerCase()).toContain('ambiguous');
    // High pauses more than Low: Low says "only when blocked", High does not.
    expect(low.toLowerCase()).toContain('blocked');
    expect(high.toLowerCase()).not.toContain('only when you are blocked');
  });

  it('threads the selected sensitivity into the continue message', () => {
    const cfg = parseAutopilotSessionConfig({
      ...valid,
      escalation: 'high',
      startedAt: '2026-09-17T12:00:00.000Z',
      status: 'running',
    })!;
    const cont = buildAutopilotVerifyContinueMessage({
      cfg,
      sha: 'abcdef1234567890',
      branch: cfg.branch,
    });
    expect(cont).toContain(autopilotEscalationInstruction('high'));
    expect(cont).not.toContain(autopilotEscalationInstruction('low'));
  });
});

describe('autopilotStopNoticeContent', () => {
  it('explains why it stopped and that no more automatic work runs', () => {
    const expired = autopilotStopNoticeContent('expired', 'autopilot/x');
    expect(expired).toContain('the time limit was reached');
    expect(expired).toContain('autopilot/x');
    expect(expired.toLowerCase()).toContain('no further automatic work');
    expect(autopilotStopNoticeContent('completed', 'autopilot/x')).toContain('the goal was met');
  });
});

describe('mainline target setup', () => {
  const mainline = {
    durationHours: 2,
    brief: 'Ship it',
    goal: 'Live checks pass',
    escalation: 'low' as const,
    target: 'mainline',
    deployEnvironment: ' staging ',
  };

  it('defaults an absent target to branch', () => {
    const result = validateAutopilotSetupInput(valid);
    expect(result.ok && result.value.target).toBe('branch');
    expect(result.ok && result.value.deployEnvironment).toBeNull();
  });

  it('accepts mainline without a branch and trims the environment', () => {
    const result = validateAutopilotSetupInput({ ...mainline, branch: 'main' });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        target: 'mainline',
        branch: '',
        deployEnvironment: 'staging',
      }),
    });
  });

  it('requires a deploy environment for mainline', () => {
    const result = validateAutopilotSetupInput({ ...mainline, deployEnvironment: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toEqual(['deployEnvironment']);
  });

  it('builds a request body with only the fields its target uses', () => {
    const m = validateAutopilotSetupInput(mainline);
    const b = validateAutopilotSetupInput(valid);
    if (!m.ok || !b.ok) throw new Error('expected valid setups');
    expect(autopilotStartRequestBody(m.value)).toEqual({
      durationHours: 2,
      brief: 'Ship it',
      goal: 'Live checks pass',
      escalation: 'low',
      target: 'mainline',
      deployEnvironment: 'staging',
    });
    const body = autopilotStartRequestBody(b.value);
    expect(body).toMatchObject({ target: 'branch', branch: 'autopilot/print-ui' });
    expect(body).not.toHaveProperty('deployEnvironment');
  });

  it('rejects an unknown target', () => {
    const result = validateAutopilotSetupInput({ ...valid, target: 'prod' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toEqual(['target']);
  });
});

describe('autopilotShipCounter', () => {
  const mainlineRow = {
    autopilot: {
      durationHours: 1,
      brief: 'b',
      goal: 'g',
      escalation: 'none',
      branch: 'main',
      status: 'running',
      target: 'mainline',
      mainline: { deployEnvironment: 'staging', landedCount: 3, slot: { phase: 'idle' } },
    },
  };

  it('counts landings on the default branch for mainline', () => {
    expect(autopilotShipCounter(mainlineRow, 9)).toEqual({
      mainline: true,
      count: 3,
      label: '3 pushes to main',
    });
    expect(formatAutopilotMainlinePushLabel(1, 'trunk')).toBe('1 push to trunk');
    expect(formatAutopilotMainlinePushLabel(0, null)).toBe('0 pushes to the default branch');
  });

  it('keeps the PR label for branch sessions', () => {
    expect(autopilotShipCounter({ autopilot: null }, 2)).toEqual({
      mainline: false,
      count: 2,
      label: '2 PRs committed',
    });
  });
});

describe('mainline copy', () => {
  const cfg = parseAutopilotSessionConfig({
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Live checks pass',
    escalation: 'none',
    branch: 'main',
    status: 'running',
    target: 'mainline',
    mainline: { deployEnvironment: 'staging', slot: { phase: 'idle' } },
  })!;

  it('kickoff describes the deploy and live verification', () => {
    const msg = buildAutopilotKickoffMessage(cfg);
    expect(msg).toContain('default branch `main`');
    expect(msg).toContain('deploys environment `staging`');
    expect(msg).toContain('verify on that live environment');
    expect(msg).not.toContain('never merge to the default branch');
  });

  it('stop notice does not ask a human to merge', () => {
    const msg = autopilotStopNoticeContent('expired', 'main', 'mainline');
    expect(msg).not.toContain('merge');
    expect(msg).toContain('owed');
  });

  it('unstick message names the environment', () => {
    expect(buildAutopilotUnstickContinueMessage(cfg)).toContain('deployed to `staging`');
  });
});
