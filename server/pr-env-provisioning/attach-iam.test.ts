import { describe, it, expect } from 'vitest';
import { attachIam, POLICY_NAME, POLICY_DOCUMENT, type IamClient } from './attach-iam.js';
import type { DetectedHost } from './detect-host.js';

function detected(over: Partial<DetectedHost> = {}): DetectedHost {
  return {
    class: 'pm2-on-ec2',
    sitesAvailableDir: '/etc/nginx/sites-available',
    sitesEnabledDir: '/etc/nginx/sites-enabled',
    baseVhostPath: '/etc/nginx/sites-available/agent-hub-pr-env',
    certPathFor: (h) => `/etc/letsencrypt/live/${h}/fullchain.pem`,
    keyPathFor: (h) => `/etc/letsencrypt/live/${h}/privkey.pem`,
    instanceRoleArn: 'arn:aws:iam::123456789012:instance-profile/ryan-ec2-ssm',
    instanceRoleName: 'ryan-ec2-ssm',
    instanceId: 'i-0abc',
    notes: [],
    ...over,
  };
}

describe('attachIam — auto-attach (path A)', () => {
  it('calls PutRolePolicy with the inline route53 policy and finishes ok', async () => {
    const calls: Array<{ RoleName: string; PolicyName: string; PolicyDocument: string }> = [];
    const iam: IamClient = {
      async putRolePolicy(input) {
        calls.push(input);
      },
    };
    const result = await attachIam({
      detected: detected(),
      hasExplicitAwsCreds: true,
      iam,
    });
    expect(result.status).toBe('ok');
    expect(result.card).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.RoleName).toBe('ryan-ec2-ssm');
    expect(calls[0]?.PolicyName).toBe(POLICY_NAME);
    const policy = JSON.parse(calls[0]?.PolicyDocument ?? '{}');
    expect(policy.Statement[0].Action).toContain('route53:ChangeResourceRecordSets');
  });

  it('falls back to GetInstanceProfile when only an ARN is detected', async () => {
    const profileLookups: string[] = [];
    const iam: IamClient = {
      async putRolePolicy() {},
      async getInstanceProfile({ InstanceProfileName }) {
        profileLookups.push(InstanceProfileName);
        return { RoleName: 'real-role-from-lookup' };
      },
    };
    const result = await attachIam({
      detected: detected({ instanceRoleName: null }),
      hasExplicitAwsCreds: true,
      iam,
    });
    expect(profileLookups).toEqual(['ryan-ec2-ssm']);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/real-role-from-lookup/);
  });

  it('downgrades to copy-paste card when PutRolePolicy errors (AccessDenied)', async () => {
    const iam: IamClient = {
      async putRolePolicy() {
        const err = new Error('User: arn:... is not authorized to perform: iam:PutRolePolicy');
        (err as Error & { name: string }).name = 'AccessDenied';
        throw err;
      },
    };
    const result = await attachIam({
      detected: detected(),
      hasExplicitAwsCreds: true,
      iam,
    });
    expect(result.status).toBe('ok');
    expect(result.card?.check).toBe('route53');
    expect(result.card?.headline).toMatch(/ryan-ec2-ssm/);
    // CLI payload mentions the policy name and the role.
    const cliAction = result.card?.actions.find((a) => a.label === 'Copy CLI');
    expect(cliAction?.payload).toMatch(/--role-name ryan-ec2-ssm/);
    expect(cliAction?.payload).toMatch(/--policy-name agent-hub-pr-env/);
  });
});

describe('attachIam — explicit creds + no instance role (containerized)', () => {
  it('returns ok with no card when explicit keys are set and no instance role exists', async () => {
    const calls: Array<{ RoleName: string }> = [];
    const iam: IamClient = {
      async putRolePolicy(input) {
        calls.push(input);
      },
    };
    const result = await attachIam({
      detected: detected({ instanceRoleArn: null, instanceRoleName: null }),
      hasExplicitAwsCreds: true,
      iam,
    });
    expect(result.status).toBe('ok');
    expect(result.card).toBeUndefined();
    expect(result.message).toMatch(/explicit AWS keys/);
    // No SDK call — explicit keys are used at runtime, nothing to attach to.
    expect(calls).toHaveLength(0);
  });
});

describe('attachIam — copy-paste fallback (path B)', () => {
  it('emits a generic copy-paste card when no creds and no instance role', async () => {
    const result = await attachIam({
      detected: detected({ instanceRoleArn: null, instanceRoleName: null }),
      hasExplicitAwsCreds: false,
      iam: null,
    });
    expect(result.status).toBe('ok');
    expect(result.card?.severity).toBe('amber');
    expect(result.card?.headline).toMatch(/EC2 instance role/);
    const cli = result.card?.actions.find((a) => a.label === 'Copy CLI');
    expect(cli?.payload).toMatch(/<your-ec2-role-name>/);
  });

  it('emits a role-targeted copy-paste card when role is detected but no creds', async () => {
    const result = await attachIam({
      detected: detected(),
      hasExplicitAwsCreds: false,
      iam: null,
    });
    expect(result.status).toBe('ok');
    expect(result.card?.headline).toMatch(/ryan-ec2-ssm/);
    expect(result.card?.actions.some((a) => a.label.includes('IAM console'))).toBe(true);
  });

  it('embeds the documented Route 53 actions in the policy doc', () => {
    const doc = JSON.parse(POLICY_DOCUMENT);
    expect(doc.Statement[0].Action).toEqual([
      'route53:GetHostedZone',
      'route53:ListHostedZones',
      'route53:ChangeResourceRecordSets',
      'route53:GetChange',
    ]);
    expect(doc.Statement[0].Sid).toBe('Route53PreviewDns');
  });
});
