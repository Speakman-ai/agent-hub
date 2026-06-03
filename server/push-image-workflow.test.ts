import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '..');
const ecrPublishWorkflowPath = path.join(
  repoRoot,
  '.github',
  'workflows',
  'ecr-publish-rollout-docker-dev.yml',
);
const pushImageWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'push-image.yml');

/**
 * Guards CI contract: ECR push + dev-sandbox SSM rollout live in the reusable
 * workflow; the thin `push-image.yml` entrypoint stays manual-only.
 */
describe('ECR publish + push-image deploy contract', () => {
  function parseSandboxInstanceFromEcrWorkflow(workflowYaml: string): string {
    const m = workflowYaml.match(/^\s*DEV_SANDBOX_INSTANCE_ID:\s*(i-[a-f0-9]+)\s*$/m);
    expect(m?.[1], 'DEV_SANDBOX_INSTANCE_ID in ecr-publish-rollout-docker-dev.yml').toBeTruthy();
    return m![1];
  }

  function parseTfvarsSandboxInstance(tfvarsBody: string): string {
    const m = tfvarsBody.match(/^\s*ci_ssm_deploy_instance_id\s*=\s*"([^"]+)"\s*$/m);
    expect(m?.[1], 'ci_ssm_deploy_instance_id in ryan.tfvars').toBeTruthy();
    return m![1];
  }

  it('defines deploy-dev-sandbox with SSM restart and a DEV_SANDBOX_INSTANCE_ID target', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toContain('deploy-dev-sandbox:');
    expect(yml).toContain('systemctl restart agenthub-server');
    expect(yml).toContain('DEV_SANDBOX_INSTANCE_ID');
    const id = parseSandboxInstanceFromEcrWorkflow(yml);
    expect(id).toMatch(/^i-[a-f0-9]{8,}$/);
  });

  it('keeps Terraform ryan.tfvars CI SSM instance in sync with the ECR rollout workflow', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const tfvars = readFileSync(
      path.join(repoRoot, 'ops', 'terraform', 'environments', 'ryan', 'ryan.tfvars'),
      'utf8',
    );
    const fromWorkflow = parseSandboxInstanceFromEcrWorkflow(yml);
    const fromTfvars = parseTfvarsSandboxInstance(tfvars);
    expect(fromTfvars).toBe(fromWorkflow);
  });

  // Regression guard for kanban 89903017. The previous deploy flow trusted
  // `systemctl restart agenthub-server` to do the right thing. When the
  // wrapper's pull silently failed, `systemctl is-active` still returned 0
  // because the container was running (on the stale cached image), and CI
  // reported success. The new flow exposes the just-pushed digest via
  // job outputs + EXPECTED_DIGEST and asserts the running container matches.
  it('exports the build digest from the push job for end-to-end verification', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    // The push job must assign an `id` to the build step and surface its
    // digest output, otherwise needs.push.outputs.digest is empty.
    expect(yml, 'build step needs `id: build` so its outputs are addressable').toMatch(
      /-\s+name: Build \+ push server image\s*\n\s+id: build/,
    );
    expect(yml, 'push job must export digest in `outputs:`').toMatch(
      /outputs:\s*\n\s*digest:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/,
    );
  });

  it('asserts the dev-sandbox container is running the just-pushed digest', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml, 'EXPECTED_DIGEST must be threaded from needs.push.outputs.digest').toMatch(
      /EXPECTED_DIGEST:\s*\$\{\{\s*needs\.push\.outputs\.digest\s*\}\}/,
    );
    // The SSM script must perform the equality check (anchor on the FATAL
    // line so a future refactor can't accidentally drop the assertion).
    expect(yml).toContain('LOCAL_REPO_DIGEST');
    expect(yml).toContain('host :main digest');
    expect(yml).toMatch(/!=\s+just-pushed digest/);
  });

  // Regression guard for the dev-sandbox manual-deploy switch. The thin
  // `push-image.yml` entrypoint must stay manual-only (no `push:` trigger).
  // Rollout itself is additionally gated by `inputs.rollout` on the reusable
  // workflow so callers (Release vs manual) can opt out without editing YAML.
  it('keeps push-image.yml manual-only and delegates ECR + rollout to the reusable workflow', () => {
    const yml = readFileSync(pushImageWorkflowPath, 'utf8');
    expect(yml, 'push-image must call the reusable ECR + rollout workflow').toMatch(
      /uses:\s*\.\/\.github\/workflows\/ecr-publish-rollout-docker-dev\.yml/,
    );
    expect(yml, 'push-image must not auto-run on pushes to main').not.toMatch(/^\s*push:\s*$/m);
  });

  it('gates deploy-dev-sandbox rollout behind inputs.rollout on the reusable workflow', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const jobMatch = yml.match(/^ {2}deploy-dev-sandbox:\s*\n([\s\S]*?)^ {4}steps:\s*$/m);
    expect(jobMatch, 'deploy-dev-sandbox job header must exist in ECR workflow').toBeTruthy();
    const jobHead = jobMatch![1];
    const ifMatch = jobHead.match(/^ {4}if:\s*(.+?)\s*$/m);
    expect(ifMatch, 'deploy-dev-sandbox must declare a job-level `if:` gate').toBeTruthy();
    expect(ifMatch![1]).toContain('inputs.rollout');
  });

  // Regression guard for kanban f1015656 (false-positive ECR deploy failures).
  // The original verification did `sleep 8` + single-shot inspect, which raced
  // the wrapper's async `docker pull` + `docker run` and reported FATAL even
  // though the image was being deployed successfully. The fix is a poll loop
  // that waits for the host digest and container image-id to converge on the
  // just-pushed image before asserting. Make sure no one accidentally
  // reverts to the single-shot inspect.
  it('polls instead of single-shot sleeping before the digest assertion', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    // Poll loop sentinels — these tokens are unique to the new wait_for_deploy
    // implementation and let a future diff make the regression obvious.
    expect(yml, 'must declare a POLL_TIMEOUT for the wait loop').toMatch(/POLL_TIMEOUT=\d+/);
    expect(yml, 'must declare a POLL_DEADLINE driven by date +%s').toMatch(/POLL_DEADLINE=/);
    expect(yml, 'must emit wait_for_deploy progress lines').toContain('wait_for_deploy');
    // The old single-shot `sleep 8` must be gone. Any future fixed-duration
    // sleep before the inspect block is the regression we are guarding against.
    expect(yml, 'fixed `sleep 8` before inspect must not return').not.toMatch(/^\s*sleep 8\s*$/m);
  });
});
