export type ParsedLogLine = {
  subject: string;
  hash: string;
  category: string;
};

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
] as const;

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/** Parse `git log --pretty='- %s (%h)'` lines into structured commits. */
export function parseLogLine(line: string): ParsedLogLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^-\s+(.+?)\s+\(([0-9a-f]{6,40})\)\s*$/i);
  if (!m) return null;
  const subject = m[1];
  const hash = m[2];
  const cc = subject.match(/^([a-z]+)(\([^)]+\))?(!)?:\s*(.+)$/);
  let category = 'other';
  if (cc && CATEGORY_KEYS.has(cc[1].toLowerCase() as (typeof CATEGORIES)[number]['key'])) {
    category = cc[1].toLowerCase();
  }
  return { subject, hash, category };
}

export function groupCommits(commits: ParsedLogLine[]): Map<string, ParsedLogLine[]> {
  const groups = new Map<string, ParsedLogLine[]>();
  for (const c of commits) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category)!.push(c);
  }
  return groups;
}

export function renderReleaseNotes(opts: {
  version: string;
  previous: string | null;
  commits: ParsedLogLine[];
  repo?: string | null;
}): string {
  const { version, previous, commits, repo } = opts;
  const lines: string[] = [];
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

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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
