/**
 * Consolidated agent-hub skill regression suite.
 *
 * Folds five tiny meta-tests into a single file so the vitest cold-start tax
 * (~430ms per file) is paid once instead of five times. Each describe() block
 * below was previously a standalone file:
 *
 *   agent-hub-skill-coverage.test.ts        — required-surface markers in skill markdown
 *   agent-hub-skill-distribution.test.ts    — scripts/ executable bits
 *   agent-hub-skill-evals.test.ts           — eval JSON shape + run.mjs --dry-run
 *   agent-hub-skill-no-prod-infra.test.ts   — forbidden production-infrastructure strings
 *   agent-hub-skill-shape.test.ts           — SKILL.md frontmatter + body invariants
 *
 * All five share the same skill-dir constants and roughly the same fs helpers,
 * so they collapse cleanly without losing assertion coverage.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { loadSkillBody } from '../skill-invoke.js';
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
const DEFAULT_SKILLS_DIR = path.join(__dirname, '..', 'default-skills');
const DEFAULT_SKILL_DIR = path.join(DEFAULT_SKILLS_DIR, 'agent-hub');
const DEFAULT_EVALS = path.join(DEFAULT_SKILL_DIR, 'evals');

// Domain sub-skills introduced by the agent-hub skill split. The core
// `agent-hub` skill is the navigational entry point; each sub-skill owns
// one domain's reference doc and fires only on that domain's vocabulary.
// Shared scripts/ tree lives in the core skill — sub-skills do NOT ship
// their own scripts dir.
const SUB_SKILLS = [
  {
    id: 'agent-hub-kanban',
    dir: path.join(DEFAULT_SKILLS_DIR, 'agent-hub-kanban'),
    reference: 'kanban.md',
    /** Domain-specific markers that MUST appear in this sub-skill's markdown. */
    domainMarkers: [/kanban/i, /board/i, /Done-state contract/i],
  },
  {
    id: 'agent-hub-wiki',
    dir: path.join(DEFAULT_SKILLS_DIR, 'agent-hub-wiki'),
    reference: 'wiki.md',
    domainMarkers: [/wiki/i, /FTS5/, /categor/i],
  },
  {
    id: 'agent-hub-sessions',
    dir: path.join(DEFAULT_SKILLS_DIR, 'agent-hub-sessions'),
    reference: 'sessions.md',
    // close-card / ask-mode / ownership markers consolidate here after
    // the split. Coverage assertion below (REQUIRED_MARKERS) is updated
    // to scan the agent-hub family, but this sub-skill is where the
    // session-flavoured surface should live first.
    domainMarkers: [/<agenthub:close-card>/, /ask[_ ]?mode/i, /owner_user_id/],
  },
  {
    id: 'agent-hub-heartbeats-crons',
    dir: path.join(DEFAULT_SKILLS_DIR, 'agent-hub-heartbeats-crons'),
    reference: 'heartbeats-crons.md',
    domainMarkers: [/heartbeat/i, /cron/i, /thread/i, /node-cron/i],
  },
] as const;

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
    surface: 'no app-level sub-agent dispatch',
    patterns: [/no app-level sub-agent dispatch/i, /peers/i, /conference rooms?/i],
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

