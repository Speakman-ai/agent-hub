import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectPreviewSetupDraft } from './preview-setup-draft.js';

describe('collectPreviewSetupDraft', () => {
  it('returns bootstrap_compose when no compose file exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-draft-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { vite: '5.0.0' },
        scripts: { dev: 'vite' },
      }),
    );
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'const x = process.env.MY_APP_TOKEN;\n');

    const draft = collectPreviewSetupDraft(dir);
    expect(draft.isMonorepo).toBe(false);
    expect(draft.phase).toBe('bootstrap_compose');
    expect(draft.detected).toBeNull();
    expect(draft.bootstrap?.file).toBe('docker-compose.yml');
    expect(draft.bootstrap?.entryService).toBe('web');
    expect(draft.bootstrap?.composeYaml).toMatch(/services:/);
    expect(draft.envVars.some((v) => v.key === 'MY_APP_TOKEN')).toBe(true);
  });

  it('returns confirm_compose when docker-compose.yml exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-draft-compose-'));
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      ['services:', '  web:', '    image: nginx', '    ports:', '      - "8080:80"'].join('\n'),
    );

    const draft = collectPreviewSetupDraft(dir);
    expect(draft.phase).toBe('confirm_compose');
    expect(draft.bootstrap).toBeNull();
    expect(draft.detected?.compose.file).toBe('docker-compose.yml');
    expect(draft.detected?.compose.services).toContain('web');
  });
});
