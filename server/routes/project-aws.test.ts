import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import path from 'path';
import config from '../config.js';
import { getRequest } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `aws-prof-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

const SAMPLE = {
  dev: {
    sso_account_id: '120569607241',
    sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    sso_region: 'us-east-2',
    sso_role_name: 'AdministratorAccess',
    region: 'us-east-2',
  },
};

describe('PUT/GET /api/projects/:id/aws-profiles', () => {
  it('round-trips profile config', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: SAMPLE })
      .expect(200);
    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.profiles.dev.sso_account_id).toBe('120569607241');
  });

  it('round-trips static credential profiles', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          staticdev: {
            type: 'static',
            aws_access_key_id: 'AKIATESTKEY',
            aws_secret_access_key: 'secret-test-key',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);
    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.profiles.staticdev).toMatchObject({
      type: 'static',
      aws_access_key_id: 'AKIATESTKEY',
      aws_secret_access_key: 'secret-test-key',
      region: 'us-east-2',
    });
  });

  it('clearing profiles truncates generated config and credentials files', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          staticdev: {
            type: 'static',
            aws_access_key_id: 'AKIATESTKEY',
            aws_secret_access_key: 'secret-test-key',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);

    const dir = path.join(config.dataDir, 'project-aws-config', projectId);
    const configPath = path.join(dir, 'config');
    const credentialsPath = path.join(dir, 'credentials');
    expect(readFileSync(credentialsPath, 'utf-8')).toContain('secret-test-key');

    await request.put(`/api/projects/${projectId}/aws-profiles`).send({ profiles: {} }).expect(200);

    expect(readFileSync(configPath, 'utf-8')).toBe('');
    expect(readFileSync(credentialsPath, 'utf-8')).toBe('');
  });

  it('round-trips the designated default profile', async () => {
    const projectId = await freshProject();
    const profiles = { ...SAMPLE, prod: { ...SAMPLE.dev, sso_account_id: '210987654321' } };

    const put = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles, defaultProfile: 'prod' })
      .expect(200);
    expect(put.body.defaultProfile).toBe('prod');
    expect(put.body.effectiveDefaultProfile).toBe('prod');

    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.defaultProfile).toBe('prod');
    expect(res.body.effectiveDefaultProfile).toBe('prod');
  });

  // Without a resolved default, an un-flagged `aws sso login` in the Terminal
  // falls back to a `[default]` section the generated config never has.
  it('reports the sole profile as effective default with no designation', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: SAMPLE })
      .expect(200);
    expect(res.body.defaultProfile).toBeNull();
    expect(res.body.effectiveDefaultProfile).toBe('dev');
  });

  it('reports no effective default for several profiles without a designation', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { ...SAMPLE, prod: { ...SAMPLE.dev } } })
      .expect(200);
    expect(res.body.effectiveDefaultProfile).toBeNull();
  });

  it('clears the designation when sent null', async () => {
    const projectId = await freshProject();
    const profiles = { ...SAMPLE, prod: { ...SAMPLE.dev } };
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles, defaultProfile: 'prod' })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles, defaultProfile: null })
      .expect(200);
    expect(res.body.defaultProfile).toBeNull();
    expect(res.body.effectiveDefaultProfile).toBeNull();
  });

  it('rejects a default profile that is not in the same request', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: SAMPLE, defaultProfile: 'staging' })
      .expect(400);
    expect(res.body.error).toMatch(/defaultProfile/);
  });

  it('round-trips a role profile without loss and keeps it out of the credentials file', async () => {
    const projectId = await freshProject();
    const role = {
      type: 'role',
      role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
      external_id: 'ext-123',
      role_session_name: 'agent-hub',
      credential_source: 'Ec2InstanceMetadata',
      region: 'us-east-2',
      output: 'yaml',
    };
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: role } })
      .expect(200);

    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.profiles.monitoring).toEqual(role);

    const dir = path.join(config.dataDir, 'project-aws-config', projectId);
    expect(readFileSync(path.join(dir, 'config'), 'utf-8')).toContain(
      'role_arn = arn:aws:iam::120569607241:role/AgentHubMonitoring',
    );
    expect(readFileSync(path.join(dir, 'credentials'), 'utf-8')).toBe('');
  });

  it('reports the credential source role profiles will be rendered with', async () => {
    const projectId = await freshProject();
    const saved = process.env.AGENT_HUB_AWS_CREDENTIAL_SOURCE;
    try {
      process.env.AGENT_HUB_AWS_CREDENTIAL_SOURCE = 'EcsContainer';
      const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
      expect(res.body.ambientCredentialSource).toBe('EcsContainer');
    } finally {
      if (saved === undefined) delete process.env.AGENT_HUB_AWS_CREDENTIAL_SOURCE;
      else process.env.AGENT_HUB_AWS_CREDENTIAL_SOURCE = saved;
    }
  });

  // Spawns get a scrubbed env, so an `Environment`-sourced role cannot work
  // from the CLI. Say which layer dropped the credentials instead of letting
  // the probe fail as a generic "unable to locate credentials".
  it('explains why an Environment-sourced role cannot be probed by the CLI', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          monitoring: {
            type: 'role',
            role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
            credential_source: 'Environment',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);

    const res = await request
      .get(`/api/projects/${projectId}/aws-sso/status?profile=monitoring`)
      .expect(200);
    expect(res.body).toMatchObject({
      profile: 'monitoring',
      loggedIn: false,
      credentialType: 'role',
      needsLogin: false,
    });
    expect(res.body.error).toMatch(/source_profile/);
  });

  it('rejects a role profile whose role_arn is not an IAM role ARN', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          monitoring: {
            type: 'role',
            role_arn: 'arn:aws:iam::120569607241:user/Someone',
            region: 'us-east-2',
          },
        },
      })
      .expect(400);
    expect(res.body.error).toMatch(/role_arn/);
  });

  // A role profile has no device flow to start; the login route must say so
  // instead of spawning `aws sso login` against a profile with no SSO keys.
  it('refuses SSO login for a role profile', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          monitoring: {
            type: 'role',
            role_arn: 'arn:aws:iam::120569607241:role/AgentHubMonitoring',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);
    const res = await request
      .post(`/api/projects/${projectId}/aws-sso/login`)
      .send({ profile: 'monitoring' })
      .expect(400);
    expect(res.body.error).toMatch(/assumed role/);
  });

  it('rejects invalid account id', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          dev: { ...SAMPLE.dev, sso_account_id: 'not-valid' },
        },
      })
      .expect(400);
    expect(res.body.error).toMatch(/account/i);
  });
});
