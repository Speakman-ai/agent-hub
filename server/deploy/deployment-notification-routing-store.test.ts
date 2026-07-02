/**
 * Per-environment notification routing store — CRUD + the env-name default
 * resolution (prod → reporter + digest, non-prod → nothing). Exercised against
 * the shared test DB (initialized once per file by test/setup.ts). No real CLI
 * is spawned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  getNotificationRouting,
  listNotificationRouting,
  upsertNotificationRouting,
  deleteNotificationRouting,
  resolveNotificationRouting,
  isProductionEnvironmentName,
} from './deployment-notification-routing-store.js';

const P = 'proj-notif-routing-test';

beforeEach(() => {
  wipeTables(getDb(), ['deployment_env_notification_routing']);
});

describe('isProductionEnvironmentName', () => {
  it('treats prod / production (any case, padded) as production', () => {
    expect(isProductionEnvironmentName('prod')).toBe(true);
    expect(isProductionEnvironmentName('production')).toBe(true);
    expect(isProductionEnvironmentName('  PROD ')).toBe(true);
    expect(isProductionEnvironmentName('Production')).toBe(true);
  });

  it('treats every other name as non-production', () => {
    expect(isProductionEnvironmentName('staging')).toBe(false);
    expect(isProductionEnvironmentName('dev')).toBe(false);
    expect(isProductionEnvironmentName('prod-eu')).toBe(false);
  });
});

describe('notification routing CRUD', () => {
  it('returns null / empty for an unconfigured project', () => {
    expect(getNotificationRouting(P, 'dev')).toBeNull();
    expect(listNotificationRouting(P)).toEqual([]);
  });

  it('a new prod row seeds both switches on from the env-name default', () => {
    const row = upsertNotificationRouting({ projectId: P, environmentName: 'prod' });
    expect(row.ticket_release_enabled).toBe(1);
    expect(row.release_digest_enabled).toBe(1);
  });

  it('a new non-prod row seeds both switches off from the env-name default', () => {
    const row = upsertNotificationRouting({ projectId: P, environmentName: 'staging' });
    expect(row.ticket_release_enabled).toBe(0);
    expect(row.release_digest_enabled).toBe(0);
  });

  it('normalizes the environment key at the write boundary', () => {
    const row = upsertNotificationRouting({ projectId: P, environmentName: '  staging ' });
    expect(row.environment_name).toBe('staging');
    expect(getNotificationRouting(P, 'staging')).not.toBeNull();
  });

  it('persists meta as JSON and round-trips it', () => {
    const row = upsertNotificationRouting({
      projectId: P,
      environmentName: 'prod',
      meta: { note: 'reporters only' },
    });
    expect(JSON.parse(row.meta as string)).toEqual({ note: 'reporters only' });
  });

  it('partial-updates: flipping one type preserves the other and meta', () => {
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'staging',
      ticketReleaseEnabled: true,
      releaseDigestEnabled: true,
      meta: { a: 1 },
    });
    const onlyDigestOff = upsertNotificationRouting({
      projectId: P,
      environmentName: 'staging',
      releaseDigestEnabled: false,
    });
    expect(onlyDigestOff.ticket_release_enabled).toBe(1);
    expect(onlyDigestOff.release_digest_enabled).toBe(0);
    expect(JSON.parse(onlyDigestOff.meta as string)).toEqual({ a: 1 });
  });

  it('meta: null clears it; undefined preserves it', () => {
    upsertNotificationRouting({ projectId: P, environmentName: 'prod', meta: { a: 1 } });
    const cleared = upsertNotificationRouting({
      projectId: P,
      environmentName: 'prod',
      meta: null,
    });
    expect(cleared.meta).toBeNull();
  });

  it('deletes a row and reports whether one was removed', () => {
    upsertNotificationRouting({ projectId: P, environmentName: 'prod' });
    expect(deleteNotificationRouting(P, 'prod')).toBe(true);
    expect(deleteNotificationRouting(P, 'prod')).toBe(false);
    expect(getNotificationRouting(P, 'prod')).toBeNull();
  });

  it('lists rows sorted by environment name', () => {
    upsertNotificationRouting({ projectId: P, environmentName: 'staging' });
    upsertNotificationRouting({ projectId: P, environmentName: 'prod' });
    upsertNotificationRouting({ projectId: P, environmentName: 'dev' });
    expect(listNotificationRouting(P).map((r) => r.environment_name)).toEqual([
      'dev',
      'prod',
      'staging',
    ]);
  });
});

describe('resolveNotificationRouting', () => {
  it('prod with no row defaults to reporter + digest (isDefault)', () => {
    const r = resolveNotificationRouting(P, 'production');
    expect(r).toMatchObject({
      isProduction: true,
      ticketReleaseEnabled: true,
      releaseDigestEnabled: true,
      isDefault: true,
      config: null,
    });
  });

  it('non-prod with no row defaults to nothing (isDefault)', () => {
    const r = resolveNotificationRouting(P, 'staging');
    expect(r).toMatchObject({
      isProduction: false,
      ticketReleaseEnabled: false,
      releaseDigestEnabled: false,
      isDefault: true,
      config: null,
    });
  });

  it('an operator override wins over the env-name default', () => {
    // Opt a non-prod env INTO digest-only.
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'staging',
      ticketReleaseEnabled: false,
      releaseDigestEnabled: true,
    });
    const r = resolveNotificationRouting(P, 'staging');
    expect(r.isDefault).toBe(false);
    expect(r.ticketReleaseEnabled).toBe(false);
    expect(r.releaseDigestEnabled).toBe(true);
    expect(r.config).not.toBeNull();
  });

  it('an operator can opt a prod env OUT of all notifications', () => {
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'prod',
      ticketReleaseEnabled: false,
      releaseDigestEnabled: false,
    });
    const r = resolveNotificationRouting(P, 'prod');
    expect(r.isDefault).toBe(false);
    expect(r.ticketReleaseEnabled).toBe(false);
    expect(r.releaseDigestEnabled).toBe(false);
  });
});
