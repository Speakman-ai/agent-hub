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
import { parseCiConfig, FINALIZE_TIMEOUT_DEFAULT_MINUTES } from './finalize/ci-config.js';

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

  it('mirrors CI gate GitHub workflows using root gate scripts (CI replacement)', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    mkdirSync(path.join(dir, 'frontend'), { recursive: true });
    writeFileSync(path.join(dir, 'frontend', 'package.json'), JSON.stringify({ name: 'fe' }));

    for (const wf of [
      'lint.yml',
      'backend.ci.yml',
      'frontend.ci.yml',
      'permissions-sync-check.yml',
      'e2e.yml',
      'deploy.prod.yml',
    ]) {
      writeFileSync(path.join(dir, '.github', 'workflows', wf), `name: ${wf}\n`);
    }
    for (const script of ['lint', 'run_api_tests', 'run_e2e_tests', 'verifypermissionsync']) {
      writeFileSync(path.join(dir, script), '#!/bin/sh\necho ok\n');
    }

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.proposedCiYaml).toMatch(/name: lint/);
    expect(draft.proposedCiYaml).toMatch(/run: \.\/lint/);
    expect(draft.proposedCiYaml).toMatch(/name: backend-tests/);
    expect(draft.proposedCiYaml).toMatch(/run: \.\/run_api_tests/);
    expect(draft.proposedCiYaml).toMatch(/name: frontend-build/);
    expect(draft.proposedCiYaml).toMatch(/name: frontend-component-tests/);
    expect(draft.proposedCiYaml).toMatch(/name: permissions-sync-check/);
    expect(draft.proposedCiYaml).toMatch(/run: \.\/verifypermissionsync/);
    expect(draft.proposedCiYaml).toMatch(/name: e2e/);
    expect(draft.proposedCiYaml).toMatch(/run: \.\/run_e2e_tests/);
    expect(draft.proposedCiYaml).not.toMatch(/deploy/);

    const parsed = parseCiConfig(draft.proposedCiYaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.version).toBe(2);
      expect(Object.keys(parsed.config.jobs).length).toBeGreaterThanOrEqual(5);
      // The draft omits an explicit `timeout_minutes`, so the config
      // inherits the parser default (raised from 60m to 240m / 4h).
      expect(parsed.config.timeoutMinutes).toBe(FINALIZE_TIMEOUT_DEFAULT_MINUTES);
    }
  });

  it('proposes v2 jobs yaml when e2e workflow declares matrix.include', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(dir, 'lint'), '#!/bin/sh\necho ok\n');
    writeFileSync(
      path.join(dir, '.github', 'workflows', 'lint.yml'),
      'name: lint\non: push\njobs:\n  lint:\n    steps:\n      - run: ./lint\n',
    );
    writeFileSync(
      path.join(dir, '.github', 'workflows', 'e2e.yml'),
      `name: E2E
jobs:
  e2e:
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        include:
          - group: Profiles
            specs: a.cy.ts
          - group: Core
            specs: b.cy.ts
    steps:
      - run: ./run_e2e_tests
`,
    );

    const draft = collectFinalizeSetupDraft(dir);
    expect(draft.proposedCiYaml).toMatch(/version: 2/);
    expect(draft.proposedCiYaml).toMatch(/matrix:/);
    expect(draft.proposedCiYaml).toMatch(/Profiles/);
    const parsed = parseCiConfig(draft.proposedCiYaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.version).toBe(2);
  });
});

