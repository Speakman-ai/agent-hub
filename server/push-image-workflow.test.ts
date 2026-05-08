import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards CI contract: ECR push workflow must include SSM deploy to the dev sandbox
 * so :main reaches the Docker host without a manual restart.
 */
describe('push-image.yml deploy contract', () => {
  function parseSandboxInstanceFromWorkflow(workflowYaml: string): string {
    const m = workflowYaml.match(/^\s*DEV_SANDBOX_INSTANCE_ID:\s*(i-[a-f0-9]+)\s*$/m);
    expect(m?.[1], 'DEV_SANDBOX_INSTANCE_ID in push-image.yml').toBeTruthy();
    return m![1];
  }

  function parseTfvarsSandboxInstance(tfvarsBody: string): string {
    const m = tfvarsBody.match(/^\s*ci_ssm_deploy_instance_id\s*=\s*"([^"]+)"\s*$/m);
    expect(m?.[1], 'ci_ssm_deploy_instance_id in ryan.tfvars').toBeTruthy();
    return m![1];
  }

  it('defines deploy-dev-sandbox with SSM restart and a DEV_SANDBOX_INSTANCE_ID target', () => {
    const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'push-image.yml');
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml).toContain('deploy-dev-sandbox:');
    expect(yml).toContain('systemctl restart agenthub-server');
    expect(yml).toContain('DEV_SANDBOX_INSTANCE_ID');
    const id = parseSandboxInstanceFromWorkflow(yml);
    expect(id).toMatch(/^i-[a-f0-9]{8,}$/);
  });

  it('keeps Terraform ryan.tfvars CI SSM instance in sync with push-image.yml', () => {
    const repoRoot = path.join(__dirname, '..');
    const yml = readFileSync(path.join(repoRoot, '.github', 'workflows', 'push-image.yml'), 'utf8');
    const tfvars = readFileSync(
      path.join(repoRoot, 'ops', 'terraform', 'environments', 'ryan', 'ryan.tfvars'),
      'utf8',
    );
    const fromWorkflow = parseSandboxInstanceFromWorkflow(yml);
    const fromTfvars = parseTfvarsSandboxInstance(tfvars);
    expect(fromTfvars).toBe(fromWorkflow);
  });
});
