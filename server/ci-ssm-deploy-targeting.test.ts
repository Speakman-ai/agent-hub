import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the release rollout dying with
 *   AccessDeniedException ... not authorized to perform: ssm:SendCommand
 *   on resource: arn:aws:ec2:<region>:<acct>:instance/i-<new sandbox>
 *
 * The deploy targets are configured twice — the DOCKER_DEPLOY_INSTANCE_ID /
 * DOCKER_DEPLOY_DEV_INSTANCE_ID repo Variables read by rollout workflows, and
 * the Terraform inputs that scope the CI role's SSM grant. The tfvars side is
 * committed (`environments/prod/prod.tfvars`); the Variable lives in GitHub
 * repo settings. When the sandbox was
 * rebuilt, the Variable moved to the new instance and the IAM policy kept naming
 * the old one, so every release failed at the SSM step.
 *
 * Two invariants close that: Terraform resolves targets by tag at plan time
 * (a rebuilt box under the same tag re-grants on the next apply) and refuses to
 * ship a grant that resolved zero instances, and the workflow translates the
 * IAM denial into the remediation instead of a bare exit 254.
 *
 * Neither of those can catch a grant that resolved exactly one *wrong* box,
 * which is what actually happened: the Variable moved to the new sandbox, the
 * tfvars kept the old id, "at least one target resolved" stayed true, and the
 * apply shipped a policy that could never authorise the rollout. So the release
 * pipeline now feeds Terraform both repo Variables the rollout workflows read
 * (TF_VAR_ci_ssm_expected_deploy_instance_ids) and the plan asserts the resolved
 * grant contains every non-empty target. The two stores are diffed at plan time,
 * in the one place that sees both.
 */

