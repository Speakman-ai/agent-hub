import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Absence guard for the PR-environments Terraform stack.
 *
 * After PR-Env Removal #6, the entire PR-env Terraform subsystem is gone:
 *   - aws_acm_certificate.pr_env_wildcard{,_cert} + DNS-01 validation records
 *   - aws_route53_record.pr_env_preview_wildcard (*.preview A-record alias)
 *   - aws_iam_role_policy.pr_env_route53 / pr_env_ssm_secrets
 *   - SG dynamic ingress for ports 3100-3999
 *   - All locals.pr_env_* toggles, vars (pr_env_preview_subdomain,
 *     cert_renewal_email, enable_pr_env_host_nginx, etc.) and outputs
 *   - templates/pr-env-base-nginx.conf.tftpl
 *   - User-data %{ if pr_env_enabled } branches
 *
 * This file is a textual contract test: it parses the .tf files and asserts
 * that none of the removed identifiers reappear. Reintroducing PR-env
 * Terraform should fail loudly here.
 */
describe('PR-environments Terraform removal contract', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tfDir = resolve(here, '..', 'ops', 'terraform');

  const variablesTf = readFileSync(resolve(tfDir, 'variables.tf'), 'utf8');
  const localsTf = readFileSync(resolve(tfDir, 'locals-agent-hub.tf'), 'utf8');
  const albTf = readFileSync(resolve(tfDir, 'alb.tf'), 'utf8');
  const ssmIamTf = readFileSync(resolve(tfDir, 'ssm-iam.tf'), 'utf8');
  const checksTf = readFileSync(resolve(tfDir, 'checks.tf'), 'utf8');
  const mainTf = readFileSync(resolve(tfDir, 'main.tf'), 'utf8');
  const outputsTf = readFileSync(resolve(tfDir, 'outputs.tf'), 'utf8');
  const userData = readFileSync(resolve(tfDir, 'agent-hub-user-data.tftpl'), 'utf8');
  const tfvarsExample = readFileSync(resolve(tfDir, 'terraform.tfvars.example'), 'utf8');
  // Assert against the tracked .example template (dev env is decommissioned).
  const devTfvarsExample = readFileSync(
    resolve(tfDir, 'environments/dev/dev.tfvars.example'),
    'utf8',
  );

  // -- Variables ------------------------------------------------------------

  it.each([
    'enable_pr_environments',
    'enable_pr_env_wildcard_cert',
    'enable_pr_env_route53_iam',
    'enable_pr_env_ssm_secrets',
    'enable_pr_env_host_nginx',
    'pr_env_preview_subdomain',
    'pr_env_ssm_path_prefix',
    'cert_renewal_email',
  ])('variable "%s" no longer declared in variables.tf', (varName) => {
    const re = new RegExp(`variable\\s+"${varName}"\\s*\\{`);
    expect(variablesTf).not.toMatch(re);
  });

  // -- Locals ---------------------------------------------------------------

  it('no pr_env_* locals remain in locals-agent-hub.tf', () => {
    // Comments (lines starting with #) are allowed to reference the removal.
    const codeLines = localsTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/\bpr_env_/);
  });

  // -- Resources ------------------------------------------------------------

  it('alb.tf no longer declares the PR-env wildcard cert / validation / preview record', () => {
    const codeLines = albTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/aws_acm_certificate.*pr_env/);
    expect(codeLines).not.toMatch(/aws_route53_record.*pr_env/);
    expect(codeLines).not.toMatch(/aws_acm_certificate_validation.*pr_env/);
  });

  it('ssm-iam.tf no longer declares pr_env_route53 / pr_env_ssm_secrets policies', () => {
    const codeLines = ssmIamTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/aws_iam_role_policy.*pr_env_/);
  });

  it('checks.tf no longer references pr_env locals', () => {
    const codeLines = checksTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/\bpr_env_/);
  });

  it('main.tf no longer references pr_env locals or cert_renewal_email', () => {
    const codeLines = mainTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/\bpr_env_/);
    expect(codeLines).not.toMatch(/cert_renewal_email/);
  });

  // -- Outputs --------------------------------------------------------------

  it('outputs.tf no longer exports any pr_env_* outputs', () => {
    const codeLines = outputsTf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toMatch(/output\s+"pr_env_/);
  });

  // -- User-data template --------------------------------------------------

  it('agent-hub-user-data.tftpl has no %{ if pr_env_enabled } branches', () => {
    expect(userData).not.toMatch(/pr_env_enabled/);
    expect(userData).not.toMatch(/pr_env_base_nginx_conf/);
    expect(userData).not.toMatch(/pr_env_preview_host/);
    expect(userData).not.toMatch(/config_json_b64/);
    expect(userData).not.toMatch(/cert_renewal_email/);
  });

  // -- Deleted nginx template ----------------------------------------------

  it('templates/pr-env-base-nginx.conf.tftpl no longer exists', () => {
    expect(existsSync(resolve(tfDir, 'templates/pr-env-base-nginx.conf.tftpl'))).toBe(false);
  });

  // -- Example tfvars + dev.tfvars.example ---------------------------------

  it('terraform.tfvars.example no longer mentions PR-env vars', () => {
    expect(tfvarsExample).not.toMatch(/enable_pr_environments\s*=/);
    expect(tfvarsExample).not.toMatch(/^\s*cert_renewal_email\s*=/m);
  });

  it('dev.tfvars.example no longer assigns PR-env vars', () => {
    expect(devTfvarsExample).not.toMatch(/^\s*enable_pr_env/m);
    expect(devTfvarsExample).not.toMatch(/^\s*cert_renewal_email\s*=/m);
    expect(devTfvarsExample).not.toMatch(/^\s*pr_env_preview_subdomain\s*=/m);
  });
});
