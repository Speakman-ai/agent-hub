/**
 * HTTP contract for the infrastructure setup wizard draft endpoint.
 *
 * The load-bearing assertion is the negative one: this endpoint must reach AWS
 * zero times (decision INFRA-WIZARD). Its most important caller is the empty
 * state of a project that has no usable credentials at all, so any dependency
 * on a credential provider resolving would make it fail exactly when it is most
 * needed. `../infra/aws-clients.js` is mocked here not to stub a result but to
 * prove nothing in it is ever called.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';
import { getRequest } from '../test/helpers.js';
import * as awsClients from '../infra/aws-clients.js';
import { replaceInfraScopes } from '../infra/infra-scope-store.js';
import { createInfraAlertRule } from '../infra/alert-store.js';

// Every export is a spy. Nothing here should fire on this route — if the draft
// ever grows a probe, these assertions fail rather than the endpoint silently
// getting slow and billable.
vi.mock('../infra/aws-clients.js', () => ({
  probeProjectMonitoringAccess: vi.fn(),
  requireProjectMonitoringProfile: vi.fn(),
  getProjectCloudWatchClient: vi.fn(),
  getProjectEc2Client: vi.fn(),
  getProjectEcsClient: vi.fn(),
  getProjectElbV2Client: vi.fn(),
  getProjectRdsClient: vi.fn(),
  getProjectLambdaClient: vi.fn(),
  getProjectS3Client: vi.fn(),
  getProjectServiceQuotasClient: vi.fn(),
  getProjectCostExplorerClient: vi.fn(),
  destroyProjectAwsClients: vi.fn(),
  invalidateProjectAwsAccess: vi.fn(),
  COST_EXPLORER_REGION: 'us-east-1',
}));

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function freshProject(): Promise<string> {
  const id = `infra-wiz-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

const STATIC_PROFILE = {
  type: 'static',
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  aws_session_token: 'FwoGZXIvYXdzEExampleSessionTokenValue',
  region: 'us-east-2',
};

const SSO_PROFILE = {
  sso_account_id: '120569607241',
  sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
  sso_region: 'us-east-2',
  sso_role_name: 'AdministratorAccess',
  region: 'us-east-2',
};

function draftUrl(projectId: string): string {
  return `/api/projects/${projectId}/infra/setup-draft`;
}

const PROCESS_SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const;

/**
 * Record every child-process launch made while `run()` executes.
 *
 * `child_process` is CJS, so it is reached through `createRequire` and mutated
 * in place — the same route `test/setup.ts` takes, and the reason `vi.spyOn` on
 * an `import * as` namespace cannot work here (the ESM namespace object is not
 * configurable).
 */
async function recordSpawns(run: () => Promise<void>): Promise<string[]> {
  const requireCjs = createRequire(import.meta.url);
  const cp = requireCjs('child_process') as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const commands: string[] = [];

  for (const name of PROCESS_SPAWNERS) {
    const original = cp[name] as (...args: unknown[]) => unknown;
    originals.set(name, original);
    cp[name] = (...args: unknown[]) => {
      commands.push(String(args[0]));
      return original(...args);
    };
  }
  try {
    await run();
  } finally {
    for (const [name, original] of originals) cp[name] = original;
  }
  return commands;
}

