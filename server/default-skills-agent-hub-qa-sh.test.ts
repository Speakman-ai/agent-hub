/**
 * Behavioural guard for `default-skills/agent-hub-qa/scripts/qa.sh`, the
 * wrapper QA sessions use for plan / case / run / result CRUD. Requests go to
 * a loopback HTTP stub that records method, path, and body, so the tests pin
 * the wire shape the wrapper sends without touching the real routes.
 */
import { spawn, spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { QA_SKILL_ID } from './qa-mode-prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, 'default-skills', QA_SKILL_ID);
const SCRIPT = path.join(SKILL_DIR, 'scripts', 'qa.sh');

const BASE_ENV = { PATH: process.env.PATH || '', HOME: os.tmpdir(), PROJECT_ID: 'proj' };

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function runSync(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { ...BASE_ENV, AGENT_HUB_URL: 'http://127.0.0.1:9', ...env },
    encoding: 'utf-8',
  });
}

/** Runs qa.sh against a loopback stub server, recording every request it receives. */
async function runAgainstStub(args: string[], stdin?: string) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({
        method: req.method || '',
        url: req.url || '',
        body: raw ? JSON.parse(raw) : null,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('bash', [SCRIPT, ...args], {
          env: { ...BASE_ENV, AGENT_HUB_URL: `http://127.0.0.1:${port}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(stdin ?? '');
      },
    );
    return { ...result, seen };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Runs qa.sh against the stub and returns the single request it made. */
async function capture(args: string[], stdin?: string) {
  const result = await runAgainstStub(args, stdin);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.seen).toHaveLength(1);
  return result.seen[0];
}

const PLANS = '/api/projects/proj/qa/plans';

describe('agent-hub-qa skill layout', () => {
  it('ships SKILL.md with matching frontmatter name and an executable qa.sh', () => {
    const md = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(md).toMatch(new RegExp(`^---\\nname: ${QA_SKILL_ID}\\n`));
    for (const topic of [
      'Authoring a plan',
      'Executing a run',
      'Screenshots',
      'Reporting a result',
      'finding cards',
    ]) {
      expect(md).toContain(topic);
    }
    expect(existsSync(SCRIPT)).toBe(true);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('prints usage for help', () => {
    const r = runSync(['help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('result post');
  });
});

describe('qa.sh argument validation', () => {
  it.each([
    [['bogus'], /unknown command/],
    [['plan', 'get'], /invalid planId/],
    [['plan', 'update', 'p1'], /nothing to change/],
    [['plan', 'update', 'p1', '--auto-rerun', 'maybe'], /on or off/],
    [['plan', 'update', 'p1', '--max-iterations', 'x'], /integer/],
    [['case', 'add', 'p1', '--steps', 'a'], /--title is required/],
    [['case', 'reorder', 'p1'], /every case id/],
    [['run', 'get', 'p1'], /invalid runId/],
    [['run', 'delete', 'p1', 'r1'], /unknown run subcommand/],
    [['result', 'post', 'p1', 'r1', '--verdict', 'pass'], /invalid --case/],
    [['result', 'post', 'p1', 'r1', '--case', 'c1', '--verdict', 'ok'], /--verdict must be/],
    [
      ['result', 'post', 'p1', 'r1', '--case', 'c1', '--verdict', 'pass', '--screenshot', 'a/b'],
      /invalid screenshot/,
    ],
    [['plan', 'get', '../x'], /invalid planId/],
  ])('rejects %j', (args, message) => {
    const r = runSync(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it('requires PROJECT_ID', () => {
    const r = runSync(['plan', 'list'], { PROJECT_ID: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PROJECT_ID/);
  });
});

describe('qa.sh @file reads', () => {
  const cases: Array<[string, (file: string) => string[]]> = [
    ['plan update --goal', (f) => ['plan', 'update', 'p1', '--goal', `@${f}`]],
    ['case add --steps', (f) => ['case', 'add', 'p1', '--title', 'T', '--steps', `@${f}`]],
    ['case update --expected', (f) => ['case', 'update', 'p1', 'c1', '--expected', `@${f}`]],
    [
      'result post --actual',
      (f) => [
        'result',
        'post',
        'p1',
        'r1',
        '--case',
        'c1',
        '--verdict',
        'fail',
        '--actual',
        `@${f}`,
      ],
    ],
    [
      'result post --notes',
      (f) => [
        'result',
        'post',
        'p1',
        'r1',
        '--case',
        'c1',
        '--verdict',
        'fail',
        '--notes',
        `@${f}`,
      ],
    ],
  ];

  it.each(cases)('%s with a missing file exits nonzero and sends nothing', async (_, build) => {
    const r = await runAgainstStub(build('/nonexistent/qa-sh-missing.md'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/file not found/);
    expect(r.seen).toHaveLength(0);
  });

  // Root ignores file modes, so the unreadable case only means something as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable file exits nonzero and sends nothing',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-sh-'));
      try {
        const file = path.join(dir, 'locked.md');
        writeFileSync(file, 'secret steps');
        chmodSync(file, 0o000);
        const r = await runAgainstStub(['case', 'update', 'p1', 'c1', '--steps', `@${file}`]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/not readable/);
        expect(r.seen).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('qa.sh requests', () => {
  it('env list', async () => {
    expect(await capture(['env', 'list'])).toMatchObject({
      method: 'GET',
      url: PLANS.replace(/plans$/, 'environments'),
    });
  });

  it('plan list / get', async () => {
    expect(await capture(['plan', 'list', '--status', 'in_progress'])).toMatchObject({
      method: 'GET',
      url: `${PLANS}?status=in_progress`,
    });
    expect(await capture(['plan', 'get', 'p1'])).toMatchObject({
      method: 'GET',
      url: `${PLANS}/p1`,
    });
  });

  it('plan update builds a typed PATCH body', async () => {
    const seen = await capture([
      'plan',
      'update',
      'p1',
      '--title',
      'T "quoted"',
      '--no-epic',
      '--auto-rerun',
      'off',
      '--max-iterations',
      '3',
    ]);
    expect(seen).toEqual({
      method: 'PATCH',
      url: `${PLANS}/p1`,
      body: { title: 'T "quoted"', epicId: null, autoRerun: false, maxIterations: 3 },
    });
  });

  it('case add reads multi-line steps from stdin and expected from a file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-sh-'));
    try {
      const file = path.join(dir, 'expected.md');
      writeFileSync(file, 'Dashboard loads');
      const seen = await capture(
        ['case', 'add', 'p1', '--title', 'Login', '--steps', '-', '--expected', `@${file}`],
        '1. Open /login\n2. Sign in',
      );
      expect(seen).toEqual({
        method: 'POST',
        url: `${PLANS}/p1/cases`,
        body: { title: 'Login', steps: '1. Open /login\n2. Sign in', expected: 'Dashboard loads' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('case update and reorder', async () => {
    expect(await capture(['case', 'update', 'p1', 'c1', '--expected', 'E'])).toEqual({
      method: 'PATCH',
      url: `${PLANS}/p1/cases/c1`,
      body: { expected: 'E' },
    });
    expect(await capture(['case', 'reorder', 'p1', 'c2', 'c1'])).toEqual({
      method: 'POST',
      url: `${PLANS}/p1/cases/reorder`,
      body: { orderedIds: ['c2', 'c1'] },
    });
  });

  it('run get / begin / finish', async () => {
    expect(await capture(['run', 'get', 'p1', 'r1'])).toMatchObject({
      method: 'GET',
      url: `${PLANS}/p1/runs/r1`,
    });
    expect(await capture(['run', 'begin', 'p1', 'r1'])).toMatchObject({
      method: 'POST',
      url: `${PLANS}/p1/runs/r1/begin`,
    });
    expect(await capture(['run', 'finish', 'p1', 'r1'])).toMatchObject({
      method: 'POST',
      url: `${PLANS}/p1/runs/r1/finish`,
    });
  });

  it('result post collects repeated and comma-separated screenshots', async () => {
    const seen = await capture([
      'result',
      'post',
      'p1',
      'r1',
      '--case',
      'c1',
      '--verdict',
      'needs_change',
      '--actual',
      'Button says "Ok"',
      '--screenshot',
      'a1',
      '--screenshot',
      'a2, a3',
      '--finding-card',
      'card-9',
    ]);
    expect(seen).toEqual({
      method: 'POST',
      url: `${PLANS}/p1/runs/r1/results`,
      body: {
        caseId: 'c1',
        verdict: 'needs_change',
        actual: 'Button says "Ok"',
        screenshotArtifactIds: ['a1', 'a2', 'a3'],
        findingCardId: 'card-9',
      },
    });
  });
});
