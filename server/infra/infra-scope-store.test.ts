/**
 * Scope store: the whole-list replace, the identity a surviving triple keeps
 * across an edit, tag-filter validation shared with the collector, and the
 * resource counts the projection is priced on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  listInfraScopes,
  replaceInfraScopes,
  uncollectableServices,
  InfraScopeValidationError,
  MAX_INFRA_SCOPES_PER_PROJECT,
} from './infra-scope-store.js';

let dir: string;

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER = DAY_MS;
const PROJECT = 'proj-a';

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-scope-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function list(projectId = PROJECT) {
  return listInfraScopes(projectId, STALE_AFTER, NOW);
}

/** Insert an inventory row the scope's resource count should pick up. */
function seedResource(opts: {
  projectId?: string;
  accountId?: string;
  region?: string;
  service?: string;
  resourceId: string;
  state?: string | null;
  lastSeen?: number;
}) {
  const projectId = opts.projectId ?? PROJECT;
  const accountId = opts.accountId ?? '111122223333';
  const region = opts.region ?? 'us-east-2';
  const service = opts.service ?? 'ec2';
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources
         (resource_key, project_id, account_id, region, service, resource_id,
          state, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      infraResourceKey({ projectId, accountId, region, service, resourceId: opts.resourceId }),
      projectId,
      accountId,
      region,
      service,
      opts.resourceId,
      opts.state === undefined ? 'running' : opts.state,
      NOW - DAY_MS,
      opts.lastSeen ?? NOW,
    );
}

describe('listInfraScopes', () => {
  it('returns nothing for a project that has opted into nothing', () => {
    expect(list()).toEqual([]);
  });

  it('reads a saved scope back in full', () => {
    replaceInfraScopes(
      PROJECT,
      [
        {
          profileName: 'monitoring',
          region: 'us-east-2',
          service: 'ec2',
          tagFilter: { Environment: ['prod'] },
        },
      ],
      NOW,
    );

    const [scope] = list();
    expect(scope).toMatchObject({
      projectId: PROJECT,
      profileName: 'monitoring',
      region: 'us-east-2',
      service: 'ec2',
      tagFilter: { Environment: ['prod'] },
      enabled: true,
      accountId: null,
      createdAt: NOW,
      updatedAt: NOW,
      resourceCount: 0,
    });
    expect(scope.id).toBeTruthy();
  });

  it('scopes reads to one project', () => {
    replaceInfraScopes(PROJECT, [{ profileName: 'a', region: 'us-east-2', service: 'ec2' }], NOW);
    replaceInfraScopes('proj-b', [{ profileName: 'b', region: 'eu-west-1', service: 'rds' }], NOW);

    expect(list().map((s) => s.profileName)).toEqual(['a']);
    expect(list('proj-b').map((s) => s.profileName)).toEqual(['b']);
  });

  it('includes disabled scopes, so the editor can render a paused row', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2', enabled: false }],
      NOW,
    );
    expect(list()).toHaveLength(1);
    expect(list()[0]!.enabled).toBe(false);
  });

  it('orders by profile, region, service so the editor is stable across saves', () => {
    replaceInfraScopes(
      PROJECT,
      [
        { profileName: 'b', region: 'us-east-2', service: 'rds' },
        { profileName: 'a', region: 'us-west-1', service: 'ec2' },
        { profileName: 'a', region: 'us-east-2', service: 'rds' },
        { profileName: 'a', region: 'us-east-2', service: 'ec2' },
      ],
      NOW,
    );

    expect(list().map((s) => `${s.profileName}/${s.region}/${s.service}`)).toEqual([
      'a/us-east-2/ec2',
      'a/us-east-2/rds',
      'a/us-west-1/ec2',
      'b/us-east-2/rds',
    ]);
  });
});

