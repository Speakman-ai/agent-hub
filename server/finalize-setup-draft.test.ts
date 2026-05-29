/**
 * finalize-setup-draft.test.ts — fixture-driven scans for the Finalize
 * ci.yaml setup wizard.
 *
 * The proposed YAML always validates against the v1 parser — that
 * contract is pinned here so a parser-breaking change shows up in CI
 * before it reaches users.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectFinalizeSetupDraft, serializeProposedCiYaml } from './finalize-setup-draft.js';
import { parseCiConfig } from './finalize/ci-config.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'ah-finalize-draft-'));
}

describe('collectFinalizeSetupDraft', () => {
  it('detects an npm single-project repo and proposes install + test', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
    );
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');

    const draft = collectFinalizeSetupDraft(dir);

    expect(draft.stack).toBe('node');
    expect(draft.packageManager).toBe('npm');
    expect(draft.isMonorepo).toBe(false);
    expect(draft.subprojects.length).toBe(1);
    expect(draft.existingCi).toBe(false);
    expect(draft.proposedCiYaml).toMatch(/npm ci --include=dev/);
    expect(draft.proposedCiYaml).toMatch(/npm test/);
    // The proposed YAML always validates.
    const parsed = parseCiConfig(draft.proposedCiYaml);
    expect(parsed.ok).toBe(true);
  });

  it('detects pnpm via lockfile and switches the install command', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.packageManager).toBe('pnpm');
    expect(draft.proposedCiYaml).toMatch(/pnpm install --frozen-lockfile/);
    expect(draft.proposedCiYaml).toMatch(/pnpm test/);
  });

  it('detects yarn via lockfile', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.packageManager).toBe('yarn');
    expect(draft.proposedCiYaml).toMatch(/yarn install --frozen-lockfile/);
  });

  it('detects a Python pip project (requirements.txt)', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'requirements.txt'), 'pytest>=7\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.stack).toBe('python');
    expect(draft.packageManager).toBe('pip');
    expect(draft.proposedCiYaml).toMatch(/pip install -r requirements\.txt/);
    expect(draft.proposedCiYaml).toMatch(/pytest/);
  });

  it('detects a Python poetry project', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[tool.poetry]\nname = "x"\nversion = "0.1.0"\n',
    );
    writeFileSync(path.join(dir, 'poetry.lock'), '');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.packageManager).toBe('poetry');
    expect(draft.proposedCiYaml).toMatch(/poetry install --no-interaction/);
    expect(draft.proposedCiYaml).toMatch(/poetry run pytest/);
  });

  it('detects a Rust cargo project', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.stack).toBe('rust');
    expect(draft.packageManager).toBe('cargo');
    expect(draft.proposedCiYaml).toMatch(/cargo test --all/);
    expect(draft.proposedCiYaml).toMatch(/cargo fmt --check/);
  });

  it('detects a Go project', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'go.mod'), 'module x\n\ngo 1.22\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.stack).toBe('go');
    expect(draft.packageManager).toBe('go');
    expect(draft.proposedCiYaml).toMatch(/go test \.\/\.\.\./);
  });

  it('falls back to Makefile target when stack is unknown', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'Makefile'), 'test:\n\techo testing\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.stack).toBe('unknown');
    expect(draft.makefileTargets).toContain('test');
    expect(draft.proposedCiYaml).toMatch(/make test/);
  });

  it('uses Makefile-first when both Makefile and package.json have test targets', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(path.join(dir, 'Makefile'), 'test:\n\techo testing\nlint:\n\techo linting\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.proposedCiYaml).toMatch(/make test/);
    expect(draft.proposedCiYaml).toMatch(/make lint/);
  });

  it('detects a Node monorepo and emits one install + test per subproject', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    );
    mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(
      path.join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
    writeFileSync(
      path.join(dir, 'apps', 'api', 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.isMonorepo).toBe(true);
    expect(draft.subprojects.map((s) => s.path).sort()).toEqual(
      ['.', 'apps/api', 'apps/web'].sort(),
    );
    expect(draft.proposedCiYaml).toMatch(/cd apps\/web && /);
    expect(draft.proposedCiYaml).toMatch(/cd apps\/api && /);
    const parsed = parseCiConfig(draft.proposedCiYaml);
    expect(parsed.ok).toBe(true);
  });

  it('flags existingCi and exposes the content for review', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
    mkdirSync(path.join(dir, '.agent-hub'), { recursive: true });
    writeFileSync(
      path.join(dir, '.agent-hub', 'ci.yaml'),
      'version: 1\non:\n  - finalize\nsteps:\n  - run: echo legacy\n',
    );

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.existingCi).toBe(true);
    expect(draft.existingCiContent).toMatch(/echo legacy/);
  });

  it('scans .github/workflows and Makefile targets as signals', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    writeFileSync(path.join(dir, '.github', 'workflows', 'release.yaml'), 'name: rel\n');
    writeFileSync(
      path.join(dir, 'Makefile'),
      'test:\n\techo t\nbuild:\n\techo b\n.PHONY: clean\nclean:\n\techo c\n',
    );

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.githubWorkflows).toEqual(['ci.yml', 'release.yaml']);
    expect(draft.makefileTargets).toContain('test');
    expect(draft.makefileTargets).toContain('build');
    expect(draft.makefileTargets).not.toContain('clean'); // not in MAKE_INTERESTING_TARGETS
  });

  it('falls back to a placeholder step that parses cleanly when nothing is detected', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'README.md'), 'A repo with no manifest.\n');

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.stack).toBe('unknown');
    const parsed = parseCiConfig(draft.proposedCiYaml);
    expect(parsed.ok).toBe(true);
  });
});

describe('serializeProposedCiYaml', () => {
  it('always emits a parseable v1 document', () => {
    const yaml = serializeProposedCiYaml(
      [
        { name: 'install', run: 'npm ci --include=dev' },
        { name: 'test', run: 'npm test' },
      ],
      30,
    );
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.steps.map((s) => s.name)).toEqual(['install', 'test']);
      expect(parsed.config.timeoutMinutes).toBe(30);
    }
  });

  it('quotes scalars that contain YAML metacharacters', () => {
    const yaml = serializeProposedCiYaml(
      [{ name: 'lint: strict', run: 'echo "hi" && exit 0' }],
      60,
    );
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.steps[0].name).toBe('lint: strict');
      expect(parsed.config.steps[0].run).toBe('echo "hi" && exit 0');
    }
  });

  it('omits timeout_minutes when the default is in use', () => {
    const yaml = serializeProposedCiYaml([{ name: 'test', run: 'echo ok' }], 60);
    expect(yaml).not.toMatch(/timeout_minutes/);
  });

  it('substitutes a placeholder when steps is empty (parser rejects empty)', () => {
    const yaml = serializeProposedCiYaml([], 60);
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
  });
});
