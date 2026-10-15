import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { findInternalTokens } from './test/internal-tokens.js';

/**
 * Guard against internal-only identifiers (the private project name and org
 * handle) anywhere in the tracked tree or in this branch's commit messages.
 * The tokens live as hashes in `test/internal-tokens.ts`, so nothing here
 * names them.
 *
 * Only the branch's own commits are scanned: history already on main is
 * cleaned by `scripts/history-scrub/`, and merge commits written by the Hub
 * pass through `commit-message-redaction.ts`. Scanning main here would fail
 * every branch for a commit none of them wrote.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

describe('no internal provenance leaks', () => {
  it('no tracked file contains an internal-only identifier', () => {
    const offenders: string[] = [];
    for (const rel of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
      const abs = join(REPO_ROOT, rel);
      let buf: Buffer;
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue; // deleted in the working tree, or a submodule/dir entry
      }
      if (buf.includes(0)) continue; // binary
      const hits = findInternalTokens(rel + '\n' + buf.toString('utf8'));
      if (hits.length) offenders.push(`${rel} [${hits.join(', ')}]`);
    }
    expect(offenders, `Internal identifiers found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no commit message on this branch contains an internal-only identifier', () => {
    let range = ['-1', 'HEAD'];
    try {
      git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
      range = ['refs/remotes/origin/main..HEAD'];
    } catch {
      // No origin/main in this clone (shallow CI checkout): check HEAD only.
    }
    const log = git(['log', ...range, '--format=%H%x00%B%x00']);
    const parts = log.split('\0');
    const offenders: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].trim();
      const hits = findInternalTokens(parts[i + 1]);
      if (hits.length) offenders.push(`${sha.slice(0, 12)} [${hits.join(', ')}]`);
    }
    expect(
      offenders,
      `Internal identifiers found in commit messages:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