describe('resource counts', () => {
  it('counts live inventory for the scope’s region and service', () => {
    seedResource({ resourceId: 'i-1' });
    seedResource({ resourceId: 'i-2' });
    seedResource({ resourceId: 'db-1', service: 'rds' });
    seedResource({ resourceId: 'i-9', region: 'eu-west-1' });

    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );

    expect(list()[0]!.resourceCount).toBe(2);
  });

  it('excludes terminated and stale resources, matching what the collector polls', () => {
    seedResource({ resourceId: 'i-live' });
    seedResource({ resourceId: 'i-gone', state: 'terminated' });
    seedResource({ resourceId: 'i-stale', lastSeen: NOW - 2 * DAY_MS });

    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );

    expect(list()[0]!.resourceCount).toBe(1);
  });

  it('does not count another project’s resources', () => {
    seedResource({ projectId: 'proj-b', resourceId: 'i-other' });
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );
    expect(list()[0]!.resourceCount).toBe(0);
  });
});

describe('replaceInfraScopes', () => {
  it('deletes rows absent from the new list', () => {
    replaceInfraScopes(
      PROJECT,
      [
        { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
        { profileName: 'monitoring', region: 'us-east-2', service: 'rds' },
      ],
      NOW,
    );
    expect(list()).toHaveLength(2);

    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'rds' }],
      NOW + 1000,
    );

    expect(list().map((s) => s.service)).toEqual(['rds']);
  });

  it('empties the allowlist, which stops all collection', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );
    replaceInfraScopes(PROJECT, [], NOW + 1000);
    expect(list()).toEqual([]);
  });

  it('keeps id, createdAt and the resolved accountId for a surviving triple', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );
    const before = list()[0]!;

    // Stand in for the async sts:GetCallerIdentity fill-in.
    getInfraDb()
      .prepare(`UPDATE infra_scopes SET account_id = ? WHERE id = ?`)
      .run('111122223333', before.id);

    replaceInfraScopes(
      PROJECT,
      [
        {
          profileName: 'monitoring',
          region: 'us-east-2',
          service: 'ec2',
          tagFilter: { Team: ['core'] },
        },
      ],
      NOW + 5000,
    );

    const after = list()[0]!;
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(NOW);
    expect(after.accountId).toBe('111122223333');
    expect(after.updatedAt).toBe(NOW + 5000);
    expect(after.tagFilter).toEqual({ Team: ['core'] });
  });

  it('does not touch metric history when a scope is removed', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
      NOW,
    );
    seedResource({ resourceId: 'i-1' });

    replaceInfraScopes(PROJECT, [], NOW + 1000);

    const remaining = getInfraDb()
      .prepare(`SELECT COUNT(*) AS n FROM infra_resources WHERE project_id = ?`)
      .get(PROJECT) as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('leaves another project’s scopes alone', () => {
    replaceInfraScopes('proj-b', [{ profileName: 'b', region: 'eu-west-1', service: 'rds' }], NOW);
    replaceInfraScopes(PROJECT, [], NOW);
    expect(list('proj-b')).toHaveLength(1);
  });

  it('lowercases the service so it matches the metric pack lookup', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: 'monitoring', region: 'us-east-2', service: 'EC2' }],
      NOW,
    );
    expect(list()[0]!.service).toBe('ec2');
  });

  it('trims surrounding whitespace rather than storing an untypable triple', () => {
    replaceInfraScopes(
      PROJECT,
      [{ profileName: '  monitoring ', region: ' us-east-2', service: 'ec2 ' }],
      NOW,
    );
    expect(list()[0]).toMatchObject({
      profileName: 'monitoring',
      region: 'us-east-2',
      service: 'ec2',
    });
  });

  it('stores an omitted or empty tag filter as no filter', () => {
    replaceInfraScopes(
      PROJECT,
      [
        { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
        { profileName: 'monitoring', region: 'us-east-2', service: 'rds', tagFilter: {} },
        { profileName: 'monitoring', region: 'us-east-2', service: 'lambda', tagFilter: null },
      ],
      NOW,
    );
    expect(list().map((s) => s.tagFilter)).toEqual([null, null, null]);
  });
});

