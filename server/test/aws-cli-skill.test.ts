/**
 * aws-cli default skill — shape + safety contract tests.
 *
 * Tests:
 *   1. SKILL.md frontmatter invariants (name, description, version)
 *   2. Scripts present and executable
 *   3. mask_secrets() redaction helper (via bash subprocess)
 *   4. aws-q.sh exits 2 with usage on bad invocation
 *   5. aws-whoami.sh handles missing credentials gracefully
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'aws-cli');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExecutable(file: string): boolean {
  const mode = statSync(file).mode;
  // User exec bit (0o100) must be set
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
    timeout: 10_000,
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

describe('aws-cli SKILL.md', () => {
  const skillMd = path.join(SKILL_DIR, 'SKILL.md');

  it('SKILL.md exists', () => {
    expect(existsSync(skillMd)).toBe(true);
  });

  it('contains name: aws-cli in frontmatter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toMatch(/^name:\s*aws-cli\s*$/m);
  });

  it('contains version in frontmatter', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content).toMatch(/^version:\s*\d+\.\d+\.\d+/m);
  });

  it('describes read-default safety model', () => {
    const content = readFileSync(skillMd, 'utf8');
    // Must mention the safety model keywords
    expect(content.toLowerCase()).toContain('confirm');
    expect(content.toLowerCase()).toContain('write');
  });

  it('mentions SSO / assume-role', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content.toLowerCase()).toContain('sso');
  });

  it('mentions JMESPath', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content.toLowerCase()).toContain('jmespath');
  });

  it('mentions pagination', () => {
    const content = readFileSync(skillMd, 'utf8');
    expect(content.toLowerCase()).toContain('pagina');
  });
});

// ---------------------------------------------------------------------------
// 2. Scripts present and executable
// ---------------------------------------------------------------------------

describe('aws-cli scripts', () => {
  const REQUIRED_SCRIPTS = ['_common.sh', 'aws-whoami.sh', 'aws-q.sh'];

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
// 3. mask_secrets() redaction (bash subprocess)
// ---------------------------------------------------------------------------

describe('mask_secrets() — redaction helper', () => {
  const commonSh = path.join(SCRIPTS_DIR, '_common.sh');

  it('masks AKIA access key IDs', () => {
    const result = runBash(
      `source '${commonSh}' && mask_secrets "AccessKeyId: AKIAIOSFODNN7EXAMPLE"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.stdout).toContain('[REDACTED_KEY_ID]');
  });

  it('masks ASIA (temporary) access key IDs', () => {
    const result = runBash(`source '${commonSh}' && mask_secrets "KeyId: ASIAIOSFODNN7EXAMPLE12"`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ASIAIOSFODNN7EXAMPLE');
    expect(result.stdout).toContain('[REDACTED_KEY_ID]');
  });

  it('masks SecretAccessKey values', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = runBash(`source '${commonSh}' && mask_secrets '"SecretAccessKey": "${secret}"'`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain('[REDACTED_SECRET]');
  });

  it('passes through non-sensitive output unchanged', () => {
    const result = runBash(`source '${commonSh}' && mask_secrets "Account: 123456789012"`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Account: 123456789012');
  });

  it('does not mask a short random string that happens to contain AKIA', () => {
    // "AKIA" with fewer than 16 trailing chars should NOT be masked
    const result = runBash(`source '${commonSh}' && mask_secrets "some AKIA short text"`);
    expect(result.status).toBe(0);
    // The pattern requires exactly 16 uppercase+digits after AKIA
    expect(result.stdout).toContain('AKIA');
  });
});

// ---------------------------------------------------------------------------
// 4. aws-q.sh — bad invocation exits 2 with usage
// ---------------------------------------------------------------------------

describe('aws-q.sh invocation guard', () => {
  const awsQ = path.join(SCRIPTS_DIR, 'aws-q.sh');

  it('exits 2 with usage when called with no arguments', () => {
    const result = runBash(
      `"${awsQ}"`,
      // Provide dummy AWS env to avoid real credential lookup
      { AWS_PROFILE: 'fake-profile', AWS_REGION: 'us-east-1' },
    );
    // Should exit 2 (usage error), not 0 or 1
    expect(result.status).toBe(2);
    expect(result.stderr.toLowerCase()).toContain('usage');
  });

  it('exits 2 with usage when called with only one argument', () => {
    const result = runBash(`"${awsQ}" ec2`, {
      AWS_PROFILE: 'fake-profile',
      AWS_REGION: 'us-east-1',
    });
    expect(result.status).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. aws-whoami.sh — missing credentials surfaces a helpful error
// ---------------------------------------------------------------------------

describe('aws-whoami.sh credential error handling', () => {
  const awsWhoami = path.join(SCRIPTS_DIR, 'aws-whoami.sh');

  it('exits non-zero and prints actionable guidance when no credentials are configured', () => {
    // Clear all credential env vars and point to a non-existent profile so
    // aws sts get-caller-identity returns a NoCredentialProviders error.
    const result = runBash(`"${awsWhoami}" --profile __nonexistent_test_profile__`, {
      AWS_PROFILE: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      HOME: '/tmp',
    });
    // Must exit non-zero
    expect(result.status).not.toBe(0);
    // Must surface actionable guidance — not a silent non-zero exit.
    // Accepts our own "error:" prefix, aws sso login hint, or aws's own error text.
    const combined = result.stderr + result.stdout;
    const hasCredGuidance =
      combined.includes('aws sso login') ||
      combined.includes('aws configure') ||
      combined.includes('No AWS credentials') ||
      combined.includes('AWS session token has expired') ||
      combined.includes('failed') ||
      combined.includes('error:') ||
      combined.toLowerCase().includes('no credential') ||
      combined.toLowerCase().includes('unable to locate');
    expect(hasCredGuidance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. References present
// ---------------------------------------------------------------------------

describe('aws-cli references', () => {
  const REQUIRED_REFS = [
    'profiles-and-regions.md',
    'sso-and-assume-role.md',
    'jmespath-recipes.md',
    'common-services.md',
    'pagination-and-output.md',
  ];
  const refsDir = path.join(SKILL_DIR, 'references');

  for (const ref of REQUIRED_REFS) {
    it(`references/${ref} exists`, () => {
      expect(existsSync(path.join(refsDir, ref))).toBe(true);
    });
  }
});
