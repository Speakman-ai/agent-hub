/**
 * Behavioural guard for `default-skills/agent-hub/scripts/finalize.sh` — the
 * wrapper that lets a spawned agent read Finalize Code Changes run state and
 * CI step logs from the REST API (it has no web "session strip").
 *
 * Most tests exercise the argument-validation / usage paths, which exit
 * before any `hub_api` call. The output parsing regression uses a local HTTP
 * server, so the tests stay hermetic and fast. The live API paths are covered
 * at the route layer (`routes/finalize.test.ts`).
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'default-skills', 'agent-hub', 'scripts', 'finalize.sh');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), ...env },
    encoding: 'utf-8',
  });
}

function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn('bash', [SCRIPT, ...args], {
        env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}

async function withJsonServer(
  handler: (requestPath: string) => unknown,
  callback: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(handler(req.url || '')));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
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

describe('finalize.sh API output parsing', () => {
  it('prints large step output without passing JSON through process env', async () => {
    const largeLine = `${'x'.repeat(150_000)} end-of-line`;
    let result: Awaited<ReturnType<typeof runAsync>> | undefined;

    await withJsonServer(
      (requestPath) => {
        expect(requestPath).toBe('/api/projects/agent-hub/finalize/run-1/steps/10/output');
        return {
          lines: [
            { stream: 'stdout', text: largeLine },
            { stream: 'stderr', text: 'stderr line' },
          ],
        };
      },
      async (baseUrl) => {
        result = await runAsync(['output', '10', 'run-1'], {
          AGENT_HUB_URL: baseUrl,
          AGENT_HUB_API_KEY: 'test-key',
          AGENT_HUB_SESSION_ID: 'session-1',
          PROJECT_ID: 'agent-hub',
        });
      },
    );

    expect(result?.status).toBe(0);
    expect(result?.stderr).toBe('');
    expect(result?.stdout).toContain('end-of-line');
    expect(result?.stdout).toContain('E stderr line');
  });
});
