/**
 * Behavioural guard for `default-skills/agent-hub/scripts/bg.sh` — the wrapper
 * a spawned agent uses to start / monitor / stop Hub-owned background shells
 * that outlive the chat turn.
 *
 * Validation paths exit before any HTTP call; the happy-path `start` uses a
 * local HTTP server so the test stays hermetic (no real Hub, no CLI spawn).
 * Live API behaviour is covered at the route layer (`routes/background-shells.test.ts`).
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
const SCRIPT = path.join(__dirname, 'default-skills', 'agent-hub', 'scripts', 'bg.sh');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env.PATH || '', HOME: os.tmpdir(), ...env },
    encoding: 'utf-8',
  });
}

// Async variant — REQUIRED for any test that also runs an in-process HTTP
// server: `spawnSync` blocks the event loop, so the local server would never
// answer the wrapper's request and both sides deadlock.
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
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    },
  );
}

async function withCaptureServer(
  callback: (
    baseUrl: string,
    captured: () => { method: string; url: string; body: string },
  ) => Promise<void>,
) {
  let method = '';
  let url = '';
  let body = '';
  const server = http.createServer((req, res) => {
    method = req.method || '';
    url = req.url || '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      body = Buffer.concat(chunks).toString('utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ shell: { id: 'shell-1', status: 'running' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${port}`, () => ({ method, url, body }));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('bg.sh layout', () => {
  it('is present and executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

describe('bg.sh usage / validation', () => {
  it('prints usage with all subcommands on help', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    for (const sub of ['start', 'list', 'status', 'logs', 'stop']) {
      expect(r.stdout).toContain(sub);
    }
  });

  it('exits 2 with usage when invoked with no subcommand', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bg.sh');
  });

  it('exits 2 on an unknown subcommand', () => {
    const r = run(['bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown subcommand');
  });

  it('exits 2 when start has no command', () => {
    const r = run(['start'], { AGENT_HUB_SESSION_ID: 'session-1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('needs a command');
  });

  it('exits 2 when AGENT_HUB_SESSION_ID is unset', () => {
    const r = run(['list']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('AGENT_HUB_SESSION_ID');
  });

  it('exits 2 when stop has no shellId', () => {
    const r = run(['stop'], { AGENT_HUB_SESSION_ID: 'session-1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('shellId');
  });
});

describe('bg.sh start (hermetic)', () => {
  it('POSTs the command + leading --label to the session background-shells route', async () => {
    let result: Awaited<ReturnType<typeof runAsync>> | undefined;
    let captured: { method: string; url: string; body: string } | undefined;
    await withCaptureServer(async (baseUrl, getCaptured) => {
      result = await runAsync(['start', '--label', 'prod build', 'npm', 'run', 'build'], {
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'session-1',
      });
      captured = getCaptured();
    });
    expect(result?.status).toBe(0);
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/api/sessions/session-1/background-shells');
    const parsed = JSON.parse(captured?.body || '{}');
    // The command is POSIX-quoted; assert it re-splits back to the argv.
    expect(shSplit(parsed.command)).toEqual(['npm', 'run', 'build']);
    expect(parsed.label).toBe('prod build');
  });

  it('only parses --label in leading position (a trailing --label stays in the command)', async () => {
    let captured: { method: string; url: string; body: string } | undefined;
    await withCaptureServer(async (baseUrl, getCaptured) => {
      await runAsync(['start', 'mytool', '--label', 'x'], {
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'session-1',
      });
      captured = getCaptured();
    });
    const parsed = JSON.parse(captured?.body || '{}');
    // `--label x` after the command belongs to the command, not the wrapper.
    expect(shSplit(parsed.command)).toEqual(['mytool', '--label', 'x']);
    expect(parsed.label).toBe('');
  });

  it('honours `--` as an explicit end-of-options separator', async () => {
    let captured: { method: string; url: string; body: string } | undefined;
    await withCaptureServer(async (baseUrl, getCaptured) => {
      await runAsync(['start', '--', '--label', 'really-a-command-arg'], {
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'session-1',
      });
      captured = getCaptured();
    });
    const parsed = JSON.parse(captured?.body || '{}');
    expect(shSplit(parsed.command)).toEqual(['--label', 'really-a-command-arg']);
    expect(parsed.label).toBe('');
  });

  it('preserves quoting / argument boundaries (regression for the naive join)', async () => {
    let captured: { method: string; url: string; body: string } | undefined;
    await withCaptureServer(async (baseUrl, getCaptured) => {
      // A single argument that contains spaces + shell metacharacters. The
      // old `${parts[*]}` join tore this into separate words.
      await runAsync(['start', 'bash', '-lc', 'echo "$FOO"'], {
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'session-1',
      });
      captured = getCaptured();
    });
    const command = JSON.parse(captured?.body || '{}').command as string;
    // The command the server will run via `sh -c "$command"` must re-split
    // into exactly the original argv — not the collapsed `echo "$FOO"` words.
    expect(shSplit(command)).toEqual(['bash', '-lc', 'echo "$FOO"']);
  });

  it('POSIX-quotes control-character / newline / single-quote args for /bin/sh', async () => {
    let captured: { method: string; url: string; body: string } | undefined;
    // Args bash's `printf %q` would encode as $'...' (invalid under dash),
    // plus an embedded single quote. All must survive a /bin/sh re-split.
    const argv = ['printf', '%s\n', 'a\nb', "it's"];
    await withCaptureServer(async (baseUrl, getCaptured) => {
      await runAsync(['start', ...argv], {
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'session-1',
      });
      captured = getCaptured();
    });
    const command = JSON.parse(captured?.body || '{}').command as string;
    expect(shSplit(command)).toEqual(argv);
  });
});

/**
 * Re-split a command string exactly the way the server does — `/bin/sh -c`
 * (dash, not bash), NUL-delimited so args containing newlines survive.
 */
function shSplit(command: string): string[] {
  const out = spawnSync(
    'sh',
    ['-c', `set -- ${command}; for a in "$@"; do printf '%s\\0' "$a"; done`],
    { encoding: 'utf-8' },
  );
  const parts = out.stdout.split('\0');
  parts.pop(); // trailing '' after the final NUL
  return parts;
}
