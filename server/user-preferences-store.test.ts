import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import {
  replaceUserPreferencesJson,
  mergeUserPreferencesJson,
  getUserPreferencesRow,
  mutateUserPreferencesJson,
  MAX_SIDEBAR_COLLAPSED_PROJECTS,
} from './user-preferences-store.js';

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

  it('ignores legacy engineDefaultModels persisted by an older build', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    // Simulate a row written by the removed per-user "default models" feature.
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
          agentEngineOverrides: {
            reviewer: { engine: 'codex-cli', model: 'gpt-5-codex' },
          },
        }),
        id,
      );
    const loaded = getUserPreferencesRow(id);
    // Legacy sub-map is silently dropped on read.
    expect((loaded as Record<string, unknown>).engineDefaultModels).toBeUndefined();
    // The other sub-map is still intact.
    expect(loaded.agentEngineOverrides?.reviewer).toEqual({
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
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

  it('round-trips per-agent model overrides JSON', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      agentModelOverrides: { 'agent-hub': 'claude-opus-4-8', reviewer: 'gpt-5-codex' },
    });
    const loaded = getUserPreferencesRow(id);
    expect(loaded.agentModelOverrides).toEqual({
      'agent-hub': 'claude-opus-4-8',
      reviewer: 'gpt-5-codex',
    });

    replaceUserPreferencesJson(id, { agentModelOverrides: {} });
    expect(getUserPreferencesRow(id).agentModelOverrides).toBeUndefined();
  });

  it('drops malformed model-override entries on read', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          agentModelOverrides: {
            good: 'claude-opus-4-8',
            empty: '   ', // blank → dropped
            wrongType: { model: 'x' }, // non-string → dropped
          },
        }),
        id,
      );
    const loaded = getUserPreferencesRow(id);
    expect(loaded.agentModelOverrides).toEqual({ good: 'claude-opus-4-8' });
  });

  it('merge updates one sub-map without clobbering the other', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      agentEngineOverrides: { reviewer: { engine: 'codex-cli' } },
    });
    // Merging only the model map must leave the engine map intact.
    mergeUserPreferencesJson(id, { agentModelOverrides: { 'agent-hub': 'claude-opus-4-8' } });
    const loaded = getUserPreferencesRow(id);
    expect(loaded.agentEngineOverrides?.reviewer).toEqual({ engine: 'codex-cli' });
    expect(loaded.agentModelOverrides).toEqual({ 'agent-hub': 'claude-opus-4-8' });
  });

  it('round-trips the sidebar collapsed-projects list and clears on empty', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, { sidebarCollapsedProjects: ['alpha', 'beta'] });
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toEqual(['alpha', 'beta']);

    replaceUserPreferencesJson(id, { sidebarCollapsedProjects: [] });
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toBeUndefined();
  });

  it('merging the collapsed list leaves the override maps intact and vice versa', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      agentEngineOverrides: { reviewer: { engine: 'codex-cli' } },
    });
    mergeUserPreferencesJson(id, { sidebarCollapsedProjects: ['alpha'] });
    let loaded = getUserPreferencesRow(id);
    expect(loaded.agentEngineOverrides?.reviewer).toEqual({ engine: 'codex-cli' });
    expect(loaded.sidebarCollapsedProjects).toEqual(['alpha']);

    mergeUserPreferencesJson(id, { agentModelOverrides: { 'agent-hub': 'claude-opus-4-8' } });
    loaded = getUserPreferencesRow(id);
    expect(loaded.sidebarCollapsedProjects).toEqual(['alpha']);
  });

  it('normalizes malformed collapsed-project entries on read', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          sidebarCollapsedProjects: ['  alpha  ', '', 'alpha', 42, null, 'beta'],
        }),
        id,
      );
    // trimmed, blanks/non-strings dropped, de-duplicated, order preserved
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toEqual(['alpha', 'beta']);
  });

  it('ignores a non-array collapsed-projects value', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(JSON.stringify({ sidebarCollapsedProjects: { alpha: true } }), id);
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toBeUndefined();
  });

  it('runs the read-modify-write inside a single transaction', () => {
    // The endpoint contract advertises "merges server-side"; that is only true
    // if the read and the write are atomic. Pinning `inTransaction` keeps a
    // future refactor from quietly splitting them back apart.
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    expect(getOrgsDb().inTransaction).toBe(false);
    let sawTransaction = false;
    mutateUserPreferencesJson(id, (current) => {
      sawTransaction = getOrgsDb().inTransaction;
      return { ...current, sidebarCollapsedProjects: ['alpha'] };
    });
    expect(sawTransaction).toBe(true);
    expect(getOrgsDb().inTransaction).toBe(false);
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toEqual(['alpha']);
  });

  it('mutate sees the latest stored state and composes across calls', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    mutateUserPreferencesJson(id, (c) => ({ ...c, sidebarCollapsedProjects: ['alpha'] }));
    const seen: string[][] = [];
    mutateUserPreferencesJson(id, (c) => {
      seen.push(c.sidebarCollapsedProjects ?? []);
      return { ...c, sidebarCollapsedProjects: [...(c.sidebarCollapsedProjects ?? []), 'beta'] };
    });
    expect(seen).toEqual([['alpha']]);
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toEqual(['alpha', 'beta']);
  });

  it('rolls the row back when the mutator throws', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, { sidebarCollapsedProjects: ['alpha'] });
    expect(() =>
      mutateUserPreferencesJson(id, () => {
        throw new Error('rejected');
      }),
    ).toThrow('rejected');
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toEqual(['alpha']);
    expect(getOrgsDb().inTransaction).toBe(false);
  });

  it('caps the persisted collapsed-projects list', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    const many = Array.from({ length: MAX_SIDEBAR_COLLAPSED_PROJECTS + 25 }, (_, i) => `p${i}`);
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(JSON.stringify({ sidebarCollapsedProjects: many }), id);
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toHaveLength(
      MAX_SIDEBAR_COLLAPSED_PROJECTS,
    );
  });

  // ── Clearing semantics, asserted against the RAW column ─────────────────
  //
  // Every other test here reads back through `getUserPreferencesRow`, which
  // normalizes — so it cannot distinguish "the key was deleted" from "the key
  // is still there holding a value that normalizes away". These assert on the
  // stored JSON text directly, and pin the whole-column-replacement contract
  // that clearing depends on: `replaceUserPreferencesJson` builds its payload
  // from scratch, so a field the caller omits is *absent* from the write, not
  // inherited from the previous row. Turning it into a merge would strand a
  // cleared preference forever, and the failure would only show on a later GET.

  const rawPrefs = (id: string) =>
    (
      getOrgsDb().prepare('SELECT preferences_json FROM users WHERE id = ?').get(id) as {
        preferences_json: string | null;
      }
    ).preferences_json;

  it('replace drops a field the caller omits rather than inheriting it', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      sidebarCollapsedProjects: ['alpha'],
      todoAutoCompleteOnPromote: true,
    });
    expect(rawPrefs(id)).toContain('sidebarCollapsedProjects');

    // The expand path: same call, this field now undefined.
    replaceUserPreferencesJson(id, {
      sidebarCollapsedProjects: undefined,
      todoAutoCompleteOnPromote: true,
    });
    expect(rawPrefs(id)).not.toContain('sidebarCollapsedProjects');
    expect(JSON.parse(rawPrefs(id) as string)).toEqual({ todoAutoCompleteOnPromote: true });
    expect(getUserPreferencesRow(id).sidebarCollapsedProjects).toBeUndefined();
  });

  it('replace with an empty list clears the key from the stored JSON', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, { sidebarCollapsedProjects: ['alpha'] });
    replaceUserPreferencesJson(id, { sidebarCollapsedProjects: [] });
    // Last preference gone → the whole column is nulled, not left as `{}`.
    expect(rawPrefs(id)).toBeNull();
  });

  it('merge clears the collapsed list without touching its neighbours', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    replaceUserPreferencesJson(id, {
      sidebarCollapsedProjects: ['alpha'],
      agentModelOverrides: { reviewer: 'gpt-5-codex' },
    });
    mergeUserPreferencesJson(id, { sidebarCollapsedProjects: [] });

    expect(JSON.parse(rawPrefs(id) as string)).toEqual({
      agentModelOverrides: { reviewer: 'gpt-5-codex' },
    });
  });

  it('round-trips hubDailySummary and drops an incomplete blob', () => {
    const id = uuidv4();
    createUser({
      id,
      username: `u_${id.replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'x',
    });
    const summary = {
      date: '2026-08-19',
      timeZone: 'America/Chicago',
      markdown: '## Today\n- shipped Daily Summary',
      engine: 'claude-code',
      model: 'claude-opus-4-6',
      generatedAt: '2026-08-19T18:00:00.000Z',
    };
    mergeUserPreferencesJson(id, { hubDailySummary: summary });
    expect(getUserPreferencesRow(id).hubDailySummary).toEqual(summary);

    mergeUserPreferencesJson(id, {
      hubDailySummary: {
        date: '',
        markdown: '',
        timeZone: '',
        engine: '',
        model: '',
        generatedAt: '',
      },
    });
    expect(getUserPreferencesRow(id).hubDailySummary).toBeUndefined();
  });
});
