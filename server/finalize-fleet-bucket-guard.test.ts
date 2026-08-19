import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The prod release applies ops/terraform unattended, and the fleet bucket names
 * arrive as optional repo Variables: release-all.yml skips the TF_VAR_* export
 * when the Variable is blank, so a missing one silently falls through to the ""
 * default. Because the buckets already carry their real names in state, an empty
 * `bucket = ""` reads as omit-not-rename and the plan looks clean — while the
 * empty name interpolates into `arn:aws:s3:::/*` in both S3 policies and into
 * `FINALIZE_WORKTREE_BUCKET=` in the Hub env. resolveBundleStore() then reads the
 * empty bucket as "no store" and every remote Finalize job ships without a
 * worktree bundle. That is exactly the outage these tests exist to prevent, so
 * they pin the plan-time precondition rather than trusting review to catch it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TF_DIR = join(REPO_ROOT, 'ops', 'terraform');

const FLEET_BUCKET_VARS = ['finalize_worktree_bucket_name', 'finalize_cache_bucket_name'] as const;

function rootTerraformFiles(): { name: string; body: string }[] {
  return readdirSync(TF_DIR)
    .filter((f) => f.endsWith('.tf'))
    .map((name) => ({ name, body: readFileSync(join(TF_DIR, name), 'utf8') }));
}

const allRootTf = rootTerraformFiles()
  .map((f) => f.body)
  .join('\n');

const MODULE_DIR = join(TF_DIR, 'modules', 'finalize-runners');

/**
 * Every place a bucket name is baked into an S3 ARN or the Hub's runtime env,
 * resolved back to the ROOT variable it came from. Module-local names
 * (`var.worktree_bucket_name`) are mapped through the root module block's
 * assignment so a guard on the root variable actually covers them.
 */
function guardedRootVarsForS3Consumers(): Set<string> {
  const rootBlock = readFileSync(join(TF_DIR, 'finalize-runners.tf'), 'utf8');
  const moduleTf = readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(join(MODULE_DIR, f), 'utf8'))
    .join('\n');

  const consumed = new Set<string>();
  const bake =
    /arn:aws:s3:::\$\{var\.([a-z0-9_]+)\}|FINALIZE_[A-Z_]*BUCKET=\$\{var\.([a-z0-9_]+)\}/g;
  for (const body of [allRootTf, moduleTf]) {
    for (const m of body.matchAll(bake)) consumed.add(m[1] ?? m[2]);
  }

  const rootVars = new Set<string>();
  for (const name of consumed) {
    if (name.startsWith('finalize_')) {
      rootVars.add(name);
      continue;
    }
    // Module-local input: resolve through `<input> = var.<root>` in the block.
    const assign = new RegExp(`^\\s*${name}\\s*=\\s*var\\.([a-z0-9_]+)\\s*$`, 'm').exec(rootBlock);
    if (assign) rootVars.add(assign[1]);
  }
  return rootVars;
}

describe('finalize fleet bucket-name plan guard', () => {
  it('declares a guard resource gated on the fleet being enabled', () => {
    const body = readFileSync(join(TF_DIR, 'finalize-runners.tf'), 'utf8');
    expect(body).toContain('resource "terraform_data" "finalize_bucket_name_guard"');
    // Gated on the fleet, not on the bucket names: a guard keyed on a non-empty
    // name would evaluate to count = 0 in precisely the broken case.
    const guard = body.slice(
      body.indexOf('resource "terraform_data" "finalize_bucket_name_guard"'),
    );
    expect(guard).toMatch(/count\s*=\s*var\.enable_finalize_runners\s*\?\s*1\s*:\s*0/);
  });

  it.each(FLEET_BUCKET_VARS)('fails the plan when %s is empty', (varName) => {
    const body = readFileSync(join(TF_DIR, 'finalize-runners.tf'), 'utf8');
    const guard = body.slice(
      body.indexOf('resource "terraform_data" "finalize_bucket_name_guard"'),
    );
    expect(guard).toContain(`condition     = trimspace(var.${varName}) != ""`);
  });

  it.each(FLEET_BUCKET_VARS)(
    '%s is referenced as a guard input so the precondition is not skipped as a no-op',
    (varName) => {
      const body = readFileSync(join(TF_DIR, 'finalize-runners.tf'), 'utf8');
      const guard = body.slice(
        body.indexOf('resource "terraform_data" "finalize_bucket_name_guard"'),
      );
      const input = guard.slice(guard.indexOf('input = {'), guard.indexOf('lifecycle {'));
      expect(input).toContain(`var.${varName}`);
    },
  );

  it('guards every fleet bucket name that is baked into an S3 ARN or the Hub env', () => {
    const body = readFileSync(join(TF_DIR, 'finalize-runners.tf'), 'utf8');
    const consumers = guardedRootVarsForS3Consumers();
    // Sanity: if the names stop being interpolated anywhere, this test has gone
    // stale and should be re-pointed rather than silently passing.
    for (const varName of FLEET_BUCKET_VARS) {
      expect(
        consumers.has(varName),
        `${varName} is no longer interpolated into an S3 ARN or the Hub env`,
      ).toBe(true);
    }
    for (const varName of consumers) {
      expect(
        body,
        `${varName} is baked into an S3 ARN but has no non-empty precondition`,
      ).toContain(`trimspace(var.${varName}) != ""`);
    }
  });

  it('keeps the release workflow comment honest about downstream guards', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'release-all.yml'),
      'utf8',
    );
    // release-all.yml justifies treating the bucket Variables as optional by
    // pointing at "downstream Terraform guards". If that claim is ever the only
    // thing standing between a blank Variable and prod, it has to stay true.
    expect(workflow).toContain('TF_VAR_finalize_worktree_bucket_name');
    expect(workflow).toContain('TF_VAR_finalize_cache_bucket_name');
    expect(workflow).toMatch(/downstream Terraform guards/);
  });
});