const repoRoot = path.join(__dirname, '..');
const tfDir = path.join(repoRoot, 'ops', 'terraform');
const iamTfPath = path.join(tfDir, 'iam-ci-ssm-deploy.tf');
const variablesTfPath = path.join(tfDir, 'variables.tf');
const rolloutWorkflowPath = path.join(
  repoRoot,
  '.github',
  'workflows',
  'ecr-publish-rollout-docker-dev.yml',
);
const releaseWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release-all.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('ops/terraform CI SSM deploy targeting', () => {
  it('declares ci_ssm_deploy_instance_tags as an optional tag map', () => {
    const tf = read(variablesTfPath);
    const block = tf.match(/variable "ci_ssm_deploy_instance_tags" \{([\s\S]*?)\n\}/);
    expect(block, 'ci_ssm_deploy_instance_tags variable must exist').toBeTruthy();
    expect(block![1]).toMatch(/type\s*=\s*map\(string\)/);
    expect(block![1], 'must stay opt-in so existing id-only workspaces are unaffected').toMatch(
      /default\s*=\s*\{\}/,
    );
  });

  it('resolves the target set from tags at plan time, including non-running instances', () => {
    const tf = read(iamTfPath);
    const block = tf.match(/data "aws_instances" "ci_ssm_deploy_targets" \{([\s\S]*?)\n\}/);
    expect(block, 'tag lookup data source must exist').toBeTruthy();
    expect(block![1]).toMatch(/instance_tags\s*=\s*var\.ci_ssm_deploy_instance_tags/);
    // A stopped sandbox is still the deploy target; dropping it from the grant
    // would break the next rollout after someone stops the box overnight.
    expect(block![1]).toMatch(/instance_state_names\s*=\s*\[[^\]]*"stopped"[^\]]*\]/);
  });

  it('unions the explicit instance id with tag-resolved ids', () => {
    const tf = read(iamTfPath);
    const union = tf.match(
      /ci_ssm_target_instance_ids\s*=\s*([\s\S]*?)\n\s*ci_ssm_target_instance_arns/,
    );
    expect(union, 'ci_ssm_target_instance_ids local must exist').toBeTruthy();
    expect(union![1], 'explicit id must still be honoured').toContain('ci_ssm_instance_id');
    expect(union![1], 'tag-resolved ids must be included').toContain(
      'ci_ssm_discovered_instance_ids',
    );
    // Set semantics: an operator who sets BOTH knobs to the same box must not
    // produce a duplicate ARN in the policy document.
    expect(union![1]).toContain('toset(');
  });

  it('grants SendCommand on every resolved instance ARN, not one interpolated id', () => {
    const tf = read(iamTfPath);
    const statement = tf.match(/Sid\s*=\s*"SendRunShellScriptToDeployTarget"([\s\S]*?)\n {6}\}/);
    expect(statement, 'SendCommand statement must exist').toBeTruthy();
    expect(statement![1]).toContain('local.ci_ssm_target_instance_arns');
    // The pinned single-instance ARN is what went stale — it must not come back.
    expect(
      statement![1],
      'SendCommand resources must come from the resolved set, not a single interpolated id',
    ).not.toMatch(/instance\/\$\{local\.ci_ssm_instance_id\}/);
    // Tag matching happens under Terraform, at plan time. Granting
    // `instance/*` with a request-time tag condition would let anyone holding
    // ec2:CreateTags widen the CI role's blast radius.
    expect(statement![1], 'the grant must stay scoped to concrete instance ARNs').not.toContain(
      'ssm:resourceTag/',
    );
  });

  it('enables the policy when only tags are configured', () => {
    const tf = read(iamTfPath);
    const enabled = tf.match(/ci_ssm_deploy_enabled\s*=\s*([\s\S]*?)\n\s*\)/);
    expect(enabled, 'ci_ssm_deploy_enabled local must exist').toBeTruthy();
    expect(enabled![1]).toContain('var.enable_ci_ssm_deploy_after_ecr_push');
    expect(
      enabled![1],
      'a tags-only workspace must still attach the policy (id no longer required)',
    ).toMatch(/length\(var\.ci_ssm_deploy_instance_tags\)\s*>\s*0/);
  });

  it('fails the apply when the configuration resolves zero deploy targets', () => {
    const tf = read(iamTfPath);
    // Scoped to the policy resource: other resources in this file carry their
    // own preconditions, and this invariant belongs to the grant itself.
    const policy = tf.match(
      /resource "aws_iam_role_policy" "github_actions_ecr_push_ssm_dev_deploy" \{([\s\S]*?)\n\}/,
    );
    expect(policy, 'the SSM deploy policy resource must exist').toBeTruthy();
    const precondition = policy![1].match(/precondition \{([\s\S]*?)\n {4}\}/);
    expect(precondition, 'policy must carry a lifecycle precondition').toBeTruthy();
    expect(precondition![1]).toMatch(/length\(local\.ci_ssm_target_instance_ids\)\s*>\s*0/);
    expect(precondition![1], 'the error must name the knobs an operator has to fix').toContain(
      'ci_ssm_deploy_instance_tags',
    );
    expect(precondition![1]).toContain('DOCKER_DEPLOY_INSTANCE_ID');
  });

  it('keeps real instance ids out of the tracked tfvars templates', () => {
    for (const env of ['dev', 'prod']) {
      const example = read(path.join(tfDir, 'environments', env, `${env}.tfvars.example`));
      const tags = example.match(/^\s*ci_ssm_deploy_instance_tags\s*=\s*(.+)$/m);
      expect(tags?.[1], `ci_ssm_deploy_instance_tags in ${env}.tfvars.example`).toBeTruthy();
      expect(tags![1], 'placeholder only — no live tag values in the public tree').toContain('<');
      expect(example).not.toMatch(/i-[a-f0-9]{8,}/);
    }
  });
});

