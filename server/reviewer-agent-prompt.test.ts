import { describe, expect, it } from 'vitest';
import {
  STALE_REVIEWER_PROMPT_MARKERS,
  buildReviewerAgentSystemPrompt,
  buildReviewerIdentityMarkdown,
  reviewerSystemPromptIsStale,
} from './reviewer-agent-prompt.js';

describe('reviewerSystemPromptIsStale', () => {
  it('is false for empty / custom prompts that are not a legacy seed', () => {
    expect(reviewerSystemPromptIsStale(undefined)).toBe(false);
    expect(reviewerSystemPromptIsStale('')).toBe(false);
    expect(reviewerSystemPromptIsStale('Review the local diff and emit a verdict.')).toBe(false);
    expect(reviewerSystemPromptIsStale(buildReviewerAgentSystemPrompt('Demo'))).toBe(false);
  });

  it('detects each legacy marker from older seeds', () => {
    for (const marker of STALE_REVIEWER_PROMPT_MARKERS) {
      expect(reviewerSystemPromptIsStale(`prefix ${marker} suffix`)).toBe(true);
    }
  });
});

describe('buildReviewerAgentSystemPrompt', () => {
  const sp = buildReviewerAgentSystemPrompt('Survey Tracker');

  it('is mode-aware: Finalize local-diff and Hub PR review share one severity cut', () => {
    expect(sp).toContain('Mode A');
    expect(sp).toContain('Mode B');
    expect(sp).toContain('local diff');
    expect(sp).toContain('a reason to stop');
    expect(sp).toContain('/pulls/');
    expect(sp).toContain('X-API-Key');
    expect(sp).not.toContain('Identify the PR you are reviewing from the prompt context');
    expect(sp).not.toContain('If you cannot load the PR diff, stop');
    expect(sp).not.toContain('leave a high-signal formal GitHub review on every pull request');
    expect(sp).not.toContain('Do **not** fetch PR metadata, call `gh`, or hit Hub/GitHub PR APIs');
    expect(sp).not.toContain('blocking findings (7+)');
  });

  it('keeps the in-session verdict contract and severity decision tree', () => {
    expect(sp).toContain('<agenthub:review-verdict>');
    expect(sp).toContain('"verdict"');
    expect(sp).toContain('approved');
    expect(sp).toContain('changes_requested');
    expect(sp).toMatch(/decision tree/i);
    expect(sp).toMatch(/don't rubber-stamp/i);
    expect(sp).toMatch(/mergeable as-is/i);
    expect(sp).toMatch(/score\b[^.]*\b(greater than|>)\s*3/i);
  });
});

describe('buildReviewerIdentityMarkdown', () => {
  it('describes both Finalize and Hub-hosted PR review modes', () => {
    const md = buildReviewerIdentityMarkdown('Survey Tracker');
    expect(md).toContain('local diff');
    expect(md).toContain('in-session');
    expect(md).toContain('Hub-hosted PR review');
    expect(md).toMatch(/never merge/i);
  });
});
