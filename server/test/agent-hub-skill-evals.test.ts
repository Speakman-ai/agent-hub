import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVALS = path.join(__dirname, '..', 'default-skills', 'agent-hub', 'evals');
const PLUGIN_EVALS = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub', 'evals');

/**
 * Shape guards for the `agent-hub` skill eval harness.
 *
 * The eval JSON contracts are what downstream tooling (run.mjs + future
 * CI wiring) depends on. If someone adds an eval with a typo'd matcher
 * type or a missing `expected_behavior`, the runner will throw at load
 * time — we want that caught in CI, not on an operator's laptop.
 *
 * These tests also lock in the acceptance criteria from the ticket:
 *   - at least three evals required (create-ticket, move-card, search-wiki)
 *   - every JSON must declare expected_behavior with recognised matchers
 *   - run.mjs must be present, executable, and pass --dry-run cleanly
 */

const REQUIRED_EVAL_IDS = ['create-ticket', 'move-card', 'search-wiki'];

// Keep this list in sync with MATCHERS in run.mjs. Drift on either side is
// intentionally visible — both files live a few lines apart in the same skill.
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

  // Required-ids coverage — the ticket names these three explicitly.
  const ids = new Set(evals.map((e) => e.id));
  for (const required of REQUIRED_EVAL_IDS) {
    expect(ids.has(required), `${label}: missing required eval "${required}.json"`).toBe(true);
  }

  // No duplicate ids — the runner keys its report by id.
  const seen = new Set<string>();
  for (const e of evals) {
    expect(seen.has(e.id), `${label}: duplicate eval id "${e.id}"`).toBe(false);
    seen.add(e.id);
  }

  for (const ev of evals) {
    const tag = `${label}/${ev.id}`;

    // Required top-level keys.
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

    // `skills: ["agent-hub", ...]` — the first entry must be the skill under test.
    expect(ev.skills.includes('agent-hub'), `${tag}: skills must list "agent-hub"`).toBe(true);

    // Every behavior entry must have a known type and a value.
    for (const [i, b] of ev.expected_behavior.entries()) {
      const btag = `${tag}.expected_behavior[${i}]`;
      expect(
        VALID_MATCHER_TYPES.has(b.type),
        `${btag}: unknown matcher type "${b.type}" (valid: ${[...VALID_MATCHER_TYPES].join(', ')})`,
      ).toBe(true);
      expect('value' in b, `${btag}: missing "value"`).toBe(true);

      // Array-valued matchers must actually carry an array.
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
        // Sanity-check the regex compiles — broken regexes turn into silent
        // `false` at runtime and would mask real failures.
        expect(() => new RegExp(b.value as string), `${btag}: regex must compile`).not.toThrow();
      } else {
        expect(typeof b.value, `${btag}: type "${b.type}" requires string value`).toBe('string');
      }
    }

    // If `files` is declared, every listed path must resolve against the repo
    // root. We don't want stale file lists silently skipping context.
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

  // Executable bit — the skill doc tells operators to `node run.mjs`, but the
  // shebang is the polite path and a lot of CI invocations rely on it.
  const mode = statSync(runner).mode;
  expect(Boolean(mode & 0o111), `${label}: run.mjs must be executable`).toBe(true);

  // --dry-run must pass — this is the CI path that validates eval shapes
  // without any API key.
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
    if (!existsSync(PLUGIN_EVALS)) return; // plugin dir is optional in some checkouts
    assertEvalShape(PLUGIN_EVALS, 'plugin');
    assertRunnerShape(PLUGIN_EVALS, 'plugin');

    // Hard parity check — every default eval must exist in the plugin mirror
    // (byte-for-byte). The plugin copy is what gets bundled to end users;
    // drift there silently breaks skill distribution.
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
