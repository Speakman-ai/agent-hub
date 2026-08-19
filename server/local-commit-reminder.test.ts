import { describe, it, expect } from 'vitest';
import type { MessageRow } from './types.js';
import {
  LOCAL_COMMIT_REMINDER,
  LOCAL_COMMIT_REMINDER_MARKER,
  COMMIT_NUDGE_KIND,
  withLocalCommitReminder,
  shouldPinLocalCommitReminder,
  parseCommitNudgeMetadata,
  hasCommitNudgeSinceLastUser,
  buildCommitNudgeCliPrompt,
  shouldNudgeUncommittedCommit,
} from './local-commit-reminder.js';
import { applyArgvPromptCap, SAFE_ARG_STRLEN_BYTES } from './spawn-prompt-payload.js';

describe('withLocalCommitReminder', () => {
  it('appends the reminder once', () => {
    const once = withLocalCommitReminder('hello');
    expect(once).toContain('hello');
    expect(once).toContain(LOCAL_COMMIT_REMINDER_MARKER);
    expect(once).toContain('git commit');
    expect(withLocalCommitReminder(once)).toBe(once);
  });
});

describe('local-commit reminder survives argv cap', () => {
  it('keeps the reminder when the enriched head is trimmed', () => {
    const head = 'S'.repeat(SAFE_ARG_STRLEN_BYTES);
    const combined = withLocalCommitReminder(`${head}\n\nHuman: please implement the fix`);
    const capped = applyArgvPromptCap(combined);
    expect(capped.truncated).toBe(true);
    expect(capped.prompt).toContain(LOCAL_COMMIT_REMINDER_MARKER);
    expect(capped.prompt).toContain('git commit');
    expect(capped.prompt).toContain('please implement the fix');
  });
});

describe('parseCommitNudgeMetadata / hasCommitNudgeSinceLastUser', () => {
  const nudge: Pick<MessageRow, 'role' | 'metadata'> = {
    role: 'system',
    metadata: JSON.stringify({ kind: COMMIT_NUDGE_KIND }),
  };

  it('parses the commit_nudge kind and ignores other metadata', () => {
    expect(parseCommitNudgeMetadata(JSON.stringify({ kind: COMMIT_NUDGE_KIND }))).toEqual({
      kind: COMMIT_NUDGE_KIND,
    });
    expect(parseCommitNudgeMetadata(JSON.stringify({ kind: 'ship_requested' }))).toBeNull();
    expect(parseCommitNudgeMetadata('not-json')).toBeNull();
  });

  it('is true when a nudge exists after the last user message', () => {
    expect(
      hasCommitNudgeSinceLastUser([
        { role: 'user', metadata: null },
        { role: 'assistant', metadata: null },
      ]),
    ).toBe(false);

    expect(
      hasCommitNudgeSinceLastUser([
        { role: 'user', metadata: null },
        nudge,
        { role: 'assistant', metadata: null },
      ]),
    ).toBe(true);

    expect(
      hasCommitNudgeSinceLastUser([
        nudge,
        { role: 'user', metadata: null },
        { role: 'assistant', metadata: null },
      ]),
    ).toBe(false);
  });

  it('stays true when a later system row lands after the nudge', () => {
    expect(
      hasCommitNudgeSinceLastUser([
        { role: 'user', metadata: null },
        nudge,
        { role: 'assistant', metadata: null },
        { role: 'system', metadata: JSON.stringify({ kind: 'close_card_rejected' }) },
      ]),
    ).toBe(true);

    expect(
      hasCommitNudgeSinceLastUser([
        { role: 'user', metadata: null },
        nudge,
        { role: 'system', metadata: JSON.stringify({ kind: 'react_budget_halt' }) },
      ]),
    ).toBe(true);
  });

  it('re-arms after a new user message', () => {
    expect(
      hasCommitNudgeSinceLastUser([
        { role: 'user', metadata: null },
        nudge,
        { role: 'assistant', metadata: null },
        { role: 'user', metadata: null },
        { role: 'assistant', metadata: null },
      ]),
    ).toBe(false);
  });
});

describe('shouldPinLocalCommitReminder', () => {
  it('pins only on a committable worktree outside ask mode', () => {
    expect(shouldPinLocalCommitReminder({ hasWorktree: true, askMode: false })).toBe(true);
    expect(shouldPinLocalCommitReminder({ hasWorktree: true, askMode: true })).toBe(false);
    expect(shouldPinLocalCommitReminder({ hasWorktree: false, askMode: false })).toBe(false);
    expect(shouldPinLocalCommitReminder({ hasWorktree: false })).toBe(false);
  });
});

describe('buildCommitNudgeCliPrompt', () => {
  it('names the branch and includes porcelain when present', () => {
    const body = buildCommitNudgeCliPrompt({
      branch: 'agent-hub/dev/session-1',
      porcelain: 'M server/foo.ts\n?? bar.ts',
    });
    expect(body).toContain('agent-hub/dev/session-1');
    expect(body).toContain('M server/foo.ts');
    expect(body).toContain('do not push');
  });

  it('omits the porcelain block when empty', () => {
    const body = buildCommitNudgeCliPrompt({ branch: 'feature/x' });
    expect(body).not.toContain('git status --porcelain');
    expect(body).toContain('feature/x');
  });
});

describe('shouldNudgeUncommittedCommit', () => {
  const ready = {
    hasUncommitted: true,
    hasUnpushed: false,
    allowFinalizeAutoStart: true,
    askMode: false,
    alreadyNudged: false,
    awaitingAsk: false,
    role: 'dev',
  };

  it('fires for a dirty worktree with no session commits', () => {
    expect(shouldNudgeUncommittedCommit(ready)).toBe(true);
  });

  it('does not fire when Finalize already has commits to ship', () => {
    expect(shouldNudgeUncommittedCommit({ ...ready, hasUnpushed: true })).toBe(false);
  });

  it('does not fire on ReAct checkpoints, ask mode, unanswered pickers, or a prior nudge', () => {
    expect(shouldNudgeUncommittedCommit({ ...ready, allowFinalizeAutoStart: false })).toBe(false);
    expect(shouldNudgeUncommittedCommit({ ...ready, askMode: true })).toBe(false);
    expect(shouldNudgeUncommittedCommit({ ...ready, awaitingAsk: true })).toBe(false);
    expect(shouldNudgeUncommittedCommit({ ...ready, alreadyNudged: true })).toBe(false);
    expect(shouldNudgeUncommittedCommit({ ...ready, role: 'reviewer' })).toBe(false);
  });

  it('does not fire on a clean worktree', () => {
    expect(shouldNudgeUncommittedCommit({ ...ready, hasUncommitted: false })).toBe(false);
  });
});

describe('LOCAL_COMMIT_REMINDER copy', () => {
  it('overrides the stock CLI wait-for-commit habit without inviting a push', () => {
    expect(LOCAL_COMMIT_REMINDER).toMatch(/does NOT apply/i);
    expect(LOCAL_COMMIT_REMINDER).toContain('git commit');
    expect(LOCAL_COMMIT_REMINDER).toMatch(/git push/);
    expect(LOCAL_COMMIT_REMINDER).toMatch(/forbidden/);
  });
});
