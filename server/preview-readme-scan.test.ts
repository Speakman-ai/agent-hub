import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { scanReadme, scanEnvExample, mergeEnvVarSuggestions } from './preview-readme-scan.js';

describe('preview-readme-scan', () => {
  it('extracts docker excerpt and env keys from README', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-readme-'));
    writeFileSync(
      path.join(dir, 'README.md'),
      '# App\n\nRun with docker compose:\n\n```\nexport MY_API_TOKEN=xxx\n```\n',
    );
    const readme = scanReadme(dir);
    expect(readme.hasDockerHints).toBe(true);
    expect(readme.setupExcerpt).toMatch(/docker compose/i);
    expect(readme.envKeysFromReadme).toContain('MY_API_TOKEN');
  });

  it('merges env suggestions from source, readme, and env example', () => {
    const merged = mergeEnvVarSuggestions(
      ['FROM_SOURCE'],
      {
        readmePath: 'README.md',
        setupExcerpt: null,
        hasDockerHints: false,
        envKeysFromReadme: ['FROM_README'],
      },
      { envExamplePath: '.env.example', keys: ['FROM_EXAMPLE'], requiredKeys: ['FROM_EXAMPLE'] },
    );
    expect(merged.map((m) => m.key)).toEqual(['FROM_EXAMPLE', 'FROM_README', 'FROM_SOURCE']);
    expect(merged.find((m) => m.key === 'FROM_EXAMPLE')?.required).toBe(true);
  });

  it('drops reserved-namespace keys so they are never suggested for preview env', () => {
    // Regression: a project that calls the Hub API references AGENT_HUB_API_KEY
    // in its source / .env, which pre-filled the Preview settings form and made
    // "Build and run" 400 (the secrets store rejects the reserved namespace).
    const merged = mergeEnvVarSuggestions(
      ['AGENT_HUB_API_KEY', 'AGENT_HUB_URL', 'KEEP_ME'],
      {
        readmePath: 'README.md',
        setupExcerpt: null,
        hasDockerHints: false,
        envKeysFromReadme: ['NODE_ENV', 'PATH'],
      },
      { envExamplePath: '.env.example', keys: ['HOME', 'ALSO_KEEP'], requiredKeys: [] },
    );
    const keys = merged.map((m) => m.key);
    expect(keys).toEqual(['ALSO_KEEP', 'KEEP_ME']);
    for (const reserved of ['AGENT_HUB_API_KEY', 'AGENT_HUB_URL', 'NODE_ENV', 'PATH', 'HOME']) {
      expect(keys).not.toContain(reserved);
    }
  });
});
