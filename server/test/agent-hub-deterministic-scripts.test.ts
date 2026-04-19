import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, statSync, readFileSync, writeFileSync, rmSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Async wrapper around spawn — spawnSync blocks the Node event loop, which
// would starve the mock HTTP server below and deadlock the test.
function spawnAsync(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    child.on('error', (err) => resolve({ status: -1, stdout, stderr: String(err) }));
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPTS = path.join(__dirname, '..', 'default-skills', 'agent-hub', 'scripts');
const PLUGIN_SCRIPTS = path.join(__dirname, '..', '..', 'plugin', 'skills', 'agent-hub', 'scripts');

/**
 * Shape guards for the deterministic script wrappers added alongside the
 * subcommand-style helpers (`board.sh`, `wiki.sh`, …). These are single-
 * purpose, flag-based scripts agents should prefer over hand-rolled curl.
 *
 * We don't run them against a live server here — the goal is to lock in the
 * *contract* (present, executable, --help works, bad invocation surfaces a
 * readable error) so regressions are caught in CI without needing the HTTP
 * stack up.
 */

const DETERMINISTIC_SCRIPTS = [
  'ah-api.sh',
  'resolve-column-id.sh',
  'kanban-create-card.sh',
  'kanban-move-card.sh',
  'kanban-list.sh',
  'wiki-search.sh',
  'wiki-upsert.sh',
  'get-board-state.sh',
];

function runHelp(file: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(file, ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: e.status ?? -1,
      stdout: String(e.stdout ?? '') + String(e.stderr ?? ''),
    };
  }
}

