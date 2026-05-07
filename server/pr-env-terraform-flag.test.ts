import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Contract guard for the PR-environments root flag introduced in
 * `[Pass2] Single TF root flag enable_pr_environments`.
 *
 * The Terraform module exposes one root flag, `enable_pr_environments`
 * (defaults true), and three nullable-bool per-piece overrides
 * (`enable_pr_env_wildcard_cert`, `enable_pr_env_route53_iam`,
 * `enable_pr_env_host_nginx`). Resources/checks/templates MUST reference the
 * resolved locals, never `var.enable_pr_env_*` directly, so the override
 * semantics stay consistent.
 *
 * This file is a textual contract test: it parses the .tf files and asserts
 * the variable declarations + the resolution shape. It intentionally does
 * NOT shell out to terraform — that would require AWS creds and slow CI by
 * minutes. The test exists to fail loudly when someone changes the contract
 * (e.g. flips a default back to false, or reintroduces a direct `var.`
 * reference inside a resource).
 */
describe('PR-environments root flag (enable_pr_environments)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tfDir = resolve(here, '..', 'ops', 'terraform');

  const variablesTf = readFileSync(resolve(tfDir, 'variables.tf'), 'utf8');
  const localsTf = readFileSync(resolve(tfDir, 'locals-agent-hub.tf'), 'utf8');
  const albTf = readFileSync(resolve(tfDir, 'alb.tf'), 'utf8');
  const ssmIamTf = readFileSync(resolve(tfDir, 'ssm-iam.tf'), 'utf8');
  const checksTf = readFileSync(resolve(tfDir, 'checks.tf'), 'utf8');
  const mainTf = readFileSync(resolve(tfDir, 'main.tf'), 'utf8');
  const ryanTfvars = readFileSync(resolve(tfDir, 'environments/ryan/ryan.tfvars'), 'utf8');

  /** Pull the body of a `variable "name" { ... }` block, naive but adequate. */
  function variableBlock(src: string, name: string): string {
    const re = new RegExp(`variable\\s+"${name}"\\s*\\{([\\s\\S]*?)^\\}`, 'm');
    const match = re.exec(src);
    if (!match) throw new Error(`variable "${name}" not found`);
    return match[1];
  }

  it('declares variable enable_pr_environments with default = true (root flag)', () => {
    const body = variableBlock(variablesTf, 'enable_pr_environments');
    expect(body).toMatch(/type\s*=\s*bool\b/);
    expect(body).toMatch(/default\s*=\s*true\b/);
  });

  it.each(['enable_pr_env_wildcard_cert', 'enable_pr_env_route53_iam', 'enable_pr_env_host_nginx'])(
    'declares %s as a nullable bool override defaulting to null',
    (varName) => {
      const body = variableBlock(variablesTf, varName);
      expect(body, `${varName} must be type bool`).toMatch(/type\s*=\s*bool\b/);
      expect(body, `${varName} must default to null`).toMatch(/default\s*=\s*null\b/);
      expect(body, `${varName} must be marked nullable = true`).toMatch(/nullable\s*=\s*true\b/);
    },
  );

  /**
   * The three locals must follow the contract:
   *   pr_env_<piece>_enabled =
   *     var.enable_pr_env_<piece> != null
   *     ? var.enable_pr_env_<piece>
   *     : var.enable_pr_environments
   *
   * Non-null override wins; null falls through to the root flag.
   */
  it.each([
    ['pr_env_wildcard_cert_enabled', 'enable_pr_env_wildcard_cert'],
    ['pr_env_route53_iam_enabled', 'enable_pr_env_route53_iam'],
    ['pr_env_host_nginx_enabled', 'enable_pr_env_host_nginx'],
  ])('local.%s resolves override → root flag', (localName, varName) => {
    // Whitespace-tolerant regex — the live file uses multi-line ternaries.
    const re = new RegExp(
      `${localName}\\s*=\\s*\\(?\\s*` +
        `var\\.${varName}\\s*!=\\s*null\\s*` +
        `\\?\\s*var\\.${varName}\\s*` +
        `:\\s*var\\.enable_pr_environments`,
      'm',
    );
    expect(
      localsTf,
      `local.${localName} must be derived from var.${varName} || var.enable_pr_environments`,
    ).toMatch(re);
  });

  it('alb.tf gates the wildcard cert on the resolved local, not the raw variable', () => {
    expect(albTf).not.toMatch(/var\.enable_pr_env_wildcard_cert\b/);
    expect(albTf).toMatch(/local\.pr_env_wildcard_cert_enabled\b/);
  });

  it('alb.tf provisions wildcard Route 53 alias for PR preview hostnames when host nginx is effectively enabled', () => {
    expect(albTf).toContain('resource "aws_route53_record" "pr_env_preview_wildcard"');
    expect(albTf).not.toMatch(
      /resource\s+"aws_route53_record"\s+"pr_env_preview_wildcard"\s*\{[\s\S]*?var\.enable_pr_env_host_nginx\b/ms,
    );
    expect(albTf).toMatch(
      /resource\s+"aws_route53_record"\s+"pr_env_preview_wildcard"\s*\{[\s\S]*?local\.pr_env_host_nginx_enabled/ms,
    );
  });

  it('ssm-iam.tf gates the Route 53 inline policy on the resolved local', () => {
    expect(ssmIamTf).not.toMatch(/var\.enable_pr_env_route53_iam\b/);
    expect(ssmIamTf).toMatch(/local\.pr_env_route53_iam_enabled\b/);
  });

  it('checks.tf early-warning surface uses the resolved local', () => {
    expect(checksTf).not.toMatch(/var\.enable_pr_env_wildcard_cert\b/);
    expect(checksTf).toMatch(/local\.pr_env_wildcard_cert_enabled\b/);
  });

  it('main.tf SG rule + cert_renewal_email precondition use the resolved local', () => {
    // The SG dynamic block and the precondition are the two boolean gates
    // in main.tf. Both must reference the local, not the bare variable.
    expect(mainTf).not.toMatch(/var\.enable_pr_env_host_nginx\b/);
    // At least two distinct usages of the local — SG ingress + precondition.
    const hits = mainTf.match(/local\.pr_env_host_nginx_enabled\b/g) ?? [];
    expect(
      hits.length,
      'expected ≥2 local.pr_env_host_nginx_enabled refs in main.tf',
    ).toBeGreaterThanOrEqual(2);
  });

  it('locals-agent-hub.tf composes pr_env_config / preview host from the resolved local', () => {
    // Outside of the override-resolution lines themselves (the only allowed
    // use of `var.enable_pr_env_*` is the three locals' RHS), the rest of
    // the file must use the resolved locals.
    const offending = [
      ...localsTf.matchAll(/var\.enable_pr_env_(wildcard_cert|route53_iam|host_nginx)\b/g),
    ];
    // The three legal references live on the override-resolution lines;
    // anything beyond that is a contract violation.
    expect(offending.length).toBeLessThanOrEqual(6);
    // And the user-data / config builders must use the locals.
    expect(localsTf).toMatch(/local\.pr_env_host_nginx_enabled\b/);
  });

  it('environments/ryan/ryan.tfvars no longer needs the per-piece flag lines', () => {
    // Per Pass2 acceptance, ryan.tfvars simplifies — the root flag defaults
    // to true so we only need to keep the cert email. The three per-piece
    // assignments are intentionally removed.
    expect(ryanTfvars).not.toMatch(/^\s*enable_pr_env_wildcard_cert\s*=/m);
    expect(ryanTfvars).not.toMatch(/^\s*enable_pr_env_route53_iam\s*=/m);
    expect(ryanTfvars).not.toMatch(/^\s*enable_pr_env_host_nginx\s*=/m);
    // cert_renewal_email is still required for the wildcard cert issuance.
    expect(ryanTfvars).toMatch(/^\s*cert_renewal_email\s*=\s*"[^"]+@[^"]+"\s*$/m);
  });
});

/**
 * Pure-JS mirror of the override-resolution rule, useful for documenting the
 * semantics in a way operators can also read. If this matrix ever drifts
 * from the Terraform locals, the contract tests above will fail first.
 */
function resolveEffective(rootFlag: boolean, override: boolean | null): boolean {
  return override !== null ? override : rootFlag;
}

describe('override resolution semantics', () => {
  it('null override falls through to the root flag (true)', () => {
    expect(resolveEffective(true, null)).toBe(true);
  });

  it('null override falls through to the root flag (false)', () => {
    expect(resolveEffective(false, null)).toBe(false);
  });

  it('false override wins over true root flag (per-piece testing disable)', () => {
    expect(resolveEffective(true, false)).toBe(false);
  });

  it('true override wins over false root flag (per-piece testing enable)', () => {
    expect(resolveEffective(false, true)).toBe(true);
  });
});
