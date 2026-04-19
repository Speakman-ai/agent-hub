import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'agent-hub');
const PLUGIN_SKILL_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub');

/**
 * Strings that identify Agent Hub's own production infrastructure and must
 * NEVER ship inside the default `agent-hub` skill. The skill is the first
 * thing every self-hosted / multi-tenant install loads, so any real hostname,
 * bucket, IAM role, or PM2 app name in there is an instant audit finding.
 *
 * Keep this list tight and specific — generic words like "EC2" or "PM2" are
 * fine in prose; only the concrete *names* are forbidden.
 */
const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'prod EC2 IP (3.22.232.193)', regex: /3\.22\.232\.193/ },
  { label: 'prod S3 bucket (agent-hub-prod-releases)', regex: /agent-hub-prod-releases/ },
  {
    label: 'prod PM2 instance (agent-hub-prod / agent-hub-prod-2)',
    regex: /agent-hub-prod(-2)?\b/,
  },
  {
    label: 'prod IAM role (agent-hub-github-actions-deploy)',
    regex: /agent-hub-github-actions-deploy/,
  },
  // Any IPv4 address that's not a clearly local/reserved range (127.*, 10.*,
  // 192.168.*, 172.16-31.*, 0.0.0.0, 255.*). We do a soft check: any IPv4
  // literal triggers a match and the allowlist below strips private ranges.
  {
    label: 'public IPv4 literal',
    regex:
      /\b(?!127\.|10\.|0\.0\.0\.0|255\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
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

function scanSkillDir(skillDir: string): Array<{ file: string; pattern: string; match: string }> {
  const hits: Array<{ file: string; pattern: string; match: string }> = [];
  for (const file of collectMarkdownFiles(skillDir)) {
    const content = readFileSync(file, 'utf8');
    for (const { label, regex } of FORBIDDEN_PATTERNS) {
      // Global flag so we can enumerate every offending substring.
      const rx = new RegExp(
        regex.source,
        regex.flags.includes('g') ? regex.flags : regex.flags + 'g',
      );
      let m: RegExpExecArray | null;
      while ((m = rx.exec(content)) !== null) {
        hits.push({ file: path.relative(skillDir, file), pattern: label, match: m[0] });
      }
    }
  }
  return hits;
}

describe('agent-hub skill ships no hardcoded production infrastructure', () => {
  it('server/default-skills/agent-hub/ contains no forbidden strings', () => {
    const hits = scanSkillDir(DEFAULT_SKILL_DIR);
    expect(
      hits,
      `Forbidden strings found in default-skills:\n${JSON.stringify(hits, null, 2)}`,
    ).toEqual([]);
  });

  it('plugin/skills/agent-hub/ contains no forbidden strings (if shipped)', () => {
    if (!existsSync(PLUGIN_SKILL_DIR)) return;
    const hits = scanSkillDir(PLUGIN_SKILL_DIR);
    expect(
      hits,
      `Forbidden strings found in plugin skill:\n${JSON.stringify(hits, null, 2)}`,
    ).toEqual([]);
  });

  it('a deployment-example.md stub exists with placeholder syntax', () => {
    const stub = path.join(DEFAULT_SKILL_DIR, 'references', 'deployment-example.md');
    expect(existsSync(stub)).toBe(true);
    const body = readFileSync(stub, 'utf8');
    // Must use angle-bracket placeholders rather than real infra.
    expect(body).toMatch(/<your-host>/);
  });
});