function assertAllMarkersPresent(skillDirs: string[], label: string): void {
  // Coverage is measured across the WHOLE agent-hub skill family — the
  // core skill + every domain sub-skill — because the split moved the
  // session-flavoured surfaces (close-card / ask-mode / ownership) out
  // of the core's references/ into agent-hub-sessions'.
  // Concatenating the markdown for the family keeps the assertion
  // honest without requiring every marker to live in the core.
  const corpus = skillDirs
    .filter((d) => existsSync(d))
    .map((d) => readAllSkillMarkdown(d))
    .join('\n\n');
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
  it('server/default-skills/agent-hub family mentions every required surface', () => {
    expect(existsSync(DEFAULT_SKILL_DIR)).toBe(true);
    // Scan the core + all sub-skills as one corpus.
    const family = [DEFAULT_SKILL_DIR, ...SUB_SKILLS.map((s) => s.dir)];
    assertAllMarkersPresent(family, 'default-skills family');
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
  it('default-skills ships the full structure (scripts/, references/, evals/)', () => {
    const label = 'default-skills';
    const dir = DEFAULT_SKILL_DIR;
    for (const sub of STRUCTURE_DIRS) {
      expect(existsSync(path.join(dir, sub)), `${label}: ${sub}/ missing from ${dir}`).toBe(true);
    }
  });

  it('default-skills ships every scripts/*.sh with the executable bit set', () => {
    const label = 'default-skills';
    const dir = DEFAULT_SKILL_DIR;
    const scriptsDir = path.join(dir, 'scripts');
    const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'));
    expect(scripts.length, `${label}: scripts/ is empty`).toBeGreaterThan(0);
    for (const name of scripts) {
      assertExecutable(path.join(scriptsDir, name), label);
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
});

// =====================================================================
// 6) Sub-skills — domain split shape + loader smoke + reference layout
// =====================================================================

// Sub-skills share the core skill's scripts/ tree and are intentionally
// thinner than the core SKILL.md. They DON'T need to enumerate all the
// core trigger terms (the core skill keeps that 8+ term invariant); they
// DO need a kebab-case name, a folded description ≤1024 chars, a body
// ≤200 lines, a reference to their local domain doc, and zero raw curl.

function assertSubSkillShape(
  skillDir: string,
  expectedName: string,
  reference: string,
  label: string,
): void {
  expect(existsSync(skillDir), `${label}: skill dir missing`).toBe(true);
  const { name, description, body, bodyLines } = parseSkill(skillDir);

  expect(name, `${label}: name mismatch`).toBe(expectedName);
  expect(name.length, `${label}: name longer than ${MAX_NAME} chars`).toBeLessThanOrEqual(MAX_NAME);
  expect(name, `${label}: name must be kebab-case`).toMatch(/^[a-z][a-z0-9-]*$/);

  expect(
    description.length,
    `${label}: description longer than ${MAX_DESCRIPTION} chars (got ${description.length})`,
  ).toBeLessThanOrEqual(MAX_DESCRIPTION);
  expect(description.length, `${label}: description should be non-trivial`).toBeGreaterThan(80);

  // Sub-skills must articulate at least one DO NOT TRIGGER guardrail so
  // their narrow trigger surface holds against neighboring vocabulary
  // (Linear, Notion, system crontab, etc.).
  expect(description, `${label}: description missing DO NOT TRIGGER guardrail`).toMatch(
    /DO NOT TRIGGER/,
  );

  expect(
    bodyLines,
    `${label}: body is ${bodyLines} lines; keep it under ${MAX_BODY_LINES}`,
  ).toBeLessThan(MAX_BODY_LINES);

  // Local reference link must point at the domain doc that travels with
  // this sub-skill (sub-skills own their reference, the core does not).
  expect(body, `${label}: body must link to references/${reference}`).toMatch(
    new RegExp(`references/${reference.replace(/\./g, '\\.')}`),
  );

  // No raw curl inside fenced bash blocks — same rule as the core skill.
  const fenceRe = /```(bash|sh|shell)?\n([\s\S]*?)```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(body)) !== null) {
    const lang = (fm[1] || '').toLowerCase();
    const inner = fm[2];
    const looksShellish =
      lang === 'bash' || lang === 'sh' || lang === 'shell' || /curl\s/.test(inner);
    if (!looksShellish) continue;
    expect(
      /\bcurl\b/.test(inner),
      `${label}: body contains raw curl outside scripts/ wrappers`,
    ).toBe(false);
  }

  // Cross-link back to the core skill so navigators can climb up.
  expect(body, `${label}: body must point readers back to the core skill`).toMatch(/agent-hub/i);
}

describe('agent-hub sub-skills — domain split', () => {
  it.each(SUB_SKILLS.map((s) => [s.id, s.dir, s.reference] as const))(
    '%s: SKILL.md frontmatter + body pass sub-skill shape invariants',
    (id, dir, reference) => {
      assertSubSkillShape(dir, id, reference, id);
    },
  );

  it.each(SUB_SKILLS.map((s) => [s.id, s.dir, s.reference] as const))(
    '%s: ships its domain reference doc under references/',
    (_id, dir, reference) => {
      const refPath = path.join(dir, 'references', reference);
      expect(existsSync(refPath), `${reference} missing under ${dir}/references/`).toBe(true);
      const body = readFileSync(refPath, 'utf8');
      expect(body.length, `${refPath} should not be empty`).toBeGreaterThan(200);
    },
  );

  it.each(SUB_SKILLS.map((s) => [s.id, s.dir, s.domainMarkers] as const))(
    '%s: SKILL.md + reference contain the domain markers',
    (_id, dir, markers) => {
      const corpus = readAllSkillMarkdown(dir);
      const missing = markers.filter((rx) => !rx.test(corpus)).map((rx) => rx.toString());
      expect(missing, `domain markers missing from ${dir}: ${missing.join(', ')}`).toEqual([]);
    },
  );

  it.each(SUB_SKILLS.map((s) => [s.id] as const))(
    '%s: loadSkillBody resolves it under default-skills/',
    (id) => {
      const loaded = loadSkillBody(id, { skillsDir: '' });
      expect(loaded, `loadSkillBody returned null for ${id}`).not.toBeNull();
      expect(loaded!.source).toBe('default');
      // Directory-loaded skills don't populate `skillTitle` (that's the
      // flat-markdown loader's job); the resolved dir's basename is the
      // canonical identifier the injection falls back to.
      expect(path.basename(loaded!.skillDir), `${id}: skillDir basename mismatch`).toBe(id);
      // The lazy-load PR removed eager reference inlining; references are
      // listed in the injection by absolute path, not body. The loaded
      // body should still carry the SKILL.md prose.
      expect(loaded!.skillMd, `${id}: skillMd should contain heading`).toMatch(/^#\s+/m);
    },
  );

  it('sub-skills DO NOT ship their own scripts/ — scripts live in the core tree', () => {
    // Architectural invariant: the split keeps the script tree under the
    // core `agent-hub` skill. If a sub-skill grows its own scripts/, the
    // split contract breaks and the loader will duplicate listings.
    for (const { id, dir } of SUB_SKILLS) {
      expect(
        existsSync(path.join(dir, 'scripts')),
        `${id}: scripts/ should NOT be shipped (lives in core agent-hub/)`,
      ).toBe(false);
    }
  });

  it('sub-skills carry no forbidden production-infrastructure strings', () => {
    for (const { id, dir } of SUB_SKILLS) {
      const hits = scanSkillDir(dir);
      expect(hits, `${id}: forbidden strings:\n${JSON.stringify(hits, null, 2)}`).toEqual([]);
    }
  });
});
