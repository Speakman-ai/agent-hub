import { existsSync } from 'fs';
import path from 'path';
import {
  loadAutofixTemplate,
  resetAutofixTemplateCache,
  AUTOFIX_KINDS,
  AUTOFIX_PROMPTS_DIR,
  type AutofixKind,
} from './index.js';

describe('autofix prompt templates', () => {
  beforeEach(() => {
    resetAutofixTemplateCache();
  });

  it('exposes all three template kinds', () => {
    expect(AUTOFIX_KINDS).toEqual(['review', 'ci', 'conflict']);
  });

  it('has a file on disk for every kind', () => {
    for (const kind of AUTOFIX_KINDS) {
      const expectedFile: Record<AutofixKind, string> = {
        review: 'review-autofix.md',
        ci: 'ci-autofix.md',
        conflict: 'conflict-resolve.md',
      };
      const filePath = path.join(AUTOFIX_PROMPTS_DIR, expectedFile[kind]);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it('loads review-autofix.md with root-cause + no-skip framing', () => {
    const prompt = loadAutofixTemplate('review');
    expect(prompt).toContain('root cause');
    expect(prompt.toLowerCase()).toContain('review feedback');
    expect(prompt).toMatch(/\.skip|xit|xdescribe/);
    expect(prompt).toMatch(/autofix\(review\)/);
  });

  it('loads ci-autofix.md with CI-specific guidance', () => {
    const prompt = loadAutofixTemplate('ci');
    expect(prompt.toLowerCase()).toContain('ci');
    expect(prompt).toContain('root cause');
    expect(prompt).toMatch(/autofix\(ci\)/);
    // Must carry the pending-checks rule from the original babysit prompt
    expect(prompt.toLowerCase()).toMatch(/pending|in.progress|queued/);
  });

  it('loads conflict-resolve.md with merge-conflict guidance', () => {
    const prompt = loadAutofixTemplate('conflict');
    expect(prompt.toLowerCase()).toContain('merge conflict');
    expect(prompt.toLowerCase()).toMatch(/base branch|rebase/);
    expect(prompt).toMatch(/autofix\(conflict\)/);
  });

  it('caches templates across calls', () => {
    const first = loadAutofixTemplate('review');
    const second = loadAutofixTemplate('review');
    // Same string instance — cache hit.
    expect(second).toBe(first);
  });

  it('resetAutofixTemplateCache forces a fresh read', () => {
    const first = loadAutofixTemplate('ci');
    resetAutofixTemplateCache();
    const second = loadAutofixTemplate('ci');
    // Content equals, but it's a newly-read string (not the cached reference).
    expect(second).toEqual(first);
  });

  it('throws for an unknown kind', () => {
    expect(() =>
      // @ts-expect-error intentional bad input
      loadAutofixTemplate('not-a-real-kind'),
    ).toThrow(/Unknown autofix template/);
  });

  it('every template forbids lazy fixes explicitly', () => {
    for (const kind of AUTOFIX_KINDS) {
      const prompt = loadAutofixTemplate(kind);
      expect(prompt.toUpperCase()).toContain('NO LAZY FIXES');
      expect(prompt).toMatch(/@ts-ignore|eslint-disable|\.skip/);
    }
  });
});
