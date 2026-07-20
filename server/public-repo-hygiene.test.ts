import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against re-introducing internal-only identifiers into the repo's
 * publishable surface (top-level README, docs/, ops/ runbooks, *.example config
 * templates, and the git-tracked Terraform environment inputs) before this is
 * an open, Apache-2.0 public repo.
 *
 * Scope note: the real per-environment Terraform inputs (the `<env>.tfvars` and
 * `backend.hcl` under `ops/terraform/environments/<env>/`) carry live account
 * IDs / ARNs / instance IDs and are now gitignored — operators copy the
 * tracked `*.example` templates and fill in real values locally (or via CI
 * `TF_VAR_*`). This guard scans every git-TRACKED file under
 * `ops/terraform/environments/**` (the sanitized templates + .gitignore), so a
 * real overlay sitting untracked on a developer's disk is never scanned, while
 * accidentally committing one is caught. Functional source that points at
 * vendor control-plane endpoints (release bucket, bug-report / replay ingest)
 * is out of scope here — changing it is a product change, not doc hygiene.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Known internal-only tokens that must not appear in the publishable surface.
const INTERNAL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'private domain (surveytracker)', re: /surveytracker|survey-tracker/i },
  { label: 'real AWS account id', re: /\b(?:120569607241|350025135582|797611956947)\b/ },
  { label: 'real Route53 zone id', re: /Z10407258WTZ0HQ4VDZP/ },
  { label: 'real KMS key id', re: /8bd60c33-06da-4257-8a77-28a99fd67ee4/ },
  { label: 'real EC2 instance id', re: /\bi-[0-9a-f]{17}\b/ },
  { label: 'private repo owner (mcsteen)', re: /\bmcsteen\b/ },
  { label: 'personal env name (ryan)', re: /\bryan\b/i },
  { label: 'private customer name (aimetrics)', re: /\baimetrics\b/i },
];

// Files/dirs excluded from the scan: the generated OpenAPI spec carries a
// documented false-green provenance string ("surveytracker#1001") that mirrors
// its Zod source.
const EXCLUDED = new Set([join(REPO_ROOT, 'docs', 'api', 'openapi.yaml')]);

function isExcluded(absPath: string): boolean {
  for (const ex of EXCLUDED) {
    if (absPath === ex || absPath.startsWith(ex + '/')) return true;
  }
  return false;
}

function collectMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    if (isExcluded(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) collectMarkdown(abs, out);
    else if (name.endsWith('.md')) out.push(abs);
  }
}

function terraformModuleSource(): string[] {
  // The reusable Terraform module root (NOT environments/**, which holds live
  // per-env inputs tracked separately) must be public-clean.
  const dir = join(REPO_ROOT, 'ops', 'terraform');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.tf'))
    .map((n) => join(dir, n))
    .filter((abs) => statSync(abs).isFile());
}

function trackedScriptFiles(): string[] {
  // Operator tooling under scripts/ ships in the public repo. Private-project
  // helpers leaked here before (surveytracker Finalize scripts, card #1401)
  // because this surface was never scanned. Enumerate git-TRACKED shell/mjs/js
  // files so an untracked local helper is ignored but a committed one is caught.
  const dir = join(REPO_ROOT, 'scripts');
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', dir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\0')
    .filter((rel) => /\.(sh|mjs|js|ts)$/.test(rel))
    .map((rel) => join(REPO_ROOT, rel));
}

function trackedEnvFiles(): string[] {
  // Every git-TRACKED file under ops/terraform/environments must be
  // placeholder-clean. Enumerating via `git ls-files` (not the filesystem)
  // means a real, gitignored overlay on a developer's disk is never scanned,
  // while a real file accidentally added to the index is caught.
  const dir = join(REPO_ROOT, 'ops', 'terraform', 'environments');
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', dir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\0')
    .filter(Boolean)
    .map((rel) => join(REPO_ROOT, rel));
}

function publishableFiles(): string[] {
  const files = new Set<string>([join(REPO_ROOT, 'README.md')]);
  const md: string[] = [];
  collectMarkdown(join(REPO_ROOT, 'docs'), md);
  collectMarkdown(join(REPO_ROOT, 'ops'), md);
  md.forEach((f) => files.add(f));
  terraformModuleSource().forEach((f) => files.add(f));
  trackedEnvFiles().forEach((f) => files.add(f));
  trackedScriptFiles().forEach((f) => files.add(f));
  // Example config templates must ship with placeholders only.
  const examples = [
    '.env.example',
    join('ops', 'terraform', 'terraform.tfvars.example'),
    join('ops', 'terraform', 'environments', 'cross-account.example.tfvars'),
  ];
  for (const rel of examples) {
    const abs = join(REPO_ROOT, rel);
    try {
      if (statSync(abs).isFile()) files.add(abs);
    } catch {
      /* absent example file is fine */
    }
  }
  return [...files];
}

describe('public-repo hygiene', () => {
  const files = publishableFiles();

  it('scans a non-trivial publishable surface', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no real per-environment tfvars / backend.hcl is git-tracked (only *.example)', () => {
    const tracked = trackedEnvFiles().map((abs) => relative(REPO_ROOT, abs));
    const offenders = tracked.filter((rel) => {
      const base = rel.split('/').pop() ?? '';
      // Only files directly inside an env subdir (environments/<env>/<file>).
      const inEnvSubdir = /^ops\/terraform\/environments\/[^/]+\/[^/]+$/.test(rel);
      if (!inEnvSubdir) return false;
      const isRealTfvars = base.endsWith('.tfvars') && !base.endsWith('.tfvars.example');
      const isRealBackend = base === 'backend.hcl';
      return isRealTfvars || isRealBackend;
    });
    expect(
      offenders,
      `Real per-env Terraform inputs must be gitignored, not committed:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('each environment ships sanitized .example templates', () => {
    const tracked = new Set(trackedEnvFiles().map((abs) => relative(REPO_ROOT, abs)));
    for (const env of ['prod', 'dev', 'test']) {
      expect(tracked, `missing environments/${env}/${env}.tfvars.example`).toContain(
        `ops/terraform/environments/${env}/${env}.tfvars.example`,
      );
      expect(tracked, `missing environments/${env}/backend.hcl.example`).toContain(
        `ops/terraform/environments/${env}/backend.hcl.example`,
      );
    }
  });

  it('publishable docs + example configs contain no internal-only identifiers', () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs);
      const text = readFileSync(abs, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const { label, re } of INTERNAL_PATTERNS) {
          if (re.test(line)) {
            offenders.push(`${rel}:${i + 1} [${label}] ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(
      offenders,
      `Internal-only tokens found in publishable surface:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
