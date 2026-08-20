/**
 * Release gate store — CRUD, JSON id-list normalization, the "must watch
 * something" guard, partial-update semantics, the fired/failed compare-and-set
 * mark helpers, and the active-gate listing the sweep consumes. Exercised
 * against the shared test DB (initialized once per file by test/setup.ts). No
 * real CLI is spawned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  createReleaseGate,
  deleteReleaseGate,
  DeployReleaseGateError,
  getReleaseGate,
  listActiveReleaseGates,
  listReleaseGatesForEnvironment,
  listReleaseGatesForProject,
  markReleaseGateFailed,
  markReleaseGateFired,
  parseGateEpicIds,
  parseGateSessionIds,
  RELEASE_GATE_MAX_SELECTIONS,
  updateReleaseGate,
} from './deployment-release-gate-store.js';

const P = 'proj-release-gate-test';

beforeEach(() => {
  wipeTables(getDb(), ['deployment_env_release_gate']);
});

describe('release gate CRUD', () => {
  it('returns null / empty for an unconfigured project', () => {
    expect(getReleaseGate(P, 'missing')).toBeNull();
    expect(listReleaseGatesForProject(P)).toEqual([]);
    expect(listReleaseGatesForEnvironment(P, 'prod')).toEqual([]);
    expect(listActiveReleaseGates().filter((g) => g.project_id === P)).toEqual([]);
  });

  it('creates a gate defaulting to armed + enabled with ref=main', () => {
    const row = createReleaseGate({
      projectId: P,
      environmentName: 'prod',
      sessionIds: ['s1', 's2'],
    });
    expect(row).toMatchObject({
      project_id: P,
      environment_name: 'prod',
      ref: 'main',
      status: 'armed',
      enabled: 1,
      owner_user_id: null,
      fired_deployment_id: null,
      last_error: null,
    });
    expect(parseGateSessionIds(row)).toEqual(['s1', 's2']);
    expect(parseGateEpicIds(row)).toEqual([]);
  });

  it('honors ref override, owner, enabled:false, epics, and meta', () => {
    const row = createReleaseGate({
      projectId: P,
      environmentName: 'staging',
      ref: 'release-1.2',
      epicIds: ['e1'],
      ownerUserId: 'user-9',
      enabled: false,
      meta: { note: 'batch' },
    });
    expect(row).toMatchObject({
      ref: 'release-1.2',
      owner_user_id: 'user-9',
      enabled: 0,
    });
    expect(parseGateEpicIds(row)).toEqual(['e1']);
    expect(JSON.parse(row.meta!)).toEqual({ note: 'batch' });
  });

  it('trims, de-duplicates, and drops blank ids', () => {
    const row = createReleaseGate({
      projectId: P,
      environmentName: 'prod',
      sessionIds: [' s1 ', 's1', '', '  ', 's2'],
    });
    expect(parseGateSessionIds(row)).toEqual(['s1', 's2']);
  });

  it('rejects a gate that watches nothing', () => {
    expect(() =>
      createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: [], epicIds: [] }),
    ).toThrow(DeployReleaseGateError);
    expect(() => createReleaseGate({ projectId: P, environmentName: 'prod' })).toThrow(
      /at least one session or epic/,
    );
  });

  it('rejects an over-long selection list', () => {
    const many = Array.from({ length: RELEASE_GATE_MAX_SELECTIONS + 1 }, (_, i) => `s${i}`);
    expect(() =>
      createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: many }),
    ).toThrow(/may not exceed/);
  });

  it('rejects a blank environment name', () => {
    expect(() =>
      createReleaseGate({ projectId: P, environmentName: '   ', sessionIds: ['s1'] }),
    ).toThrow(/environmentName is required/);
  });
});

describe('release gate update', () => {
  it('partially updates without clobbering other fields', () => {
    const row = createReleaseGate({
      projectId: P,
      environmentName: 'prod',
      sessionIds: ['s1'],
      epicIds: ['e1'],
      ref: 'main',
    });
    const updated = updateReleaseGate(P, row.id, { enabled: false });
    expect(updated).toMatchObject({ enabled: 0, ref: 'main' });
    expect(parseGateSessionIds(updated!)).toEqual(['s1']);
    expect(parseGateEpicIds(updated!)).toEqual(['e1']);

    const reselected = updateReleaseGate(P, row.id, { sessionIds: ['s9'] });
    expect(parseGateSessionIds(reselected!)).toEqual(['s9']);
    expect(parseGateEpicIds(reselected!)).toEqual(['e1']);
  });

  it('returns null updating a missing gate', () => {
    expect(updateReleaseGate(P, 'nope', { enabled: false })).toBeNull();
  });

  it('rejects an update that would leave the gate watching nothing', () => {
    const row = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s1'] });
    expect(() => updateReleaseGate(P, row.id, { sessionIds: [], epicIds: [] })).toThrow(
      /at least one session or epic/,
    );
  });
});

describe('release gate mark helpers (compare-and-set)', () => {
  it('markFired flips an armed gate once and is idempotent afterwards', () => {
    const row = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s1'] });
    expect(markReleaseGateFired(P, row.id, 'dep-1')).toBe(true);
    const fired = getReleaseGate(P, row.id)!;
    expect(fired).toMatchObject({
      status: 'fired',
      fired_deployment_id: 'dep-1',
      last_error: null,
    });
    expect(fired.resolved_at).not.toBeNull();
    // A second call no longer matches status='armed'.
    expect(markReleaseGateFired(P, row.id, 'dep-2')).toBe(false);
    expect(getReleaseGate(P, row.id)!.fired_deployment_id).toBe('dep-1');
  });

  it('markFailed flips an armed gate and blocks a later fire', () => {
    const row = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s1'] });
    expect(markReleaseGateFailed(P, row.id, 'boom')).toBe(true);
    expect(getReleaseGate(P, row.id)).toMatchObject({ status: 'failed', last_error: 'boom' });
    // Already terminal — cannot fire.
    expect(markReleaseGateFired(P, row.id, 'dep-x')).toBe(false);
  });
});

describe('listActiveReleaseGates', () => {
  it('returns only armed + enabled gates', () => {
    const armed = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s1'] });
    const paused = createReleaseGate({
      projectId: P,
      environmentName: 'prod',
      sessionIds: ['s2'],
      enabled: false,
    });
    const fired = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s3'] });
    markReleaseGateFired(P, fired.id, 'dep-1');

    const active = listActiveReleaseGates()
      .filter((g) => g.project_id === P)
      .map((g) => g.id);
    expect(active).toContain(armed.id);
    expect(active).not.toContain(paused.id);
    expect(active).not.toContain(fired.id);
  });
});

describe('release gate delete', () => {
  it('removes a gate and is idempotent', () => {
    const row = createReleaseGate({ projectId: P, environmentName: 'prod', sessionIds: ['s1'] });
    expect(deleteReleaseGate(P, row.id)).toBe(true);
    expect(deleteReleaseGate(P, row.id)).toBe(false);
    expect(getReleaseGate(P, row.id)).toBeNull();
  });
});