function runExit(file: string, args: string[]): number {
  try {
    execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      env: { ...process.env, PROJECT_ID: '', AGENT_HUB_API_KEY: '' },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe('agent-hub deterministic script wrappers — shape', () => {
  describe.each([
    ['default-skills', DEFAULT_SCRIPTS],
    ['plugin mirror', PLUGIN_SCRIPTS],
  ])('%s', (_label, dir) => {
    it('scripts/ directory exists', () => {
      expect(existsSync(dir)).toBe(true);
    });

    it.each(DETERMINISTIC_SCRIPTS)('%s is present and executable', (name) => {
      const file = path.join(dir, name);
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const mode = statSync(file).mode;
      // Owner-executable bit set — good enough for "agents can run this".
      expect(mode & 0o100).toBeTruthy();
    });

    it.each(DETERMINISTIC_SCRIPTS)('%s --help exits 0 with usage text', (name) => {
      const file = path.join(dir, name);
      const { code, stdout } = runHelp(file);
      expect(code, `${name} --help exit`).toBe(0);
      expect(stdout.toLowerCase()).toContain('usage:');
    });

    it('scripts use set -euo pipefail', async () => {
      const { readFileSync } = await import('fs');
      for (const name of DETERMINISTIC_SCRIPTS) {
        const src = readFileSync(path.join(dir, name), 'utf8');
        expect(src, `${name} missing 'set -euo pipefail'`).toMatch(/set -euo pipefail/);
      }
    });

    it('scripts route auth through ah-api.sh (no hard-coded x-api-key reads outside it)', async () => {
      const { readFileSync } = await import('fs');
      for (const name of DETERMINISTIC_SCRIPTS) {
        if (name === 'ah-api.sh') continue;
        const src = readFileSync(path.join(dir, name), 'utf8');
        // Other scripts must not build their own x-api-key header directly;
        // they source ah-api.sh and call ah_api / ah_resolve_key.
        expect(src, `${name} builds its own x-api-key header`).not.toMatch(
          /-H\s+["']x-api-key:\s*\$\{?AGENT_HUB_API_KEY/,
        );
      }
    });
  });

  describe('bad invocation surfaces actionable errors', () => {
    it('resolve-column-id.sh with no args exits 2', () => {
      expect(runExit(path.join(DEFAULT_SCRIPTS, 'resolve-column-id.sh'), [])).toBe(2);
    });

    it('kanban-create-card.sh without --title exits 2', () => {
      expect(
        runExit(path.join(DEFAULT_SCRIPTS, 'kanban-create-card.sh'), ['--column', 'Backlog']),
      ).toBe(2);
    });

    it('kanban-move-card.sh with 1 arg exits 2', () => {
      expect(runExit(path.join(DEFAULT_SCRIPTS, 'kanban-move-card.sh'), ['abc'])).toBe(2);
    });

    it('wiki-search.sh with no args exits 2', () => {
      expect(runExit(path.join(DEFAULT_SCRIPTS, 'wiki-search.sh'), [])).toBe(2);
    });

    it('wiki-upsert.sh with 1 arg exits 2', () => {
      expect(runExit(path.join(DEFAULT_SCRIPTS, 'wiki-upsert.sh'), ['slug-only'])).toBe(2);
    });

    it('ah-api.sh with no args exits 2', () => {
      expect(runExit(path.join(DEFAULT_SCRIPTS, 'ah-api.sh'), [])).toBe(2);
    });
  });

  // ─── Source-level assertions ──────────────────────────────────────────
  // POST /board/cards does NOT accept epic_id — epic linking is a separate
  // endpoint. The create-card wrapper must chain a second call when
  // --epic-id is provided. Pinning the contract at the source level protects
  // future edits from silently re-introducing the bug.
  describe('kanban-create-card.sh source invariants', () => {
    it.each([DEFAULT_SCRIPTS, PLUGIN_SCRIPTS])(
      'chains POST /board/cards/:id/epic when --epic-id is set (%s)',
      (dir) => {
        const src = readFileSync(path.join(dir, 'kanban-create-card.sh'), 'utf8');
        expect(src).toMatch(/board\/cards\/\$card_id\/epic/);
        expect(src).toMatch(/\{\\"epicId\\":\\"\$epic_id\\"\}/);
        // The create payload must not carry epic_id (the endpoint ignores it).
        expect(src).not.toMatch(/\("epic_id",\s*"AH_EPIC"\)/);
      },
    );
  });

  // ─── End-to-end check against a mock HTTP server ──────────────────────
  // Spins up a tiny Node HTTP listener that captures the request sequence
  // kanban-create-card.sh makes, so we can assert the epic-link chain
  // actually fires. Skipped if `python3` isn't on PATH — the script needs it
  // to build the JSON body.
  describe('kanban-create-card.sh epic-link chaining (mock server)', () => {
    const hasPython = spawnSync('python3', ['--version']).status === 0;
    const fn = hasPython ? it : it.skip;

    fn(
      'POSTs to /epic after creating the card when --epic-id is set',
      async () => {
        const calls: Array<{ method: string; url: string; body: string }> = [];
        const cardId = 'card-uuid-abc';

        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            calls.push({ method: req.method ?? '', url: req.url ?? '', body });
            res.setHeader('content-type', 'application/json');
            if (req.url?.endsWith('/board')) {
              res.end(JSON.stringify({ columns: [{ id: 'col-backlog', name: 'Backlog' }] }));
            } else if (req.url?.endsWith('/board/cards')) {
              res.end(JSON.stringify({ id: cardId, title: 'test', epic_id: null }));
            } else if (req.url?.endsWith(`/cards/${cardId}/epic`)) {
              res.end(JSON.stringify({ id: cardId, title: 'test', epic_id: 'epic-xyz' }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'not found' }));
            }
          });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const { port } = server.address() as AddressInfo;
          const result = await spawnAsync(
            path.join(DEFAULT_SCRIPTS, 'kanban-create-card.sh'),
            ['--title', 'test', '--column', 'Backlog', '--epic-id', 'epic-xyz'],
            {
              ...process.env,
              AGENT_HUB_URL: `http://127.0.0.1:${port}`,
              AGENT_HUB_API_KEY: '',
              PROJECT_ID: 'proj-x',
            },
          );
          expect(result.status, `stderr: ${result.stderr}`).toBe(0);

          const paths = calls.map((c) => `${c.method} ${c.url}`);
          expect(paths).toContain('GET /api/projects/proj-x/board');
          expect(paths).toContain('POST /api/projects/proj-x/board/cards');
          expect(paths).toContain(`POST /api/projects/proj-x/board/cards/${cardId}/epic`);

          const epicCall = calls.find((c) => c.url.endsWith('/epic'));
          expect(epicCall?.body).toContain('"epicId":"epic-xyz"');

          // Stdout should be the final (linked) card JSON — epic_id populated.
          expect(result.stdout).toContain('"epic_id":"epic-xyz"');
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      15_000,
    );

    fn(
      'omits the epic call when --epic-id is not set',
      async () => {
        const calls: string[] = [];
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            calls.push(`${req.method} ${req.url}`);
            res.setHeader('content-type', 'application/json');
            if (req.url?.endsWith('/board')) {
              res.end(JSON.stringify({ columns: [{ id: 'col-backlog', name: 'Backlog' }] }));
            } else if (req.url?.endsWith('/board/cards')) {
              res.end(JSON.stringify({ id: 'c1', title: 'plain' }));
            } else {
              res.statusCode = 404;
              res.end('{}');
            }
          });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const { port } = server.address() as AddressInfo;
          const result = await spawnAsync(
            path.join(DEFAULT_SCRIPTS, 'kanban-create-card.sh'),
            ['--title', 'plain', '--column', 'Backlog'],
            {
              ...process.env,
              AGENT_HUB_URL: `http://127.0.0.1:${port}`,
              AGENT_HUB_API_KEY: '',
              PROJECT_ID: 'proj-x',
            },
          );
          expect(result.status, `stderr: ${result.stderr}`).toBe(0);
          expect(calls.some((c) => c.includes('/epic'))).toBe(false);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      15_000,
    );
  });

  // ─── Wiki-upsert slug safety ──────────────────────────────────────────
  // server/wiki.ts::createPage derives the slug from slugify(title) and
  // ignores any body slug field. The wrapper must validate slug/title
  // agreement up-front so callers don't silently land on the wrong slug.
  describe('wiki-upsert.sh source invariants', () => {
    it.each([DEFAULT_SCRIPTS, PLUGIN_SCRIPTS])(
      'does NOT send "slug" in the POST body (%s)',
      (dir) => {
        const src = readFileSync(path.join(dir, 'wiki-upsert.sh'), 'utf8');
        // The payload dict in the embedded python block must not have a
        // "slug" key — server ignores it anyway and its presence creates
        // the false impression that the caller can pin the slug.
        expect(src).not.toMatch(/"slug":\s*os\.environ\["AH_SLUG"\]/);
        // And the validation must run (slugify mirror + exit 2).
        expect(src).toMatch(/def slugify/);
        expect(src).toMatch(/slug\/title mismatch/);
      },
    );
  });

  describe('wiki-upsert.sh slug validation (mock server)', () => {
    const hasPython = spawnSync('python3', ['--version']).status === 0;
    const fn = hasPython ? it : it.skip;

    let tmpDir: string;
    beforeAll(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wiki-upsert-test-'));
    });
    afterAll(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    });

    fn(
      'rejects a slug that disagrees with the H1 title, before any HTTP call',
      async () => {
        const calls: string[] = [];
        const server = http.createServer((req, res) => {
          calls.push(`${req.method} ${req.url}`);
          res.statusCode = 500;
          res.end('should not have been called');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const { port } = server.address() as AddressInfo;
          const mdPath = path.join(tmpDir, 'mismatch.md');
          writeFileSync(mdPath, '# Architecture: My New Design\n\nbody\n');

          const result = await spawnAsync(
            path.join(DEFAULT_SCRIPTS, 'wiki-upsert.sh'),
            ['my-design-doc', mdPath],
            {
              ...process.env,
              AGENT_HUB_URL: `http://127.0.0.1:${port}`,
              AGENT_HUB_API_KEY: '',
              PROJECT_ID: 'proj-x',
            },
          );
          expect(result.status).toBe(2);
          expect(result.stderr).toContain('slug/title mismatch');
          expect(result.stderr).toContain('architecture-my-new-design');
          // Critical: validation happens before the probe — no HTTP calls at all.
          expect(calls).toEqual([]);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      15_000,
    );

    fn(
      'accepts a slug that matches slugify(title); body omits slug field',
      async () => {
        const calls: Array<{ method: string; url: string; body: string }> = [];
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            calls.push({ method: req.method ?? '', url: req.url ?? '', body });
            res.setHeader('content-type', 'application/json');
            if (req.method === 'GET' && req.url?.endsWith('/wiki/my-page')) {
              // Not found — triggers the create branch.
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'not found' }));
            } else if (req.method === 'POST' && req.url?.endsWith('/wiki')) {
              res.end(JSON.stringify({ slug: 'my-page', title: 'My Page' }));
            } else {
              res.statusCode = 404;
              res.end('{}');
            }
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const { port } = server.address() as AddressInfo;
          const mdPath = path.join(tmpDir, 'ok.md');
          writeFileSync(mdPath, '# My Page\n\ncontent\n');

          const result = await spawnAsync(
            path.join(DEFAULT_SCRIPTS, 'wiki-upsert.sh'),
            ['my-page', mdPath],
            {
              ...process.env,
              AGENT_HUB_URL: `http://127.0.0.1:${port}`,
              AGENT_HUB_API_KEY: '',
              PROJECT_ID: 'proj-x',
            },
          );
          expect(result.status, `stderr: ${result.stderr}`).toBe(0);

          const post = calls.find((c) => c.method === 'POST');
          expect(post).toBeTruthy();
          // Body must NOT contain a "slug" field — the server ignores it and
          // its presence would be a lie about who controls slug identity.
          expect(post!.body).not.toMatch(/"slug"\s*:/);
          expect(post!.body).toContain('"title": "My Page"');
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      15_000,
    );
  });
});
