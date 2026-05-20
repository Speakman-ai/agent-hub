#!/usr/bin/env -S npx tsx
/**
 * Format release notes for a tagged release.
 *
 * Reads raw `git log` output from stdin (one commit per line, format
 * `- <subject> (<short-hash>)`) and emits a Markdown release-notes document
 * grouped by Conventional Commits category.
 *
 * Usage (inside the release workflow — invoked via tsx because the server
 * is TypeScript-source / no build step):
 *   git log --pretty='- %s (%h)' <prev>..HEAD \
 *     | npx tsx server/scripts/format-release-notes.ts \
 *         --version v1.2.3 --previous v1.2.2 \
 *     > notes.md
 *
 * The companion test for the underlying parser lives at
 * `server/release-notes-parse.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { parseLogLine, renderReleaseNotes, parseArgs } from '../release-notes-parse.js';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || typeof args.version !== 'string') {
    process.stderr.write('error: --version <tag> is required\n');
    process.exit(2);
  }
  const raw = readStdin();
  const commits = raw
    .split('\n')
    .map(parseLogLine)
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const md = renderReleaseNotes({
    version: args.version,
    previous: args.previous && args.previous !== 'true' ? String(args.previous) : null,
    commits,
    repo: args.repo && args.repo !== 'true' ? String(args.repo) : null,
  });
  process.stdout.write(md);
}

const invoked = process.argv[1] && /format-release-notes\.(ts|mjs|js)$/.test(process.argv[1]);
if (invoked) {
  main();
}