describe('ops/terraform plan-time guard: the grant must cover the rollout target', () => {
  it('keeps the singular expected target as an optional compatibility input', () => {
    const tf = read(variablesTfPath);
    const block = tf.match(/variable "ci_ssm_expected_deploy_instance_id" \{([\s\S]*?)\n\}/);
    expect(block, 'ci_ssm_expected_deploy_instance_id variable must exist').toBeTruthy();
    expect(block![1]).toMatch(/type\s*=\s*string/);
    // Empty must stay the default: an operator running a local plan does not
    // necessarily know the repo Variable, and this must not become a required
    // input that breaks every existing workspace.
    expect(block![1], 'must be opt-in').toMatch(/default\s*=\s*""/);
  });

  it('declares a complete optional list of expected runtime targets', () => {
    const tf = read(variablesTfPath);
    const block = tf.match(/variable "ci_ssm_expected_deploy_instance_ids" \{([\s\S]*?)\n\}/);
    expect(block, 'ci_ssm_expected_deploy_instance_ids variable must exist').toBeTruthy();
    expect(block![1]).toMatch(/type\s*=\s*list\(string\)/);
    expect(block![1], 'must be opt-in for local plans').toMatch(/default\s*=\s*\[\]/);
    expect(block![1]).toContain('DOCKER_DEPLOY_INSTANCE_ID');
    expect(block![1]).toContain('DOCKER_DEPLOY_DEV_INSTANCE_ID');
  });

  it('is an assertion input only — it must never widen the grant', () => {
    const tf = read(iamTfPath);
    const union = tf.match(
      /ci_ssm_target_instance_ids\s*=\s*([\s\S]*?)\n\s*ci_ssm_target_instance_arns/,
    );
    expect(union, 'ci_ssm_target_instance_ids local must exist').toBeTruthy();
    // The whole point is that CI declares what it will hit and Terraform checks
    // it. If the expected id fed the target set instead, editing a repo Variable
    // would silently grant the CI role SendCommand on any instance in the
    // account, and the drift this guard exists to catch would "fix" itself into
    // an unreviewed grant.
    expect(
      union![1],
      'the expected id must not be unioned into the granted target set',
    ).not.toContain('ci_ssm_expected');

    const arns = tf.match(/ci_ssm_target_instance_arns\s*=\s*\[([\s\S]*?)\n {2}\]/);
    expect(arns, 'ci_ssm_target_instance_arns local must exist').toBeTruthy();
    expect(arns![1], 'ARNs must be built from the resolved set only').not.toContain(
      'ci_ssm_expected',
    );
  });

  it('fails coverage when the DEV target is missing even if the release target is covered', () => {
    const tf = read(iamTfPath);
    const expected = tf.match(
      /ci_ssm_expected_instance_ids\s*=\s*([\s\S]*?)\n\s*ci_ssm_missing_expected_instance_ids/,
    );
    expect(expected, 'the complete expected-target local must exist').toBeTruthy();
    expect(expected![1]).toContain('var.ci_ssm_expected_deploy_instance_ids');

    const missing = tf.match(
      /ci_ssm_missing_expected_instance_ids\s*=\s*([\s\S]*?)\n\s*ci_ssm_expected_covered/,
    );
    expect(missing, 'the guard must calculate every missing target').toBeTruthy();
    expect(missing![1]).toContain('setsubtract(');
    expect(missing![1]).toContain('local.ci_ssm_expected_instance_ids');
    expect(missing![1]).toContain('local.ci_ssm_target_instance_ids');

    const covered = tf.match(/ci_ssm_expected_covered\s*=\s*(.+)/);
    expect(covered, 'ci_ssm_expected_covered local must exist').toBeTruthy();
    expect(covered![1], 'coverage requires no missing runtime targets').toMatch(
      /length\(local\.ci_ssm_missing_expected_instance_ids\)\s*==\s*0/,
    );
  });

  it('hangs the guard on a resource that exists even when the grant does not', () => {
    const tf = read(iamTfPath);
    const guard = tf.match(
      /resource "terraform_data" "ci_ssm_deploy_target_guard" \{([\s\S]*?)\n\}/,
    );
    expect(guard, 'the guard resource must exist').toBeTruthy();
    // Keyed on the expected ids, NOT on ci_ssm_deploy_enabled: turning the
    // feature off drops the grant entirely, which breaks the rollout in exactly
    // the same AccessDenied way. A guard that vanishes with the policy could not
    // catch that.
    expect(guard![1], 'guard must be keyed on the expected targets').toMatch(
      /count\s*=\s*length\(local\.ci_ssm_expected_instance_ids\)\s*>\s*0\s*\?\s*1\s*:\s*0/,
    );
    const conditions = [...guard![1].matchAll(/condition\s*=\s*(.+)/g)].map((m) => m[1]);
    expect(conditions.some((c) => c.includes('ci_ssm_deploy_enabled'))).toBe(true);
    expect(conditions.some((c) => c.includes('ci_ssm_expected_covered'))).toBe(true);
  });

  it('re-evaluates whenever either side of the drift moves', () => {
    const tf = read(iamTfPath);
    const guard = tf.match(
      /resource "terraform_data" "ci_ssm_deploy_target_guard" \{([\s\S]*?)\n\}/,
    );
    const input = guard![1].match(/input\s*=\s*\{([\s\S]*?)\n {2}\}/);
    expect(input, 'guard must carry an input').toBeTruthy();
    // Both stores in the input means any move on either side plans a change on
    // this resource, so the preconditions are guaranteed to be evaluated in the
    // scenario they exist for — rather than relying on whether Terraform
    // evaluates preconditions for a no-op resource.
    expect(input![1]).toContain('local.ci_ssm_expected_instance_ids');
    expect(input![1]).toContain('local.ci_ssm_target_instance_ids');
  });

  it('names both drifting values in the failure, not just the knobs', () => {
    const tf = read(iamTfPath);
    const guard = tf.match(
      /resource "terraform_data" "ci_ssm_deploy_target_guard" \{([\s\S]*?)\n\}/,
    );
    // Line-based on purpose: these messages interpolate `join(", ", …)`, whose
    // nested quotes defeat any naive quoted-string match.
    const messages = [...guard![1].matchAll(/error_message\s*=\s*(.+)/g)].map((m) => m[1]);
    expect(messages.length, 'both preconditions must explain themselves').toBeGreaterThanOrEqual(2);
    const joined = messages.join('\n');
    // The operator cannot see either store from the plan output, so the message
    // has to carry the actual ids — that is the difference between this and the
    // bare IAM denial it replaces.
    expect(joined, 'must interpolate every expected id').toContain(
      'local.ci_ssm_expected_instance_ids',
    );
    expect(joined, 'must identify the subset absent from the grant').toContain(
      'local.ci_ssm_missing_expected_instance_ids',
    );
    expect(joined, 'must interpolate what actually resolved').toContain(
      'local.ci_ssm_target_instance_ids',
    );
    expect(joined).toContain('DOCKER_DEPLOY_INSTANCE_ID');
    expect(joined).toContain('DOCKER_DEPLOY_DEV_INSTANCE_ID');
    expect(joined).toContain('ci_ssm_deploy_instance_tags');
    expect(joined, 'the disabled-feature case must name the flag').toContain(
      'enable_ci_ssm_deploy_after_ecr_push',
    );
  });

  it('keeps real instance ids out of the tracked tfvars templates', () => {
    for (const env of ['dev', 'prod']) {
      const example = read(path.join(tfDir, 'environments', env, `${env}.tfvars.example`));
      expect(
        example,
        `${env}.tfvars.example must document the guard so operators know CI supplies it`,
      ).toContain('ci_ssm_expected_deploy_instance_ids');
      expect(example).not.toMatch(/i-[a-f0-9]{8,}/);
    }
  });
});

