/**
 * Tests for the agent-hub skill `examples/` directory.
 *
 * The examples under `plugin/skills/agent-hub/examples/` (mirrored under
 * `server/default-skills/agent-hub/examples/`) are worked recipes that agents
 * copy-paste verbatim into live sessions. If a script referenced from an
 * example is renamed or deleted without updating the example, the recipe
 * silently rots — the agent runs a command that no longer exists.
 *
 * This suite walks every example file, extracts every `scripts/<name>.sh`
 * reference, and asserts:
 *   1. The referenced script file exists on disk.
 *   2. The SKILL.md "Workflows — worked examples" table links to the example.
 *   3. The two skill-doc mirrors (plugin/ and server/default-skills/) stay
 *      byte-identical for both the example files and SKILL.md.
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

const PLUGIN_DIR = path.join(REPO_ROOT, 'plugin', 'skills', 'agent-hub');
const MIRROR_DIR = path.join(REPO_ROOT, 'server', 'default-skills', 'agent-hub');

const PLUGIN_EXAMPLES = path.join(PLUGIN_DIR, 'examples');
const MIRROR_EXAMPLES = path.join(MIRROR_DIR, 'examples');

const PLUGIN_SCRIPTS = path.join(PLUGIN_DIR, 'scripts');

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
  it('exists in both the plugin/ and server/default-skills/ mirrors', () => {
    expect(existsSync(PLUGIN_EXAMPLES), 'plugin examples dir missing').toBe(true);
    expect(existsSync(MIRROR_EXAMPLES), 'mirror examples dir missing').toBe(true);
    expect(statSync(PLUGIN_EXAMPLES).isDirectory()).toBe(true);
    expect(statSync(MIRROR_EXAMPLES).isDirectory()).toBe(true);
  });

  it('ships the four required example recipes (plus a README)', () => {
    const required = [
      'create-ticket-from-bug-report.md',
      'post-heartbeat-summary.md',
      'search-and-link-wiki-page.md',
      'move-card-through-workflow.md',
    ];
    const found = listExamples(PLUGIN_EXAMPLES);
    for (const name of required) {
      expect(found, `missing required example: ${name}`).toContain(name);
    }
    expect(existsSync(path.join(PLUGIN_EXAMPLES, 'README.md'))).toBe(true);
  });

  it('keeps plugin/ and server/default-skills/ mirrors byte-identical', () => {
    const a = listExamples(PLUGIN_EXAMPLES);
    const b = listExamples(MIRROR_EXAMPLES);
    expect(b).toEqual(a);
    for (const name of [...a, 'README.md']) {
      const pluginBytes = readFileSync(path.join(PLUGIN_EXAMPLES, name));
      const mirrorBytes = readFileSync(path.join(MIRROR_EXAMPLES, name));
      expect(
        mirrorBytes.equals(pluginBytes),
        `mirror drift in examples/${name} — run \`cp plugin/skills/agent-hub/examples/${name} server/default-skills/agent-hub/examples/${name}\``,
      ).toBe(true);
    }
  });

  it('keeps SKILL.md byte-identical across the two mirrors', () => {
    const a = readFileSync(path.join(PLUGIN_DIR, 'SKILL.md'));
    const b = readFileSync(path.join(MIRROR_DIR, 'SKILL.md'));
    expect(
      a.equals(b),
      'SKILL.md drift — plugin/ and server/default-skills/ copies must match',
    ).toBe(true);
  });

  describe('script references resolve', () => {
    const examples = listExamples(PLUGIN_EXAMPLES);
    for (const name of examples) {
      it(`${name}: every scripts/*.sh mention points at an existing file`, () => {
        const body = readFileSync(path.join(PLUGIN_EXAMPLES, name), 'utf8');
        const refs = extractScriptRefs(body);
        expect(
          refs.length,
          `expected at least one scripts/*.sh reference in ${name}`,
        ).toBeGreaterThan(0);
        for (const ref of refs) {
          const basename = ref.replace(/^scripts\//, '');
          const onDisk = path.join(PLUGIN_SCRIPTS, basename);
          expect(existsSync(onDisk), `${name} references ${ref} but ${onDisk} does not exist`).toBe(
            true,
          );
        }
      });
    }
  });

  it('SKILL.md Workflows table links to every example file', () => {
    const skill = readFileSync(path.join(PLUGIN_DIR, 'SKILL.md'), 'utf8');
    const examples = listExamples(PLUGIN_EXAMPLES);
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
    for (const name of listExamples(PLUGIN_EXAMPLES)) {
      const body = readFileSync(path.join(PLUGIN_EXAMPLES, name), 'utf8');
      expect(
        body.includes('Copy-paste checklist'),
        `${name} missing "Copy-paste checklist" section — acceptance marker for worked recipes`,
      ).toBe(true);
    }
  });
});
