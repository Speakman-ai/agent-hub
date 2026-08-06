import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeInfraDb, initInfraDb } from './infra-db.js';
import {
  deleteInfraAlertRouting,
  resolveInfraAlertRouting,
  upsertInfraAlertRouting,
} from './alert-routing-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-routing-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('infra alert routing', () => {
  it('resolves missing rows from severity defaults', () => {
    expect(resolveInfraAlertRouting('project-a', 'critical').channels).toEqual({
      in_app: true,
      push: true,
      email: true,
    });
    expect(resolveInfraAlertRouting('project-a', 'info').isDefault).toBe(true);
  });

  it('applies an override without materializing unrelated defaults', () => {
    upsertInfraAlertRouting('project-a', {
      severity: 'critical',
      channel: 'email',
      enabled: false,
    });
    const resolved = resolveInfraAlertRouting('project-a', 'critical');
    expect(resolved.channels).toEqual({ in_app: true, push: true, email: false });
    expect(resolved.isDefault).toBe(false);
    expect(resolved.overrides).toHaveLength(1);
    expect(deleteInfraAlertRouting('project-a', 'critical', 'email')).toBe(true);
    expect(resolveInfraAlertRouting('project-a', 'critical').isDefault).toBe(true);
  });
});
