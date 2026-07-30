/**
 * Tests for the agent-hub skill `examples/` directory.
 *
 * The examples under `server/default-skills/agent-hub/examples/` are worked
 * recipes that agents
 * copy-paste verbatim into live sessions. If a script referenced from an
 * example is renamed or deleted without updating the example, the recipe
 * silently rots — the agent runs a command that no longer exists.
 *
 * This suite walks every example file, extracts every `scripts/<name>.sh`
 * reference, and asserts:
 *   1. The referenced script file exists on disk.
 *   2. The SKILL.md "Workflows — worked examples" table links to the example.
 *   3. The bundled skill docs remain internally consistent.
 *
 * Regression coverage for the "skill bit-rot" class of bugs: the docs say
 * `scripts/foo.sh --bar baz`, but `foo.sh` was renamed to `foo-bar.sh` three
 * weeks ago and nobody updated the example.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SKILL_DIR = path.join(REPO_ROOT, 'server', 'default-skills', 'agent-hub');
const EXAMPLES_DIR = path.join(SKILL_DIR, 'examples');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

/** List .md files in a directory, sorted, excluding README. */
function listExamples(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
}

/** Extract every `scripts/<name>.sh` reference from a body of text. */
function extractScriptRefs(text: string): string[] {
  const rx = /scripts\/[a-zA-Z0-9_-]+\.sh/g;
  return Array.from(new Set(text.match(rx) ?? []));
}

describe('agent-hub skill — examples/ directory', () => {
  it('exists in the bundled default-skills tree', () => {
    expect(existsSync(EXAMPLES_DIR), 'examples dir missing').toBe(true);
    expect(statSync(EXAMPLES_DIR).isDirectory()).toBe(true);
  });

  it('ships the four required example recipes (plus a README)', () => {
    const required = [
      'create-ticket-from-bug-report.md',
      'post-heartbeat-summary.md',
      'search-and-link-wiki-page.md',
      'move-card-through-workflow.md',
    ];
    const found = listExamples(EXAMPLES_DIR);
    for (const name of required) {
      expect(found, `missing required example: ${name}`).toContain(name);
    }
    expect(existsSync(path.join(EXAMPLES_DIR, 'README.md'))).toBe(true);
  });

  describe('script references resolve', () => {
    const examples = listExamples(EXAMPLES_DIR);
    for (const name of examples) {
      it(`${name}: every scripts/*.sh mention points at an existing file`, () => {
        const body = readFileSync(path.join(EXAMPLES_DIR, name), 'utf8');
        const refs = extractScriptRefs(body);
        expect(
          refs.length,
          `expected at least one scripts/*.sh reference in ${name}`,
        ).toBeGreaterThan(0);
        for (const ref of refs) {
          const basename = ref.replace(/^scripts\//, '');
          const onDisk = path.join(SCRIPTS_DIR, basename);
          expect(existsSync(onDisk), `${name} references ${ref} but ${onDisk} does not exist`).toBe(
            true,
          );
        }
      });
    }
  });

  it('SKILL.md Workflows table links to every example file', () => {
    const skill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const examples = listExamples(EXAMPLES_DIR);
    for (const name of examples) {
      const expectedLink = `examples/${name}`;
      expect(
        skill.includes(expectedLink),
        `SKILL.md does not link to ${expectedLink} in the Workflows table`,
      ).toBe(true);
    }
    // And the Workflows header itself is present.
    expect(skill).toMatch(/## Workflows — worked examples/);
  });

  it('every example carries an acceptance-criteria "Copy-paste checklist"', () => {
    for (const name of listExamples(EXAMPLES_DIR)) {
      const body = readFileSync(path.join(EXAMPLES_DIR, name), 'utf8');
      expect(
        body.includes('Copy-paste checklist'),
        `${name} missing "Copy-paste checklist" section — acceptance marker for worked recipes`,
      ).toBe(true);
    }
  });
});
