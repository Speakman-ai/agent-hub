import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Invariants for the Terraform S3 remote-state setup.
 *
 * The scripts/tf-init.sh bootstrap reads `bucket`, `region`, and optionally
 * `dynamodb_table` out of each env's backend.hcl. If any env ever goes live
 * without those keys, init silently picks the wrong state or errors with a
 * cryptic "Backend configuration required" message. These tests catch that
 * at PR time instead of at apply time.
 *
 * The real per-env `backend.hcl` is gitignored (it carries the account-specific
 * state bucket — see AH-1388); operators copy the tracked `backend.hcl.example`
 * template. These invariants are asserted against the committed `.example`
 * templates, which are the only backend configs present in a fresh checkout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tfDir = resolve(here, '..', 'ops', 'terraform');

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('ops/terraform/backend.tf', () => {
  const path = join(tfDir, 'backend.tf');

  it('declares an empty s3 backend block (values are supplied per-env via -backend-config)', () => {
    const tf = readText(path);
    expect(tf).toMatch(/terraform\s*\{[^}]*backend\s+"s3"\s*\{\s*\}/s);
  });
});

describe('ops/terraform/environments/*/backend.hcl.example', () => {
  const envsDir = join(tfDir, 'environments');
  const BACKEND_TEMPLATE = 'backend.hcl.example';
  const envs = readdirSync(envsDir).filter((name) => {
    const p = join(envsDir, name);
    return statSync(p).isDirectory();
  });

  // Simple HCL-ish parser for `key = value` lines. Matches the parser in
  // scripts/tf-init.sh — if this drifts, the script will too.
  function parseKV(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!m) continue;
      let v = m[2].trim();
      // Strip surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    return out;
  }

  it('every env ships a backend.hcl.example template', () => {
    // The real backend.hcl is gitignored; every env must still commit a
    // sanitized template so operators can bootstrap remote state.
    for (const env of envs) {
      const p = join(envsDir, env, BACKEND_TEMPLATE);
      expect(() => statSync(p), `missing ${p}`).not.toThrow();
    }
  });

  it('each backend.hcl.example sets bucket, region, and encrypt=true', () => {
    for (const env of envs) {
      const p = join(envsDir, env, BACKEND_TEMPLATE);
      const cfg = parseKV(readText(p));
      expect(cfg.bucket, `${env}: bucket`).toBeTruthy();
      expect(cfg.region, `${env}: region`).toBeTruthy();
      expect(cfg.encrypt, `${env}: encrypt must be true`).toBe('true');
    }
  });

  it('each backend.hcl.example specifies either use_lockfile=true OR dynamodb_table (state locking is required)', () => {
    for (const env of envs) {
      const p = join(envsDir, env, BACKEND_TEMPLATE);
      const cfg = parseKV(readText(p));
      const hasNativeLock = cfg.use_lockfile === 'true';
      const hasDdbLock = typeof cfg.dynamodb_table === 'string' && cfg.dynamodb_table.length > 0;
      expect(
        hasNativeLock || hasDdbLock,
        `${env}: must set use_lockfile=true or dynamodb_table`,
      ).toBe(true);
    }
  });

  it('each backend.hcl.example key matches the convention <env>/terraform.tfstate', () => {
    for (const env of envs) {
      const p = join(envsDir, env, BACKEND_TEMPLATE);
      const cfg = parseKV(readText(p));
      expect(cfg.key, `${env}: key convention`).toBe(`${env}/terraform.tfstate`);
    }
  });
});

describe('ops/terraform/main.tf — required_version floor', () => {
  const path = join(tfDir, 'main.tf');

  it('keeps the required_version floor at >= 1.5 so TF 1.7.x operators can still plan/apply', () => {
    // use_lockfile (TF >= 1.10) is opt-in per-env via backend.hcl; operators
    // on older TF use the DynamoDB lock-table fallback. The global gate must
    // stay low enough to accommodate both.
    const tf = readText(path);
    expect(tf).toMatch(/required_version\s*=\s*"(>=\s*1\.[0-9]\b|~>\s*1\.[0-9])/);
    expect(tf).not.toMatch(/required_version\s*=\s*">=\s*1\.1[0-9]"/);
  });
});

describe('ops/terraform/variables.tf — user_data_replace_on_change', () => {
  const path = join(tfDir, 'variables.tf');

  it('defaults to false so bootstrap edits do not replace the host unless operators opt in', () => {
    // True forces instance replacement whenever rendered user_data changes.
    // Default false pairs with `lifecycle.ignore_changes = [ami]` on
    // `aws_instance.app` so routine applies do not wipe the box; adopt bootstrap
    // on existing hosts via SSM, or `terraform apply -replace=aws_instance.app`,
    // or set this true temporarily for a deliberate rebuild.
    const tf = readText(path);
    const m = tf.match(/variable\s+"user_data_replace_on_change"\s*\{[\s\S]*?\n\}/);
    expect(m, 'variable block must exist').toBeTruthy();
    expect(m![0]).toMatch(/default\s*=\s*false/);
  });
});

describe('ops/terraform/main.tf — aws_instance.app lifecycle', () => {
  const path = join(tfDir, 'main.tf');

  it('ignores post-create ami drift so SSM recommended AMI updates do not replace the instance', () => {
    const tf = readText(path);
    expect(tf).toMatch(/resource\s+"aws_instance"\s+"app"/);
    expect(tf).toMatch(/ignore_changes\s*=\s*\[\s*ami\s*\]/);
  });
});

describe('ops/terraform/scripts/tf-init.sh', () => {
  const path = join(tfDir, 'scripts', 'tf-init.sh');

  it('is executable', () => {
    const mode = statSync(path).mode;
    // Check owner-executable bit
    expect(mode & 0o100, 'tf-init.sh must be executable').toBeTruthy();
  });

  it('creates the bucket with versioning, encryption, and public-access-block', () => {
    const sh = readText(path);
    expect(sh).toMatch(/s3api\s+create-bucket/);
    expect(sh).toMatch(/put-bucket-versioning[\s\S]*?Status=Enabled/);
    expect(sh).toMatch(/put-bucket-encryption/);
    expect(sh).toMatch(/put-public-access-block/);
  });

  it('handles the us-east-1 bucket-creation quirk (no LocationConstraint)', () => {
    // us-east-1 rejects `--create-bucket-configuration LocationConstraint=us-east-1`;
    // every other region requires it. The script must branch on this.
    const sh = readText(path);
    expect(sh).toMatch(/us-east-1/);
    expect(sh).toMatch(/LocationConstraint/);
  });

  it('passes the per-env backend.hcl to `terraform init -backend-config`', () => {
    const sh = readText(path);
    expect(sh).toMatch(/terraform init -backend-config=[^\s]+/);
  });
});
