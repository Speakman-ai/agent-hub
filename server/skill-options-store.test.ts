import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const {
  upsertUserSkillOption,
  listUserSkillOptions,
  deleteUserSkillOption,
  getUserSkillOptionValues,
} = await import('./skill-options-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'skill-opt-store-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('skill-options-store', () => {
  let userId: string;
  beforeEach(() => {
    freshDb();
    userId = createUser({ username: `u-${Date.now()}`, passwordHash: 'h' }).id;
  });

  it('upserts and reads back a selection', () => {
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'ENV', value: 'prod' });
    const rows = listUserSkillOptions(userId, 'survey-tracker');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill_id: 'survey-tracker',
      option_name: 'ENV',
      value: 'prod',
    });
  });

  it('updates the value on a second upsert (unique per user+skill+option)', () => {
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'ENV', value: 'dev' });
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'ENV', value: 'prod' });
    const rows = listUserSkillOptions(userId, 'survey-tracker');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('prod');
  });

  it('getUserSkillOptionValues returns a name->value map for one skill', () => {
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'ENV', value: 'prod' });
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'REGION', value: 'us' });
    upsertUserSkillOption({ userId, skillId: 'other', optionName: 'ENV', value: 'dev' });
    const map = getUserSkillOptionValues(userId, 'survey-tracker');
    expect(map.get('ENV')).toBe('prod');
    expect(map.get('REGION')).toBe('us');
    expect(map.has('other')).toBe(false);
  });

  it('delete removes the row and reports ok', () => {
    upsertUserSkillOption({ userId, skillId: 'survey-tracker', optionName: 'ENV', value: 'prod' });
    expect(deleteUserSkillOption(userId, 'survey-tracker', 'ENV').ok).toBe(true);
    expect(listUserSkillOptions(userId, 'survey-tracker')).toHaveLength(0);
    // idempotent: second delete reports not-found
    expect(deleteUserSkillOption(userId, 'survey-tracker', 'ENV').ok).toBe(false);
  });
});
