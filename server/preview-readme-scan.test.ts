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
});
