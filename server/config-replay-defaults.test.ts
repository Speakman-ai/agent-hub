import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { readFileSync } from 'fs';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe('session replay platform defaults', () => {
  it('defaults retention to 14 days and mask-all to enabled', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(
      os.tmpdir(),
      `agent-hub-replay-defaults-${process.pid}-${Date.now()}`,
    );
    delete process.env.AGENT_HUB_REPLAY_RETENTION_DAYS;
    delete process.env.AGENT_HUB_REPLAY_MASK_ALL_ENFORCED;

    const { default: config } = await import('./config.js');
    expect(config.replayRetentionDays).toBe(14);
    expect(config.replayMaskAllEnforced).toBe(true);
  });

  it('wires retention and the staging mask-all opt-out through Terraform', () => {
    const root = path.resolve(__dirname, '..');
    const locals = readFileSync(path.join(root, 'ops/terraform/locals-agent-hub.tf'), 'utf8');
    const variables = readFileSync(path.join(root, 'ops/terraform/variables.tf'), 'utf8');
    const staging = readFileSync(
      path.join(root, 'ops/terraform/environments/test/test.tfvars.example'),
      'utf8',
    );

    expect(variables).toMatch(/variable "replay_retention_days"[\s\S]*default\s*=\s*14/);
    expect(locals).toContain('AGENT_HUB_REPLAY_RETENTION_DAYS=');
    expect(locals).toContain('AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=');
    expect(staging).toMatch(/replay_mask_all_enforced\s*=\s*false/);
  });
});
