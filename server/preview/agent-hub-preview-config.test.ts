import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Agent Hub preview config', () => {
  it('preserves image-installed dependencies under the worktree bind mount', () => {
    const raw = readFileSync(path.join(repoRoot, '.agent-hub', 'preview.json'), 'utf8');
    const config = JSON.parse(raw) as {
      prEnv?: { preview?: { compose?: { shadowDirs?: string[] } } };
    };

    const shadowDirs = config.prEnv?.preview?.compose?.shadowDirs ?? [];
    expect(shadowDirs).toContain('client/node_modules');
    expect(shadowDirs).toContain('server/node_modules');
  });
});
