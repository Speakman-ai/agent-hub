import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The on-demand deploy pool only works if three separately written names agree:
 * the ECS service the module creates, the service the Hub scales (env), and the
 * service the Hub's IAM policy lets it scale. Pin them, plus the two properties
 * that make the pool worth having: 100% on-demand capacity and agents that claim
 * only the `ondemand` class.
 */
const TF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'terraform');
const read = (rel: string): string => readFileSync(join(TF_DIR, rel), 'utf8');

const moduleMain = read('modules/finalize-runners/main.tf');
const hubEnv = read('finalize-hub.tf');
const rootFleet = read('finalize-runners.tf');

function block(src: string, header: string): string {
  const start = src.indexOf(header);
  expect(start, `missing ${header}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${header}`);
}

describe('on-demand deploy pool Terraform', () => {
  it('names the same ECS service in the module, the Hub env, and the scale IAM policy', () => {
    const svc = block(moduleMain, 'resource "aws_ecs_service" "agent_ondemand"');
    expect(svc).toContain('name            = "${local.name}-agent-ondemand"');
    expect(moduleMain).toContain('name = "${var.project_name}-finalize-runner"');
    const fullName = '${var.project_name}-finalize-runner-agent-ondemand';
    expect(hubEnv).toContain(`FINALIZE_FLEET_ONDEMAND_ECS_SERVICE=${fullName}`);
    const iam = block(rootFleet, 'resource "aws_iam_role_policy" "hub_fleet_scale"');
    expect(iam).toContain(`service/\${var.project_name}-finalize-runner/${fullName}`);
  });

  it('runs the pool 100% on-demand with no Spot allocation', () => {
    const asg = block(moduleMain, 'resource "aws_autoscaling_group" "ondemand"');
    expect(asg).toMatch(/on_demand_percentage_above_base_capacity\s*=\s*100/);
    expect(asg).toMatch(/on_demand_base_capacity\s*=\s*var\.ondemand_max_size/);
    expect(asg).not.toContain('spot_allocation_strategy');
    expect(asg).not.toMatch(/capacity_rebalance\s*=\s*true/);
  });

  it('starts its agents in the ondemand runner class', () => {
    const td = block(moduleMain, 'resource "aws_ecs_task_definition" "agent_ondemand"');
    expect(td).toMatch(/name = "FINALIZE_RUNNER_CLASS", value = "ondemand"/);
    const svc = block(moduleMain, 'resource "aws_ecs_service" "agent_ondemand"');
    expect(svc).toContain('capacity_provider = aws_ecs_capacity_provider.ondemand[0].name');
  });

  it('creates the on-demand service only after its provider is associated with the cluster', () => {
    const svc = block(moduleMain, 'resource "aws_ecs_service" "agent_ondemand"');
    expect(svc).toMatch(/depends_on\s*=\s*\[aws_ecs_cluster_capacity_providers\.fleet\]/);
  });

  it('counts the deploy pool against the On-Demand vCPU quota even on a Spot fleet', () => {
    expect(rootFleet).toMatch(
      /var\.finalize_deploy_ondemand_pool \? var\.finalize_deploy_ondemand_max_size : 0/,
    );
    const guard = block(rootFleet, 'resource "terraform_data" "finalize_quota_guard"');
    expect(guard).toContain('local.finalize_ondemand_agents_max > 0');
  });
});