describe('release-all.yml feeds Terraform every rollout target', () => {
  const yml = read(releaseWorkflowPath);
  const tfJob = yml.match(/\n {2}terraform-apply:\n([\s\S]*?)\n {2}[a-z][a-z-]*:\n/);

  it('injects the prod sandbox Variable into the expected target list', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    const line = tfJob![1].match(/^\s*TF_VAR_ci_ssm_expected_deploy_instance_ids:\s*(.+)$/m);
    expect(line, 'Terraform must receive the runtime target list').toBeTruthy();
    expect(line![1]).toContain('${{ vars.DOCKER_DEPLOY_INSTANCE_ID }}');
    expect(line![1], 'DEV Hub is decommissioned — do not require it in the grant').not.toContain(
      'DOCKER_DEPLOY_DEV_INSTANCE_ID',
    );
  });

  it('sets it at job scope so terraform plan sees it', () => {
    // `terraform apply` consumes the saved plan, so the var has to be present
    // during plan or the precondition is never evaluated.
    const jobEnv = tfJob![1].match(/^ {4}env:\n((?: {6}.*\n)+)/m);
    expect(jobEnv, 'terraform-apply must declare a job-level env block').toBeTruthy();
    expect(jobEnv![1]).toContain('TF_VAR_ci_ssm_expected_deploy_instance_ids');
  });

  it('still guards the plan it applies', () => {
    // The precondition fails the plan step; this asserts the pipeline has not
    // been reordered to apply something it never planned under the guard.
    const planIdx = tfJob![1].indexOf('terraform plan -input=false');
    const applyIdx = tfJob![1].indexOf('terraform apply -input=false -auto-approve');
    expect(planIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(planIdx);
  });
});

