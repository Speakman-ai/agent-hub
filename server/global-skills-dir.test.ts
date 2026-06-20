import { describe, it, expect, vi } from 'vitest';

// Mirror prompt-builder unit tests (agent-roster, prompt-trim) that mock
// ./config.js WITHOUT a dataDir — resolveGlobalSkillsDir must not throw on
// path.join(undefined, …), since listMergedSkills/loadSkillBody call it.
vi.mock('./config.js', () => ({
  default: { defaultModel: 'x' },
}));

import { resolveGlobalSkillsDir } from './global-skills-dir.js';

describe('resolveGlobalSkillsDir — config.dataDir unset', () => {
  it('returns "" instead of throwing when dataDir is missing', () => {
    expect(() => resolveGlobalSkillsDir()).not.toThrow();
    expect(resolveGlobalSkillsDir()).toBe('');
  });
});
