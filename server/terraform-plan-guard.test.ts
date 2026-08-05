import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The release pipeline applies ops/terraform on every release, so nothing
 * supervises the plan before it lands. assert-no-protected-replacements.sh is
 * the gate that keeps an unattended apply from destroying or replacing the live
 * Hub instance / data volume. These tests pin its verdicts, because a regression
 * here is silent until the one release that wipes prod.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(
  REPO_ROOT,
  'ops',
  'terraform',
  'scripts',
  'assert-no-protected-replacements.sh',
);

interface PlanChange {
  address: string;
  actions: string[];
}

function planJson(changes: PlanChange[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tf-plan-guard-'));
  const file = join(dir, 'plan.json');
  writeFileSync(
    file,
    JSON.stringify({
      format_version: '1.2',
      resource_changes: changes.map(({ address, actions }) => ({
        address,
        type: address.split('.')[0],
        change: { actions },
      })),
    }),
  );
  return file;
}

function runGuard(planPath: string, extraProtected: string[] = []) {
  const res = spawnSync('bash', [SCRIPT, planPath, ...extraProtected], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('assert-no-protected-replacements.sh', () => {
  it('passes a plan with no changes at all', () => {
    const { status, stdout } = runGuard(planJson([]));
    expect(status).toBe(0);
    expect(stdout).toContain('no protected Hub resource');
  });

  it('passes when protected resources are only updated in place', () => {
    // This is the common prod shape: user_data / volume-attachment attribute
    // drift applied in place. It must not trip the guard.
    const { status } = runGuard(
      planJson([
        { address: 'aws_instance.app', actions: ['update'] },
        { address: 'aws_volume_attachment.hub_data[0]', actions: ['update'] },
      ]),
    );
    expect(status).toBe(0);
  });

  it('passes but reports replacements of unprotected resources', () => {
    const { status, stdout } = runGuard(
      planJson([
        {
          address: 'module.finalize_runners[0].aws_ecs_task_definition.agent',
          actions: ['delete', 'create'],
        },
      ]),
    );
    expect(status).toBe(0);
    expect(stdout).toContain('1 unprotected resource');
    expect(stdout).toContain('aws_ecs_task_definition.agent');
  });

  it('fails when the Hub instance would be replaced', () => {
    const { status, stderr } = runGuard(
      planJson([{ address: 'aws_instance.app', actions: ['delete', 'create'] }]),
    );
    expect(status).toBe(1);
    expect(stderr).toContain('aws_instance.app');
    expect(stderr).toContain('Refusing to apply');
  });

  it('fails on create_before_destroy ordering too', () => {
    // A replacement can be planned in either order; both contain "delete".
    const { status, stderr } = runGuard(
      planJson([{ address: 'aws_instance.app', actions: ['create', 'delete'] }]),
    );
    expect(status).toBe(1);
    expect(stderr).toContain('aws_instance.app');
  });

  it.each(['aws_ebs_volume.hub_data[0]', 'aws_volume_attachment.hub_data[0]'])(
    'fails when %s would be destroyed',
    (address) => {
      const { status, stderr } = runGuard(planJson([{ address, actions: ['delete'] }]));
      expect(status).toBe(1);
      expect(stderr).toContain(address);
    },
  );

  it('honours additional protected addresses passed as arguments', () => {
    const plan = planJson([{ address: 'aws_lb.agenthub[0]', actions: ['delete', 'create'] }]);
    expect(runGuard(plan).status).toBe(0);
    expect(runGuard(plan, ['aws_lb.agenthub']).status).toBe(1);
  });

  it('exits 2 on a missing plan file rather than silently passing', () => {
    const { status } = runGuard(join(tmpdir(), 'definitely-not-a-plan.json'));
    expect(status).toBe(2);
  });
});
