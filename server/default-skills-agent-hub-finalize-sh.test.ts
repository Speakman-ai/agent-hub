/**
 * Behavioural guard for `default-skills/agent-hub/scripts/finalize.sh` — the
 * wrapper that lets a spawned agent read Finalize Code Changes run state and
 * CI step logs from the REST API (it has no web "session strip").
 *
 * These tests exercise ONLY the argument-validation / usage paths, which
 * exit before any `hub_api` (network) call. We never hit the Hub here, so
 * the tests are hermetic and fast. The happy-path subcommands (`latest`,
 * `failed`, `output <n>`) talk to the live API and are covered at the route
 * layer (`routes/finalize.test.ts`).
 */
import { spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'default-skills', 'agent-hub', 'scripts', 'finalize.sh');

function run(args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env.PATH || '', HOME: os.tmpdir() },
    encoding: 'utf-8',
  });
}

describe('finalize.sh layout', () => {
  it('is present and executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

describe('finalize.sh usage / validation', () => {
  it('prints usage with all subcommands on `help`', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: finalize.sh');
    for (const sub of ['latest', 'failed', 'output', 'raw']) {
      expect(r.stdout).toContain(sub);
    }
  });

  it('prints usage when invoked with no subcommand', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: finalize.sh');
  });

  it('exits 2 on an unknown subcommand', () => {
    const r = run(['bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown subcommand');
  });

  it('exits 2 when `output` is missing the step index', () => {
    const r = run(['output']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: finalize.sh output');
  });

  it('exits 2 when `output` step index is not a positive integer', () => {
    for (const bad of ['abc', '-1', '1.5']) {
      const r = run(['output', bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('positive integer');
    }
  });
});
