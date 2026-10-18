import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  attachPendingObservationToUserTurn,
  consumePendingSkillInjection,
  PENDING_OBSERVATION_ARGV_RESERVE_BYTES,
  routePendingContext,
} from './chat.js';
import { applyArgvPromptCap, SAFE_ARG_STRLEN_BYTES } from './spawn-prompt-payload.js';

describe('attachPendingObservationToUserTurn', () => {
  it('puts the preview observation ahead of the request the engine will read', () => {
    const out = attachPendingObservationToUserTurn(
      'Continue your previous answer using the newly loaded preview context.',
      '\n\n## Preview: screenshot\n\npage text',
    );
    expect(out).toBe(
      '## Preview: screenshot\n\npage text\n\nContinue your previous answer using the newly loaded preview context.',
    );
  });

  it('keeps the whole request and the observation heading through the argv cap', () => {
    const request = 'USER-REQUEST-MARKER: fix the header spacing.';
    // Pending context is allowed up to 128 KiB, past the 100 KB argv cap.
    const observation = `## Skill: big-skill\n\n${'x'.repeat(110_000)}`;
    const attached = attachPendingObservationToUserTurn(request, observation);
    expect(Buffer.byteLength(attached, 'utf8')).toBeLessThanOrEqual(
      SAFE_ARG_STRLEN_BYTES - PENDING_OBSERVATION_ARGV_RESERVE_BYTES,
    );
    // Simulate the local-commit reminder pinned at the tail before the cap.
    const capped = applyArgvPromptCap(`${attached}\n\nCommit locally when done.`);
    expect(capped.truncated).toBe(false);
    expect(capped.prompt).toContain(request);
    expect(capped.prompt).toContain('## Skill: big-skill');
    expect(capped.prompt).toContain('[Truncated: observation clipped');
  });

  it('drops the observation rather than the request when the request fills the cap', () => {
    const request = 'r'.repeat(SAFE_ARG_STRLEN_BYTES - 1000);
    expect(attachPendingObservationToUserTurn(request, '## Wiki\n\nhit')).toBe(request);
  });

  it('returns the user turn unchanged when there is no observation', () => {
    expect(attachPendingObservationToUserTurn('Continue.', '  ')).toBe('Continue.');
  });
});

describe('routePendingContext', () => {
  const pendingSuffix = '\n\n## SideBar context\n\nPARENT_MARKER';

  it('keeps pending context in the file-backed system prompt for a fresh engine session', () => {
    const out = routePendingContext({
      resumingEngineSession: false,
      cliContent: 'question',
      enrichedPrompt: 'SYSTEM',
      pendingSuffix,
    });
    expect(out).toEqual({ cliContent: 'question', enrichedPrompt: `SYSTEM${pendingSuffix}` });
  });

  it('moves pending context onto the user turn when resuming', () => {
    const out = routePendingContext({
      resumingEngineSession: true,
      cliContent: 'question',
      enrichedPrompt: 'SYSTEM',
      pendingSuffix,
    });
    expect(out.enrichedPrompt).toBe('SYSTEM');
    expect(out.cliContent).toBe('## SideBar context\n\nPARENT_MARKER\n\nquestion');
  });
});

describe('consumePendingSkillInjection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty when there is no pending context', () => {
    expect(consumePendingSkillInjection(null, () => {})).toEqual({
      suffix: '',
      forceSystemPromptThisTurn: false,
    });
    expect(consumePendingSkillInjection('   ', () => {})).toEqual({
      suffix: '',
      forceSystemPromptThisTurn: false,
    });
  });

  it('clears first then returns suffix only when clear succeeds', () => {
    const order: string[] = [];
    const out = consumePendingSkillInjection('## Skill context', () => {
      order.push('clear');
    });
    expect(order).toEqual(['clear']);
    expect(out.forceSystemPromptThisTurn).toBe(true);
    expect(out.suffix).toBe('\n\n## Skill context');
  });

  it('does not return a suffix when clear fails (avoids sticky re-append)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = consumePendingSkillInjection('## Skill context', () => {
      throw new Error('database locked');
    });
    expect(out).toEqual({ suffix: '', forceSystemPromptThisTurn: false });
    expect(errSpy).toHaveBeenCalledWith(
      '[skill-invoke] failed to clear pending_skill_context:',
      'database locked',
    );
  });
});