describe('validation', () => {
  const base = { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' };

  it('rejects a duplicate triple by name, not as an opaque constraint error', () => {
    expect(() => replaceInfraScopes(PROJECT, [base, { ...base }], NOW)).toThrow(
      InfraScopeValidationError,
    );
    expect(() => replaceInfraScopes(PROJECT, [base, { ...base }], NOW)).toThrow(
      /duplicate scope for monitoring \/ us-east-2 \/ ec2/,
    );
  });

  it('treats a case- or whitespace-different service as the same triple', () => {
    expect(() => replaceInfraScopes(PROJECT, [base, { ...base, service: ' EC2 ' }], NOW)).toThrow(
      InfraScopeValidationError,
    );
  });

  it.each(['profileName', 'region', 'service'])('rejects a blank %s', (field) => {
    expect(() => replaceInfraScopes(PROJECT, [{ ...base, [field]: '   ' }], NOW)).toThrow(
      new RegExp(`${field} is required`),
    );
  });

  it.each(['profileName', 'region', 'service'])('rejects a missing %s', (field) => {
    const scope = { ...base } as Record<string, unknown>;
    delete scope[field];
    expect(() => replaceInfraScopes(PROJECT, [scope as never], NOW)).toThrow(
      InfraScopeValidationError,
    );
  });

  it('rejects an over-long field', () => {
    expect(() => replaceInfraScopes(PROJECT, [{ ...base, region: 'x'.repeat(129) }], NOW)).toThrow(
      /128 characters or fewer/,
    );
  });

  it('rejects a tag filter the collector would refuse, rather than storing a dead scope', () => {
    expect(() =>
      replaceInfraScopes(PROJECT, [{ ...base, tagFilter: { '': ['prod'] } }], NOW),
    ).toThrow(InfraScopeValidationError);
    expect(() => replaceInfraScopes(PROJECT, [{ ...base, tagFilter: { Env: [] } }], NOW)).toThrow(
      InfraScopeValidationError,
    );
    expect(() =>
      replaceInfraScopes(PROJECT, [{ ...base, tagFilter: { Env: [7] as never } }], NOW),
    ).toThrow(InfraScopeValidationError);
  });

  it('rejects a non-object tag filter', () => {
    expect(() =>
      replaceInfraScopes(PROJECT, [{ ...base, tagFilter: ['prod'] as never }], NOW),
    ).toThrow(/tagFilter must be an object/);
  });

  it('caps the allowlist size, since every row multiplies into billed requests', () => {
    const many = Array.from({ length: MAX_INFRA_SCOPES_PER_PROJECT + 1 }, (_, i) => ({
      ...base,
      region: `us-east-${i}`,
    }));
    expect(() => replaceInfraScopes(PROJECT, many, NOW)).toThrow(
      new RegExp(`at most ${MAX_INFRA_SCOPES_PER_PROJECT} scopes`),
    );
  });

  it('writes nothing at all when one row in the list is invalid', () => {
    replaceInfraScopes(PROJECT, [base], NOW);
    expect(() =>
      replaceInfraScopes(
        PROJECT,
        [
          { ...base, service: 'rds' },
          { ...base, service: '' },
        ],
        NOW + 1000,
      ),
    ).toThrow(InfraScopeValidationError);

    // The pre-existing ec2 scope survives: validation runs before any write.
    expect(list().map((s) => s.service)).toEqual(['ec2']);
  });
});

describe('uncollectableServices', () => {
  it('is empty when every service has a metric pack', () => {
    expect(
      uncollectableServices([{ profileName: 'm', region: 'us-east-2', service: 'ec2' }]),
    ).toEqual([]);
  });

  it('reports an unknown service rather than rejecting it', () => {
    const scopes = [
      { profileName: 'm', region: 'us-east-2', service: 'ec2' },
      { profileName: 'm', region: 'us-east-2', service: 'quantumdb' },
      { profileName: 'm', region: 'eu-west-1', service: 'QuantumDB' },
    ];
    expect(uncollectableServices(scopes)).toEqual(['quantumdb']);

    // And it stores, because the service column is deliberately free text.
    replaceInfraScopes(PROJECT, scopes.slice(0, 2), NOW);
    expect(list()).toHaveLength(2);
  });
});
