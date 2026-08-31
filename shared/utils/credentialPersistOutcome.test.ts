import { describe, it, expect } from 'vitest';
import {
  describeCredentialPersistOutcome,
  normalizeCredentialPersistTarget,
  EPHEMERAL_DISCARD_LINE,
} from './credentialPersistOutcome';

describe('normalizeCredentialPersistTarget', () => {
  it('accepts a valid target and trims key names', () => {
    expect(
      normalizeCredentialPersistTarget({ skillId: 'survey-tracker', map: { username: ' USER ' } }),
    ).toEqual({ skillId: 'survey-tracker', map: { username: 'USER' } });
  });

  it('rejects a map whose destination keys collide (would overwrite the wrong secret)', () => {
    expect(
      normalizeCredentialPersistTarget({
        skillId: 'survey-tracker',
        map: { password: 'LOGIN', username: 'LOGIN' },
      }),
    ).toBeNull();
  });

  it('rejects bad skill ids, empty/oversized maps, and non-env key names', () => {
    expect(normalizeCredentialPersistTarget({ skillId: 'bad id', map: { a: 'B' } })).toBeNull();
    expect(normalizeCredentialPersistTarget({ skillId: 'ok', map: {} })).toBeNull();
    expect(normalizeCredentialPersistTarget({ skillId: 'ok', map: { a: '1BAD' } })).toBeNull();
    const big: Record<string, string> = {};
    for (let i = 0; i < 7; i++) big[`f${i}`] = `K${i}`;
    expect(normalizeCredentialPersistTarget({ skillId: 'ok', map: big })).toBeNull();
  });

  it('enforces field-key membership when fieldKeys is supplied', () => {
    const fieldKeys = new Set(['username']);
    expect(
      normalizeCredentialPersistTarget({ skillId: 'ok', map: { nope: 'K' } }, { fieldKeys }),
    ).toBeNull();
    expect(
      normalizeCredentialPersistTarget({ skillId: 'ok', map: { username: 'K' } }, { fieldKeys }),
    ).toEqual({ skillId: 'ok', map: { username: 'K' } });
  });
});

const persist = {
  skillId: 'survey-tracker',
  map: {
    username: 'SURVEYTRACKER_API_DATA_USERNAME',
    password: 'SURVEYTRACKER_API_DATA_PASSWORD',
  },
};

describe('describeCredentialPersistOutcome', () => {
  it('returns the ephemeral line when no persist target was requested', () => {
    const out = describeCredentialPersistOutcome({ service: 'Survey Tracker' });
    expect(out.kind).toBe('off');
    expect(out.line).toBe(EPHEMERAL_DISCARD_LINE);
  });

  it('reports full success only when every requested key was stored', () => {
    const out = describeCredentialPersistOutcome({
      service: 'Survey Tracker',
      persist,
      persisted: {
        skillId: 'survey-tracker',
        stored: ['SURVEYTRACKER_API_DATA_USERNAME', 'SURVEYTRACKER_API_DATA_PASSWORD'],
        skipped: [],
      },
    });
    expect(out.kind).toBe('saved');
    expect(out.line).toContain('reused in future sessions');
    expect(out.unsavedKeys).toEqual([]);
  });

  it('reports partial failure when some requested keys were skipped', () => {
    const out = describeCredentialPersistOutcome({
      service: 'Survey Tracker',
      persist,
      persisted: {
        skillId: 'survey-tracker',
        stored: ['SURVEYTRACKER_API_DATA_USERNAME'],
        skipped: [{ keyName: 'SURVEYTRACKER_API_DATA_PASSWORD', reason: 'not-declared-by-skill' }],
      },
    });
    expect(out.kind).toBe('partial');
    expect(out.savedKeys).toEqual(['SURVEYTRACKER_API_DATA_USERNAME']);
    expect(out.unsavedKeys).toEqual(['SURVEYTRACKER_API_DATA_PASSWORD']);
    expect(out.line).toContain('partially saved');
    expect(out.line).toContain('could NOT be saved');
    expect(out.line).toContain('SURVEYTRACKER_API_DATA_PASSWORD');
    expect(out.line).not.toContain('reused in future sessions');
  });

  it('treats a requested key the server omitted entirely as unsaved (not just skipped[])', () => {
    const out = describeCredentialPersistOutcome({
      service: 'Survey Tracker',
      persist,
      // Server returned only one stored key and an EMPTY skipped list — the
      // other requested key is still unsaved and must be disclosed.
      persisted: {
        skillId: 'survey-tracker',
        stored: ['SURVEYTRACKER_API_DATA_USERNAME'],
        skipped: [],
      },
    });
    expect(out.kind).toBe('partial');
    expect(out.unsavedKeys).toEqual(['SURVEYTRACKER_API_DATA_PASSWORD']);
  });

  it('reports total failure and surfaces the error when nothing was stored', () => {
    const out = describeCredentialPersistOutcome({
      service: 'Survey Tracker',
      persist,
      persisted: {
        skillId: 'survey-tracker',
        stored: [],
        skipped: [],
        error: 'skill "survey-tracker" declares no credentials in SKILL.md frontmatter',
      },
    });
    expect(out.kind).toBe('failed');
    expect(out.line).toContain('could NOT be saved');
    expect(out.line).toContain('declares no credentials');
    expect(out.line).not.toContain('reused in future sessions');
  });

  it('degrades to failed when the server returns no persisted payload at all', () => {
    const out = describeCredentialPersistOutcome({ service: 'Survey Tracker', persist });
    expect(out.kind).toBe('failed');
    expect(out.line).toContain('could NOT be saved');
  });
});
