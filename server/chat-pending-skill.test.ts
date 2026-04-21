import { describe, it, expect, vi, afterEach } from 'vitest';
import { consumePendingSkillInjection } from './chat.js';

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
