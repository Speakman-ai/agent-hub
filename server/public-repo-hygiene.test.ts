import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against re-introducing internal-only identifiers into the repo's
 * publishable surface (top-level README, docs/, ops/ runbooks, *.example config
 * templates, and the git-tracked Terraform environment inputs) before this is
 * a public, source-available repo.
 *
 * Scope note: the live `prod.tfvars` is committed on purpose so fleet/sizing
 * *config* (instance types, counts, toggles) is reviewable in PRs. It is still
 * scanned here for internal-only identifiers — account-specific IDENTIFIERS
 * (the deploy domain, AWS account IDs, Route 53 zone ID, KMS key ID,
 * account-scoped bucket names, the delegation role ARN) and tokens stay OUT of
 * it, in the gitignored overlay (`secrets.tfvars`) / CI `TF_VAR_*`. The live
 * `backend.hcl` carries the account-ID state bucket, so it is gitignored (CI
 * passes the same values inline from GitHub Variables). Committing a token in
 * prod.tfvars is additionally caught by `ci-ssm-deploy-targeting.test.ts`.
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
  // "Ryan Speakman" is the identified licensor legal name in LICENSE/docs.
  // Do not treat that published counterparty name as the retired personal env.
  { label: 'personal env name (ryan)', re: /\bryan\b(?!\s+Speakman)/i },
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

function trackedWorkflowFiles(): string[] {
  // GitHub Actions workflows under .github/ are fully public once the repo is
  // open. A real EC2 instance-id fallback leaked here before (card #1598)
  // because neither hygiene guard scanned this surface. Enumerate git-TRACKED
  // workflow definitions so an untracked local file is ignored but a committed
  // one is caught.
  const dir = join(REPO_ROOT, '.github');
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
    .filter((rel) => /\.(ya?ml)$/.test(rel))
    .map((rel) => join(REPO_ROOT, rel));
}

function trackedAppSourceFiles(): string[] {
  // Shipped client/mobile source (excluding tests, which legitimately use
  // sample usernames as fixtures). Personal home-dir paths leaked into mobile
  // source before (card #1598).
  const dirs = [join(REPO_ROOT, 'client', 'src'), join(REPO_ROOT, 'mobile', 'src')];
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\0')
    .filter((rel) => /\.(ts|tsx|js|jsx)$/.test(rel))
    .filter((rel) => !/\.(test|spec)\.[jt]sx?$/.test(rel))
    .map((rel) => join(REPO_ROOT, rel));
}

function trackedEnvFiles(): string[] {
  // Enumerating via `git ls-files` (not the filesystem) so an untracked local
  // secrets.tfvars is never scanned, while a committed one is caught.
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
  // Every git-tracked env file must be placeholder-clean of internal-only
  // identifiers — the sanitized `.example` templates AND the committed live
  // `prod.tfvars` (reviewable fleet config; account-specific IDs live in the
  // gitignored overlay / TF_VAR_*). backend.hcl is gitignored, so `git
  // ls-files` never surfaces the live one here.
  trackedEnvFiles().forEach((f) => files.add(f));
  trackedScriptFiles().forEach((f) => files.add(f));
  trackedWorkflowFiles().forEach((f) => files.add(f));
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

  it('never tracks secrets.tfvars (tokens only; config tfvars are committed)', () => {
    const tracked = trackedEnvFiles().map((abs) => relative(REPO_ROOT, abs));
    const secrets = tracked.filter((rel) => rel.endsWith('/secrets.tfvars'));
    expect(secrets, `secrets.tfvars must stay gitignored:\n${secrets.join('\n')}`).toEqual([]);
  });

  function isGitIgnored(rel: string): boolean {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO_ROOT });
      return true;
    } catch {
      return false;
    }
  }

  it('does not gitignore live prod.tfvars (reviewable config must be committable)', () => {
    const rel = 'ops/terraform/environments/prod/prod.tfvars';
    expect(isGitIgnored(rel), `${rel} is config and must be committable`).toBe(false);
  });

  it('gitignores live backend.hcl (carries the account-ID state bucket)', () => {
    // The committed surface is the sanitized backend.hcl.example; the live file
    // stays untracked (CI passes the same values inline from GitHub Variables).
    const rel = 'ops/terraform/environments/prod/backend.hcl';
    expect(isGitIgnored(rel), `${rel} must stay gitignored`).toBe(true);
    expect(
      isGitIgnored('ops/terraform/environments/prod/backend.hcl.example'),
      'backend.hcl.example must stay committable',
    ).toBe(false);
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

  it('no generated build/report output is git-tracked, and each path is ignored', () => {
    // A committed playwright-report/index.html (524 KB snapshot of one local
    // run) sat in the tree because .gitignore had no entry for it. Generated
    // output belongs to the machine that produced it, never to the repo.
    const GENERATED_PREFIXES = [
      'playwright-report/',
      'e2e/playwright-report/',
      'test-results/',
      'e2e/test-results/',
      'blob-report/',
      'e2e/blob-report/',
      'docs/api/_site/',
      'client/dist/',
    ];

    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);

    const committed = tracked.filter((rel) => GENERATED_PREFIXES.some((p) => rel.startsWith(p)));
    expect(committed, `Generated output must not be committed:\n${committed.join('\n')}`).toEqual(
      [],
    );

    // `git check-ignore` exits 1 when a path is NOT ignored, so a missing
    // .gitignore entry surfaces as an offender rather than a thrown error.
    const notIgnored = GENERATED_PREFIXES.filter((prefix) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', '--', prefix + 'probe'], {
          cwd: REPO_ROOT,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(
      notIgnored,
      `Missing .gitignore coverage for generated output:\n${notIgnored.join('\n')}`,
    ).toEqual([]);
  });

  it('shipped client/mobile source has no personal /home/<user> paths', () => {
    // Generic placeholders are fine; a maintainer's real home dir is not.
    const ALLOWED_HOME = new Set(['user', 'node', 'runner', 'agent']);
    const homePath = /\/home\/([a-z][a-z0-9_-]*)/g;
    const offenders: string[] = [];
    for (const abs of trackedAppSourceFiles()) {
      const rel = relative(REPO_ROOT, abs);
      const text = readFileSync(abs, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(homePath)) {
          if (!ALLOWED_HOME.has(m[1])) {
            offenders.push(`${rel}:${i + 1} [personal home path] ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(
      offenders,
      `Personal home-dir paths found in shipped source:\n${offenders.join('\n')}`,
    ).toEqual([]);
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
