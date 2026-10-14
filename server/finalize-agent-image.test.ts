import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Release always passes the runner-agent fleet image explicitly: the image it
 * pushed, or (push failed) the image deployed today. finalize-agent-image.sh
 * reads the deployed image from state and verifies the saved plan, so neither
 * a failed push nor a tfvars entry can drop the fleet back to the stale `:main`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'ops', 'terraform', 'scripts', 'finalize-agent-image.sh');
const RELEASE_IMAGE = 'public.ecr.aws/example/agent-hub-finalize-runner:v2.31.194';
const DEPLOYED_IMAGE = 'public.ecr.aws/example/agent-hub-finalize-runner:v2.31.193';
const STALE_IMAGE = 'public.ecr.aws/example/agent-hub-finalize-runner:main';
const SPOT = 'module.finalize_runners[0].aws_ecs_task_definition.agent';
const ONDEMAND = 'module.finalize_runners[0].aws_ecs_task_definition.agent_ondemand[0]';

function taskDef(address: string, image: string) {
  return {
    address,
    mode: 'managed',
    type: 'aws_ecs_task_definition',
    values: {
      container_definitions: JSON.stringify([{ name: 'runner-agent', image }]),
    },
  };
}

/** `terraform show -json` shape: plans use planned_values, state uses values. */
function jsonFile(root: 'planned_values' | 'values', resources: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tf-agent-image-'));
  const file = join(dir, `${root}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      format_version: '1.2',
      [root]: {
        root_module: {
          resources: [{ address: 'aws_instance.app', mode: 'managed', type: 'aws_instance' }],
          child_modules: [{ address: 'module.finalize_runners[0]', resources }],
        },
      },
    }),
  );
  return file;
}

function run(...args: string[]) {
  const res = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('finalize-agent-image.sh assert', () => {
  it('passes when both Spot and on-demand task definitions use the expected image', () => {
    const plan = jsonFile('planned_values', [
      taskDef(SPOT, RELEASE_IMAGE),
      taskDef(ONDEMAND, RELEASE_IMAGE),
    ]);
    const { status, stdout } = run('assert', plan, RELEASE_IMAGE);
    expect(status).toBe(0);
    expect(stdout).toContain(`ok: ${SPOT}`);
    expect(stdout).toContain(`ok: ${ONDEMAND}`);
  });

  it('fails when the plan keeps the stale :main image', () => {
    const plan = jsonFile('planned_values', [taskDef(SPOT, STALE_IMAGE)]);
    const { status, stderr } = run('assert', plan, RELEASE_IMAGE);
    expect(status).toBe(1);
    expect(stderr).toContain(`plans image ${STALE_IMAGE}`);
  });

  it('fails when only the on-demand task definition is stale', () => {
    const plan = jsonFile('planned_values', [
      taskDef(SPOT, RELEASE_IMAGE),
      taskDef(ONDEMAND, STALE_IMAGE),
    ]);
    const { status, stderr } = run('assert', plan, RELEASE_IMAGE);
    expect(status).toBe(1);
    expect(stderr).toContain(ONDEMAND);
  });

  it('fails when the plan has no runner-agent task definition to verify', () => {
    const { status, stderr } = run('assert', jsonFile('planned_values', []), RELEASE_IMAGE);
    expect(status).toBe(1);
    expect(stderr).toContain('no runner-agent task definition');
  });
});

describe('finalize-agent-image.sh deployed', () => {
  it('prints the image the fleet runs today', () => {
    const state = jsonFile('values', [
      taskDef(SPOT, DEPLOYED_IMAGE),
      taskDef(ONDEMAND, DEPLOYED_IMAGE),
    ]);
    const { status, stdout } = run('deployed', state);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(DEPLOYED_IMAGE);
  });

  it('fails rather than guess when the task definitions disagree', () => {
    const state = jsonFile('values', [
      taskDef(SPOT, DEPLOYED_IMAGE),
      taskDef(ONDEMAND, STALE_IMAGE),
    ]);
    const { status, stdout } = run('deployed', state);
    expect(status).toBe(1);
    expect(stdout).toBe('');
  });

  it('fails when the fleet is not in state', () => {
    const { status, stdout } = run('deployed', jsonFile('values', []));
    expect(status).toBe(1);
    expect(stdout).toBe('');
  });
});

describe('finalize-agent-image.sh usage', () => {
  it('rejects missing arguments, unknown modes, and non-terraform JSON', () => {
    expect(run().status).toBe(2);
    expect(run('bogus', jsonFile('values', [])).status).toBe(2);
    expect(run('assert', jsonFile('planned_values', [taskDef(SPOT, RELEASE_IMAGE)])).status).toBe(
      2,
    );
    const dir = mkdtempSync(join(tmpdir(), 'tf-agent-image-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{}');
    expect(run('assert', bad, RELEASE_IMAGE).status).toBe(2);
    expect(run('deployed', bad).status).toBe(2);
  });
});
