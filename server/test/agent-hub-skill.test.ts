/**
 * Consolidated agent-hub skill regression suite.
 *
 * Folds five tiny meta-tests into a single file so the vitest cold-start tax
 * (~430ms per file) is paid once instead of five times. Each describe() block
 * below was previously a standalone file:
 *
 *   agent-hub-skill-coverage.test.ts        — required-surface markers in skill markdown
 *   agent-hub-skill-distribution.test.ts    — scripts/ executable bits + cpSync sync path
 *   agent-hub-skill-evals.test.ts           — eval JSON shape + run.mjs --dry-run
 *   agent-hub-skill-no-prod-infra.test.ts   — forbidden production-infrastructure strings
 *   agent-hub-skill-shape.test.ts           — SKILL.md frontmatter + body invariants
 *
 * All five share the same skill-dir constants and roughly the same fs helpers,
 * so they collapse cleanly without losing assertion coverage.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'agent-hub');
const PLUGIN_SKILL_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub');
const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugin');
const DEFAULT_EVALS = path.join(DEFAULT_SKILL_DIR, 'evals');
const PLUGIN_EVALS = path.join(PLUGIN_SKILL_DIR, 'evals');

// --- shared fs helpers --------------------------------------------------

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

function assertExecutable(file: string, label: string): void {
  const mode = statSync(file).mode;
  const isExec = (mode & 0o111) !== 0;
  expect(isExec, `${label}: ${file} is missing the executable bit (mode=${mode.toString(8)})`).toBe(
    true,
  );
}

// =====================================================================
// 1) Coverage — every agent-facing surface gets a distinctive marker
// =====================================================================

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

describe('agent-hub skill — required surface coverage', () => {
  it('server/default-skills/agent-hub/ mentions every required surface', () => {
    expect(existsSync(DEFAULT_SKILL_DIR)).toBe(true);
    assertAllMarkersPresent(DEFAULT_SKILL_DIR, 'default-skills');
  });

  it('plugin/skills/agent-hub/ mentions every required surface (if shipped)', () => {
    if (!existsSync(PLUGIN_SKILL_DIR)) return;
    assertAllMarkersPresent(PLUGIN_SKILL_DIR, 'plugin skill');
  });

  it('coverage markers are specific enough to fail on accidental deletion', () => {
    const minimalCorpus = '---\nname: agent-hub\n---\n# Just a title\n';
    const missing = REQUIRED_MARKERS.filter(({ patterns }) =>
      patterns.some((rx) => !rx.test(minimalCorpus)),
    );
    expect(missing.length).toBe(REQUIRED_MARKERS.length);
  });
});

// =====================================================================
// 2) Distribution — scripts/ executable bits + cpSync preserves modes
// =====================================================================

const STRUCTURE_DIRS = ['scripts', 'references', 'evals'] as const;

describe('agent-hub skill — distribution integrity', () => {
  it.each([
    ['default-skills', DEFAULT_SKILL_DIR],
    ['plugin mirror', PLUGIN_SKILL_DIR],
  ])('%s ships the full structure (scripts/, references/, evals/)', (label, dir) => {
    if (label === 'plugin mirror' && !existsSync(dir)) return;
    for (const sub of STRUCTURE_DIRS) {
      expect(existsSync(path.join(dir, sub)), `${label}: ${sub}/ missing from ${dir}`).toBe(true);
    }
  });

  it.each([
    ['default-skills', DEFAULT_SKILL_DIR],
    ['plugin mirror', PLUGIN_SKILL_DIR],
  ])('%s ships every scripts/*.sh with the executable bit set', (label, dir) => {
    if (label === 'plugin mirror' && !existsSync(dir)) return;
    const scriptsDir = path.join(dir, 'scripts');
    const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'));
    expect(scripts.length, `${label}: scripts/ is empty`).toBeGreaterThan(0);
    for (const name of scripts) {
      assertExecutable(path.join(scriptsDir, name), label);
    }
  });

  it('cpSync (the plugin sync path) preserves executable bits end-to-end', () => {
    if (!existsSync(PLUGIN_ROOT)) return;
    const tmpDest = path.join(os.tmpdir(), `agent-hub-skill-sync-${Date.now()}`);
    try {
      mkdirSync(tmpDest, { recursive: true });
      cpSync(PLUGIN_ROOT, tmpDest, { recursive: true });
      const copiedScripts = path.join(tmpDest, 'skills', 'agent-hub', 'scripts');
      expect(
        existsSync(copiedScripts),
        `sync destination is missing skills/agent-hub/scripts/`,
      ).toBe(true);
      const scripts = readdirSync(copiedScripts).filter((f) => f.endsWith('.sh'));
      expect(scripts.length, 'sync destination scripts/ is empty').toBeGreaterThan(0);
      for (const name of scripts) {
        assertExecutable(path.join(copiedScripts, name), 'sync destination');
      }
    } finally {
      rmSync(tmpDest, { recursive: true, force: true });
    }
  });

  it('cpSync preserves the executable bit on a freshly chmod +x script', () => {
    const tmpSrc = path.join(os.tmpdir(), `cp-mode-src-${Date.now()}`);
    const tmpDst = path.join(os.tmpdir(), `cp-mode-dst-${Date.now()}`);
    try {
      mkdirSync(path.join(tmpSrc, 'scripts'), { recursive: true });
      const scriptPath = path.join(tmpSrc, 'scripts', 'probe.sh');
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho probe\n');
      chmodSync(scriptPath, 0o755);
      cpSync(tmpSrc, tmpDst, { recursive: true });
      assertExecutable(path.join(tmpDst, 'scripts', 'probe.sh'), 'probe');
    } finally {
      rmSync(tmpSrc, { recursive: true, force: true });
      rmSync(tmpDst, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// 3) Evals — JSON shape + run.mjs --dry-run
// =====================================================================

const REQUIRED_EVAL_IDS = ['create-ticket', 'move-card', 'search-wiki'];
const VALID_MATCHER_TYPES = new Set([
  'contains',
  'not_contains',
  'contains_any',
  'not_contains_any',
  'regex',
  'mentions_script',
  'mentions_any_script',
  'references_file',
]);

type EvalFile = {
  id: string;
  description: string;
  skills: string[];
  query: string;
  files?: string[];
  expected_behavior: Array<{
    type: string;
    value: string | string[];
    rationale?: string;
  }>;
};

function loadEvals(dir: string): EvalFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as EvalFile);
}

function assertEvalShape(dir: string, label: string): void {
  expect(existsSync(dir), `${label}: evals/ directory missing`).toBe(true);
  const evals = loadEvals(dir);

  const ids = new Set(evals.map((e) => e.id));
  for (const required of REQUIRED_EVAL_IDS) {
    expect(ids.has(required), `${label}: missing required eval "${required}.json"`).toBe(true);
  }

  const seen = new Set<string>();
  for (const e of evals) {
    expect(seen.has(e.id), `${label}: duplicate eval id "${e.id}"`).toBe(false);
    seen.add(e.id);
  }

  for (const ev of evals) {
    const tag = `${label}/${ev.id}`;
    expect(typeof ev.id, `${tag}: id must be string`).toBe('string');
    expect(typeof ev.description, `${tag}: description must be string`).toBe('string');
    expect(Array.isArray(ev.skills), `${tag}: skills must be array`).toBe(true);
    expect(ev.skills.length, `${tag}: skills must be non-empty`).toBeGreaterThan(0);
    expect(typeof ev.query, `${tag}: query must be string`).toBe('string');
    expect(ev.query.length, `${tag}: query must be non-trivial`).toBeGreaterThan(10);
    expect(Array.isArray(ev.expected_behavior), `${tag}: expected_behavior must be array`).toBe(
      true,
    );
    expect(
      ev.expected_behavior.length,
      `${tag}: expected_behavior must have >=1 entry`,
    ).toBeGreaterThan(0);
    expect(ev.skills.includes('agent-hub'), `${tag}: skills must list "agent-hub"`).toBe(true);

    for (const [i, b] of ev.expected_behavior.entries()) {
      const btag = `${tag}.expected_behavior[${i}]`;
      expect(
        VALID_MATCHER_TYPES.has(b.type),
        `${btag}: unknown matcher type "${b.type}" (valid: ${[...VALID_MATCHER_TYPES].join(', ')})`,
      ).toBe(true);
      expect('value' in b, `${btag}: missing "value"`).toBe(true);

      const wantsArray = ['contains_any', 'not_contains_any', 'mentions_any_script'];
      if (wantsArray.includes(b.type)) {
        expect(
          Array.isArray(b.value),
          `${btag}: type "${b.type}" requires value to be an array`,
        ).toBe(true);
        expect(
          (b.value as string[]).length,
          `${btag}: type "${b.type}" requires non-empty array`,
        ).toBeGreaterThan(0);
      } else if (b.type === 'regex') {
        expect(() => new RegExp(b.value as string), `${btag}: regex must compile`).not.toThrow();
      } else {
        expect(typeof b.value, `${btag}: type "${b.type}" requires string value`).toBe('string');
      }
    }

    if (ev.files) {
      const repoRoot = path.join(__dirname, '..', '..');
      for (const rel of ev.files) {
        expect(
          existsSync(path.join(repoRoot, rel)),
          `${tag}: files entry "${rel}" does not exist`,
        ).toBe(true);
      }
    }
  }
}

function assertRunnerShape(dir: string, label: string): void {
  const runner = path.join(dir, 'run.mjs');
  expect(existsSync(runner), `${label}: run.mjs missing`).toBe(true);
  const mode = statSync(runner).mode;
  expect(Boolean(mode & 0o111), `${label}: run.mjs must be executable`).toBe(true);
  expect(() => {
    execFileSync('node', [runner, '--dry-run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
  }, `${label}: run.mjs --dry-run must exit 0`).not.toThrow();
}

describe('agent-hub skill — evals harness', () => {
  it('default-skills/agent-hub/evals has the required scenarios in a valid shape', () => {
    assertEvalShape(DEFAULT_EVALS, 'default-skills');
  });

  it('default-skills/agent-hub/evals ships a runnable run.mjs', () => {
    assertRunnerShape(DEFAULT_EVALS, 'default-skills');
  });

  it('plugin/skills/agent-hub/evals stays in sync with default-skills', () => {
    if (!existsSync(PLUGIN_EVALS)) return;
    assertEvalShape(PLUGIN_EVALS, 'plugin');
    assertRunnerShape(PLUGIN_EVALS, 'plugin');

    const defaults = readdirSync(DEFAULT_EVALS)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const plugins = readdirSync(PLUGIN_EVALS)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(plugins, 'plugin evals list mismatch vs default-skills').toEqual(defaults);
    for (const name of defaults) {
      const a = readFileSync(path.join(DEFAULT_EVALS, name), 'utf8');
      const b = readFileSync(path.join(PLUGIN_EVALS, name), 'utf8');
      expect(a, `plugin/skills/agent-hub/evals/${name} diverges from default-skills`).toBe(b);
    }
  });
});

// =====================================================================
// 4) No prod infra — forbidden hostname/bucket/IAM/PM2 strings
// =====================================================================

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
  {
    label: 'public IPv4 literal',
    regex:
      /\b(?!127\.|10\.|0\.0\.0\.0|255\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  },
];

function scanSkillDir(skillDir: string): Array<{ file: string; pattern: string; match: string }> {
  const hits: Array<{ file: string; pattern: string; match: string }> = [];
  for (const file of collectMarkdownFiles(skillDir)) {
    const content = readFileSync(file, 'utf8');
    for (const { label, regex } of FORBIDDEN_PATTERNS) {
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

describe('agent-hub skill — no production infrastructure leaks', () => {
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
    expect(body).toMatch(/<your-host>/);
  });
});

// =====================================================================
// 5) SKILL.md shape — frontmatter + body invariants
// =====================================================================

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_BODY_LINES = 200;

const REQUIRED_TRIGGER_TERMS = [
  'kanban',
  'wiki',
  'sessions',
  'heartbeats',
  'crons',
  'epics',
  'delegation',
  'Agent Hub API',
  'http://localhost:3051',
];

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  bodyLines: number;
}

function parseSkill(skillDir: string): ParsedSkill {
  const file = path.join(skillDir, 'SKILL.md');
  const content = readFileSync(file, 'utf8');
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`SKILL.md missing frontmatter: ${file}`);
  const fm = m[1];
  const body = m[2];

  const nameMatch = fm.match(/^name:\s*(\S+)\s*$/m);
  if (!nameMatch) throw new Error(`SKILL.md missing 'name' field: ${file}`);
  const name = nameMatch[1];

  const descMatch = fm.match(/description:\s*>-?\s*\n((?:[ \t]+.+\n)+)/);
  if (!descMatch) throw new Error(`SKILL.md missing folded 'description': ${file}`);
  const description = descMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');

  return {
    name,
    description,
    body,
    bodyLines: body.split('\n').length - 1,
  };
}

function assertSkillShape(skillDir: string, label: string): void {
  expect(existsSync(skillDir), `missing skill dir: ${label}`).toBe(true);
  const { name, description, body, bodyLines } = parseSkill(skillDir);

  expect(name.length, `${label}: name longer than ${MAX_NAME} chars`).toBeLessThanOrEqual(MAX_NAME);
  expect(name, `${label}: name must be kebab-case`).toMatch(/^[a-z][a-z0-9-]*$/);

  expect(
    description.length,
    `${label}: description longer than ${MAX_DESCRIPTION} chars (got ${description.length})`,
  ).toBeLessThanOrEqual(MAX_DESCRIPTION);

  const lowerDesc = description.toLowerCase();
  const hit = REQUIRED_TRIGGER_TERMS.filter((t) => lowerDesc.includes(t.toLowerCase()));
  expect(
    hit.length,
    `${label}: description mentions only ${hit.length}/${REQUIRED_TRIGGER_TERMS.length} trigger terms — hits: ${JSON.stringify(hit)}`,
  ).toBeGreaterThanOrEqual(8);

  expect(
    bodyLines,
    `${label}: body is ${bodyLines} lines; keep it under ${MAX_BODY_LINES}`,
  ).toBeLessThan(MAX_BODY_LINES);

  const fenceRe = /```(bash|sh|shell)?\n([\s\S]*?)```/g;
  const violatingFences: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(body)) !== null) {
    const lang = (fm[1] || '').toLowerCase();
    const inner = fm[2];
    const looksShellish =
      lang === 'bash' || lang === 'sh' || lang === 'shell' || /curl\s/.test(inner);
    if (!looksShellish) continue;
    if (/\bcurl\b/.test(inner)) {
      violatingFences.push(inner.slice(0, 200));
    }
  }
  expect(
    violatingFences,
    `${label}: body contains raw curl outside scripts/ wrappers:\n${violatingFences.join('\n---\n')}`,
  ).toEqual([]);

  expect(body, `${label}: body never points at references/`).toMatch(/references\/[\w.-]+\.md/);
  expect(body, `${label}: body never points at scripts/`).toMatch(/scripts\/[\w.-]+\.sh/);
}

function assertScriptsPresent(skillDir: string, label: string): void {
  const scriptsDir = path.join(skillDir, 'scripts');
  expect(existsSync(scriptsDir), `${label}: scripts/ missing`).toBe(true);
  expect(
    existsSync(path.join(scriptsDir, '_common.sh')),
    `${label}: scripts/_common.sh missing`,
  ).toBe(true);

  const body = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const referenced = new Set(Array.from(body.matchAll(/scripts\/([\w.-]+\.sh)/g), (m) => m[1]));
  const present = new Set(readdirSync(scriptsDir).filter((f) => f.endsWith('.sh')));
  for (const name of referenced) {
    expect(
      present.has(name),
      `${label}: SKILL.md references scripts/${name} but file is missing`,
    ).toBe(true);
  }
}

function assertReferencesPresent(skillDir: string, label: string): void {
  const refsDir = path.join(skillDir, 'references');
  expect(existsSync(refsDir), `${label}: references/ missing`).toBe(true);
  const body = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const referenced = new Set(Array.from(body.matchAll(/references\/([\w.-]+\.md)/g), (m) => m[1]));
  const present = new Set(readdirSync(refsDir).filter((f) => f.endsWith('.md')));
  for (const name of referenced) {
    expect(
      present.has(name),
      `${label}: SKILL.md references references/${name} but file is missing`,
    ).toBe(true);
  }
}

describe('agent-hub SKILL.md — discovery rewrite shape', () => {
  it('default-skills/agent-hub frontmatter + body pass the shape invariants', () => {
    assertSkillShape(DEFAULT_SKILL_DIR, 'default-skills');
  });

  it('default-skills/agent-hub ships all referenced scripts/*.sh', () => {
    assertScriptsPresent(DEFAULT_SKILL_DIR, 'default-skills');
  });

  it('default-skills/agent-hub ships all referenced references/*.md', () => {
    assertReferencesPresent(DEFAULT_SKILL_DIR, 'default-skills');
  });

  it('plugin/skills/agent-hub stays in sync (shape)', () => {
    if (!existsSync(PLUGIN_SKILL_DIR)) return;
    assertSkillShape(PLUGIN_SKILL_DIR, 'plugin skill');
    assertScriptsPresent(PLUGIN_SKILL_DIR, 'plugin skill');
    assertReferencesPresent(PLUGIN_SKILL_DIR, 'plugin skill');
  });
});
