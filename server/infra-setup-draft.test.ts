/**
 * Unit tests for the Hub-local infrastructure setup draft.
 *
 * Two things carry weight here beyond the field-by-field mapping:
 *
 *   1. **Zero AWS.** The draft must render for a project whose only profiles
 *      are interactive SSO — the case that cannot monitor anything and the most
 *      common reason to open the wizard. If it ever reached for a credential
 *      provider or an SDK client, that case would fail exactly when it matters.
 *      Asserted structurally, against the module's own import graph.
 *   2. **No credential material.** Every profile arm carries secrets; the draft
 *      carries none. Asserted against a project stuffed with recognizable
 *      credentials, over the serialized JSON rather than field-by-field, so a
 *      future field that happens to include a key fails this test too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectInfraSetupDraft } from './infra-setup-draft.js';
import type { InfraScope } from './infra/infra-scope-store.js';
import type { InfraAlertRuleRow } from './infra/alert-store.js';
import type { Project } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj',
    name: 'Proj',
    cwd: '/tmp/proj',
    color: '#3B82F6',
    agents: [],
    ...overrides,
  } as Project;
}

const SSO_PROFILE = {
  type: 'sso' as const,
  sso_account_id: '123456789012',
  sso_start_url: 'https://example.awsapps.com/start',
  sso_region: 'us-east-1',
  sso_role_name: 'ReadOnly',
  region: 'us-east-2',
};

const STATIC_PROFILE = {
  type: 'static' as const,
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  aws_session_token: 'FwoGZXIvYXdzEExampleSessionTokenValue',
  region: 'eu-west-1',
};

const ROLE_PROFILE = {
  type: 'role' as const,
  role_arn: 'arn:aws:iam::123456789012:role/AgentHubMonitoring',
  external_id: 'ahx-super-secret-external-id',
  credential_source: 'Ec2InstanceMetadata' as const,
  region: 'us-east-2',
};

function makeScope(overrides: Partial<InfraScope> = {}): InfraScope {
  return {
    id: 'scope-1',
    projectId: 'proj',
    profileName: 'monitoring',
    accountId: '123456789012',
    region: 'us-east-2',
    service: 'ec2',
    tagFilter: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    resourceCount: 4,
    ...overrides,
  };
}

function makeRule(overrides: Partial<InfraAlertRuleRow> = {}): InfraAlertRuleRow {
  return {
    id: 'rule-1',
    project_id: 'proj',
    name: 'CPU high',
    description: null,
    service: 'ec2',
    account_id: null,
    region: null,
    resource_key: null,
    tag_filter_json: null,
    namespace: 'AWS/EC2',
    metric_name: 'CPUUtilization',
    stat: 'Average',
    period_s: 300,
    threshold: 90,
    comparison_operator: 'GreaterThanThreshold',
    evaluation_periods: 3,
    datapoints_to_alarm: 2,
    treat_missing_data: 'missing',
    severity: 'warning',
    enabled: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as InfraAlertRuleRow;
}

describe('collectInfraSetupDraft — profiles', () => {
  it('summarizes each profile arm with its type and monitoring capability', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { dev: SSO_PROFILE, keys: STATIC_PROFILE, monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { scopes: [makeScope()] },
    );

    // Sorted by name so the picker order is stable across saves.
    expect(draft.profiles).toEqual([
      { name: 'dev', type: 'sso', region: 'us-east-2', monitoringCapable: false },
      { name: 'keys', type: 'static', region: 'eu-west-1', monitoringCapable: true },
      { name: 'monitoring', type: 'role', region: 'us-east-2', monitoringCapable: true },
    ]);
    expect(draft.monitoringCapableProfiles).toEqual(['keys', 'monitoring']);
    expect(draft.monitoringProfile).toBe('monitoring');
    expect(draft.designatedMonitoringProfile).toBe('monitoring');
  });

  it('treats a legacy stanza with no `type` as SSO, matching isProjectAwsSsoProfile', () => {
    const { type: _dropped, ...legacy } = SSO_PROFILE;
    const draft = collectInfraSetupDraft(
      makeProject({ awsSsoProfiles: { legacy } as Project['awsSsoProfiles'] }),
    );

    expect(draft.profiles[0]).toMatchObject({
      name: 'legacy',
      type: 'sso',
      monitoringCapable: false,
    });
    expect(draft.blockers).toContain('only-sso-profiles');
  });
});

describe('collectInfraSetupDraft — blockers', () => {
  it('reports every precondition for a bare project', () => {
    const draft = collectInfraSetupDraft(makeProject());

    expect(draft.blockers).toEqual([
      'infra-disabled',
      'no-profiles',
      'no-monitoring-profile',
      'no-scope',
    ]);
    expect(draft.infraEnabled).toBe(false);
    expect(draft.monitoringProfile).toBeNull();
  });

  it('names only-sso-profiles as the cause alongside no-monitoring-profile', () => {
    const draft = collectInfraSetupDraft(
      makeProject({ infraEnabled: true, awsSsoProfiles: { dev: SSO_PROFILE } }),
      { scopes: [makeScope()] },
    );

    // Both, not one: the wizard needs `no-monitoring-profile` to decide whether
    // collection can run, and `only-sso-profiles` to decide what to say about it.
    expect(draft.blockers).toEqual(['only-sso-profiles', 'no-monitoring-profile']);
    expect(draft.notes.join(' ')).toMatch(/static or assume-role profile/);
  });

  it('reports a designation that no longer resolves as dead rather than absent', () => {
    // The designation survived a flip to SSO. `resolveProjectAwsMonitoringProfile`
    // refuses it, and so must the draft — but the field is still set, so telling
    // the operator "none designated" would point them at a filled-in input.
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: SSO_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { scopes: [makeScope()] },
    );

    expect(draft.designatedMonitoringProfile).toBe('monitoring');
    expect(draft.monitoringProfile).toBeNull();
    expect(draft.blockers).toContain('no-monitoring-profile');
    expect(draft.notes.join(' ')).toMatch(/designated but no longer resolves/);
  });

  it('clears every blocker once the project is fully configured', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { scopes: [makeScope()], alertRules: [makeRule()] },
    );

    expect(draft.blockers).toEqual([]);
  });

  it('flags an all-disabled allowlist as no-scope, since nothing is polled', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { scopes: [makeScope({ enabled: false })], alertRules: [makeRule()] },
    );

    expect(draft.enabledScopeCount).toBe(0);
    expect(draft.blockers).toEqual(['no-scope']);
    expect(draft.notes.join(' ')).toMatch(/pause, not a delete/);
  });

  it('reports storage-unavailable instead of no-scope when infra.db is closed', () => {
    // The operator cannot fix a closed database by adding a scope, so reporting
    // zero scopes as a configuration choice would send them to the wrong screen.
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { storageReady: false },
    );

    expect(draft.storageReady).toBe(false);
    expect(draft.blockers).toEqual(['storage-unavailable']);
    expect(draft.blockers).not.toContain('no-scope');
    expect(draft.notes.join(' ')).toMatch(/unknown, not zero/);
  });
});

describe('collectInfraSetupDraft — scopes and rules', () => {
  it('summarizes the allowlist and counts enabled rules separately', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      {
        scopes: [
          makeScope({ tagFilter: { Env: ['prod'] } }),
          makeScope({ id: 's2', service: 'rds', enabled: false, resourceCount: 0 }),
        ],
        alertRules: [makeRule(), makeRule({ id: 'r2', enabled: 0 })],
      },
    );

    expect(draft.scopes).toEqual([
      {
        profileName: 'monitoring',
        accountId: '123456789012',
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        hasTagFilter: true,
        resourceCount: 4,
      },
      {
        profileName: 'monitoring',
        accountId: '123456789012',
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
  });

  it('notes when scopes collect but nothing would ever notify', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
      }),
      { scopes: [makeScope()], alertRules: [] },
    );

    expect(draft.notes.join(' ')).toMatch(/no alert rules exist yet/);
  });
});

describe('collectInfraSetupDraft — never leaks credential material', () => {
  it('omits access keys, secret keys, session tokens and the external ID', () => {
    const draft = collectInfraSetupDraft(
      makeProject({
        infraEnabled: true,
        awsSsoProfiles: { keys: STATIC_PROFILE, monitoring: ROLE_PROFILE },
        awsMonitoringProfile: 'monitoring',
        // Present on the record and deliberately not surfaced: the external ID
        // is the shared half of a customer's role trust policy.
        awsExternalId: 'ahx-project-external-id',
      }),
      { scopes: [makeScope()], alertRules: [makeRule()] },
    );

    // Serialized rather than field-by-field, so a field added later that
    // happens to carry a secret fails here too.
    const serialized = JSON.stringify(draft);
    for (const secret of [
      STATIC_PROFILE.aws_access_key_id,
      STATIC_PROFILE.aws_secret_access_key,
      STATIC_PROFILE.aws_session_token,
      ROLE_PROFILE.external_id,
      ROLE_PROFILE.role_arn,
      'ahx-project-external-id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const key of [
      'aws_access_key_id',
      'aws_secret_access_key',
      'aws_session_token',
      'external_id',
    ]) {
      expect(serialized).not.toContain(key);
    }
  });
});

describe('collectInfraSetupDraft — makes no AWS calls', () => {
  it('renders for an SSO-only project, the case with no usable credentials', () => {
    // The behavioural half of "zero AWS calls": if the draft reached for a
    // credential provider this project could not produce one, and the call
    // would fail rather than return the blockers that explain the situation.
    const draft = collectInfraSetupDraft(
      makeProject({ infraEnabled: true, awsSsoProfiles: { dev: SSO_PROFILE } }),
      { storageReady: false },
    );

    expect(draft.blockers).toContain('only-sso-profiles');
    expect(draft.profiles).toHaveLength(1);
  });

  it('imports no AWS SDK, credential provider, or process-spawning module', () => {
    // Structural half: purity here is a property of the import graph, not a
    // discipline. `import type` is erased at runtime, so only value imports
    // count — this asserts the module can reach neither AWS nor a shell.
    const source = readFileSync(path.join(HERE, 'infra-setup-draft.ts'), 'utf8');
    const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gm)].map(
      (m) => m[1],
    );

    expect(valueImports).toEqual(['./project-aws-profiles.js']);
    for (const forbidden of ['@aws-sdk/', 'child_process', 'aws-clients', 'infra-db']) {
      expect(valueImports.some((spec) => spec.includes(forbidden))).toBe(false);
    }
  });
});