describe('ecr-publish-rollout-docker-dev.yml SSM failure diagnostics', () => {
  const yml = read(rolloutWorkflowPath);

  it('traps a failed send-command instead of letting a bare exit 254 through', () => {
    expect(yml, 'send-command must run under a failure branch').toMatch(
      /if ! CMD_ID="\$\(aws ssm send-command/,
    );
    expect(yml, 'stderr must be captured so it can be classified and echoed').toMatch(
      /2>"\$SEND_ERR"/,
    );
    expect(yml, 'the captured stderr must still reach the log').toMatch(/cat "\$SEND_ERR" >&2/);
  });

  it('turns an AccessDenied on SendCommand into the actual remediation', () => {
    const branch = yml.match(
      /if grep -q 'AccessDeniedException' "\$SEND_ERR"; then([\s\S]*?)\n {12}fi/,
    );
    expect(branch, 'AccessDenied must be classified explicitly').toBeTruthy();
    const message = branch![1];
    expect(message, 'must be a GitHub annotation, not a plain echo').toContain('::error::');
    // Both sides of the drift have to be named, or the reader is back to
    // decoding an IAM ARN against a repo Variable they cannot see.
    expect(message).toContain('DOCKER_DEPLOY_INSTANCE_ID');
    expect(message).toContain('ci_ssm_deploy_instance_tags');
    expect(message, 'must name the Terraform resource that owns the grant').toContain(
      'github_actions_ecr_push_ssm_dev_deploy',
    );
  });

  it('explains that the plan guard covers the runtime target', () => {
    const branch = yml.match(
      /if grep -q 'AccessDeniedException' "\$SEND_ERR"; then([\s\S]*?)\n {12}fi/,
    );
    // With the guard wired, reaching this branch means the repo Variable
    // moved after the last release apply.
    expect(branch![1]).toContain('TF_VAR_ci_ssm_expected_deploy_instance_ids');
    expect(branch![1]).toContain('DOCKER_DEPLOY_INSTANCE_ID');
  });

  it('still fails the job when send-command is denied', () => {
    const failureBlock = yml.match(
      /cat "\$SEND_ERR" >&2([\s\S]*?)\n {10}fi\n {10}echo "SSM CommandId=\$CMD_ID"/,
    );
    expect(failureBlock, 'failure branch must precede the CommandId echo').toBeTruthy();
    expect(failureBlock![1], 'a denied rollout must not be reported as success').toMatch(
      /\n {12}exit 1$/,
    );
  });
});

