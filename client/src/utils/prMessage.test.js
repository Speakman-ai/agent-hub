import { describe, it, expect } from 'vitest';
import {
  parsePrCreatedMetadata,
  parsePrFailedMetadata,
  describePrFailureCode,
  shortSha,
} from './prMessage.js';

describe('parsePrCreatedMetadata', () => {
  const valid = {
    kind: 'pr_created',
    prUrl: 'https://github.com/acme/repo/pull/42',
    prNumber: 42,
    commitSha: 'abc123def4567',
    commitTitle: 'Fix login crash',
    cardId: 'card-uuid',
    cardTitle: 'Login task',
  };

  it('parses well-formed metadata', () => {
    const out = parsePrCreatedMetadata(JSON.stringify(valid));
    expect(out).toEqual({
      prUrl: 'https://github.com/acme/repo/pull/42',
      prNumber: 42,
      commitSha: 'abc123def4567',
      commitTitle: 'Fix login crash',
      cardId: 'card-uuid',
      cardTitle: 'Login task',
    });
  });

  it('accepts pre-parsed objects (idempotent)', () => {
    const out = parsePrCreatedMetadata(valid);
    expect(out?.prNumber).toBe(42);
  });

  it('returns null for null/undefined', () => {
    expect(parsePrCreatedMetadata(null)).toBeNull();
    expect(parsePrCreatedMetadata(undefined)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parsePrCreatedMetadata('{ not json')).toBeNull();
    expect(parsePrCreatedMetadata('')).toBeNull();
  });

  it('returns null when kind is not pr_created', () => {
    const wrong = JSON.stringify({ ...valid, kind: 'something_else' });
    expect(parsePrCreatedMetadata(wrong)).toBeNull();
  });

  it('returns null when prUrl is missing or empty', () => {
    expect(parsePrCreatedMetadata(JSON.stringify({ ...valid, prUrl: '' }))).toBeNull();
    expect(parsePrCreatedMetadata(JSON.stringify({ ...valid, prUrl: null }))).toBeNull();
    const { prUrl: _unused, ...noUrl } = valid;
    expect(parsePrCreatedMetadata(JSON.stringify(noUrl))).toBeNull();
  });

  it('tolerates null cardId/cardTitle (ad-hoc flow)', () => {
    const adhoc = JSON.stringify({ ...valid, cardId: null, cardTitle: null });
    const out = parsePrCreatedMetadata(adhoc);
    expect(out?.cardId).toBeNull();
    expect(out?.cardTitle).toBeNull();
    expect(out?.prUrl).toBe(valid.prUrl);
  });

  it('coerces non-number prNumber to null (future-proof against wire drift)', () => {
    const weird = JSON.stringify({ ...valid, prNumber: '42' });
    expect(parsePrCreatedMetadata(weird)?.prNumber).toBeNull();
  });

  it('coerces missing commitSha / commitTitle to empty strings', () => {
    const minimal = JSON.stringify({
      kind: 'pr_created',
      prUrl: 'https://x/pull/1',
      prNumber: 1,
      cardId: null,
      cardTitle: null,
    });
    const out = parsePrCreatedMetadata(minimal);
    expect(out?.commitSha).toBe('');
    expect(out?.commitTitle).toBe('');
  });
});

describe('parsePrFailedMetadata', () => {
  const valid = {
    kind: 'pr_failed',
    code: 'push_failed',
    error: 'git push rejected — remote contains work you do not have locally',
    branch: 'agent-hub/agent-hub/session-abc',
    cardId: 'card-uuid',
    cardTitle: 'Sessions arent pushing',
    agentName: 'Hub Lead Dev',
  };

  it('parses well-formed metadata', () => {
    const out = parsePrFailedMetadata(JSON.stringify(valid));
    expect(out).toEqual({
      code: 'push_failed',
      error: valid.error,
      branch: valid.branch,
      cardId: 'card-uuid',
      cardTitle: 'Sessions arent pushing',
      agentName: 'Hub Lead Dev',
    });
  });

  it('accepts pre-parsed objects', () => {
    const out = parsePrFailedMetadata(valid);
    expect(out?.code).toBe('push_failed');
  });

  it('returns null for null/undefined/malformed', () => {
    expect(parsePrFailedMetadata(null)).toBeNull();
    expect(parsePrFailedMetadata(undefined)).toBeNull();
    expect(parsePrFailedMetadata('{ not json')).toBeNull();
    expect(parsePrFailedMetadata('')).toBeNull();
  });

  it('returns null when kind is not pr_failed', () => {
    expect(parsePrFailedMetadata(JSON.stringify({ ...valid, kind: 'pr_created' }))).toBeNull();
  });

  it('returns null for unknown / missing code (whitelist enforced)', () => {
    expect(
      parsePrFailedMetadata(JSON.stringify({ ...valid, code: 'nothing_to_publish' })),
    ).toBeNull();
    expect(parsePrFailedMetadata(JSON.stringify({ ...valid, code: 'bogus' }))).toBeNull();
    const { code: _c, ...noCode } = valid;
    expect(parsePrFailedMetadata(JSON.stringify(noCode))).toBeNull();
  });

  it('returns null when error is missing', () => {
    const { error: _e, ...noError } = valid;
    expect(parsePrFailedMetadata(JSON.stringify(noError))).toBeNull();
  });

  it('tolerates null branch / cardId / cardTitle / agentName (ad-hoc flow)', () => {
    const adhoc = JSON.stringify({
      ...valid,
      branch: null,
      cardId: null,
      cardTitle: null,
      agentName: null,
    });
    const out = parsePrFailedMetadata(adhoc);
    expect(out?.branch).toBeNull();
    expect(out?.cardId).toBeNull();
    expect(out?.cardTitle).toBeNull();
    expect(out?.agentName).toBeNull();
    expect(out?.code).toBe('push_failed');
  });

  it('accepts each whitelisted failure code', () => {
    for (const code of ['commit_failed', 'push_failed', 'pr_failed']) {
      const out = parsePrFailedMetadata(JSON.stringify({ ...valid, code }));
      expect(out?.code).toBe(code);
    }
  });
});

describe('describePrFailureCode', () => {
  it('maps known codes to human-friendly labels', () => {
    expect(describePrFailureCode('push_failed')).toBe('Push rejected');
    expect(describePrFailureCode('commit_failed')).toBe('Commit failed');
    expect(describePrFailureCode('pr_failed')).toBe('PR creation failed');
  });

  it('falls back to generic label for unknown codes', () => {
    expect(describePrFailureCode('bogus')).toBe('Auto-PR failed');
    expect(describePrFailureCode(undefined)).toBe('Auto-PR failed');
  });
});

describe('shortSha', () => {
  it('returns the first 7 chars of a SHA', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef1');
  });

  it('returns the whole string if shorter than 7', () => {
    expect(shortSha('abc')).toBe('abc');
  });

  it('returns empty string for null / undefined / non-strings', () => {
    expect(shortSha(null)).toBe('');
    expect(shortSha(undefined)).toBe('');
    expect(shortSha(42)).toBe('');
    expect(shortSha('')).toBe('');
  });
});
