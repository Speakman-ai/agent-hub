import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Keep the top-level README honest about commands, screenshots, and config.
 * These claims are what a first-time clone reads before any code.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const PKG_PATH = join(REPO_ROOT, 'package.json');

function readme(): string {
  return readFileSync(README_PATH, 'utf8');
}

describe('README accuracy', () => {
  const text = readme();
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('describes npm test as the full monorepo suite, not server-only', () => {
    // Root `npm test` runs every package; the old table said "Run server tests".
    expect(pkg.scripts.test).toContain('test:client');
    expect(pkg.scripts.test).toContain('test:server');
    expect(pkg.scripts.test).toContain('test:electron');
    expect(pkg.scripts.test).toContain('test:mobile');
    expect(pkg.scripts.test).toContain('test:shared');
    expect(text).not.toMatch(/`npm test`\s*\|\s*Run server tests\s*\|/);
    expect(text).toMatch(
      /`npm test`\s*\|\s*Run client, server, electron, mobile, and shared tests\s*\|/,
    );
  });

  it('embeds committed docs/media stills instead of GitHub user-attachments', () => {
    expect(text).not.toMatch(/github\.com\/user-attachments\/assets\//);
    expect(text).toContain('docs/media/finalize.png');
    expect(text).toContain('docs/media/replay.png');
    expect(existsSync(join(REPO_ROOT, 'docs/media/finalize.png'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'docs/media/replay.png'))).toBe(true);
  });

  it('includes grokBin in the config.json example', () => {
    const example = text.match(/```json\n([\s\S]*?)```/);
    expect(example?.[1]).toMatch(/"grokBin"\s*:/);
  });

  it('does not claim API auth is optional', () => {
    expect(text).not.toMatch(/Auth is optional/i);
    expect(text).toMatch(/\/api\/auth\/setup/);
    expect(text).toMatch(/break-glass/);
  });
});
