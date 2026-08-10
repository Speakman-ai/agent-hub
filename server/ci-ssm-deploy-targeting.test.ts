import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the release rollout dying with
 *   AccessDeniedException ... not authorized to perform: ssm:SendCommand
 *   on resource: arn:aws:ec2:<region>:<acct>:instance/i-<new sandbox>
 *
 * The deploy target is configured twice — the DOCKER_DEPLOY_INSTANCE_ID repo
 * Variable read by the rollout workflow, and the Terraform inputs that scope the
 * CI role's SSM grant. Both live in private stores (repo Variables, the
 * PROD_TFVARS secret), so nothing in-tree could diff them. When the sandbox was
 * rebuilt, the Variable moved to the new instance and the IAM policy kept naming
 * the old one, so every release failed at the SSM step.
 *
 * Two invariants close that: Terraform resolves targets by tag at plan time
 * (a rebuilt box under the same tag re-grants on the next apply) and refuses to
 * ship a grant that resolved zero instances, and the workflow translates the
 * IAM denial into the remediation instead of a bare exit 254.
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
    const precondition = tf.match(/precondition \{([\s\S]*?)\n {4}\}/);
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
