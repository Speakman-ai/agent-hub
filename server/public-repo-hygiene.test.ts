import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against re-introducing internal-only identifiers into the repo's
 * publishable surface (top-level README, docs/, ops/ runbooks, and *.example
 * config templates) before this is an open, Apache-2.0 public repo.
 *
 * Scope note: this guard intentionally covers only the docs + example-config
 * surface. The real Terraform environment inputs under
 * `ops/terraform/environments/**` (prod/ryan/test tfvars + backend.hcl) still
 * carry live account IDs / ARNs / instance IDs; whether those files should be
 * public at all is an infra decision tracked as follow-up, not something to
 * placeholder in place (it would break `terraform apply`). Functional source
 * that points at vendor control-plane endpoints (release bucket, bug-report /
 * replay ingest) is also out of scope here — changing it is a product change,
 * not doc hygiene.
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
// its Zod source, and the live Terraform env inputs are tracked separately.
const EXCLUDED = new Set([
  join(REPO_ROOT, 'docs', 'api', 'openapi.yaml'),
  join(REPO_ROOT, 'ops', 'terraform', 'environments'),
]);

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

function publishableFiles(): string[] {
  const files: string[] = [join(REPO_ROOT, 'README.md')];
  collectMarkdown(join(REPO_ROOT, 'docs'), files);
  collectMarkdown(join(REPO_ROOT, 'ops'), files);
  files.push(...terraformModuleSource());
  // Example config templates must ship with placeholders only.
  const examples = [
    '.env.example',
    join('ops', 'terraform', 'terraform.tfvars.example'),
    join('ops', 'terraform', 'environments', 'cross-account.example.tfvars'),
  ];
  for (const rel of examples) {
    const abs = join(REPO_ROOT, rel);
    try {
      if (statSync(abs).isFile()) files.push(abs);
    } catch {
      /* absent example file is fine */
    }
  }
  return files;
}

describe('public-repo hygiene', () => {
  const files = publishableFiles();

  it('scans a non-trivial publishable surface', () => {
    expect(files.length).toBeGreaterThan(5);
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
