import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'agent-hub');
const PLUGIN_SKILL_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub');

/**
 * Shape guard for the rewritten `agent-hub` SKILL.md (discovery rewrite).
 *
 * The skill is the first thing every agent running on Agent Hub loads;
 * Anthropic's skill loader rejects frontmatter with a name longer than 64
 * chars or a description longer than 1024 chars, and we want the body to stay
 * a *navigational overview* — if it drifts back to being a raw curl dump,
 * discovery degrades and the file becomes stale the next time a route
 * changes. These invariants make the drift fail loudly in CI.
 */

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_BODY_LINES = 200;

// Concrete trigger terms the description must name so skill-selection scoring
// fires on the right cues. Keep this list tight — every term here must also
// show up in a user's ask for the skill to light up.
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

  // description: >- followed by indented lines; YAML folds them to a single line.
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
    bodyLines: body.split('\n').length - 1, // trailing newline
  };
}

function assertSkillShape(skillDir: string, label: string): void {
  expect(existsSync(skillDir), `missing skill dir: ${label}`).toBe(true);

  const { name, description, body, bodyLines } = parseSkill(skillDir);

  // --- Frontmatter invariants -----------------------------------------
  expect(name.length, `${label}: name longer than ${MAX_NAME} chars`).toBeLessThanOrEqual(MAX_NAME);
  expect(name, `${label}: name must be kebab-case`).toMatch(/^[a-z][a-z0-9-]*$/);

  expect(
    description.length,
    `${label}: description longer than ${MAX_DESCRIPTION} chars (got ${description.length})`,
  ).toBeLessThanOrEqual(MAX_DESCRIPTION);

  // Trigger-term coverage: at least 8 of the concrete terms must appear.
  const lowerDesc = description.toLowerCase();
  const hit = REQUIRED_TRIGGER_TERMS.filter((t) => lowerDesc.includes(t.toLowerCase()));
  expect(
    hit.length,
    `${label}: description mentions only ${hit.length}/${REQUIRED_TRIGGER_TERMS.length} trigger terms — hits: ${JSON.stringify(hit)}`,
  ).toBeGreaterThanOrEqual(8);

  // --- Body invariants ------------------------------------------------
  expect(
    bodyLines,
    `${label}: body is ${bodyLines} lines; keep it under ${MAX_BODY_LINES}`,
  ).toBeLessThan(MAX_BODY_LINES);

  // Every fenced bash/shell block in the *body* must reference scripts/ —
  // raw curl belongs in references/ or scripts/, never in the navigational
  // overview. We look for code fences that name bash-family languages or are
  // unlabeled fences containing curl.
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

  // Navigational overview must actually link to references/ and scripts/.
  expect(body, `${label}: body never points at references/`).toMatch(/references\/[\w.-]+\.md/);
  expect(body, `${label}: body never points at scripts/`).toMatch(/scripts\/[\w.-]+\.sh/);
}

function assertScriptsPresent(skillDir: string, label: string): void {
  const scriptsDir = path.join(skillDir, 'scripts');
  expect(existsSync(scriptsDir), `${label}: scripts/ missing`).toBe(true);

  // _common.sh is the shared helper; other scripts source it.
  expect(
    existsSync(path.join(scriptsDir, '_common.sh')),
    `${label}: scripts/_common.sh missing`,
  ).toBe(true);

  // Every scripts/*.sh referenced from SKILL.md body must exist on disk.
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
