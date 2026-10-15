import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * PR environments are proxied from the Hub to a gateway port on the runner's
 * private IP, allowed by an ingress rule on the module's runner SG. That rule
 * only takes effect if runner instances are actually in that SG: a launch
 * template with no security group puts them in the VPC default SG, where the
 * Hub's packets are dropped and every environment shows "not responding".
 */
const TF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'terraform');
const moduleMain = readFileSync(join(TF_DIR, 'modules/finalize-runners/main.tf'), 'utf8');

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

describe('finalize runner security group', () => {
  it('attaches the runner SG to the launch template', () => {
    const lt = block(moduleMain, 'resource "aws_launch_template" "runner"');
    expect(lt).toMatch(/vpc_security_group_ids\s*=\s*\[aws_security_group\.runner\.id\]/);
  });

  it('puts the PR environment ingress rule on that same SG', () => {
    const rule = block(
      moduleMain,
      'resource "aws_vpc_security_group_ingress_rule" "runner_environment_from_hub"',
    );
    expect(rule).toMatch(/security_group_id\s*=\s*aws_security_group\.runner\.id/);
  });

  it('launches every runner ASG from that launch template', () => {
    for (const name of ['fleet', 'ondemand']) {
      const asg = block(moduleMain, `resource "aws_autoscaling_group" "${name}"`);
      expect(asg).toContain('launch_template_id = aws_launch_template.runner.id');
    }
  });
});
