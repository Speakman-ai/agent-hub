import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Regression guard for the pre-publication secret scan (kanban 44de0d69):
// server/remote-orgs.json was committed with real org API keys before it was
// gitignored. This test fails if any instance/runtime file that can hold real
// credentials loses its .gitignore rule, so a secret-bearing config file can
// never silently become committable again.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const gitignoreLines = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('#'));

// Instance/runtime files that can carry real credentials and must never be
// tracked in git.
const REQUIRED_IGNORES = [
  'server/config.json',
  'server/projects.json',
  'server/agents.json',
  'server/remote-orgs.json',
  'server/slack-config.json',
  'server/connection.json',
  'server/active-org.json',
];

describe('.gitignore covers secret-bearing instance config', () => {
  for (const file of REQUIRED_IGNORES) {
    it(`ignores ${file}`, () => {
      expect(gitignoreLines).toContain(file);
    });
  }

  it('ignores dotenv files', () => {
    expect(gitignoreLines).toContain('.env');
    expect(gitignoreLines).toContain('.env.*');
  });

  it('ignores database files', () => {
    expect(gitignoreLines).toContain('*.db');
  });
});
