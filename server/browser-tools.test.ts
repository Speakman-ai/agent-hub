import { describe, it, expect } from 'vitest';
import {
  looksLikeSelectorTarget,
  runBrowserReActStep,
  resolveStagehandModelName,
} from './browser-tools.js';

describe('browser-tools — looksLikeSelectorTarget', () => {
  it('treats prose with spaces as natural language', () => {
    expect(looksLikeSelectorTarget('click the blue submit button')).toBe(false);
  });

  it('recognizes common CSS and XPath patterns', () => {
    expect(looksLikeSelectorTarget('#login')).toBe(true);
    expect(looksLikeSelectorTarget('.btn-primary')).toBe(true);
    expect(looksLikeSelectorTarget('[data-testid="x"]')).toBe(true);
    expect(looksLikeSelectorTarget('//button[@type="submit"]')).toBe(true);
    expect(looksLikeSelectorTarget('iframe >> #go')).toBe(true);
    expect(looksLikeSelectorTarget('button')).toBe(true);
    expect(looksLikeSelectorTarget('div.err')).toBe(true);
  });
});

describe('browser-tools — runBrowserReActStep', () => {
  it('returns error markdown when op is unknown (does not launch Chromium)', async () => {
    const r = await runBrowserReActStep('test-session-uuid', { op: 'not-a-real-op' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/Unsupported or missing op/);
  });
});

describe('browser-tools — resolveStagehandModelName', () => {
  it('falls back to a Stagehand-style anthropic id when STAGEHAND_MODEL is unset', () => {
    const prev = process.env.STAGEHAND_MODEL;
    delete process.env.STAGEHAND_MODEL;
    try {
      expect(resolveStagehandModelName()).toMatch(/^anthropic\//);
    } finally {
      if (prev !== undefined) process.env.STAGEHAND_MODEL = prev;
    }
  });
});
