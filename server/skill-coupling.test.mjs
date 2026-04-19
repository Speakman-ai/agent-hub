// Tests for `.github/scripts/skill-coupling.mjs` — the CI check that
// enforces platform-module ↔ SKILL.md coupling during the skill freeze.
//
// The script is pure ESM with zero deps, so we import it directly.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  '.github',
  'scripts',
  'skill-coupling.mjs',
);
const CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '.github',
  'skill-coupling.yml',
);

const mod = await import(SCRIPT_PATH);
const { parseCouplingYaml, globToRegex, matchesAny, evaluateCoupling, formatFailureMessage } =
  mod;

const SHIPPED_CONFIG = parseCouplingYaml(readFileSync(CONFIG_PATH, 'utf8'));

describe('parseCouplingYaml', () => {
  it('parses the shipped .github/skill-coupling.yml', () => {
    expect(Array.isArray(SHIPPED_CONFIG.coupled_paths)).toBe(true);
    expect(Array.isArray(SHIPPED_CONFIG.skill_doc_paths)).toBe(true);
    expect(typeof SHIPPED_CONFIG.override_label).toBe('string');
    expect(SHIPPED_CONFIG.override_label).toBe('skill-freeze-override');
  });

  it('includes every platform module called out in the kanban ticket', () => {
    const required = [
      'server/delegation.ts',
      'server/handoff.ts',
      'server/card-auto-close.ts',
      'server/routes/auth.ts',
      'server/memberships-store.ts',
      'server/users-store.ts',
      'server/invites-store.ts',
    ];
    for (const p of required) {
      expect(SHIPPED_CONFIG.coupled_paths).toContain(p);
    }
  });

  it('includes both the plugin and default-skills SKILL.md locations', () => {
    expect(SHIPPED_CONFIG.skill_doc_paths).toContain(
      'plugin/skills/agent-hub/SKILL.md',
    );
    expect(SHIPPED_CONFIG.skill_doc_paths).toContain(
      'server/default-skills/agent-hub/SKILL.md',
    );
  });

  it('ignores comments and blank lines', () => {
    const y = `
# leading comment
foo: bar  # trailing comment

items:
  - one
  - two # trailing on list item
`;
    const parsed = parseCouplingYaml(y);
    expect(parsed.foo).toBe('bar');
    expect(parsed.items).toEqual(['one', 'two']);
  });

  it('strips surrounding quotes on scalar values', () => {
    expect(parseCouplingYaml('label: "skill-freeze-override"').label).toBe(
      'skill-freeze-override',
    );
    expect(parseCouplingYaml("label: 'x'").label).toBe('x');
  });
});

describe('globToRegex / matchesAny', () => {
  it('matches literal paths exactly', () => {
    const rx = globToRegex('server/delegation.ts');
    expect(rx.test('server/delegation.ts')).toBe(true);
    expect(rx.test('server/delegation-wrap.ts')).toBe(false);
    expect(rx.test('other/server/delegation.ts')).toBe(false);
  });

  it('** matches across path segments', () => {
    const rx = globToRegex('server/**/*.ts');
    expect(rx.test('server/delegation.ts')).toBe(true);
    expect(rx.test('server/routes/auth.ts')).toBe(true);
    expect(rx.test('server/a/b/c/d.ts')).toBe(true);
    expect(rx.test('client/foo.ts')).toBe(false);
  });

  it('single * does not cross slashes', () => {
    const rx = globToRegex('server/*.ts');
    expect(rx.test('server/foo.ts')).toBe(true);
    expect(rx.test('server/routes/foo.ts')).toBe(false);
  });

  it('matchesAny returns true if any pattern hits', () => {
    const patterns = ['server/delegation.ts', 'server/routes/auth.ts'];
    expect(matchesAny('server/routes/auth.ts', patterns)).toBe(true);
    expect(matchesAny('server/chat.ts', patterns)).toBe(false);
  });
});

describe('evaluateCoupling', () => {
  const config = SHIPPED_CONFIG;

  it('passes when no coupled file is touched (rule does not apply)', () => {
    const result = evaluateCoupling({
      changedFiles: ['client/src/App.jsx', 'server/chat.ts'],
      labels: [],
      config,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-coupled-files-changed');
    expect(result.matchedCoupled).toEqual([]);
  });

  it('FAILS when delegation.ts changes without a skill-doc touch', () => {
    const result = evaluateCoupling({
      changedFiles: ['server/delegation.ts'],
      labels: [],
      config,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('coupled-change-without-skill-update');
    expect(result.matchedCoupled).toEqual(['server/delegation.ts']);
    expect(result.matchedDoc).toEqual([]);
    expect(result.overrideUsed).toBe(false);
  });

  it('passes when delegation.ts change is accompanied by a SKILL.md touch', () => {
    const result = evaluateCoupling({
      changedFiles: [
        'server/delegation.ts',
        'plugin/skills/agent-hub/SKILL.md',
      ],
      labels: [],
      config,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('skill-doc-touched');
    expect(result.matchedDoc).toContain('plugin/skills/agent-hub/SKILL.md');
  });

  it('accepts a references/ file as satisfying the coupling', () => {
    const result = evaluateCoupling({
      changedFiles: [
        'server/handoff.ts',
        'server/default-skills/agent-hub/references/handoff.md',
      ],
      labels: [],
      config,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('skill-doc-touched');
  });

  it('passes with the override label even without a skill touch', () => {
    const result = evaluateCoupling({
      changedFiles: ['server/routes/auth.ts'],
      labels: ['skill-freeze-override'],
      config,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('override-label-present');
    expect(result.overrideUsed).toBe(true);
  });

  it('an unrelated label does NOT bypass the check', () => {
    const result = evaluateCoupling({
      changedFiles: ['server/card-auto-close.ts'],
      labels: ['bug', 'backend', 'NOT-skill-freeze-override'],
      config,
    });
    expect(result.ok).toBe(false);
    expect(result.overrideUsed).toBe(false);
  });

  it('reports EVERY coupled file that changed, not just the first', () => {
    const result = evaluateCoupling({
      changedFiles: [
        'server/delegation.ts',
        'server/handoff.ts',
        'server/users-store.ts',
        'README.md',
      ],
      labels: [],
      config,
    });
    expect(result.ok).toBe(false);
    expect(result.matchedCoupled).toEqual([
      'server/delegation.ts',
      'server/handoff.ts',
      'server/users-store.ts',
    ]);
  });

  it('recognizes every coupled path from the shipped config', () => {
    for (const p of config.coupled_paths) {
      const result = evaluateCoupling({
        changedFiles: [p],
        labels: [],
        config,
      });
      expect(result.matchedCoupled, `pattern ${p} should self-match`).toEqual([
        p,
      ]);
    }
  });
});

describe('formatFailureMessage', () => {
  it('names each offending file and both override paths', () => {
    const result = evaluateCoupling({
      changedFiles: ['server/delegation.ts', 'server/handoff.ts'],
      labels: [],
      config: SHIPPED_CONFIG,
    });
    const msg = formatFailureMessage(result, SHIPPED_CONFIG);
    expect(msg).toContain('server/delegation.ts');
    expect(msg).toContain('server/handoff.ts');
    expect(msg).toContain('plugin/skills/agent-hub/SKILL.md');
    expect(msg).toContain('skill-freeze-override');
    expect(msg).toContain('.github/skill-coupling.yml');
  });
});
