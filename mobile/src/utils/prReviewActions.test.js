import { describe, it, expect } from 'vitest';
import {
  REVIEW_EVENTS,
  reviewStateForEvent,
  buildReviewPayload,
  buildGeneralCommentPayload,
  buildEditPrPayload,
  buildInlineCommentPayload,
  prDetailCapabilities,
} from './prReviewActions.js';

describe('REVIEW_EVENTS / reviewStateForEvent', () => {
  it('maps the GitHub-style UI verbs to the server state values', () => {
    expect(reviewStateForEvent('APPROVE')).toBe('approved');
    expect(reviewStateForEvent('REQUEST_CHANGES')).toBe('changes_requested');
    expect(reviewStateForEvent('COMMENT')).toBe('commented');
  });

  it('returns null for unknown events', () => {
    expect(reviewStateForEvent('MERGE')).toBeNull();
    expect(reviewStateForEvent(undefined)).toBeNull();
  });

  it('exposes a label per event for the UI', () => {
    expect(REVIEW_EVENTS.every((e) => e.event && e.state && e.label)).toBe(true);
  });
});

describe('buildReviewPayload', () => {
  it('builds an approve payload with an optional trimmed body', () => {
    expect(buildReviewPayload('APPROVE', '  LGTM  ')).toEqual({
      ok: true,
      payload: { state: 'approved', body: 'LGTM' },
    });
    expect(buildReviewPayload('APPROVE')).toEqual({
      ok: true,
      payload: { state: 'approved', body: '' },
    });
  });

  it('builds a request-changes payload', () => {
    expect(buildReviewPayload('REQUEST_CHANGES', 'fix the test').payload).toEqual({
      state: 'changes_requested',
      body: 'fix the test',
    });
  });

  it('requires a body for COMMENT reviews (server contract)', () => {
    expect(buildReviewPayload('COMMENT', '   ').ok).toBe(false);
    expect(buildReviewPayload('COMMENT', '').ok).toBe(false);
    expect(buildReviewPayload('COMMENT', 'note').payload).toEqual({
      state: 'commented',
      body: 'note',
    });
  });

  it('rejects unknown events', () => {
    const res = buildReviewPayload('SHIP_IT', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SHIP_IT/);
  });

  it('tolerates a non-string body', () => {
    expect(buildReviewPayload('APPROVE', null).payload.body).toBe('');
    expect(buildReviewPayload('COMMENT', 42).ok).toBe(false);
  });
});

describe('buildGeneralCommentPayload', () => {
  it('is a commented review under the hood', () => {
    expect(buildGeneralCommentPayload('hello').payload).toEqual({
      state: 'commented',
      body: 'hello',
    });
  });

  it('rejects empty text', () => {
    expect(buildGeneralCommentPayload('  ').ok).toBe(false);
  });
});

describe('buildEditPrPayload', () => {
  it('requires a non-empty title', () => {
    expect(buildEditPrPayload({ title: '  ', body: 'x' }).ok).toBe(false);
    expect(buildEditPrPayload({}).ok).toBe(false);
    expect(buildEditPrPayload().ok).toBe(false);
  });

  it('trims the title and preserves the body (including empty)', () => {
    expect(buildEditPrPayload({ title: '  Fix bug  ', body: 'desc' }).payload).toEqual({
      title: 'Fix bug',
      body: 'desc',
    });
    expect(buildEditPrPayload({ title: 'T' }).payload).toEqual({ title: 'T', body: '' });
  });
});

describe('buildInlineCommentPayload', () => {
  it('builds a valid payload and defaults side to "new"', () => {
    expect(buildInlineCommentPayload({ filePath: 'a.js', line: 7, body: ' hi ' }).payload).toEqual({
      filePath: 'a.js',
      line: 7,
      side: 'new',
      body: 'hi',
    });
  });

  it('keeps side "old" when given', () => {
    expect(
      buildInlineCommentPayload({ filePath: 'a.js', line: 3, side: 'old', body: 'x' }).payload.side,
    ).toBe('old');
  });

  it('clamps unknown sides to "new"', () => {
    expect(
      buildInlineCommentPayload({ filePath: 'a.js', line: 3, side: 'left', body: 'x' }).payload
        .side,
    ).toBe('new');
  });

  it('coerces numeric-string lines', () => {
    expect(buildInlineCommentPayload({ filePath: 'a.js', line: '12', body: 'x' }).payload.line).toBe(
      12,
    );
  });

  it('rejects missing file, bad lines, and empty bodies', () => {
    expect(buildInlineCommentPayload({ line: 1, body: 'x' }).ok).toBe(false);
    expect(buildInlineCommentPayload({ filePath: 'a.js', line: 0, body: 'x' }).ok).toBe(false);
    expect(buildInlineCommentPayload({ filePath: 'a.js', line: 'nope', body: 'x' }).ok).toBe(false);
    expect(buildInlineCommentPayload({ filePath: 'a.js', line: 1, body: '  ' }).ok).toBe(false);
    expect(buildInlineCommentPayload().ok).toBe(false);
  });
});

describe('prDetailCapabilities', () => {
  const nativeOpen = {
    source: 'agenthub',
    pr: { state: 'open', html_url: 'agent-hub://projects/p1/pulls/4' },
  };

  it('native open PR: review/comment/edit enabled, reopen disabled', () => {
    const caps = prDetailCapabilities(nativeOpen);
    expect(caps).toMatchObject({
      isNative: true,
      isOpen: true,
      canReview: true,
      canComment: true,
      canEdit: true,
      canReopen: false,
      canViewFiles: true,
    });
  });

  it('native closed (not merged) PR: only reopen', () => {
    const caps = prDetailCapabilities({
      source: 'agenthub',
      pr: { state: 'closed', html_url: 'x' },
    });
    expect(caps).toMatchObject({
      canReview: false,
      canComment: false,
      canEdit: false,
      canReopen: true,
    });
  });

  it('merged native PR: immutable — no reopen', () => {
    const caps = prDetailCapabilities({
      source: 'agenthub',
      pr: { state: 'closed', merged_at: '2026-06-01T00:00:00Z', html_url: 'x' },
    });
    expect(caps.isMerged).toBe(true);
    expect(caps.canReopen).toBe(false);
  });

  it('GitHub PR: write actions disabled, files viewable, external link kept', () => {
    const caps = prDetailCapabilities({
      source: 'user-oauth',
      pr: { state: 'open', html_url: 'https://github.com/o/r/pull/9' },
    });
    expect(caps).toMatchObject({
      isNative: false,
      canReview: false,
      canComment: false,
      canEdit: false,
      canReopen: false,
      canViewFiles: true,
      externalUrl: 'https://github.com/o/r/pull/9',
    });
  });

  it('native in-app URLs get no externalUrl', () => {
    expect(prDetailCapabilities(nativeOpen).externalUrl).toBeNull();
  });

  it('handles null / malformed detail', () => {
    expect(prDetailCapabilities(null)).toMatchObject({
      canReview: false,
      canViewFiles: false,
      prUrl: null,
    });
    expect(prDetailCapabilities({})).toMatchObject({ canEdit: false });
  });
});
