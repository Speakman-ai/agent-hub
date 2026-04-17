#!/usr/bin/env node
/**
 * Format release notes for a tagged release.
 *
 * Reads raw `git log` output from stdin (one commit per line, format
 * `- <subject> (<short-hash>)`) and emits a Markdown release-notes document
 * grouped by Conventional Commits category. Commits that don't match the
 * Conventional Commits pattern fall through into an "Other" section.
 *
 * Usage (inside the release workflow):
 *   git log --pretty='- %s (%h)' <prev>..HEAD \
 *     | node scripts/format-release-notes.mjs --version v1.2.3 --previous v1.2.2 \
 *     > notes.md
 *
 * The logic is exposed as pure functions so it can be unit-tested.
 */

import { readFileSync } from 'node:fs';

const CATEGORIES = [
  { key: 'feat', title: 'Features' },
  { key: 'fix', title: 'Bug Fixes' },
  { key: 'perf', title: 'Performance' },
  { key: 'refactor', title: 'Refactors' },
  { key: 'docs', title: 'Documentation' },
  { key: 'test', title: 'Tests' },
  { key: 'build', title: 'Build' },
  { key: 'ci', title: 'CI' },
  { key: 'chore', title: 'Chores' },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/**
 * Parse a single log line of the form `- <subject> (<short-hash>)` into a
 * structured record. Returns `null` if the line does not match.
 */
export function parseLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Lazy `(.+?)` for the subject combined with the `$`-anchored
  // `([0-9a-f]{6,40})` group means the **last** parenthesized hex group wins.
  // This correctly handles pathological subjects like
  //   `- fix: revert (deadbee) something (a1b2c3d)`
  // where `(deadbee)` is part of the subject and `(a1b2c3d)` is the commit
  // hash appended by `git log --pretty='- %s (%h)'`.
  const m = trimmed.match(/^-\s+(.+?)\s+\(([0-9a-f]{6,40})\)\s*$/i);
  if (!m) return null;
  const subject = m[1];
  const hash = m[2];
  // Conventional Commits: type(scope)?!?: description
  const cc = subject.match(/^([a-z]+)(\([^)]+\))?(!)?:\s*(.+)$/);
  let category = 'other';
  if (cc && CATEGORY_KEYS.has(cc[1].toLowerCase())) {
    category = cc[1].toLowerCase();
  }
  return { subject, hash, category };
}

/**
 * Group parsed commits by category, preserving the documented category order.
 */
export function groupCommits(commits) {
  const groups = new Map();
  for (const c of commits) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  return groups;
}

/**
 * Render a Markdown release-notes document.
 *
 * @param {object} opts
 * @param {string} opts.version  Current release tag (e.g. "v1.2.3")
 * @param {string|null} opts.previous  Previous tag (e.g. "v1.2.2"), or null for first release
 * @param {Array} opts.commits  Parsed commits (see parseLogLine)
 * @param {string} [opts.repo]  GitHub "owner/repo" for the compare link
 */
export function renderReleaseNotes({ version, previous, commits, repo }) {
  const lines = [];
  lines.push(`## ${version}`);
  lines.push('');
  if (commits.length === 0) {
    lines.push('_No user-visible changes since the previous release._');
    lines.push('');
  } else {
    const grouped = groupCommits(commits);
    for (const { key, title } of CATEGORIES) {
      const items = grouped.get(key);
      if (!items || items.length === 0) continue;
      lines.push(`### ${title}`);
      lines.push('');
      for (const c of items) {
        lines.push(`- ${c.subject} (\`${c.hash}\`)`);
      }
      lines.push('');
    }
    const other = grouped.get('other');
    if (other && other.length > 0) {
      lines.push('### Other');
      lines.push('');
      for (const c of other) {
        lines.push(`- ${c.subject} (\`${c.hash}\`)`);
      }
      lines.push('');
    }
  }
  if (previous && repo) {
    lines.push(`**Full Changelog**: https://github.com/${repo}/compare/${previous}...${version}`);
    lines.push('');
  } else if (previous) {
    lines.push(`**Previous release**: ${previous}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Parse CLI arguments of the form `--flag value`.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function readStdin() {
  // Node 20+ supports readFileSync(0)
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    process.stderr.write('error: --version <tag> is required\n');
    process.exit(2);
  }
  const raw = readStdin();
  const commits = raw
    .split('\n')
    .map(parseLogLine)
    .filter((x) => x !== null);
  const md = renderReleaseNotes({
    version: args.version,
    previous: args.previous && args.previous !== 'true' ? args.previous : null,
    commits,
    repo: args.repo && args.repo !== 'true' ? args.repo : null,
  });
  process.stdout.write(md);
}

// Only run main() when executed directly, not when imported by tests.
const invoked = process.argv[1] && process.argv[1].endsWith('format-release-notes.mjs');
if (invoked) {
  main();
}