describe('GET /api/projects/:projectId/infra/setup-draft', () => {
  it('404s an unknown project', async () => {
    await request.get(draftUrl('does-not-exist')).expect(404);
  });

  it('returns a fully-populated draft for a bare project, listing every blocker', async () => {
    const projectId = await freshProject();

    const res = await request.get(draftUrl(projectId)).expect(200);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.draft).toMatchObject({
      projectId,
      infraEnabled: false,
      profiles: [],
      monitoringProfile: null,
      designatedMonitoringProfile: null,
      alertRuleCount: 0,
      enabledScopeCount: 0,
    });
    expect(res.body.draft.blockers).toEqual([
      'infra-disabled',
      'no-profiles',
      'no-monitoring-profile',
      'no-scope',
    ]);
  });

  it('renders for an SSO-only project — the case that has no usable credentials', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { dev: SSO_PROFILE } })
      .expect(200);

    const res = await request.get(draftUrl(projectId)).expect(200);

    expect(res.body.draft.profiles).toEqual([
      { name: 'dev', type: 'sso', region: 'us-east-2', monitoringCapable: false },
    ]);
    expect(res.body.draft.monitoringCapableProfiles).toEqual([]);
    expect(res.body.draft.blockers).toContain('only-sso-profiles');
    expect(res.body.draft.blockers).toContain('no-monitoring-profile');
  });

  it('reflects the designated monitoring profile, the allowlist and the rule counts', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: STATIC_PROFILE }, monitoringProfile: 'monitoring' })
      .expect(200);
    await request.patch(`/api/projects/${projectId}`).send({ infraEnabled: true }).expect(200);

    replaceInfraScopes(projectId, [
      { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
      { profileName: 'monitoring', region: 'us-east-2', service: 'rds', enabled: false },
    ]);
    createInfraAlertRule(
      projectId,
      {
        name: 'CPU high',
        service: 'ec2',
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: 'Average',
        periodS: 300,
        threshold: 90,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
      },
      Date.now(),
    );
    createInfraAlertRule(
      projectId,
      {
        name: 'Disabled rule',
        service: 'ec2',
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        stat: 'Maximum',
        periodS: 60,
        threshold: 0,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 2,
        enabled: false,
      },
      Date.now(),
    );

    const res = await request.get(draftUrl(projectId)).expect(200);
    const { draft } = res.body;

    expect(draft.infraEnabled).toBe(true);
    expect(draft.monitoringProfile).toBe('monitoring');
    expect(draft.designatedMonitoringProfile).toBe('monitoring');
    expect(draft.monitoringCapableProfiles).toEqual(['monitoring']);
    expect(draft.storageReady).toBe(true);
    expect(draft.scopes).toEqual([
      {
        profileName: 'monitoring',
        accountId: null,
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        hasTagFilter: false,
        resourceCount: 0,
      },
      {
        profileName: 'monitoring',
        accountId: null,
        region: 'us-east-2',
        service: 'rds',
        enabled: false,
        hasTagFilter: false,
        resourceCount: 0,
      },
    ]);
    expect(draft.enabledScopeCount).toBe(1);
    expect(draft.alertRuleCount).toBe(2);
    expect(draft.enabledAlertRuleCount).toBe(1);
    // Fully configured: nothing left to nag about.
    expect(draft.blockers).toEqual([]);
  });

  it('constructs no AWS SDK client and spawns no aws process', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: STATIC_PROFILE }, monitoringProfile: 'monitoring' })
      .expect(200);

    // Measure the GET only. Saving the profiles above legitimately invalidates
    // the cached credential resolvers, and that call is not the draft's.
    vi.clearAllMocks();
    const commands = await recordSpawns(async () => {
      await request.get(draftUrl(projectId)).expect(200);
    });

    // No credential provider, no client, no probe.
    for (const [name, fn] of Object.entries(awsClients)) {
      if (typeof fn === 'function') {
        expect(vi.mocked(fn as (...args: unknown[]) => unknown), name).not.toHaveBeenCalled();
      }
    }
    // And no shelling out to the AWS CLI, which is the other way this endpoint
    // could quietly acquire an AWS dependency.
    expect(commands.filter((cmd) => cmd.includes('aws'))).toEqual([]);
  });

  it('never serializes credential material', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          monitoring: STATIC_PROFILE,
          assumed: {
            type: 'role',
            role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
            external_id: 'ahx-super-secret-external-id',
            region: 'us-east-2',
          },
        },
        monitoringProfile: 'monitoring',
      })
      .expect(200);

    const res = await request.get(draftUrl(projectId)).expect(200);

    // Asserted over the wire format, so a field added later that happens to
    // carry a secret trips this too.
    const body = JSON.stringify(res.body);
    for (const secret of [
      STATIC_PROFILE.aws_access_key_id,
      STATIC_PROFILE.aws_secret_access_key,
      STATIC_PROFILE.aws_session_token,
      'ahx-super-secret-external-id',
      'arn:aws:iam::120569607241:role/AgentHubMonitoring',
    ]) {
      expect(body).not.toContain(secret);
    }
    for (const key of [
      'aws_access_key_id',
      'aws_secret_access_key',
      'aws_session_token',
      'external_id',
      'role_arn',
    ]) {
      expect(body).not.toContain(key);
    }
    // The profiles are still reported — this is not vacuously passing.
    expect(res.body.draft.profiles.map((p: { name: string }) => p.name)).toEqual([
      'assumed',
      'monitoring',
    ]);
  });
});
