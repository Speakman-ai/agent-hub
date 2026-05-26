import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectPreviewEnvironmentDraft } from './preview-environment-draft.js';

describe('collectPreviewEnvironmentDraft', () => {
  it('returns bootstrap phase with env vars and script hints for vite repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-env-draft-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '1' }, scripts: { dev: 'vite' } }),
    );
    writeFileSync(path.join(dir, 'README.md'), 'Use API_KEY in docker compose.\n');
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\n');

    const draft = collectPreviewEnvironmentDraft(dir);
    expect(draft.phase).toBe('bootstrap_compose');
    expect(draft.bootstrap?.composeYaml).toMatch(/services:/);
    expect(draft.envVars.some((v) => v.key === 'API_KEY')).toBe(true);
    expect(draft.scriptHints.length).toBeGreaterThan(0);
    expect(draft.composeChecklist.length).toBeGreaterThan(0);
    // After dropping the always-CHECK manual rows, every checklist item
    // must resolve to a real verdict — no perpetually-unresolved entries.
    for (const item of draft.composeChecklist) {
      expect(['pass', 'warn', 'fail']).toContain(item.status);
    }
    expect(draft.composeChecklist.some((i) => i.id === 'compose-file-readable')).toBe(true);
  });
});
