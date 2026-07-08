import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Locks the PR-baseline / post-merge split introduced when we stripped CI
 * down to consistent baseline checks:
 *
 *   - `.github/workflows/ci.yml`         — PR gate (build + typecheck).
 *                                          MUST run unconditionally on every
 *                                          PR (no path filter, no `if:` on the
 *                                          jobs that the gate depends on).
 *   - `.github/workflows/main-checks.yml` — push:main informational suite
 *                                           (lint, skill-coupling).
 *   - `.github/workflows/skill-coupling.yml` was folded into main-checks.yml
 *                                            and should NOT exist.
 *   - `.github/workflows/api-docs.yml` runs on push:main only (no PR trigger).
 *
 * If a future PR re-adds path-based skipping to the PR gate, moves a deferred
 * check back into ci.yml, or reintroduces test-suite execution in GitHub
 * Actions, this test fires.
 */

const repoRoot = join(__dirname, '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

function readWorkflow(name: string): string {
  return readFileSync(join(workflowsDir, name), 'utf8');
}

describe('PR baseline (.github/workflows/ci.yml)', () => {
  const yml = readWorkflow('ci.yml');

  it('triggers on pull_request to main only', () => {
    // We want pull_request: branches: [main]. No push:, no paths:.
    expect(yml).toMatch(/^on:\s*\n\s+pull_request:\s*\n\s+branches:\s*\[main\]\s*\n/m);
    expect(/^\s+push:\s*\n/m.test(yml)).toBe(false);
  });

  it('does not use dorny/paths-filter or any conditional skipping', () => {
    expect(/dorny\/paths-filter/.test(yml)).toBe(false);
    expect(/paths-?filter/i.test(yml)).toBe(false);
    // The path-plan helper scripts were removed; we should not reference them.
    expect(/ci-path-plan|ci-path-scope|ci-uncovered-paths/.test(yml)).toBe(false);
  });

  it('declares a `build` job that always runs and no `test` job', () => {
    // The build job gates the `CI` aggregator and must not be guarded by path
    // filters.
    const buildBlock = extractJob(yml, 'build');
    const testBlock = extractJob(yml, 'test');
    expect(buildBlock, 'ci.yml is missing a `build:` job').toBeTruthy();
    expect(testBlock, 'ci.yml should not declare a `test:` job').toBeNull();
    // First two lines of the job block: `  build:` then `    name: ...`.
    // No `if:` should appear at indent depth 4 (job-level).
    expect(jobHasTopLevelIf(yml, 'build')).toBe(false);
  });

  it('aggregates into a single required status named `CI`', () => {
    // The required check is the `ci:` job with `name: CI` that `needs` the
    // real gate jobs: build (build + typecheck) and secret-scan (gitleaks).
    expect(yml).toMatch(/^\s{2}ci:\s*\n[\s\S]+?name:\s*CI\b/m);
    expect(yml).toMatch(/needs:\s*\[\s*build\s*,\s*secret-scan\s*\]/);
  });

  it('runs a gitleaks secret-scan job that gates the aggregator', () => {
    // The per-change secret gate must exist as its own job AND be a dependency
    // of the `CI` aggregator, or a committed credential could slip through green.
    const scanBlock = extractJob(yml, 'secret-scan');
    expect(scanBlock, 'ci.yml is missing a `secret-scan:` job').toBeTruthy();
    expect(scanBlock).toMatch(/gitleaks dir \. --config \.gitleaks\.toml/);
  });

  it('allowlists `.git/` so a deep checkout cannot turn the gate into a history scan', () => {
    // `gitleaks dir` walks `.git` as raw files. The gate is working-tree-only,
    // but that must hold BY CONSTRUCTION — not by relying on checkout's shallow
    // `fetch-depth: 1` default. Allowlisting `.git/` in .gitleaks.toml makes a
    // future `fetch-depth: 0` inert instead of red-on-every-PR (known historical
    // leaks). If this allowlist entry is dropped, this test fires.
    const gitleaksToml = readFileSync(join(repoRoot, '.gitleaks.toml'), 'utf8');
    expect(gitleaksToml).toMatch(/\(\^\|\/\)\\\.git\//);
  });

  it('does not run server or client test suites', () => {
    expect(yml).not.toMatch(/shard:\s*[123][^\n]*shards:\s*3/);
    expect(yml).not.toMatch(/suite:\s*client/);
    expect(yml).not.toMatch(/npm\s+(run\s+)?test|npx\s+vitest|vitest\s+run/);
  });
});

describe('Post-merge informational suite (.github/workflows/main-checks.yml)', () => {
  it('exists', () => {
    expect(existsSync(join(workflowsDir, 'main-checks.yml'))).toBe(true);
  });

  const yml = readWorkflow('main-checks.yml');

  it('triggers on push to main only', () => {
    expect(yml).toMatch(/^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/m);
    expect(/^\s+pull_request:\s*\n/m.test(yml)).toBe(false);
  });

  it('declares the deferred suites as jobs', () => {
    for (const job of ['lint', 'skill-coupling']) {
      expect(extractJob(yml, job), `main-checks.yml missing job \`${job}\``).toBeTruthy();
    }
    // The Terraform fmt/init/validate job was removed; it must not return.
    expect(extractJob(yml, 'terraform')).toBeNull();
    expect(extractJob(yml, 'electron-tests')).toBeNull();
    expect(extractJob(yml, 'mobile-tests')).toBeNull();
  });

  it('does not aggregate into a required-style gate (these checks are informational)', () => {
    // We never want a job here to be referenced by branch protection. The
    // simplest invariant: no job named exactly `CI` (the PR gate's name).
    expect(/^\s{2}ci:\s*\n/m.test(yml)).toBe(false);
  });
});

describe('Deleted / retargeted workflows', () => {
  it('skill-coupling.yml was folded into main-checks.yml and removed', () => {
    expect(existsSync(join(workflowsDir, 'skill-coupling.yml'))).toBe(false);
  });

  it('api-docs.yml no longer triggers on pull_request', () => {
    const yml = readWorkflow('api-docs.yml');
    expect(/^\s+pull_request:\s*\n/m.test(yml)).toBe(false);
    expect(yml).toMatch(/^\s+push:\s*\n\s+branches:\s*\[main\]/m);
  });
});

describe('GitHub Actions test-suite execution', () => {
  it('does not run tests from any workflow', () => {
    const forbidden = [
      /npm\s+(run\s+)?test\b/,
      /npx\s+vitest\b/,
      /vitest\s+run\b/,
      /playwright\s+test\b/,
      /\bjest\b/,
      /\bdetox\b/,
      /\btest\s+-f\b/,
    ];
    for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith('.yml'))) {
      const yml = readWorkflow(name);
      for (const pattern of forbidden) {
        expect(yml, `${name} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Returns the text of a top-level job block, or null if no such job exists. */
function extractJob(yml: string, jobName: string): string | null {
  // JS regex has no `\Z` anchor, so we explicitly tolerate end-of-input: look
  // ahead for the next 2-space-indented job key, OR a non-space top-level key,
  // OR the end of the document.
  const re = new RegExp(`(^ {2}${jobName}:\\s*\\n[\\s\\S]+?)(?=^ {2}\\S|^\\S|$(?![\\s\\S]))`, 'm');
  const m = re.exec(yml);
  return m ? m[1] : null;
}

/** True if the job has an `if:` at job-level indentation (4 spaces deep). */
function jobHasTopLevelIf(yml: string, jobName: string): boolean {
  const block = extractJob(yml, jobName);
  if (!block) return false;
  // Drop the job header line so we only inspect the body. Job-level keys are
  // indented 4 spaces; step-level keys live under `steps:` further in.
  const lines = block.split('\n').slice(1);
  for (const line of lines) {
    if (/^ {2}\S/.test(line)) break; // next job starts
    if (/^ {4}if:\b/.test(line)) return true;
    if (/^ {4}steps:\s*$/.test(line)) break; // anything after is step-level
  }
  return false;
}
