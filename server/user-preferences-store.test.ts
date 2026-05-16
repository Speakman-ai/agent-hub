import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
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

  it('round-trips per-agent engine overrides JSON', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      agentEngineOverrides: {
        'agent-hub': { engine: 'codex-cli', model: 'gpt-5-codex' },
        reviewer: { engine: 'claude-code' },
      },
    });
    const loaded = getUserPreferencesRow(id);
    expect(loaded.agentEngineOverrides?.['agent-hub']).toEqual({
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
    expect(loaded.agentEngineOverrides?.['reviewer']).toEqual({ engine: 'claude-code' });

    replaceUserPreferencesJson(id, { agentEngineOverrides: {} });
    expect(getUserPreferencesRow(id).agentEngineOverrides).toBeUndefined();
  });

  it('stores engineDefaultModels and agentEngineOverrides side-by-side', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      engineDefaultModels: { 'claude-code': 'claude-opus-4-7' },
      agentEngineOverrides: { reviewer: { engine: 'codex-cli', model: 'gpt-5-codex' } },
    });
    const loaded = getUserPreferencesRow(id);
    expect(loaded.engineDefaultModels?.['claude-code']).toBe('claude-opus-4-7');
    expect(loaded.agentEngineOverrides?.reviewer.engine).toBe('codex-cli');
    expect(loaded.agentEngineOverrides?.reviewer.model).toBe('gpt-5-codex');
  });

  it('drops malformed override entries on read', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    // Hand-write a malformed payload directly to the column.
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          agentEngineOverrides: {
            // Valid
            good: { engine: 'codex-cli', model: 'gpt-5-codex' },
            // Missing engine — should be dropped
            bad1: { model: 'x' },
            // Empty engine — should be dropped
            bad2: { engine: '   ' },
            // Wrong type — should be dropped
            bad3: 'codex-cli',
          },
        }),
        id,
      );
    const loaded = getUserPreferencesRow(id);
    expect(Object.keys(loaded.agentEngineOverrides ?? {})).toEqual(['good']);
  });
});
