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

  // Regression guard for kanban 89903017. The previous deploy flow trusted
  // `systemctl restart agenthub-server` to do the right thing. When the
  // wrapper's pull silently failed, `systemctl is-active` still returned 0
  // because the container was running (on the stale cached image), and CI
  // reported success. The new flow exposes the just-pushed digest via
  // job outputs + EXPECTED_DIGEST and asserts the running container matches.
  it('exports the build digest from the push job for end-to-end verification', () => {
    const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'push-image.yml');
    const yml = readFileSync(workflowPath, 'utf8');
    // The push job must assign an `id` to the build step and surface its
    // digest output, otherwise needs.push.outputs.digest is empty.
    expect(yml, 'build step needs `id: build` so its outputs are addressable').toMatch(
      /-\s+name: Build \+ push image\s+id: build/,
    );
    expect(yml, 'push job must export digest in `outputs:`').toMatch(
      /outputs:\s*\n\s*digest:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/,
    );
  });

  it('asserts the dev-sandbox container is running the just-pushed digest', () => {
    const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'push-image.yml');
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml, 'EXPECTED_DIGEST must be threaded from needs.push.outputs.digest').toMatch(
      /EXPECTED_DIGEST:\s*\$\{\{\s*needs\.push\.outputs\.digest\s*\}\}/,
    );
    // The SSM script must perform the equality check (anchor on the FATAL
    // line so a future refactor can't accidentally drop the assertion).
    expect(yml).toContain('LOCAL_REPO_DIGEST');
    expect(yml).toContain('host :main digest');
    expect(yml).toMatch(/!=\s+just-pushed digest/);
  });

  // Regression guard for kanban 14af4660-b8d1-4faa-b97b-4d3c4cab5303.
  // The original verification (`sleep 8` + single `docker image inspect`)
  // raced the wrapper's async docker pull and produced false-negative
  // "host did not pull the new image" failures on every push to main after
  // PR #888 — even though the host DID land the new digest and the running
  // container DID swap to it. Fix is a bounded poll loop that waits for the
  // host's :main digest AND the running container's image-id to converge
  // with EXPECTED_DIGEST before asserting. This test pins that contract so
  // we never silently regress back to a static sleep.
  it('polls for host digest + container image-id convergence (no static sleep race)', () => {
    const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'push-image.yml');
    const yml = readFileSync(workflowPath, 'utf8');
    // No bare `sleep 8` (or any small static sleep) between systemctl
    // restart and the digest inspect — the convergence must be observed
    // via the loop, not by guessing how long the host pull will take.
    expect(yml, 'must not gate verification on a single static sleep').not.toMatch(
      /Give the wrapper a moment to pull \+ start before inspecting\.\s*\n\s*sleep \d+/,
    );
    // Bounded deadline-driven poll loop with a `date +%s` floor.
    expect(yml, 'must compute a deadline timestamp for the poll loop').toMatch(
      /DEADLINE=\\?\$\(\(\s*\\?\$\(date \+%s\)\s*\+\s*\d+\s*\)\)/,
    );
    expect(yml, 'must loop until the deadline is reached').toMatch(
      /while\s*\[\s*"\\?\$\(date \+%s\)"\s*-lt\s*"\\?\$DEADLINE"\s*\]/,
    );
    // The loop body must compare EXPECTED_DIGEST against the host's :main
    // digest AND the running container's image-id BEFORE breaking, so the
    // post-loop assertion only fires once convergence fails the deadline.
    expect(
      yml,
      'loop must early-exit on full convergence (digest + container image-id match)',
    ).toMatch(
      /\[\s*"\\\$LOCAL_DIGEST"\s*=\s*"\\\$EXPECTED_DIGEST"\s*\][\s\S]*?\[\s*"\\\$CONTAINER_IMAGE_ID"\s*=\s*"\\\$LOCAL_IMAGE_ID"\s*\][\s\S]*?break/,
    );
  });
});
