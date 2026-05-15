import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import { replaceUserPreferencesJson, getUserPreferencesRow } from './user-preferences-store.js';

describe('user-preferences-store', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ah-preftest-'));

  beforeEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* first run */
    }
    mkdirSync(tmpRoot, { recursive: true });
    setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
    initOrgsDb();
  });

  afterAll(() => {
    setOrgsDbPathForTests(null);
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('round-trips engine default models JSON', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      engineDefaultModels: {
        'claude-code': 'claude-opus-4-7',
        'cursor-agent': 'composer-2',
      },
    });
    const loaded = getUserPreferencesRow(id);
    expect(loaded.engineDefaultModels?.['claude-code']).toBe('claude-opus-4-7');
    expect(loaded.engineDefaultModels?.['cursor-agent']).toBe('composer-2');

    replaceUserPreferencesJson(id, { engineDefaultModels: {} });
    expect(getUserPreferencesRow(id)).toEqual({});
  });
});
