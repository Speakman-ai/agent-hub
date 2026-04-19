import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'agent-hub');
const PLUGIN_SKILL_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub');

/**
 * Coverage guard for the `agent-hub` skill (P0 #2).
 *
 * Agents running on Agent Hub itself need the skill doc to reflect what the
 * platform actually does today — not a stale snapshot. Each surface below
 * was added in this batch; if it regresses out of the skill, an agent seeing
 * the doc for the first time will operate with a wrong mental model
 * (missing coordination blocks, wrong auth model, etc.).
 *
 * This test exercises the same "in-skill discovery" path that `wiki_search`
 * hits: grep the shipped markdown and confirm each surface has at least one
 * distinctive marker. Markers are intentionally specific — a passing test
 * means an agent searching for these terms will find content.
 */
const REQUIRED_MARKERS: Array<{ surface: string; patterns: RegExp[] }> = [
  {
    surface: '<delegate> coordination block',
    patterns: [/<delegate>/, /agentId/, /parallel/i],
  },
  {
    surface: '<handoff> coordination block',
    patterns: [/<handoff>/, /toAgent/, /pending.*delivered.*failed|handoffs.*table/i],
  },
  {
    surface: 'Ask Mode (read-only sessions)',
    patterns: [
      /ask[_ ]?mode/i,
      /permission-mode\s+plan|plan\s*mode/i,
      /read[- ]only|analysis|planning/i,
    ],
  },
  {
    surface: '<agenthub:close-card> auto-close',
    patterns: [/<agenthub:close-card>/, /duplicate|already-done/, /session_id|linked card/i],
  },
  {
    surface: 'TOOL_ERROR self-reporting format',
    patterns: [/TOOL_ERROR/, /ISO timestamp/i, /pipe-delimited|\| <tool|one-line summary/i],
  },
  {
    surface: 'Auth Phase 3 (multi-user orgs)',
    patterns: [
      /multi[- ]user|multi[- ]org/i,
      /Owner.*Admin.*User|role hierarchy/i,
      /sole[- ]?Owner/i,
      /uid.*claim|JWT.*uid|`uid`/i,
    ],
  },
  {
    surface: 'Electron desktop shell',
    patterns: [/Electron/i, /no[- ]?Origin|Origin header/i, /userData|app\.getPath|packaged/i],
  },
];

function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readAllSkillMarkdown(skillDir: string): string {
  return collectMarkdownFiles(skillDir)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n\n');
}

function assertAllMarkersPresent(skillDir: string, label: string): void {
  const corpus = readAllSkillMarkdown(skillDir);
  const missing: Array<{ surface: string; unmatched: string[] }> = [];
  for (const { surface, patterns } of REQUIRED_MARKERS) {
    const unmatched = patterns.filter((rx) => !rx.test(corpus)).map((rx) => rx.toString());
    if (unmatched.length > 0) missing.push({ surface, unmatched });
  }
  if (missing.length > 0) {
    throw new Error(`Missing skill coverage in ${label}:\n${JSON.stringify(missing, null, 2)}`);
  }
}

describe('agent-hub skill documents all seven agent-facing surfaces (P0 #2)', () => {
  it('server/default-skills/agent-hub/ mentions every required surface', () => {
    expect(existsSync(DEFAULT_SKILL_DIR)).toBe(true);
    assertAllMarkersPresent(DEFAULT_SKILL_DIR, 'default-skills');
  });

  it('plugin/skills/agent-hub/ mentions every required surface (if shipped)', () => {
    if (!existsSync(PLUGIN_SKILL_DIR)) return;
    assertAllMarkersPresent(PLUGIN_SKILL_DIR, 'plugin skill');
  });

  it('coverage markers are specific enough to fail on accidental deletion', () => {
    // Sanity: a corpus that is just the skill frontmatter should fail.
    const minimalCorpus = '---\nname: agent-hub\n---\n# Just a title\n';
    const missing = REQUIRED_MARKERS.filter(({ patterns }) =>
      patterns.some((rx) => !rx.test(minimalCorpus)),
    );
    expect(missing.length).toBe(REQUIRED_MARKERS.length);
  });
});