const WIDENED_FINALIZE_INSTANCE_TYPES = [
  'm7a.xlarge',
  'm7i.xlarge',
  'm6a.xlarge',
  'm6i.xlarge',
  'm6in.xlarge',
  'm6id.xlarge',
  'm6idn.xlarge',
  'm5.xlarge',
  'm5a.xlarge',
  'm5n.xlarge',
  'm5d.xlarge',
  'm5dn.xlarge',
  'm5ad.xlarge',
  'm5zn.xlarge',
] as const;

describe('prod.tfvars is committed config; tokens are individual GitHub secrets', () => {
  const prodTfvarsPath = path.join(tfDir, 'environments', 'prod', 'prod.tfvars');
  const gitignorePath = path.join(tfDir, '.gitignore');
  const yml = read(releaseWorkflowPath);
  const tfJob = yml.match(/\n {2}terraform-apply:\n([\s\S]*?)\n {2}[a-z][a-z-]*:\n/);

  it('commits prod.tfvars so fleet config is reviewable', () => {
    const tfvars = read(prodTfvarsPath);
    expect(tfvars.length).toBeGreaterThan(0);
    expect(tfvars).toMatch(/finalize_runner_max_size\s*=\s*128/);
    expect(tfvars).toMatch(/enable_finalize_runners\s*=\s*true/);
  });

  it('does not put instance ids, AMI ids, or fleet bucket names in committed prod.tfvars', () => {
    const tfvars = read(prodTfvarsPath);
    expect(tfvars).not.toMatch(/^\s*ci_ssm_deploy_instance_id\s*=/m);
    expect(tfvars).not.toMatch(/^\s*finalize_runner_ami_id\s*=/m);
    expect(tfvars).not.toMatch(/^\s*finalize_cache_bucket_name\s*=/m);
    expect(tfvars).not.toMatch(/^\s*finalize_worktree_bucket_name\s*=/m);
    expect(tfvars).not.toMatch(/\bi-[0-9a-f]{17}\b/);
    expect(tfvars).not.toMatch(/\bami-[0-9a-f]+\b/);
  });

  it('does not put tokens in committed prod.tfvars', () => {
    const tfvars = read(prodTfvarsPath);
    expect(tfvars).not.toMatch(/^\s*agent_hub_ahlog_token\s*=/m);
    expect(tfvars).not.toMatch(/^\s*github_token_for_git_clone\s*=/m);
    expect(tfvars).not.toMatch(/^\s*agent_hub_api_key\s*=/m);
    expect(tfvars).not.toMatch(/ahlog_[A-Za-z0-9_-]{8,}/);
    expect(tfvars).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(tfvars).not.toMatch(/AKIA[A-Z0-9]{16}/);
  });

  it('widens the Finalize Spot pool to 14 full-performance xlarge types', () => {
    const tfvars = read(prodTfvarsPath);
    for (const instanceType of WIDENED_FINALIZE_INSTANCE_TYPES) {
      expect(tfvars).toContain(`"${instanceType}"`);
    }
    expect(tfvars).not.toContain('"m7i-flex');
  });

  it('keeps account-specific identifiers out of committed prod.tfvars', () => {
    // These moved to the gitignored overlay / TF_VAR_* so the committed file
    // stays clean of the internal-only identifiers public-repo-hygiene scans.
    const tfvars = read(prodTfvarsPath);
    expect(tfvars, 'private deploy domain').not.toMatch(/surveytracker/i);
    expect(tfvars, 'real AWS account id').not.toMatch(
      /\b(?:120569607241|350025135582|797611956947)\b/,
    );
    expect(tfvars, 'real Route53 zone id').not.toMatch(/Z10407258WTZ0HQ4VDZP/);
    expect(tfvars, 'real KMS key id').not.toMatch(/8bd60c33-06da-4257-8a77-28a99fd67ee4/);
    // The account-scoped inputs must not carry live assignments here.
    expect(tfvars).not.toMatch(/^\s*public_fqdn\s*=/m);
    expect(tfvars).not.toMatch(/^\s*base_domain\s*=/m);
    expect(tfvars).not.toMatch(/^\s*root_delegation_role_arn\s*=/m);
    expect(tfvars).not.toMatch(/^\s*hub_data_kms_key_arn\s*=/m);
    expect(tfvars).not.toMatch(/^\s*artifacts_bucket_name\s*=/m);
  });

  it('gitignores the secrets overlay, live backend.hcl, and leftover non-prod files', () => {
    const gi = read(gitignorePath);
    expect(gi).toMatch(/environments\/\*\/secrets\.tfvars/);
    // The live backend.hcl carries the account-ID state bucket → gitignored,
    // template kept.
    expect(gi).toMatch(/^environments\/\*\/backend\.hcl$/m);
    expect(gi).toMatch(/!environments\/\*\/backend\.hcl\.example/);
    // prod.tfvars stays committed (not caught by a broad tfvars glob).
    expect(gi).not.toMatch(/environments\/\*\/\*\.tfvars/);
  });

  it('injects env identifiers from GitHub Variables as TF_VAR_*, failing fast when required ones are unset', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    expect(tfJob![1]).toContain('vars.PUBLIC_FQDN');
    expect(tfJob![1]).toContain('vars.BASE_DOMAIN');
    expect(tfJob![1]).toContain('vars.HUB_DATA_KMS_KEY_ARN');
    expect(tfJob![1]).toContain('vars.ARTIFACTS_BUCKET_NAME');
    expect(tfJob![1]).toContain('TF_VAR_public_fqdn');
    expect(tfJob![1]).toContain('TF_VAR_hub_data_kms_key_arn');
    // Required identifiers fail-fast before plan rather than defaulting.
    expect(tfJob![1]).toContain('require_tf_var');
  });

  it('does not materialize prod.tfvars from a PROD_TFVARS blob', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    expect(tfJob![1]).not.toMatch(/secrets\.PROD_TFVARS/);
    expect(tfJob![1]).toContain('Assert committed prod.tfvars is present');
    expect(tfJob![1]).toContain('-var-file=environments/prod/prod.tfvars');
  });

  it('sources only tokens (credentials) from GitHub Secrets', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    expect(tfJob![1]).toContain('secrets.AGENT_HUB_AHLOG_TOKEN');
    expect(tfJob![1]).toContain('secrets.AGENT_HUB_API_KEY');
    expect(tfJob![1]).toContain('secrets.TF_GITHUB_TOKEN_FOR_GIT_CLONE');
    // Non-secret deployment identifiers must NOT come from Secrets — Secrets
    // are reserved for tokens.
    expect(tfJob![1]).not.toContain('secrets.CI_SSM_DEPLOY_INSTANCE_ID');
    expect(tfJob![1]).not.toContain('secrets.FINALIZE_RUNNER_AMI_ID');
    expect(tfJob![1]).not.toContain('secrets.FINALIZE_CACHE_BUCKET_NAME');
    expect(tfJob![1]).not.toContain('secrets.FINALIZE_WORKTREE_BUCKET_NAME');
    // Empty secrets must not override Terraform defaults with "".
    expect(tfJob![1]).toMatch(/if \[ -z "\$value" \]; then/);
  });

  it('sources deployment identifiers from GitHub Variables, not Secrets', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    expect(tfJob![1]).toContain('vars.CI_SSM_DEPLOY_INSTANCE_ID');
    expect(tfJob![1]).toContain('vars.FINALIZE_RUNNER_AMI_ID');
    expect(tfJob![1]).toContain('vars.FINALIZE_CACHE_BUCKET_NAME');
    expect(tfJob![1]).toContain('vars.FINALIZE_WORKTREE_BUCKET_NAME');
    expect(tfJob![1]).toContain('TF_VAR_ci_ssm_deploy_instance_id');
    expect(tfJob![1]).toContain('TF_VAR_finalize_cache_bucket_name');
    expect(tfJob![1]).toContain('TF_VAR_finalize_worktree_bucket_name');
    expect(tfJob![1]).toContain('TF_VAR_finalize_runner_ami_id');
  });
});
