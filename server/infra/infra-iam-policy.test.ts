/**
 * Proves the IAM policy published under `docs/guides/aws-monitoring-iam/`
 * actually covers what the collectors call, and nothing more.
 *
 * An operator grants what we publish once and then never looks again, so a
 * policy that drifts from the code does not fail loudly — it fails as an
 * AccessDenied inside a background poller nobody is watching, weeks later. This
 * test is the thing that has to notice instead.
 *
 * It checks in both directions:
 *   - every action in `infra-iam-actions.ts` is granted by the published JSON;
 *   - the published JSON grants nothing beyond it, and in particular none of
 *     the data-plane reads that make `ReadOnlyAccess` the wrong answer;
 * and that the Terraform and CloudFormation renderings say the same thing as
 * the JSON, since three copies of a policy are three chances to diverge.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';
import {
  INFRA_IAM_ACTIONS,
  INFRA_IAM_CAPABILITIES,
  INFRA_IAM_FORBIDDEN_ACTIONS,
  INFRA_IAM_POLICY_VERSION,
  INFRA_IAM_STATEMENT_SIDS,
  allInfraIamActions,
  iamActionMatches,
  infraIamActionsFor,
} from './infra-iam-actions.js';

const DOC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'guides',
  'aws-monitoring-iam',
);
const POLICY_FILE = 'agent-hub-monitoring-policy.json';

interface PolicyStatement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}

function read(name: string): string {
  return readFileSync(join(DOC_DIR, name), 'utf-8');
}

const policy = JSON.parse(read(POLICY_FILE)) as {
  Version: string;
  Statement: PolicyStatement[];
};
const terraform = read('agent-hub-monitoring-role.tf');
const cloudformation = parseYaml(read('agent-hub-monitoring-role.yaml')) as Record<string, any>;
const readme = read('README.md');

function actionsOf(statement: PolicyStatement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

const grantedPatterns = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap(actionsOf);

function isGranted(action: string): boolean {
  return grantedPatterns.some((pattern) => iamActionMatches(pattern, action));
}

describe('iamActionMatches', () => {
  it('matches an exact action case-insensitively, the way IAM does', () => {
    expect(iamActionMatches('s3:GetObject', 's3:getobject')).toBe(true);
    expect(iamActionMatches('s3:GetObject', 's3:GetObjectVersion')).toBe(false);
  });

  it('expands wildcards, which is the whole point of the forbidden-action check', () => {
    expect(iamActionMatches('s3:Get*', 's3:GetObject')).toBe(true);
    expect(iamActionMatches('rds:Download*', 'rds:DownloadCompleteDBLogFile')).toBe(true);
    expect(iamActionMatches('*', 'dynamodb:Scan')).toBe(true);
    expect(iamActionMatches('cloudwatch:Get?', 'cloudwatch:GetX')).toBe(true);
  });

  it('does not let a service prefix leak across services', () => {
    expect(iamActionMatches('ec2:Describe*', 'ecs:DescribeServices')).toBe(false);
  });
});

describe(`docs/guides/aws-monitoring-iam/${POLICY_FILE}`, () => {
  it('is a well-formed IAM policy document', () => {
    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement.length).toBeGreaterThan(0);
    for (const statement of policy.Statement) {
      expect(statement.Effect).toBe('Allow');
      expect(statement.Resource).toBe('*');
      expect(actionsOf(statement).length).toBeGreaterThan(0);
    }
  });

  it('covers every action the collectors call', () => {
    const missing = allInfraIamActions().filter((action) => !isGranted(action));
    expect(missing).toEqual([]);
  });

  it('grants no data-plane read — the reason ReadOnlyAccess is the wrong answer', () => {
    const leaked = INFRA_IAM_FORBIDDEN_ACTIONS.filter((action) => isGranted(action));
    expect(leaked).toEqual([]);
  });

  it('grants nothing beyond the manifest', () => {
    // Exact set equality per statement, not glob coverage: a `ec2:Describe*`
    // that happened to satisfy the coverage check above would also hand over
    // several hundred actions no collector calls.
    const declared = new Set(allInfraIamActions());
    const extra = grantedPatterns.filter((action) => !declared.has(action));
    expect(extra).toEqual([]);
  });

  it('uses no wildcard action', () => {
    expect(grantedPatterns.filter((a) => a.includes('*'))).toEqual([]);
  });

  it('groups statements by capability with the declared Sids', () => {
    const sids = policy.Statement.map((s) => s.Sid);
    expect(sids).toEqual(INFRA_IAM_CAPABILITIES.map((c) => INFRA_IAM_STATEMENT_SIDS[c]));

    for (const capability of INFRA_IAM_CAPABILITIES) {
      const sid = INFRA_IAM_STATEMENT_SIDS[capability];
      const statement = policy.Statement.find((s) => s.Sid === sid);
      expect(statement, `no statement with Sid ${sid}`).toBeDefined();
      expect(actionsOf(statement as PolicyStatement)).toEqual(
        infraIamActionsFor([capability]).map((a) => a.action),
      );
    }
  });

  it('keeps every opt-in capability in a statement of its own, so it can be deleted', () => {
    const optIn = INFRA_IAM_ACTIONS.filter((a) => a.optIn);
    for (const action of optIn) {
      const sid = INFRA_IAM_STATEMENT_SIDS[action.capability];
      const statement = policy.Statement.find((s) => s.Sid === sid) as PolicyStatement;
      // Nothing required is stranded in a statement an operator may drop.
      const stranded = actionsOf(statement).filter(
        (a) => !INFRA_IAM_ACTIONS.find((m) => m.action === a)?.optIn,
      );
      expect(stranded).toEqual([]);
    }
  });
});

describe('docs/guides/aws-monitoring-iam/agent-hub-monitoring-role.tf', () => {
  it('reads the published JSON rather than restating it', () => {
    expect(terraform).toContain(`file("\${path.module}/${POLICY_FILE}")`);
  });

  it('requires the external ID with StringEquals, never the ...IfExists form', () => {
    // `StringEqualsIfExists` evaluates true when the key is absent, which would
    // admit an AssumeRole carrying no external ID at all.
    expect(terraform).toContain('"sts:ExternalId"');
    expect(terraform).toMatch(/test\s*=\s*"StringEquals"/);
    // Scoped to the operator values, so the comment explaining the trap does
    // not itself trip the check.
    expect(terraform.match(/test\s*=\s*"(\w+)"/g)).toEqual([
      'test     = "StringEquals"',
      'test     = "ArnEquals"',
    ]);
  });

  it('pins the trust to one collector role, not to a whole account', () => {
    expect(terraform).toContain('aws:PrincipalArn');
    expect(terraform).toMatch(/test\s*=\s*"ArnEquals"/);
  });
});

describe('docs/guides/aws-monitoring-iam/agent-hub-monitoring-role.yaml', () => {
  const managedPolicy = cloudformation.Resources.AgentHubMonitoringPolicy;
  const role = cloudformation.Resources.AgentHubMonitoringRole;

  it('inlines exactly the published policy document', () => {
    // CloudFormation has no `file()`, so this is the one genuine duplicate.
    expect(managedPolicy.Properties.PolicyDocument).toEqual(policy);
  });

  it('requires the external ID with StringEquals, never the ...IfExists form', () => {
    const condition = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
    expect(Object.keys(condition).sort()).toEqual(['ArnEquals', 'StringEquals']);
    expect(condition.StringEquals['sts:ExternalId']).toEqual({ Ref: 'AgentHubExternalId' });
    expect(condition.ArnEquals['aws:PrincipalArn']).toEqual({ Ref: 'AgentHubCollectorRoleArn' });
  });

  it('constrains the external ID parameter to the AWS ExternalId grammar', () => {
    const param = cloudformation.Parameters.AgentHubExternalId;
    expect(param.MinLength).toBe(2);
    expect(param.MaxLength).toBe(1224);
    expect('agent-hub-8f14e45f-ceea-467a-9c1e-6b1e5f8a0d2c').toMatch(
      new RegExp(param.AllowedPattern as string),
    );
  });
});

describe('docs/guides/aws-monitoring-iam/README.md', () => {
  it('publishes the current policy version', () => {
    expect(readme).toContain(`Policy version: ${INFRA_IAM_POLICY_VERSION}`);
  });

  it('documents both ViewOnlyAccess gaps', () => {
    expect(readme).toContain('cloudwatch:Get*');
    expect(readme).toContain('cloudwatch:DescribeAlarms');
    for (const prefix of ['ce:', 'health:', 'compute-optimizer:', 'servicequotas:']) {
      expect(readme, `README does not mention the ${prefix} gap`).toContain(prefix);
    }
  });

  it('documents the data-plane reads that rule out ReadOnlyAccess', () => {
    for (const action of ['s3:Get*', 'dynamodb:Scan', 'logs:FilterLogEvents', 'rds:Download*']) {
      expect(readme, `README does not name ${action}`).toContain(action);
    }
  });

  it('documents the assume-without-external-ID onboarding test', () => {
    expect(readme).toContain('Must FAIL with AccessDenied');
    expect(readme).toContain('--external-id');
  });

  it('names every statement Sid so an operator can map a block to a capability', () => {
    for (const sid of Object.values(INFRA_IAM_STATEMENT_SIDS)) {
      expect(readme, `README does not document Sid ${sid}`).toContain(sid);
    }
  });
});
