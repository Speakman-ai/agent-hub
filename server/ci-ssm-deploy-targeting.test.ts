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
 * the Terraform inputs that scope the CI role's SSM grant. Both live in private stores (repo Variables, the
 * PROD_TFVARS secret), so nothing in-tree could diff them. When the sandbox was
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

  it('injects both repo Variables into the expected target list', () => {
    expect(tfJob, 'terraform-apply job must exist').toBeTruthy();
    const line = tfJob![1].match(/^\s*TF_VAR_ci_ssm_expected_deploy_instance_ids:\s*(.+)$/m);
    expect(line, 'Terraform must receive the full runtime target list').toBeTruthy();
    expect(line![1]).toContain('${{ vars.DOCKER_DEPLOY_INSTANCE_ID }}');
    expect(line![1]).toContain('${{ vars.DOCKER_DEPLOY_DEV_INSTANCE_ID }}');
    expect(line![1], 'Terraform list syntax must preserve both distinct values').toMatch(
      /^'\[".+", ".+"\]'$/,
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

  it('explains that the plan guard covers both runtime targets', () => {
    const branch = yml.match(
      /if grep -q 'AccessDeniedException' "\$SEND_ERR"; then([\s\S]*?)\n {12}fi/,
    );
    // With the guard wired, reaching this branch means one of the repo Variables
    // moved after the last release apply. Both must be named so a DEV failure is
    // not misdiagnosed as release-only drift.
    expect(branch![1]).toContain('TF_VAR_ci_ssm_expected_deploy_instance_ids');
    expect(branch![1]).toContain('DOCKER_DEPLOY_INSTANCE_ID');
    expect(branch![1]).toContain('DOCKER_DEPLOY_DEV_INSTANCE_ID');
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