describe('serializeProposedCiYaml', () => {
  it('always emits a parseable document', () => {
    const yaml = serializeProposedCiYaml({
      hostJobs: [
        { name: 'install', run: 'npm ci --include=dev' },
        { name: 'test', run: 'npm test' },
      ],
      timeoutMinutes: 30,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.config.jobs)).toEqual(['install', 'test']);
    expect(parsed.config.jobs.install.steps[0].name).toBe('install');
    expect(parsed.config.timeoutMinutes).toBe(30);
  });

  it('quotes scalars that contain YAML metacharacters', () => {
    const yaml = serializeProposedCiYaml({
      hostJobs: [{ name: 'lint: strict', run: 'echo "hi" && exit 0' }],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const job = Object.values(parsed.config.jobs)[0];
    expect(job.steps[0].name).toBe('lint: strict');
    expect(job.steps[0].run).toBe('echo "hi" && exit 0');
  });

  it('omits timeout_minutes when the default is in use', () => {
    const yaml = serializeProposedCiYaml({
      hostJobs: [{ name: 'test', run: 'echo ok' }],
      timeoutMinutes: 60,
    });
    expect(yaml).not.toMatch(/timeout_minutes/);
  });

  it('substitutes a placeholder when there are no jobs (parser rejects empty)', () => {
    const yaml = serializeProposedCiYaml({ hostJobs: [], timeoutMinutes: 60 });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
  });

  it('chains host jobs with needs so they cannot race on the shared worktree', () => {
    // `runs-on: host` runs on the Hub box in the session's own worktree, so
    // every host job shares one directory. Left independent, lint/test would
    // start before install finished writing node_modules.
    const yaml = serializeProposedCiYaml({
      hostJobs: [
        { name: 'install', run: 'npm ci --include=dev' },
        { name: 'lint', run: 'npm run lint' },
        { name: 'test', run: 'npm test' },
      ],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.jobs.install.needs).toEqual([]);
    expect(parsed.config.jobs.lint.needs).toEqual(['install']);
    expect(parsed.config.jobs.test.needs).toEqual(['lint']);
  });

  it('leaves the e2e container job unchained (its own checkout, shares nothing)', () => {
    const yaml = serializeProposedCiYaml({
      hostJobs: [{ name: 'install', run: 'npm ci' }],
      e2eMatrix: [{ group: 'Core', specs: 'a.cy.ts' }],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.jobs.e2e.needs).toEqual([]);
    expect(parsed.config.jobs.e2e.runsOn).toBe('ubuntu-24.04');
  });

  it('de-duplicates job ids that sanitise to the same key', () => {
    // Two gates collapsing to one YAML key would keep only the last, silently
    // dropping a gate from the pipeline.
    const yaml = serializeProposedCiYaml({
      hostJobs: [
        { name: 'Lint', run: 'npm run lint' },
        { name: 'lint', run: './lint' },
        { name: 'Test (unit)', run: 'npm test' },
        { name: 'Test [unit]', run: 'npm run test:unit' },
      ],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Four gates in, four jobs out — nothing swallowed.
    expect(Object.keys(parsed.config.jobs)).toHaveLength(4);
    const runs = Object.values(parsed.config.jobs).map((job) => job.steps[0].run);
    expect(runs).toEqual(['npm run lint', './lint', 'npm test', 'npm run test:unit']);
  });

  it('falls back to a usable id when a name sanitises to nothing', () => {
    // A punctuation-only name previously produced `  :` or a bare `  -:`,
    // which is either unparsable or read as a sequence entry, not a job key.
    const yaml = serializeProposedCiYaml({
      hostJobs: [
        { name: '!!!', run: 'echo one' },
        { name: '***', run: 'echo two' },
      ],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.config.jobs)).toEqual(['job', 'job-2']);
  });

  it('renames a host gate that would collide with the reserved e2e job', () => {
    const yaml = serializeProposedCiYaml({
      hostJobs: [{ name: 'e2e', run: './run_e2e_tests' }],
      e2eMatrix: [{ group: 'Core' }],
      timeoutMinutes: 60,
    });
    const parsed = parseCiConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The host gate is renamed; the container matrix job keeps `e2e`.
    expect(parsed.config.jobs['e2e-2'].runsOn).toBe('host');
    expect(parsed.config.jobs.e2e.runsOn).toBe('ubuntu-24.04');
  });
});
