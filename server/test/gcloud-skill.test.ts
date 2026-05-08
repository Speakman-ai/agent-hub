/**
 * gcloud default skill — shape + safety contract tests.
 *
 * Tests:
 *   1. SKILL.md frontmatter invariants (name, description, version)
 *   2. References present
 *   3. Scripts present and executable
 *   4. mask_secrets() redaction helper (via bash subprocess)
 *   5. gcloud-q.sh exits 2 with usage on bad invocation
 *   6. gcloud-whoami.sh handles missing credentials gracefully
 *   7. SKILL.md TRIGGER / DO-NOT-TRIGGER contract (Workspace exclusion)
 *   8. Active-config resolution chain in _common.sh
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'gcloud');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExecutable(file: string): boolean {
  const mode = statSync(file).mode;
  return (mode & 0o100) !== 0;
}

function runBash(
  script: string,
  env: Record<string, string> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// 1. SKILL.md shape
// ---------------------------------------------------------------------------

describe('gcloud SKILL.md', () => {
  const skillMd = path.join(SKILL_DIR, 'SKILL.md');

  it('SKILL.md exists', () => {
    expect(existsSync(skillMd)).toBe(true);
  });

  it('contains name: gcloud in frontmatter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toMatch(/^name:\s*gcloud\s*$/m);
  });

  it('contains version in frontmatter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toMatch(/^version:\s*\d+\.\d+\.\d+/m);
  });

  it('contains category in frontmatter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toMatch(/^category:\s*\S+/m);
  });

  it('describes read-default safety model (confirm required for writes)', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content.toLowerCase()).toContain('confirm');
    expect(content.toLowerCase()).toContain('write');
  });

  it('mentions --format output projection', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('--format');
  });

  it('mentions --filter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('--filter');
  });

  it('covers gsutil and bq alongside gcloud', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content.toLowerCase()).toContain('gsutil');
    expect(content.toLowerCase()).toContain('bq');
  });
});

// ---------------------------------------------------------------------------
// 2. TRIGGER / DO-NOT-TRIGGER contract
// ---------------------------------------------------------------------------

describe('gcloud SKILL.md — trigger contract', () => {
  const skillMd = path.join(SKILL_DIR, 'SKILL.md');
  let content: string;

  it('SKILL.md loads', () => {
    content = readFileSync(skillMd, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('TRIGGER includes GCP / Google Cloud', () => {
    content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('GCP');
    expect(content).toContain('Google Cloud');
  });

  it('TRIGGER includes gs:// URI pattern', () => {
    content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('gs://');
  });

  it('TRIGGER includes BigQuery', () => {
    content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('BigQuery');
  });

  it('DO-NOT-TRIGGER explicitly excludes Google Workspace / Drive / Gmail', () => {
    content = readFileSync(skillMd, 'utf8');
    const lower = content.toLowerCase();
    expect(lower).toContain('workspace');
    expect(lower).toContain('drive');
    expect(lower).toContain('gmail');
    // The exclusion must be in the DO-NOT-TRIGGER section (description frontmatter or body)
    const hasExclusion = content.includes('DO NOT TRIGGER') || content.includes('not trigger');
    expect(hasExclusion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. References present
// ---------------------------------------------------------------------------

describe('gcloud references', () => {
  const REQUIRED_REFS = [
    'auth-and-adc.md',
    'configurations.md',
    'format-and-filter.md',
    'common-services.md',
  ];
  const refsDir = path.join(SKILL_DIR, 'references');

  it('references/ directory exists', () => {
    expect(existsSync(refsDir)).toBe(true);
  });

  for (const ref of REQUIRED_REFS) {
    it(`references/${ref} exists`, () => {
      expect(existsSync(path.join(refsDir, ref))).toBe(true);
    });

    it(`references/${ref} is non-empty`, () => {
      const size = statSync(path.join(refsDir, ref)).size;
      expect(size).toBeGreaterThan(100);
    });
  }

  it('auth-and-adc.md covers service account keys', () => {
    const content = readFileSync(path.join(refsDir, 'auth-and-adc.md'), 'utf8');
    expect(content.toLowerCase()).toContain('service account');
  });

  it('auth-and-adc.md covers Application Default Credentials', () => {
    const content = readFileSync(path.join(refsDir, 'auth-and-adc.md'), 'utf8');
    expect(content).toContain('ADC');
  });

  it('configurations.md covers multi-config switching', () => {
    const content = readFileSync(path.join(refsDir, 'configurations.md'), 'utf8');
    expect(content).toContain('CLOUDSDK_ACTIVE_CONFIG_NAME');
  });

  it('format-and-filter.md covers value() projection', () => {
    const content = readFileSync(path.join(refsDir, 'format-and-filter.md'), 'utf8');
    expect(content).toContain('value(');
  });

  it('format-and-filter.md covers --filter operators', () => {
    const content = readFileSync(path.join(refsDir, 'format-and-filter.md'), 'utf8');
    expect(content).toContain('--filter');
  });

  it('common-services.md covers GKE', () => {
    const content = readFileSync(path.join(refsDir, 'common-services.md'), 'utf8');
    expect(content.toLowerCase()).toContain('gke');
  });

  it('common-services.md covers BigQuery', () => {
    const content = readFileSync(path.join(refsDir, 'common-services.md'), 'utf8');
    expect(content.toLowerCase()).toContain('bigquery');
  });

  it('common-services.md covers Cloud Run', () => {
    const content = readFileSync(path.join(refsDir, 'common-services.md'), 'utf8');
    expect(content.toLowerCase()).toContain('cloud run');
  });
});

// ---------------------------------------------------------------------------
// 4. Scripts present and executable
// ---------------------------------------------------------------------------

describe('gcloud scripts', () => {
  const REQUIRED_SCRIPTS = ['_common.sh', 'gcloud-whoami.sh', 'gcloud-q.sh'];

  for (const script of REQUIRED_SCRIPTS) {
    it(`${script} exists`, () => {
      expect(existsSync(path.join(SCRIPTS_DIR, script))).toBe(true);
    });

    it(`${script} is executable`, () => {
      expect(isExecutable(path.join(SCRIPTS_DIR, script))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. mask_secrets() — redaction helper (bash subprocess)
// ---------------------------------------------------------------------------

describe('mask_secrets() — redaction helper', () => {
  const commonSh = path.join(SCRIPTS_DIR, '_common.sh');

  it('masks OAuth access tokens (ya29.*)', () => {
    const token = 'ya29.c.c0ASRK0GbVkpLfAHSnBBKR7exampletokenthatisquitelon';
    const result = runBash(`source '${commonSh}' && mask_secrets "${token}"`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain('[REDACTED_ACCESS_TOKEN]');
  });

  it('masks refresh_token JSON field', () => {
    const input = '"refresh_token": "1//0xyz-some-refresh-token-value"';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('1//0xyz-some-refresh-token-value');
    expect(result.stdout).toContain('[REDACTED_REFRESH_TOKEN]');
  });

  it('masks access_token JSON field', () => {
    const input = '"access_token": "ya29.A0ARrdaM-some-token-value"';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ya29.A0ARrdaM-some-token-value');
    expect(result.stdout).toContain('[REDACTED_ACCESS_TOKEN]');
  });

  it('masks client_secret JSON field', () => {
    const input = '"client_secret": "GOCSPXSomeSecretValue12345"';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('GOCSPXSomeSecretValue12345');
    expect(result.stdout).toContain('[REDACTED_CLIENT_SECRET]');
  });

  it('masks private_key JSON field (SA key)', () => {
    const input = '"private_key": "-----BEGIN RSA PRIVATE KEY-----\\nMIIE..."';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('MIIe');
    expect(result.stdout).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('passes through non-sensitive output unchanged', () => {
    const input = 'projectId: my-gcp-project-123';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(input);
  });

  it('does not mask a short string that starts with ya29 but is too short', () => {
    // Less than 20 chars after "ya29." — must NOT be masked
    const input = 'ya29.short';
    const result = runBash(`source '${commonSh}' && mask_secrets '${input}'`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ya29.short');
  });
});

// ---------------------------------------------------------------------------
// 6. gcloud-q.sh — bad invocation exits 2 with usage
// ---------------------------------------------------------------------------

describe('gcloud-q.sh invocation guard', () => {
  const gcloudQ = path.join(SCRIPTS_DIR, 'gcloud-q.sh');

  it('exits 2 with usage when called with no arguments', () => {
    const result = runBash(`"${gcloudQ}"`, {
      CLOUDSDK_ACTIVE_CONFIG_NAME: 'default',
    });
    expect(result.status).toBe(2);
    expect(result.stderr.toLowerCase()).toContain('usage');
  });
});

// ---------------------------------------------------------------------------
// 7. gcloud-whoami.sh — missing credentials surfaces a helpful error
// ---------------------------------------------------------------------------

describe('gcloud-whoami.sh credential error handling', () => {
  const gcloudWhoami = path.join(SCRIPTS_DIR, 'gcloud-whoami.sh');

  it('exits non-zero and prints actionable guidance when gcloud is not on PATH', () => {
    // Prepend a temp directory (without gcloud) to PATH so the real system
    // tools (bash, sed, etc.) remain available but gcloud is not found.
    const script = `
      tmpdir=$(mktemp -d)
      trap 'rm -rf "$tmpdir"' EXIT
      export PATH="$tmpdir:$PATH"
      "${gcloudWhoami}"
    `;
    const result = runBash(script);
    // Must exit non-zero (exit 2 from require_gcloud)
    expect(result.status).not.toBe(0);
    // Must mention gcloud or install instructions
    const combined = result.stdout + result.stderr;
    const hasInstallHint =
      combined.toLowerCase().includes('gcloud') ||
      combined.toLowerCase().includes('install') ||
      combined.toLowerCase().includes('not found') ||
      combined.toLowerCase().includes('error');
    expect(hasInstallHint).toBe(true);
  });

  it('exits non-zero when gcloud reports no active accounts', () => {
    // Create a stub gcloud that reports empty auth list (no active accounts)
    const script = `
      tmpdir=$(mktemp -d)
      trap 'rm -rf "$tmpdir"' EXIT
      cat > "$tmpdir/gcloud" <<'STUB'
#!/usr/bin/env bash
# Stub gcloud: simulates authenticated but no active accounts
if [[ "$*" == *"auth list"* ]]; then
  echo "[]"
  exit 0
fi
if [[ "$*" == *"config"* ]]; then
  echo ""
  exit 0
fi
echo ""
exit 0
STUB
      chmod +x "$tmpdir/gcloud"
      export PATH="$tmpdir:$PATH"
      "${gcloudWhoami}"
    `;
    const result = runBash(script);
    // Must exit non-zero (no active accounts)
    expect(result.status).not.toBe(0);
    // Must surface actionable guidance
    const combined = result.stdout + result.stderr;
    const hasGuidance =
      combined.toLowerCase().includes('gcloud auth login') ||
      combined.toLowerCase().includes('credentials') ||
      combined.toLowerCase().includes('error') ||
      combined.toLowerCase().includes('no active');
    expect(hasGuidance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. _common.sh — config resolution chain
// ---------------------------------------------------------------------------

describe('_common.sh — active config resolution', () => {
  const commonSh = path.join(SCRIPTS_DIR, '_common.sh');

  it('GCLOUD_CLI_CONFIG takes top priority', () => {
    const result = runBash(`source '${commonSh}' && echo "$RESOLVED_CONFIG"`, {
      GCLOUD_CLI_CONFIG: 'my-explicit-config',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('my-explicit-config');
  });

  it('CLOUDSDK_ACTIVE_CONFIG_NAME is second priority', () => {
    // Only fires when GCLOUD_CLI_CONFIG is unset
    const result = runBash(`source '${commonSh}' && echo "$RESOLVED_CONFIG"`, {
      GCLOUD_CLI_CONFIG: '',
      CLOUDSDK_ACTIVE_CONFIG_NAME: 'staging-config',
      // Suppress gcloud binary calls by pointing PATH to a stub that echoes nothing
      PATH: `${path.join(SCRIPTS_DIR, '../..')}:${process.env.PATH ?? ''}`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('staging-config');
  });

  it('falls back to "default" when no config can be determined', () => {
    // We need gcloud to be available but return an empty active config.
    // We do this by overriding GCLOUD_CLI_CONFIG="" and CLOUDSDK_ACTIVE_CONFIG_NAME=""
    // and pointing PATH to a stub gcloud that outputs nothing.
    const stubDir = '/tmp/gcloud-stub-test';
    const setup = `
      mkdir -p '${stubDir}'
      cat > '${stubDir}/gcloud' <<'STUB'
#!/usr/bin/env bash
# Stub gcloud: outputs nothing for config list queries
exit 0
STUB
      chmod +x '${stubDir}/gcloud'
      export PATH='${stubDir}':$PATH
      export GCLOUD_CLI_CONFIG=''
      export CLOUDSDK_ACTIVE_CONFIG_NAME=''
      source '${commonSh}'
      echo "$RESOLVED_CONFIG"
    `;
    const result = runBash(setup);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('default');
  });

  it('mask_secrets strips ya29.* tokens from longer strings', () => {
    const longToken = 'ya29.' + 'A'.repeat(30);
    const result = runBash(`source '${commonSh}' && mask_secrets "token=${longToken}"`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(longToken);
    expect(result.stdout).toContain('[REDACTED_ACCESS_TOKEN]');
  });
});
