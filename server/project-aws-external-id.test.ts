import { describe, it, expect } from 'vitest';
import {
  PROJECT_AWS_EXTERNAL_ID_PREFIX,
  PROJECT_AWS_EXTERNAL_ID_RE,
  ensureProjectAwsExternalId,
  generateProjectAwsExternalId,
  stampProjectAwsExternalId,
} from './project-aws-external-id.js';
import type { ProjectAwsSsoProfilesMap } from './project-aws-profiles.js';

describe('generateProjectAwsExternalId', () => {
  it('mints prefixed, high-entropy values', () => {
    const value = generateProjectAwsExternalId();
    expect(value.startsWith(PROJECT_AWS_EXTERNAL_ID_PREFIX)).toBe(true);
    expect(value).toMatch(PROJECT_AWS_EXTERNAL_ID_RE);
  });

  it('is unique across projects', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateProjectAwsExternalId()));
    expect(seen.size).toBe(200);
  });

  it('stays inside the AWS ExternalId character set and length limits', () => {
    // AWS: 2–1224 characters matching [\w+=,.@:/-]*.
    const value = generateProjectAwsExternalId();
    expect(value.length).toBeGreaterThanOrEqual(2);
    expect(value.length).toBeLessThanOrEqual(1224);
    expect(value).toMatch(/^[\w+=,.@:/-]+$/);
  });
});

describe('ensureProjectAwsExternalId', () => {
  it('mints and records on a project that has none', () => {
    const project: Record<string, unknown> = {};
    const { externalId, created } = ensureProjectAwsExternalId(project);
    expect(created).toBe(true);
    expect(project.awsExternalId).toBe(externalId);
  });

  it('is stable across calls so a re-read never rotates a live trust policy', () => {
    const project: Record<string, unknown> = {};
    const first = ensureProjectAwsExternalId(project);
    const second = ensureProjectAwsExternalId(project);
    expect(second.externalId).toBe(first.externalId);
    // `created: false` is what keeps a GET from writing projects.json every time.
    expect(second.created).toBe(false);
  });

  it('treats a blank stored value as unset', () => {
    const project: Record<string, unknown> = { awsExternalId: '   ' };
    const { externalId, created } = ensureProjectAwsExternalId(project);
    expect(created).toBe(true);
    expect(externalId).toMatch(PROJECT_AWS_EXTERNAL_ID_RE);
  });
});

describe('stampProjectAwsExternalId', () => {
  const externalId = 'agent-hub-11111111-2222-3333-4444-555555555555';

  it('overwrites an operator-supplied external_id on role profiles', () => {
    const profiles: ProjectAwsSsoProfilesMap = {
      mon: {
        type: 'role',
        role_arn: 'arn:aws:iam::123456789012:role/AgentHubMonitoring',
        external_id: 'attacker-chosen',
        region: 'us-east-2',
      },
    };
    const out = stampProjectAwsExternalId(profiles, externalId);
    expect(out.mon).toMatchObject({ external_id: externalId });
  });

  it('stamps a role profile that supplied none', () => {
    const profiles: ProjectAwsSsoProfilesMap = {
      mon: { type: 'role', role_arn: 'arn:aws:iam::123456789012:role/Mon', region: 'us-east-2' },
    };
    expect(stampProjectAwsExternalId(profiles, externalId).mon).toMatchObject({
      external_id: externalId,
    });
  });

  it('leaves sso and static profiles untouched', () => {
    const profiles: ProjectAwsSsoProfilesMap = {
      sso: {
        sso_account_id: '123456789012',
        sso_start_url: 'https://example.awsapps.com/start/',
        sso_region: 'us-east-2',
        sso_role_name: 'AdministratorAccess',
        region: 'us-east-2',
      },
      stat: {
        type: 'static',
        aws_access_key_id: 'AKIAEXAMPLE',
        aws_secret_access_key: 'secret',
        region: 'us-east-2',
      },
    };
    const out = stampProjectAwsExternalId(profiles, externalId);
    expect(out.sso).not.toHaveProperty('external_id');
    expect(out.stat).not.toHaveProperty('external_id');
  });

  it('does not mutate the input map', () => {
    const profiles: ProjectAwsSsoProfilesMap = {
      mon: { type: 'role', role_arn: 'arn:aws:iam::123456789012:role/Mon', region: 'us-east-2' },
    };
    stampProjectAwsExternalId(profiles, externalId);
    expect(profiles.mon).not.toHaveProperty('external_id');
  });
});
