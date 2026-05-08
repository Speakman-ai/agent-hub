import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards CI contract: ECR push workflow must include SSM deploy to the dev sandbox
 * so :main reaches the Docker host without a manual restart.
 */
describe('push-image.yml deploy contract', () => {
  it('defines deploy-dev-sandbox with SSM restart targeting the documented instance', () => {
    const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'push-image.yml');
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml).toContain('deploy-dev-sandbox:');
    expect(yml).toContain('systemctl restart agenthub-server');
    expect(yml).toContain('DEV_SANDBOX_INSTANCE_ID');
    expect(yml).toContain('i-08b54d5b72e54baed');
  });
});
