import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

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

// `.cursor/` holds local agent config including `.cursor/agent-hub.env`, which
// carries an API key. We deliberately unignore `.cursor/rules/` so the shared
// convention files are reviewable, and that negation is the dangerous part:
// unignoring the directory alone makes every descendant trackable, so a stray
// `.cursor/rules/secret.txt` gets swept up by a later `git add .`. Only `*.mdc`
// may be trackable.
describe('.gitignore scopes the .cursor/rules negation to rule files', () => {
  // Hermetic: apply the committed .gitignore inside a throwaway repo so the
  // assertion holds even when the suite runs outside a git checkout.
  let scratch = '';

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'gitignore-cursor-'));
    const init = spawnSync('git', ['init', '-q'], { cwd: scratch, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    writeFileSync(
      join(scratch, '.gitignore'),
      readFileSync(resolve(repoRoot, '.gitignore'), 'utf8'),
    );
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const isIgnored = (path: string) =>
    spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: scratch, encoding: 'utf8' })
      .status === 0;

  for (const path of [
    '.cursor/agent-hub.env',
    '.cursor/mcp.json',
    '.cursor/rules/secret.txt',
    '.cursor/rules/.env',
    '.cursor/rules/nested/credentials.json',
  ]) {
    it(`ignores ${path}`, () => {
      expect(isIgnored(path)).toBe(true);
    });
  }

  for (const path of ['.cursor/rules/git-hosted-on-agent-hub.mdc', '.cursor/rules/nested/x.mdc']) {
    it(`tracks ${path}`, () => {
      expect(isIgnored(path)).toBe(false);
    });
  }
});
